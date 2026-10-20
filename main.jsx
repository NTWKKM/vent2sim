import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { 
  Play, Pause, Activity, Settings, HeartPulse, AlertCircle, TrendingUp, 
  BarChart2, User, Clock, PauseCircle, StopCircle, Zap, 
  ShieldAlert, Stethoscope, Wind, Droplets, RotateCcw, CheckCircle2
} from 'lucide-react';

// =========================================================================
// 1. ADVANCED RESPIRATORY BIOMECHANICS & FLUID CONSTANTS
// =========================================================================
const DT = 0.016;              // Base animation frame dt (~60 Hz)
const SUB_STEPS = 8;           // 8 sub-steps per frame -> 500 Hz high-fidelity ODE integration
const SUB_DT = DT / SUB_STEPS; // 0.002s per physics sub-step
const MAX_HISTORY = 1200;      // History points for waveforms (~20s)
const PEAK_WINDOW = 250;       // Window for auto-scale tracking

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
const getDynamicAirwayResistance = (baseR, flowLps, volL, pathology, capacityL) => {
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

  // Dynamic expiratory airway compression (Bernoulli effect + loss of radial traction in COPD/Emphysema/Asthma)
  let compressionFactor = 1.0;
  if ((pathology === 'COPD' || pathology === 'EMPHYSEMA' || pathology === 'ASTHMA') && flowLps < -0.02 && volL < capacityL * 0.45) {
    const collapseSeverity = Math.exp(-3.2 * Math.max(0, volL / (capacityL * 0.45)));
    compressionFactor = 1.0 + (collapseSeverity * 2.5);
  }

  return Math.max(baseR * 0.35, volDependentR * compressionFactor);
};

