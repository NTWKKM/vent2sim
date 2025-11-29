import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Play, Pause, Activity, Settings, BarChart2, AlertCircle, TrendingUp, Zap } from 'lucide-react';
import { getDynamicCompliance } from './physics/compliance';
import { getDynamicResistance } from './physics/resistance';
import { PATHOLOGY_PRESETS } from './physics/pathologyPresets';

const DT = 0.016;
const MAX_HISTORY = 1500;
const PEAK_WINDOW = 300;
const PCV_RISE_SMOOTHING = 0.08;
const EXP_RESISTANCE_MULTIPLIER = 1.2;
const CIRCUIT_COMPLIANCE = 2.5;

const lerp = (start, end, factor) => start + (end - start) * factor;

const calculatePBW = (gender, heightCm) => {
  const heightInches = heightCm * 0.393701;
  if (gender === 'M') {
    return 50 + 2.3 * (heightInches - 60);
  } else {
    return 45.5 + 2.3 * (heightInches - 60);
  }
};

function App() {
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
    gender: 'M', heightCm: 170, actualWeightKg: 70,
    spontaneousRR: 0,
    pmusSyncMode: 'AUTO_SYNC'
  });

  const [isRunning, setIsRunning] = useState(false);
  const [isRecruiting, setIsRecruiting] = useState(false);
  const [inspHoldRequest, setInspHoldRequest] = useState(false);
  const [expHoldRequest, setExpHoldRequest] = useState(false);
  const [holdStatus, setHoldStatus] = useState(null);
  const [backupActive, setBackupActive] = useState(false);

  const [scales, setScales] = useState({ pMax: 40, fMax: 60, vMax: 600 });
  const scalesRef = useRef(scales);
  const displayedScalesRef = useRef(scales);

  const [monitoredValues, setMonitoredValues] = useState({
    Pplat: 0, Pmean: 0, Cstat: 0, AutoPEEP: 0,
    TotalRR: 0, MV: 0, VtExp: 0, VPeakAbs: 0, VPeakRel: 0,
    SpO2: 98, EtCO2: 35
  });

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

  const derivedParams = useMemo(() => {
    const cycleDuration = 60 / params.respiratoryRate;
    const inspDuration = params.inspiratoryTime;
    const TiMax = cycleDuration * 0.95;
    const safeTi = Math.min(inspDuration, TiMax - 0.05);
    const expDuration = cycleDuration - safeTi;

    const VtL = params.tidalVolume / 1000;
    let requiredFlow = params.flowPattern === 'SQUARE' ? VtL / safeTi : (2 * VtL) / safeTi;

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
      ieRatio: (expDuration / safeTi).toFixed(1),
      requiredFlowLps: requiredFlow,
      requiredFlowLpm: requiredFlow * 60,
      C_Total_ml,
      PBW: PBW.toFixed(1),
      safeVtRange: `${safeVtMin}-${safeVtMax} ml`,
      isVtSafe: (params.tidalVolume >= safeVtMin && params.tidalVolume <= safeVtMax),
      pmusMagnitude: calculatedPmus,
      pmusStatus,
      pmusColor
    };
  }, [params]);

  const resetSimState = useCallback(() => {
    const p = params;
    const C_L_Lps = p.compL / 1000;
    const C_R_Lps = p.compR / 1000;
    const V_L_PEEP = (p.peep * C_L_Lps) + (p.frcOffset / 2);
    const V_R_PEEP = (p.peep * C_R_Lps) + (p.frcOffset / 2);
    const initialVolAbs = (V_L_PEEP + V_R_PEEP) * 1000;

    simState.current = {
      time: 0, cycleTime: 0, patientTime: 0, phase: 'EXP',
      volL: V_L_PEEP, volR: V_R_PEEP,
      paw: p.peep, valveFlow: 0, valvePressure: p.peep,
      volCircuit: (p.peep * CIRCUIT_COMPLIANCE) / 1000,
      flowTotal: 0, flowL: 0, flowR: 0,
      recruitmentTimer: 0, recruitmentStep: 0,
      pawSum: 0, pawCount: 0, pPlatTemp: p.peep, autoPeepTemp: p.peep,
      volPeakCycle: initialVolAbs, currentPeakFlow: 0,
      lastBreathTime: Date.now(), timeSinceLastBreath: 0,
      isBackupCycle: false, holdTimer: 0, pPlatCaptured: false
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
      TotalRR: 0, MV: 0, VtExp: 0, VPeakAbs: initialVolAbs, VPeakRel: 0,
      SpO2: 98, EtCO2: 35
    });
    setBackupActive(false);
    setInspHoldRequest(false);
    setExpHoldRequest(false);
    setHoldStatus(null);
  }, [params.compL, params.compR, params.peep, params.frcOffset, params.inspiratoryPressure, params.tidalVolume]);

  useEffect(() => {
    resetSimState();
  }, [resetSimState]);

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
  
  // Handler for Shunt/Dead Space (as floating point numbers)
  const handleGasExchangeChange = (key, value) => {
    const numValue = Math.max(0, Math.min(1.0, Number(value))); // Clamp between 0-1 (0-100%)
    setParams(p => ({ ...p, [key]: numValue }));
  };
  
  // Handler for FiO2 (as floating point number between 0.21 and 1.0)
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
  
  // --- New Derived Monitor Values for Loops ---
  const drivingPressure = monitoredValues.Pplat - params.peep;
  // Vt Difference: Target Vt - Exhaled Vt (Proxy for Volume Trapping in VCV)
  const vtDifference = params.tidalVolume - monitoredValues.VtExp; 


  return (
    <div className="min-h-screen bg-gray-100 text-gray-900 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        
        {/* Header */}
        <header className="flex justify-between items-center mb-8 border-b border-gray-300 pb-4">
          <div className="flex items-center space-x-3">
            <Activity className="text-blue-600 h-8 w-8" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">VentSim <span className="text-blue-500">Dual-Lung</span></h1>
              <p className="text-xs text-gray-500">VC, PC, PS Mode Simulator with Dual-Lung Pathology</p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
              {/* HOLD STATUS INDICATORS */}
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
                    {/* [MODIFIED] Added SpO2 and EtCO2 */}
                    <div className="flex justify-between items-center text-sm border-b border-gray-100 pb-1">
                        <span className="text-gray-600">SpO2 (Est.)</span>
                        <span className={`font-bold text-lg text-right ${monitoredValues.SpO2 < 90 ? 'text-red-600 animate-pulse' : 'text-blue-500'}`}>{monitoredValues.SpO2} <span className="text-sm">%</span></span>
                    </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-600">EtCO2 (Est.)</span>
                        <span className={`font-bold text-lg text-right ${monitoredValues.EtCO2 > 45 ? 'text-red-600' : 'text-emerald-500'}`}>{monitoredValues.EtCO2} <span className="text-sm">mmHg</span></span>
                    </div>
                </div>
              </div>

              {/* P/V Loop (Card 2) - UPDATED MONITOR SIZE and BG */}
              <div className="md:col-span-1 relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                  <canvas ref={canvasRefPV} width={300} height={200} className="w-full h-auto bg-gray-800" />
                  {/* NEW Monitor Area for P/V (Changed bg-gray-900/50 to bg-gray-900) */}
                  <div className="absolute bottom-1 left-2 right-2 rounded-b bg-gray-900 p-1 text-xs text-white">
                      <div className="flex justify-between font-bold">
                          <span className="text-yellow-500">DRIVING P:</span>
                          {/* Adjusted text-xl to text-2xl and text-sm to text-base */}
                          <span className="text-2xl leading-none text-red-500">{drivingPressure.toFixed(1)} <span className="text-base">cmH2O</span></span>
                      </div>
                      {/* Adjusted text-[10px] to text-xs */}
                      <div className="flex justify-between pt-1 text-xs">
                          <span>Plat: {monitoredValues.Pplat.toFixed(1)}</span>
                          <span className="text-purple-400">Cstat: {monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span>
                      </div>
                  </div>
              </div>
              
              {/* F/V Loop (Card 3) - UPDATED MONITOR SIZE and BG */}
              <div className="md:col-span-1 relative rounded-xl border border-gray-400 bg-gray-800 p-2 shadow-lg">
                  <canvas ref={canvasRefFV} width={300} height={200} className="w-full h-auto bg-gray-800" />
                  {/* NEW Monitor Area for F/V (Changed bg-gray-900/50 to bg-gray-900) */}
                  <div className="absolute bottom-1 left-2 right-2 rounded-b bg-gray-900 p-1 text-xs text-white">
                      <div className="flex justify-between font-bold">
                          <span className="text-emerald-400">PEEPi:</span>
                          {/* Adjusted text-xl to text-2xl and text-sm to text-base */}
                          <span className="text-2xl leading-none text-yellow-500">{monitoredValues.AutoPEEP.toFixed(1)} <span className="text-base">cmH2O</span></span>
                      </div>
                       {/* Adjusted text-[10px] to text-xs */}
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
                     {/* [NEW UI] Sync Mode Selector */}
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
                            <p className="text-[10px] text-gray-500 mt-1">"Fighting" จะแสดง Patient Asynchrony ชัดเจน (เช่น Reverse Triggering, Flow Fighting)</p>
                        </div>
                    )}
                 </div>

                 {/* Pathology Preset Selector */}
                 <div className="flex items-center space-x-4 bg-gray-100 p-3 rounded border border-gray-300">
                     <Filter className="w-5 h-5 text-purple-500 flex-shrink-0" />
                     <div className="flex-grow">
                        <label htmlFor="pathologySelect" className="text-sm font-semibold block mb-1">Select Pathology Preset</label>
                        {/* NOTE: handlePathologyChange is used here */}
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
                 
                 {/* [NEW UI STEP 4] Shunt & Deadspace Sliders */}
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
                
                {/* [NEW UI] FiO2 Slider */}
                <div>
                  <div className="flex justify-between text-sm mb-1"><span>FiO2</span><span className="font-mono text-blue-600">{(params.fiO2 * 100).toFixed(0)} %</span></div>
                  <input type="range" min="0.21" max="1.0" step="0.01" value={params.fiO2} onChange={handleFiO2Change} className="w-full accent-blue-600"/>
                  <p className="text-xs text-gray-500 mt-1">Fraction of Inspired Oxygen (21% - 100%)</p>
                </div>


              </div>
            </div>

            {/* Special Maneuvers (UPDATED) */}
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
            
            {/* Footer Added Here */}
            <footer className="mt-8 pt-6 border-t border-gray-300 text-center text-xs text-gray-500">
                &copy; 2025 NTWKKM &nbsp;|&nbsp; Powered by GitHub
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
