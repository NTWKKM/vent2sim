import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Play, Pause, Activity, Settings, HeartPulse, AlertCircle, TrendingUp, Filter, BarChart2, User, Clock, PauseCircle, StopCircle } from 'lucide-react';

// ==================== PHYSICS CONSTANTS ====================
const DT = 0.016; // Time step (seconds) approx 60fps
const MAX_HISTORY = 1500; // Points to keep in graph history (approx 24s)
const PEAK_WINDOW = 300; // Window for real-time peak calculation (~5 seconds)

// Pressure rise smoothing (Rise Time simulation for PCV/PSV)
const PCV_RISE_SMOOTHING = 0.08; 
// Expiratory resistance multiplier (ETT + Expiratory Valve)
const EXP_RESISTANCE_MULTIPLIER = 1.5;
// Circuit Compliance (ml/cmH2O)
const CIRCUIT_COMPLIANCE = 2.5; 

// --- Helper: Linear Interpolation ---
const lerp = (start, end, factor) => start + (end - start) * factor;

// ==================== ADVANCED PHYSICS: DYNAMIC RESISTANCE (NEW) ====================
// Implements: Rohrer Equation (K1*Flow + K2*Flow²), Airway Tethering, Dynamic Compression
const getDynamicResistance = (baseR, currentFlow_Lps, currentVol_L, pathology, lungCapacity_L) => {
    // Rohrer coefficients: K1 (laminar/viscosity) + K2 (turbulent/density)
    let K1 = 0.05; // Baseline viscous component
    let K2 = 0.3;  // Baseline turbulent component
  
    if (pathology === 'COPD' || pathology === 'EMPHYSEMA') {
      // Higher turbulence in narrowed airways + mucus plugging
      K1 = 0.08;
      K2 = 0.8;
    } else if (pathology === 'FIBROSIS') {
      K1 = 0.04; // Less turbulence (stiffer airways)
      K2 = 0.2;
    }
  
    // ===== ROHRER EQUATION COMPONENT =====
    // Pressure drop = K1*V + K2*V² (V = flow velocity)
    const flowMagnitude = Math.abs(currentFlow_Lps);
    const laminarComponent = K1 * flowMagnitude;
    const turbulentComponent = K2 * flowMagnitude * flowMagnitude;
    const flowDependentR = baseR + laminarComponent + turbulentComponent;
  
    // ===== AIRWAY TETHERING: Volume-dependent conductance increase =====
    // Higher lung volume = larger airways = lower resistance (hyperbolic decay)
    const tethering = currentVol_L / (lungCapacity_L / 2);
    const volumeFactor = 1 / (1 + 2 * tethering); // Conductance curve
    const volumeDependentR = flowDependentR * (0.5 + 0.5 * volumeFactor);
  
    // ===== DYNAMIC COMPRESSION EFFECT (Flow Limitation) =====
    // In COPD/emphysema: Early airway closure at low volumes + high RR
    let compressionFactor = 1.0;
    if ((pathology === 'COPD' || pathology === 'EMPHYSEMA') && currentVol_L < lungCapacity_L * 0.3) {
      // Airway collapse risk increases exponentially as volume drops
      const collapseRisk = Math.exp(-3 * (currentVol_L / (lungCapacity_L * 0.3)));
      compressionFactor = 1.0 + (collapseRisk * 2); // Up to 3x resistance
    }
  
    const effectiveR = volumeDependentR * compressionFactor;
  
    // Safety: Don't go below 30% of baseline
    return Math.max(baseR * 0.3, effectiveR);
};

// ==================== ADVANCED PHYSICS: DYNAMIC COMPLIANCE (NEW) ====================
// Implements: Hysteresis, Non-linear S-shape, Lower/Upper Inflection Points
const getDynamicCompliance = (currentTotalVol_L, baseC_ml, pathology, phase, lungCapacity_L) => {
    const baseC_L = baseC_ml / 1000;
    
    // Define inflection points based on pathology
    let lowerInflection_L = 0.1;
    let upperInflection_L = lungCapacity_L * 0.75;
    let distensionFactor = 10;
    let sigFactor = 1.5; // Sigmoid steepness for S-curve
  
    switch (pathology) {
      case 'ARDS':
        // Baby Lung: High inflection points, steep dropout at top
        lowerInflection_L = 0.2;
        upperInflection_L = lungCapacity_L * 0.6;
        distensionFactor = 25;
        sigFactor = 2.5;
        break;
      case 'FIBROSIS':
        // Restrictive: Low compliance throughout, early upper inflection
        lowerInflection_L = 0.05;
        upperInflection_L = lungCapacity_L * 0.5;
        distensionFactor = 30;
        sigFactor = 3.0;
        break;
      case 'EMPHYSEMA':
      case 'COPD':
        // Obstructive: High C initially, but Air Trapping increases effective volume
        lowerInflection_L = 0.0;
        upperInflection_L = lungCapacity_L * 0.8;
        distensionFactor = 12;
        sigFactor = 1.2;
        break;
      default: // NORMAL
        lowerInflection_L = 0.1;
        upperInflection_L = lungCapacity_L * 0.85;
        distensionFactor = 10;
        sigFactor = 1.5;
    }
  
    let effectiveC = baseC_L;
  
    // ===== SIGMOID S-CURVE FOR NORMAL PHYSIOLOGY =====
    // Creates smooth transition between low and high compliance regions
    if (pathology === 'NORMAL' || pathology === 'CUSTOM') {
      const midpoint = (lowerInflection_L + upperInflection_L) / 2;
      const sigmoid = 1 / (1 + Math.exp(-sigFactor * (currentTotalVol_L - midpoint) / (upperInflection_L - lowerInflection_L)));
      effectiveC = baseC_L * (0.4 + 0.6 * sigmoid);
    }
  
    // ===== RECRUITMENT PHASE (Inspiration): Lower Compliance =====
    // Effort to open collapsed alveoli requires additional pressure
    if (phase === 'INS' || phase === 'HOLD_INS' || phase === 'REC') {
      if (currentTotalVol_L < lowerInflection_L) {
        // Sigmoid recruitment: hard at start, eases off
        const recruitSig = 1 / (1 + Math.exp(-5 * (currentTotalVol_L / lowerInflection_L)));
        effectiveC = baseC_L * (0.3 + 0.7 * recruitSig);
      }
    }
  
    // ===== BALLOON EFFECT (Overdistension): Stiffness increases =====
    // At high volumes, tissue tension + surface tension resist further expansion
    if (currentTotalVol_L > upperInflection_L) {
      const excessVol = currentTotalVol_L - upperInflection_L;
      // Exponential stiffness increase (collagen fiber stretch resistance)
      const stiffness = Math.exp(-excessVol * distensionFactor);
      effectiveC = baseC_L * stiffness;
    }
  
    // ===== HYSTERESIS EFFECT (Expiration > Inspiration) =====
    // Surfactant concentration during expiration improves compliance
    if (phase === 'EXP' || phase === 'HOLD_EXP') {
      // Expiratory compliance 10-20% higher due to surfactant desorption
      effectiveC *= 1.15;
    }
  
    // Safety: Minimum compliance 2 ml/cmH2O
    return Math.max(0.002, effectiveC);
};

// --- Pathology Presets (Matched to New Physics) ---
const PATHOLOGY_PRESETS = {
  NORMAL: { 
      name: 'Normal (Adult on ETT)', 
      resL: 15, compL: 50, resR: 15, compR: 50, 
      shunt: 0.05, deadspace: 0.15, 
      frcOffset: 0.0, lungCapacity: 3.0, 
      note: 'Standard adult. Normal S-shape P/V curve.' 
  },
  ARDS: { 
      name: 'ARDS (Stiff Lungs)', 
      resL: 15, compL: 30, resR: 15, compR: 30, 
      shunt: 0.30, deadspace: 0.35, 
      frcOffset: 0.0, 
      lungCapacity: 3.0, // <--- แก้เป็น 3.0 ตามที่ขอครับ (เดิม 1.0)
      note: 'Low compliance. Adjusted Capacity (3.0L) to avoid early overdistension.' 
  },
  COPD: { 
      name: 'COPD (Mild/Mod)', 
      resL: 20, compL: 60, resR: 20, compR: 60, 
      shunt: 0.10, deadspace: 0.30, 
      frcOffset: 1.0, lungCapacity: 3.5, 
      note: 'Moderate R, High C. Avoid high RR.' 
  },
  EMPHYSEMA: { 
      name: 'Emphysema (Severe)', 
      resL: 25, compL: 120, resR: 25, compR: 120, 
      shunt: 0.15, deadspace: 0.45, 
      frcOffset: 2.3, lungCapacity: 3.0, 
      note: 'High Compliance but Low Vt due to Severe Air Trapping.' 
  },
  PULMONARY_EDEMA: { 
      name: 'Pulmonary Edema', 
      resL: 15, compL: 25, resR: 15, compR: 25, 
      shunt: 0.25, deadspace: 0.25, 
      frcOffset: 0.0, lungCapacity: 2.0,
      note: 'Fluid in lungs reducing compliance.' 
  },
  UNILATERAL_C_DEC: { 
      name: 'Unilateral Low C (Right)', 
      resL: 15, compL: 50, resR: 15, compR: 20, 
      shunt: 0.15, deadspace: 0.20, 
      frcOffset: 0.0, lungCapacity: 2.5,
      note: 'Right lung stiff. Flow goes preferentially to Left.' 
  },
  CUSTOM: { 
      name: 'Custom Settings', 
      resL: 15, compL: 50, resR: 15, compR: 50, 
      shunt: 0.05, deadspace: 0.15, 
      frcOffset: 0.0, lungCapacity: 3.0,
      note: 'Manual control.' 
  }
};

