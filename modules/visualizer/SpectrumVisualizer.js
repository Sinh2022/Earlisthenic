/**
 * Earlisthenic — modules/visualizer/SpectrumVisualizer.js
 * Bridge for Real-Time Visualizer:
 * Uses OffscreenCanvas + Web Worker when supported to render off the main thread at 60-120fps;
 * falls back to optimized inline canvas 2D context on legacy browsers.
 */

class EarlisthenicSpectrumVisualizer {
  constructor(canvasElement, workerScriptUrl = 'dist/earlisthenic-visualizer-worker.js') {
    this.canvas = canvasElement;
    this.workerScriptUrl = workerScriptUrl;
    this.worker = null;
    this.isOffscreen = false;
    this.ctx = null;
    this.isDark = true;
    this.animationId = null;

    this.init();
  }

  init() {
    if (!this.canvas) return;

    const hasOffscreen = typeof this.canvas.transferControlToOffscreen === 'function' && typeof Worker !== 'undefined';
    if (hasOffscreen) {
      try {
        const offscreen = this.canvas.transferControlToOffscreen();
        this.worker = new Worker(this.workerScriptUrl);
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.worker.postMessage({
          type: 'INIT',
          canvas: offscreen,
          width: rect.width || 400,
          height: rect.height || 180,
          dpr: dpr,
          isDark: document.documentElement.classList.contains('dark')
        }, [offscreen]);

        this.isOffscreen = true;
        return;
      } catch (err) {
        console.warn('OffscreenCanvas init failed, falling back to main-thread canvas:', err);
        this.worker = null;
        this.isOffscreen = false;
      }
    }

    // Fallback: standard 2D context
    this.ctx = this.canvas.getContext('2d');
  }

  resize(width, height) {
    const dpr = window.devicePixelRatio || 1;
    if (this.isOffscreen && this.worker) {
      this.worker.postMessage({
        type: 'RESIZE',
        width,
        height,
        dpr
      });
    } else if (this.canvas) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
  }

  setTheme(isDark) {
    this.isDark = !!isDark;
    if (this.isOffscreen && this.worker) {
      this.worker.postMessage({ type: 'SET_THEME', isDark });
    }
  }

  updateAudioData(freqData, isPlaying, playheadPct, loopStartPct, loopEndPct) {
    if (this.isOffscreen && this.worker) {
      this.worker.postMessage({
        type: 'UPDATE_AUDIO_DATA',
        freqData: freqData ? freqData.slice(0) : null,
        isPlaying,
        playheadPct,
        loopStartPct,
        loopEndPct
      });
    }
  }

  destroy() {
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) {}
      this.worker = null;
    }
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EarlisthenicSpectrumVisualizer };
}
