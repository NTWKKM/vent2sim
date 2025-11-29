import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Play, Pause, Activity, Settings, BarChart2, AlertCircle } from 'lucide-react';
import { getDynamicCompliance } from './physics/compliance';
import { getDynamicResistance } from './physics/resistance';
import { PATHOLOGY_PRESETS } from './physics/pathologyPresets';

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

// ===== MAIN APP =====
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
    spontaneousRR: 0
  });

  const [isRunning, setIsRunning] = useState(false);
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

    return {
      cycleDuration,
      inspDuration: safeTi,
      expDuration,
      ieRatio: (expDuration / safeTi).toFixed(1),
      requiredFlowLps: requiredFlow,
      requiredFlowLpm: requiredFlow * 60
    };
  }, [params]);

  const updatePhysics = useCallback(() => {
    if (!isRunning) return;

    const s = simState.current;
    const p = params;
    const d = derivedParams;

    s.time += DT;
    if (s.phase !== 'HOLD_INS' && s.phase !== 'HOLD_EXP') {
      s.cycleTime += DT;
    }

    const CL_dynamic = getDynamicCompliance(s.volL, p.compL, p.pathology, s.phase, p.lungCapacity);
    const CR_dynamic = getDynamicCompliance(s.volR, p.compR, p.pathology, s.phase, p.lungCapacity);
    const RL_dynamic = getDynamicResistance(p.resL, s.flowL, s.volL, p.pathology);
    const RR_dynamic = getDynamicResistance(p.resR, s.flowR, s.volR, p.pathology);

    const V_Absolute_L_Current = s.volL + s.volR;
    const V_Relative_mL_Current = Math.max(0, (V_Absolute_L_Current * 1000) - ((p.peep * (p.compL + p.compR)) + (p.frcOffset * 1000)));

    let triggerBreath = false;

    if (s.cycleTime >= d.cycleDuration) {
      triggerBreath = true;
    }

    if (triggerBreath && s.phase !== 'INS') {
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
    const PalvL = PelL;
    const PalvR = PelR;

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

    const drawLine = (ctx, data, color, yMax, midY = false) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      
      data.forEach((val, i) => {
        const x = 40 + ((i / MAX_HISTORY) * (w - 50));
        let y;
        if (midY) {
          y = h / 2 - (val / yMax) * (h / 2 - 20);
        } else {
          y = h - 20 - (val / yMax) * (h - 40);
        }
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    // Pressure
    ctxP.fillStyle = '#f59e0b';
    ctxP.font = '12px sans-serif';
    ctxP.fillText('Paw (cmH2O)', 50, 20);
    ctxP.fillText('PEAK: ' + Math.max(...history.current.paw).toFixed(1), w - 120, 20);
    drawLine(ctxP, history.current.paw, '#f59e0b', scalesRef.current.pMax);

    // Flow
    ctxF.fillStyle = '#10b981';
    ctxF.font = '12px sans-serif';
    ctxF.fillText('Flow (L/min)', 50, 20);
    ctxF.fillText('SCALE: ' + scalesRef.current.fMax.toFixed(1) + ' L/min', w - 150, 20);
    drawLine(ctxF, history.current.flow, '#10b981', scalesRef.current.fMax, true);

    // Volume
    ctxV.fillStyle = '#3b82f6';
    ctxV.font = '12px sans-serif';
    ctxV.fillText('Volume (ml)', 50, 20);
    ctxV.fillText('Max (Rel): ' + Math.max(...history.current.vol).toFixed(0), w - 150, 20);
    drawLine(ctxV, history.current.vol, '#3b82f6', scalesRef.current.vMax);

  }, [updateAutoScales]);

  useEffect(() => {
    let animationFrameId;
    const loop = () => {
      updatePhysics();
      drawWaveforms();
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [updatePhysics, drawWaveforms]);

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

  return (
    <div className="min-h-screen bg-gray-700 text-white p-4">
      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <header className="flex justify-between items-center mb-6 pb-4 border-b border-gray-600">
          <div className="flex items-center gap-3">
            <Activity className="h-6 w-6 text-blue-400" />
            <div>
              <h1 className="text-2xl font-bold">VentSim <span className="text-blue-400">Dual-Lung</span></h1>
              <p className="text-xs text-gray-400">VC, PC, PS Mode Simulator with Dual-Lung Pathology</p>
            </div>
          </div>

          <button
            onClick={() => setIsRunning(!isRunning)}
            className={`flex items-center gap-2 px-5 py-2 rounded-full font-bold transition ${
              isRunning 
                ? 'bg-red-600 hover:bg-red-700 text-white' 
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {isRunning ? <Pause size={16} /> : <Play size={16} />}
            {isRunning ? 'STOP' : 'START'}
          </button>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* WAVEFORMS - 2/3 WIDTH */}
          <div className="lg:col-span-2 space-y-3">
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-600">
              <h2 className="flex items-center gap-2 font-bold mb-3 text-sm">
                <Activity size={16} /> Real-time Waveforms
              </h2>
              
              <div className="space-y-2">
                {/* Pressure */}
                <div className="bg-gray-900 rounded border border-gray-600 p-2">
                  <canvas ref={canvasRefP} width={800} height={140} className="w-full" />
                </div>

                {/* Flow */}
                <div className="bg-gray-900 rounded border border-gray-600 p-2">
                  <canvas ref={canvasRefF} width={800} height={140} className="w-full" />
                </div>

                {/* Volume */}
                <div className="bg-gray-900 rounded border border-gray-600 p-2">
                  <canvas ref={canvasRefV} width={800} height={140} className="w-full" />
                </div>
              </div>
            </div>

            {/* LOOPS */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-800 rounded-lg p-3 border border-gray-600">
                <h3 className="text-xs font-bold mb-2">P-V Loop</h3>
                <canvas ref={canvasRefPV} width={300} height={200} className="w-full bg-gray-900 rounded" />
              </div>
              <div className="bg-gray-800 rounded-lg p-3 border border-gray-600">
                <h3 className="text-xs font-bold mb-2">F-V Loop</h3>
                <canvas ref={canvasRefFV} width={300} height={200} className="w-full bg-gray-900 rounded" />
              </div>
            </div>
          </div>

          {/* CONTROLS - 1/3 WIDTH */}
          <div className="space-y-3">
            {/* Ventilator Settings */}
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-600">
              <h3 className="flex items-center gap-2 font-bold mb-3 text-sm">
                <Settings size={16} /> Ventilator Settings
              </h3>

              <div className="space-y-3 text-sm">
                <div>
                  <label className="text-xs font-bold">Ventilation Mode</label>
                  <select 
                    value={params.mode}
                    onChange={(e) => setParams(p => ({ ...p, mode: e.target.value }))}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white"
                  >
                    <option>VCV</option>
                    <option>PCV</option>
                    <option>PSV</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-bold">Inspiratory Pressure (Pinsp)</label>
                  <input 
                    type="range"
                    min="5" max="30"
                    value={params.inspiratoryPressure}
                    onChange={(e) => setParams(p => ({ ...p, inspiratoryPressure: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <span className="text-xs text-red-400 font-bold">{params.inspiratoryPressure} cmH2O</span>
                </div>

                <div>
                  <label className="text-xs font-bold">Respiratory Rate (RR)</label>
                  <input 
                    type="range"
                    min="6" max="40"
                    value={params.respiratoryRate}
                    onChange={(e) => setParams(p => ({ ...p, respiratoryRate: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <span className="text-xs font-bold">{params.respiratoryRate} /min</span>
                </div>

                <div>
                  <label className="text-xs font-bold">Inspiratory Time (Ti)</label>
                  <input 
                    type="range"
                    min="0.3" max="2.0" step="0.1"
                    value={params.inspiratoryTime}
                    onChange={(e) => setParams(p => ({ ...p, inspiratoryTime: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <span className="text-xs font-bold">{params.inspiratoryTime.toFixed(2)}s</span>
                </div>

                <div>
                  <label className="text-xs font-bold">PEEP</label>
                  <input 
                    type="range"
                    min="0" max="20"
                    value={params.peep}
                    onChange={(e) => setParams(p => ({ ...p, peep: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <span className="text-xs font-bold">{params.peep} cmH2O</span>
                </div>

                <div>
                  <label className="text-xs font-bold">FiO2</label>
                  <input 
                    type="range"
                    min="21" max="100"
                    value={params.fiO2 * 100}
                    onChange={(e) => setParams(p => ({ ...p, fiO2: Number(e.target.value) / 100 }))}
                    className="w-full"
                  />
                  <span className="text-xs font-bold">{(params.fiO2 * 100).toFixed(0)}%</span>
                </div>
              </div>
            </div>

            {/* Monitoring */}
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-600">
              <h3 className="flex items-center gap-2 font-bold mb-3 text-sm">
                <BarChart2 size={16} /> Monitored Values
              </h3>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>P-Plateau</span>
                  <span className="font-bold text-red-400">{monitoredValues.Pplat.toFixed(1)} cmH2O</span>
                </div>
                <div className="flex justify-between">
                  <span>Paw-mean</span>
                  <span className="font-bold text-yellow-400">{monitoredValues.Pmean.toFixed(1)} cmH2O</span>
                </div>
                <div className="flex justify-between">
                  <span>RR Total</span>
                  <span className="font-bold">{monitoredValues.TotalRR.toFixed(1)} /min</span>
                </div>
                <div className="flex justify-between">
                  <span>MV (Exp.)</span>
                  <span className="font-bold text-green-400">{monitoredValues.MV.toFixed(2)} L/min</span>
                </div>
                <div className="flex justify-between">
                  <span>Cstat</span>
                  <span className="font-bold text-purple-400">{monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span>
                </div>
                <div className="flex justify-between">
                  <span>PEEPI</span>
                  <span className="font-bold text-orange-400">{monitoredValues.AutoPEEP.toFixed(1)} cmH2O</span>
                </div>
                <div className="flex justify-between">
                  <span>SpO2 (Est.)</span>
                  <span className="font-bold" style={{color: monitoredValues.SpO2 < 90 ? '#ef4444' : '#3b82f6'}}>
                    {monitoredValues.SpO2} %
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>EtCO2 (Est.)</span>
                  <span className="font-bold text-pink-400">{monitoredValues.EtCO2} mmHg</span>
                </div>
              </div>
            </div>

            {/* Pathology */}
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-600">
              <h3 className="flex items-center gap-2 font-bold mb-3 text-sm">
                <AlertCircle size={16} /> Select Pathology Preset
              </h3>

              <select 
                value={params.pathology}
                onChange={handlePathologyChange}
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-2 text-sm text-white"
              >
                {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>{preset.name}</option>
                ))}
              </select>

              <div className="mt-2 text-xs text-gray-300">
                <p><strong>L:</strong> R={params.resL} C={params.compL} | <strong>R:</strong> R={params.resR} C={params.compR}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== RENDER =====
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

export default App;
