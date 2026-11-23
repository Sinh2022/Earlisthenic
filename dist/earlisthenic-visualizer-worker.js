/**
 * Earlisthenic — dist/earlisthenic-visualizer-worker.js
 * High-Performance OffscreenCanvas Web Worker for Real-Time Audio Visualization.
 * Renders FFT Log Spectrum Analyzer & Waveform at 60–120 FPS off the Main Thread.
 */

let canvas = null;
let ctx = null;
let width = 0;
let height = 0;
let dpr = 1;
let isDark = true;
let isRunning = false;

// Visualization buffers
let freqData = null;
let lastPeakHold = new Float32Array(128);
let waveformBins = null;
let playheadPct = 0;
let loopStartPct = 0;
let loopEndPct = 1.0;
let isPlaying = false;

const PALETTE = {
  dark: {
    bg: '#191D19',
    grid: 'rgba(236, 235, 226, 0.08)',
    text: '#A0A597',
    primary: '#B56D4E',
    primaryGlow: 'rgba(181, 109, 78, 0.28)',
    accent: '#DFA58D',
    curve: '#ECEBE2',
    peakHold: 'rgba(223, 165, 141, 0.75)'
  },
  light: {
    bg: '#F4F0E7',
    grid: 'rgba(23, 25, 21, 0.08)',
    text: '#596052',
    primary: '#965438',
    primaryGlow: 'rgba(150, 84, 56, 0.22)',
    accent: '#B56D4E',
    curve: '#171915',
    peakHold: 'rgba(150, 84, 56, 0.65)'
  }
};

// Universal Environment Guard: Prevents ReferenceError in server-side runtimes (e.g. Google Apps Script V8)
var _workerGlobal = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof _workerGlobal !== 'undefined' && (typeof _workerGlobal.addEventListener === 'function' || typeof _workerGlobal.postMessage === 'function')) {
  _workerGlobal.onmessage = function (e) {
    const msg = e.data;
    if (!msg) return;

    switch (msg.type) {
      case 'INIT':
        canvas = msg.canvas;
        ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        width = msg.width || 400;
        height = msg.height || 180;
        dpr = msg.dpr || 1;
        isDark = !!msg.isDark;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        if (!isRunning) {
          isRunning = true;
          requestAnimationFrame(renderLoop);
        }
        break;

      case 'RESIZE':
        width = msg.width || width;
        height = msg.height || height;
        dpr = msg.dpr || dpr;
        if (canvas) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
        }
        break;

      case 'SET_THEME':
        isDark = !!msg.isDark;
        break;

      case 'UPDATE_AUDIO_DATA':
        if (msg.freqData) freqData = msg.freqData;
        if (typeof msg.playheadPct === 'number') playheadPct = msg.playheadPct;
        if (typeof msg.loopStartPct === 'number') loopStartPct = msg.loopStartPct;
        if (typeof msg.loopEndPct === 'number') loopEndPct = msg.loopEndPct;
      if (typeof msg.isPlaying === 'boolean') isPlaying = msg.isPlaying;
      if (msg.waveformBins) waveformBins = msg.waveformBins;
      break;
    }
  };
}

function renderLoop() {
  if (!ctx || !canvas) return;

  const w = canvas.width;
  const h = canvas.height;
  const colors = isDark ? PALETTE.dark : PALETTE.light;

  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  // Draw Subtle Frequency Grid
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  const octaves = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < octaves.length; i++) {
    // Logarithmic horizontal position: 20 Hz to 20000 Hz
    const freq = octaves[i];
    const logMin = Math.log10(20);
    const logMax = Math.log10(20000);
    const x = ((Math.log10(freq) - logMin) / (logMax - logMin)) * w;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();

  // Draw Real-Time FFT Spectrum Curve if audio data exists
  if (freqData && freqData.length > 0 && isPlaying) {
    const bins = freqData.length;
    const numPoints = 128;
    const logMin = Math.log10(20);
    const logMax = Math.log10(20000);

    ctx.beginPath();
    ctx.moveTo(0, h);

    for (let p = 0; p < numPoints; p++) {
      const frac = p / (numPoints - 1);
      const freq = Math.pow(10, logMin + frac * (logMax - logMin));
      // Map freq to FFT bin index (Nyquist assumed 24kHz or sampleRate/2)
      const binIdx = Math.min(bins - 1, Math.max(0, Math.round((freq / 24000) * bins)));
      const rawVal = freqData[binIdx]; // 0 to 255
      const norm = rawVal / 255.0;

      // Peak Hold decay
      if (norm > lastPeakHold[p]) {
        lastPeakHold[p] = norm;
      } else {
        lastPeakHold[p] = Math.max(0, lastPeakHold[p] - 0.008);
      }

      const y = h - (norm * h * 0.88);
      const x = frac * w;
      if (p === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    // Glow Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, colors.primaryGlow);
    grad.addColorStop(1, 'transparent');
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fillStyle = grad;
    ctx.fill();

    // Curve line
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();

    // Draw Peak Hold Line
    ctx.beginPath();
    ctx.strokeStyle = colors.peakHold;
    ctx.lineWidth = 1 * dpr;
    for (let p = 0; p < numPoints; p++) {
      const x = (p / (numPoints - 1)) * w;
      const y = h - (lastPeakHold[p] * h * 0.88);
      if (p === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Draw Playhead line
  if (isPlaying && playheadPct >= 0 && playheadPct <= 1.0) {
    const phX = playheadPct * w;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, h);
    ctx.stroke();
  }

  if (isRunning) {
    requestAnimationFrame(renderLoop);
  }
}
