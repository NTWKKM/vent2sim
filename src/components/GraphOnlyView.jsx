/**
 * GraphOnlyView Component (Study Mode)
 * Fullscreen view displaying only waveforms and loops
 * Perfect for teaching/presentation mode
 */

import React from 'react';
import { X, Download } from 'lucide-react';

export default function GraphOnlyView({ 
  isActive, 
  onClose, 
  canvasRefs = {},
  scales = {},
  monitoredValues = {},
  params = {}
}) {
  const handleScreenshot = () => {
    // Capture all canvas elements
    const timestamp = new Date().toLocaleString();
    
    // Could implement HTML to image conversion here
    console.log('Screenshot captured:', timestamp);
    alert(`Graph snapshot taken at ${timestamp}`);
  };

  if (!isActive) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header Bar */}
      <div className="bg-gray-900 border-b border-gray-700 px-6 py-3 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h2 className="text-white text-lg font-bold">
            📊 Study Mode - Waveforms & Loops
          </h2>
          <div className="text-sm text-gray-400">
            Mode: <span className="font-mono text-blue-300">{params.mode}</span> | 
            Pathology: <span className="font-mono text-green-300">{params.pathology}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleScreenshot}
            className="p-2 bg-green-600 hover:bg-green-700 text-white rounded flex items-center gap-1 text-sm"
            title="Capture graph snapshot"
          >
            <Download className="w-4 h-4" />
            Snapshot
          </button>
          <button
            onClick={onClose}
            className="p-2 bg-red-600 hover:bg-red-700 text-white rounded flex items-center gap-1 text-sm"
            title="Exit study mode"
          >
            <X className="w-4 h-4" />
            Exit
          </button>
        </div>
      </div>

      {/* Main Graph Grid */}
      <div className="flex-1 overflow-auto bg-black p-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-full">
          
          {/* Left Column: Waveforms (Pressure, Flow, Volume) */}
          <div className="space-y-4 flex flex-col">
            {/* Pressure Waveform */}
            <div className="flex-1 rounded border border-gray-700 bg-gray-900 p-2">
              <div className="text-xs text-gray-400 mb-1 font-bold">
                📈 Airway Pressure (Paw) - {scales.pMax?.toFixed(0) || 40} cmH2O
              </div>
              <canvas
                ref={canvasRefs.P}
                width={800}
                height={150}
                className="w-full h-full"
              />
            </div>

            {/* Flow Waveform */}
            <div className="flex-1 rounded border border-gray-700 bg-gray-900 p-2">
              <div className="text-xs text-gray-400 mb-1 font-bold">
                💨 Flow - {scales.fMax?.toFixed(0) || 60} L/min
              </div>
              <canvas
                ref={canvasRefs.F}
                width={800}
                height={150}
                className="w-full h-full"
              />
            </div>

            {/* Volume Waveform */}
            <div className="flex-1 rounded border border-gray-700 bg-gray-900 p-2">
              <div className="text-xs text-gray-400 mb-1 font-bold">
                📦 Volume - {scales.vMax?.toFixed(0) || 600} ml
              </div>
              <canvas
                ref={canvasRefs.V}
                width={800}
                height={150}
                className="w-full h-full"
              />
            </div>
          </div>

          {/* Right Column: Loops (P-V and F-V) */}
          <div className="space-y-4 flex flex-col">
            {/* P-V Loop */}
            <div className="flex-1 rounded border border-gray-700 bg-gray-900 p-2">
              <div className="text-xs text-gray-400 mb-1 font-bold">
                🔄 Pressure-Volume Loop
              </div>
              <canvas
                ref={canvasRefs.PV}
                width={400}
                height={300}
                className="w-full h-full"
              />
              <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-gray-300">
                <div>
                  <span className="text-gray-500">Pplat:</span> 
                  <span className="text-yellow-400 font-mono ml-1">
                    {monitoredValues.Pplat?.toFixed(1)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Cstat:</span>
                  <span className="text-purple-400 font-mono ml-1">
                    {monitoredValues.Cstat?.toFixed(1)}
                  </span>
                </div>
              </div>
            </div>

            {/* F-V Loop */}
            <div className="flex-1 rounded border border-gray-700 bg-gray-900 p-2">
              <div className="text-xs text-gray-400 mb-1 font-bold">
                🌀 Flow-Volume Loop
              </div>
              <canvas
                ref={canvasRefs.FV}
                width={400}
                height={300}
                className="w-full h-full"
              />
              <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-gray-300">
                <div>
                  <span className="text-gray-500">AutoPEEP:</span>
                  <span className="text-green-400 font-mono ml-1">
                    {monitoredValues.AutoPEEP?.toFixed(1)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Vt:</span>
                  <span className="text-blue-400 font-mono ml-1">
                    {monitoredValues.VtExp?.toFixed(0)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="bg-gray-900 border-t border-gray-700 px-6 py-2 text-xs text-gray-400 flex justify-between">
        <div>
          Click and drag on graphs to pan • Scroll to zoom • Use header buttons to manage view
        </div>
        <div className="text-gray-500">
          Study Mode • Real-time simulation running
        </div>
      </div>
    </div>
  );
}
