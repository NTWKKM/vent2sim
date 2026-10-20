import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { 
  Play, Pause, Activity, Settings, HeartPulse, AlertCircle, TrendingUp, 
  Filter, BarChart2, User, Clock, PauseCircle, StopCircle, Zap, 
  ShieldAlert, Stethoscope, Wind, Droplets, Info, Sparkles
} from 'lucide-react';

// =========================================================================
// 1. ADVANCED RESPIRATORY BIOMECHANICS & FLUID CONSTANTS
// =========================================================================
const DT = 0.016;           // Base animation frame dt (approx 60 Hz)
const SUB_STEPS = 8;        // 8 sub-steps per frame -> 500 Hz high-fidelity ODE integration!
const SUB_DT = DT / SUB_STEPS; // 0.002s per physics sub-step
const MAX_HISTORY = 1200;   // History points for waveforms (~20s)
const PEAK_WINDOW = 250;    // Window for auto-scale tracking

// Endotracheal Tube (ETT) Rohrer / Blasius coefficients: DeltaP = K1*Flow + K2*Flow^1.75
const ETT_PROPERTIES = {
  '6.0': { name: 'ETT 6.0 mm (High Res)', k1: 2.8, k2: 14.0 },
  '7.0': { name: 'ETT 7.0 mm (Adult Small)', k1: 1.8, k2: 7.2 },
  '7.5': { name: 'ETT 7.5 mm (Standard Female)', k1: 1.5, k2: 5.0 },
  '8.0': { name: 'ETT 8.0 mm (Standard Male)', k1: 1.2, k2: 3.6 },
  '8.5': { name: 'ETT 8.5 mm (Adult Large)', k1: 0.95, k2: 2.4 },
  'TRACH': { name: 'Tracheostomy (Low Res)', k1: 0.65, k2: 1.5 }
};

// Linear interpolation helper
const lerp = (a, b, t) => a + (b - a) * t;

// =========================================================================
// 2. ROHRER FLUID DYNAMICS (DYNAMIC AIRWAY RESISTANCE)
// =========================================================================
// Calculates non-linear flow-dependent and volume-dependent resistance for each lung
const getDynamicAirwayResistance = (baseR, flowLps, volL, pathology, capacityL) => {
  // Rohrer equation coefficients (Viscous K1 + Turbulent K2)
  let k1 = 0.06;
  let k2 = 0.35;
  
  if (pathology === 'COPD' || pathology === 'EMPHYSEMA' || pathology === 'ASTHMA') {
    k1 = 0.12;
    k2 = 1.10; // High turbulence in narrowed bronchi & mucosal edema
  } else if (pathology === 'FIBROSIS') {
    k1 = 0.04;
    k2 = 0.20;
  }

  const absFlow = Math.abs(flowLps);
  const flowDependentR = baseR + (k1 * absFlow) + (k2 * absFlow * absFlow);

  // Airway tethering: volume expansion pulls open parenchymal bronchioles
  const halfCap = Math.max(0.2, capacityL / 2);
  const tetheringRatio = volL / halfCap;
  const tetheringConductance = 1 / (1 + 1.8 * Math.max(0, tetheringRatio));
  const volDependentR = flowDependentR * (0.45 + 0.55 * tetheringConductance);

  // Dynamic expiratory airway compression (Bernoulli effect + loss of radial traction in COPD)
  let compressionFactor = 1.0;
  if ((pathology === 'COPD' || pathology === 'EMPHYSEMA' || pathology === 'ASTHMA') && volL < capacityL * 0.35) {
    const collapseSeverity = Math.exp(-3.5 * Math.max(0, volL / (capacityL * 0.35)));
    compressionFactor = 1.0 + (collapseSeverity * 2.5); // Up to 3.5x resistance near closing capacity
  }

  return Math.max(baseR * 0.35, volDependentR * compressionFactor);
};

// =========================================================================
// 3. SIGMOID S-CURVE COMPLIANCE WITH PEEP RECRUITMENT & HYSTERESIS
// =========================================================================
const getDynamicAlveolarCompliance = (volL, baseC_ml, pathology, phase, capacityL, currentPEEP) => {
  const baseC_L = Math.max(0.005, baseC_ml / 1000);
  
  let lowerInflection_L = 0.12;
  let upperInflection_L = capacityL * 0.72;
  let distensionFactor = 12;
  let sigFactor = 1.8;
  let peepRecruitmentFactor = 1.0;

  switch (pathology) {
    case 'ARDS':
      lowerInflection_L = 0.22;
      upperInflection_L = capacityL * 0.55;
      distensionFactor = 28;
      sigFactor = 2.6;
      
      // ARDS PEEP Recruitment Zone (Gattinoni / Goligher response curve)
      if (currentPEEP < 6) {
        // Severe derecruitment & cyclic alveolar collapse
        peepRecruitmentFactor = 0.55 + (currentPEEP * 0.06);
      } else if (currentPEEP <= 14) {
        // Optimal alveolar recruitment window
        peepRecruitmentFactor = 0.91 + ((currentPEEP - 6) * 0.075);
        peepRecruitmentFactor = Math.min(1.52, peepRecruitmentFactor);
      } else {
        // High PEEP overdistension & microvascular compromise
        peepRecruitmentFactor = 1.52 - ((currentPEEP - 14) * 0.085);
        peepRecruitmentFactor = Math.max(0.95, peepRecruitmentFactor);
      }
      break;

    case 'FIBROSIS':
      lowerInflection_L = 0.06;
      upperInflection_L = capacityL * 0.45;
      distensionFactor = 32;
      sigFactor = 3.2;
      break;

    case 'COPD':
    case 'EMPHYSEMA':
      lowerInflection_L = 0.02;
      upperInflection_L = capacityL * 0.82;
      distensionFactor = 10;
      sigFactor = 1.3;
      break;

    default: // NORMAL
      lowerInflection_L = 0.10;
      upperInflection_L = capacityL * 0.82;
      distensionFactor = 10;
      sigFactor = 1.6;
  }

  // Base Sigmoidal Compliance
  const midpoint = (lowerInflection_L + upperInflection_L) / 2;
  const spread = Math.max(0.1, upperInflection_L - lowerInflection_L);
  const sigmoid = 1 / (1 + Math.exp(-sigFactor * (volL - midpoint) / spread));
  let effectiveC = baseC_L * (0.35 + 0.65 * sigmoid);

  // Tidal recruitment resistance near Lower Inflection Point (opening pressure hurdle)
  if ((phase === 'INS' || phase === 'HOLD_INS' || phase === 'REC') && volL < lowerInflection_L) {
    const recruitSig = 1 / (1 + Math.exp(-6 * (volL / lowerInflection_L)));
    effectiveC *= (0.30 + 0.70 * recruitSig);
  }

  // Overdistension stiffness curve above Upper Inflection Point
  if (volL > upperInflection_L) {
    const excess = volL - upperInflection_L;
    effectiveC *= Math.exp(-excess * distensionFactor);
  }

  // Surfactant Hysteresis effect: deflation curve exhibits higher compliance than inflation
  if (phase === 'EXP' || phase === 'HOLD_EXP') {
    effectiveC *= 1.18;
  }

  // Apply PEEP recruitment scaling
  if (pathology === 'ARDS') {
    effectiveC *= peepRecruitmentFactor;
  }

  return Math.max(0.002, effectiveC);
};

// =========================================================================
// 4. PATHOLOGY PRESETS (CLINICAL SPECIFICATIONS)
// =========================================================================
const PATHOLOGY_PRESETS = {
  NORMAL: {
    name: 'Normal Adult (Mechanically Ventilated)',
    resL: 12, compL: 50, resR: 12, compR: 50, compChest: 150,
    shunt: 0.05, deadspace: 0.18,
    frcOffset: 0.0, lungCapacity: 3.2,
    note: 'Standard adult respiratory mechanics with normal time constants (~0.4s).'
  },
  ARDS: {
    name: 'Severe ARDS (Baby Lung Model)',
    resL: 16, compL: 20, resR: 16, compR: 20, compChest: 120,
    shunt: 0.35, deadspace: 0.40,
    frcOffset: 0.0, lungCapacity: 2.2,
    note: 'Marked loss of aerated lung units. High driving pressure and recruitability with PEEP.'
  },
  COPD: {
    name: 'COPD / Bronchospasm',
    resL: 26, compL: 65, resR: 26, compR: 65, compChest: 130,
    shunt: 0.12, deadspace: 0.35,
    frcOffset: 1.2, lungCapacity: 3.6,
    note: 'Elevated expiratory resistance, prolonged expiratory time constant, risk of Auto-PEEP.'
  },
  EMPHYSEMA: {
    name: 'Severe Emphysema (High Compliance / Trapping)',
    resL: 30, compL: 110, resR: 30, compR: 110, compChest: 140,
    shunt: 0.18, deadspace: 0.45,
    frcOffset: 2.0, lungCapacity: 3.8,
    note: 'Loss of parenchymal elastic recoil leads to early dynamic airway collapse during expiration.'
  },
  PULMONARY_EDEMA: {
    name: 'Cardiogenic Pulmonary Edema',
    resL: 18, compL: 25, resR: 18, compR: 25, compChest: 130,
    shunt: 0.30, deadspace: 0.28,
    frcOffset: 0.1, lungCapacity: 2.4,
    note: 'Alveolar fluid flooding reduces compliance and causes ventilation-perfusion mismatch.'
  },
  UNILATERAL_C_DEC: {
    name: 'Asymmetric Lung Injury (Unilateral Right)',
    resL: 12, compL: 50, resR: 22, compR: 18, compChest: 140,
    shunt: 0.22, deadspace: 0.25,
    frcOffset: 0.0, lungCapacity: 2.8,
    note: 'Right lung stiff & obstructed. Produces Pendelluft gas transfer between lungs.'
  },
  OBESITY: {
    name: 'Morbid Obesity / Chest Wall Restriction',
    resL: 14, compL: 45, resR: 14, compR: 45, compChest: 55,
    shunt: 0.15, deadspace: 0.22,
    frcOffset: -0.3, lungCapacity: 2.5,
    note: 'Stiff chest wall increases pleural pressure. Paw is high but transpulmonary stress is dampened.'
  },
  CUSTOM: {
    name: 'Custom Physiological Settings',
    resL: 15, compL: 50, resR: 15, compR: 50, compChest: 140,
    shunt: 0.05, deadspace: 0.20,
    frcOffset: 0.0, lungCapacity: 3.0,
    note: 'Freely customize resistance, parenchymal compliance, and chest wall parameters.'
  }
};

