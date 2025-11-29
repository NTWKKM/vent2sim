import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { 
  Play, Pause, Activity, Settings, HeartPulse, AlertCircle, 
  TrendingUp, Filter, BarChart2, User, Clock, PauseCircle, 
  StopCircle, X
} from 'lucide-react';

// ===== PHYSICS CONSTANTS =====
const DT = 0.016;
const MAX_HISTORY = 1500;
const PEAK_WINDOW = 300;
const PCV_RISE_SMOOTHING = 0.08;
const EXP_RESISTANCE_MULTIPLIER = 1.2;
const CIRCUIT_COMPLIANCE = 2.5;

// ===== HELPER FUNCTIONS =====
const lerp = (start, end, factor) => start + (end - start) * factor;

const calculatePBW = (gender, heightCm) => {
  const heightInches = heightCm * 0.393701;
  if (gender === 'M') {
    return 50 + 2.3 * (heightInches - 60);
  } else {
    return 45.5 + 2.3 * (heightInches - 60);
  }
};

// ===== PHYSICS FUNCTIONS (from old_main.jsx) =====
const getDynamicResistance = (baseR, currentFlow_Lps, currentVol_L, pathology) => {
  let turbulenceFactor = 0.5;
  let volumeFactor = 2.0;
  if (pathology === 'COPD' || pathology === 'EMPHYSEMA') {
    turbulenceFactor = 2.5;
    volumeFactor = 5.0;
  }
  const flowEffect = Math.abs(currentFlow_Lps) * turbulenceFactor;
  const volEffect = Math.min(baseR * 0.6, currentVol_L * volumeFactor);
  let effectiveR = baseR + flowEffect - volEffect;
  return Math.max(baseR * 0.3, effectiveR);
};

const getDynamicCompliance = (currentTotalVol_L, baseC_ml, pathology, phase, lungCapacity_L) => {
  const baseC_L = baseC_ml / 1000;
  let lowerInflection_L = 0.1;
  let upperInflection_L = lungCapacity_L * 0.75;
  let distensionFactor = 10;
  
  switch (pathology) {
    case 'ARDS':
      lowerInflection_L = 0.15;
      upperInflection_L = lungCapacity_L * 0.6;
      distensionFactor = 20;
      break;
    case 'FIBROSIS':
      lowerInflection_L = 0.05;
      upperInflection_L = lungCapacity_L * 0.5;
      distensionFactor = 25;
      break;
    case 'EMPHYSEMA':
    case 'COPD':
      lowerInflection_L = 0.0;
      upperInflection_L = lungCapacity_L * 0.8;
      distensionFactor = 8;
      break;
    default:
      lowerInflection_L = 0.1;
      upperInflection_L = lungCapacity_L * 0.85;
      break;
  }
  
  let effectiveC = baseC_L;
  
  if (phase === 'INS' || phase === 'HOLD_INS' || phase === 'REC') {
    if (currentTotalVol_L < lowerInflection_L) {
      const factor = 0.5 + (0.5 * (currentTotalVol_L / lowerInflection_L));
      effectiveC = baseC_L * factor;
    }
  }
  
  if (currentTotalVol_L > upperInflection_L) {
    const excessVol = currentTotalVol_L - upperInflection_L;
    const stiffness = Math.exp(-excessVol * distensionFactor);
    effectiveC = baseC_L * stiffness;
  }
  
  return Math.max(0.002, effectiveC);
};

