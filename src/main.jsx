/**
 * UPDATED main.jsx - Refactored Structure
 * 
 * CHANGES:
 * 1. Import physics functions from separate modules
 * 2. Add state for study mode
 * 3. Add language support (en/th)
 * 4. Responsive layout with tabs on mobile
 * 5. Integrated InfoTooltip components
 * 
 * FILE STRUCTURE AFTER REFACTOR:
 * src/
 *   physics/
 *     - resistance.js (CREATED)
 *     - compliance.js (CREATED)
 *     - gasExchange.js (CREATED)
 *     - pathologyPresets.js (CREATED)
 *   content/
 *     - tooltips.js (CREATED)
 *   components/
 *     - InfoTooltip.jsx (CREATED)
 *     - GraphOnlyView.jsx (CREATED)
 *     - Layout/ (TO CREATE)
 *       - AppLayout.jsx
 *       - Header.jsx
 *       - MainGrid.jsx
 *     - Panels/ (TO CREATE)
 *       - WaveformsPanel.jsx
 *       - MonitoringPanel.jsx
 *       - ControlsPanel.jsx
 *   main.jsx (THIS FILE - REFACTORED)
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { 
  Play, Pause, Activity, Settings, HeartPulse, AlertCircle, 
  TrendingUp, Filter, BarChart2, User, Clock, PauseCircle, 
  StopCircle, X
} from 'lucide-react';

// ===== PHYSICS IMPORTS (NEWLY SEPARATED) =====
import { getDynamicResistance, getDualLungResistance } from './physics/resistance';
import { getDynamicCompliance, getDualLungCompliance } from './physics/compliance';
import { calculateOxygenation } from './physics/gasExchange';
import { PATHOLOGY_PRESETS, getPathologyPreset } from './physics/pathologyPresets';

// ===== CONTENT & COMPONENT IMPORTS (NEWLY CREATED) =====
import { getTooltip, getCategoryTooltips } from './content/tooltips';
import InfoTooltip from './components/InfoTooltip';
import GraphOnlyView from './components/GraphOnlyView';

// ===== PHYSICS CONSTANTS (MOVED TO SEPARATE FILE IN FUTURE) =====
const DT = 0.016;           // Time step (seconds) ~60fps
const MAX_HISTORY = 1500;   // Points to keep (~24s at 60fps)
const PEAK_WINDOW = 300;    // Window for peak calculation (5 seconds)
const PCV_RISE_SMOOTHING = 0.08;
const EXP_RESISTANCE_MULTIPLIER = 1.5;
const CIRCUIT_COMPLIANCE = 2.5;

// ===== LANGUAGE STATE (NEW) =====
const [language, setLanguage] = useState('en'); // or 'th'

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

// ===== MAIN APP COMPONENT =====
export default function App() {
  // ===== STATE: General UI =====
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
    
    // Patient mechanics
    pathology: 'NORMAL',
    resL: 15, compL: 50,
    resR: 15, compR: 50,
    shunt: 0.05,
    deadspace: 0.15,
    frcOffset: 0.0,
    lungCapacity: 3.0,
    
    // Patient data
    gender: 'M',
    heightCm: 170,
    actualWeightKg: 70,
    weightMode: 'PBW',
    spontaneousRR: 0,
    pmusSyncMode: 'AUTOSYNC'
  });

  const [isRunning, setIsRunning] = useState(false);
  const [isRecruiting, setIsRecruiting] = useState(false);
  const [backupActive, setBackupActive] = useState(false);
  
  // ===== STATE: NEW - Study Mode & Language =====
  const [isStudyMode, setIsStudyMode] = useState(false);
  const [language, setLanguage] = useState('en'); // 'en' or 'th'
  const [activeMobileTab, setActiveMobileTab] = useState('waveforms'); // Mobile tab navigation
  
  // ===== STATE: Hold Maneuvers =====
  const [inspHoldRequest, setInspHoldRequest] = useState(false);
  const [expHoldRequest, setExpHoldRequest] = useState(false);
  const [holdStatus, setHoldStatus] = useState(null);

  // ===== STATE: Scales & Display =====
  const [scales, setScales] = useState({ pMax: 40, fMax: 60, vMax: 600 });
  const scalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });
  const displayedScalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });

  // ===== STATE: Monitored Values =====
  const [monitoredValues, setMonitoredValues] = useState({
    Pplat: 0, Pmean: 0, Cstat: 0, AutoPEEP: 0,
    TotalRR: 0, MV: 0, VtExp: 0, VPeakAbs: 0, VPeakRel: 0,
    SpO2: 98, EtCO2: 35, PaO2: 100, PaCO2: 40
  });

  // ===== REFS: Simulation State =====
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

  // ===== REFS: History (for graph rendering) =====
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

  // ===== REFS: Canvas =====
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

  // ===== PHYSICS ENGINE & SIMULATION (SAME AS ORIGINAL BUT USING IMPORTED FUNCTIONS) =====
  const updatePhysics = useCallback(() => {
    if (!isRunning) return;

    const s = simState.current;
    const p = params;
    const d = derivedParams;

    s.time += DT;
    if (s.phase !== 'HOLDINS' && s.phase !== 'HOLDEXP') {
      s.cycleTime += DT;
    }

    // ===== TRIGGER LOGIC & PHASE MANAGEMENT =====
    let triggerBreath = false;
    let Pmus = 0;
    let isApneaTrigger = false;

    // ... [KEEP ALL EXISTING TRIGGER LOGIC FROM ORIGINAL main.jsx] ...
    // (Implementation details remain the same - this is just showing the structure)

    // ===== USE IMPORTED PHYSICS FUNCTIONS (KEY CHANGE) =====
    const CLdynamic = getDynamicCompliance(s.volL, p.compL, p.pathology, s.phase, p.lungCapacity);
    const CRdynamic = getDynamicCompliance(s.volR, p.compR, p.pathology, s.phase, p.lungCapacity);

    const { RL: RLdynamic, RR: RRdynamic } = getDualLungResistance(
      p.resL, p.resR, s.flowL, s.flowR, s.volL, s.volR, p.pathology
    );

    // ===== GAS EXCHANGE CALCULATION (USING IMPORTED FUNCTION) =====
    const {
      SpO2: estimatedSpO2,
      EtCO2: estimatedEtCO2,
      effectiveShunt
    } = calculateOxygenation(
      (s.pawSum / Math.max(1, s.pawCount)) || p.peep,
      40,
      p.fiO2,
      p.shunt,
      p.deadspace,
      monitoredValues.TotalRR,
      monitoredValues.VtExp / 1000
    );

    // ... [KEEP REST OF PHYSICS CALCULATION] ...
    
  }, [isRunning, params, derivedParams, monitoredValues]);

  // ===== AUTO SCALE LOGIC =====
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

  // ===== DRAWING FUNCTIONS (UNCHANGED) =====
  // [KEEP ALL EXISTING DRAWING CODE FROM ORIGINAL]

  // ===== MAIN LOOP =====
  useEffect(() => {
    let animationFrameId;
    const loop = () => {
      updatePhysics();
      // drawWaveforms();
      // drawLoops();
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

  // ===== RENDER: Main JSX with Responsive Layout =====
  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 font-sans p-2 sm:p-4 md:p-8">
      {/* Study Mode Overlay */}
      {isStudyMode && (
        <GraphOnlyView
          isActive={isStudyMode}
          onClose={() => setIsStudyMode(false)}
          canvasRefs={{
            P: canvasRefP,
            F: canvasRefF,
            V: canvasRefV,
            PV: canvasRefPV,
            FV: canvasRefFV
          }}
          scales={scales}
          monitoredValues={monitoredValues}
          params={params}
        />
      )}

      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 border-b border-gray-300 pb-4 gap-4">
          <div className="flex items-center gap-3">
            <Activity className="text-blue-600 h-8 w-8" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                VentSim <span className="text-blue-500">Dual-Lungs</span>
              </h1>
              <p className="text-xs text-gray-500">
                VC, PC, PS Mode Simulator with Dual-Lung Pathology
              </p>
            </div>
          </div>

          {/* Header Actions */}
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            {/* Language Toggle */}
            <div className="flex gap-1 bg-gray-200 p-1 rounded">
              <button
                onClick={() => handleLanguageChange('en')}
                className={`px-2 py-1 text-xs font-semibold rounded ${
                  language === 'en' ? 'bg-blue-600 text-white' : 'text-gray-600'
                }`}
              >
                EN
              </button>
              <button
                onClick={() => handleLanguageChange('th')}
                className={`px-2 py-1 text-xs font-semibold rounded ${
                  language === 'th' ? 'bg-green-600 text-white' : 'text-gray-600'
                }`}
              >
                ไทย
              </button>
            </div>

            {/* Start/Stop Button */}
            <button
              onClick={() => setIsRunning(!isRunning)}
              className={`flex items-center px-4 py-2 rounded-full font-semibold transition ${
                isRunning
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {isRunning ? (
                <>
                  <Pause className="w-4 h-4 mr-2" />
                  PAUSE
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  START
                </>
              )}
            </button>

            {/* Study Mode Button */}
            <button
              onClick={() => setIsStudyMode(true)}
              className="flex items-center px-4 py-2 rounded bg-green-600 hover:bg-green-700 text-white font-semibold text-sm"
              title="Fullscreen graph view for teaching"
            >
              📊 Study
            </button>

            {/* Settings Button */}
            <button className="flex items-center justify-center w-10 h-10 rounded bg-gray-200 hover:bg-gray-300">
              <Settings className="w-5 h-5 text-gray-600" />
            </button>
          </div>
        </header>

        {/* DESKTOP LAYOUT (hidden on mobile) */}
        <div className="hidden md:block">
          <div className="grid grid-cols-12 gap-6">
            {/* Waveforms & Monitoring */}
            <div className="col-span-8 space-y-6">
              {/* Waveforms */}
              <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300">
                <h3 className="text-gray-500 text-sm font-semibold mb-2 flex items-center">
                  <Activity className="w-4 h-4 mr-2" />
                  Real-time Waveforms
                </h3>
                <div className="space-y-4">
                  {/* Pressure Canvas */}
                  <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <span className="absolute top-2 right-2 text-yellow-500 text-xs font-bold z-10">
                      PEAK {scales.pMax.toFixed(0)} cmH2O
                    </span>
                    <canvas ref={canvasRefP} width={800} height={128} className="w-full h-full" />
                  </div>

                  {/* Flow Canvas */}
                  <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <span className="absolute top-2 right-2 text-emerald-400 text-xs font-bold z-10">
                      SCALE {scales.fMax.toFixed(0)} L/min
                    </span>
                    <canvas ref={canvasRefF} width={800} height={128} className="w-full h-full" />
                  </div>

                  {/* Volume Canvas */}
                  <div className="relative h-32 bg-gray-800 rounded border border-gray-400 overflow-hidden">
                    <div className="absolute top-1 right-2 text-blue-500 text-xs font-bold z-10 text-right leading-tight">
                      <span className="block">
                        Max Rel {monitoredValues.VPeakRel.toFixed(0)} ml
                      </span>
                      <span className="text-emerald-400 block">
                        Vt {monitoredValues.VtExp.toFixed(0)} ml
                      </span>
                      <span className="text-indigo-400 block">
                        Max Abs {monitoredValues.VPeakAbs.toFixed(0)} ml
                      </span>
                    </div>
                    <canvas ref={canvasRefV} width={800} height={128} className="w-full h-full" />
                  </div>
                </div>
              </div>

              {/* Loops */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* PV Loop */}
                <div className="relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                  <canvas ref={canvasRefPV} width={300} height={200} className="w-full h-auto bg-gray-800" />
                </div>

                {/* FV Loop */}
                <div className="relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                  <canvas ref={canvasRefFV} width={300} height={200} className="w-full h-auto bg-gray-800" />
                </div>
              </div>
            </div>

            {/* Controls Panel (Right Column) */}
            <div className="col-span-4 space-y-4">
              {/* Mode Selector */}
              <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300">
                <div className="flex items-center gap-2 mb-3">
                  <Settings className="w-5 h-5 text-purple-600" />
                  <h2 className="font-bold">Ventilator Settings</h2>
                </div>

                <div className="space-y-3">
                  {/* Mode Selection */}
                  <div>
                    <label className="text-xs font-semibold text-gray-700 block mb-1">
                      Mode <InfoTooltip title="Ventilation Mode" description={getTooltip('modes', language)?.PCV?.description} position="right" />
                    </label>
                    <select
                      value={params.mode}
                      onChange={(e) => setParams(p => ({ ...p, mode: e.target.value }))}
                      className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm"
                    >
                      <option value="VCV">Volume Control (VCV)</option>
                      <option value="PCV">Pressure Control (PCV)</option>
                      <option value="PSV">Pressure Support (PSV)</option>
                    </select>
                  </div>

                  {/* Pathology Selection */}
                  <div>
                    <label className="text-xs font-semibold text-gray-700 block mb-1">
                      Pathology <InfoTooltip title="Patient Condition" description="Select lung pathology" position="right" />
                    </label>
                    <select
                      value={params.pathology}
                      onChange={handlePathologyChange}
                      className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm"
                    >
                      {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                        <option key={key} value={key}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    
                    {/* Clinical Tips for Pathology */}
                    {params.pathology !== 'CUSTOM' && (
                      <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
                        <strong>💡 Tip:</strong> {PATHOLOGY_PRESETS[params.pathology]?.clinicalTips?.[0]}
                      </div>
                    )}
                  </div>

                  {/* Basic Parameters */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-semibold text-gray-700">RR (bpm)</label>
                      <input
                        type="number"
                        min="6"
                        max="40"
                        value={params.respiratoryRate}
                        onChange={(e) =>
                          setParams(p => ({ ...p, respiratoryRate: Number(e.target.value) }))
                        }
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-gray-700">
                        PEEP <InfoTooltip title="PEEP" description={getTooltip('PEEP', language)?.description} />
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="20"
                        value={params.peep}
                        onChange={(e) =>
                          setParams(p => ({ ...p, peep: Number(e.target.value) }))
                        }
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-semibold text-gray-700">
                        Ti (sec)
                      </label>
                      <input
                        type="number"
                        min="0.3"
                        max="2.0"
                        step="0.1"
                        value={params.inspiratoryTime}
                        onChange={(e) =>
                          setParams(p => ({ ...p, inspiratoryTime: Number(e.target.value) }))
                        }
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-gray-700">FiO2</label>
                      <input
                        type="number"
                        min="0.21"
                        max="1.0"
                        step="0.05"
                        value={params.fiO2}
                        onChange={(e) =>
                          setParams(p => ({ ...p, fiO2: Math.max(0.21, Math.min(1.0, Number(e.target.value))) }))
                        }
                        className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Monitored Values Panel */}
              <div className="bg-white rounded-xl p-4 shadow-lg border border-gray-300">
                <div className="flex items-center gap-2 mb-3">
                  <BarChart2 className="w-4 h-4 text-purple-600" />
                  <h3 className="text-xs font-semibold">Monitored Values</h3>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between items-center text-sm pb-1 border-b border-gray-100">
                    <span className="text-gray-600">
                      P-Plateau <InfoTooltip title="Pplat" description={getTooltip('Pplat', language)?.description} />
                    </span>
                    <span className="font-bold text-red-600">{monitoredValues.Pplat.toFixed(1)} cmH2O</span>
                  </div>

                  <div className="flex justify-between items-center text-sm pb-1 border-b border-gray-100">
                    <span className="text-gray-600">
                      Cstat <InfoTooltip title="Cstat" description={getTooltip('Cstat', language)?.description} />
                    </span>
                    <span className="font-bold text-purple-600">{monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span>
                  </div>

                  <div className="flex justify-between items-center text-sm pb-1 border-b border-gray-100">
                    <span className="text-gray-600">
                      AutoPEEP <InfoTooltip title="AutoPEEP" description={getTooltip('AutoPEEP', language)?.description} />
                    </span>
                    <span className="font-bold text-yellow-600">{monitoredValues.AutoPEEP.toFixed(1)} cmH2O</span>
                  </div>

                  <div className="flex justify-between items-center text-sm pb-1 border-b border-gray-100">
                    <span className="text-gray-600">SpO2</span>
                    <span className={`font-bold ${monitoredValues.SpO2 < 90 ? 'text-red-600 animate-pulse' : 'text-blue-600'}`}>
                      {monitoredValues.SpO2}%
                    </span>
                  </div>

                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-600">EtCO2</span>
                    <span className={`font-bold ${monitoredValues.EtCO2 > 45 ? 'text-red-600' : 'text-green-600'}`}>
                      {monitoredValues.EtCO2} mmHg
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* MOBILE LAYOUT (shown only on mobile) */}
        <div className="md:hidden">
          {/* Tab Navigation */}
          <div className="flex gap-2 mb-4 border-b border-gray-300 overflow-x-auto">
            {[
              { id: 'waveforms', label: '📈 Waves', icon: TrendingUp },
              { id: 'loops', label: '🔄 Loops', icon: BarChart2 },
              { id: 'monitors', label: '📊 Monitors', icon: Activity },
              { id: 'settings', label: '⚙️ Settings', icon: Settings }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveMobileTab(tab.id)}
                className={`px-4 py-2 font-semibold text-sm whitespace-nowrap border-b-2 transition ${
                  activeMobileTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="space-y-4">
            {/* Waveforms Tab */}
            {activeMobileTab === 'waveforms' && (
              <div className="bg-white rounded-lg p-3 shadow space-y-3">
                <div className="h-24 bg-gray-800 rounded border border-gray-400">
                  <canvas ref={canvasRefP} width={600} height={96} className="w-full h-full" />
                </div>
                <div className="h-24 bg-gray-800 rounded border border-gray-400">
                  <canvas ref={canvasRefF} width={600} height={96} className="w-full h-full" />
                </div>
                <div className="h-24 bg-gray-800 rounded border border-gray-400">
                  <canvas ref={canvasRefV} width={600} height={96} className="w-full h-full" />
                </div>
              </div>
            )}

            {/* Loops Tab */}
            {activeMobileTab === 'loops' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-gray-800 rounded border border-gray-400 p-2">
                  <canvas ref={canvasRefPV} width={250} height={200} className="w-full" />
                </div>
                <div className="bg-gray-800 rounded border border-gray-400 p-2">
                  <canvas ref={canvasRefFV} width={250} height={200} className="w-full" />
                </div>
              </div>
            )}

            {/* Monitors Tab */}
            {activeMobileTab === 'monitors' && (
              <div className="bg-white rounded-lg p-3 shadow space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-red-50 p-2 rounded border border-red-200">
                    <div className="text-xs text-gray-600">Pplat</div>
                    <div className="text-lg font-bold text-red-600">{monitoredValues.Pplat.toFixed(1)}</div>
                  </div>
                  <div className="bg-purple-50 p-2 rounded border border-purple-200">
                    <div className="text-xs text-gray-600">Cstat</div>
                    <div className="text-lg font-bold text-purple-600">{monitoredValues.Cstat.toFixed(1)}</div>
                  </div>
                  <div className="bg-yellow-50 p-2 rounded border border-yellow-200">
                    <div className="text-xs text-gray-600">AutoPEEP</div>
                    <div className="text-lg font-bold text-yellow-600">{monitoredValues.AutoPEEP.toFixed(1)}</div>
                  </div>
                  <div className="bg-blue-50 p-2 rounded border border-blue-200">
                    <div className="text-xs text-gray-600">SpO2</div>
                    <div className="text-lg font-bold text-blue-600">{monitoredValues.SpO2}%</div>
                  </div>
                </div>
              </div>
            )}

            {/* Settings Tab */}
            {activeMobileTab === 'settings' && (
              <div className="bg-white rounded-lg p-3 shadow space-y-3">
                <div>
                  <label className="text-xs font-semibold">Mode</label>
                  <select
                    value={params.mode}
                    onChange={(e) => setParams(p => ({ ...p, mode: e.target.value }))}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                  >
                    <option>VCV</option>
                    <option>PCV</option>
                    <option>PSV</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold">Pathology</label>
                  <select
                    value={params.pathology}
                    onChange={handlePathologyChange}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                  >
                    {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>
                        {preset.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <input type="number" placeholder="RR" value={params.respiratoryRate} className="border border-gray-300 rounded px-2 py-1 text-sm" />
                  <input type="number" placeholder="PEEP" value={params.peep} className="border border-gray-300 rounded px-2 py-1 text-sm" />
                </div>
              </div>
            )}
          </div>

          {/* Sticky Bottom Bar (Mobile) */}
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-300 p-3 flex gap-2">
            <button
              onClick={() => setIsRunning(!isRunning)}
              className={`flex-1 py-2 rounded font-semibold text-sm ${
                isRunning
                  ? 'bg-red-500 text-white'
                  : 'bg-blue-600 text-white'
              }`}
            >
              {isRunning ? 'PAUSE' : 'START'}
            </button>
            <button
              onClick={() => setIsStudyMode(true)}
              className="flex-1 py-2 rounded bg-green-600 text-white font-semibold text-sm"
            >
              Study Mode
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Mount React app
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