// Initial state parameters
const INITIAL_STATE = {
  // Ventilator Machine Settings
  mode: 'PCV',
  tidalVolume: 450,           // ml
  inspiratoryPressure: 14,    // cmH2O (above PEEP)
  pressureSupport: 12,        // cmH2O (above PEEP)
  eSense: 25,                 // % of peak inspiratory flow
  respiratoryRate: 14,        // breaths/min
  inspiratoryTime: 1.0,       // seconds
  pauseTime: 0.0,             // seconds (optional inspiratory pause)
  peep: 8,                    // cmH2O
  flowPattern: 'SQUARE',      // 'SQUARE' or 'RAMP'
  apneaTime: 12,              // seconds
  fiO2: 0.40,                 // 21% - 100%
  riseTime: 0.12,             // seconds (valve rise slope)
  triggerType: 'FLOW',        // 'FLOW' or 'PRESSURE'
  triggerSens: 2.0,           // L/min for flow, cmH2O for pressure
  circuitCompliance: 2.0,     // ml/cmH2O
  ettSize: '7.5',             // ETT size ID
  tubeCompEnabled: false,     // Automatic Tube Compensation (ATC)

  // Patient Mechanics & Pathology
  pathology: 'NORMAL',
  resL: 12, compL: 50,
  resR: 12, compR: 50,
  compChest: 150,             // ml/cmH2O (Chest wall compliance)
  shunt: 0.05,
  deadspace: 0.18,
  frcOffset: 0.0,             // L (air trapping offset)
  lungCapacity: 3.2,          // L

  // Patient Profile
  gender: 'M',
  heightCm: 170,
  actualWeightKg: 70,
  weightMode: 'PBW',

  // Spontaneous Effort
  spontaneousRR: 0,
  pmusSyncMode: 'AUTO_SYNC',  // 'AUTO_SYNC' | 'FIGHTING' | 'REVERSE' | 'INEFFECTIVE'
  pmusEffort: 6.0,            // cmH2O negative inspiratory effort
  bicarbonate: 24             // mEq/L for ABG calculation
};

// Calculate Predicted Body Weight (PBW) in kg
const calculatePBW = (gender, heightCm) => {
  const heightInches = heightCm * 0.393701;
  return gender === 'M' 
    ? 50 + 2.3 * (heightInches - 60)
    : 45.5 + 2.3 * (heightInches - 60);
};

