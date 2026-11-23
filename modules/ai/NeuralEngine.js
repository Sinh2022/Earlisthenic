/**
 * Earlisthenic Web-Scale Neural Engine Controller
 * Manages off-thread AI/neural-network inference for:
 * 1. Neural Ear Fatigue & Auditory Strain Prediction (NEFP)
 * 2. Bayesian Neural Just Noticeable Difference (JND) Adaptation
 * 3. Psychoacoustic Spectral Feature Extraction & Bark Masking
 */
class EarlisthenicNeuralEngine {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl || 'dist/earlisthenic-neural-worker.js';
    this.worker = null;
    this.msgId = 1;
    this.pendingRequests = new Map();
    this.isWorkerReady = false;
    this.currentFatigueState = {
      fatigueIndex: 0.0,
      status: 'optimal',
      advice: 'Awaiting session data.',
      estimatedSensitivityLossDb: 0.0,
      highFreqAcuityPercent: 100
    };
    this.fatigueListeners = [];
    this._initWorker();
  }

  _bindWorkerEvents() {
    if (!this.worker) return;
    this.worker.onmessage = (e) => {
      const { id, success, result, error } = e.data || {};
      if (id && this.pendingRequests.has(id)) {
        const { resolve, reject } = this.pendingRequests.get(id);
        this.pendingRequests.delete(id);
        if (success) resolve(result);
        else reject(new Error(error || 'Neural worker task failed.'));
      }
    };
    this.worker.onerror = () => {
      this.isWorkerReady = false;
    };
    this.isWorkerReady = true;
  }

  _initWorker() {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(this.workerUrl);
      this._bindWorkerEvents();
    } catch (crossOriginErr) {
      if (typeof fetch === 'function' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
        fetch(this.workerUrl)
          .then(res => {
            if (!res.ok) throw new Error('Worker fetch status: ' + res.status);
            return res.text();
          })
          .then(code => {
            const blob = new Blob([code], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            this.worker = new Worker(blobUrl);
            this._bindWorkerEvents();
          })
          .catch(() => {
            this.isWorkerReady = false;
          });
      } else {
        this.isWorkerReady = false;
      }
    }
  }

  _callWorker(type, payload) {
    if (!this.worker || !this.isWorkerReady) {
      return this._fallbackSyncExecution(type, payload);
    }
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          // Fall back gracefully on timeout
          resolve(this._fallbackSyncExecution(type, payload));
        }
      }, 3000);

      this.pendingRequests.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      this.worker.postMessage({ id, type, payload });
    });
  }

  /**
   * Predicts ear fatigue and cognitive auditory strain
   * @param {Object} session - { durationMin, rmsDb, errorVelocity, reactionDriftMs, consecFails }
   */
  async predictEarFatigue(session = {}) {
    const res = await this._callWorker('PREDICT_FATIGUE', session);
    if (res && typeof res.fatigueIndex === 'number') {
      this.currentFatigueState = res;
      if (res.status === 'fatigued') {
        this._notifyFatigueListeners(res);
      }
    }
    return res;
  }

  /**
   * Predicts probability of correctly discerning a frequency boost/cut
   */
  async predictJndProbability(freqHz, deltaDb, userSkillLevel = 5, fatigueFactor = 0.0) {
    return await this._callWorker('PREDICT_JND_PROBABILITY', {
      freqHz,
      deltaDb,
      userSkillLevel,
      fatigueFactor
    });
  }

  /**
   * Extracts spectral centroid, flatness, crest, and rolloff
   */
  async extractSpectralFeatures(fftMagnitudes, sampleRate = 48000) {
    return await this._callWorker('EXTRACT_SPECTRAL_FEATURES', {
      fftMagnitudes,
      sampleRate
    });
  }

  /**
   * Calculates 24-band Bark simultaneous auditory masking curve
   */
  async calculateAuditoryMasking(fftMagnitudes, sampleRate = 48000) {
    return await this._callWorker('CALCULATE_AUDITORY_MASKING', {
      fftMagnitudes,
      sampleRate
    });
  }

  onFatigueAlert(callback) {
    if (typeof callback === 'function') {
      this.fatigueListeners.push(callback);
    }
  }

  _notifyFatigueListeners(state) {
    for (const fn of this.fatigueListeners) {
      try { fn(state); } catch (e) {}
    }
  }

  getFatigueState() {
    return this.currentFatigueState;
  }

  /**
   * In-thread fallback if Web Workers are restricted by browser policy
   */
  _fallbackSyncExecution(type, payload) {
    if (type === 'PREDICT_FATIGUE') {
      const dur = Number((payload && payload.durationMin) || 0);
      const fi = Math.min(1.0, dur / 60.0);
      return {
        fatigueIndex: Number(fi.toFixed(2)),
        status: fi >= 0.7 ? 'fatigued' : (fi >= 0.4 ? 'mild_strain' : 'optimal'),
        advice: fi >= 0.7 ? 'Rest your ears for 5-10 minutes.' : 'Hearing acuity is normal.',
        estimatedSensitivityLossDb: Number((fi * 2.5).toFixed(1)),
        highFreqAcuityPercent: Math.max(30, Math.round(100 - fi * 40))
      };
    }
    if (type === 'PREDICT_JND_PROBABILITY') {
      const d = Math.abs(Number(payload && payload.deltaDb) || 3.0);
      return {
        freqHz: Number(payload && payload.freqHz) || 1000,
        deltaDb: d,
        probabilityCorrect: Math.min(0.99, Math.max(0.5, 0.5 + d * 0.15)),
        isPerceptuallyNoticeable: d >= 1.5
      };
    }
    return {};
  }
}

if (typeof window !== 'undefined') {
  window.EarlisthenicNeuralEngine = EarlisthenicNeuralEngine;
}
