import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Play, Pause, Activity, Settings, BarChart2 } from 'lucide-react';
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

// ===== MAIN APP COMPONENT =====
export default function App() {
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
  const [language, setLanguage] = useState('en');
  const [scales, setScales] = useState({ pMax: 40, fMax: 60, vMax: 600 });
  const scalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });
  const displayedScalesRef = useRef({ pMax: 40, fMax: 60, vMax: 600 });

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

  // ===== DERIVED PARAMS =====
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
      requiredFlowLps: requiredFlow,
      requiredFlowLpm: requiredFlow * 60,
      CTotalml: params.compL + params.compR,
      PBW: calculatePBW(params.gender, params.heightCm).toFixed(1)
    };
  }, [params]);

  // ===== PHYSICS ENGINE =====
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
        const intensity = (p.spontaneousRR * 0.5) * 2.5;
        Pmus = -1 * intensity * (t_mus/Ti_mus) * Math.exp(1 - (t_mus/(Ti_mus*0.3)));
        if (s.phase === 'EXP' && p.mode === 'PSV') {
          triggerBreath = true;
        }
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

  // ===== DRAWING FUNCTIONS =====
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

    const drawLine = (ctx, data, color, yMax, yMin = 0, midZero = false) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      let scale, offset = 0;
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

    // Draw pressure
    ctxP.fillStyle = '#f59e0b';
    ctxP.fillText('Paw (cmH2O)', 40, 15);
    drawLine(ctxP, history.current.paw, '#f59e0b', sP);

    // Draw flow
    ctxF.fillStyle = '#10b981';
    ctxF.fillText('Flow (L/min)', 40, 15);
    drawLine(ctxF, history.current.flow, '#10b981', sF, -sF, true);

    // Draw volume
    ctxV.fillStyle = '#3b82f6';
    ctxV.fillText('Volume (ml)', 40, 15);
    drawLine(ctxV, history.current.vol, '#3b82f6', sV);

  }, []);

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
      updateAutoScales();
      drawWaveforms();
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [updatePhysics, updateAutoScales, drawWaveforms]);

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

  // ===== RENDER =====
  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="max-w-6xl mx-auto">
        {/* HEADER */}
        <header className="flex justify-between items-center mb-6 pb-4 border-b">
          <div>
            <h1 className="text-3xl font-bold">VentSim <span className="text-blue-500">Dual-Lungs v2.0</span></h1>
            <p className="text-sm text-gray-600">VCV/PCV/PSV Modes with Dual-Lung Pathology</p>
          </div>

          <div className="flex gap-2">
            <div className="flex gap-1 bg-gray-200 p-1 rounded">
              <button
                onClick={() => setLanguage('en')}
                className={`px-3 py-1 text-sm font-bold rounded ${language === 'en' ? 'bg-blue-600 text-white' : ''}`}
              >
                EN
              </button>
              <button
                onClick={() => setLanguage('th')}
                className={`px-3 py-1 text-sm font-bold rounded ${language === 'th' ? 'bg-green-600 text-white' : ''}`}
              >
                ไทย
              </button>
            </div>

            <button
              onClick={() => setIsRunning(!isRunning)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-white ${
                isRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {isRunning ? <Pause size={18} /> : <Play size={18} />}
              {isRunning ? 'PAUSE' : 'START'}
            </button>
          </div>
        </header>

        {/* MAIN GRID */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* GRAPHS - LEFT 2/3 */}
          <div className="md:col-span-2 space-y-4">
            {/* Waveforms */}
            <div className="bg-white rounded-lg p-4 shadow-lg">
              <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                <Activity size={16} /> Real-time Waveforms
              </h3>
              <div className="space-y-3">
                <div className="h-32 bg-gray-800 rounded border border-gray-600">
                  <canvas ref={canvasRefP} width={800} height={128} className="w-full h-full" />
                </div>
                <div className="h-32 bg-gray-800 rounded border border-gray-600">
                  <canvas ref={canvasRefF} width={800} height={128} className="w-full h-full" />
                </div>
                <div className="h-32 bg-gray-800 rounded border border-gray-600">
                  <canvas ref={canvasRefV} width={800} height={128} className="w-full h-full" />
                </div>
              </div>
            </div>
          </div>

          {/* CONTROLS - RIGHT 1/3 */}
          <div className="space-y-4">
            {/* Settings */}
            <div className="bg-white rounded-lg p-4 shadow-lg">
              <h2 className="font-bold mb-3 flex items-center gap-2">
                <Settings size={18} /> Settings
              </h2>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-bold">Mode</label>
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
                  <label className="text-xs font-bold">Pathology</label>
                  <select 
                    value={params.pathology} 
                    onChange={handlePathologyChange}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                  >
                    {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>{preset.name}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-bold">RR (bpm)</label>
                    <input 
                      type="number" 
                      value={params.respiratoryRate}
                      onChange={(e) => setParams(p => ({ ...p, respiratoryRate: Number(e.target.value) }))}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold">PEEP</label>
                    <input 
                      type="number" 
                      value={params.peep}
                      onChange={(e) => setParams(p => ({ ...p, peep: Number(e.target.value) }))}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-bold">Ti (sec)</label>
                    <input 
                      type="number" 
                      step="0.1"
                      value={params.inspiratoryTime}
                      onChange={(e) => setParams(p => ({ ...p, inspiratoryTime: Number(e.target.value) }))}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold">FiO2</label>
                    <input 
                      type="number" 
                      step="0.05"
                      value={params.fiO2}
                      onChange={(e) => setParams(p => ({ ...p, fiO2: Number(e.target.value) }))}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Monitor */}
            <div className="bg-white rounded-lg p-4 shadow-lg">
              <h3 className="font-bold mb-3 flex items-center gap-2">
                <BarChart2 size={16} /> Monitor
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span>Pplat:</span><span className="font-bold text-red-600">{monitoredValues.Pplat.toFixed(1)} cmH2O</span></div>
                <div className="flex justify-between"><span>Cstat:</span><span className="font-bold text-purple-600">{monitoredValues.Cstat.toFixed(1)} ml/cmH2O</span></div>
                <div className="flex justify-between"><span>AutoPEEP:</span><span className="font-bold text-yellow-600">{monitoredValues.AutoPEEP.toFixed(1)} cmH2O</span></div>
                <div className="flex justify-between"><span>SpO2:</span><span className={`font-bold ${monitoredValues.SpO2 < 90 ? 'text-red-600' : 'text-blue-600'}`}>{monitoredValues.SpO2}%</span></div>
                <div className="flex justify-between"><span>RR:</span><span className="font-bold">{monitoredValues.TotalRR.toFixed(0)} bpm</span></div>
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
