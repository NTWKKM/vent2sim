import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Play, Pause, Activity, Settings, HeartPulse, AlertCircle, TrendingUp, Filter, BarChart2, User, Clock, PauseCircle, StopCircle } from 'lucide-react';

// ==================== PHYSICS CONSTANTS ====================
const DT = 0.016; // Time step (seconds) ~60fps
const MAX_HISTORY = 1500; // ~24 seconds of waveform history
const PEAK_WINDOW = 300; // ~5 second window for peak calculation

// Pressure rise smoothing (Rise Time simulation for PCV/PSV)
const PCV_RISE_SMOOTHING = 0.08;

// Expiratory resistance multiplier (ETT + valve)
const EXP_RESISTANCE_MULTIPLIER = 1.5;

// Circuit compliance (ml/cmH2O)
const CIRCUIT_COMPLIANCE = 2.5;

// ==================== ADVANCED PHYSICS: DYNAMIC COMPLIANCE ====================
// Implements: Hysteresis, Non-linear S-shape, Lower/Upper Inflection Points
// References: PDF 3, 4 - Hysteresis & Elastic Properties
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

// ==================== ADVANCED PHYSICS: DYNAMIC RESISTANCE ====================
// Implements: Rohrer Equation (K1*Flow + K2*Flow²), Airway Tethering, Dynamic Compression
// References: PDF 5, 6 - Resistance physiology
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

// ==================== HELPER: Linear Interpolation ====================
const lerp = (start, end, factor) => start + (end - start) * factor;

// ==================== PATHOLOGY PRESETS ====================
const PATHOLOGY_PRESETS = {
  NORMAL: {
    name: 'Normal (Adult on ETT)',
    resL: 15, compL: 50, resR: 15, compR: 50,
    shunt: 0.05, deadspace: 0.15,
    frcOffset: 0.0, lungCapacity: 3.0,
    note: 'Standard adult. Normal S-shape P/V curve.'
  },
  ARDS: {
    name: 'ARDS (Stiff Lungs - Baby Lung)',
    resL: 15, compL: 30, resR: 15, compR: 30,
    shunt: 0.30, deadspace: 0.35,
    frcOffset: 0.0, lungCapacity: 1.0,
    note: 'Low compliance, high inflection points, needs recruitment.'
  },
  COPD: {
    name: 'COPD (Mild/Moderate)',
    resL: 20, compL: 60, resR: 20, compR: 60,
    shunt: 0.10, deadspace: 0.30,
    frcOffset: 1.0, lungCapacity: 3.5,
    note: 'Moderate R, High C, mild air trapping. Avoid high RR.'
  },
  EMPHYSEMA: {
    name: 'Emphysema (Severe - Floppy Lungs)',
    resL: 25, compL: 120, resR: 25, compR: 120,
    shunt: 0.15, deadspace: 0.45,
    frcOffset: 2.3, lungCapacity: 3.0,
    note: 'SEVERE air trapping! High C but Vt limited by Balloon Effect.'
  },
  PULMONARY_EDEMA: {
    name: 'Pulmonary Edema',
    resL: 15, compL: 25, resR: 15, compR: 25,
    shunt: 0.25, deadspace: 0.25,
    frcOffset: 0.0, lungCapacity: 2.0,
    note: 'Fluid → low compliance. High shunt → SpO2 drops.'
  },
  UNILATERAL_C_DEC: {
    name: 'Unilateral Low C (Right)',
    resL: 15, compL: 50, resR: 15, compR: 20,
    shunt: 0.15, deadspace: 0.20,
    frcOffset: 0.0, lungCapacity: 2.5,
    note: 'Pneumonia/collapse on right. Preferential flow to left.'
  },
  CUSTOM: {
    name: 'Custom Settings',
    resL: 15, compL: 50, resR: 15, compR: 50,
    shunt: 0.05, deadspace: 0.15,
    frcOffset: 0.0, lungCapacity: 3.0,
    note: 'Manual control.'
  }
};

// ==================== INITIAL STATE ====================
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
  resL: 15, compL: 50, resR: 15, compR: 50,
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
  pmusSyncMode: 'AUTO_SYNC'
};