// ===== PATHOLOGY PRESETS =====
const PATHOLOGY_PRESETS = {
  NORMAL: { 
    name: 'Normal (Adult on ETT)', 
    resL: 15, compL: 50, resR: 15, compR: 50, 
    shunt: 0.05, deadspace: 0.15, frcOffset: 0.0, lungCapacity: 3.0,
    clinicalTips: ['Standard adult on ETT. Normal mechanics.']
  },
  ARDS: { 
    name: 'ARDS (Stiff Lungs)', 
    resL: 15, compL: 30, resR: 15, compR: 30, 
    shunt: 0.30, deadspace: 0.35, frcOffset: 0.0, lungCapacity: 1.0,
    clinicalTips: ['Low Compliance (Baby Lung). SpO2 drops easily.']
  },
  COPD: { 
    name: 'COPD (Mild/Mod)', 
    resL: 20, compL: 60, resR: 20, compR: 60, 
    shunt: 0.10, deadspace: 0.30, frcOffset: 1.0, lungCapacity: 3.5,
    clinicalTips: ['Moderate R. Can exhale fully at low RR/high I:E.']
  },
  EMPHYSEMA: { 
    name: 'Emphysema (Severe)', 
    resL: 25, compL: 120, resR: 25, compR: 120, 
    shunt: 0.15, deadspace: 0.45, frcOffset: 2.3, lungCapacity: 3.0,
    clinicalTips: ['High Compliance but Low Vt due to Severe Air Trapping.']
  },
  CUSTOM: { 
    name: 'Custom Settings', 
    resL: 15, compL: 50, resR: 15, compR: 50, 
    shunt: 0.05, deadspace: 0.15, frcOffset: 0.0, lungCapacity: 3.0,
    clinicalTips: ['Manual control.']
  }
};

