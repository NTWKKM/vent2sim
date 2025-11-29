import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Play, Pause, Activity, Settings, BarChart2, AlertCircle, TrendingUp, Zap, RefreshCw } from 'lucide-react';
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

    try {
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
            const Vt_Final_mL = Math.max(0, s.volPeakCycle - ((s.volL + s.volR) * 1000));
            const MV_val = (instantRR * Vt_Final_mL) / 1000;
            const drivingP = Math.max(1, s.pPlatTemp - p.peep);
            const cstat = Vt_Final_mL / drivingP;

            const baseShunt = p.shunt;
            const baseDeadspace = p.deadspace;
            const PmeanEffect = Math.max(0, ((s.pawSum / Math.max(1, s.pawCount)) - 5) * 0.01);
            const actualShunt = Math.max(0.01, baseShunt - PmeanEffect);
            let estimatedSpO2 = 99 - (actualShunt * 100) * 1.5;
            const fio2Effect = (p.fiO2 - 0.40) * 15;
            estimatedSpO2 += fio2Effect;
            estimatedSpO2 = Math.max(50, Math.min(100, estimatedSpO2));

            const idealMV = 6.0;
            const effectiveMV = (instantRR * Vt_Final_mL / 1000) * (1 - baseDeadspace);
            let estimatedEtCO2 = 40 * (idealMV / Math.max(0.1, effectiveMV));
            estimatedEtCO2 = Math.max(10, Math.min(100, estimatedEtCO2));

            setMonitoredValues(m => ({
              ...m,
              TotalRR: Math.round(instantRR * 10) / 10,
              MV: Math.round(MV_val * 100) / 100,
              VtExp: Math.round(Vt_Final_mL),
              Cstat: Math.round(cstat * 10) / 10,
              Pplat: Math.round(s.pPlatTemp * 10) / 10,
              Pmean: Math.round((s.pawSum / Math.max(1, s.pawCount)) * 10) / 10,
              AutoPEEP: Math.round(Math.max(0, ((s.volL / CL_dynamic + s.volR / CR_dynamic) / 2) - p.peep) * 10) / 10,
              SpO2: Math.round(estimatedSpO2),
              EtCO2: Math.round(estimatedEtCO2)
            }));
          }
        }
        s.lastBreathTime = now;
        s.phase = 'INS';
        s.cycleTime = 0;
        s.volPeakCycle = (s.volL + s.volR) * 1000;
        s.pawSum = 0;
        s.pawCount = 0;
        
        if (history.current.currentLoopPV.length > 10) {
          history.current.lastLoopPV = [...history.current.currentLoopPV];
          history.current.lastLoopFV = [...history.current.currentLoopFV];
        }
        history.current.currentLoopPV = [];
        history.current.currentLoopFV = [];
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
            s.pPlatTemp = (PelL + PelR) / 2 + p.peep;
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

      history.current.currentLoopPV.push({ p: s.paw, v: V_Relative_mL_Current });
      history.current.currentLoopFV.push({ f: s.flowTotal * 60, v: V_Relative_mL_Current });

      if (history.current.paw.length > MAX_HISTORY) {
        history.current.paw.shift();
        history.current.flow.shift();
        history.current.flowL.shift();
        history.current.flowR.shift();
        history.current.vol.shift();
      }

      s.timeSinceLastBreath += DT;
      s.patientTime += DT;
    } catch (e) {
      console.error('Physics error:', e);
    }
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
      setScales({
        pMax: scalesRef.current.pMax,
        fMax: scalesRef.current.fMax,
        vMax: scalesRef.current.vMax
      });
      displayedScalesRef.current = { ...scalesRef.current };
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
    ctxP.fillStyle = '#1f2937';
    ctxP.fillRect(0, 0, w, h);
    ctxP.fillStyle = '#f59e0b';
    ctxP.font = 'bold 13px sans-serif';
    ctxP.fillText('Paw (cmH2O)', 50, 22);
    ctxP.font = '12px sans-serif';
    ctxP.fillText('PEAK: ' + Math.max(...history.current.paw).toFixed(1), w - 120, 22);
    drawLine(ctxP, history.current.paw, '#f59e0b', scales.pMax);

    // Flow
    ctxF.fillStyle = '#1f2937';
    ctxF.fillRect(0, 0, w, h);
    ctxF.fillStyle = '#10b981';
    ctxF.font = 'bold 13px sans-serif';
    ctxF.fillText('Flow (L/min)', 50, 22);
    ctxF.font = '12px sans-serif';
    ctxF.fillText('SCALE: ' + scales.fMax.toFixed(1), w - 150, 22);
    drawLine(ctxF, history.current.flow, '#10b981', scales.fMax, true);

    // Volume
    ctxV.fillStyle = '#1f2937';
    ctxV.fillRect(0, 0, w, h);
    ctxV.fillStyle = '#3b82f6';
    ctxV.font = 'bold 13px sans-serif';
    ctxV.fillText('Volume (ml)', 50, 22);
    ctxV.font = '12px sans-serif';
    ctxV.fillText('Max: ' + Math.max(...history.current.vol).toFixed(0), w - 150, 22);
    drawLine(ctxV, history.current.vol, '#3b82f6', scales.vMax);
  }, [scales, updateAutoScales]);

  const drawLoops = useCallback(() => {
    const ctxPV = canvasRefPV.current?.getContext('2d');
    const ctxFV = canvasRefFV.current?.getContext('2d');
    if (!ctxPV || !ctxFV) return;

    const w = ctxPV.canvas.width;
    const h = ctxPV.canvas.height;

    // P-V Loop
    ctxPV.fillStyle = '#1f2937';
    ctxPV.fillRect(0, 0, w, h);
    ctxPV.strokeStyle = '#f59e0b';
    ctxPV.lineWidth = 2;
    ctxPV.beginPath();

    const pMax = scales.pMax;
    const vMax = scales.vMax;
    const px = 40;
    const py = 20;
    const pw = w - 60;
    const ph = h - 40;

    // Ghost loop
    ctxPV.globalAlpha = 0.2;
    history.current.lastLoopPV.forEach((pt, i) => {
      const x = px + (pt.p / pMax) * pw;
      const y = py + ph - (pt.v / vMax) * ph;
      if (i === 0) ctxPV.moveTo(x, y);
      else ctxPV.lineTo(x, y);
    });
    ctxPV.stroke();

    // Current loop
    ctxPV.globalAlpha = 1.0;
    ctxPV.beginPath();
    history.current.currentLoopPV.forEach((pt, i) => {
      const x = px + (pt.p / pMax) * pw;
      const y = py + ph - (pt.v / vMax) * ph;
      if (i === 0) ctxPV.moveTo(x, y);
      else ctxPV.lineTo(x, y);
    });
    ctxPV.stroke();

    // F-V Loop
    ctxFV.fillStyle = '#1f2937';
    ctxFV.fillRect(0, 0, w, h);
    ctxFV.strokeStyle = '#10b981';
    ctxFV.lineWidth = 2;
    ctxFV.beginPath();

    const fMax = scales.fMax;

    // Ghost loop
    ctxFV.globalAlpha = 0.2;
    history.current.lastLoopFV.forEach((pt, i) => {
      const x = px + (pt.v / vMax) * pw;
      const y = py + ph / 2 - (pt.f / fMax) * (ph / 2);
      if (i === 0) ctxFV.moveTo(x, y);
      else ctxFV.lineTo(x, y);
    });
    ctxFV.stroke();

    // Current loop
    ctxFV.globalAlpha = 1.0;
    ctxFV.beginPath();
    history.current.currentLoopFV.forEach((pt, i) => {
      const x = px + (pt.v / vMax) * pw;
      const y = py + ph / 2 - (pt.f / fMax) * (ph / 2);
      if (i === 0) ctxFV.moveTo(x, y);
      else ctxFV.lineTo(x, y);
    });
    ctxFV.stroke();
  }, [scales]);

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
    <div className="min-h-screen bg-white text-gray-900 p-4">
      <div className="max-w-7xl mx-auto">
        {/* HEADER */}
        <header className="flex justify-between items-center mb-6 pb-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Activity className="h-7 w-7 text-blue-600" />
            <div>
              <h1 className="text-3xl font-bold">VentSim <span className="text-blue-600">Dual-Lung</span></h1>
              <p className="text-sm text-gray-500">VCV/PCV/PSV with Dual-Lung Pathology Simulation</p>
            </div>
          </div>

          <button
            onClick={() => setIsRunning(!isRunning)}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-full font-bold transition text-base ${
              isRunning 
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-lg' 
                : 'bg-green-600 hover:bg-green-700 text-white shadow-lg'
            }`}
          >
            {isRunning ? <Pause size={18} /> : <Play size={18} />}
            {isRunning ? 'STOP' : 'START'}
          </button>
        </header>

        {/* MAIN CONTENT */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          {/* WAVEFORMS - FULL WIDTH TOP */}
          <div className="lg:col-span-3 bg-white rounded-lg p-4 border border-gray-200 shadow-sm">
            <h2 className="flex items-center gap-2 font-bold mb-3 text-lg">
              <TrendingUp size={20} className="text-blue-600" /> Real-time Waveforms
            </h2>
            
            <div className="space-y-2">
              <div className="bg-gray-900 rounded border border-gray-300 p-2">
                <canvas ref={canvasRefP} width={1000} height={120} className="w-full" />
              </div>
              <div className="bg-gray-900 rounded border border-gray-300 p-2">
                <canvas ref={canvasRefF} width={1000} height={120} className="w-full" />
              </div>
              <div className="bg-gray-900 rounded border border-gray-300 p-2">
                <canvas ref={canvasRefV} width={1000} height={120} className="w-full" />
              </div>
            </div>
          </div>

          {/* MONITORED VALUES + LOOPS */}
          <div className="lg:col-span-2 space-y-4">
            {/* Monitored Values */}
            <div className="bg-white rounded-lg p-4 border border-gray-200 shadow-sm">
              <h3 className="flex items-center gap-2 font-bold mb-3 text-base">
                <BarChart2 size={18} className="text-blue-600" /> Monitored Values
              </h3>

              <div className="grid grid-cols-3 gap-3">
                <div className="bg-red-50 p-3 rounded-lg border border-red-100">
                  <p className="text-xs text-gray-600">P-Plateau</p>
                  <p className="text-2xl font-bold text-red-600">{monitoredValues.Pplat}</p>
                  <p className="text-xs text-gray-500">cmH2O</p>
                </div>
                <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-100">
                  <p className="text-xs text-gray-600">Paw-mean</p>
                  <p className="text-2xl font-bold text-yellow-600">{monitoredValues.Pmean}</p>
                  <p className="text-xs text-gray-500">cmH2O</p>
                </div>
                <div className="bg-blue-50 p-3 rounded-lg border border-blue-100">
                  <p className="text-xs text-gray-600">RR Total</p>
                  <p className="text-2xl font-bold text-blue-600">{monitoredValues.TotalRR}</p>
                  <p className="text-xs text-gray-500">/min</p>
                </div>
                <div className="bg-green-50 p-3 rounded-lg border border-green-100">
                  <p className="text-xs text-gray-600">MV (Exp.)</p>
                  <p className="text-2xl font-bold text-green-600">{monitoredValues.MV.toFixed(1)}</p>
                  <p className="text-xs text-gray-500">L/min</p>
                </div>
                <div className="bg-cyan-50 p-3 rounded-lg border border-cyan-100">
                  <p className="text-xs text-gray-600">Vt (Exp)</p>
                  <p className="text-2xl font-bold text-cyan-600">{monitoredValues.VtExp}</p>
                  <p className="text-xs text-gray-500">ml</p>
                </div>
                <div className="bg-purple-50 p-3 rounded-lg border border-purple-100">
                  <p className="text-xs text-gray-600">Cstat</p>
                  <p className="text-2xl font-bold text-purple-600">{monitoredValues.Cstat}</p>
                  <p className="text-xs text-gray-500">ml/cmH2O</p>
                </div>
                <div className="bg-orange-50 p-3 rounded-lg border border-orange-100">
                  <p className="text-xs text-gray-600">PEEPI</p>
                  <p className="text-2xl font-bold text-orange-600">{monitoredValues.AutoPEEP}</p>
                  <p className="text-xs text-gray-500">cmH2O</p>
                </div>
                <div className={`p-3 rounded-lg border ${monitoredValues.SpO2 < 90 ? 'bg-red-50 border-red-100' : 'bg-blue-50 border-blue-100'}`}>
                  <p className="text-xs text-gray-600">SpO2 (Est.)</p>
                  <p className={`text-2xl font-bold ${monitoredValues.SpO2 < 90 ? 'text-red-600' : 'text-blue-600'}`}>{monitoredValues.SpO2}</p>
                  <p className="text-xs text-gray-500">%</p>
                </div>
                <div className="bg-pink-50 p-3 rounded-lg border border-pink-100">
                  <p className="text-xs text-gray-600">EtCO2 (Est.)</p>
                  <p className="text-2xl font-bold text-pink-600">{monitoredValues.EtCO2}</p>
                  <p className="text-xs text-gray-500">mmHg</p>
                </div>
              </div>
            </div>

            {/* Loops */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-lg p-3 border border-gray-200 shadow-sm">
                <h3 className="text-sm font-bold mb-2">P-V Loop</h3>
                <canvas ref={canvasRefPV} width={300} height={200} className="w-full bg-gray-900 rounded" />
              </div>
              <div className="bg-white rounded-lg p-3 border border-gray-200 shadow-sm">
                <h3 className="text-sm font-bold mb-2">F-V Loop</h3>
                <canvas ref={canvasRefFV} width={300} height={200} className="w-full bg-gray-900 rounded" />
              </div>
            </div>
          </div>

          {/* CONTROLS - 1/3 WIDTH */}
          <div className="space-y-4">
            {/* Ventilator Settings */}
            <div className="bg-white rounded-lg p-4 border border-gray-200 shadow-sm">
              <h3 className="flex items-center gap-2 font-bold mb-3 text-base">
                <Settings size={18} className="text-blue-600" /> Ventilator Settings
              </h3>

              <div className="space-y-3 text-sm">
                <div>
                  <label className="text-xs font-bold text-gray-700">Mode</label>
                  <select 
                    value={params.mode}
                    onChange={(e) => setParams(p => ({ ...p, mode: e.target.value }))}
                    className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 hover:border-gray-400"
                  >
                    <option>VCV</option>
                    <option>PCV</option>
                    <option>PSV</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-bold text-gray-700 flex justify-between">
                    <span>Pinsp (cmH2O)</span>
                    <span className="text-red-600">{params.inspiratoryPressure}</span>
                  </label>
                  <input 
                    type="range"
                    min="5" max="30"
                    value={params.inspiratoryPressure}
                    onChange={(e) => setParams(p => ({ ...p, inspiratoryPressure: Number(e.target.value) }))}
                    className="w-full h-2 bg-gray-300 rounded appearance-none cursor-pointer"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-gray-700 flex justify-between">
                    <span>RR (/min)</span>
                    <span className="text-blue-600">{params.respiratoryRate}</span>
                  </label>
                  <input 
                    type="range"
                    min="6" max="40"
                    value={params.respiratoryRate}
                    onChange={(e) => setParams(p => ({ ...p, respiratoryRate: Number(e.target.value) }))}
                    className="w-full h-2 bg-gray-300 rounded appearance-none cursor-pointer"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-gray-700 flex justify-between">
                    <span>Ti (sec)</span>
                    <span className="text-yellow-600">{params.inspiratoryTime.toFixed(2)}</span>
                  </label>
                  <input 
                    type="range"
                    min="0.3" max="2.0" step="0.1"
                    value={params.inspiratoryTime}
                    onChange={(e) => setParams(p => ({ ...p, inspiratoryTime: Number(e.target.value) }))}
                    className="w-full h-2 bg-gray-300 rounded appearance-none cursor-pointer"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-gray-700 flex justify-between">
                    <span>PEEP (cmH2O)</span>
                    <span className="text-purple-600">{params.peep}</span>
                  </label>
                  <input 
                    type="range"
                    min="0" max="20"
                    value={params.peep}
                    onChange={(e) => setParams(p => ({ ...p, peep: Number(e.target.value) }))}
                    className="w-full h-2 bg-gray-300 rounded appearance-none cursor-pointer"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-gray-700 flex justify-between">
                    <span>FiO2 (%)</span>
                    <span className="text-green-600">{Math.round(params.fiO2 * 100)}</span>
                  </label>
                  <input 
                    type="range"
                    min="21" max="100"
                    value={params.fiO2 * 100}
                    onChange={(e) => setParams(p => ({ ...p, fiO2: Number(e.target.value) / 100 }))}
                    className="w-full h-2 bg-gray-300 rounded appearance-none cursor-pointer"
                  />
                </div>
              </div>
            </div>

            {/* Tools & Maneuvers */}
            <div className="bg-gradient-to-br from-blue-50 to-cyan-50 rounded-lg p-4 border border-blue-200 shadow-sm">
              <h3 className="flex items-center gap-2 font-bold mb-3 text-base text-blue-900">
                <Zap size={18} /> Tools / Maneuvers
              </h3>
              <button className="w-full bg-white border border-blue-300 text-blue-700 font-semibold py-2 rounded-lg hover:bg-blue-50 transition">
                Start Recruitment (30/40 cmH2O)
              </button>
            </div>

            {/* Pathology */}
            <div className="bg-white rounded-lg p-4 border border-gray-200 shadow-sm">
              <h3 className="flex items-center gap-2 font-bold mb-3 text-base">
                <AlertCircle size={18} className="text-orange-600" /> Pathology Preset
              </h3>

              <select 
                value={params.pathology}
                onChange={handlePathologyChange}
                className="w-full bg-white border border-gray-300 rounded px-2 py-2 text-sm text-gray-900 hover:border-gray-400"
              >
                {Object.entries(PATHOLOGY_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>{preset.name}</option>
                ))}
              </select>

              <div className="mt-3 p-3 bg-gray-50 rounded text-xs text-gray-700 border border-gray-200">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="font-bold text-gray-800">Left Lung</p>
                    <p>R: {params.resL} cmH2O/(L/s)</p>
                    <p>C: {params.compL} ml/cmH2O</p>
                  </div>
                  <div>
                    <p className="font-bold text-gray-800">Right Lung</p>
                    <p>R: {params.resR} cmH2O/(L/s)</p>
                    <p>C: {params.compR} ml/cmH2O</p>
                  </div>
                </div>
                <p className="mt-2 text-gray-600"><strong>FRC:</strong> {(params.frcOffset * 1000).toFixed(0)} ml</p>
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

export default App;