// ==================== HELPER FUNCTIONS ====================
const calculatePBW = (gender, heightCm) => {
  const heightInches = heightCm * 0.393701;
  if (gender === 'M') {
    return 50 + 2.3 * (heightInches - 60);
  } else {
    return 45.5 + 2.3 * (heightInches - 60);
  }
};

// ==================== MAIN APP COMPONENT ====================
const App = () => {
  // ===== STATE MANAGEMENT =====
  const [params, setParams] = useState(INITIAL_STATE);
  const [isRunning, setIsRunning] = useState(false);
  const [isRecruiting, setIsRecruiting] = useState(false);
  
  // Auto-scale state for dynamic Y-axis
  const [scales, setScales] = useState({ pMax: 40, fMax: 60, vMax: 600 });
  const scalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });
  const displayedScalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });
  
  // Monitored values
  const [monitoredValues, setMonitoredValues] = useState({
    Pplat: 0, Pmean: 0, Cstat: 0, AutoPEEP: 0,
    TotalRR: 0, MV: 0, VtExp: 0,
    VPeakAbs: 0, VPeakRel: 0,
    SpO2: 98, EtCO2: 35,
    FlowLimitationDetected: false // NEW: Track flow limitation
  });
  
  const [backupActive, setBackupActive] = useState(false);
  const [inspHoldRequest, setInspHoldRequest] = useState(false);
  const [expHoldRequest, setExpHoldRequest] = useState(false);
  const [holdStatus, setHoldStatus] = useState(null);
  
  // Simulation state
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
  
  // History for graphs
  const history = useRef({
    paw: new Array(MAX_HISTORY).fill(0),
    flow: new Array(MAX_HISTORY).fill(0),
    flowL: new Array(MAX_HISTORY).fill(0),
    flowR: new Array(MAX_HISTORY).fill(0),
    vol: new Array(MAX_HISTORY).fill(0),
    currentLoopPV: [],
    currentLoopFV: [],
    lastLoopPV: [],
    lastLoopFV: []
  });
  
  // Canvas references
  const canvasRefP = useRef(null);
  const canvasRefF = useRef(null);
  const canvasRefV = useRef(null);
  const canvasRefPV = useRef(null);
  const canvasRefFV = useRef(null);
  
  // ===== DERIVED CALCULATIONS =====
  const derivedParams = useMemo(() => {
    const cycleDuration = 60 / params.respiratoryRate;
    const inspDuration = params.inspiratoryTime;
    const TiMax = cycleDuration * 0.95;
    const safeTi = Math.min(inspDuration, TiMax - 0.05);
    const expDuration = cycleDuration - safeTi;
    
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
      ieRatioDisplay: isFinite(expDuration / safeTi) ? (expDuration / safeTi).toFixed(1) : '0.0',
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
  
  // ===== STATE RESET & INITIALIZATION =====
  const resetSimState = useCallback(() => {
    const p = params;
    const C_L_Lps = p.compL / 1000;
    const C_R_Lps = p.compR / 1000;
    
    // Initial volume: PEEP + FRC offset (air trapping)
    const V_L_PEEP = (p.peep * C_L_Lps) + (p.frcOffset / 2);
    const V_R_PEEP = (p.peep * C_R_Lps) + (p.frcOffset / 2);
    const initialVolAbs = (V_L_PEEP + V_R_PEEP) * 1000;
    
    simState.current = {
      time: 0, cycleTime: 0, patientTime: 0,
      phase: 'EXP',
      volL: V_L_PEEP, volR: V_R_PEEP,
      paw: p.peep,
      valveFlow: 0, valvePressure: p.peep,
      volCircuit: (p.peep * CIRCUIT_COMPLIANCE) / 1000,
      flowTotal: 0, flowL: 0, flowR: 0,
      recruitmentTimer: 0, recruitmentStep: 0,
      pawSum: 0, pawCount: 0,
      pPlatTemp: p.peep, autoPeepTemp: p.peep,
      volPeakCycle: initialVolAbs,
      currentPeakFlow: 0,
      lastBreathTime: Date.now(),
      timeSinceLastBreath: 0,
      isBackupCycle: false,
      holdTimer: 0,
      pPlatCaptured: false,
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
    
    const initScales = {
      pMax: p.inspiratoryPressure + p.peep + 10,
      fMax: 60,
      vMax: p.tidalVolume + 200
    };
    setScales(initScales);
    scalesRef.current = initScales;
    displayedScalesRef.current = initScales;
    
    setMonitoredValues({
      Pplat: p.peep, Pmean: p.peep, Cstat: 0, AutoPEEP: 0,
      TotalRR: 0, MV: 0, VtExp: 0,
      VPeakAbs: initialVolAbs, VPeakRel: 0,
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
  
  // ===== PATHOLOGY MANAGEMENT =====
  const handlePathologyChange = (e) => {
    const newPathology = e.target.value;
    const preset = PATHOLOGY_PRESETS[newPathology] || PATHOLOGY_PRESETS['NORMAL'];
    setParams(p => ({
      ...p,
      pathology: newPathology,
      resL: preset.resL, compL: preset.compL,
      resR: preset.resR, compR: preset.compR,
      shunt: preset.shunt, deadspace: preset.deadspace,
      frcOffset: preset.frcOffset, lungCapacity: preset.lungCapacity
    }));
  };
  
  useEffect(() => {
    if (params.pathology !== 'CUSTOM') {
      const preset = PATHOLOGY_PRESETS[params.pathology];
      setParams(p => ({
        ...p,
        resL: preset.resL, compL: preset.compL,
        resR: preset.resR, compR: preset.compR,
        shunt: preset.shunt, deadspace: preset.deadspace,
        frcOffset: preset.frcOffset, lungCapacity: preset.lungCapacity
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
    
    // Absolute volume (includes PEEP + FRC)
    const V_Absolute_L_Current = s.volL + s.volR;
    // Relative volume (for display - zero at breath start)
    const V_Relative_mL_Current = Math.max(0, (V_Absolute_L_Current * 1000) - ((p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000)));
    
    // ===== TRIGGER LOGIC & ASYNCHRONY =====
    let triggerBreath = false;
    let Pmus = 0;
    let isApneaTrigger = false;
    
    // Apnea check
    if (p.mode === 'PSV' && s.timeSinceLastBreath > p.apneaTime) {
      triggerBreath = true;
      isApneaTrigger = true;
    }
    
    // Patient trigger & Pmus
    if (p.spontaneousRR > 0) {
      if (s.patientTime >= patientCycleDur) s.patientTime = 0;
      const Ti_mus = patientCycleDur * 0.4;
      const t_mus = s.patientTime;
      
      // Inspiratory effort (negative Pmus)
      if (t_mus < Ti_mus) {
        const intensity = d.pmusMagnitude * 2.5;
        Pmus = -1 * intensity * (t_mus/Ti_mus) * Math.exp(1 - (t_mus/(Ti_mus*0.3)));
        if (Pmus < -d.pmusMagnitude) Pmus = -d.pmusMagnitude;
        
        if (s.phase === 'EXP' && p.mode === 'PSV' && !triggerBreath) {
          triggerBreath = true;
        }
      }
      // Expiratory effort (positive Pmus - abdominal muscles)
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
    
    // Machine trigger
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
    
    // ===== PHASE TRANSITION & MONITORING =====
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
      
      // Calculate elastic recoil pressure
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
    
    // ===== MODE-SPECIFIC CONTROL LOGIC =====
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
    } else if (s.phase === 'HOLD_INS') {
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
    } else if (s.phase === 'HOLD_EXP') {
      targetMode = 'PC';
      targetFlow = 0;
      const P_static_exp = (s.volL / CL_dynamic + s.volR / CR_dynamic) / 2;
      targetPaw = P_static_exp;
      setMonitoredValues(m => ({...m, AutoPEEP: Math.max(0, P_static_exp - p.peep)}));
      if (!expHoldRequest) {
        triggerBreath = true;
        setHoldStatus(null);
      }
    } else if (s.phase === 'INS') {
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
      } else if (effectiveMode === 'PCV') {
        targetMode = 'PC';
        if (s.cycleTime < d.inspDuration) targetPaw = p.inspiratoryPressure + p.peep;
        else endInsp = true;
      } else if (effectiveMode === 'PSV') {
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
    } else {
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
    } else {
      // VC mode
      s.valveFlow = lerp(s.valveFlow, targetFlow, smoothing);
      const totalFlow = s.valveFlow;
      const GL = 1/RL;
      const GR = 1/RR;
      currentPaw = (totalFlow + (PalvL * GL) + (PalvR * GR)) / (GL + GR);
      s.paw = currentPaw;
      s.flowL = (currentPaw - PalvL) / RL;
      s.flowR = (currentPaw - PalvR) / RR;
    }
    
    // Circuit compliance dynamics
    const prevVolCircuit = s.volCircuit;
    const newVolCircuit = (currentPaw * CIRCUIT_COMPLIANCE) / 1000;
    s.volCircuit = newVolCircuit;
    const flowCircuit = (newVolCircuit - prevVolCircuit) / DT;
    
    s.flowTotal = s.flowL + s.flowR + flowCircuit;
    s.paw = currentPaw;
    
    // Volume integration
    s.volL += s.flowL * DT;
    s.volR += s.flowR * DT;
    if (s.volL < 0) s.volL = 0;
    if (s.volR < 0) s.volR = 0;
    
    const V_Absolute_mL = (s.volL + s.volR) * 1000;
    
    s.pawSum += s.paw;
    s.pawCount += 1;
    
    // Peak tracking
    if (s.phase === 'INS') {
      s.volPeakCycle = Math.max(s.volPeakCycle, V_Absolute_mL);
      if (s.cycleTime > d.inspDuration * 0.95) s.pPlatTemp = (PalvL + PalvR) / 2;
    }
    
    // ===== FLOW LIMITATION DETECTION =====
    // Flow limitation: Paw increases but flow doesn't increase (or decreases)
    if (s.phase === 'EXP' && s.flowTotal < -0.1) { // Negative flow = expiration
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
    
    // History recording
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
  
  // ===== AUTO-SCALE LOGIC =====
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
  
  // ===== DRAWING FUNCTIONS =====
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
      ctx.strokeStyle = '#374151';
      ctx.fillStyle = '#f3f4f6';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      
      if (midZero) {
        const totalRange = yMaxPos + yMaxNeg;
        const scale = h / totalRange;
        const zeroYPos = h - (yMaxNeg * scale);
        ctx.beginPath();
        ctx.strokeStyle = '#9ca3af';
        ctx.moveTo(35, zeroYPos);
        ctx.lineTo(w, zeroYPos);
        ctx.stroke();
        const steps = 4;
        for(let i=0; i<=steps; i++) {
          let val = yMaxPos - (i * (yMaxPos)/steps);
          let y = zeroYPos - (val * scale);
          if (y < 0) continue;
          ctx.beginPath();
          ctx.strokeStyle = '#374151';
          ctx.moveTo(35, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          ctx.fillText(val.toFixed(0), 32, y+3);
        }
        for(let i=0; i<=steps; i++) {
          let val = yMaxNeg - (i * (yMaxNeg)/steps);
          let y = zeroYPos + (val * scale);
          if (y > h) continue;
          ctx.beginPath();
          ctx.strokeStyle = '#374151';
          ctx.moveTo(35, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          if (val !== 0) ctx.fillText('-'+val.toFixed(0), 32, y+3);
        }
      } else {
        const yMax = yMaxPos;
        const numYTicks = 5;
        for (let i = 0; i <= numYTicks; i++) {
          let yValue = ((numYTicks - i) * (yMax / numYTicks)).toFixed(0);
          let yPos = (i / numYTicks) * (h - 10) + 5;
          ctx.beginPath();
          ctx.moveTo(35, yPos);
          ctx.lineTo(w, yPos);
          ctx.stroke();
          ctx.fillText(yValue, 32, yPos + 3);
        }
      }
      ctx.beginPath();
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 1;
      ctx.moveTo(35, 0);
      ctx.lineTo(35, h);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = yColor;
      ctx.font = '12px sans-serif';
      ctx.fillText(yLabel, 40, 15);
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
  
  const drawLoops = useCallback(() => {
    const ctxPV = canvasRefPV.current?.getContext('2d');
    const ctxFV = canvasRefFV.current?.getContext('2d');
    if (!ctxPV || !ctxFV) return;
    
    const w = ctxPV.canvas.width;
    const h = ctxPV.canvas.height;
    const paddingLeft = 40;
    const paddingRight = 10;
    const paddingBottom = 35;
    const paddingTop = 20;
    const innerW = w - paddingLeft - paddingRight;
    const innerH = h - paddingTop - paddingBottom;
    
    const pMax = scalesRef.current.pMax;
    const vMax = scalesRef.current.vMax;
    const fMax = scalesRef.current.fMax;
    
    const drawLoopGrid = (ctx, xMax, yMax, xLabel, yLabel, midZeroY = false) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#374151';
      ctx.fillStyle = '#f3f4f6';
      ctx.font = '10px sans-serif';
      ctx.lineWidth = 1;
      
      ctx.beginPath();
      ctx.moveTo(paddingLeft, h - paddingBottom);
      ctx.lineTo(w - paddingRight, h - paddingBottom);
      ctx.moveTo(paddingLeft, paddingTop);
      ctx.lineTo(paddingLeft, h - paddingBottom);
      ctx.stroke();
      
      ctx.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        const xVal = (xMax / 4) * i;
        const xPos = paddingLeft + (innerW / 4) * i;
        ctx.beginPath();
        ctx.moveTo(xPos, h - paddingBottom);
        ctx.lineTo(xPos, h - paddingBottom + 4);
        ctx.stroke();
        ctx.fillText(xVal.toFixed(0), xPos, h - paddingBottom + 15);
      }
      
      ctx.textAlign = 'center';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(xLabel, paddingLeft + innerW / 2, h - 5);
      ctx.textAlign = 'right';
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#9ca3af';
      
      const steps = 4;
      for(let i=0; i<=steps; i++) {
        let val, y;
        if(midZeroY) {
          val = yMax - (i * (yMax*2)/steps);
          y = paddingTop + (i * innerH/steps);
        } else {
          val = yMax - (i * yMax/steps);
          y = paddingTop + (i * innerH/steps);
        }
        ctx.beginPath();
        ctx.moveTo(paddingLeft-4, y);
        ctx.lineTo(paddingLeft, y);
        ctx.stroke();
        ctx.fillText(val.toFixed(0), paddingLeft - 8, y + 3);
      }
      
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e5e7eb';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(yLabel, 5, 12);
      
      if(midZeroY) {
        const midY = paddingTop + innerH/2;
        ctx.strokeStyle = '#4b5563';
        ctx.beginPath();
        ctx.moveTo(paddingLeft, midY);
        ctx.lineTo(w-paddingRight, midY);
        ctx.stroke();
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
    
    // P/V Loop
    drawLoopGrid(ctxPV, pMax, vMax, 'Pressure (cmH2O)', 'Volume (ml)', false);
    ctxPV.globalAlpha = 0.3;
    drawLoopLine(ctxPV, history.current.lastLoopPV, '#f59e0b', 'p', 'v', pMax, vMax, false);
    ctxPV.globalAlpha = 1.0;
    drawLoopLine(ctxPV, history.current.currentLoopPV, '#f59e0b', 'p', 'v', pMax, vMax, false);
    
    // F/V Loop
    drawLoopGrid(ctxFV, vMax, fMax, 'Volume (ml)', 'Flow (L/min)', true);
    ctxFV.globalAlpha = 0.3;
    drawLoopLine(ctxFV, history.current.lastLoopFV, '#10b981', 'v', 'f', vMax, fMax, true);
    ctxFV.globalAlpha = 1.0;
    drawLoopLine(ctxFV, history.current.currentLoopFV, '#10b981', 'v', 'f', vMax, fMax, true);
  }, []);
  
  // ===== MAIN LOOP =====
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
  
  // ===== EVENT HANDLERS =====
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
    const numValue = Math.max(0, Math.min(1.0, Number(value)));
    setParams(p => ({ ...p, [key]: numValue }));
  };
  
  const handleFiO2Change = (e) => {
    const numValue = Math.max(0.21, Math.min(1.0, Number(e.target.value)));
    setParams(p => ({ ...p, fiO2: numValue }));
  };
  
  const handlePatientDataChange = (key, value) => {
    let numValue = value;
    if (key === 'heightCm' || key === 'actualWeightKg') {
      numValue = Math.max(0, Number(value));
    }
    setParams(p => ({ ...p, [key]: numValue }));
  };
  
  return (
    <div className="w-full h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100 overflow-hidden flex flex-col">
      {/* Header */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-4 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Activity className="w-8 h-8 text-white" />
            <h1 className="text-3xl font-bold text-white">Ventilator Simulation Pro</h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setIsRunning(!isRunning)}
              className={`px-4 py-2 rounded-lg font-semibold transition-all ${
                isRunning 
                  ? 'bg-red-500 hover:bg-red-600 text-white' 
                  : 'bg-green-500 hover:bg-green-600 text-white'
              }`}
            >
              {isRunning ? <Pause className="inline w-5 h-5 mr-2" /> : <Play className="inline w-5 h-5 mr-2" />}
              {isRunning ? 'Pause' : 'Start'}
            </button>
            <button
              onClick={() => { setIsRunning(false); resetSimState(); }}
              className="px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white rounded-lg font-semibold transition-all"
            >
              <StopCircle className="inline w-5 h-5 mr-2" />
              Reset
            </button>
            <button
              onClick={() => setIsRecruiting(!isRecruiting)}
              className={`px-4 py-2 rounded-lg font-semibold transition-all ${
                isRecruiting
                  ? 'bg-orange-500 hover:bg-orange-600 text-white'
                  : 'bg-slate-600 hover:bg-slate-700 text-white'
              }`}
            >
              <TrendingUp className="inline w-5 h-5 mr-2" />
              {isRecruiting ? 'Stop' : 'Recruit'}
            </button>
          </div>
        </div>
      </div>
      
      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex gap-4 p-4 overflow-auto">
          {/* Left Panel - Waveforms */}
          <div className="flex-1 flex flex-col gap-4">
            {/* Pressure */}
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-amber-400 mb-2">Pressure (Paw)</h3>
              <canvas ref={canvasRefP} width={600} height={120} className="w-full border border-slate-600 rounded" />
            </div>
            
            {/* Flow */}
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-emerald-400 mb-2">Flow (L/min) - Green: Total, Red: Right, Blue: Left</h3>
              <canvas ref={canvasRefF} width={600} height={120} className="w-full border border-slate-600 rounded" />
            </div>
            
            {/* Volume */}
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-blue-400 mb-2">Volume (mL - relative to PEEP)</h3>
              <canvas ref={canvasRefV} width={600} height={120} className="w-full border border-slate-600 rounded" />
            </div>
          </div>
          
          {/* Right Panel - Controls & Loops */}
          <div className="w-96 overflow-y-auto space-y-4 pr-2">
            {/* Loops */}
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-amber-400 mb-2">P/V Loop (Current/Ghost)</h3>
              <canvas ref={canvasRefPV} width={300} height={150} className="w-full border border-slate-600 rounded" />
            </div>
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-emerald-400 mb-2">F/V Loop</h3>
              <canvas ref={canvasRefFV} width={300} height={150} className="w-full border border-slate-600 rounded" />
            </div>
            
            {/* Ventilator Controls */}
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-teal-400 mb-3 flex items-center gap-2">
                <Settings className="w-4 h-4" /> Ventilator Settings
              </h3>
              <div className="space-y-2 text-sm">
                <div>
                  <label className="font-semibold">Mode: </label>
                  <select value={params.mode} onChange={handleModeChange} className="bg-slate-600 text-white px-2 py-1 rounded w-full">
                    <option value="VCV">VCV (Volume)</option>
                    <option value="PCV">PCV (Pressure)</option>
                    <option value="PSV">PSV (Support)</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="font-semibold block">RR: {params.respiratoryRate}/min</label>
                    <input type="range" min="4" max="40" value={params.respiratoryRate} onChange={(e) => setParams(p => ({...p, respiratoryRate: Number(e.target.value)}))} className="w-full" />
                  </div>
                  <div>
                    <label className="font-semibold block">PEEP: {params.peep} cmH2O</label>
                    <input type="range" min="0" max="15" value={params.peep} onChange={(e) => setParams(p => ({...p, peep: Number(e.target.value)}))} className="w-full" />
                  </div>
                </div>
                
                {params.mode === 'VCV' && (
                  <div>
                    <label className="font-semibold block">Vt: {params.tidalVolume} mL</label>
                    <input type="range" min="200" max="800" value={params.tidalVolume} onChange={(e) => setParams(p => ({...p, tidalVolume: Number(e.target.value)}))} className="w-full" />
                  </div>
                )}
                
                {params.mode === 'PCV' && (
                  <div>
                    <label className="font-semibold block">Pinsp: {params.inspiratoryPressure} cmH2O</label>
                    <input type="range" min="0" max="30" value={params.inspiratoryPressure} onChange={(e) => setParams(p => ({...p, inspiratoryPressure: Number(e.target.value)}))} className="w-full" />
                  </div>
                )}
                
                {params.mode === 'PSV' && (
                  <div>
                    <label className="font-semibold block">PS: {params.pressureSupport} cmH2O</label>
                    <input type="range" min="0" max="25" value={params.pressureSupport} onChange={(e) => setParams(p => ({...p, pressureSupport: Number(e.target.value)}))} className="w-full" />
                  </div>
                )}
                
                <div>
                  <label className="font-semibold block">Ti: {params.inspiratoryTime.toFixed(2)} s</label>
                  <input type="range" min="0.3" max={derivedParams.TiMax} step="0.05" value={params.inspiratoryTime} onChange={handleTiChange} className="w-full" />
                </div>
              </div>
            </div>
            
            {/* Patient Settings */}
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-teal-400 mb-3 flex items-center gap-2">
                <User className="w-4 h-4" /> Patient Mechanics
              </h3>
              <div className="space-y-2 text-sm">
                <div>
                  <label className="font-semibold">Pathology: </label>
                  <select value={params.pathology} onChange={handlePathologyChange} className="bg-slate-600 text-white px-2 py-1 rounded w-full">
                    {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">{PATHOLOGY_PRESETS[params.pathology].note}</p>
                </div>
                
                <div>
                  <label className="font-semibold block">Shunt: {(params.shunt * 100).toFixed(0)}%</label>
                  <input type="range" min="0" max="1" step="0.05" value={params.shunt} onChange={(e) => handleGasExchangeChange('shunt', e.target.value)} className="w-full" />
                  <p className="text-xs text-gray-400">Higher Shunt → Lower SpO2</p>
                </div>
                
                <div>
                  <label className="font-semibold block">Dead Space: {(params.deadspace * 100).toFixed(0)}%</label>
                  <input type="range" min="0" max="1" step="0.05" value={params.deadspace} onChange={(e) => handleGasExchangeChange('deadspace', e.target.value)} className="w-full" />
                  <p className="text-xs text-gray-400">Higher Dead Space → Higher EtCO2</p>
                </div>
              </div>
            </div>
            
            {/* Monitored Values */}
            <div className="bg-slate-700 rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold text-teal-400 mb-3 flex items-center gap-2">
                <BarChart2 className="w-4 h-4" /> Monitored Values
              </h3>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-slate-600 p-2 rounded">
                  <div className="font-semibold text-amber-400">Pplat</div>
                  <div className="text-lg">{monitoredValues.Pplat.toFixed(1)} cmH2O</div>
                </div>
                <div className="bg-slate-600 p-2 rounded">
                  <div className="font-semibold text-emerald-400">AutoPEEP</div>
                  <div className="text-lg">{monitoredValues.AutoPEEP.toFixed(1)} cmH2O</div>
                </div>
                <div className="bg-slate-600 p-2 rounded">
                  <div className="font-semibold text-blue-400">Cstat</div>
                  <div className="text-lg">{monitoredValues.Cstat.toFixed(0)} ml/cmH2O</div>
                </div>
                <div className="bg-slate-600 p-2 rounded">
                  <div className="font-semibold text-purple-400">Vt</div>
                  <div className="text-lg">{monitoredValues.VtExp.toFixed(0)} mL</div>
                </div>
                <div className="bg-slate-600 p-2 rounded">
                  <div className="font-semibold text-cyan-400">RR</div>
                  <div className="text-lg">{monitoredValues.TotalRR.toFixed(1)} /min</div>
                </div>
                <div className="bg-slate-600 p-2 rounded">
                  <div className="font-semibold text-orange-400">SpO2</div>
                  <div className="text-lg">{monitoredValues.SpO2}%</div>
                </div>
                <div className="bg-slate-600 p-2 rounded">
                  <div className="font-semibold text-pink-400">EtCO2</div>
                  <div className="text-lg">{monitoredValues.EtCO2} mmHg</div>
                </div>
                <div className={`${monitoredValues.FlowLimitationDetected ? 'bg-red-600' : 'bg-slate-600'} p-2 rounded`}>
                  <div className="font-semibold text-red-400">Flow Limit</div>
                  <div className="text-lg">{monitoredValues.FlowLimitationDetected ? 'YES' : 'NO'}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ==================== RENDER ====================
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);