// --- Initial State ---
const INITIAL_STATE = {
  // Ventilator Settings
  mode: 'PCV', 
  tidalVolume: 450, 
  inspiratoryPressure: 10, 
  pressureSupport: 10, 
  eSense: 25, 
  respiratoryRate: 14, 
  inspiratoryTime: 1.0, 
  peep: 5, 
  flowPattern: 'SQUARE', 
  apneaTime: 10, 
  fiO2: 0.40, 
  
  // Patient Mechanics
  pathology: 'NORMAL', 
  resL: 15, compL: 50,
  resR: 15, compR: 50,
  shunt: 0.05, deadspace: 0.15,    
  frcOffset: 0.0,    
  lungCapacity: 3.0, 

  // Patient Data
  gender: 'M', 
  heightCm: 170, 
  actualWeightKg: 70, 
  weightMode: 'PBW', 
  
  // Spontaneous Breathing
  spontaneousRR: 0, 
  pmusSyncMode: 'AUTO_SYNC', 
};


// --- Helper Functions ---
const calculatePBW = (gender, heightCm) => {
  const heightInches = heightCm * 0.393701;
  if (gender === 'M') {
    return 50 + 2.3 * (heightInches - 60);
  } else {
    return 45.5 + 2.3 * (heightInches - 60);
  }
};