// =========================================================================
// 3. SIGMOID S-CURVE COMPLIANCE WITH PEEP RECRUITMENT & HYSTERESIS
// =========================================================================
const getDynamicAlveolarCompliance = (volL, baseC_ml, pathology, phase, capacityL, currentPEEP, recruitBonus = 0) => {
  const baseC_L = Math.max(0.005, baseC_ml / 1000);
  
  let lowerInflection_L = 0.12;
  let upperInflection_L = capacityL * 0.72;
  let distensionFactor = 12;
  let sigFactor = 1.8;
  let peepRecruitmentFactor = 1.0;

  switch (pathology) {
    case 'ARDS':
    case 'PULMONARY_EDEMA':
      lowerInflection_L = pathology === 'ARDS' ? 0.22 : 0.16;
      upperInflection_L = capacityL * (pathology === 'ARDS' ? 0.55 : 0.62);
      distensionFactor = pathology === 'ARDS' ? 28 : 22;
      sigFactor = 2.6;
      
      // ARDS / Edema PEEP Recruitment Zone (Gattinoni / Goligher response curve)
      if (currentPEEP < 6) {
        peepRecruitmentFactor = 0.65 + (currentPEEP * 0.05);
      } else if (currentPEEP <= 15) {
        peepRecruitmentFactor = 0.95 + ((currentPEEP - 6) * 0.055);
        peepRecruitmentFactor = Math.min(1.45, peepRecruitmentFactor);
      } else {
        peepRecruitmentFactor = 1.45 - ((currentPEEP - 15) * 0.075);
        peepRecruitmentFactor = Math.max(0.90, peepRecruitmentFactor);
      }
      peepRecruitmentFactor += recruitBonus * 0.18;
      break;

    case 'FIBROSIS':
      lowerInflection_L = 0.06;
      upperInflection_L = capacityL * 0.45;
      distensionFactor = 32;
      sigFactor = 3.2;
      break;

    case 'COPD':
    case 'EMPHYSEMA':
    case 'ASTHMA':
      lowerInflection_L = 0.02;
      upperInflection_L = capacityL * 0.82;
      distensionFactor = 10;
      sigFactor = 1.3;
      break;

    default: // NORMAL, OBESITY, UNILATERAL_C_DEC, CUSTOM
      lowerInflection_L = 0.08;
      upperInflection_L = capacityL * 0.82;
      distensionFactor = 10;
      sigFactor = 1.6;
  }

  // Base Sigmoidal Compliance
  const midpoint = (lowerInflection_L + upperInflection_L) / 2;
  const spread = Math.max(0.1, upperInflection_L - lowerInflection_L);
  const sigmoid = 1 / (1 + Math.exp(-sigFactor * (volL - midpoint) / spread));
  let effectiveC = baseC_L * (0.45 + 0.55 * sigmoid);

  // Tidal recruitment resistance near Lower Inflection Point (opening pressure hurdle)
  if ((phase === 'INS' || phase === 'HOLD_INS' || phase === 'REC') && volL < lowerInflection_L) {
    const recruitSig = 1 / (1 + Math.exp(-6 * (volL / lowerInflection_L)));
    effectiveC *= (0.40 + 0.60 * recruitSig);
  }

  // Overdistension stiffness curve above Upper Inflection Point
  if (volL > upperInflection_L) {
    const excess = volL - upperInflection_L;
    effectiveC *= Math.exp(-excess * distensionFactor);
  }

  // Surfactant Hysteresis effect: deflation curve exhibits higher compliance than inflation
  if (phase === 'EXP' || phase === 'HOLD_EXP') {
    effectiveC *= 1.15;
  }

  // Apply PEEP recruitment scaling
  if (pathology === 'ARDS' || pathology === 'PULMONARY_EDEMA') {
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
    resL: 10, compL: 50, resR: 10, compR: 50, compChest: 160,
    shunt: 0.05, deadspace: 0.18,
    frcOffset: 0.0, lungCapacity: 3.4,
    note: 'Standard adult respiratory mechanics with normal time constants (~0.5s).'
  },
  ARDS: {
    name: 'Severe ARDS (Baby Lung Model)',
    resL: 15, compL: 20, resR: 15, compR: 20, compChest: 120,
    shunt: 0.35, deadspace: 0.40,
    frcOffset: 0.0, lungCapacity: 2.2,
    note: 'Marked loss of aerated lung units. High driving pressure and PEEP recruitability.'
  },
  COPD: {
    name: 'COPD / Acute Bronchospasm',
    resL: 26, compL: 65, resR: 26, compR: 65, compChest: 130,
    shunt: 0.12, deadspace: 0.35,
    frcOffset: 1.0, lungCapacity: 3.6,
    note: 'Elevated expiratory resistance, prolonged expiratory time constant, high risk of Auto-PEEP.'
  },
  ASTHMA: {
    name: 'Status Asthmaticus (Severe Obstruction)',
    resL: 35, compL: 55, resR: 35, compR: 55, compChest: 140,
    shunt: 0.10, deadspace: 0.38,
    frcOffset: 1.4, lungCapacity: 3.4,
    note: 'Extreme bronchospasm with high peak airway pressures and severe dynamic hyperinflation.'
  },
  EMPHYSEMA: {
    name: 'Severe Emphysema (High Compliance / Trapping)',
    resL: 28, compL: 100, resR: 28, compR: 100, compChest: 140,
    shunt: 0.18, deadspace: 0.45,
    frcOffset: 1.6, lungCapacity: 3.8,
    note: 'Loss of parenchymal elastic recoil leads to early dynamic airway collapse during expiration.'
  },
  PULMONARY_EDEMA: {
    name: 'Cardiogenic Pulmonary Edema',
    resL: 18, compL: 26, resR: 18, compR: 26, compChest: 130,
    shunt: 0.28, deadspace: 0.28,
    frcOffset: 0.1, lungCapacity: 2.5,
    note: 'Alveolar fluid flooding reduces compliance and causes V/Q mismatch responsive to PEEP.'
  },
  FIBROSIS: {
    name: 'Idiopathic Pulmonary Fibrosis (Restrictive)',
    resL: 12, compL: 18, resR: 12, compR: 18, compChest: 130,
    shunt: 0.22, deadspace: 0.32,
    frcOffset: -0.2, lungCapacity: 2.0,
    note: 'Severe parenchymal stiffness with low upper inflection point; high risk of barotrauma.'
  },
  UNILATERAL_C_DEC: {
    name: 'Asymmetric Lung Injury (Right Lobar Consolidation)',
    resL: 10, compL: 50, resR: 24, compR: 18, compChest: 140,
    shunt: 0.22, deadspace: 0.25,
    frcOffset: 0.0, lungCapacity: 2.8,
    note: 'Right lung stiff & obstructed. Produces inter-compartmental Pendelluft gas transfer.'
  },
  OBESITY: {
    name: 'Morbid Obesity / Chest Wall Restriction',
    resL: 14, compL: 45, resR: 14, compR: 45, compChest: 55,
    shunt: 0.15, deadspace: 0.22,
    frcOffset: -0.3, lungCapacity: 2.6,
    note: 'Stiff chest wall elevates pleural pressure. Paw is high while transpulmonary stress is buffered.'
  },
  CUSTOM: {
    name: 'Custom Physiological Settings',
    resL: 15, compL: 50, resR: 15, compR: 50, compChest: 140,
    shunt: 0.08, deadspace: 0.20,
    frcOffset: 0.0, lungCapacity: 3.2,
    note: 'Freely customize resistance, parenchymal compliance, shunt, deadspace, and chest wall parameters.'
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
  apneaTime: 10,              // seconds
  fiO2: 0.40,                 // 21% - 100%
  riseTime: 0.12,             // seconds (valve rise slope)
  triggerType: 'FLOW',        // 'FLOW' or 'PRESSURE'
  triggerSens: 2.0,           // L/min for flow, cmH2O for pressure
  circuitCompliance: 2.0,     // ml/cmH2O
  ettSize: '7.5',             // ETT size ID
  tubeCompEnabled: false,     // Automatic Tube Compensation (ATC)

  // Patient Mechanics & Pathology
  pathology: 'NORMAL',
  resL: 10, compL: 50,
  resR: 10, compR: 50,
  compChest: 160,             // ml/cmH2O (Chest wall compliance)
  shunt: 0.05,
  deadspace: 0.18,
  frcOffset: 0.0,             // L (air trapping offset)
  lungCapacity: 3.4,          // L

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
  const pbw = gender === 'M' 
    ? 50 + 2.3 * (heightInches - 60)
    : 45.5 + 2.3 * (heightInches - 60);
  return Math.max(30, pbw);
};

// =========================================================================
// 5. MAIN VENTILATOR SIMULATOR COMPONENT
// =========================================================================
const App = () => {
  const [params, setParams] = useState(INITIAL_STATE);
  const [isRunning, setIsRunning] = useState(true);
  const [isRecruiting, setIsRecruiting] = useState(false);
  const [activeTab, setActiveTab] = useState('waveforms'); // 'waveforms' | 'abg' | 'mechanics'

  // Dynamic Scale references for smooth Canvas scaling
  const [scales, setScales] = useState({ pMax: 35, fMax: 60, vMax: 650 });
  const scalesRef = useRef({ pMax: 35, fMax: 60, vMax: 650 });
  const displayedScalesRef = useRef({ pMax: 35, fMax: 60, vMax: 650 });

  // Live high-frequency state (~20Hz) for smooth dual-lung animation & instantaneous telemetry
  const [liveTelemetry, setLiveTelemetry] = useState({
    volL_mL: 400,
    volR_mL: 400,
    pctL: 35,
    pctR: 35,
    pendelluftLpm: 0.0,
    instantPaw: 8.0,
    instantFlow: 0.0,
    instantVol: 0,
    phase: 'INS',
    recruitTimeLeft: 0
  });

  // Monitored Real-time Physiological Values
  const [monitoredValues, setMonitoredValues] = useState({
    Ppeak: 22.0,
    Pplat: 18.5,
    Pmean: 11.4,
    PEEPtotal: 8.0,
    AutoPEEP: 0.0,
    DrivingPressure: 10.5,
    TotalRR: 14.0,
    MV: 6.8,
    VtExp: 485,
    VPeakAbs: 1285,
    VPeakRel: 485,
    Cstat: 46.2,
    Cdyn: 34.6,
    Raw: 10.2,
    MechanicalPower: 9.8,
    StressIndex: 1.00,
    TranspulmonaryP: 20.5,
    Ppl: -2.0,
    SpO2: 99,
    EtCO2: 33,
    PaO2: 180,
    PaCO2: 40,
    pH: 7.40,
    HCO3: 24,
    PF_Ratio: 450,
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
    expTime: 0,
    holdTimer: 0,
    patientTime: 0,
    phase: 'EXP',           // 'INS' | 'HOLD_INS' | 'EXP' | 'HOLD_EXP' | 'REC'
    volL: 0.4,              // L (absolute gas volume in Left Lung)
    volR: 0.4,              // L (absolute gas volume in Right Lung)
    volCircuit: 0.016,      // L (compressed volume in ventilator tubing)
    paw: 8,                 // cmH2O (airway pressure at Y-piece)
    flowTotal: 0,           // L/s
    flowL: 0,               // L/s
    flowR: 0,               // L/s
    flowPendelluft: 0,      // L/s (cross-compartment transfer)
    valveFlow: 0,           // L/s (ventilator delivery valve)
    valvePressure: 8,       // cmH2O (proportional valve target)
    pAlvL: 8,               // cmH2O
    pAlvR: 8,               // cmH2O
    pAlvMean: 8,            // cmH2O
    pPl: -5,                // cmH2O (pleural pressure)
    pMus: 0,                // cmH2O (patient effort)
    pPlatStatic: 18,        // cmH2O
    volPeakCycle: 800,
    vEndExpLast_mL: 800,
    currentPeakFlow: 30,
    lastBreathSimTime: 0,
    timeSinceLastBreath: 0,
    isBackupCycle: false,
    pawSum: 0,
    pawCount: 0,
    pPeakCycle: 8,
    recruitmentTimer: 0,
    recruitBonus: 0,
    patientTriggeredThisEffort: false,
    reverseTriggerPending: false,
    reverseTriggerTimer: 0,

    // Pressure trajectory tracking for Stress Index estimation
    inspPressurePoints: [],
    flowLimitationCounter: 0,
    asynchronyType: null,
    lastUiSyncTime: 0
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
    const safeTi = Math.min(inspDuration, cycleDuration * 0.85);
    const pauseDur = params.mode === 'VCV' ? (params.pauseTime || 0) : 0;
    const expDuration = Math.max(0.15, cycleDuration - safeTi - pauseDur);
    const totalInspTime = safeTi + pauseDur;
    const ieRatioNum = expDuration / Math.max(0.1, totalInspTime);
    const ieRatioDisplay = ieRatioNum >= 1
      ? `1 : ${ieRatioNum.toFixed(1)}`
      : `${(1 / ieRatioNum).toFixed(1)} : 1`;
    const isInverseRatio = totalInspTime > expDuration;

    const PBW = calculatePBW(params.gender, params.heightCm);
    const safeVtMin = Math.round(4 * PBW);
    const safeVtMax = Math.round(8 * PBW);
    const isVtSafe = params.tidalVolume >= safeVtMin && params.tidalVolume <= safeVtMax;

    // Time constant calculations: Tau = R * C (in seconds)
    const tauL = (params.resL * (params.compL / 1000));
    const tauR = (params.resR * (params.compR / 1000));
    const cTotal = (params.compL + params.compR) / 1000;
    const rParallel = (params.resL * params.resR) / Math.max(1, params.resL + params.resR);
    const tauSystem = (rParallel * cTotal);

    // Flow requirement in VCV
    const Vt_L = params.tidalVolume / 1000;
    const requiredFlowLps = params.flowPattern === 'SQUARE'
      ? Vt_L / safeTi
      : (2 * Vt_L) / safeTi;

    return {
      cycleDuration,
      inspDuration: safeTi,
      pauseDur,
      expDuration,
      ieRatioDisplay,
      isInverseRatio,
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

  // Compute clinical alarms for active safety surveillance
  const activeAlarms = useMemo(() => {
    const alarms = [];
    if (monitoredValues.Ppeak > 35) {
      alarms.push({ level: 'high', text: `High Peak Pressure (${monitoredValues.Ppeak.toFixed(0)} cmH2O)` });
    }
    if (monitoredValues.Pplat > 30) {
      alarms.push({ level: 'high', text: `High Plateau Pressure (${monitoredValues.Pplat.toFixed(1)} cmH2O > 30)` });
    }
    if (monitoredValues.DrivingPressure >= 15) {
      alarms.push({ level: 'warn', text: `High Driving Pressure (ΔP ${monitoredValues.DrivingPressure.toFixed(1)} cmH2O)` });
    }
    if (monitoredValues.AutoPEEP > 2.0) {
      alarms.push({ level: 'warn', text: `Dynamic Hyperinflation / Auto-PEEP (${monitoredValues.AutoPEEP.toFixed(1)} cmH2O)` });
    }
    if (monitoredValues.SpO2 < 90) {
      alarms.push({ level: 'high', text: `Hypoxemia Alert (SpO2 ${monitoredValues.SpO2}%)` });
    }
    if (monitoredValues.MV > 0.5 && monitoredValues.MV < 3.5) {
      alarms.push({ level: 'warn', text: `Low Minute Ventilation (${monitoredValues.MV.toFixed(1)} L/min)` });
    }
    if (backupActive) {
      alarms.push({ level: 'high', text: 'Apnea Backup Ventilation Active' });
    }
    return alarms;
  }, [monitoredValues, backupActive]);

  // Reset simulation state
  const resetSimState = useCallback((customParams) => {
    const p = customParams || params;
    const cL_Lps = p.compL / 1000;
    const cR_Lps = p.compR / 1000;
    const vL_PEEP = (p.peep * cL_Lps) + (Math.max(0, p.frcOffset) / 2);
    const vR_PEEP = (p.peep * cR_Lps) + (Math.max(0, p.frcOffset) / 2);
    const initVolAbs = (vL_PEEP + vR_PEEP) * 1000;
    const cycleDur = 60 / Math.max(1, p.respiratoryRate);

    simState.current = {
      time: 0,
      // Set cycleTime near cycleDur so the first breath begins immediately
      cycleTime: cycleDur - 0.02,
      expTime: 1.0,
      holdTimer: 0,
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
      pPlatStatic: p.peep + 10,
      volPeakCycle: initVolAbs + p.tidalVolume,
      vEndExpLast_mL: initVolAbs,
      currentPeakFlow: 30,
      lastBreathSimTime: -cycleDur,
      timeSinceLastBreath: 0,
      isBackupCycle: false,
      pawSum: p.peep,
      pawCount: 1,
      pPeakCycle: p.peep + (p.mode === 'PCV' ? p.inspiratoryPressure : 14),
      recruitmentTimer: 0,
      recruitBonus: 0,
      patientTriggeredThisEffort: false,
      reverseTriggerPending: false,
      reverseTriggerTimer: 0,
      eelvRef_mL: initVolAbs,
      inspPressurePoints: [],
      flowLimitationCounter: 0,
      asynchronyType: null,
      lastUiSyncTime: 0
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
      vMax: Math.max(550, p.tidalVolume + 200) 
    };
    setScales(initScales);
    scalesRef.current = initScales;
    displayedScalesRef.current = initScales;

    setBackupActive(false);
    setInspHoldRequest(false);
    setExpHoldRequest(false);
    setIsRecruiting(false);
    setHoldStatus(null);
  }, [params]);

  // Initialize simulation state on mount
  useEffect(() => {
    resetSimState(INITIAL_STATE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full Factory Reset Handler
  const handleFullReset = () => {
    setParams(INITIAL_STATE);
    resetSimState(INITIAL_STATE);
    setIsRunning(true);
  };

  // Keep a live reference to current parameters & controls for the 60fps loop
  const liveConfigRef = useRef({
    isRunning,
    isRecruiting,
    params,
    derivedParams,
    backupActive,
    inspHoldRequest,
    expHoldRequest,
    totalRR: monitoredValues.TotalRR
  });
  liveConfigRef.current = {
    isRunning,
    isRecruiting,
    params,
    derivedParams,
    backupActive,
    inspHoldRequest,
    expHoldRequest,
    totalRR: monitoredValues.TotalRR
  };

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

  // Helper to compute ABG and update monitored values
  const computeAndSetMonitoredValues = useCallback((s, p, d, instantRR, vtExpired_mL, autoPEEP, isPatientTriggered, isApneaTrigger, asynchronyLabel) => {
    const drivingP = Math.max(0.5, s.pPlatStatic - (p.peep + autoPEEP));
    let calculatedCstat = (p.compL + p.compR);
    if (vtExpired_mL > 40 && drivingP > 0.5) {
      calculatedCstat = Math.min(220, vtExpired_mL / drivingP);
    }

    const dynamicDrivingP = Math.max(1, s.pPeakCycle - p.peep);
    const calculatedCdyn = vtExpired_mL > 40
      ? Math.min(200, vtExpired_mL / dynamicDrivingP)
      : calculatedCstat * 0.8;

    const peakFlowLps = Math.max(0.15, s.currentPeakFlow / 60);
    const calculatedRaw = Math.max(1.5, Math.abs(s.pPeakCycle - s.pPlatStatic) / peakFlowLps);

    // Mechanical Power (Gattinoni formula): MP = 0.098 * RR * [Vt * (Ppeak - 0.5 * DrivingP)] (Joules/min)
    const vt_L = vtExpired_mL / 1000;
    const mechanicalPower = Math.max(0, 0.098 * instantRR * (vt_L * (s.pPeakCycle - (0.5 * drivingP))));

    // Stress Index: curvature of Paw during constant flow inspiration
    let stressIndex = 1.0;
    if (s.inspPressurePoints.length >= 8 && p.mode === 'VCV' && p.flowPattern === 'SQUARE') {
      const pts = s.inspPressurePoints;
      const pStart = pts[1];
      const pMid = pts[Math.floor(pts.length / 2)];
      const pEnd = pts[pts.length - 2];
      const midLinear = (pStart + pEnd) / 2;
      const delta = pMid - midLinear;
      stressIndex = Math.max(0.65, Math.min(1.45, 1.0 - (delta / 3.5)));
    } else {
      // Estimate stress index from alveolar volume relative to inflection zone
      const totalV = s.volL + s.volR;
      if (totalV > p.lungCapacity * 0.72) stressIndex = 1.15;
      else if (p.pathology === 'ARDS' && p.peep < 6) stressIndex = 0.85;
      else stressIndex = 1.00;
    }

    // Transpulmonary Pressure at end-inspiration: PL = Pplat - Ppl
    const transpulmonaryP = Math.max(0, s.pPlatStatic - s.pPl);

    // Physiological Gas Exchange & Arterial Blood Gas (ABG)
    const vd_mL = (p.deadspace * vtExpired_mL) + (p.circuitCompliance * Math.max(0, s.pPeakCycle - p.peep) * 0.35);
    const effectiveVt_mL = Math.max(60, vtExpired_mL);
    const va_Lpm = Math.max(0.6, (instantRR * Math.max(45, effectiveVt_mL - vd_mL)) / 1000);

    const pbwNum = Number(d.PBW) || 70;
    const vco2_mLpm = 3.2 * pbwNum;

    let calcPaCO2 = (vco2_mLpm * 0.863) / va_Lpm;
    calcPaCO2 = Math.max(16, Math.min(110, calcPaCO2));

    const hco3 = p.bicarbonate || 24;
    let calcPH = 6.10 + Math.log10(hco3 / (0.0307 * calcPaCO2));
    calcPH = Math.max(6.80, Math.min(7.75, calcPH));

    const paO2_alveolar = Math.max(25, (713 * p.fiO2) - (calcPaCO2 / 0.8));

    let actualShunt = p.shunt;
    if (p.pathology === 'ARDS' || p.pathology === 'PULMONARY_EDEMA') {
      const peepRecruitBenefit = Math.max(0, (p.peep - 5) * 0.018) + (s.recruitBonus * 0.06);
      actualShunt = Math.max(0.05, actualShunt - peepRecruitBenefit);
    }
    if (s.pPlatStatic > 30) {
      actualShunt += (s.pPlatStatic - 30) * 0.01;
    }

    let calcPaO2 = (paO2_alveolar * (1 - actualShunt)) - (actualShunt * 65);
    calcPaO2 = Math.max(28, Math.min(550, calcPaO2));

    const p50_eff = 26.6 * Math.pow(10, 0.48 * (7.40 - calcPH));
    const pRatio = Math.max(0.1, calcPaO2 / p50_eff);
    let calcSaO2 = (Math.pow(pRatio, 2.7) / (1 + Math.pow(pRatio, 2.7))) * 100;
    calcSaO2 = Math.max(35, Math.min(100, Math.round(calcSaO2)));

    let calcEtCO2 = Math.round(calcPaCO2 * (1 - p.deadspace * 0.85));
    calcEtCO2 = Math.max(10, Math.min(95, calcEtCO2));

    const pfRatio = Math.round(calcPaO2 / p.fiO2);
    const aaGradient = Math.max(2, Math.round(paO2_alveolar - calcPaO2));

    setMonitoredValues({
      Ppeak: s.pPeakCycle,
      Pplat: s.pPlatStatic,
      Pmean: s.pawSum / Math.max(1, s.pawCount),
      PEEPtotal: p.peep + autoPEEP,
      AutoPEEP: autoPEEP,
      DrivingPressure: drivingP,
      TotalRR: instantRR,
      MV: (instantRR * effectiveVt_mL) / 1000,
      VtExp: effectiveVt_mL,
      VPeakAbs: s.volPeakCycle,
      VPeakRel: effectiveVt_mL,
      Cstat: calculatedCstat,
      Cdyn: calculatedCdyn,
      Raw: calculatedRaw,
      MechanicalPower: mechanicalPower,
      StressIndex: stressIndex,
      TranspulmonaryP: transpulmonaryP,
      Ppl: s.pPl,
      SpO2: calcSaO2,
      EtCO2: calcEtCO2,
      PaO2: Math.round(calcPaO2),
      PaCO2: Math.round(calcPaCO2),
      pH: calcPH,
      HCO3: hco3,
      PF_Ratio: pfRatio,
      AaGradient: aaGradient,
      FlowLimitationDetected: s.flowLimitationCounter > 6,
      AsynchronyEvent: asynchronyLabel || (isPatientTriggered ? 'Patient Assist' : (isApneaTrigger ? 'Apnea Backup' : null))
    });
  }, []);

  // =========================================================================
  // 6. HIGH-PRECISION SUB-STEPPING PHYSICS SOLVER (500 Hz)
  // =========================================================================
  const updatePhysics = useCallback(() => {
    const {
      isRunning: running,
      isRecruiting: recruiting,
      params: p,
      derivedParams: d,
      backupActive: isBackupUI,
      inspHoldRequest: reqInspHold,
      expHoldRequest: reqExpHold,
      totalRR
    } = liveConfigRef.current;

    if (!running) return;

    const s = simState.current;

    for (let step = 0; step < SUB_STEPS; step++) {
      s.time += SUB_DT;
      if (s.phase !== 'HOLD_INS' && s.phase !== 'HOLD_EXP' && s.phase !== 'REC') {
        s.cycleTime += SUB_DT;
      }
      if (s.phase === 'EXP') {
        s.expTime += SUB_DT;
      }
      s.patientTime += SUB_DT;
      s.timeSinceLastBreath += SUB_DT;

      // Gradually decay recruitment maneuver bonus slowly over minutes
      if (s.recruitBonus > 0 && !recruiting) {
        s.recruitBonus = Math.max(0, s.recruitBonus - SUB_DT * 0.002);
      }

      // -----------------------------------------------------------------------
      // A. Patient Spontaneous Breathing & Pmus Trajectory
      // -----------------------------------------------------------------------
      let Pmus = 0;
      let isPatientTriggered = false;
      let asynchronyNote = null;
      const patientCycleDur = p.spontaneousRR > 0 ? (60 / p.spontaneousRR) : 999;

      if (p.spontaneousRR > 0) {
        if (s.patientTime >= patientCycleDur) {
          s.patientTime = 0;
          s.patientTriggeredThisEffort = false;
        }

        const Ti_mus = Math.min(1.2, patientCycleDur * 0.36);
        const t = s.patientTime;
        const maxEffort = p.pmusEffort || 6.0;

        if (p.pmusSyncMode === 'REVERSE') {
          // Reverse triggering: passive machine inflation triggers reflex diaphragmatic contraction near end-inspiration
          if (s.reverseTriggerPending) {
            s.reverseTriggerTimer += SUB_DT;
            if (s.reverseTriggerTimer < 0.7) {
              Pmus = -1 * maxEffort * Math.sin(Math.PI * (s.reverseTriggerTimer / 0.7));
              asynchronyNote = 'Reverse Trigger (Breath Stacking)';
            } else {
              s.reverseTriggerPending = false;
              s.reverseTriggerTimer = 0;
            }
          }
        } else if (t < Ti_mus) {
          const tNorm = t / Ti_mus;
          Pmus = -1 * maxEffort * Math.sin(Math.PI * tNorm);
        } else {
          Pmus = 0;
        }

        if (p.pmusSyncMode === 'INEFFECTIVE') {
          // Weak inspiratory effort unable to overcome threshold / Auto-PEEP
          Pmus *= 0.28;
          if (t < Ti_mus) asynchronyNote = 'Ineffective Triggering (Wasted Effort)';
        } else if (p.pmusSyncMode === 'FIGHTING') {
          // Patient bucks / contracts expiratory muscles during mechanical inspiration
          if (s.phase === 'INS' && s.cycleTime > 0.25) {
            Pmus = maxEffort * 0.85 * Math.sin(Math.PI * ((s.cycleTime - 0.25) / Math.max(0.3, d.inspDuration)));
            asynchronyNote = 'Expiratory Bucking / Fighting';
          }
        }
      } else {
        s.patientTriggeredThisEffort = false;
      }
      s.pMus = Pmus;
      if (asynchronyNote) s.asynchronyType = asynchronyNote;

      // -----------------------------------------------------------------------
      // B. Pleural Pressure (Ppl) & Transpulmonary Calculations
      // -----------------------------------------------------------------------
      const vTotalL = Math.max(0, (s.volL + s.volR) - Math.max(0, p.frcOffset || 0));
      const cChest_L = Math.max(0.02, p.compChest / 1000);
      const ppl = -5.0 + (vTotalL / cChest_L) + Pmus;
      s.pPl = ppl;

      // -----------------------------------------------------------------------
      // C. Dynamic Resistance & Compliance with ETT Fluid Dynamics
      // -----------------------------------------------------------------------
      const cL_dynamic = getDynamicAlveolarCompliance(s.volL, p.compL, p.pathology, s.phase, p.lungCapacity / 2, p.peep, s.recruitBonus);
      const cR_dynamic = getDynamicAlveolarCompliance(s.volR, p.compR, p.pathology, s.phase, p.lungCapacity / 2, p.peep, s.recruitBonus);

      const rL_dynamic = getDynamicAirwayResistance(p.resL, s.flowL, s.volL, p.pathology, p.lungCapacity / 2);
      const rR_dynamic = getDynamicAirwayResistance(p.resR, s.flowR, s.volR, p.pathology, p.lungCapacity / 2);

      // Endotracheal Tube Rohrer coefficients
      const ettInfo = ETT_PROPERTIES[p.ettSize] || ETT_PROPERTIES['7.5'];
      const absTotalFlow = Math.abs(s.flowTotal);
      let rETT = ettInfo.k1 + (ettInfo.k2 * Math.pow(Math.max(0.01, absTotalFlow), 0.75));
      if (p.tubeCompEnabled) {
        rETT *= 0.15;
      }

      const expResMultiplier = (s.phase === 'EXP' || s.phase === 'HOLD_EXP') ? 1.55 : 1.0;
      const RL = (rL_dynamic * expResMultiplier) + (rETT * 0.5);
      const RR = (rR_dynamic * expResMultiplier) + (rETT * 0.5);

      // Baseline elastic recoil equilibrium offset so at Vol = V_PEEP, pAlv = PEEP
      const vL_base = Math.max(0, p.frcOffset / 2);
      const vR_base = Math.max(0, p.frcOffset / 2);
      const pAlvL = ((s.volL - vL_base) / cL_dynamic) + (ppl + 5.0);
      const pAlvR = ((s.volR - vR_base) / cR_dynamic) + (ppl + 5.0);
      s.pAlvL = pAlvL;
      s.pAlvR = pAlvR;
      s.pAlvMean = (pAlvL + pAlvR) / 2;

      // -----------------------------------------------------------------------
      // D. Inter-Compartment Gas Transfer (Pendelluft Effect)
      // -----------------------------------------------------------------------
      const collateralResistance = 32; // cmH2O/(L/s) inter-bronchial resistance
      const pendelluftFlow = (pAlvL - pAlvR) / collateralResistance;
      s.flowPendelluft = pendelluftFlow;

      // -----------------------------------------------------------------------
      // E. Ventilator Triggering & Phase Switching Logic
      // -----------------------------------------------------------------------
      let triggerBreath = false;
      let isApneaTrigger = false;

      // 1. Apnea Backup check in PSV
      if (p.mode === 'PSV' && s.timeSinceLastBreath >= p.apneaTime && !reqExpHold && !reqInspHold && !recruiting) {
        triggerBreath = true;
        isApneaTrigger = true;
      }

      // 2. Patient Trigger Check ( during EXP after minimum 0.25s refractory period )
      if (s.phase === 'EXP' && s.expTime > 0.25 && p.spontaneousRR > 0 && p.pmusSyncMode !== 'INEFFECTIVE' && !reqExpHold && !recruiting) {
        // Patient effort creates pressure drop below PEEP and positive inspiratory draw
        const rMean = (RL + RR) / 4;
        const patientSuctionDrop = Math.max(0, p.peep - s.pAlvMean);
        const patientInspiratoryFlowLpm = (patientSuctionDrop / Math.max(2, rMean)) * 60;

        if (!s.patientTriggeredThisEffort || p.pmusSyncMode === 'REVERSE') {
          if (p.triggerType === 'FLOW') {
            if (patientInspiratoryFlowLpm >= p.triggerSens) {
              triggerBreath = true;
              isPatientTriggered = true;
              s.patientTriggeredThisEffort = true;
            }
          } else {
            // Pressure trigger: patient suction drop exceeds pressure trigger sensitivity
            if (patientSuctionDrop >= Math.abs(p.triggerSens)) {
              triggerBreath = true;
              isPatientTriggered = true;
              s.patientTriggeredThisEffort = true;
            }
          }
        }
      }

      // 3. Expiratory Hold Request Check
      if (reqExpHold && s.phase === 'EXP' && (s.cycleTime >= d.cycleDuration * 0.9 || (p.mode === 'PSV' && s.expTime >= 1.2))) {
        s.phase = 'HOLD_EXP';
        s.holdTimer = 0;
        setHoldStatus('EXP_HOLD');
      }

      // 4. Mandatory Machine Time Trigger
      if (p.mode !== 'PSV' && s.cycleTime >= d.cycleDuration && s.phase === 'EXP' && !reqExpHold && !recruiting) {
        triggerBreath = true;
      }

      if (s.phase === 'HOLD_EXP' && !reqExpHold) {
        triggerBreath = true;
        setHoldStatus(null);
      }

      // -----------------------------------------------------------------------
      // F. Breath Transition & Cycle Analysis
      // -----------------------------------------------------------------------
      if (triggerBreath && s.phase !== 'INS' && s.phase !== 'HOLD_INS' && s.phase !== 'REC') {
        const breathDurSec = s.time - s.lastBreathSimTime;
        let instantRR = p.mode === 'PSV' ? Math.max(p.spontaneousRR, 60 / p.apneaTime) : p.respiratoryRate;
        if (breathDurSec > 0.4 && breathDurSec < 25) {
          instantRR = lerp(totalRR || instantRR, 60 / breathDurSec, 0.45);
        }
        s.lastBreathSimTime = s.time;

        const vEndExp_mL = (s.volL + s.volR) * 1000;
        const vtExpired_mL = Math.max(0, s.volPeakCycle - vEndExp_mL);
        const autoPEEP = Math.max(0, s.pAlvMean - p.peep);

        computeAndSetMonitoredValues(
          s, p, d, instantRR, vtExpired_mL, autoPEEP,
          isPatientTriggered, isApneaTrigger, s.asynchronyType
        );

        // Save completed loop for reference shadow
        if (history.current.currentLoopPV.length > 15) {
          history.current.lastLoopPV = [...history.current.currentLoopPV];
          history.current.lastLoopFV = [...history.current.currentLoopFV];
        }
        history.current.currentLoopPV = [];
        history.current.currentLoopFV = [];

        // Reset per-breath accumulators
        s.phase = 'INS';
        s.cycleTime = 0;
        s.expTime = 0;
        s.holdTimer = 0;
        s.currentPeakFlow = 0;
        s.timeSinceLastBreath = 0;
        s.isBackupCycle = isApneaTrigger;
        s.pawSum = 0;
        s.pawCount = 0;
        s.pPeakCycle = p.peep;
        s.volPeakCycle = vEndExp_mL;
        s.vEndExpLast_mL = vEndExp_mL;
        s.eelvRef_mL = vEndExp_mL;
        s.inspPressurePoints = [];
        s.flowLimitationCounter = 0;
        s.asynchronyType = null;

        if (isBackupUI !== s.isBackupCycle) {
          setBackupActive(s.isBackupCycle);
        }
      }

      // -----------------------------------------------------------------------
      // G. Mode Target Delivery & Valve Regulation
      // -----------------------------------------------------------------------
      let targetFlow = 0;
      let targetPaw = p.peep;
      let deliveryMode = 'PC'; // 'PC' | 'VC' | 'HOLD'
      const vRelCurrent_mL = Math.max(0, ((s.volL + s.volR) * 1000) - (s.eelvRef_mL || 0));

      if (recruiting) {
        s.recruitmentTimer += SUB_DT;
        s.recruitBonus = Math.min(1.0, s.recruitmentTimer / 20);
        deliveryMode = 'PC';
        if (s.recruitmentTimer < 10) {
          targetPaw = 30;
          s.phase = 'REC';
        } else if (s.recruitmentTimer < 25) {
          targetPaw = 40;
          s.phase = 'REC';
        } else {
          // Recruitment complete (25s protocol finished)
          s.recruitmentTimer = 0;
          s.phase = 'EXP';
          s.expTime = 0;
          setIsRecruiting(false);
        }
      } else {
        if (s.recruitmentTimer > 0) s.recruitmentTimer = 0;

        if (s.phase === 'HOLD_INS') {
          // True Zero-Flow Occlusion State (Both valves closed)
          deliveryMode = 'HOLD';
          s.holdTimer += SUB_DT;
          s.pPlatStatic = s.paw;

          const targetPause = reqInspHold ? 999 : (p.mode === 'VCV' ? (p.pauseTime || 0) : 0);
          if (!reqInspHold && s.holdTimer >= targetPause) {
            s.phase = 'EXP';
            s.expTime = 0;
            setHoldStatus(null);
          }
        } else if (s.phase === 'HOLD_EXP') {
          // True Expiratory Occlusion State (Both valves closed -> reveals Total PEEP / Auto-PEEP)
          deliveryMode = 'HOLD';
          s.holdTimer += SUB_DT;
          if (!reqExpHold) {
            s.phase = 'EXP';
            setHoldStatus(null);
          }
        } else if (s.phase === 'INS') {
          const effectiveMode = (p.mode === 'PSV' && s.isBackupCycle) ? 'PCV' : p.mode;
          let endInsp = false;

          if (effectiveMode === 'VCV') {
            deliveryMode = 'VC';
            if (vRelCurrent_mL >= p.tidalVolume || s.cycleTime >= d.inspDuration) {
              endInsp = true;
            } else {
              if (p.flowPattern === 'SQUARE') {
                // Compensate for initial valve ramp so exact tidal volume is achieved
                targetFlow = d.requiredFlowLps * 1.04;
              } else {
                targetFlow = Math.max(0.05, d.requiredFlowLps * 1.05 * (1 - (s.cycleTime / d.inspDuration)));
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
              if ((currentInspFlowLpm < cycleThreshold && s.currentPeakFlow > 6) || s.cycleTime > 2.8 || (s.cycleTime > 0.25 && currentInspFlowLpm < -2)) {
                endInsp = true;
              }
            }
          }

          if (endInsp) {
            // Trigger Reverse Triggering entrainment at end-inspiration if enabled
            if (p.spontaneousRR > 0 && p.pmusSyncMode === 'REVERSE' && !s.reverseTriggerPending) {
              s.reverseTriggerPending = true;
              s.reverseTriggerTimer = 0;
            }

            if (reqInspHold) {
              s.phase = 'HOLD_INS';
              s.holdTimer = 0;
              setHoldStatus('INSP_HOLD');
            } else if (p.mode === 'VCV' && p.pauseTime && p.pauseTime > 0.02) {
              s.phase = 'HOLD_INS';
              s.holdTimer = 0;
            } else {
              s.phase = 'EXP';
              s.expTime = 0;
            }
          }
        } else {
          // Expiratory Phase
          s.phase = 'EXP';
          deliveryMode = 'PC';
          targetPaw = p.peep;
        }
      }

      // -----------------------------------------------------------------------
      // H. Real-time Fluidic Valve & Airway Dynamics (500 Hz ODE Solver)
      // -----------------------------------------------------------------------
      const valveRiseRate = Math.max(0.03, p.riseTime || 0.12);
      const smoothingFactor = Math.min(1.0, SUB_DT / valveRiseRate);
      const gL = 1 / RL;
      const gR = 1 / RR;

      let currentPaw = p.peep;
      if (deliveryMode === 'HOLD') {
        // Zero external flow: airway pressure equilibrates with alveolar compartments
        s.valveFlow = 0;
        const eqPaw = (pAlvL * gL + pAlvR * gR) / (gL + gR);
        s.valvePressure = lerp(s.valvePressure, eqPaw, Math.min(1, SUB_DT * 25));
        currentPaw = s.valvePressure;
        s.flowL = (currentPaw - pAlvL) / RL;
        s.flowR = (currentPaw - pAlvR) / RR;
      } else if (deliveryMode === 'PC') {
        // Proportional valve pressure regulation + patient effort interaction during EXP
        const expSmoothing = s.phase === 'EXP' ? Math.min(1.0, SUB_DT / 0.045) : smoothingFactor;
        s.valvePressure = lerp(s.valvePressure, targetPaw, expSmoothing);
        // When patient pulls negative Pmus during EXP, Paw dips slightly proportional to effort
        const patientPullDip = s.phase === 'EXP' && Pmus < 0 ? (Pmus * 0.22) : (s.phase === 'INS' && Pmus > 0 ? Pmus * 0.45 : 0);
        currentPaw = Math.max(0, s.valvePressure + patientPullDip);
        s.flowL = (currentPaw - pAlvL) / RL;
        s.flowR = (currentPaw - pAlvR) / RR;
        s.valveFlow = s.flowL + s.flowR;
      } else {
        // High-precision Volume Control flow delivery
        s.valveFlow = lerp(s.valveFlow, targetFlow, Math.min(1.0, SUB_DT / 0.025));
        currentPaw = (s.valveFlow + (pAlvL * gL) + (pAlvR * gR)) / (gL + gR);
        s.flowL = (currentPaw - pAlvL) / RL;
        s.flowR = (currentPaw - pAlvR) / RR;
        s.valvePressure = currentPaw;
      }

      // Circuit Compliance tubing volume effect
      const circuitCompL = (p.circuitCompliance || 2.0) / 1000;
      const prevCircuitVol = s.volCircuit;
      const newCircuitVol = currentPaw * circuitCompL;
      s.volCircuit = newCircuitVol;
      const circuitFlow = deliveryMode === 'HOLD' ? 0 : (newCircuitVol - prevCircuitVol) / SUB_DT;

      s.paw = currentPaw;
      s.flowTotal = deliveryMode === 'HOLD' ? 0 : (s.flowL + s.flowR + (circuitFlow * 0.25));
      s.currentPeakFlow = Math.max(s.currentPeakFlow, s.flowTotal * 60);

      // Update alveolar compartment volumes with Pendelluft cross-flow
      s.volL += (s.flowL - pendelluftFlow) * SUB_DT;
      s.volR += (s.flowR + pendelluftFlow) * SUB_DT;

      if (s.volL < 0.05) s.volL = 0.05;
      if (s.volR < 0.05) s.volR = 0.05;

      const vAbsoluteTotal_mL = (s.volL + s.volR) * 1000;
      s.volPeakCycle = Math.max(s.volPeakCycle, vAbsoluteTotal_mL);
      s.pPeakCycle = Math.max(s.pPeakCycle, currentPaw);

      s.pawSum += currentPaw;
      s.pawCount += 1;

      if (s.phase === 'INS') {
        if (s.cycleTime > 0.08 && s.inspPressurePoints.length < 30) {
          s.inspPressurePoints.push(currentPaw);
        }
        s.pPlatStatic = (pAlvL + pAlvR) / 2;
      }

      // Dynamic Flow Limitation detection
      if (s.phase === 'EXP' && s.flowTotal < -0.12) {
        if ((p.pathology === 'COPD' || p.pathology === 'EMPHYSEMA' || p.pathology === 'ASTHMA') && s.pAlvMean > (p.peep + 2.5) && s.flowTotal > -0.45) {
          s.flowLimitationCounter++;
        } else {
          s.flowLimitationCounter = Math.max(0, s.flowLimitationCounter - 1);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Push Data to History Buffer for 60fps Canvas Display
    // -------------------------------------------------------------------------
    const vRelCurrent_mL = Math.max(0, ((s.volL + s.volR) * 1000) - (s.eelvRef_mL || 0));
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

    // -------------------------------------------------------------------------
    // Throttled Real-time Telemetry Sync (~18 Hz) for Dual-Lung Visualizer & Holds
    // -------------------------------------------------------------------------
    if (s.time - s.lastUiSyncTime >= 0.055) {
      s.lastUiSyncTime = s.time;
      const halfCapL = Math.max(0.5, p.lungCapacity / 2);
      setLiveTelemetry({
        volL_mL: Math.round(s.volL * 1000),
        volR_mL: Math.round(s.volR * 1000),
        pctL: Math.min(100, Math.max(20, (s.volL / halfCapL) * 85)),
        pctR: Math.min(100, Math.max(20, (s.volR / halfCapL) * 85)),
        pendelluftLpm: s.flowPendelluft * 60,
        instantPaw: s.paw,
        instantFlow: s.flowTotal * 60,
        instantVol: Math.round(vRelCurrent_mL),
        phase: s.phase,
        recruitTimeLeft: recruiting ? Math.max(0, Math.ceil(25 - s.recruitmentTimer)) : 0
      });

      // Live readout updates during Diagnostic Holds or Recruitment Maneuver
      if (s.phase === 'HOLD_INS' || s.phase === 'HOLD_EXP' || s.phase === 'REC') {
        const currentVt = Math.max(50, s.volPeakCycle - s.vEndExpLast_mL);
        const currentAutoPeep = s.phase === 'HOLD_EXP'
          ? Math.max(0, s.paw - p.peep)
          : Math.max(0, s.pAlvMean - p.peep);
        const currentPlat = s.phase === 'HOLD_INS' ? s.paw : s.pPlatStatic;
        const currentDriving = Math.max(0.5, currentPlat - (p.peep + currentAutoPeep));
        const currentCstat = Math.min(220, currentVt / currentDriving);

        setMonitoredValues(m => ({
          ...m,
          Ppeak: Math.max(m.Ppeak, s.paw),
          Pplat: currentPlat,
          PEEPtotal: p.peep + currentAutoPeep,
          AutoPEEP: currentAutoPeep,
          DrivingPressure: currentDriving,
          Cstat: currentCstat,
          TranspulmonaryP: Math.max(0, currentPlat - s.pPl),
          Ppl: s.pPl
        }));
      }
    }
  }, [computeAndSetMonitoredValues]);

  // =========================================================================
  // 7. AUTO-SCALE LOGIC FOR HIGH-DEF CANVAS PLOTS
  // =========================================================================
  const updateAutoScales = useCallback(() => {
    const recentPaw = history.current.paw.slice(-PEAK_WINDOW);
    const recentFlow = history.current.flow.slice(-PEAK_WINDOW);
    const recentVol = history.current.vol.slice(-PEAK_WINDOW);

    const maxP = Math.max(25, ...recentPaw);
    const maxF = Math.max(25, ...recentFlow.map(Math.abs));
    const maxV = Math.max(300, ...recentVol);

    scalesRef.current.pMax = lerp(scalesRef.current.pMax, maxP * 1.25, 0.06);
    scalesRef.current.fMax = lerp(scalesRef.current.fMax, maxF * 1.25, 0.06);
    scalesRef.current.vMax = lerp(scalesRef.current.vMax, maxV * 1.22, 0.06);

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

    const w = ctxP.canvas.width;
    const h = ctxP.canvas.height;

    ctxP.clearRect(0, 0, w, h);
    ctxF.clearRect(0, 0, w, h);
    ctxV.clearRect(0, 0, w, h);

    const sP = scalesRef.current.pMax;
    const sF = scalesRef.current.fMax;
    const sV = scalesRef.current.vMax;

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
        scale = (h - 14) / yMax;
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
          const yPos = (i / steps) * (h - 14) + 6;
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
    ctxP.globalAlpha = 0.55;
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
  }, []);

  // Draw P/V and F/V Loops
  const drawLoops = useCallback(() => {
    const canvasPV = canvasRefPV.current;
    const canvasFV = canvasRefFV.current;
    if (!canvasPV || !canvasFV) return;

    const rectPV = canvasPV.getBoundingClientRect();
    const targetW_PV = Math.floor(rectPV.width) || canvasPV.clientWidth || 300;
    const targetH_PV = Math.floor(rectPV.height) || canvasPV.clientHeight || 180;
    if (targetW_PV > 10 && (canvasPV.width !== targetW_PV || canvasPV.height !== targetH_PV)) {
      canvasPV.width = targetW_PV;
      canvasPV.height = targetH_PV;
    }

    const rectFV = canvasFV.getBoundingClientRect();
    const targetW_FV = Math.floor(rectFV.width) || canvasFV.clientWidth || 300;
    const targetH_FV = Math.floor(rectFV.height) || canvasFV.clientHeight || 180;
    if (targetW_FV > 10 && (canvasFV.width !== targetW_FV || canvasFV.height !== targetH_FV)) {
      canvasFV.width = targetW_FV;
      canvasFV.height = targetH_FV;
    }

    const ctxPV = canvasPV.getContext('2d');
    const ctxFV = canvasFV.getContext('2d');
    if (!ctxPV || !ctxFV) return;

    const pMax = scalesRef.current.pMax;
    const vMax = scalesRef.current.vMax;
    const fMax = scalesRef.current.fMax;

    const drawLoopGrid = (ctx, xMax, yMax, xLabel, yLabel, midZeroY = false) => {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      const padL = 36, padR = 12, padB = 26, padT = 16;
      const innerW = Math.max(10, w - padL - padR);
      const innerH = Math.max(10, h - padT - padB);

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
      ctx.fillText(xLabel, padL + innerW / 2, h - 3);

      // Y Ticks
      ctx.textAlign = 'right';
      ctx.font = '9px sans-serif';
      ctx.fillStyle = '#9ca3af';
      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const val = midZeroY
          ? yMax - (i * (yMax * 2) / steps)
          : yMax - (i * yMax / steps);
        const y = padT + (i * innerH / steps);
        ctx.beginPath();
        ctx.moveTo(padL - 3, y);
        ctx.lineTo(padL, y);
        ctx.stroke();
        ctx.fillText(val.toFixed(0), padL - 5, y + 3);
      }

      ctx.textAlign = 'left';
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(yLabel, 6, 11);

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
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      const padL = 36, padR = 12, padB = 26, padT = 16;
      const innerW = Math.max(10, w - padL - padR);
      const innerH = Math.max(10, h - padT - padB);

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
      updateAutoScales();
      drawWaveforms();
      drawLoops();
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [updatePhysics, updateAutoScales, drawWaveforms, drawLoops]);

  // Mode change handler (seamless transition without resetting waveform history)
  const handleModeChange = (e) => {
    const newMode = e.target.value;
    setParams(p => ({
      ...p,
      mode: newMode,
      inspiratoryTime: newMode === 'PSV' ? 0.9 : 1.0,
      spontaneousRR: (newMode === 'PSV' && p.spontaneousRR === 0) ? 14 : p.spontaneousRR
    }));
    if (newMode !== 'PSV') {
      simState.current.isBackupCycle = false;
      setBackupActive(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 font-sans p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-5">

        {/* ================================================================= */}
        {/* HEADER & GLOBAL RUN CONTROLS */}
        {/* ================================================================= */}
        <header className="flex flex-wrap justify-between items-center bg-white border border-gray-300 rounded-2xl p-4 md:p-5 shadow-sm gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-blue-50 text-blue-600 border border-blue-200 rounded-xl">
              <Activity className="h-7 w-7" />
            </div>
            <div>
              <div className="flex items-center flex-wrap gap-2">
                <h1 className="text-xl md:text-2xl font-bold tracking-tight text-gray-900">
                  VentSim <span className="text-blue-600">Pro</span>
                </h1>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                  500 Hz High-Fidelity Physics
                </span>
                <span className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-0.5 rounded-full border ${
                  liveTelemetry.phase === 'INS'
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                    : liveTelemetry.phase === 'EXP'
                    ? 'bg-amber-100 text-amber-800 border-amber-300'
                    : 'bg-purple-100 text-purple-800 border-purple-300'
                }`}>
                  Phase: {liveTelemetry.phase}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">Advanced Dual-Lung Biomechanics, Rohrer Fluid Dynamics & Real-Time ABG</p>
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-2.5">
            {holdStatus && (
              <div className="px-3 py-1.5 rounded-lg bg-yellow-100 border border-yellow-400 text-yellow-800 text-xs font-bold animate-pulse flex items-center space-x-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>{holdStatus === 'INSP_HOLD' ? 'INSPIRATORY HOLD (ZERO FLOW)' : 'EXPIRATORY HOLD (OCCLUSION)'}</span>
              </div>
            )}

            {monitoredValues.AsynchronyEvent && (
              <div className="px-3 py-1.5 rounded-lg bg-purple-100 border border-purple-300 text-purple-800 text-xs font-bold flex items-center space-x-1.5">
                <Zap className="w-3.5 h-3.5" />
                <span>{monitoredValues.AsynchronyEvent}</span>
              </div>
            )}

            {backupActive && (
              <div className="px-3 py-1.5 rounded-lg bg-red-100 border border-red-400 text-red-800 text-xs font-bold animate-pulse flex items-center space-x-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>APNEA BACKUP ACTIVE</span>
              </div>
            )}

            <button
              onClick={handleFullReset}
              title="Reset all parameters to factory clinical defaults"
              className="flex items-center px-3.5 py-2.5 rounded-xl font-semibold text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300 transition"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> RESET
            </button>

            <button
              onClick={() => setIsRunning(!isRunning)}
              className={`flex items-center px-6 py-2.5 rounded-xl font-semibold text-sm transition shadow-sm ${
                isRunning
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {isRunning ? <><Pause className="w-4 h-4 mr-2" /> PAUSE</> : <><Play className="w-4 h-4 mr-2" /> START</>}
            </button>
          </div>
        </header>

        {/* ACTIVE CLINICAL ALARMS BANNER */}
        {activeAlarms.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 bg-red-50 border border-red-300 rounded-xl px-4 py-2.5">
            <span className="text-xs font-bold text-red-800 flex items-center mr-1">
              <AlertCircle className="w-4 h-4 mr-1.5 text-red-600 animate-bounce" />
              Clinical Alerts:
            </span>
            {activeAlarms.map((al, idx) => (
              <span
                key={idx}
                className={`text-xs font-bold px-2.5 py-0.5 rounded-lg border ${
                  al.level === 'high'
                    ? 'bg-red-600 text-white border-red-700'
                    : 'bg-amber-100 text-amber-900 border-amber-400'
                }`}
              >
                {al.text}
              </span>
            ))}
          </div>
        )}

        {/* ================================================================= */}
        {/* MAIN BODY GRID: 8 COLUMNS (MONITOR) vs 4 COLUMNS (CONTROLS) */}
        {/* ================================================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* LEFT 8 COLUMNS: Waveforms, Clinical Metrics & Loops */}
          <div className="lg:col-span-8 space-y-5">

            {/* TAB SELECTOR */}
            <div className="flex flex-wrap gap-2 border-b border-gray-300 pb-2">
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
                <div className="flex flex-wrap justify-between items-center border-b border-gray-200 pb-3 gap-2">
                  <h3 className="text-gray-700 text-sm font-bold flex items-center">
                    <Activity className="w-4 h-4 mr-2 text-blue-600" />
                    Continuous Waveform Telemetry
                  </h3>
                  <div className="flex items-center space-x-4 text-xs">
                    <span className="flex items-center text-amber-600 font-mono font-bold">
                      Paw: {liveTelemetry.instantPaw.toFixed(1)} (Peak {monitoredValues.Ppeak.toFixed(1)}) cmH2O
                    </span>
                    <span className="flex items-center text-emerald-600 font-mono font-bold">
                      Flow: {liveTelemetry.instantFlow.toFixed(0)} L/m
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
                      PEAK: {monitoredValues.Ppeak.toFixed(1)} | PLAT: {monitoredValues.Pplat.toFixed(1)} | PEEP: {monitoredValues.PEEPtotal.toFixed(1)} cmH2O
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
                      <span>Tidal Vol: {liveTelemetry.instantVol} ml | VTe: {monitoredValues.VtExp.toFixed(0)} ml | Total Vol: {monitoredValues.VPeakAbs.toFixed(0)} ml</span>
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
                    <h3 className="text-gray-900 font-bold text-base">Arterial Blood Gas (ABG) & Oxygenation</h3>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-bold border ${
                    monitoredValues.pH < 7.35 
                      ? 'bg-red-100 text-red-700 border-red-300' 
                      : (monitoredValues.pH > 7.45 
                          ? 'bg-amber-100 text-amber-700 border-amber-300' 
                          : 'bg-emerald-100 text-emerald-700 border-emerald-300')
                  }`}>
                    {monitoredValues.pH < 7.35 ? 'Acidemia' : (monitoredValues.pH > 7.45 ? 'Alkalemia' : 'Normal Acid-Base (pH)')}
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
                      monitoredValues.PaCO2 > 45 ? 'text-red-600' : (monitoredValues.PaCO2 < 35 ? 'text-amber-600' : 'text-blue-600')
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
                    <span className="text-xs text-gray-500 block font-medium">SaO2 / SpO2</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.SpO2 < 90 ? 'text-red-600 animate-pulse' : 'text-emerald-600'
                    }`}>
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
                      {monitoredValues.PF_Ratio < 100 ? 'Severe ARDS (<100)' : (monitoredValues.PF_Ratio < 200 ? 'Moderate ARDS (<200)' : (monitoredValues.PF_Ratio < 300 ? 'Mild ARDS (<300)' : 'Normal (>300)'))}
                    </span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">A-a Gradient</span>
                    <span className="text-2xl font-black font-mono text-purple-600">
                      {monitoredValues.AaGradient} <span className="text-xs font-normal">mmHg</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Alveolar-arterial O2 diff</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">EtCO2</span>
                    <span className="text-2xl font-black font-mono text-amber-600">
                      {monitoredValues.EtCO2} <span className="text-xs font-normal">mmHg</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">PaCO2 - EtCO2: {monitoredValues.PaCO2 - monitoredValues.EtCO2} mmHg</span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">HCO3- (Metabolic)</span>
                    <span className="text-2xl font-black font-mono text-gray-800">
                      {monitoredValues.HCO3} <span className="text-xs font-normal">mEq/L</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Ref: 22 - 26 mEq/L</span>
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
                    <span className="text-[10px] text-gray-400 block mt-1">Safe &lt; 15 cmH2O (Amato 2015)</span>
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
                      {monitoredValues.StressIndex > 1.08 ? 'Overdistension (>1.08)' : (monitoredValues.StressIndex < 0.92 ? 'Tidal Recruitment (<0.92)' : 'Optimal Linear (0.95-1.05)')}
                    </span>
                  </div>

                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                    <span className="text-xs text-gray-500 block font-medium">Transpulmonary (PL)</span>
                    <span className={`text-2xl font-black font-mono ${
                      monitoredValues.TranspulmonaryP > 22 ? 'text-red-600' : 'text-purple-600'
                    }`}>
                      {monitoredValues.TranspulmonaryP.toFixed(1)} <span className="text-xs">cmH2O</span>
                    </span>
                    <span className="text-[10px] text-gray-400 block mt-1">Pplat - Ppl (safe &lt; 20 cmH2O)</span>
                  </div>
                </div>

                {/* Pendelluft & Asymmetric Airway Indicator */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 flex flex-col md:flex-row justify-between items-center space-y-2 md:space-y-0">
                  <div>
                    <span className="text-xs font-bold text-gray-800 block">Two-Compartment Time Constants (Tau = R × C)</span>
                    <p className="text-[11px] text-gray-600">
                      Left Lung τ = {derivedParams.tauL}s &nbsp;|&nbsp; Right Lung τ = {derivedParams.tauR}s &nbsp;|&nbsp; System τ = {derivedParams.tauSystem}s
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-gray-500">Complete Exhalation (3.5τ): </span>
                    <span className={`text-xs font-bold ${
                      derivedParams.expDuration < Number(derivedParams.tauSystem) * 3.0 ? 'text-red-600' : 'text-emerald-600'
                    }`}>
                      {(Number(derivedParams.tauSystem) * 3.5).toFixed(2)}s (Current Te: {derivedParams.expDuration.toFixed(2)}s)
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* MONITOR CARDS & REAL-TIME LOOPS */}
            <div className="grid grid-cols-1 md:grid-cols-[auto_1fr_1fr] gap-4 items-stretch">

              {/* Monitored Parameters List */}
              <div className="bg-white rounded-xl p-3.5 shadow-md border border-gray-300 flex flex-col justify-between h-full min-w-[215px]">
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-600 flex items-center mb-1">
                  <BarChart2 className="w-3.5 h-3.5 mr-1.5 text-blue-600 shrink-0" />
                  Primary Readouts
                </h4>
                <div className="flex-1 flex flex-col justify-between text-xs w-full py-0.5 space-y-1">
                  <div className="flex justify-between items-center border-b border-gray-100 py-0.5">
                    <span className="text-gray-600 whitespace-nowrap mr-3">P-Peak / Plat</span>
                    <span className="font-mono font-bold text-red-600 text-right whitespace-nowrap">
                      {monitoredValues.Ppeak.toFixed(1)} / {monitoredValues.Pplat.toFixed(1)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center border-b border-gray-100 py-0.5">
                    <span className="text-gray-600 whitespace-nowrap mr-3">Paw Mean</span>
                    <span className="font-mono font-bold text-amber-600 text-right whitespace-nowrap">{monitoredValues.Pmean.toFixed(1)} cmH2O</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-gray-100 py-0.5">
                    <span className="text-gray-600 whitespace-nowrap mr-3">PEEPtot (PEEPi)</span>
                    <span className={`font-mono font-bold text-right whitespace-nowrap ${monitoredValues.AutoPEEP > 1.5 ? 'text-red-600 animate-pulse' : 'text-gray-800'}`}>
                      {monitoredValues.PEEPtotal.toFixed(1)} ({monitoredValues.AutoPEEP.toFixed(1)})
                    </span>
                  </div>
                  <div className="flex justify-between items-center border-b border-gray-100 py-0.5">
                    <span className="text-gray-600 whitespace-nowrap mr-3">Cstat / Cdyn</span>
                    <span className="font-mono font-bold text-purple-600 text-right whitespace-nowrap">
                      {monitoredValues.Cstat.toFixed(1)} / {monitoredValues.Cdyn.toFixed(1)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center border-b border-gray-100 py-0.5">
                    <span className="text-gray-600 whitespace-nowrap mr-3">Raw</span>
                    <span className="font-mono font-bold text-blue-600 text-right whitespace-nowrap">{monitoredValues.Raw.toFixed(1)} cmH2O/L/s</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-gray-100 py-0.5">
                    <span className="text-gray-600 whitespace-nowrap mr-3">MV (Exp)</span>
                    <span className="font-mono font-bold text-emerald-600 text-right whitespace-nowrap">{monitoredValues.MV.toFixed(2)} L/min</span>
                  </div>
                  <div className="flex justify-between items-center py-0.5">
                    <span className="text-gray-600 whitespace-nowrap mr-3">Total RR (I:E)</span>
                    <span className="font-mono font-bold text-blue-600 text-right whitespace-nowrap">
                      {monitoredValues.TotalRR.toFixed(1)} ({derivedParams.ieRatioDisplay})
                    </span>
                  </div>
                </div>

                {monitoredValues.FlowLimitationDetected && (
                  <div className="mt-1 bg-red-100 border border-red-400 text-red-700 px-2 py-0.5 rounded text-center text-[10px] font-bold animate-pulse shrink-0">
                    ⚠️ EXP FLOW LIMITATION
                  </div>
                )}
              </div>

              {/* P/V Loop */}
              <div className="relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-md flex flex-col justify-between h-full min-h-[220px]">
                <div className="w-full flex-1 min-h-[120px] relative overflow-hidden">
                  <canvas ref={canvasRefPV} className="w-full h-full block bg-gray-800 rounded" />
                </div>
                <div className="mt-1 rounded-lg bg-gray-900/95 p-1.5 text-xs text-white border border-gray-700 shrink-0">
                  <div className="flex justify-between items-center font-bold">
                    <span className="text-yellow-400">DRIVING P (ΔP):</span>
                    <span className="text-base leading-none text-red-400 font-mono">
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
              <div className="relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-md flex flex-col justify-between h-full min-h-[220px]">
                <div className="w-full flex-1 min-h-[120px] relative overflow-hidden">
                  <canvas ref={canvasRefFV} className="w-full h-full block bg-gray-800 rounded" />
                </div>
                <div className="mt-1 rounded-lg bg-gray-900/95 p-1.5 text-xs text-white border border-gray-700 shrink-0">
                  <div className="flex justify-between items-center font-bold">
                    <span className="text-emerald-400">AUTO-PEEP (PEEPi):</span>
                    <span className="text-base leading-none text-yellow-400 font-mono">
                      {monitoredValues.AutoPEEP.toFixed(1)} <span className="text-xs">cmH2O</span>
                    </span>
                  </div>
                  <div className="flex justify-between pt-0.5 text-[10px] text-gray-300">
                    <span className="text-sky-300">VTe: {monitoredValues.VtExp.toFixed(0)} ml</span>
                    <span className="text-emerald-300">Scale: ±{scales.fMax.toFixed(0)} L/m</span>
                  </div>
                </div>
              </div>

            </div>

            {/* DUAL-LUNG REAL-TIME EXPANSION VISUALIZER */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300">
              <div className="flex flex-wrap justify-between items-center mb-3 gap-2">
                <h4 className="text-sm font-bold text-gray-800 flex items-center">
                  <Wind className="w-4 h-4 mr-2 text-blue-600" />
                  Bilateral Alveolar Aeration & Dynamic Inflation
                </h4>
                <div className="flex items-center space-x-4 text-xs text-gray-600">
                  <span>
                    SpO2: <strong className={monitoredValues.SpO2 < 90 ? 'text-red-600' : 'text-emerald-600'}>{monitoredValues.SpO2}%</strong>
                  </span>
                  <span>
                    Pendelluft Cross-Flow: <strong className="font-mono text-blue-600">{liveTelemetry.pendelluftLpm.toFixed(1)} L/min</strong>
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Left Lung Visualization */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 text-center">
                  <span className="text-xs font-bold text-blue-600 block mb-2">
                    LEFT LUNG (CL: {params.compL} | RL: {params.resL} | τ: {derivedParams.tauL}s)
                  </span>
                  <div className="h-20 flex items-end justify-center bg-gray-100 rounded-xl p-2 border border-gray-200">
                    <div 
                      className="w-28 bg-gradient-to-t from-blue-600 to-sky-400 rounded-xl transition-all duration-75 shadow-md"
                      style={{ 
                        height: `${liveTelemetry.pctL}%`,
                        opacity: params.shunt > 0.25 ? 0.75 : 1.0
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-xs font-mono font-semibold text-gray-700 mt-2 px-2">
                    <span>Vol: {liveTelemetry.volL_mL} ml</span>
                    <span className="text-blue-600">{liveTelemetry.pctL.toFixed(0)}% Cap</span>
                  </div>
                </div>

                {/* Right Lung Visualization */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 text-center">
                  <span className="text-xs font-bold text-red-600 block mb-2">
                    RIGHT LUNG (CR: {params.compR} | RR: {params.resR} | τ: {derivedParams.tauR}s)
                  </span>
                  <div className="h-20 flex items-end justify-center bg-gray-100 rounded-xl p-2 border border-gray-200">
                    <div 
                      className="w-28 bg-gradient-to-t from-red-600 to-rose-400 rounded-xl transition-all duration-75 shadow-md"
                      style={{ 
                        height: `${liveTelemetry.pctR}%`,
                        opacity: params.shunt > 0.25 ? 0.75 : 1.0
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-xs font-mono font-semibold text-gray-700 mt-2 px-2">
                    <span>Vol: {liveTelemetry.volR_mL} ml</span>
                    <span className="text-red-600">{liveTelemetry.pctR.toFixed(0)}% Cap</span>
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* RIGHT 4 COLUMNS: Ventilator Controls, Patient Mechanics & Maneuvers */}
          <div className="lg:col-span-4 space-y-5">

            {/* 1. VENTILATOR SETTINGS */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-4">
              <div className="flex items-center justify-between text-blue-600 border-b border-gray-200 pb-3">
                <div className="flex items-center">
                  <Settings className="w-5 h-5 mr-2" />
                  <h3 className="font-bold text-gray-900 text-base">Ventilator Settings</h3>
                </div>
                <span className="text-[11px] font-mono font-bold text-gray-600 bg-gray-100 px-2 py-0.5 rounded border border-gray-200">
                  I:E {derivedParams.ieRatioDisplay}
                </span>
              </div>

              {/* Mode Selection */}
              <div>
                <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-2">Ventilation Mode</label>
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
                <div className="space-y-3 bg-blue-50/40 p-3 rounded-xl border border-blue-100">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700 font-semibold">Tidal Volume (Vt)</span>
                      <span className="font-mono font-bold text-blue-600">{params.tidalVolume} ml ({derivedParams.requiredFlowLpm.toFixed(0)} L/m)</span>
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
                        Protective: {derivedParams.safeVtRange}
                      </span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-700 font-semibold block mb-1">Flow Waveform Pattern</label>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {['SQUARE', 'RAMP'].map(patt => (
                        <button
                          key={patt}
                          onClick={() => setParams(p => ({ ...p, flowPattern: patt }))}
                          className={`py-1.5 rounded-lg font-bold border transition ${
                            params.flowPattern === patt
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
                          }`}
                        >
                          {patt === 'SQUARE' ? 'Square (Constant)' : 'Decelerating Ramp'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700 font-semibold">Inspiratory Pause (Tpause)</span>
                      <span className="font-mono font-bold text-blue-600">{params.pauseTime.toFixed(2)} s</span>
                    </div>
                    <input
                      type="range" min="0" max="0.6" step="0.05"
                      value={params.pauseTime}
                      onChange={(e) => setParams(p => ({ ...p, pauseTime: Number(e.target.value) }))}
                      className="w-full accent-blue-600"
                    />
                  </div>
                </div>
              )}

              {/* PCV: Inspiratory Pressure */}
              {params.mode === 'PCV' && (
                <div className="bg-red-50/40 p-3 rounded-xl border border-red-100">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-700 font-semibold">Pinsp (above PEEP)</span>
                    <span className="font-mono font-bold text-red-600">{params.inspiratoryPressure} cmH2O</span>
                  </div>
                  <input
                    type="range" min="4" max="35" step="1"
                    value={params.inspiratoryPressure}
                    onChange={(e) => setParams(p => ({ ...p, inspiratoryPressure: Number(e.target.value) }))}
                    className="w-full accent-red-600"
                  />
                  <span className="text-[11px] text-gray-500 block mt-0.5">
                    Target Peak Airway Pressure = <strong>{params.inspiratoryPressure + params.peep} cmH2O</strong>
                  </span>
                </div>
              )}

              {/* PSV: Pressure Support, E-Sense & Apnea Time */}
              {params.mode === 'PSV' && (
                <div className="space-y-3 bg-emerald-50/40 p-3 rounded-xl border border-emerald-100">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700 font-semibold">Pressure Support (PS)</span>
                      <span className="font-mono font-bold text-red-600">{params.pressureSupport} cmH2O</span>
                    </div>
                    <input
                      type="range" min="4" max="30" step="1"
                      value={params.pressureSupport}
                      onChange={(e) => setParams(p => ({ ...p, pressureSupport: Number(e.target.value) }))}
                      className="w-full accent-red-600"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-700 font-semibold">E-Sense</span>
                        <span className="font-mono font-bold text-blue-600">{params.eSense}%</span>
                      </div>
                      <input
                        type="range" min="5" max="55" step="5"
                        value={params.eSense}
                        onChange={(e) => setParams(p => ({ ...p, eSense: Number(e.target.value) }))}
                        className="w-full accent-blue-600"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-700 font-semibold">Apnea Time</span>
                        <span className="font-mono font-bold text-red-600">{params.apneaTime}s</span>
                      </div>
                      <input
                        type="range" min="5" max="20" step="1"
                        value={params.apneaTime}
                        onChange={(e) => setParams(p => ({ ...p, apneaTime: Number(e.target.value) }))}
                        className="w-full accent-red-600"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Respiratory Rate & Ti */}
              {params.mode !== 'PSV' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">Rate (RR)</span>
                      <span className="font-mono font-bold text-blue-600">{params.respiratoryRate} /min</span>
                    </div>
                    <input
                      type="range" min="6" max="40" step="1"
                      value={params.respiratoryRate}
                      onChange={(e) => setParams(p => ({ ...p, respiratoryRate: Number(e.target.value) }))}
                      className="w-full accent-blue-600"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-700">Insp Time (Ti)</span>
                      <span className="font-mono font-bold text-blue-600">{params.inspiratoryTime.toFixed(2)}s</span>
                    </div>
                    <input
                      type="range" min="0.4" max="2.5" step="0.05"
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

              {/* Trigger, ETT, Rise Time, Circuit & ATC */}
              <div className="border-t border-gray-200 pt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="text-gray-600 block mb-1">Trigger Mode</label>
                    <select
                      value={params.triggerType}
                      onChange={(e) => setParams(p => ({
                        ...p,
                        triggerType: e.target.value,
                        triggerSens: e.target.value === 'FLOW' ? 2.0 : 1.5
                      }))}
                      className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-900"
                    >
                      <option value="FLOW">Flow Trigger (L/min)</option>
                      <option value="PRESSURE">Pressure Trigger (cmH2O)</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-600">Sensitivity</span>
                      <span className="font-mono font-bold text-blue-600">
                        {params.triggerSens.toFixed(1)} {params.triggerType === 'FLOW' ? 'L/m' : 'cmH2O'}
                      </span>
                    </div>
                    <input
                      type="range" min="0.5" max="8.0" step="0.5"
                      value={params.triggerSens}
                      onChange={(e) => setParams(p => ({ ...p, triggerSens: Number(e.target.value) }))}
                      className="w-full accent-blue-600 mt-1"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="text-gray-600 block mb-1">Airway / ETT Size</label>
                    <select
                      value={params.ettSize}
                      onChange={(e) => setParams(p => ({ ...p, ettSize: e.target.value }))}
                      className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-900"
                    >
                      {Object.entries(ETT_PROPERTIES).map(([k, v]) => (
                        <option key={k} value={k}>{v.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-600">Rise Time</span>
                      <span className="font-mono font-bold text-blue-600">{params.riseTime.toFixed(2)}s</span>
                    </div>
                    <input
                      type="range" min="0.04" max="0.40" step="0.02"
                      value={params.riseTime}
                      onChange={(e) => setParams(p => ({ ...p, riseTime: Number(e.target.value) }))}
                      className="w-full accent-blue-600 mt-1"
                    />
                  </div>
                </div>

                <div className="flex justify-between items-center bg-gray-50 p-2.5 rounded-xl border border-gray-200">
                  <div>
                    <span className="text-xs text-gray-700 font-semibold block">Automatic Tube Comp (ATC)</span>
                    <span className="text-[10px] text-gray-500">Offsets non-linear ETT Rohrer resistance</span>
                  </div>
                  <button
                    onClick={() => setParams(p => ({ ...p, tubeCompEnabled: !p.tubeCompEnabled }))}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
                      params.tubeCompEnabled ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {params.tubeCompEnabled ? 'ON (85%)' : 'OFF'}
                  </button>
                </div>
              </div>
            </div>

            {/* 2. PATIENT PROFILE & ANTHROPOMETRICS */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-3">
              <div className="flex items-center justify-between text-indigo-600 border-b border-gray-200 pb-2.5">
                <div className="flex items-center">
                  <User className="w-5 h-5 mr-2" />
                  <h3 className="font-bold text-gray-900 text-base">Patient Profile & ABG Base</h3>
                </div>
                <span className="text-xs font-mono font-bold bg-indigo-50 text-indigo-700 px-2.5 py-0.5 rounded-full border border-indigo-200">
                  PBW: {derivedParams.PBW} kg
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2.5 text-xs">
                <div>
                  <label className="text-gray-600 block mb-1 font-medium">Sex</label>
                  <select
                    value={params.gender}
                    onChange={(e) => setParams(p => ({ ...p, gender: e.target.value }))}
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-900"
                  >
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                  </select>
                </div>
                <div>
                  <label className="text-gray-600 block mb-1 font-medium">Height (cm)</label>
                  <input
                    type="number" min="140" max="210"
                    value={params.heightCm}
                    onChange={(e) => setParams(p => ({ ...p, heightCm: Math.max(140, Math.min(210, Number(e.target.value) || 170)) }))}
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-900 font-mono"
                  />
                </div>
                <div>
                  <label className="text-gray-600 block mb-1 font-medium">HCO3- (mEq/L)</label>
                  <input
                    type="number" min="8" max="45"
                    value={params.bicarbonate}
                    onChange={(e) => setParams(p => ({ ...p, bicarbonate: Math.max(8, Math.min(45, Number(e.target.value) || 24)) }))}
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-900 font-mono"
                  />
                </div>
              </div>
            </div>

            {/* 3. PATIENT BIOMECHANICS & PATHOLOGY */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-4">
              <div className="flex items-center text-purple-600 border-b border-gray-200 pb-3">
                <HeartPulse className="w-5 h-5 mr-2" />
                <h3 className="font-bold text-gray-900 text-base">Patient Mechanics & Pathology</h3>
              </div>

              {/* Pathology Selector */}
              <div>
                <label className="text-xs text-gray-600 block mb-1 font-semibold">Clinical Pathology Preset</label>
                <select
                  value={params.pathology}
                  onChange={handlePathologyChange}
                  className="w-full bg-white border border-gray-300 rounded-xl px-3 py-2 text-xs text-gray-900 font-semibold"
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
                    <HeartPulse className="w-3.5 h-3.5 mr-1" /> Spontaneous Neural RR
                  </span>
                  <span className="font-mono font-bold text-purple-700">{params.spontaneousRR} bpm</span>
                </div>
                <input
                  type="range" min="0" max="38" step="1"
                  value={params.spontaneousRR}
                  onChange={(e) => setParams(p => ({ ...p, spontaneousRR: Number(e.target.value) }))}
                  className="w-full accent-purple-600"
                />

                {params.spontaneousRR > 0 && (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-purple-700 font-semibold">Inspiratory Effort (Pmus)</span>
                      <span className="font-mono text-purple-800 font-bold">-{params.pmusEffort} cmH2O</span>
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
                        <option value="AUTO_SYNC">Synchronized Assist (Normal)</option>
                        <option value="FIGHTING">Expiratory Bucking / Fighting</option>
                        <option value="INEFFECTIVE">Ineffective Triggering (Wasted Effort)</option>
                        <option value="REVERSE">Reverse Triggering (Breath Stacking)</option>
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* Detailed Dual-Lung Mechanics */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-gray-50 p-3 rounded-xl border border-gray-200">
                  <span className="font-bold text-blue-600 block mb-1">Left Lung</span>
                  <div className="space-y-1.5">
                    <div>
                      <span className="text-[10px] text-gray-500 block">Comp (ml/cmH2O)</span>
                      <input
                        type="number" min="5" max="150"
                        value={params.compL}
                        onChange={(e) => setParams(p => ({ ...p, compL: Math.max(5, Number(e.target.value) || 5) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-500 block">Res (cmH2O/L/s)</span>
                      <input
                        type="number" min="2" max="60"
                        value={params.resL}
                        onChange={(e) => setParams(p => ({ ...p, resL: Math.max(2, Number(e.target.value) || 2) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs font-mono"
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
                        onChange={(e) => setParams(p => ({ ...p, compR: Math.max(5, Number(e.target.value) || 5) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-gray-500 block">Res (cmH2O/L/s)</span>
                      <input
                        type="number" min="2" max="60"
                        value={params.resR}
                        onChange={(e) => setParams(p => ({ ...p, resR: Math.max(2, Number(e.target.value) || 2) }))}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-gray-900 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Chest Wall, Shunt & Deadspace Parameters */}
              <div className="grid grid-cols-3 gap-2 text-xs pt-1">
                <div className="bg-gray-50 p-2 rounded-lg border border-gray-200">
                  <span className="text-[10px] text-gray-500 block">Ccw (ml/cmH2O)</span>
                  <input
                    type="number" min="25" max="250"
                    value={params.compChest}
                    onChange={(e) => setParams(p => ({ ...p, compChest: Math.max(25, Number(e.target.value) || 100) }))}
                    className="w-full bg-white border border-gray-300 rounded px-1.5 py-1 text-gray-900 text-xs font-mono mt-0.5"
                  />
                </div>
                <div className="bg-gray-50 p-2 rounded-lg border border-gray-200">
                  <span className="text-[10px] text-gray-500 block">Shunt (%)</span>
                  <input
                    type="number" min="2" max="65"
                    value={Math.round(params.shunt * 100)}
                    onChange={(e) => setParams(p => ({ ...p, shunt: Math.max(0.02, Math.min(0.65, (Number(e.target.value) || 5) / 100)) }))}
                    className="w-full bg-white border border-gray-300 rounded px-1.5 py-1 text-gray-900 text-xs font-mono mt-0.5"
                  />
                </div>
                <div className="bg-gray-50 p-2 rounded-lg border border-gray-200">
                  <span className="text-[10px] text-gray-500 block">Vd/Vt (%)</span>
                  <input
                    type="number" min="10" max="70"
                    value={Math.round(params.deadspace * 100)}
                    onChange={(e) => setParams(p => ({ ...p, deadspace: Math.max(0.10, Math.min(0.70, (Number(e.target.value) || 18) / 100)) }))}
                    className="w-full bg-white border border-gray-300 rounded px-1.5 py-1 text-gray-900 text-xs font-mono mt-0.5"
                  />
                </div>
              </div>
            </div>

            {/* 4. DIAGNOSTIC MANEUVERS (INSP HOLD / EXP HOLD / RECRUITMENT) */}
            <div className="bg-white rounded-xl p-5 shadow-lg border border-gray-300 space-y-4">
              <div className="flex items-center text-amber-600 border-b border-gray-200 pb-3">
                <TrendingUp className="w-5 h-5 mr-2" />
                <h3 className="font-bold text-gray-900 text-base">Diagnostic ICU Maneuvers</h3>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    setInspHoldRequest(!inspHoldRequest);
                    if (!inspHoldRequest) setExpHoldRequest(false);
                  }}
                  className={`py-3 px-3 rounded-xl font-bold text-xs transition border flex items-center justify-center space-x-1.5 ${
                    inspHoldRequest
                      ? 'bg-blue-600 text-white border-blue-600 animate-pulse shadow'
                      : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                  }`}
                >
                  <PauseCircle className="w-4 h-4" />
                  <span>{inspHoldRequest ? 'RELEASE INSP' : 'INSP HOLD (Pplat)'}</span>
                </button>

                <button
                  onClick={() => {
                    setExpHoldRequest(!expHoldRequest);
                    if (!expHoldRequest) setInspHoldRequest(false);
                  }}
                  className={`py-3 px-3 rounded-xl font-bold text-xs transition border flex items-center justify-center space-x-1.5 ${
                    expHoldRequest
                      ? 'bg-red-600 text-white border-red-600 animate-pulse shadow'
                      : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                  }`}
                >
                  <StopCircle className="w-4 h-4" />
                  <span>{expHoldRequest ? 'RELEASE EXP' : 'EXP HOLD (PEEPi)'}</span>
                </button>
              </div>

              <button
                onClick={() => {
                  setIsRecruiting(!isRecruiting);
                  setInspHoldRequest(false);
                  setExpHoldRequest(false);
                }}
                className={`w-full py-2.5 rounded-xl font-bold text-xs transition border flex items-center justify-center space-x-2 ${
                  isRecruiting
                    ? 'bg-amber-100 text-amber-900 border-amber-400 animate-pulse'
                    : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
                }`}
              >
                <CheckCircle2 className="w-4 h-4 text-amber-600" />
                <span>
                  {isRecruiting
                    ? `RECRUITING LUNG (30/40 cmH2O) — ${liveTelemetry.recruitTimeLeft}s left`
                    : 'Start Stepwise Alveolar Recruitment (25s)'}
                </span>
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