// =========================================================================
// 5. MAIN VENTILATOR SIMULATOR COMPONENT
// =========================================================================
const App = () => {
  const [params, setParams] = useState(INITIAL_STATE);
  const [isRunning, setIsRunning] = useState(false);
  const [isRecruiting, setIsRecruiting] = useState(false);
  const [activeTab, setActiveTab] = useState('waveforms'); // 'waveforms' | 'abg' | 'mechanics'

  // Dynamic Scale references for smooth Canvas scaling
  const [scales, setScales] = useState({ pMax: 40, fMax: 60, vMax: 600 });
  const scalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });
  const displayedScalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });

  // Monitored Real-time Physiological Values
  const [monitoredValues, setMonitoredValues] = useState({
    Ppeak: 0,
    Pplat: 0,
    Pmean: 0,
    PEEPtotal: 0,
    AutoPEEP: 0,
    DrivingPressure: 0,
    TotalRR: 0,
    MV: 0,
    VtExp: 0,
    VPeakAbs: 0,
    VPeakRel: 0,
    Cstat: 0,
    Cdyn: 0,
    Raw: 0,
    MechanicalPower: 0,
    StressIndex: 1.0,
    TranspulmonaryP: 0,
    Ppl: -5,
    SpO2: 98,
    EtCO2: 36,
    PaO2: 95,
    PaCO2: 40,
    pH: 7.40,
    HCO3: 24,
    PF_Ratio: 237,
    AaGradient: 25,
    FlowLimitationDetected: false,
    AsynchronyEvent: null
  });

  const [backupActive, setBackupActive] = useState(false);
  const [inspHoldRequest, setInspHoldRequest] = useState(false);
  const [expHoldRequest, setExpHoldRequest] = useState(false);
  const [holdStatus, setHoldStatus] = useState(null);

  // Simulation Internal State Reference (continuous across animation ticks)
  const simState = useRef({
    time: 0,
    cycleTime: 0,
    patientTime: 0,
    phase: 'EXP',           // 'INS' | 'HOLD_INS' | 'EXP' | 'HOLD_EXP' | 'REC'
    volL: 0,                // L (absolute gas volume in Left Lung)
    volR: 0,                // L (absolute gas volume in Right Lung)
    volCircuit: 0,          // L (compressed volume in ventilator tubing)
    paw: 0,                 // cmH2O (airway pressure at Y-piece)
    flowTotal: 0,           // L/s
    flowL: 0,               // L/s
    flowR: 0,               // L/s
    flowPendelluft: 0,      // L/s (cross-compartment transfer)
    valveFlow: 0,           // L/s (ventilator delivery valve)
    valvePressure: 0,       // cmH2O (proportional valve target)
    pAlvL: 0,               // cmH2O
    pAlvR: 0,               // cmH2O
    pAlvMean: 0,            // cmH2O
    pPl: -5,                // cmH2O (pleural pressure)
    pMus: 0,                // cmH2O (patient effort)
    pPlatStatic: 0,         // cmH2O
    autoPeepTemp: 0,
    volPeakCycle: 0,
    currentPeakFlow: 0,
    lastBreathTime: Date.now(),
    timeSinceLastBreath: 0,
    isBackupCycle: false,
    pPlatCaptured: false,
    pawSum: 0,
    pawCount: 0,
    pPeakCycle: 0,
    recruitmentTimer: 0,

    // Pressure trajectory tracking for Stress Index estimation
    inspPressurePoints: [],
    flowLimitationCounter: 0,
    asynchronyTimer: 0,
    asynchronyType: null
  });

  // Circular history buffers for continuous 60fps graph rendering
  const history = useRef({
    paw: new Array(MAX_HISTORY).fill(8),
    flow: new Array(MAX_HISTORY).fill(0),
    flowL: new Array(MAX_HISTORY).fill(0),
    flowR: new Array(MAX_HISTORY).fill(0),
    vol: new Array(MAX_HISTORY).fill(0),
    ppl: new Array(MAX_HISTORY).fill(-5),
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

  // Derived patient & ventilation parameters
  const derivedParams = useMemo(() => {
    const cycleDuration = 60 / Math.max(1, params.respiratoryRate);
    const inspDuration = params.inspiratoryTime;
    const safeTi = Math.min(inspDuration, cycleDuration * 0.90);
    const expDuration = Math.max(0.1, cycleDuration - safeTi - (params.pauseTime || 0));
    const ieRatioDisplay = (expDuration / safeTi).toFixed(1);

    const PBW = calculatePBW(params.gender, params.heightCm);
    const safeVtMin = Math.round(4 * PBW);
    const safeVtMax = Math.round(8 * PBW);
    const isVtSafe = params.tidalVolume >= safeVtMin && params.tidalVolume <= safeVtMax;

    // Time constant calculations: Tau = R * C (in seconds)
    const tauL = (params.resL * (params.compL / 1000));
    const tauR = (params.resR * (params.compR / 1000));
    const cTotal = (params.compL + params.compR) / 1000;
    const rParallel = (params.resL * params.resR) / (params.resL + params.resR);
    const tauSystem = (rParallel * cTotal);

    // Flow requirement in VCV
    const Vt_L = params.tidalVolume / 1000;
    const requiredFlowLps = params.flowPattern === 'SQUARE'
      ? Vt_L / safeTi
      : (2 * Vt_L) / safeTi;

    return {
      cycleDuration,
      inspDuration: safeTi,
      expDuration,
      ieRatioDisplay,
      requiredFlowLps,
      requiredFlowLpm: requiredFlowLps * 60,
      PBW: PBW.toFixed(1),
      safeVtRange: `${safeVtMin}-${safeVtMax} ml`,
      isVtSafe,
      tauL: tauL.toFixed(2),
      tauR: tauR.toFixed(2),
      tauSystem: tauSystem.toFixed(2),
      rParallel: rParallel.toFixed(1)
    };
  }, [params]);

  // Reset simulation state
  const resetSimState = useCallback(() => {
    const p = params;
    const cL_Lps = p.compL / 1000;
    const cR_Lps = p.compR / 1000;
    const vL_PEEP = (p.peep * cL_Lps) + (Math.max(0, p.frcOffset) / 2);
    const vR_PEEP = (p.peep * cR_Lps) + (Math.max(0, p.frcOffset) / 2);
    const initVolAbs = (vL_PEEP + vR_PEEP) * 1000;

    simState.current = {
      time: 0,
      cycleTime: 0,
      patientTime: 0,
      phase: 'EXP',
      volL: vL_PEEP,
      volR: vR_PEEP,
      volCircuit: (p.peep * p.circuitCompliance) / 1000,
      paw: p.peep,
      flowTotal: 0,
      flowL: 0,
      flowR: 0,
      flowPendelluft: 0,
      valveFlow: 0,
      valvePressure: p.peep,
      pAlvL: p.peep,
      pAlvR: p.peep,
      pAlvMean: p.peep,
      pPl: -5,
      pMus: 0,
      pPlatStatic: p.peep,
      autoPeepTemp: 0,
      volPeakCycle: initVolAbs,
      currentPeakFlow: 0,
      lastBreathTime: Date.now(),
      timeSinceLastBreath: 0,
      isBackupCycle: false,
      pPlatCaptured: false,
      pawSum: 0,
      pawCount: 0,
      pPeakCycle: p.peep,
      recruitmentTimer: 0,
      inspPressurePoints: [],
      flowLimitationCounter: 0,
      asynchronyTimer: 0,
      asynchronyType: null
    };

    history.current.paw.fill(p.peep);
    history.current.flow.fill(0);
    history.current.flowL.fill(0);
    history.current.flowR.fill(0);
    history.current.vol.fill(0);
    history.current.ppl.fill(-5);
    history.current.currentLoopPV = [];
    history.current.currentLoopFV = [];
    history.current.lastLoopPV = [];
    history.current.lastLoopFV = [];

    const initScales = { 
      pMax: Math.max(30, p.inspiratoryPressure + p.peep + 12), 
      fMax: 60, 
      vMax: Math.max(500, p.tidalVolume + 200) 
    };
    setScales(initScales);
    scalesRef.current = initScales;
    displayedScalesRef.current = initScales;

    setMonitoredValues(m => ({
      ...m,
      Ppeak: p.peep,
      Pplat: p.peep,
      Pmean: p.peep,
      PEEPtotal: p.peep,
      AutoPEEP: 0,
      DrivingPressure: 0,
      TotalRR: p.respiratoryRate,
      VtExp: 0,
      VPeakAbs: initVolAbs,
      VPeakRel: 0
    }));
    setBackupActive(false);
    setHoldStatus(null);
  }, [params]);

  useEffect(() => {
    resetSimState();
  }, [resetSimState]);

  // Handle Pathology Preset Selection
  const handlePathologyChange = (e) => {
    const newPath = e.target.value;
    const preset = PATHOLOGY_PRESETS[newPath] || PATHOLOGY_PRESETS.NORMAL;
    setParams(p => ({
      ...p,
      pathology: newPath,
      resL: preset.resL,
      compL: preset.compL,
      resR: preset.resR,
      compR: preset.compR,
      compChest: preset.compChest,
      shunt: preset.shunt,
      deadspace: preset.deadspace,
      frcOffset: preset.frcOffset,
      lungCapacity: preset.lungCapacity
    }));
  };

  // =========================================================================
  // 6. HIGH-PRECISION SUB-STEPPING PHYSICS SOLVER (500 Hz)
  // =========================================================================
  const updatePhysics = useCallback(() => {
    if (!isRunning) return;

    const s = simState.current;
    const p = params;
    const d = derivedParams;

    // Run multiple micro-steps per frame to solve stiff ODEs with zero numerical instability
    for (let step = 0; step < SUB_STEPS; step++) {
      s.time += SUB_DT;
      if (s.phase !== 'HOLD_INS' && s.phase !== 'HOLD_EXP') {
        s.cycleTime += SUB_DT;
      }
      s.patientTime += SUB_DT;
      s.timeSinceLastBreath += SUB_DT;

      // -----------------------------------------------------------------------
      // A. Patient Spontaneous Breathing & Pmus Trajectory
      // -----------------------------------------------------------------------
      let Pmus = 0;
      let isPatientTriggered = false;
      const patientCycleDur = p.spontaneousRR > 0 ? (60 / p.spontaneousRR) : 999;

      if (p.spontaneousRR > 0) {
        if (s.patientTime >= patientCycleDur) {
          s.patientTime = 0;
        }

        const Ti_mus = patientCycleDur * 0.38; // Inspiratory muscle contraction time
        const t = s.patientTime;
        const maxEffort = p.pmusEffort || 6.0;

        // Neural inspiratory muscle pressure trajectory (bell-shaped bell curve)
        if (t < Ti_mus) {
          const tNorm = t / Ti_mus;
          Pmus = -1 * maxEffort * Math.sin(Math.PI * tNorm);
        } else {
          // Passive relaxation with minimal active exp effort
          Pmus = 0;
        }

        // Asynchrony modeling modes
        if (p.pmusSyncMode === 'INEFFECTIVE') {
          // Patient tries to breathe during auto-PEEP; effort is too weak to reach trigger threshold
          Pmus *= 0.45;
        } else if (p.pmusSyncMode === 'FIGHTING') {
          // Patient breathes out of phase (reverse phase / bucking)
          if (s.phase === 'INS') {
            Pmus = Math.max(0, maxEffort * 0.8); // Patient contracts expiratory muscles during inspiration!
          }
        }
      }
      s.pMus = Pmus;

      // -----------------------------------------------------------------------
      // B. Pleural Pressure (Ppl) & Transpulmonary Calculations
      // -----------------------------------------------------------------------
      // Total lung volume currently above baseline FRC
      const vTotalL = Math.max(0, (s.volL + s.volR) - (p.frcOffset || 0));
      const cChest_L = Math.max(0.02, p.compChest / 1000);
      
      // Pleural pressure = resting (-5 cmH2O) + elastic chest wall recoil + Pmus
      const ppl = -5.0 + (vTotalL / cChest_L) + Pmus;
      s.pPl = ppl;

      // -----------------------------------------------------------------------
      // C. Dynamic Resistance & Compliance with ETT Fluid Dynamics
      // -----------------------------------------------------------------------
      const cL_dynamic = getDynamicAlveolarCompliance(s.volL, p.compL, p.pathology, s.phase, p.lungCapacity / 2, p.peep);
      const cR_dynamic = getDynamicAlveolarCompliance(s.volR, p.compR, p.pathology, s.phase, p.lungCapacity / 2, p.peep);

      const rL_dynamic = getDynamicAirwayResistance(p.resL, s.flowL, s.volL, p.pathology, p.lungCapacity / 2);
      const rR_dynamic = getDynamicAirwayResistance(p.resR, s.flowR, s.volR, p.pathology, p.lungCapacity / 2);

      // Endotracheal Tube Rohrer coefficients
      const ettInfo = ETT_PROPERTIES[p.ettSize] || ETT_PROPERTIES['7.5'];
      const absTotalFlow = Math.abs(s.flowTotal);
      let rETT = ettInfo.k1 + (ettInfo.k2 * Math.pow(Math.max(0.01, absTotalFlow), 0.75));
      if (p.tubeCompEnabled) {
        // Automatic Tube Compensation (ATC) eliminates ETT resistive work of breathing
        rETT *= 0.15;
      }

      // Expiratory valve resistance multiplier
      const expResMultiplier = (s.phase === 'EXP' || s.phase === 'HOLD_EXP') ? 1.6 : 1.0;
      const RL = (rL_dynamic * expResMultiplier) + (rETT * 0.5);
      const RR = (rR_dynamic * expResMultiplier) + (rETT * 0.5);

      // Alveolar recoil pressures
      const pAlvL = (s.volL / cL_dynamic) + ppl;
      const pAlvR = (s.volR / cR_dynamic) + ppl;
      s.pAlvL = pAlvL;
      s.pAlvR = pAlvR;
      s.pAlvMean = (pAlvL + pAlvR) / 2;

      // -----------------------------------------------------------------------
      // D. Inter-Compartment Gas Transfer (Pendelluft Effect)
      // -----------------------------------------------------------------------
      // Driven by differential pressures between heterogeneous lung compartments
      const collateralResistance = 40; // cmH2O/(L/s) inter-bronchial collateral resistance
      const pendelluftFlow = (pAlvL - pAlvR) / collateralResistance;
      s.flowPendelluft = pendelluftFlow;

      // -----------------------------------------------------------------------
      // E. Ventilator Triggering & Phase Switching Logic
      // -----------------------------------------------------------------------
      let triggerBreath = false;
      let isApneaTrigger = false;

      // 1. Apnea Backup check in PSV
      if (p.mode === 'PSV' && s.timeSinceLastBreath > p.apneaTime) {
        triggerBreath = true;
        isApneaTrigger = true;
      }

      // 2. Patient Trigger Check
      if (s.phase === 'EXP' && p.spontaneousRR > 0) {
        if (p.triggerType === 'FLOW') {
          // Flow trigger: patient effort pulls flow above base bias flow
          const patientInspiratoryFlow = (s.paw - s.pAlvMean) / ((RL + RR) / 2);
          if (patientInspiratoryFlow * 60 >= p.triggerSens) {
            triggerBreath = true;
            isPatientTriggered = true;
          }
        } else {
          // Pressure trigger: patient effort pulls Paw below (PEEP - triggerSens)
          if (s.paw <= (p.peep - Math.abs(p.triggerSens))) {
            triggerBreath = true;
            isPatientTriggered = true;
          }
        }
      }

      // 3. Mandatory Machine Trigger
      if (p.mode !== 'PSV' && s.cycleTime >= d.cycleDuration) {
        if (expHoldRequest) {
          if (s.phase !== 'HOLD_EXP') {
            s.phase = 'HOLD_EXP';
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

      // -----------------------------------------------------------------------
      // F. Breath Transition & Cycle Analysis
      // -----------------------------------------------------------------------
      if (triggerBreath && s.phase !== 'INS' && s.phase !== 'HOLD_INS') {
        const now = Date.now();
        let instantRR = monitoredValues.TotalRR;
        if (s.lastBreathTime > 0) {
          const breathDurMs = now - s.lastBreathTime;
          if (breathDurMs > 400) {
            instantRR = 60000 / breathDurMs;
          }
        }
        s.lastBreathTime = now;

        // Calculate final expired tidal volume & intrinsic Auto-PEEP
        const vEndExp_mL = (s.volL + s.volR) * 1000;
        const vtExpired_mL = Math.max(0, s.volPeakCycle - vEndExp_mL);
        const autoPEEP = Math.max(0, s.pAlvMean - p.peep);

        // Static Compliance: Cstat = Vt / (Pplat - PEEPtotal)
        const drivingP = Math.max(1, s.pPlatStatic - (p.peep + autoPEEP));
        let calculatedCstat = 0;
        if (vtExpired_mL > 40 && drivingP > 0.5) {
          calculatedCstat = Math.min(180, vtExpired_mL / drivingP);
        }

        // Dynamic Compliance: Cdyn = Vt / (Ppeak - PEEP)
        const dynamicDrivingP = Math.max(1, s.pPeakCycle - p.peep);
        const calculatedCdyn = Math.min(150, vtExpired_mL / dynamicDrivingP);

        // Airway Resistance: Raw = (Ppeak - Pplat) / PeakFlow(L/s)
        const peakFlowLps = Math.max(0.1, s.currentPeakFlow / 60);
        const calculatedRaw = Math.max(1, (s.pPeakCycle - s.pPlatStatic) / peakFlowLps);

        // Mechanical Power (Gattinoni formula): MP = 0.098 * RR * [Vt * (Ppeak - 0.5 * DrivingP)] (Joules/min)
        const vt_L = vtExpired_mL / 1000;
        const mechanicalPower = 0.098 * instantRR * (vt_L * (s.pPeakCycle - (0.5 * drivingP)));

        // Stress Index: curvature of Paw during constant flow inspiration
        let stressIndex = 1.0;
        if (s.inspPressurePoints.length >= 8 && p.mode === 'VCV' && p.flowPattern === 'SQUARE') {
          const pts = s.inspPressurePoints;
          const pStart = pts[1];
          const pMid = pts[Math.floor(pts.length / 2)];
          const pEnd = pts[pts.length - 2];
          const midLinear = (pStart + pEnd) / 2;
          const delta = pMid - midLinear;
          // Negative delta means downward concavity (recruitment, b < 1), positive means upward (overdistension, b > 1)
          stressIndex = Math.max(0.6, Math.min(1.5, 1.0 + (delta / 4.0)));
        }

        // Transpulmonary Pressure at end-inspiration: PL = Pplat - Ppl
        const transpulmonaryP = s.pPlatStatic - s.pPl;

        // =====================================================================
        // G. Physiological Gas Exchange & Arterial Blood Gas (ABG) Simulator
        // =====================================================================
        // Alveolar ventilation: VA = RR * (Vt - Vd)
        const vd_mL = (p.deadspace * vtExpired_mL) + (p.circuitCompliance * s.pPeakCycle);
        const va_Lpm = Math.max(0.5, (instantRR * Math.max(50, vtExpired_mL - vd_mL)) / 1000);

        // CO2 Production based on predicted weight: VCO2 = 3.5 ml/kg/min
        const pbwNum = Number(d.PBW) || 70;
        const vco2_mLpm = 3.5 * pbwNum;

        // Arterial PaCO2: PaCO2 = (VCO2 * 0.863) / VA
        let calcPaCO2 = (vco2_mLpm * 0.863) / va_Lpm;
        calcPaCO2 = Math.max(15, Math.min(110, calcPaCO2));

        // Arterial pH via Henderson-Hasselbalch equation: pH = 6.10 + log10( [HCO3] / (0.0307 * PaCO2) )
        const hco3 = p.bicarbonate || 24;
        let calcPH = 6.10 + Math.log10(hco3 / (0.0307 * calcPaCO2));
        calcPH = Math.max(6.80, Math.min(7.75, calcPH));

        // Alveolar Oxygen Equation: PAO2 = (760 - 47)*FiO2 - PaCO2 / 0.8
        const paO2_alveolar = Math.max(20, (713 * p.fiO2) - (calcPaCO2 / 0.8));

        // Intrapulmonary Shunt (Qs/Qt) with PEEP recruitment and high Pplat microvascular compression
        let actualShunt = p.shunt;
        // PEEP recruitment reduces shunt in ARDS
        if (p.pathology === 'ARDS') {
          const peepRecruitBenefit = Math.max(0, (p.peep - 5) * 0.022);
          actualShunt = Math.max(0.06, actualShunt - peepRecruitBenefit);
        }
        // Excess Pplat compression increases dead space and shunt
        if (s.pPlatStatic > 30) {
          actualShunt += (s.pPlatStatic - 30) * 0.012;
        }

        // Arterial PaO2 via shunt equation & A-a gradient
        let calcPaO2 = (paO2_alveolar * (1 - actualShunt)) - (actualShunt * 80);
        calcPaO2 = Math.max(25, Math.min(550, calcPaO2));

        // SaO2 / SpO2 via Severinghaus / Adair equation with Bohr shift
        const p50_eff = 26.6 * Math.pow(10, 0.48 * (7.40 - calcPH));
        const pRatio = Math.max(0.1, calcPaO2 / p50_eff);
        let calcSaO2 = (Math.pow(pRatio, 2.7) / (1 + Math.pow(pRatio, 2.7))) * 100;
        calcSaO2 = Math.max(35, Math.min(100, Math.round(calcSaO2)));

        // End-Tidal CO2: EtCO2 = PaCO2 * (1 - DeadspaceFraction)
        let calcEtCO2 = Math.round(calcPaCO2 * (1 - p.deadspace));
        calcEtCO2 = Math.max(10, Math.min(85, calcEtCO2));

        const pfRatio = Math.round(calcPaO2 / p.fiO2);
        const aaGradient = Math.max(0, Math.round(paO2_alveolar - calcPaO2));

        // Update all monitored clinical variables
        setMonitoredValues({
          Ppeak: s.pPeakCycle,
          Pplat: s.pPlatStatic,
          Pmean: s.pawSum / Math.max(1, s.pawCount),
          PEEPtotal: p.peep + autoPEEP,
          AutoPEEP: autoPEEP,
          DrivingPressure: drivingP,
          TotalRR: instantRR,
          MV: (instantRR * vtExpired_mL) / 1000,
          VtExp: vtExpired_mL,
          VPeakAbs: s.volPeakCycle,
          VPeakRel: vtExpired_mL,
          Cstat: calculatedCstat,
          Cdyn: calculatedCdyn,
          Raw: calculatedRaw,
          MechanicalPower: mechanicalPower,
          StressIndex: stressIndex,
          TranspulmonaryP: transpulmonaryP,
          Ppl: ppl,
          SpO2: calcSaO2,
          EtCO2: calcEtCO2,
          PaO2: Math.round(calcPaO2),
          PaCO2: Math.round(calcPaCO2),
          pH: calcPH,
          HCO3: hco3,
          PF_Ratio: pfRatio,
          AaGradient: aaGradient,
          FlowLimitationDetected: s.flowLimitationCounter > 6,
          AsynchronyEvent: isPatientTriggered ? 'Patient Assist' : (isApneaTrigger ? 'Apnea Backup' : null)
        });

        // Loop management for P/V and F/V loops
        if (history.current.currentLoopPV.length > 15) {
          history.current.lastLoopPV = [...history.current.currentLoopPV];
          history.current.lastLoopFV = [...history.current.currentLoopFV];
        }
        history.current.currentLoopPV = [];
        history.current.currentLoopFV = [];

        // Reset per-breath accumulators
        s.phase = 'INS';
        s.cycleTime = 0;
        s.currentPeakFlow = 0;
        s.timeSinceLastBreath = 0;
        s.isBackupCycle = isApneaTrigger;
        s.pawSum = 0;
        s.pawCount = 0;
        s.pPeakCycle = p.peep;
        s.volPeakCycle = vEndExp_mL;
        s.inspPressurePoints = [];
        s.flowLimitationCounter = 0;

        if (backupActive !== s.isBackupCycle) {
          setBackupActive(s.isBackupCycle);
        }
      }

      // -----------------------------------------------------------------------
      // H. Mode Target Delivery & Valve Regulation
      // -----------------------------------------------------------------------
      let targetFlow = 0;
      let targetPaw = p.peep;
      let deliveryMode = 'PC'; // 'PC' (Pressure Control) or 'VC' (Volume Control)
      const vRelCurrent_mL = Math.max(0, ((s.volL + s.volR) * 1000) - ((p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000)));

      if (isRecruiting) {
        s.recruitmentTimer += SUB_DT;
        deliveryMode = 'PC';
        if (s.recruitmentTimer < 10) targetPaw = 30;
        else if (s.recruitmentTimer < 25) targetPaw = 40;
        else targetPaw = p.peep;
        s.phase = 'REC';
      } else if (s.phase === 'HOLD_INS') {
        // True Zero-Flow Plateau state
        deliveryMode = 'PC';
        targetFlow = 0;
        targetPaw = s.pAlvMean; // Airway pressure stabilizes at alveolar plateau
        s.pPlatStatic = s.paw;

        if (!inspHoldRequest && s.cycleTime >= (d.inspDuration + (p.pauseTime || 0))) {
          s.phase = 'EXP';
          setHoldStatus(null);
        }
      } else if (s.phase === 'HOLD_EXP') {
        deliveryMode = 'PC';
        targetFlow = 0;
        targetPaw = p.peep;
        if (!expHoldRequest) {
          triggerBreath = true;
          setHoldStatus(null);
        }
      } else if (s.phase === 'INS') {
        const effectiveMode = (p.mode === 'PSV' && s.isBackupCycle) ? 'PCV' : p.mode;
        let endInsp = false;

        if (effectiveMode === 'VCV') {
          deliveryMode = 'VC';
          // Check volume limit or inspiratory time
          if (vRelCurrent_mL >= p.tidalVolume || s.cycleTime >= d.inspDuration) {
            endInsp = true;
          } else {
            if (p.flowPattern === 'SQUARE') {
              targetFlow = d.requiredFlowLps;
            } else {
              // Decelerating Ramp: from peak flow down to 0
              targetFlow = Math.max(0, d.requiredFlowLps * (1 - (s.cycleTime / d.inspDuration)));
            }
          }
        } else if (effectiveMode === 'PCV') {
          deliveryMode = 'PC';
          if (s.cycleTime < d.inspDuration) {
            targetPaw = p.inspiratoryPressure + p.peep;
          } else {
            endInsp = true;
          }
        } else if (effectiveMode === 'PSV') {
          deliveryMode = 'PC';
          targetPaw = p.pressureSupport + p.peep;

          const currentInspFlowLpm = s.flowTotal * 60;
          if (s.cycleTime > 0.08) {
            s.currentPeakFlow = Math.max(s.currentPeakFlow, currentInspFlowLpm);
            const cycleThreshold = s.currentPeakFlow * (p.eSense / 100);
            // Cycle-off when flow drops below E-Sense threshold or exceeds maximum Ti (3.0s)
            if ((currentInspFlowLpm < cycleThreshold && s.currentPeakFlow > 8) || s.cycleTime > 3.0 || currentInspFlowLpm < -5) {
              endInsp = true;
            }
          }
        }

        if (endInsp) {
          if (inspHoldRequest) {
            s.phase = 'HOLD_INS';
            setHoldStatus('INSP_HOLD');
          } else if (p.mode === 'VCV' && p.pauseTime && p.pauseTime > 0.02) {
            s.phase = 'HOLD_INS';
          } else {
            s.phase = 'EXP';
          }
        }
      } else {
        // Expiratory Phase
        s.phase = 'EXP';
        deliveryMode = 'PC';
        targetPaw = p.peep;
      }

      // -----------------------------------------------------------------------
      // I. Real-time Fluidic Valve & Airway Dynamics (Solvent ODE Solver)
      // -----------------------------------------------------------------------
      const valveRiseRate = Math.max(0.04, p.riseTime || 0.12);
      const smoothingFactor = Math.min(1.0, SUB_DT / valveRiseRate);

      let currentPaw = 0;
      if (deliveryMode === 'PC') {
        // Proportional valve pressure regulation
        s.valvePressure = lerp(s.valvePressure, targetPaw, smoothingFactor);
        currentPaw = s.valvePressure;
        s.flowL = (currentPaw - pAlvL) / RL;
        s.flowR = (currentPaw - pAlvR) / RR;
      } else {
        // High-precision flow control delivery
        s.valveFlow = lerp(s.valveFlow, targetFlow, smoothingFactor * 1.5);
        const gL = 1 / RL;
        const gR = 1 / RR;
        // Solve for Paw where TotalFlow = FlowL + FlowR + FlowCircuit
        currentPaw = (s.valveFlow + (pAlvL * gL) + (pAlvR * gR)) / (gL + gR);
        s.flowL = (currentPaw - pAlvL) / RL;
        s.flowR = (currentPaw - pAlvR) / RR;
      }

      // Circuit Compliance tubing volume effect
      const circuitCompL = (p.circuitCompliance || 2.0) / 1000;
      const prevCircuitVol = s.volCircuit;
      const newCircuitVol = currentPaw * circuitCompL;
      s.volCircuit = newCircuitVol;
      const circuitFlow = (newCircuitVol - prevCircuitVol) / SUB_DT;

      s.paw = currentPaw;
      s.flowTotal = s.flowL + s.flowR + circuitFlow;

      // Update alveolar compartment volumes with pendelluft cross-flow
      s.volL += (s.flowL - pendelluftFlow) * SUB_DT;
      s.volR += (s.flowR + pendelluftFlow) * SUB_DT;

      if (s.volL < 0.05) s.volL = 0.05;
      if (s.volR < 0.05) s.volR = 0.05;

      const vAbsoluteTotal_mL = (s.volL + s.volR) * 1000;
      s.volPeakCycle = Math.max(s.volPeakCycle, vAbsoluteTotal_mL);
      s.pPeakCycle = Math.max(s.pPeakCycle, currentPaw);

      s.pawSum += currentPaw;
      s.pawCount += 1;

      // Record pressure trajectory during inspiration for Stress Index
      if (s.phase === 'INS') {
        if (s.cycleTime > 0.08 && s.inspPressurePoints.length < 30) {
          s.inspPressurePoints.push(currentPaw);
        }
        s.pPlatStatic = (pAlvL + pAlvR) / 2;
      }

      // Dynamic Flow Limitation detection (Paw rises while expiratory flow plateaus)
      if (s.phase === 'EXP' && s.flowTotal < -0.15) {
        if (currentPaw > (p.peep + 1.2) && s.flowTotal > -0.40) {
          s.flowLimitationCounter++;
        } else {
          s.flowLimitationCounter = Math.max(0, s.flowLimitationCounter - 1);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Push Data to History Buffer for 60fps Canvas Display
    // -------------------------------------------------------------------------
    const vRelCurrent_mL = Math.max(0, ((s.volL + s.volR) * 1000) - ((p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000)));
    history.current.paw.push(s.paw);
    history.current.flow.push(s.flowTotal * 60);
    history.current.flowL.push(s.flowL * 60);
    history.current.flowR.push(s.flowR * 60);
    history.current.vol.push(vRelCurrent_mL);
    history.current.ppl.push(s.pPl);

    history.current.currentLoopPV.push({ p: s.paw, v: vRelCurrent_mL });
    history.current.currentLoopFV.push({ f: s.flowTotal * 60, v: vRelCurrent_mL });

    if (history.current.paw.length > MAX_HISTORY) {
      history.current.paw.shift();
      history.current.flow.shift();
      history.current.flowL.shift();
      history.current.flowR.shift();
      history.current.vol.shift();
      history.current.ppl.shift();
    }
  }, [isRunning, isRecruiting, params, derivedParams, backupActive, inspHoldRequest, expHoldRequest, monitoredValues.TotalRR]);

  // =========================================================================
  // 7. AUTO-SCALE LOGIC FOR HIGH-DEF CANVAS PLOTS
  // =========================================================================
  const updateAutoScales = useCallback(() => {
    const recentPaw = history.current.paw.slice(-PEAK_WINDOW);
    const recentFlow = history.current.flow.slice(-PEAK_WINDOW);
    const recentVol = history.current.vol.slice(-PEAK_WINDOW);

    const maxP = Math.max(25, ...recentPaw);
    const maxF = Math.max(20, ...recentFlow.map(Math.abs));
    const maxV = Math.max(250, ...recentVol);

    scalesRef.current.pMax = lerp(scalesRef.current.pMax, maxP * 1.25, 0.05);
    scalesRef.current.fMax = lerp(scalesRef.current.fMax, maxF * 1.25, 0.05);
    scalesRef.current.vMax = lerp(scalesRef.current.vMax, maxV * 1.20, 0.05);

    const diffP = Math.abs(scalesRef.current.pMax - displayedScalesRef.current.pMax);
    const diffF = Math.abs(scalesRef.current.fMax - displayedScalesRef.current.fMax);
    const diffV = Math.abs(scalesRef.current.vMax - displayedScalesRef.current.vMax);

    if (diffP > 1.5 || diffF > 3 || diffV > 15) {
      const newScales = {
        pMax: scalesRef.current.pMax,
        fMax: scalesRef.current.fMax,
        vMax: scalesRef.current.vMax
      };
      setScales(newScales);
      displayedScalesRef.current = newScales;
    }
  }, []);

  // =========================================================================
  // 8. GRAPHICAL RENDERING (WAVEFORMS & LOOPS)
  // =========================================================================
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

    // Draw continuous data line
    const drawLine = (ctx, data, color, yMax, yMin = 0, midZero = false, lineWidth = 2) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';

      let scale, offset;
      if (midZero) {
        const range = yMax + Math.abs(yMin);
        scale = h / range;
        offset = Math.abs(yMin) * scale;
      } else {
        scale = (h - 12) / yMax;
        offset = 10;
      }

      data.forEach((val, i) => {
        const x = 36 + ((i / MAX_HISTORY) * (w - 36));
        const y = h - ((val * scale) + offset);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    // Draw clinical gridlines & labels
    const drawAxisAndGrid = (ctx, yMaxPos, yMaxNeg = 0, yLabel, yColor, midZero = false) => {
      ctx.strokeStyle = '#2d3748';
      ctx.fillStyle = '#a0aec0';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';

      if (midZero) {
        const totalRange = yMaxPos + yMaxNeg;
        const scale = h / totalRange;
        const zeroY = h - (yMaxNeg * scale);

        ctx.beginPath();
        ctx.strokeStyle = '#4a5568';
        ctx.moveTo(36, zeroY);
        ctx.lineTo(w, zeroY);
        ctx.stroke();

        const steps = 4;
        for (let i = 0; i <= steps; i++) {
          const val = yMaxPos - (i * yMaxPos / steps);
          const y = zeroY - (val * scale);
          if (y >= 0 && y <= h) {
            ctx.beginPath();
            ctx.strokeStyle = '#1a202c';
            ctx.moveTo(36, y);
            ctx.lineTo(w, y);
            ctx.stroke();
            ctx.fillText(val.toFixed(0), 32, y + 3);
          }
        }
        for (let i = 1; i <= steps; i++) {
          const val = yMaxNeg * (i / steps);
          const y = zeroY + (val * scale);
          if (y <= h) {
            ctx.beginPath();
            ctx.strokeStyle = '#1a202c';
            ctx.moveTo(36, y);
            ctx.lineTo(w, y);
            ctx.stroke();
            ctx.fillText('-' + val.toFixed(0), 32, y + 3);
          }
        }
      } else {
        const steps = 4;
        for (let i = 0; i <= steps; i++) {
          const val = ((steps - i) * (yMaxPos / steps)).toFixed(0);
          const yPos = (i / steps) * (h - 12) + 6;
          ctx.beginPath();
          ctx.strokeStyle = '#1a202c';
          ctx.moveTo(36, yPos);
          ctx.lineTo(w, yPos);
          ctx.stroke();
          ctx.fillText(val, 32, yPos + 3);
        }
      }

      ctx.beginPath();
      ctx.strokeStyle = '#4a5568';
      ctx.lineWidth = 1;
      ctx.moveTo(36, 0);
      ctx.lineTo(36, h);
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.fillStyle = yColor;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(yLabel, 42, 14);
    };

    // 1. Airway Pressure Waveform (Paw) + Pleural Pressure (Ppl)
    drawAxisAndGrid(ctxP, sP, 0, 'Paw (cmH2O)', '#f59e0b', false);
    // Pleural pressure overlay in subtle violet
    ctxP.globalAlpha = 0.5;
    drawLine(ctxP, history.current.ppl, '#a855f7', sP, 0, false, 1.5);
    ctxP.globalAlpha = 1.0;
    drawLine(ctxP, history.current.paw, '#f59e0b', sP, 0, false, 2);

    // 2. Flow Waveform (Total, Left, Right)
    drawAxisAndGrid(ctxF, sF, sF, 'Flow (L/min)', '#10b981', true);
    ctxF.globalAlpha = 0.65;
    drawLine(ctxF, history.current.flowR, '#ef4444', sF, -sF, true, 1.5);
    drawLine(ctxF, history.current.flowL, '#3b82f6', sF, -sF, true, 1.5);
    ctxF.globalAlpha = 1.0;
    drawLine(ctxF, history.current.flow, '#10b981', sF, -sF, true, 2);

    // 3. Volume Waveform
    drawAxisAndGrid(ctxV, sV, 0, 'Volume (ml)', '#38bdf8', false);
    drawLine(ctxV, history.current.vol, '#38bdf8', sV, 0, false, 2);
  }, [updateAutoScales]);

  // Draw P/V and F/V Loops
  const drawLoops = useCallback(() => {
    const ctxPV = canvasRefPV.current?.getContext('2d');
    const ctxFV = canvasRefFV.current?.getContext('2d');
    if (!ctxPV || !ctxFV) return;

    const w = ctxPV.canvas.width;
    const h = ctxPV.canvas.height;
    const padL = 38, padR = 12, padB = 30, padT = 18;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    const pMax = scalesRef.current.pMax;
    const vMax = scalesRef.current.vMax;
    const fMax = scalesRef.current.fMax;

    const drawLoopGrid = (ctx, xMax, yMax, xLabel, yLabel, midZeroY = false) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#374151';
      ctx.fillStyle = '#9ca3af';
      ctx.font = '9px sans-serif';
      ctx.lineWidth = 1;

      // X Axis
      ctx.beginPath();
      ctx.moveTo(padL, h - padB);
      ctx.lineTo(w - padR, h - padB);
      ctx.stroke();

      // Y Axis
      ctx.beginPath();
      ctx.moveTo(padL, padT);
      ctx.lineTo(padL, h - padB);
      ctx.stroke();

      // X Ticks
      ctx.textAlign = 'center';
      for (let i = 0; i <= 4; i++) {
        const xVal = (xMax / 4) * i;
        const xPos = padL + (innerW / 4) * i;
        ctx.beginPath();
        ctx.moveTo(xPos, h - padB);
        ctx.lineTo(xPos, h - padB + 4);
        ctx.stroke();
        ctx.fillText(xVal.toFixed(0), xPos, h - padB + 13);
      }
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(xLabel, padL + innerW / 2, h - 4);

      // Y Ticks
      ctx.textAlign = 'right';
      ctx.font = '9px sans-serif';
      ctx.fillStyle = '#9ca3af';
      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        let val, y;
        if (midZeroY) {
          val = yMax - (i * (yMax * 2) / steps);
          y = padT + (i * innerH / steps);
        } else {
          val = yMax - (i * yMax / steps);
          y = padT + (i * innerH / steps);
        }
        ctx.beginPath();
        ctx.moveTo(padL - 3, y);
        ctx.lineTo(padL, y);
        ctx.stroke();
        ctx.fillText(val.toFixed(0), padL - 5, y + 3);
      }

      ctx.textAlign = 'left';
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(yLabel, 6, 12);

      if (midZeroY) {
        const midY = padT + innerH / 2;
        ctx.strokeStyle = '#4a5568';
        ctx.beginPath();
        ctx.moveTo(padL, midY);
        ctx.lineTo(w - padR, midY);
        ctx.stroke();
      }
    };

    const drawLoopLine = (ctx, data, color, xKey, yKey, xMax, yMax, midZeroY = false) => {
      if (data.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';

      data.forEach((pt, i) => {
        const x = padL + (pt[xKey] / xMax) * innerW;
        let y;
        if (midZeroY) {
          const midH = padT + innerH / 2;
          y = midH - (pt[yKey] / yMax) * (innerH / 2);
        } else {
          y = (h - padB) - (pt[yKey] / yMax) * innerH;
        }
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    // Draw P/V Loop
    drawLoopGrid(ctxPV, pMax, vMax, 'Pressure (cmH2O)', 'Volume (ml)', false);
    ctxPV.globalAlpha = 0.30;
    drawLoopLine(ctxPV, history.current.lastLoopPV, '#f59e0b', 'p', 'v', pMax, vMax, false);
    ctxPV.globalAlpha = 1.0;
    drawLoopLine(ctxPV, history.current.currentLoopPV, '#f59e0b', 'p', 'v', pMax, vMax, false);

    // Draw F/V Loop
    drawLoopGrid(ctxFV, vMax, fMax, 'Volume (ml)', 'Flow (L/min)', true);
    ctxFV.globalAlpha = 0.30;
    drawLoopLine(ctxFV, history.current.lastLoopFV, '#10b981', 'v', 'f', vMax, fMax, true);
    ctxFV.globalAlpha = 1.0;
    drawLoopLine(ctxFV, history.current.currentLoopFV, '#10b981', 'v', 'f', vMax, fMax, true);
  }, []);

  // Main Animation Request Frame loop
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

  // Mode change handler
  const handleModeChange = (e) => {
    const newMode = e.target.value;
    setParams(p => ({
      ...p,
      mode: newMode,
      inspiratoryTime: newMode === 'PSV' ? 0.35 : 1.0,
      spontaneousRR: (newMode === 'PSV' && p.spontaneousRR === 0) ? 14 : p.spontaneousRR
    }));
    resetSimState();
  };

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* ================================================================= */}
        {/* HEADER & GLOBAL RUN CONTROLS (LIGHT THEME) */}
        {/* ================================================================= */}
        <header className="flex flex-wrap justify-between items-center bg-white border border-gray-300 rounded-2xl p-4 md:p-6 shadow-sm">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-blue-50 text-blue-600 border border-blue-200 rounded-xl">
              <Activity className="h-7 w-7" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-xl md:text-2xl font-bold tracking-tight text-gray-900">
                  VentSim <span className="text-blue-600">Pro</span>
                </h1>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                  500 Hz High-Fidelity Physics
                </span>
              </div>
              <p className="text-xs text-gray-500">Advanced Dual-Lung Biomechanics, Rohrer Fluid Dynamics & Real-Time ABG</p>
            </div>
          </div>

          <div className="flex items-center space-x-3 mt-3 md:mt-0">
            {holdStatus && (
              <div className="px-3 py-1.5 rounded-lg bg-yellow-100 border border-yellow-400 text-yellow-800 text-xs font-bold animate-pulse flex items-center space-x-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>{holdStatus === 'INSP_HOLD' ? 'INSPIRATORY HOLD ACTIVE' : 'EXPIRATORY HOLD ACTIVE'}</span>
              </div>
            )}

            {backupActive && (
              <div className="px-3 py-1.5 rounded-lg bg-red-100 border border-red-400 text-red-800 text-xs font-bold animate-pulse flex items-center space-x-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>APNEA BACKUP ACTIVE</span>
              </div>
            )}

            <button
              onClick={() => setIsRunning(!isRunning)}
              className={`flex items-center px-6 py-2.5 rounded-full font-semibold text-sm transition shadow-sm ${
                isRunning
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {isRunning ? <><Pause className="w-4 h-4 mr-2" /> STOP</> : <><Play className="w-4 h-4 mr-2" /> START</>}
            </button>
          </div>
        </header>

        {/* ================================================================= */}
        {/* MAIN BODY GRID: 8 COLUMNS (MONITOR) vs 4 COLUMNS (CONTROLS) */}
        {/* ================================================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* LEFT 8 COLUMNS: Waveforms, Clinical Metrics & Loops */}
          <div className="lg:col-span-8 space-y-6">

            {/* TAB SELECTOR */}
            <div className="flex space-x-2 border-b border-gray-300 pb-2">
              <button
                onClick={() => setActiveTab('waveforms')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-2 ${
                  activeTab === 'waveforms'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Real-time Waveforms & Loops</span>
              </button>
              <button
                onClick={() => setActiveTab('abg')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-2 ${
                  activeTab === 'abg'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
                }`}
              >
                <Droplets className="w-3.5 h-3.5" />
                <span>Arterial Blood Gas (ABG)</span>
              </button>
              <button
                onClick={() => setActiveTab('mechanics')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center space-x-2 ${
                  activeTab === 'mechanics'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
                }`}
              >
                <Stethoscope className="w-3.5 h-3.5" />
                <span>Lung Protection & Power</span>
              </button>
            </div>

            {/* TAB 1: REAL-TIME WAVEFORMS */}
            {activeTab === 'waveforms' && (
              <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300 space-y-4">
                <div className="flex justify-between items-center border-b border-gray-200 pb-3">
                  <h3 className="text-gray-700 text-sm font-bold flex items-center">
                    <Activity className="w-4 h-4 mr-2 text-blue-600" />
                    Continuous Waveform Telemetry
                  </h3>
                  <div className="flex items-center space-x-3 text-xs">
                    <span className="flex items-center text-amber-600 font-mono font-bold">
                      Ppeak: {monitoredValues.Ppeak.toFixed(1)} cmH2O
                    </span>
                    <span className="flex items-center text-emerald-600 font-mono font-bold">
                      Flow: ±{scales.fMax.toFixed(0)} L/m
                    </span>
                    <span className="flex items-center text-blue-600 font-mono font-bold">
                      VTe: {monitoredValues.VtExp.toFixed(0)} ml
                    </span>
                  </div>
                </div>

                <div className="space-y-3">
                  {/* Pressure Waveform (Paw) */}
                  <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <div className="absolute top-2 right-3 text-xs font-mono font-bold text-yellow-400 z-10">
                      PEAK: {monitoredValues.Ppeak.toFixed(1)} | PLAT: {monitoredValues.Pplat.toFixed(1)} cmH2O
                    </div>
                    <div className="absolute top-6 left-12 text-[10px] text-purple-300 font-semibold z-10">
                      ■ Ppl: {monitoredValues.Ppl.toFixed(1)} cmH2O
                    </div>
                    <canvas ref={canvasRefP} width={800} height={128} className="w-full h-full" />
                  </div>

                  {/* Flow Waveform */}
                  <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <div className="absolute top-2 right-3 text-xs font-mono font-bold text-emerald-400 z-10">
                      SCALE: ±{scales.fMax.toFixed(0)} L/min
                    </div>
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[10px] flex space-x-3 z-10 text-white">
                      <span className="text-blue-400 font-semibold">■ Left ({params.compL}ml/cmH2O)</span>
                      <span className="text-red-400 font-semibold">■ Right ({params.compR}ml/cmH2O)</span>
                      <span className="text-emerald-400 font-semibold">■ Total Airway Flow</span>
                    </div>
                    <canvas ref={canvasRefF} width={800} height={128} className="w-full h-full" />
                  </div>

                  {/* Volume Waveform */}
                  <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <div className="absolute top-2 right-3 text-xs font-mono font-bold text-blue-400 z-10 text-right">
                      <span>VTe: {monitoredValues.VtExp.toFixed(0)} ml | Peak: {monitoredValues.VPeakAbs.toFixed(0)} ml</span>
                    </div>
                    <canvas ref={canvasRefV} width={800} height={128} className="w-full h-full" />
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: ARTERIAL BLOOD GAS (ABG) */}
            {activeTab === 'abg' && (
              <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-5">
                <div className="flex justify-between items-center border-b border-gray-200 pb-3">
                  <div className="flex items-center space-x-2">
                    <Droplets className="w-5 h-5 text-red-500" />
                    <h3 className="text-gray-900 font-bold text-base">Arterial Blood Gas (ABG) Simulator</h3>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-bold border ${
                    monitoredValues.pH < 7.35 
                      ? 'bg-red-100 text-red-700 border-red-300' 
                      : (monitoredValues.pH > 7.45 
                          ? 'bg-amber-100 text-amber-700 border-amber-300' 
                          : 'bg-emerald-100 text-emerald-700 border-emerald-300')
                  }`}>
                    {monitoredValues.pH < 7.35 ? 'Acidemia' : (monitoredValues.pH > 7.45 ? 'Alkalemia' : 'Normal pH')}
                  </span>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">pH (Arterial)</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.pH < 7.35 ? 'text-red-600' : (monitoredValues.pH > 7.45 ? 'text-amber-600' : 'text-emerald-600')
                    }`}>
                      {monitoredValues.pH.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Ref: 7.35 - 7.45</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">PaCO2</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.PaCO2 > 45 ? 'text-red-600' : 'text-blue-600'
                    }`}>
                      {monitoredValues.PaCO2} <span className="text-xs font-normal">mmHg</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Ref: 35 - 45 mmHg</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">PaO2</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.PaO2 < 60 ? 'text-red-600' : 'text-emerald-600'
                    }`}>
                      {monitoredValues.PaO2} <span className="text-xs font-normal">mmHg</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Ref: 80 - 100 mmHg</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">SaO2 (Calculated)</span>
                    <span className="text-2xl font-black font-mono text-emerald-600">
                      {monitoredValues.SpO2} <span className="text-xs font-normal">%</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Adair-Hill with Bohr effect</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">P/F Ratio</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.PF_Ratio < 100 
                        ? 'text-red-600 animate-pulse' 
                        : (monitoredValues.PF_Ratio < 200 ? 'text-amber-600' : 'text-blue-600')
                    }`}>
                      {monitoredValues.PF_Ratio}
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">
                      {monitoredValues.PF_Ratio < 100 ? 'Severe ARDS' : (monitoredValues.PF_Ratio < 200 ? 'Moderate ARDS' : (monitoredValues.PF_Ratio < 300 ? 'Mild ARDS' : 'Normal'))}
                    </span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">A-a Gradient</span>
                    <span className="text-2xl font-black font-mono text-purple-600">
                      {monitoredValues.AaGradient} <span className="text-xs font-normal">mmHg</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Alveolar-arterial O2 difference</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">EtCO2</span>
                    <span className="text-2xl font-black font-mono text-amber-600">
                      {monitoredValues.EtCO2} <span className="text-xs font-normal">mmHg</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">End-tidal capnography</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">HCO3-</span>
                    <span className="text-2xl font-black font-mono text-gray-800">
                      {monitoredValues.HCO3} <span className="text-xs font-normal">mEq/L</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Serum Bicarbonate</span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: LUNG PROTECTION & MECHANICAL POWER */}
            {activeTab === 'mechanics' && (
              <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-5">
                <div className="flex justify-between items-center border-b border-gray-200 pb-3">
                  <div className="flex items-center space-x-2">
                    <Stethoscope className="w-5 h-5 text-emerald-600" />
                    <h3 className="text-gray-900 font-bold text-base">Lung Protective Ventilation & VILI Risk</h3>
                  </div>
                  <span className="text-xs text-gray-500">Amato & Gattinoni Predictors</span>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">Driving Pressure (ΔP)</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.DrivingPressure >= 15 ? 'text-red-600 animate-pulse' : 'text-emerald-600'
                    }`}>
                      {monitoredValues.DrivingPressure.toFixed(1)} <span className="text-xs">cmH2O</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Safe &lt; 14 cmH2O (Amato 2015)</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">Mechanical Power</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.MechanicalPower >= 17 ? 'text-red-600' : 'text-blue-600'
                    }`}>
                      {monitoredValues.MechanicalPower.toFixed(1)} <span className="text-xs">J/min</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Threshold: &gt; 17 J/min causes VILI</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">Stress Index</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.StressIndex > 1.08 
                        ? 'text-amber-600' 
                        : (monitoredValues.StressIndex < 0.92 ? 'text-blue-600' : 'text-emerald-600')
                    }`}>
                      {monitoredValues.StressIndex.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">
                      {monitoredValues.StressIndex > 1.08 ? 'Overdistension' : (monitoredValues.StressIndex < 0.92 ? 'Tidal Recruitment' : 'Optimal Curve')}
                    </span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">Transpulmonary (PL)</span>
                    <span className="text-2xl font-black font-mono text-purple-600">
                      {monitoredValues.TranspulmonaryP.toFixed(1)} <span className="text-xs">cmH2O</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Pplat - Ppl (safe &lt; 20 cmH2O)</span>
                  </div>
                </div>

                {/* Pendelluft & Asymmetric Airway Indicator */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 flex flex-col md:flex-row justify-between items-center space-y-2 md:space-y-0">
                  <div>
                    <span className="text-xs font-bold text-gray-800 block">Two-Compartment Time Constants (Tau)</span>
                    <p className="text-[11px] text-gray-600">
                      Left Lung τ = {derivedParams.tauL}s &nbsp;|&nbsp; Right Lung τ = {derivedParams.tauR}s &nbsp;|&nbsp; System τ = {derivedParams.tauSystem}s
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-gray-500">Complete Exhalation (3-5τ): </span>
                    <span className="text-xs font-bold text-emerald-600">
                      {(Number(derivedParams.tauSystem) * 3.5).toFixed(2)}s (Current Te: {derivedParams.expDuration.toFixed(2)}s)
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* MONITOR CARDS & REAL-TIME LOOPS */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

              {/* Monitored Parameters List */}
              <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300 space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-600 flex items-center mb-2">
                  <BarChart2 className="w-3.5 h-3.5 mr-1.5 text-blue-600" />
                  Primary Readouts
                </h4>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between border-b border-gray-100 pb-1">
                    <span className="text-gray-600">P-Plateau</span>
                    <span className="font-mono font-bold text-red-600">{monitoredValues.Pplat.toFixed(1)} cmH2O</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-100 pb-1">
                    <span className="text-gray-600">Paw Mean</span>
                    <span className="font-mono font-bold text-amber-600">{monitoredValues.Pmean.toFixed(1)} cmH2O</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-100 pb-1">
                    <span className="text-gray-600">PEEPi (Auto-PEEP)</span>
                    <span className={`font-mono font-bold ${monitoredValues.AutoPEEP > 1.5 ? 'text-red-600 animate-pulse' : 'text-gray-800'}`}>
                      {monitoredValues.AutoPEEP.toFixed(1)} cmH2O
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-gray-100 pb-1">
                    <span className="text-gray-600">Static Comp (Cstat)</span>
                    <span className="font-mono font-bold text-purple-600 text-right">{monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-100 pb-1">
                    <span className="text-gray-600">Airway Res (Raw)</span>
                    <span className="font-mono font-bold text-blue-600 text-right">{monitoredValues.Raw.toFixed(1)} cmH2O/(L/s)</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-100 pb-1">
                    <span className="text-gray-600">Minute Volume (MV)</span>
                    <span className="font-mono font-bold text-emerald-600">{monitoredValues.MV.toFixed(2)} L/min</span>
                  </div>
                  <div className="flex justify-between pb-1">
                    <span className="text-gray-600">Total RR</span>
                    <span className="font-mono font-bold text-blue-600">{monitoredValues.TotalRR.toFixed(1)} /min</span>
                  </div>
                </div>

                {monitoredValues.FlowLimitationDetected && (
                  <div className="mt-2 bg-red-100 border border-red-400 text-red-700 px-2 py-1 rounded text-center text-[10px] font-bold animate-pulse">
                    ⚠️ EXPIRATORY FLOW LIMITATION DETECTED
                  </div>
                )}
              </div>

              {/* P/V Loop */}
              <div className="relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                <canvas ref={canvasRefPV} width={300} height={200} className="w-full h-auto bg-gray-800 rounded" />
                <div className="absolute bottom-1 left-2 right-2 rounded-b bg-gray-900/95 p-1 text-xs text-white">
                  <div className="flex justify-between items-center font-bold">
                    <span className="text-yellow-400">DRIVING P:</span>
                    <span className="text-lg leading-none text-red-400 font-mono">
                      {monitoredValues.DrivingPressure.toFixed(1)} <span className="text-xs">cmH2O</span>
                    </span>
                  </div>
                  <div className="flex justify-between pt-0.5 text-[10px] text-gray-300">
                    <span>Plat: {monitoredValues.Pplat.toFixed(1)}</span>
                    <span className="text-purple-300">Cstat: {monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span>
                  </div>
                </div>
              </div>

              {/* F/V Loop */}
              <div className="relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                <canvas ref={canvasRefFV} width={300} height={200} className="w-full h-auto bg-gray-800 rounded" />
                <div className="absolute bottom-1 left-2 right-2 rounded-b bg-gray-900/95 p-1 text-xs text-white">
                  <div className="flex justify-between items-center font-bold">
                    <span className="text-emerald-400">PEEPi:</span>
                    <span className="text-lg leading-none text-yellow-400 font-mono">
                      {monitoredValues.AutoPEEP.toFixed(1)} <span className="text-xs">cmH2O</span>
                    </span>
                  </div>
                  <div className="flex justify-between pt-0.5 text-[10px] text-gray-300">
                    <span className="text-sky-300">VTe: {monitoredValues.VtExp.toFixed(0)} ml</span>
                    <span className="text-emerald-300">Peak: {scales.fMax.toFixed(0)} L/m</span>
                  </div>
                </div>
              </div>

            </div>

            {/* DUAL-LUNG REAL-TIME EXPANSION VISUALIZER */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300">
              <div className="flex justify-between items-center mb-3">
                <h4 className="text-sm font-bold text-gray-800 flex items-center">
                  <Wind className="w-4 h-4 mr-2 text-blue-600" />
                  Bilateral Alveolar Aeration & Dynamic Inflation
                </h4>
                <div className="text-xs text-gray-600">
                  Pendelluft Cross-Flow: <span className="font-mono font-bold text-blue-600">{(simState.current.flowPendelluft * 60).toFixed(1)} L/min</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Left Lung Visualization */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 text-center">
                  <span className="text-xs font-bold text-blue-600 block mb-2">LEFT LUNG (CL: {params.compL} | RL: {params.resL})</span>
                  <div className="h-16 flex items-end justify-center">
                    <div 
                      className="w-24 bg-gradient-to-t from-blue-600 to-sky-400 rounded-2xl transition-all duration-75 shadow-md"
                      style={{ 
                        height: `${Math.min(100, Math.max(25, (simState.current.volL / (params.lungCapacity / 2)) * 85))}%`,
                        opacity: params.shunt > 0.25 ? 0.75 : 1.0
                      }}
                    />
                  </div>
                  <span className="text-xs font-mono font-semibold text-gray-700 block mt-2">
                    Vol: {(simState.current.volL * 1000).toFixed(0)} ml
                  </span>
                </div>

                {/* Right Lung Visualization */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 text-center">
                  <span className="text-xs font-bold text-red-600 block mb-2">RIGHT LUNG (CR: {params.compR} | RR: {params.resR})</span>
                  <div className="h-16 flex items-end justify-center">
                    <div 
                      className="w-24 bg-gradient-to-t from-red-600 to-rose-400 rounded-2xl transition-all duration-75 shadow-md"
                      style={{ 
                        height: `${Math.min(100, Math.max(25, (simState.current.volR / (params.lungCapacity / 2)) * 85))}%`,
                        opacity: params.shunt > 0.25 ? 0.75 : 1.0
                      }}
                    />
                  </div>
                  <span className="text-xs font-mono font-semibold text-gray-700 block mt-2">
                    Vol: {(simState.current.volR * 1000).toFixed(0)} ml
                  </span>
                </div>
              </div>
            </div>

          </div>

          {/* RIGHT 4 COLUMNS: Ventilator Controls, Patient Mechanics & Maneuvers */}
          <div className="lg:col-span-4 space-y-6">

            {/* 1. VENTILATOR SETTINGS */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-5">
              <div className="flex items-center text-blue-600 border-b border-gray-200 pb-3">
                <Settings className="w-5 h-5 mr-2" />
                <h3 className="font-bold text-gray-900 text-base">Ventilator Settings</h3>
              </div>

              {/* Mode Selection */}
              <div>
                <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-2">Mode</label>
                <div className="grid grid-cols-3 gap-2">
                  {['VCV', 'PCV', 'PSV'].map(mode => (
                    <button
                      key={mode}
                      onClick={() => handleModeChange({ target: { value: mode } })}
                      className={`py-2 rounded-xl text-xs font-bold transition border ${
                        params.mode === mode
                          ? 'bg-blue-600 text-white border-blue-600 shadow'
                          : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* VCV: Tidal Volume & Flow Pattern */}
              {params.mode === 'VCV' && (
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">Tidal Volume (Vt)</span>
                      <span className="font-mono font-bold text-blue-600">{params.tidalVolume} ml</span>
                    </div>
                    <input
                      type="range" min="200" max="800" step="10"
                      value={params.tidalVolume}
                      onChange={(e) => setParams(p => ({ ...p, tidalVolume: Number(e.target.value) }))}
                      className="w-full accent-blue-600"
                    />
                    <div className="flex justify-between text-[11px] text-gray-600 mt-1">
                      <span>Vt/PBW: {(params.tidalVolume / (Number(derivedParams.PBW) || 70)).toFixed(1)} ml/kg</span>
                      <span className={derivedParams.isVtSafe ? 'text-emerald-600 font-bold' : 'text-red-600 font-bold'}>
                        Safe: {derivedParams.safeVtRange}
                      </span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-700 block mb-1">Flow Pattern</label>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {['SQUARE', 'RAMP'].map(patt => (
                        <button
                          key={patt}
                          onClick={() => setParams(p => ({ ...p, flowPattern: patt }))}
                          className={`py-1.5 rounded-lg font-bold border transition ${
                            params.flowPattern === patt
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                          }`}
                        >
                          {patt === 'SQUARE' ? 'Square Wave' : 'Decel Ramp'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">Inspiratory Pause (Tpause)</span>
                      <span className="font-mono font-bold text-blue-600">{params.pauseTime} s</span>
                    </div>
                    <input
                      type="range" min="0" max="0.7" step="0.05"
                      value={params.pauseTime}
                      onChange={(e) => setParams(p => ({ ...p, pauseTime: Number(e.target.value) }))}
                      className="w-full accent-blue-600"
                    />
                    <p className="text-[10px] text-gray-500 mt-0.5">Enables continuous zero-flow Plateau pressure measurement</p>
                  </div>
                </div>
              )}

              {/* PCV: Inspiratory Pressure */}
              {params.mode === 'PCV' && (
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-700">Pinsp (above PEEP)</span>
                    <span className="font-mono font-bold text-red-600">{params.inspiratoryPressure} cmH2O</span>
                  </div>
                  <input
                    type="range" min="4" max="35" step="1"
                    value={params.inspiratoryPressure}
                    onChange={(e) => setParams(p => ({ ...p, inspiratoryPressure: Number(e.target.value) }))}
                    className="w-full accent-red-600"
                  />
                  <span className="text-[10px] text-gray-500">Total Insp Pressure = {params.inspiratoryPressure + params.peep} cmH2O</span>
                </div>
              )}

              {/* PSV: Pressure Support & E-Sense */}
              {params.mode === 'PSV' && (
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">Pressure Support (PS)</span>
                      <span className="font-mono font-bold text-red-600">{params.pressureSupport} cmH2O</span>
                    </div>
                    <input
                      type="range" min="4" max="30" step="1"
                      value={params.pressureSupport}
                      onChange={(e) => setParams(p => ({ ...p, pressureSupport: Number(e.target.value) }))}
                      className="w-full accent-red-600"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">Expiratory Cycle (E-Sense)</span>
                      <span className="font-mono font-bold text-blue-600">{params.eSense} %</span>
                    </div>
                    <input
                      type="range" min="5" max="50" step="5"
                      value={params.eSense}
                      onChange={(e) => setParams(p => ({ ...p, eSense: Number(e.target.value) }))}
                      className="w-full accent-blue-600"
                    />
                  </div>
                </div>
              )}

              {/* Respiratory Rate & Ti */}
              {params.mode !== 'PSV' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">RR</span>
                      <span className="font-mono font-bold text-blue-600">{params.respiratoryRate}/min</span>
                    </div>
                    <input
                      type="range" min="8" max="40" step="1"
                      value={params.respiratoryRate}
                      onChange={(e) => setParams(p => ({ ...p, respiratoryRate: Number(e.target.value) }))}
                      className="w-full accent-blue-600"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">Ti</span>
                      <span className="font-mono font-bold text-blue-600">{params.inspiratoryTime.toFixed(2)}s</span>
                    </div>
                    <input
                      type="range" min="0.3" max="2.5" step="0.05"
                      value={params.inspiratoryTime}
                      onChange={(e) => setParams(p => ({ ...p, inspiratoryTime: Number(e.target.value) }))}
                      className="w-full accent-blue-600"
                    />
                  </div>
                </div>
              )}

              {/* PEEP & FiO2 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-700">PEEP</span>
                    <span className="font-mono font-bold text-amber-600">{params.peep} cmH2O</span>
                  </div>
                  <input
                    type="range" min="0" max="24" step="1"
                    value={params.peep}
                    onChange={(e) => setParams(p => ({ ...p, peep: Number(e.target.value) }))}
                    className="w-full accent-amber-600"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-700">FiO2</span>
                    <span className="font-mono font-bold text-blue-600">{(params.fiO2 * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range" min="0.21" max="1.0" step="0.01"
                    value={params.fiO2}
                    onChange={(e) => setParams(p => ({ ...p, fiO2: Number(e.target.value) }))}
                    className="w-full accent-blue-600"
                  />
                </div>
              </div>

              {/* Advanced Airway & Tube Compensation (ATC) */}
              <div className="border-t border-gray-200 pt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="text-gray-600 block mb-1">ETT Size</label>
                    <select
                      value={params.ettSize}
                      onChange={(e) => setParams(p => ({ ...p, ettSize: e.target.value }))}
                      className="w-full bg-white border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-900"
                    >
                      {Object.entries(ETT_PROPERTIES).map(([k, v]) => (
                        <option key={k} value={k}>{v.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-gray-600 block mb-1">Rise Time (P-ramp)</label>
                    <input
                      type="range" min="0.05" max="0.4" step="0.02"
                      value={params.riseTime}
                      onChange={(e) => setParams(p => ({ ...p, riseTime: Number(e.target.value) }))}
                      className="w-full accent-blue-600 mt-2"
                    />
                  </div>
                </div>

                <div className="flex justify-between items-center bg-gray-50 p-2.5 rounded-xl border border-gray-200">
                  <span className="text-xs text-gray-700 font-semibold">Automatic Tube Comp (ATC)</span>
                  <button
                    onClick={() => setParams(p => ({ ...p, tubeCompEnabled: !p.tubeCompEnabled }))}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                      params.tubeCompEnabled ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {params.tubeCompEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>
            </div>

            {/* 2. PATIENT BIOMECHANICS & PATHOLOGY */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-4">
              <div className="flex items-center text-purple-600 border-b border-gray-200 pb-3">
                <HeartPulse className="w-5 h-5 mr-2" />
                <h3 className="font-bold text-gray-900 text-base">Patient Mechanics & Pathology</h3>
              </div>

              {/* Pathology Selector */}
              <div>
                <label className="text-xs text-gray-600 block mb-1 font-semibold">Pathology Preset</label>
                <select
                  value={params.pathology}
                  onChange={handlePathologyChange}
                  className="w-full bg-white border border-gray-300 rounded-xl px-3 py-2 text-xs text-gray-900"
                >
                  {Object.entries(PATHOLOGY_PRESETS).map(([k, v]) => (
                    <option key={k} value={k}>{v.name}</option>
                  ))}
                </select>
                <p className="text-[11px] text-gray-500 mt-1.5 italic">
                  {PATHOLOGY_PRESETS[params.pathology]?.note}
                </p>
              </div>

              {/* Spontaneous Effort (Pmus) & Asynchrony */}
              <div className="bg-purple-50 p-3.5 rounded-xl border border-purple-200 space-y-3">
                <div className="flex justify-between text-xs">
                  <span className="font-bold text-purple-800 flex items-center">
                    <HeartPulse className="w-3.5 h-3.5 mr-1" /> Spontaneous RR
                  </span>
                  <span className="font-mono font-bold text-purple-700">{params.spontaneousRR} bpm</span>
                </div>
                <input
                  type="range" min="0" max="40" step="1"
                  value={params.spontaneousRR}
                  onChange={(e) => setParams(p => ({ ...p, spontaneousRR: Number(e.target.value) }))}
                  className="w-full accent-purple-600"
                />

                {params.spontaneousRR > 0 && (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-purple-700 font-semibold">Inspiratory Effort (Pmus)</span>
                      <span className="font-mono text-purple-800 font-bold">{params.pmusEffort} cmH2O</span>
                    </div>
                    <input
                      type="range" min="2" max="20" step="1"
                      value={params.pmusEffort}
                      onChange={(e) => setParams(p => ({ ...p, pmusEffort: Number(e.target.value) }))}
                      className="w-full accent-purple-600"
                    />

                    <div>
                      <label className="text-xs text-purple-700 block mb-1 font-semibold">Patient-Ventilator Interaction</label>
                      <select
                        value={params.pmusSyncMode}
                        onChange={(e) => setParams(p => ({ ...p, pmusSyncMode: e.target.value }))}
                        className="w-full bg-white border border-purple-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-900"
                      >
                        <option value="AUTO_SYNC">Synchronized Breathing (Normal)</option>
                        <option value="FIGHTING">Bucking / Reverse Phase Fighting</option>
                        <option value="INEFFECTIVE">Ineffective Triggering (Weak effort & PEEPi)</option>
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* Detailed Dual-Lung Mechanics (Customizable) */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-gray-50 p-3 rounded-xl border border-gray-200">
                  <span className="font-bold text-blue-600 block mb-1">Left Lung</span>
                  <div className="space-y-1.5">
                    <div>
                      <span className="text-[10px] text-gray-500 block">Comp (ml/cmH2O)</span>
                      <input
                        type="number" min="5" max="150"
                        value={params.compL}
                        onChange={(e) => setParams(p => ({ ...p, compL: Number(e.target.value) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-500 block">Res (cmH2O/Lps)</span>
                      <input
                        type="number" min="2" max="60"
                        value={params.resL}
                        onChange={(e) => setParams(p => ({ ...p, resL: Number(e.target.value) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs"
                      />
                    </div>
                  </div>
                </div>

                <div className="bg-gray-50 p-3 rounded-xl border border-gray-200">
                  <span className="font-bold text-red-600 block mb-1">Right Lung</span>
                  <div className="space-y-1.5">
                    <div>
                      <span className="text-[10px] text-gray-500 block">Comp (ml/cmH2O)</span>
                      <input
                        type="number" min="5" max="150"
                        value={params.compR}
                        onChange={(e) => setParams(p => ({ ...p, compR: Number(e.target.value) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-500 block">Res (cmH2O/Lps)</span>
                      <input
                        type="number" min="2" max="60"
                        value={params.resR}
                        onChange={(e) => setParams(p => ({ ...p, resR: Number(e.target.value) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 3. DIAGNOSTIC MANEUVERS (INSP HOLD / EXP HOLD / RECRUITMENT) */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-4">
              <div className="flex items-center text-amber-600 border-b border-gray-200 pb-3">
                <TrendingUp className="w-5 h-5 mr-2" />
                <h3 className="font-bold text-gray-900 text-base">Diagnostic ICU Maneuvers</h3>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setInspHoldRequest(!inspHoldRequest)}
                  className={`py-3 px-3 rounded-xl font-bold text-xs transition border flex items-center justify-center space-x-1.5 ${
                    inspHoldRequest
                      ? 'bg-blue-600 text-white border-blue-600 animate-pulse'
                      : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                  }`}
                >
                  <PauseCircle className="w-4 h-4" />
                  <span>{inspHoldRequest ? 'HOLDING INSP...' : 'INSP HOLD'}</span>
                </button>

                <button
                  onClick={() => setExpHoldRequest(!expHoldRequest)}
                  className={`py-3 px-3 rounded-xl font-bold text-xs transition border flex items-center justify-center space-x-1.5 ${
                    expHoldRequest
                      ? 'bg-red-600 text-white border-red-600 animate-pulse'
                      : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                  }`}
                >
                  <StopCircle className="w-4 h-4" />
                  <span>{expHoldRequest ? 'HOLDING EXP...' : 'EXP HOLD'}</span>
                </button>
              </div>

              <button
                onClick={() => setIsRecruiting(!isRecruiting)}
                className={`w-full py-2.5 rounded-xl font-bold text-xs transition border ${
                  isRecruiting
                    ? 'bg-amber-100 text-amber-800 border-amber-400 animate-pulse'
                    : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                }`}
              >
                {isRecruiting ? 'LUNG RECRUITMENT ACTIVE (30/40 cmH2O)' : 'Start Alveolar Recruitment Maneuver'}
              </button>
            </div>

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