const App = () => {
  // --- State Management ---
  const [params, setParams] = useState(INITIAL_STATE);
  const [isRunning, setIsRunning] = useState(false);
  const [isRecruiting, setIsRecruiting] = useState(false);
  
  // Auto-Scale State
  const [scales, setScales] = useState({ pMax: 40, fMax: 60, vMax: 600 });
  const scalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });
  const displayedScalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });

  const [monitoredValues, setMonitoredValues] = useState({
    Pplat: 0, Pmean: 0, Cstat: 0, AutoPEEP: 0, TotalRR: 0, MV: 0, VtExp: 0, 
    VPeakAbs: 0, VPeakRel: 0, SpO2: 98, EtCO2: 35,
    FlowLimitationDetected: false // NEW
  });
  const [backupActive, setBackupActive] = useState(false); 

  // --- Holds ---
  const [inspHoldRequest, setInspHoldRequest] = useState(false);
  const [expHoldRequest, setExpHoldRequest] = useState(false);
  const [holdStatus, setHoldStatus] = useState(null); 

  // Simulation State
  const simState = useRef({
    time: 0, cycleTime: 0, patientTime: 0,   
    phase: 'EXP',     
    volL: 0, volR: 0, 
    paw: 0, flowTotal: 0, flowL: 0, flowR: 0,
    valveFlow: 0, valvePressure: 0,
    volCircuit: 0,
    recruitmentTimer: 0, recruitmentStep: 0,
    pawSum: 0, pawCount: 0,
    pPlatTemp: 0, autoPeepTemp: 0, 
    volPeakCycle: 0, currentPeakFlow: 0, 
    lastBreathTime: Date.now(), 
    timeSinceLastBreath: 0,
    isBackupCycle: false, 
    holdTimer: 0,
    pPlatCaptured: false,
    
    // NEW: Flow limitation tracking
    prevFlow: 0,
    prevPaw: 0,
    flowLimitationCounter: 0
  });

  // Data History
  const history = useRef({
    paw: new Array(MAX_HISTORY).fill(0),
    flow: new Array(MAX_HISTORY).fill(0),
    flowL: new Array(MAX_HISTORY).fill(0),
    flowR: new Array(MAX_HISTORY).fill(0),
    vol: new Array(MAX_HISTORY).fill(0), 
    currentLoopPV: [], 
    currentLoopFV: [],
    lastLoopPV: [], 
    lastLoopFV: [],
  });

  // Canvas Refs
  const canvasRefP = useRef(null);
  const canvasRefF = useRef(null);
  const canvasRefV = useRef(null);
  const canvasRefPV = useRef(null); 
  const canvasRefFV = useRef(null); 
  
  // --- Derived Calculations ---
  const derivedParams = useMemo(() => {
    const cycleDuration = 60 / params.respiratoryRate;
    const inspDuration = params.inspiratoryTime;
    const TiMax = cycleDuration * 0.95; 
    const safeTi = Math.min(inspDuration, TiMax - 0.05);
    const expDuration = cycleDuration - safeTi;
    const ieRatioDisplay = expDuration / safeTi;
    
    const Vt_L = params.tidalVolume / 1000;
    let requiredFlow = 0;
    if (params.flowPattern === 'SQUARE') {
      requiredFlow = Vt_L / safeTi; 
    } else { 
      requiredFlow = 2 * Vt_L / safeTi; 
    }
    
    const C_Total_ml = params.compL + params.compR; 
    const PBW = calculatePBW(params.gender, params.heightCm);
    const safeVtMin = Math.round(4 * PBW);
    const safeVtMax = Math.round(8 * PBW);

    const calculatedPmus = params.spontaneousRR * 0.5;
    let pmusStatus = "None";
    let pmusColor = "text-gray-500";
    
    if (params.spontaneousRR > 0) {
        if (calculatedPmus < 5) {
            pmusStatus = "Low Effort";
            pmusColor = "text-blue-600";
        } else if (calculatedPmus <= 10) {
            pmusStatus = "Normal";
            pmusColor = "text-emerald-600";
        } else {
            pmusStatus = "High Effort";
            pmusColor = "text-red-600";
        }
    }

    return {
      cycleDuration,
      inspDuration: safeTi,
      expDuration, 
      ieRatioDisplay: isFinite(ieRatioDisplay) ? ieRatioDisplay.toFixed(1) : '0.0',
      requiredFlowLps: requiredFlow,
      requiredFlowLpm: requiredFlow * 60,
      C_Total_ml,
      PBW: PBW.toFixed(1),
      safeVtRange: `${safeVtMin}-${safeVtMax} ml`,
      isVtSafe: (params.tidalVolume >= safeVtMin && params.tidalVolume <= safeVtMax),
      TiMax: TiMax.toFixed(2),
      pmusMagnitude: calculatedPmus,
      pmusStatus,
      pmusColor
    };
  }, [params]);


  // --- State Initialization and Reset ---
  const resetSimState = useCallback(() => {
    const p = params;
    
    const C_L_Lps = p.compL / 1000; 
    const C_R_Lps = p.compR / 1000;
    
    const V_L_PEEP = (p.peep * C_L_Lps) + (p.frcOffset / 2); 
    const V_R_PEEP = (p.peep * C_R_Lps) + (p.frcOffset / 2); 

    const initialVolAbs = (V_L_PEEP + V_R_PEEP) * 1000;

    simState.current = {
        time: 0, cycleTime: 0, patientTime: 0, phase: 'EXP',
        volL: V_L_PEEP, volR: V_R_PEEP, paw: p.peep, 
        valveFlow: 0, valvePressure: p.peep, 
        volCircuit: (p.peep * CIRCUIT_COMPLIANCE) / 1000, 
        flowTotal: 0, flowL: 0, flowR: 0,
        recruitmentTimer: 0, recruitmentStep: 0,
        pawSum: 0, pawCount: 0,
        pPlatTemp: p.peep, autoPeepTemp: p.peep, 
        volPeakCycle: initialVolAbs, currentPeakFlow: 0, 
        lastBreathTime: Date.now(),
        timeSinceLastBreath: 0,
        isBackupCycle: false,
        holdTimer: 0,
        pPlatCaptured: false,
        // NEW Init
        prevFlow: 0,
        prevPaw: p.peep,
        flowLimitationCounter: 0
    };

    history.current.paw.fill(p.peep);
    history.current.flow.fill(0);
    history.current.flowL.fill(0);
    history.current.flowR.fill(0);
    history.current.vol.fill(0);  
    
    history.current.currentLoopPV = [];
    history.current.currentLoopFV = [];
    history.current.lastLoopPV = [];
    history.current.lastLoopFV = [];
    
    const initScales = { pMax: p.inspiratoryPressure + p.peep + 10, fMax: 60, vMax: p.tidalVolume + 200 };
    setScales(initScales);
    scalesRef.current = initScales;
    displayedScalesRef.current = initScales;

    setMonitoredValues({ 
      Pplat: p.peep, Pmean: p.peep, Cstat: 0, AutoPEEP: 0, TotalRR: 0, MV: 0, VtExp: 0, 
      VPeakAbs: initialVolAbs,
      VPeakRel: 0,
      SpO2: 98, EtCO2: 35,
      FlowLimitationDetected: false
    }); 
    setBackupActive(false);
    setInspHoldRequest(false);
    setExpHoldRequest(false);
    setHoldStatus(null);

  }, [params.compL, params.compR, params.resL, params.resR, params.pathology, params.mode, params.frcOffset, params.lungCapacity]); 

  useEffect(() => {
    resetSimState();
  }, [resetSimState]); 
  
  const handlePathologyChange = (e) => {
    const newPathology = e.target.value;
    const preset = PATHOLOGY_PRESETS[newPathology] || PATHOLOGY_PRESETS['NORMAL'];
    
    setParams(p => ({
      ...p,
      pathology: newPathology,
      resL: preset.resL, compL: preset.compL,
      resR: preset.resR, compR: preset.compR,
      shunt: preset.shunt, 
      deadspace: preset.deadspace,
      frcOffset: preset.frcOffset,
      lungCapacity: preset.lungCapacity
    }));
  };

  useEffect(() => {
    if (params.pathology !== 'CUSTOM') {
      const preset = PATHOLOGY_PRESETS[params.pathology];
      setParams(p => ({
        ...p, resL: preset.resL, compL: preset.compL, resR: preset.resR, compR: preset.compR,
        shunt: preset.shunt,
        deadspace: preset.deadspace,
        frcOffset: preset.frcOffset,
        lungCapacity: preset.lungCapacity
      }));
    }
  }, [params.pathology]);


  // ==================== PHYSICS ENGINE (UPDATED) ====================
  const updatePhysics = useCallback(() => {
    if (!isRunning) return;

    const s = simState.current;
    const p = params;
    const d = derivedParams;

    s.time += DT;
    if (s.phase !== 'HOLD_INS' && s.phase !== 'HOLD_EXP') {
        s.cycleTime += DT;
    }
    
    // ===== PATIENT SYNC LOGIC =====
    let patientTimeCorrection = 0;
    const patientCycleDur = 60 / p.spontaneousRR;
    if (p.spontaneousRR > 0 && p.pmusSyncMode === 'AUTO_SYNC' && s.phase === 'INS') {
        const patientPhase = s.patientTime / patientCycleDur;
        if (patientPhase > 0.7) { 
            const SYNC_FACTOR = 0.0005; 
            patientTimeCorrection = patientCycleDur * SYNC_FACTOR; 
        }
    }
    s.patientTime += DT + patientTimeCorrection; 
    s.timeSinceLastBreath += DT;
    
    // ===== LUNG MECHANICS (with Dynamic Compliance & Resistance) =====
    const CL_dynamic = getDynamicCompliance(s.volL, p.compL, p.pathology, s.phase, p.lungCapacity/2);
    const CR_dynamic = getDynamicCompliance(s.volR, p.compR, p.pathology, s.phase, p.lungCapacity/2);
    const RL_dynamic = getDynamicResistance(p.resL, s.flowL, s.volL, p.pathology, p.lungCapacity/2);
    const RR_dynamic = getDynamicResistance(p.resR, s.flowR, s.volR, p.pathology, p.lungCapacity/2);
    
    const V_Absolute_L_Current = s.volL + s.volR;
    const V_Relative_mL_Current = Math.max(0, (V_Absolute_L_Current * 1000) - ((p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000))); 
    
    // ===== TRIGGER LOGIC =====
    let triggerBreath = false;
    let Pmus = 0;
    let isApneaTrigger = false;

    // 1. Apnea Check
    if (p.mode === 'PSV' && s.timeSinceLastBreath > p.apneaTime) {
        triggerBreath = true;
        isApneaTrigger = true;
    }

    /// 2. Patient Trigger & Pmus Generation
    if (p.spontaneousRR > 0) {
        if (s.patientTime >= patientCycleDur) s.patientTime = 0;
        
        const Ti_mus = patientCycleDur * 0.4; 
        const t_mus = s.patientTime;
        
        if (t_mus < Ti_mus) { 
             const normalizedT = t_mus / (Ti_mus * 0.3); 
             const intensity = d.pmusMagnitude * 2.5; 
             Pmus = -1 * intensity * (t_mus/Ti_mus) * Math.exp(1 - (t_mus/(Ti_mus*0.3)));
             if (Pmus < -d.pmusMagnitude) Pmus = -d.pmusMagnitude;
             
             if (s.phase === 'EXP' && p.mode === 'PSV' && !triggerBreath) {
                 triggerBreath = true; 
             }
        } 
        else if (t_mus >= patientCycleDur * 0.7) { 
            const t_exp_active = t_mus - (patientCycleDur * 0.7);
            const active_duration = patientCycleDur * 0.3; 
            const intensity = d.pmusMagnitude * 0.5; 
            Pmus = intensity * (1 - (t_exp_active / active_duration));
            if (Pmus < 0) Pmus = 0; 
        } else {
             Pmus = 0;
        }

        if (s.phase === 'EXP' && s.cycleTime < 0.3 && Pmus < -2) {
             triggerBreath = true;
        }
    }
      
    // 3. Machine Trigger
    if (p.mode !== 'PSV' && s.cycleTime >= d.cycleDuration) {
        if (expHoldRequest) {
             if (s.phase !== 'HOLD_EXP') {
                 s.phase = 'HOLD_EXP';
                 s.holdTimer = 0;
                 setHoldStatus('EXP_HOLD');
             }
        } else {
            triggerBreath = true;
        }
    }
    
    if (s.phase === 'HOLD_EXP' && !expHoldRequest) {
        triggerBreath = true;
        setHoldStatus(null);
    }

    // ===== RESISTANCE MULTIPLIER =====
    let effectiveRL = RL_dynamic; 
    let effectiveRR = RR_dynamic; 
    if (s.phase === 'EXP' || s.phase === 'HOLD_EXP') {
        effectiveRL *= EXP_RESISTANCE_MULTIPLIER; 
        effectiveRR *= EXP_RESISTANCE_MULTIPLIER; 
    }
    const RL = effectiveRL; 
    const RR = effectiveRR;
    
    // ===== PHASE TRANSITION & MONITOR UPDATE =====
    if (triggerBreath && s.phase !== 'INS' && s.phase !== 'HOLD_INS') {
        const now = Date.now();
        let instantRR = monitoredValues.TotalRR; 
        if (s.lastBreathTime > 0) {
             const breathDurMs = now - s.lastBreathTime;
             if (breathDurMs > 500) { 
                 instantRR = 60000 / breathDurMs;
             }
        }
        s.lastBreathTime = now;

        const PelL_EndExp = s.volL / CL_dynamic;
        const PelR_EndExp = s.volR / CR_dynamic;
        const PalvMean = (PelL_EndExp + PelR_EndExp) / 2;
        const calcAutoPEEP = Math.max(0, PalvMean - p.peep);

        const V_EndExp_mL = (s.volL + s.volR) * 1000;
        const Vt_Final_mL = Math.max(0, s.volPeakCycle - V_EndExp_mL);

        let calculatedCstat = 0;
        const drivingPressure = Math.max(1, s.pPlatTemp - p.peep);
        if (drivingPressure > 1 && Vt_Final_mL > 50) {
            calculatedCstat = Vt_Final_mL / drivingPressure;
        }
        if (calculatedCstat > 200) calculatedCstat = 200;

        const VPeakAbs_Measured = s.volPeakCycle;
        const V_PEEP_Vol_mL = (p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000);
        const VPeakRel_Derived = Math.max(0, VPeakAbs_Measured - V_PEEP_Vol_mL);

        // ===== OXYGENATION MODEL =====
        const baseShunt = p.shunt;        
        const baseDeadspace = p.deadspace; 
        const PmeanEffect = Math.max(0, (s.pawSum / Math.max(1, s.pawCount)) - 5) * 0.01; 
        const actualShunt = Math.max(0.01, baseShunt - PmeanEffect);
        
        let estimatedSpO2 = 99;
        estimatedSpO2 -= (actualShunt * 100) * 1.5; 
        const fio2EffectFactor = (p.fiO2 - 0.40) * 15; 
        estimatedSpO2 += fio2EffectFactor;
        if (estimatedSpO2 > 100) estimatedSpO2 = 100;
        if (estimatedSpO2 < 50) estimatedSpO2 = 50;

        const idealMV = 6.0; 
        const effectiveMV = (instantRR * Vt_Final_mL / 1000) * (1 - baseDeadspace);
        let estimatedEtCO2 = 40 * (idealMV / Math.max(0.1, effectiveMV));
        if (estimatedEtCO2 > 100) estimatedEtCO2 = 100;
        if (estimatedEtCO2 < 10) estimatedEtCO2 = 10;

        // NEW: Detect flow limitation
        const flowLimitationDetected = s.flowLimitationCounter > 5;

        setMonitoredValues(m => ({
             ...m,
             TotalRR: instantRR,
             MV: (instantRR * Vt_Final_mL) / 1000,
             VtExp: Vt_Final_mL,
             VPeakAbs: VPeakAbs_Measured,
             VPeakRel: VPeakRel_Derived,
             AutoPEEP: calcAutoPEEP,
             Cstat: calculatedCstat,
             Pplat: s.pPlatTemp,
             Pmean: s.pawSum / Math.max(1, s.pawCount),
             SpO2: Math.round(estimatedSpO2), 
             EtCO2: Math.round(estimatedEtCO2),
             FlowLimitationDetected: flowLimitationDetected 
        }));

        s.phase = 'INS';
        s.cycleTime = 0; 
        s.currentPeakFlow = 0;
        s.timeSinceLastBreath = 0; 
        s.isBackupCycle = isApneaTrigger;
        
        if (backupActive !== s.isBackupCycle) setBackupActive(s.isBackupCycle);

        if (history.current.currentLoopPV.length > 10) {
            history.current.lastLoopPV = [...history.current.currentLoopPV];
            history.current.lastLoopFV = [...history.current.currentLoopFV];
        }
        history.current.currentLoopPV = []; 
        history.current.currentLoopFV = [];
        
        s.pawSum = 0; 
        s.pawCount = 0;
        s.pPlatCaptured = false;
        s.volPeakCycle = V_EndExp_mL; 
        s.flowLimitationCounter = 0;
    }

    // ===== MODE LOGIC =====
    let targetFlow = 0; 
    let targetPaw = null; 
    let targetMode = 'PC'; 

    if (isRecruiting) {
      s.recruitmentTimer += DT;
      targetMode = 'PC';
      if (s.recruitmentTimer < 10) targetPaw = 30; 
      else if (s.recruitmentTimer < 20) targetPaw = 40; 
      else targetPaw = p.peep; 
      s.phase = 'REC';
    }
    else if (s.phase === 'HOLD_INS') {
        targetMode = 'PC';
        targetFlow = 0;
        const P_static = ((s.volL + s.volR) / (CL_dynamic + CR_dynamic) * 2) + p.peep; 
        targetPaw = P_static; 

        if (!s.pPlatCaptured) {
             const Pplat_Realtime = s.paw; 
             const Vt_Current = ((s.volL + s.volR) * 1000) - ((p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000)); 
             const drivingP = Math.max(1, Pplat_Realtime - p.peep);
             setMonitoredValues(m => ({...m, Pplat: Pplat_Realtime, Cstat: Vt_Current / drivingP}));
        }

        if (!inspHoldRequest) {
            s.phase = 'EXP';
            setHoldStatus(null);
        }
    }
    else if (s.phase === 'HOLD_EXP') {
        targetMode = 'PC';
        targetFlow = 0;
        targetPaw = p.peep; 
        const P_static_exp = (s.volL / CL_dynamic + s.volR / CR_dynamic) / 2;
        targetPaw = P_static_exp; 
        setMonitoredValues(m => ({...m, AutoPEEP: Math.max(0, P_static_exp - p.peep)}));
        
        if (!expHoldRequest) {
             triggerBreath = true; 
             setHoldStatus(null);
        }
    }
    else if (s.phase === 'INS') {
        const effectiveMode = (p.mode === 'PSV' && s.isBackupCycle) ? 'PCV' : p.mode;
        let endInsp = false;

        if (effectiveMode === 'VCV') {
          targetMode = 'VC';
          if (V_Relative_mL_Current >= p.tidalVolume) endInsp = true; 
          else if (s.cycleTime >= d.inspDuration) endInsp = true;
          
          if (endInsp) targetFlow = 0; 
          else {
            if (p.flowPattern === 'SQUARE') targetFlow = d.requiredFlowLps; 
            else targetFlow = Math.max(0, d.requiredFlowLps * (1 - s.cycleTime / d.inspDuration));
          }
        }
        else if (effectiveMode === 'PCV') {
          targetMode = 'PC';
          if (s.cycleTime < d.inspDuration) targetPaw = p.inspiratoryPressure + p.peep; 
          else endInsp = true;
        }
        else if (effectiveMode === 'PSV') {
          targetMode = 'PC';
          targetPaw = p.pressureSupport + p.peep;
          
          const currentInspFlow = s.flowTotal * 60; 
          if (s.cycleTime > 0.1) {
              s.currentPeakFlow = Math.max(s.currentPeakFlow, currentInspFlow);
              const flowThreshold = s.currentPeakFlow * (p.eSense / 100);
              if ((currentInspFlow < flowThreshold && s.currentPeakFlow > 10) || s.cycleTime > 3.0 || currentInspFlow < -5) {
                  endInsp = true; 
              }
          }
        }
        
        if (endInsp) {
            if (inspHoldRequest) {
                s.phase = 'HOLD_INS';
                setHoldStatus('INSP_HOLD');
                s.holdTimer = 0;
            } else {
                s.phase = 'EXP';
            }
        }
    } 
    else {
      s.phase = 'EXP';
      targetMode = 'PC';
      targetPaw = p.peep; 
    }
    
    // ===== PHYSICS SOLVER =====
    const PelL = s.volL / CL_dynamic; 
    const PelR = s.volR / CR_dynamic;
    const PalvL = PelL + Pmus; 
    const PalvR = PelR + Pmus; 
    
    let currentPaw = 0;
    const smoothing = 0.2;

    if (targetMode === 'PC') {
      let currentSmoothing = smoothing;
      if (s.phase === 'INS') currentSmoothing = PCV_RISE_SMOOTHING;

      if (s.phase.includes('HOLD')) s.valvePressure = lerp(s.valvePressure, targetPaw, 0.1); 
      else s.valvePressure = lerp(s.valvePressure, targetPaw, currentSmoothing);
      
      currentPaw = s.valvePressure;

      s.flowL = (currentPaw - PalvL) / RL;
      s.flowR = (currentPaw - PalvR) / RR;
      
    } else { // VC
      s.valveFlow = lerp(s.valveFlow, targetFlow, smoothing);
      const totalFlow = s.valveFlow;
      const GL = 1/RL; const GR = 1/RR;
      currentPaw = (totalFlow + (PalvL * GL) + (PalvR * GR)) / (GL + GR);
      s.paw = currentPaw; 
      s.flowL = (currentPaw - PalvL) / RL;
      s.flowR = (currentPaw - PalvR) / RR;
    }

    const prevVolCircuit = s.volCircuit;
    const newVolCircuit = (currentPaw * CIRCUIT_COMPLIANCE) / 1000; 
    s.volCircuit = newVolCircuit;
    const flowCircuit = (newVolCircuit - prevVolCircuit) / DT; 
    
    s.flowTotal = s.flowL + s.flowR + flowCircuit;

    s.paw = currentPaw;
    s.volL += s.flowL * DT;
    s.volR += s.flowR * DT;

    if (s.volL < 0) s.volL = 0;
    if (s.volR < 0) s.volR = 0;

    const V_Absolute_mL = (s.volL + s.volR) * 1000;
    
    s.pawSum += s.paw;
    s.pawCount += 1;
    
    if (s.phase === 'INS') {
        s.volPeakCycle = Math.max(s.volPeakCycle, V_Absolute_mL);
        if (s.cycleTime > d.inspDuration * 0.95) s.pPlatTemp = (PalvL + PalvR) / 2; 
    }

    // ===== FLOW LIMITATION DETECTION =====
    // Flow limitation: Paw increases but flow doesn't increase (or decreases)
    if (s.phase === 'EXP' && s.flowTotal < -0.1) { 
        const dFlow = s.flowTotal - s.prevFlow;
        const dPaw = currentPaw - s.prevPaw;
        if (dPaw > 0.5 && dFlow < 0.05) { // Paw up, Flow not up
          s.flowLimitationCounter++;
        } else {
          s.flowLimitationCounter = Math.max(0, s.flowLimitationCounter - 1);
        }
    }
    s.prevFlow = s.flowTotal;
    s.prevPaw = currentPaw;

    history.current.paw.push(s.paw);
    history.current.flow.push(s.flowTotal * 60);
    history.current.flowL.push(s.flowL * 60);
    history.current.flowR.push(s.flowR * 60); 
    history.current.vol.push(V_Relative_mL_Current); 

    history.current.currentLoopPV.push({ p: s.paw, v: V_Relative_mL_Current });
    history.current.currentLoopFV.push({ f: s.flowTotal * 60, v: V_Relative_mL_Current });

    if (history.current.paw.length > MAX_HISTORY) {
      history.current.paw.shift();
      history.current.flow.shift();
      history.current.flowL.shift(); 
      history.current.flowR.shift();
      history.current.vol.shift();
    }

  }, [isRunning, isRecruiting, params, derivedParams, backupActive, inspHoldRequest, expHoldRequest, monitoredValues.TotalRR]);

  // --- AUTO SCALE LOGIC ---
  const updateAutoScales = useCallback(() => {
      const recentPaw = history.current.paw.slice(-PEAK_WINDOW);
      const recentFlow = history.current.flow.slice(-PEAK_WINDOW);
      const recentVol = history.current.vol.slice(-PEAK_WINDOW);
      const maxP = Math.max(20, ...recentPaw); 
      const maxF = Math.max(15, ...recentFlow.map(Math.abs)); 
      const maxV = Math.max(200, ...recentVol); 

      scalesRef.current.pMax = lerp(scalesRef.current.pMax, maxP * 1.2, 0.05);
      scalesRef.current.fMax = lerp(scalesRef.current.fMax, maxF * 1.2, 0.05);
      scalesRef.current.vMax = lerp(scalesRef.current.vMax, maxV * 1.2, 0.05);

      const diffP = Math.abs(scalesRef.current.pMax - displayedScalesRef.current.pMax);
      const diffF = Math.abs(scalesRef.current.fMax - displayedScalesRef.current.fMax);
      const diffV = Math.abs(scalesRef.current.vMax - displayedScalesRef.current.vMax);

      if (diffP > 1 || diffF > 2 || diffV > 10) {
          const newScales = { 
            pMax: scalesRef.current.pMax, 
            fMax: scalesRef.current.fMax, 
            vMax: scalesRef.current.vMax 
          };
          setScales(newScales);
          displayedScalesRef.current = newScales;
      }
  }, []);

  // --- Drawing ---
  const drawWaveforms = useCallback(() => {
    const ctxP = canvasRefP.current?.getContext('2d');
    const ctxF = canvasRefF.current?.getContext('2d');
    const ctxV = canvasRefV.current?.getContext('2d');

    if (!ctxP || !ctxF || !ctxV) return;
    
    updateAutoScales(); 

    const w = ctxP.canvas.width;
    const h = ctxP.canvas.height;
    
    ctxP.clearRect(0, 0, w, h);
    ctxF.clearRect(0, 0, w, h);
    ctxV.clearRect(0, 0, w, h);
    
    const sP = scalesRef.current.pMax;
    const sF = scalesRef.current.fMax;
    const sV = scalesRef.current.vMax;

    const drawLine = (ctx, data, color, yMax, yMin = 0, midZero = false) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      let scale;
      let offset = 0; 
      if (midZero) {
          const range = yMax + Math.abs(yMin);
          scale = h / range;
          offset = Math.abs(yMin) * scale;
      } else {
          scale = (h - 10) / yMax; 
          offset = 10;
      }
      data.forEach((val, i) => {
        const x = 35 + ((i / MAX_HISTORY) * (w - 35)); 
        const y = h - ((val * scale) + offset); 
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    const drawAxisAndGrid = (ctx, yMaxPos, yMaxNeg = 0, yLabel, yColor, midZero = false) => {
      const h = ctx.canvas.height;
      const w = ctx.canvas.width;
      ctx.strokeStyle = '#374151'; ctx.fillStyle = '#f3f4f6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';

      if (midZero) {
          const totalRange = yMaxPos + yMaxNeg;
          const scale = h / totalRange;
          const zeroYPos = h - (yMaxNeg * scale); 
          ctx.beginPath(); ctx.strokeStyle = '#9ca3af'; ctx.moveTo(35, zeroYPos); ctx.lineTo(w, zeroYPos); ctx.stroke();
          const steps = 4;
          for(let i=0; i<=steps; i++) {
              let val = yMaxPos - (i * (yMaxPos)/steps);
              let y = zeroYPos - (val * scale);
              if (y < 0) continue;
              ctx.beginPath(); ctx.strokeStyle = '#374151'; ctx.moveTo(35, y); ctx.lineTo(w, y); ctx.stroke();
              ctx.fillText(val.toFixed(0), 32, y+3);
          }
          for(let i=0; i<=steps; i++) {
              let val = yMaxNeg - (i * (yMaxNeg)/steps);
              let y = zeroYPos + (val * scale);
              if (y > h) continue;
              ctx.beginPath(); ctx.strokeStyle = '#374151'; ctx.moveTo(35, y); ctx.lineTo(w, y); ctx.stroke();
              if (val !== 0) ctx.fillText('-'+val.toFixed(0), 32, y+3);
          }
      } else {
          const yMax = yMaxPos;
          const numYTicks = 5; 
          for (let i = 0; i <= numYTicks; i++) {
              let yValue = ((numYTicks - i) * (yMax / numYTicks)).toFixed(0);
              let yPos = (i / numYTicks) * (h - 10) + 5; 
              ctx.beginPath(); ctx.moveTo(35, yPos); ctx.lineTo(w, yPos); ctx.stroke();
              ctx.fillText(yValue, 32, yPos + 3);
          }
      }
      ctx.beginPath(); ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1; ctx.moveTo(35, 0); ctx.lineTo(35, h); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = yColor; ctx.font = '12px sans-serif'; ctx.fillText(yLabel, 40, 15); 
    };
    
    drawAxisAndGrid(ctxP, sP, 0, 'Paw (cmH2O)', '#f59e0b', false); 
    drawLine(ctxP, history.current.paw, '#f59e0b', sP, 0, false); 
    drawAxisAndGrid(ctxF, sF, sF, 'Flow (L/min)', '#10b981', true); 
    drawLine(ctxF, history.current.flow, '#10b981', sF, -sF, true); 
    ctxF.globalAlpha = 0.8;
    drawLine(ctxF, history.current.flowR, '#ef4444', sF, -sF, true); 
    ctxF.globalAlpha = 0.6; 
    drawLine(ctxF, history.current.flowL, '#3b82f6', sF, -sF, true); 
    ctxF.globalAlpha = 1.0;
    drawAxisAndGrid(ctxV, sV, 0, 'Volume (ml)', '#3b82f6', false); 
    drawLine(ctxV, history.current.vol, '#3b82f6', sV, 0, false); 
  }, [updateAutoScales]);
  
  // --- Loop Drawing ---
  const drawLoops = useCallback(() => {
    const ctxPV = canvasRefPV.current?.getContext('2d');
    const ctxFV = canvasRefFV.current?.getContext('2d');
    if (!ctxPV || !ctxFV) return;

    const w = ctxPV.canvas.width;
    const h = ctxPV.canvas.height;
    const paddingLeft = 40; const paddingRight = 10; const paddingBottom = 35; const paddingTop = 20; 
    const innerW = w - paddingLeft - paddingRight;
    const innerH = h - paddingTop - paddingBottom;
    
    const pMax = scalesRef.current.pMax;
    const vMax = scalesRef.current.vMax;
    const fMax = scalesRef.current.fMax;

    const drawLoopGrid = (ctx, xMax, yMax, xLabel, yLabel, midZeroY = false) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#374151'; ctx.fillStyle = '#f3f4f6'; ctx.font = '10px sans-serif';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(paddingLeft, h - paddingBottom); ctx.lineTo(w - paddingRight, h - paddingBottom);
      ctx.moveTo(paddingLeft, paddingTop); ctx.lineTo(paddingLeft, h - paddingBottom); ctx.stroke();
      ctx.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        const xVal = (xMax / 4) * i; const xPos = paddingLeft + (innerW / 4) * i;
        ctx.beginPath(); ctx.moveTo(xPos, h - paddingBottom); ctx.lineTo(xPos, h - paddingBottom + 4); ctx.stroke();
        ctx.fillText(xVal.toFixed(0), xPos, h - paddingBottom + 15);
      }
      ctx.fillStyle = '#f3f4f6'; ctx.textAlign = 'center'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText(xLabel, paddingLeft + innerW / 2, h - 5); 
      ctx.textAlign = 'right'; ctx.font = '10px sans-serif'; ctx.fillStyle = '#9ca3af';
      const steps = 4;
      for(let i=0; i<=steps; i++) {
          let val, y;
          if(midZeroY) { val = yMax - (i * (yMax*2)/steps); y = paddingTop + (i * innerH/steps); } 
          else { val = yMax - (i * yMax/steps); y = paddingTop + (i * innerH/steps); }
          ctx.beginPath(); ctx.moveTo(paddingLeft-4, y); ctx.lineTo(paddingLeft, y); ctx.stroke();
          ctx.fillText(val.toFixed(0), paddingLeft - 8, y + 3);
      }
      ctx.textAlign = 'left'; ctx.fillStyle = '#e5e7eb'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(yLabel, 5, 12); 
      if(midZeroY) {
         const midY = paddingTop + innerH/2;
         ctx.strokeStyle = '#4b5563'; ctx.beginPath(); ctx.moveTo(paddingLeft, midY); ctx.lineTo(w-paddingRight, midY); ctx.stroke();
      }
    };

    const drawLoopLine = (ctx, data, color, xAccessor, yAccessor, xMax, yMax, midY = false) => {
        if (data.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        data.forEach((point, i) => {
          const xVal = point[xAccessor];
          const yVal = point[yAccessor];
          const x = paddingLeft + (xVal / xMax) * innerW;
          let y;
          if (midY) {
              const midH = paddingTop + innerH/2;
              y = midH - (yVal / yMax) * (innerH/2);
          } else {
              y = (h - paddingBottom) - (yVal / yMax) * innerH;
          }
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
    };

    // Draw P/V Loop
    drawLoopGrid(ctxPV, pMax, vMax, 'Pressure (cmH2O)', 'Volume (ml)', false);
    ctxPV.globalAlpha = 0.3;
    drawLoopLine(ctxPV, history.current.lastLoopPV, '#f59e0b', 'p', 'v', pMax, vMax, false);
    ctxPV.globalAlpha = 1.0;
    drawLoopLine(ctxPV, history.current.currentLoopPV, '#f59e0b', 'p', 'v', pMax, vMax, false);

    // Draw F/V Loop
    drawLoopGrid(ctxFV, vMax, fMax, 'Volume (ml)', 'Flow (L/min)', true);
    ctxFV.globalAlpha = 0.3;
    drawLoopLine(ctxFV, history.current.lastLoopFV, '#10b981', 'v', 'f', vMax, fMax, true);
    ctxFV.globalAlpha = 1.0;
    drawLoopLine(ctxFV, history.current.currentLoopFV, '#10b981', 'v', 'f', vMax, fMax, true);

  }, []);

  // --- Main Loop ---
  useEffect(() => {
    let animationFrameId;
    const loop = () => {
      updatePhysics();
      drawWaveforms();
      drawLoops(); 
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [updatePhysics, drawWaveforms, drawLoops]);

  // --- Handlers ---
  const handleModeChange = (e) => {
    const newMode = e.target.value;
    setParams(p => ({
        ...p,
        mode: newMode,
        inspiratoryTime: newMode === 'PSV' ? 0.3 : 1.0, 
        spontaneousRR: (newMode === 'PSV' && p.spontaneousRR === 0) ? 12 : p.spontaneousRR
    }));
    resetSimState();
  };

  const handleTiChange = (e) => {
    const newTi = Number(e.target.value);
    const cycleDuration = 60 / params.respiratoryRate;
    const TiMax = cycleDuration * 0.95; 
    if (newTi < TiMax) {
      setParams(p => ({ ...p, inspiratoryTime: newTi }));
    } else {
      setParams(p => ({ ...p, inspiratoryTime: TiMax - 0.05 }));
    }
  };

  const handleCustomParamChange = (key, value) => {
    const numValue = Math.max(0, Number(value));
    setParams(p => ({ ...p, [key]: numValue }));
  };
  
  const handleGasExchangeChange = (key, value) => {
    const numValue = Math.max(0, Math.min(1.0, Number(value))); // Clamp between 0-1
    setParams(p => ({ ...p, [key]: numValue }));
  };
  
  const handleFiO2Change = (e) => {
    const numValue = Math.max(0.21, Math.min(1.0, Number(e.target.value))); // Clamp between 0.21-1.0
    setParams(p => ({ ...p, fiO2: numValue }));
  };

  const handlePatientDataChange = (key, value) => {
    let numValue = value;
    if (key === 'heightCm' || key === 'actualWeightKg') {
        numValue = Math.max(0, Number(value));
    }
    setParams(p => ({ ...p, [key]: numValue }));
  };
  
  const drivingPressure = monitoredValues.Pplat - params.peep;
  const vtDifference = params.tidalVolume - monitoredValues.VtExp; 


  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        
        {/* Header */}
        <header className="flex justify-between items-center mb-8 border-b border-gray-300 pb-4">
          <div className="flex items-center space-x-3">
            <Activity className="text-blue-600 h-8 w-8" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">VentSim <span className="text-blue-500">Pro</span></h1>
              <p className="text-xs text-gray-500">Advanced Dual-Lung Mechanics Simulator</p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
              {holdStatus && (
                  <div className="px-3 py-1 rounded bg-yellow-100 border border-yellow-400 text-yellow-800 text-xs font-bold animate-pulse">
                      {holdStatus === 'INSP_HOLD' ? 'INSPIRATORY HOLD ACTIVE' : 'EXPIRATORY HOLD ACTIVE'}
                  </div>
              )}
              <button 
                onClick={() => setIsRunning(!isRunning)}
                className={`flex items-center px-4 py-2 rounded-full font-semibold transition ${
                  isRunning ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
              >
                {isRunning ? <><Pause className="w-4 h-4 mr-2"/> STOP</> : <><Play className="w-4 h-4 mr-2"/> START</>}
              </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* LEFT COLUMN: Waveforms & Monitoring */}
          <div className="lg:col-span-8 space-y-6">
            
            {/* Waveforms Panel */}
            <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300">
              <h3 className="text-gray-500 text-sm font-semibold mb-2 flex items-center">
                <Activity className="w-4 h-4 mr-2"/> Real-time Waveforms
              </h3>
              
              <div className="space-y-4">
                {/* Pressure */}
                <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <span className="absolute top-2 right-2 text-yellow-500 text-xs font-bold z-10">
                        PEAK: {scales.pMax.toFixed(0)} cmH2O 
                    </span>
                  <canvas ref={canvasRefP} width={800} height={128} className="w-full h-full" />
                </div>

                {/* Flow */}
                <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <span className="absolute top-2 right-2 text-emerald-400 text-xs font-bold z-10">
                        SCALE: ±{scales.fMax.toFixed(0)} L/min 
                    </span>
                  <div className="absolute top-2 left-1/2 transform -translate-x-1/2 text-[10px] flex justify-center space-x-3 z-10 text-white mt-1">
                    <span className="text-blue-500">■ Left Lung</span>
                    <span className="text-red-500">■ Right Lung</span>
                    <span className="text-emerald-400">■ Total</span>
                  </div>
                  <canvas ref={canvasRefF} width={800} height={128} className="w-full h-full" />
                </div>

                {/* Volume */}
                <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <div className="absolute top-1 right-2 text-blue-500 text-xs font-bold z-10 text-right leading-tight">
                        <span className="block">Max (Rel): {monitoredValues.VPeakRel.toFixed(0)} ml</span>
                        <span className="text-emerald-400 block">Vt: {monitoredValues.VtExp.toFixed(0)} ml</span> 
                        <span className="block text-indigo-400">Max (Abs): {monitoredValues.VPeakAbs.toFixed(0)} ml</span>
                    </div>
                  <canvas ref={canvasRefV} width={800} height={128} className="w-full h-full" />
                </div>
              </div>
            </div>
            
            {/* Monitoring and Loops Panel */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              
              {/* Monitored Parameters */}
              <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300 md:col-span-1">
                <h3 className="text-gray-500 text-sm font-semibold mb-3 flex items-center">
                  <BarChart2 className="w-4 h-4 mr-2"/> Monitored Values
                </h3>
                <div className="space-y-2">
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">P-Plateau</span>
                        <span className="font-bold text-lg text-red-600 text-right">{monitoredValues.Pplat.toFixed(1)} <span className="text-sm">cmH2O</span></span>
                    </div>
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">Paw-mean</span>
                        <span className="font-bold text-lg text-blue-600 text-right">{monitoredValues.Pmean.toFixed(1)} <span className="text-sm">cmH2O</span></span>
                    </div>
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">RR Total</span>
                        <span className="font-bold text-lg text-blue-600 text-right">{monitoredValues.TotalRR.toFixed(1)} <span className="text-sm">/min</span></span>
                    </div>
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">MV (Exp.)</span>
                        <span className="font-bold text-lg text-emerald-600 text-right">{monitoredValues.MV.toFixed(2)} <span className="text-sm">L/min</span></span>
                    </div>
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">Cstat</span>
                        <span className="font-bold text-lg text-purple-600 text-right">{monitoredValues.Cstat.toFixed(1)} <span className="text-sm">ml/cmH2O</span></span>
                    </div>
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">PEEPi</span>
                        <span className="font-bold text-lg text-yellow-600 text-right">{monitoredValues.AutoPEEP.toFixed(1)} <span className="text-sm">cmH2O</span></span>
                    </div>
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">SpO2 (Est.)</span>
                        <span className={`font-bold text-lg text-right ${monitoredValues.SpO2 < 90 ? 'text-red-600 animate-pulse' : 'text-blue-500'}`}>{monitoredValues.SpO2} <span className="text-sm">%</span></span>
                    </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-600">EtCO2 (Est.)</span>
                        <span className={`font-bold text-lg text-right ${monitoredValues.EtCO2 > 45 ? 'text-red-600' : 'text-emerald-500'}`}>{monitoredValues.EtCO2} <span className="text-sm">mmHg</span></span>
                    </div>
                    {/* NEW: Flow Limitation Indicator */}
                    {monitoredValues.FlowLimitationDetected && (
                        <div className="mt-2 bg-red-100 border border-red-400 text-red-700 px-2 py-1 rounded text-center text-xs font-bold animate-pulse">
                            ⚠️ FLOW LIMITATION
                        </div>
                    )}
                </div>
              </div>

              {/* P/V Loop (Card 2) */}
              <div className="md:col-span-1 relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                  <canvas ref={canvasRefPV} width={300} height={200} className="w-full h-auto bg-gray-800" />
                  <div className="absolute bottom-1 left-2 right-2 rounded-b bg-gray-900 p-1 text-xs text-white">
                      <div className="flex justify-between font-bold">
                          <span className="text-yellow-500">DRIVING P:</span>
                          <span className="text-2xl leading-none text-red-500">{drivingPressure.toFixed(1)} <span className="text-base">cmH2O</span></span>
                      </div>
                      <div className="flex justify-between pt-1 text-xs">
                          <span>Plat: {monitoredValues.Pplat.toFixed(1)}</span>
                          <span className="text-purple-400">Cstat: {monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span>
                      </div>
                  </div>
              </div>
              
              {/* F/V Loop (Card 3) */}
              <div className="md:col-span-1 relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                  <canvas ref={canvasRefFV} width={300} height={200} className="w-full h-auto bg-gray-800" />
                  <div className="absolute bottom-1 left-2 right-2 rounded-b bg-gray-900 p-1 text-xs text-white">
                      <div className="flex justify-between font-bold">
                          <span className="text-emerald-400">PEEPi:</span>
                          <span className="text-2xl leading-none text-yellow-500">{monitoredValues.AutoPEEP.toFixed(1)} <span className="text-base">cmH2O</span></span>
                      </div>
                       <div className="flex justify-between pt-1 text-xs">
                           <span className="text-red-400">{params.mode === 'VCV' ? `Vt Diff: ${vtDifference.toFixed(0)} ml` : `VTe: ${monitoredValues.VtExp.toFixed(0)} ml`}</span>
                           <span className="text-blue-400">Flow Peak: {scales.fMax.toFixed(0)} L/min</span>
                      </div>
                  </div>
              </div>
            </div>


            {/* Patient Mechanics & Pathology Presets */}
            <div className="bg-white rounded-xl p-6 shadow-lg border border-gray-300">
              <div className="flex items-center mb-4 text-purple-600">
                <HeartPulse className="w-5 h-5 mr-2"/>
                <h2 className="font-bold">Patient Mechanics & Pathology Presets</h2>
              </div>

              <div className="space-y-4">
                 {/* Patient Data Inputs */}
                 <div className="bg-gray-100 p-3 rounded border border-gray-300">
                     <h4 className="text-sm font-semibold mb-2 flex items-center"><User className="w-4 h-4 mr-1"/> Patient Profile</h4>
                     <div className="grid grid-cols-4 gap-3 text-sm">
                        <div>
                            <label className="text-xs text-gray-500 block mb-1">Gender</label>
                            <select value={params.gender} onChange={(e) => handlePatientDataChange('gender', e.target.value)} className="w-full bg-white border border-gray-300 rounded px-2 py-1">
                                <option value="M">Male</option><option value="F">Female</option>
                            </select>
                        </div>
                        <div>
                            <label className="text-xs text-gray-500 block mb-1">Height (cm)</label>
                            <input type="number" min="100" max="250" value={params.heightCm} onChange={(e) => handlePatientDataChange('heightCm', e.target.value)} className="w-full bg-white border border-gray-300 rounded px-2 py-1"/>
                        </div>
                        <div>
                            <label className="text-xs text-gray-500 block mb-1">Actual Weight (kg)</label>
                            <input type="number" min="20" max="200" value={params.actualWeightKg} onChange={(e) => handlePatientDataChange('actualWeightKg', e.target.value)} className="w-full bg-white border border-gray-300 rounded px-2 py-1"/>
                        </div>
                        <div>
                            <label className="text-xs text-gray-500 block mb-1">Vt Weight Mode</label>
                            <select value={params.weightMode} onChange={(e) => handlePatientDataChange('weightMode', e.target.value)} className="w-full bg-white border border-gray-300 rounded px-2 py-1">
                                <option value="PBW">PBW ({derivedParams.PBW} kg)</option><option value="Actual">Actual ({params.actualWeightKg} kg)</option>
                            </select>
                        </div>
                        <div className="col-span-4 text-xs text-gray-600 mt-1">
                            <span className="font-semibold">Safe Vt Range (4-8 ml/kg PBW):</span> 
                            <span className={derivedParams.isVtSafe ? 'text-emerald-600 font-bold' : 'text-red-600 font-bold'}> {derivedParams.safeVtRange}</span>
                        </div>
                     </div>
                 </div>

                 {/* Spontaneous RR Slider with Pmus Display */}
                 <div className="bg-purple-50 p-3 rounded border border-purple-100">
                    <div className="flex justify-between text-sm mb-1">
                        <span className="font-bold text-purple-800 flex items-center"><HeartPulse className="w-4 h-4 mr-1"/> Spontaneous RR (Patient Effort)</span>
                        <span className="font-mono text-purple-800 font-bold">{params.spontaneousRR} bpm</span>
                    </div>
                    <input type="range" min="0" max="40" step="1" value={params.spontaneousRR} onChange={(e) => setParams(p => ({...p, spontaneousRR: Number(e.target.value)}))} className="w-full accent-purple-600"/>
                    <div className="flex justify-between items-center mt-1">
                         <p className="text-xs text-purple-600">Set &#62; 0 to activate Pmus (Patient Effort) for PSV Trigger.</p>
                         {params.spontaneousRR > 0 && (
                             <div className="text-right">
                                 <span className="text-xs font-bold block text-purple-700">Est. Pmus: {derivedParams.pmusMagnitude.toFixed(1)} cmH2O</span>
                                 <span className={`text-[10px] font-semibold ${derivedParams.pmusColor}`}>{derivedParams.pmusStatus}</span>
                             </div>
                         )}
                    </div>
                    {params.spontaneousRR > 0 && (
                        <div className="mt-2 border-t border-purple-200 pt-2">
                            <label className="text-xs text-purple-600 block mb-1 font-semibold">Sync Mode</label>
                            <div className="flex space-x-4 text-sm">
                                <label className="flex items-center">
                                    <input type="radio" name="syncMode" value="FIGHTING" checked={params.pmusSyncMode === 'FIGHTING'} onChange={(e) => setParams(p => ({...p, pmusSyncMode: e.target.value}))} className="form-radio h-4 w-4 text-purple-600 border-gray-300"/>
                                    <span className="ml-1 text-purple-800">Fighting (Asynchrony)</span>
                                </label>
                                <label className="flex items-center">
                                    <input type="radio" name="syncMode" value="AUTO_SYNC" checked={params.pmusSyncMode === 'AUTO_SYNC'} onChange={(e) => setParams(p => ({...p, pmusSyncMode: e.target.value}))} className="form-radio h-4 w-4 text-purple-600 border-gray-300"/>
                                    <span className="ml-1 text-purple-800">Auto Sync (1-2 min)</span>
                                </label>
                            </div>
                            <p className="text-[10px] text-gray-500 mt-1">"Fighting" simulates asynchrony (Reverse Triggering, Flow Fighting)</p>
                        </div>
                    )}
                 </div>

                 {/* Pathology Preset Selector */}
                 <div className="flex items-center space-x-4 bg-gray-100 p-3 rounded border border-gray-300">
                     <Filter className="w-5 h-5 text-purple-500 flex-shrink-0" />
                     <div className="flex-grow">
                        <label htmlFor="pathologySelect" className="text-sm font-semibold block mb-1">Select Pathology Preset</label>
                        <select id="pathologySelect" value={params.pathology} onChange={handlePathologyChange} className="w-full bg-white border border-gray-300 rounded px-3 py-1 text-sm text-gray-900 appearance-none">
                          {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                            <option key={key} value={key}>{preset.name}</option>
                          ))}
                        </select>
                     </div>
                 </div>
                 
                 {/* Custom R/C inputs */}
                 <div className="grid grid-cols-2 gap-4">
                    <div className="bg-gray-50 p-3 rounded border border-gray-200">
                        <h4 className="text-sm font-bold text-blue-600 mb-2">Left Lung</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs text-gray-500 block">Compliance (ml/cmH2O)</label>
                                <input type="number" min="1" className={`w-full bg-white border rounded px-2 py-1 text-sm text-gray-900 ${params.pathology !== 'CUSTOM' ? 'bg-gray-100 border-gray-300' : 'border-blue-300'}`} value={params.compL} onChange={(e) => handleCustomParamChange('compL', e.target.value)} disabled={params.pathology !== 'CUSTOM'} />
                            </div>
                            <div>
                                <label className="text-xs text-gray-500 block">Resistance (cmH2O/(L/s))</label>
                                <input type="number" min="1" className={`w-full bg-white border rounded px-2 py-1 text-sm text-gray-900 ${params.pathology !== 'CUSTOM' ? 'bg-gray-100 border-gray-300' : 'border-red-300'}`} value={params.resL} onChange={(e) => handleCustomParamChange('resL', e.target.value)} disabled={params.pathology !== 'CUSTOM'} />
                            </div>
                        </div>
                    </div>
                    <div className="bg-gray-50 p-3 rounded border border-gray-200">
                        <h4 className="text-sm font-bold text-red-600 mb-2">Right Lung</h4>
                         <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs text-gray-500 block">Compliance (ml/cmH2O)</label>
                                <input type="number" min="1" className={`w-full bg-white border rounded px-2 py-1 text-sm text-gray-900 ${params.pathology !== 'CUSTOM' ? 'bg-gray-100 border-gray-300' : 'border-red-300'}`} value={params.compR} onChange={(e) => handleCustomParamChange('compR', e.target.value)} disabled={params.pathology !== 'CUSTOM'} />
                            </div>
                            <div>
                                <label className="text-xs text-gray-500 block">Resistance (cmH2O/(L/s))</label>
                                <input type="number" min="1" className={`w-full bg-white border rounded px-2 py-1 text-sm text-gray-900 ${params.pathology !== 'CUSTOM' ? 'bg-gray-100 border-gray-300' : 'border-red-300'}`} value={params.resR} onChange={(e) => handleCustomParamChange('resR', e.target.value)} disabled={params.pathology !== 'CUSTOM'} />
                            </div>
                        </div>
                    </div>
                 </div>
                 
                 {/* Shunt & Deadspace Sliders */}
                 <div className="bg-gray-50 p-3 rounded border border-gray-200 mt-4">
                     <h4 className="text-sm font-bold text-gray-700 mb-2">Gas Exchange Parameters</h4>
                     
                     {/* Shunt Slider */}
                     <div className="mb-3">
                         <div className="flex justify-between text-xs mb-1">
                             <span>Intrapulmonary Shunt (SpO2 effect)</span>
                             <span className={`font-bold ${params.shunt > 0.15 ? 'text-red-600' : 'text-blue-600'}`}>
                                 {(params.shunt * 100).toFixed(0)}%
                             </span>
                         </div>
                         <input 
                             type="range" min="0" max="0.6" step="0.01" 
                             value={params.shunt} 
                             onChange={(e) => handleGasExchangeChange('shunt', e.target.value)} 
                             className="w-full accent-blue-600"
                         />
                         <p className="text-[10px] text-gray-500">Higher Shunt = Lower SpO2 (e.g., ARDS, Pneumonia)</p>
                     </div>

                     {/* Dead Space Slider */}
                     <div>
                         <div className="flex justify-between text-xs mb-1">
                             <span>Dead Space Fraction (EtCO2 effect)</span>
                             <span className={`font-bold ${params.deadspace > 0.3 ? 'text-red-600' : 'text-purple-600'}`}>
                                 {(params.deadspace * 100).toFixed(0)}%
                             </span>
                         </div>
                         <input 
                             type="range" min="0.1" max="0.8" step="0.01" 
                             value={params.deadspace} 
                             onChange={(e) => handleGasExchangeChange('deadspace', e.target.value)} 
                             className="w-full accent-purple-600"
                         />
                         <p className="text-[10px] text-gray-500">Higher Dead Space = Higher EtCO2 (e.g., COPD, PE)</p>
                     </div>
                 </div>


                 <p className="text-xs text-gray-500 mt-2"><span className="font-semibold text-purple-600">Note:</span> {PATHOLOGY_PRESETS[params.pathology].note}</p>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Controls */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* Ventilator Settings */}
            <div className="bg-white rounded-xl p-6 border border-gray-300">
              <div className="flex items-center mb-4 text-blue-600">
                <Settings className="w-5 h-5 mr-2"/>
                <h2 className="font-bold">Ventilator Settings</h2>
              </div>
              
              <div className="space-y-5">
                {/* Mode Selector */}
                <div>
                   <label className="text-sm font-semibold mb-2 block">Ventilation Mode</label>
                   <div className="flex justify-between">
                       {['VCV', 'PCV', 'PSV'].map(mode => (
                           <label key={mode} className="flex items-center text-sm">
                               <input type="radio" name="mode" value={mode} checked={params.mode === mode} onChange={handleModeChange} className="form-radio h-4 w-4 text-blue-600 border-gray-300"/>
                               <span className="ml-2 font-bold">{mode}</span>
                           </label>
                       ))}
                   </div>
                </div>

                {/* VCV ONLY: Tidal Volume */}
                {params.mode === 'VCV' && (
                    <div>
                      <div className="flex justify-between text-sm mb-1"><span>Tidal Volume (Vt)</span><span className="font-mono text-blue-600">{params.tidalVolume} ml</span></div>
                      <input type="range" min="200" max="800" step="10" value={params.tidalVolume} onChange={(e) => setParams(p => ({...p, tidalVolume: Number(e.target.value)}))} className="w-full accent-blue-600"/>
                      <p className={`text-xs mt-1 ${derivedParams.isVtSafe ? 'text-emerald-600 font-bold' : 'text-red-600 font-bold'}`}>Vt/PBW: {(params.tidalVolume / derivedParams.PBW).toFixed(1)} ml/kg</p>
                    </div>
                )}

                {/* PCV ONLY: Inspiratory Pressure */}
                {params.mode === 'PCV' && (
                    <div>
                      <div className="flex justify-between text-sm mb-1"><span>Inspiratory Pressure (Pinsp)</span><span className="font-mono text-red-600">{params.inspiratoryPressure} cmH2O</span></div>
                      <input type="range" min="5" max="30" step="1" value={params.inspiratoryPressure} onChange={(e) => setParams(p => ({...p, inspiratoryPressure: Number(e.target.value)}))} className="w-full accent-red-600"/>
                    </div>
                )}
                
                {/* PSV ONLY: Pressure Support & E-Sense */}
                {params.mode === 'PSV' && (
                    <div className='space-y-4'>
                        <div>
                            <div className="flex justify-between text-sm mb-1"><span>Pressure Support (PS)</span><span className="font-mono text-red-600">{params.pressureSupport} cmH2O</span></div>
                            <input type="range" min="5" max="25" step="1" value={params.pressureSupport} onChange={(e) => setParams(p => ({...p, pressureSupport: Number(e.target.value)}))} className="w-full accent-red-600"/>
                        </div>
                        <div>
                             <div className="flex justify-between text-sm mb-1"><span>E-Sense (Exp. Cycle)</span><span className="font-mono text-blue-600">{params.eSense} % Peak Flow</span></div>
                              <input type="range" min="5" max="50" step="5" value={params.eSense} onChange={(e) => setParams(p => ({...p, eSense: Number(e.target.value)}))} className="w-full accent-blue-600"/>
                        </div>
                        <div className={`p-2 rounded border transition-colors duration-300 ${backupActive ? 'bg-red-100 border-red-200 animate-pulse' : 'bg-red-50 border-red-100'}`}>
                             <div className="flex justify-between text-sm mb-1 text-red-700">
                                 <span className="font-bold flex items-center"><Clock className="w-3 h-3 mr-1"/> Apnea Backup Time</span>
                                 <span className="font-mono">{params.apneaTime} s</span>
                             </div>
                             <input type="range" min="5" max="60" step="1" value={params.apneaTime} onChange={(e) => setParams(p => ({...p, apneaTime: Number(e.target.value)}))} className="w-full accent-red-500"/>
                             {backupActive ? (
                                 <p className="text-[10px] font-bold text-red-600 mt-1 text-center">⚠️ BACKUP ACTIVE: PATIENT APNEA DETECTED</p>
                             ) : (
                                 <p className="text-[10px] text-red-500 mt-1">Triggers PCV backup if no breath for {params.apneaTime}s</p>
                             )}
                        </div>
                    </div>
                )}

                {/* Respiratory Rate (All Modes EXCEPT PSV) */}
                {params.mode !== 'PSV' && (
                    <div>
                      <div className="flex justify-between text-sm mb-1"><span>Respiratory Rate (RR)</span><span className="font-mono text-blue-600">{params.respiratoryRate} /min</span></div>
                      <input type="range" min="8" max="40" step="1" value={params.respiratoryRate} onChange={(e) => setParams(p => ({...p, respiratoryRate: Number(e.target.value)}))} className="w-full accent-blue-600"/>
                    </div>
                )}

                {/* Inspiratory Time (VCV/PCV) */}
                {(params.mode === 'VCV' || params.mode === 'PCV') && (
                    <div>
                      <div className="flex justify-between text-sm mb-1"><span>Inspiratory Time (Ti)</span><span className="font-mono text-blue-600">{params.inspiratoryTime.toFixed(2)} s (Max: {derivedParams.TiMax} s)</span></div>
                      <input type="range" min="0.3" max="3.0" step="0.05" value={params.inspiratoryTime} onChange={handleTiChange} className="w-full accent-blue-600"/>
                    </div>
                )}

                {/* Derived I:E Ratio, Te, and Flow Rate */}
                <div className="grid grid-cols-3 gap-2 text-center border-t border-gray-200 pt-3">
                   <div className="p-1 bg-gray-50 rounded">
                        <span className="text-xs text-gray-500 block">I:E Ratio</span>
                        <span className="font-bold text-lg text-blue-700">{derivedParams.ieRatioDisplay}</span>
                   </div>
                   {/* NEW: Expiratory Time (Te) Display */}
                   <div className="p-1 bg-gray-50 rounded">
                        <span className="text-xs text-gray-500 block">Te (Exp)</span>
                        <span className="font-bold text-lg text-blue-700">{derivedParams.expDuration.toFixed(2)} s</span>
                   </div>
                   <div className="p-1 bg-gray-50 rounded">
                        <span className="text-xs text-gray-500 block">{params.mode === 'VCV' ? 'Req. Flow' : 'Peak Flow'}</span>
                        <span className="font-bold text-lg text-blue-700">
                            {params.mode === 'VCV' ? derivedParams.requiredFlowLpm.toFixed(0) : scales.fMax.toFixed(0)} L/min
                        </span>
                   </div>
                </div>

                {/* Flow Pattern Selection (VCV/PCV) */}
                {(params.mode === 'VCV' || params.mode === 'PCV') && (
                    <div className="border-t border-gray-200 pt-3">
                      <label className="text-sm font-semibold mb-2 block">Flow Pattern</label>
                      <div className="flex space-x-4">
                        <label className="flex items-center text-sm"><input type="radio" name="flowPattern" value="SQUARE" checked={params.flowPattern === 'SQUARE'} onChange={(e) => setParams(p => ({...p, flowPattern: e.target.value}))} className="form-radio h-4 w-4 text-blue-600 border-gray-300"/><span className="ml-2">SQUARE (VCV)</span></label>
                        <label className="flex items-center text-sm"><input type="radio" name="flowPattern" value="RAMP" checked={params.flowPattern === 'RAMP'} onChange={(e) => setParams(p => ({...p, flowPattern: e.target.value}))} className="form-radio h-4 w-4 text-blue-600 border-gray-300"/><span className="ml-2">RAMP (Decel)</span></label>
                      </div>
                    </div>
                )}

                {/* PEEP */}
                <div>
                  <div className="flex justify-between text-sm mb-1"><span>PEEP</span><span className="font-mono text-blue-600">{params.peep} cmH2O</span></div>
                  <input type="range" min="0" max="20" step="1" value={params.peep} onChange={(e) => setParams(p => ({...p, peep: Number(e.target.value)}))} className="w-full accent-blue-600"/>
                </div>
                
                {/* FiO2 Slider */}
                <div>
                  <div className="flex justify-between text-sm mb-1"><span>FiO2</span><span className="font-mono text-blue-600">{(params.fiO2 * 100).toFixed(0)} %</span></div>
                  <input type="range" min="0.21" max="1.0" step="0.01" value={params.fiO2} onChange={handleFiO2Change} className="w-full accent-blue-600"/>
                  <p className="text-xs text-gray-500 mt-1">Fraction of Inspired Oxygen (21% - 100%)</p>
                </div>


              </div>
            </div>

            {/* Special Maneuvers */}
            <div className="bg-white rounded-xl p-6 border border-gray-300">
              <div className="flex items-center mb-4 text-yellow-600"><TrendingUp className="w-5 h-5 mr-2"/><h2 className="font-bold">Tools / Maneuvers</h2></div>
              
              <div className="space-y-3">
                 {/* Recruitment Button */}
                 <button onClick={() => setIsRecruiting(!isRecruiting)} className={`w-full py-2 px-4 rounded-lg font-bold text-sm transition border ${isRecruiting ? 'bg-yellow-100 text-yellow-600 border-yellow-600' : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'}`}>
                    {isRecruiting ? 'RECRUITMENT ACTIVE' : 'Start Recruitment (30/40 cmH2O)'}
                 </button>
                 
                 {/* HOLD BUTTONS */}
                 <div className="grid grid-cols-2 gap-3">
                     <button 
                        onClick={() => setInspHoldRequest(!inspHoldRequest)} 
                        className={`flex items-center justify-center py-3 px-3 rounded-lg font-bold text-xs transition border ${
                            inspHoldRequest 
                            ? 'bg-blue-600 text-white border-blue-700 animate-pulse' 
                            : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                        }`}
                     >
                        <PauseCircle className="w-4 h-4 mr-1" /> {inspHoldRequest ? 'HOLDING INSP...' : 'INSP HOLD'}
                     </button>
                     <button 
                        onClick={() => setExpHoldRequest(!expHoldRequest)} 
                        className={`flex items-center justify-center py-3 px-3 rounded-lg font-bold text-xs transition border ${
                            expHoldRequest 
                            ? 'bg-red-600 text-white border-red-700 animate-pulse' 
                            : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                        }`}
                     >
                        <StopCircle className="w-4 h-4 mr-1" /> {expHoldRequest ? 'HOLDING EXP...' : 'EXP HOLD'}
                     </button>
                 </div>
                 
                 <p className="text-[10px] text-gray-500 text-center mt-1">Hold buttons will sync with the next breath cycle.</p>
              </div>
            </div>
            
            <footer className="mt-8 pt-6 border-t border-gray-300 text-center text-xs text-gray-500">
                &copy; 2025 Ventilator Simulation Pro &nbsp;|&nbsp; Powered by GitHub
            </footer>

          </div>
        </div>
      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