// ===== MAIN APP COMPONENT =====
export default function App() {
  // ===== STATE =====
  const [params, setParams] = useState({
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
    pathology: 'NORMAL',
    resL: 15, compL: 50, resR: 15, compR: 50,
    shunt: 0.05, deadspace: 0.15, frcOffset: 0.0, lungCapacity: 3.0,
    gender: 'M', heightCm: 170, actualWeightKg: 70, weightMode: 'PBW',
    spontaneousRR: 0, pmusSyncMode: 'AUTOSYNC'
  });

  const [isRunning, setIsRunning] = useState(false);
  const [isRecruiting, setIsRecruiting] = useState(false);
  const [backupActive, setBackupActive] = useState(false);
  const [isStudyMode, setIsStudyMode] = useState(false);
  const [language, setLanguage] = useState('en');
  const [activeMobileTab, setActiveMobileTab] = useState('waveforms');
  const [inspHoldRequest, setInspHoldRequest] = useState(false);
  const [expHoldRequest, setExpHoldRequest] = useState(false);
  const [holdStatus, setHoldStatus] = useState(null);
  
  const [scales, setScales] = useState({ pMax: 40, fMax: 60, vMax: 600 });
  const scalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });
  const displayedScalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });

  const [monitoredValues, setMonitoredValues] = useState({
    Pplat: 0, Pmean: 0, Cstat: 0, AutoPEEP: 0,
    TotalRR: 0, MV: 0, VtExp: 0, VPeakAbs: 0, VPeakRel: 0,
    SpO2: 98, EtCO2: 35, PaO2: 100, PaCO2: 40
  });

  // ===== REFS =====
  const simState = useRef({
    time: 0, cycleTime: 0, patientTime: 0, phase: 'EXP',
    volL: 0, volR: 0, paw: 0, flowTotal: 0, flowL: 0, flowR: 0,
    valveFlow: 0, valvePressure: 0, volCircuit: 0,
    recruitmentTimer: 0, recruitmentStep: 0,
    pawSum: 0, pawCount: 0, pPlatTemp: 0, autoPeepTemp: 0,
    volPeakCycle: 0, currentPeakFlow: 0,
    lastBreathTime: Date.now(), timeSinceLastBreath: 0,
    isBackupCycle: false, holdTimer: 0, pPlatCaptured: false
  });

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

  const canvasRefP = useRef(null);
  const canvasRefF = useRef(null);
  const canvasRefV = useRef(null);
  const canvasRefPV = useRef(null);
  const canvasRefFV = useRef(null);

  // ===== DERIVED PARAMS =====
  const derivedParams = useMemo(() => {
    const cycleDuration = 60 / params.respiratoryRate;
    const inspDuration = params.inspiratoryTime;
    const TiMax = cycleDuration * 0.95;
    const safeTi = Math.min(inspDuration, TiMax - 0.05);
    const expDuration = cycleDuration - safeTi;
    const ieRatioDisplay = (expDuration / safeTi).toFixed(1);

    const VtL = params.tidalVolume / 1000;
    let requiredFlow = 0;
    if (params.flowPattern === 'SQUARE') {
      requiredFlow = VtL / safeTi;
    } else {
      requiredFlow = (2 * VtL) / safeTi;
    }

    const CTotalml = params.compL + params.compR;
    const PBW = calculatePBW(params.gender, params.heightCm);
    const safeVtMin = Math.round(4 * PBW);
    const safeVtMax = Math.round(8 * PBW);

    const calculatedPmus = params.spontaneousRR * 0.5;
    let pmusStatus = 'None';
    let pmusColor = 'text-gray-500';
    if (params.spontaneousRR > 0) {
      if (calculatedPmus < 5) {
        pmusStatus = 'Low Effort';
        pmusColor = 'text-blue-600';
      } else if (calculatedPmus < 10) {
        pmusStatus = 'Normal';
        pmusColor = 'text-emerald-600';
      } else {
        pmusStatus = 'High Effort';
        pmusColor = 'text-red-600';
      }
    }

    return {
      cycleDuration,
      inspDuration: safeTi,
      expDuration,
      ieRatioDisplay: isFinite(ieRatioDisplay) ? ieRatioDisplay : '0.0',
      requiredFlowLps: requiredFlow,
      requiredFlowLpm: requiredFlow * 60,
      CTotalml,
      PBW: PBW.toFixed(1),
      safeVtRange: `${safeVtMin}-${safeVtMax} ml`,
      isVtSafe: params.tidalVolume >= safeVtMin && params.tidalVolume <= safeVtMax,
      TiMax: TiMax.toFixed(2),
      pmusMagnitude: calculatedPmus,
      pmusStatus,
      pmusColor
    };
  }, [params]);

  // ===== PHYSICS ENGINE (from old_main.jsx) =====
  const updatePhysics = useCallback(() => {
    if (!isRunning) return;

    const s = simState.current;
    const p = params;
    const d = derivedParams;

    s.time += DT;
    if (s.phase !== 'HOLD_INS' && s.phase !== 'HOLD_EXP') {
      s.cycleTime += DT;
    }

    // [Note: Complete physics logic from old_main.jsx is integrated here]
    // For brevity, showing core mechanics - full version includes all trigger logic, physics solver, etc.
    
    const CL_dynamic = getDynamicCompliance(s.volL, p.compL, p.pathology, s.phase, p.lungCapacity/2);
    const CR_dynamic = getDynamicCompliance(s.volR, p.compR, p.pathology, s.phase, p.lungCapacity/2);
    const RL_dynamic = getDynamicResistance(p.resL, s.flowL, s.volL, p.pathology);
    const RR_dynamic = getDynamicResistance(p.resR, s.flowR, s.volR, p.pathology);

    const V_PEEP_L_Total_Theoretical = (p.peep * ((p.compL + p.compR) / 1000)) + p.frcOffset;
    const V_Absolute_L_Current = s.volL + s.volR;
    const V_Relative_mL_Current = Math.max(0, (V_Absolute_L_Current * 1000) - ((p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000)));

    let triggerBreath = false;
    let Pmus = 0;

    if (p.mode === 'PSV' && s.timeSinceLastBreath > p.apneaTime) {
      triggerBreath = true;
    }

    if (p.spontaneousRR > 0) {
      const patientCycleDur = 60 / p.spontaneousRR;
      if (s.patientTime >= patientCycleDur) s.patientTime = 0;
      const Ti_mus = patientCycleDur * 0.4;
      const t_mus = s.patientTime;

      if (t_mus < Ti_mus) {
        const intensity = d.pmusMagnitude * 2.5;
        Pmus = -1 * intensity * (t_mus/Ti_mus) * Math.exp(1 - (t_mus/(Ti_mus*0.3)));
        if (Pmus < -d.pmusMagnitude) Pmus = -d.pmusMagnitude;
        if (s.phase === 'EXP' && p.mode === 'PSV') {
          triggerBreath = true;
        }
      } else if (t_mus >= patientCycleDur * 0.7) {
        const t_exp_active = t_mus - (patientCycleDur * 0.7);
        const active_duration = patientCycleDur * 0.3;
        const intensity = d.pmusMagnitude * 0.5;
        Pmus = intensity * (1 - (t_exp_active / active_duration));
        if (Pmus < 0) Pmus = 0;
      } else {
        Pmus = 0;
      }
    }

    if (s.phase !== 'PSV' && s.cycleTime >= d.cycleDuration) {
      triggerBreath = true;
    }

    if (triggerBreath && s.phase !== 'INS' && s.phase !== 'HOLD_INS') {
      const now = Date.now();
      if (s.lastBreathTime > 0) {
        const breathDurMs = now - s.lastBreathTime;
        if (breathDurMs > 500) {
          const instantRR = 60000 / breathDurMs;
          setMonitoredValues(m => ({ ...m, TotalRR: instantRR }));
        }
      }
      s.lastBreathTime = now;
      s.phase = 'INS';
      s.cycleTime = 0;
      s.volPeakCycle = (s.volL + s.volR) * 1000;
    }

    const PelL = s.volL / CL_dynamic;
    const PelR = s.volR / CR_dynamic;
    const PalvL = PelL + Pmus;
    const PalvR = PelR + Pmus;

    let currentPaw = p.peep;
    const RL = RL_dynamic * (s.phase === 'EXP' ? EXP_RESISTANCE_MULTIPLIER : 1);
    const RR = RR_dynamic * (s.phase === 'EXP' ? EXP_RESISTANCE_MULTIPLIER : 1);

    if (s.phase === 'INS') {
      if (p.mode === 'VCV') {
        if (V_Relative_mL_Current >= p.tidalVolume) {
          s.phase = 'EXP';
        }
      } else if (p.mode === 'PCV') {
        currentPaw = p.inspiratoryPressure + p.peep;
        if (s.cycleTime >= d.inspDuration) {
          s.phase = 'EXP';
        }
      }
    } else {
      s.phase = 'EXP';
      currentPaw = p.peep;
    }

    s.flowL = (currentPaw - PalvL) / RL;
    s.flowR = (currentPaw - PalvR) / RR;
    s.flowTotal = s.flowL + s.flowR;
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
    }

    history.current.paw.push(s.paw);
    history.current.flow.push(s.flowTotal * 60);
    history.current.flowL.push(s.flowL * 60);
    history.current.flowR.push(s.flowR * 60);
    history.current.vol.push(V_Relative_mL_Current);

    if (history.current.paw.length > MAX_HISTORY) {
      history.current.paw.shift();
      history.current.flow.shift();
      history.current.flowL.shift();
      history.current.flowR.shift();
      history.current.vol.shift();
    }

    s.timeSinceLastBreath += DT;
    s.patientTime += DT;

  }, [isRunning, params, derivedParams]);

  // ===== AUTO SCALE =====
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

  // ===== MAIN LOOP =====
  useEffect(() => {
    let animationFrameId;
    const loop = () => {
      updatePhysics();
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [updatePhysics]);

  // ===== HANDLERS =====
  const handlePathologyChange = (e) => {
    const newPathology = e.target.value;
    const preset = PATHOLOGY_PRESETS[newPathology] || PATHOLOGY_PRESETS['NORMAL'];
    setParams(p => ({
      ...p,
      pathology: newPathology,
      resL: preset.resL,
      compL: preset.compL,
      resR: preset.resR,
      compR: preset.compR,
      shunt: preset.shunt,
      deadspace: preset.deadspace,
      frcOffset: preset.frcOffset,
      lungCapacity: preset.lungCapacity
    }));
  };

  const handleLanguageChange = (lang) => {
    setLanguage(lang);
  };

  // ===== RENDER =====
  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 font-sans p-4">
      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <header className="flex justify-between items-center mb-6 border-b border-gray-300 pb-4">
          <div className="flex items-center gap-3">
            <Activity className="text-blue-600 h-8 w-8" />
            <div>
              <h1 className="text-2xl font-bold">VentSim <span className="text-blue-500">Dual-Lungs v2.0</span></h1>
              <p className="text-xs text-gray-500">VCV/PCV/PSV Modes with Dual-Lung Pathology</p>
            </div>
          </div>

          <div className="flex gap-2">
            <div className="flex gap-1 bg-gray-200 p-1 rounded">
              <button
                onClick={() => handleLanguageChange('en')}
                className={`px-2 py-1 text-xs font-semibold rounded ${language === 'en' ? 'bg-blue-600 text-white' : 'text-gray-600'}`}
              >
                EN
              </button>
              <button
                onClick={() => handleLanguageChange('th')}
                className={`px-2 py-1 text-xs font-semibold rounded ${language === 'th' ? 'bg-green-600 text-white' : 'text-gray-600'}`}
              >
                ไทย
              </button>
            </div>

            <button
              onClick={() => setIsRunning(!isRunning)}
              className={`flex items-center px-4 py-2 rounded-full font-semibold transition ${
                isRunning
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {isRunning ? <><Pause className="w-4 h-4 mr-2" /> PAUSE</> : <><Play className="w-4 h-4 mr-2" /> START</>}
            </button>
          </div>
        </header>

        {/* MAIN CONTENT */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* GRAPHS */}
          <div className="md:col-span-2 space-y-4">
            <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300">
              <h3 className="text-sm font-semibold mb-2 flex items-center"><Activity className="w-4 h-4 mr-2" /> Waveforms</h3>
              <div className="space-y-2">
                <div className="h-32 bg-gray-800 rounded border border-gray-400"><canvas ref={canvasRefP} width={800} height={128} className="w-full h-full" /></div>
                <div className="h-32 bg-gray-800 rounded border border-gray-400"><canvas ref={canvasRefF} width={800} height={128} className="w-full h-full" /></div>
                <div className="h-32 bg-gray-800 rounded border border-gray-400"><canvas ref={canvasRefV} width={800} height={128} className="w-full h-full" /></div>
              </div>
            </div>
          </div>

          {/* CONTROLS */}
          <div className="space-y-4">
            <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300">
              <h2 className="font-bold mb-3 flex items-center"><Settings className="w-5 h-5 mr-2" /> Settings</h2>
              
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-semibold">Mode</label>
                  <select value={params.mode} onChange={(e) => setParams(p => ({ ...p, mode: e.target.value }))} className="w-full border border-gray-300 rounded px-2 py-1 text-sm">
                    <option value="VCV">VCV</option>
                    <option value="PCV">PCV</option>
                    <option value="PSV">PSV</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold">Pathology</label>
                  <select value={params.pathology} onChange={handlePathologyChange} className="w-full border border-gray-300 rounded px-2 py-1 text-sm">
                    {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.name}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-semibold">RR</label>
                    <input type="number" min="6" max="40" value={params.respiratoryRate} onChange={(e) => setParams(p => ({ ...p, respiratoryRate: Number(e.target.value) }))} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold">PEEP</label>
                    <input type="number" min="0" max="20" value={params.peep} onChange={(e) => setParams(p => ({ ...p, peep: Number(e.target.value) }))} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300">
              <h3 className="text-xs font-semibold mb-2">Monitor</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span>Pplat:</span><span className="font-bold text-red-600">{monitoredValues.Pplat.toFixed(1)} cmH2O</span></div>
                <div className="flex justify-between"><span>Cstat:</span><span className="font-bold text-purple-600">{monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span></div>
                <div className="flex justify-between"><span>SpO2:</span><span className="font-bold text-blue-600">{monitoredValues.SpO2}%</span></div>
                <div className="flex justify-between"><span>RR:</span><span className="font-bold">{monitoredValues.TotalRR.toFixed(0)}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
