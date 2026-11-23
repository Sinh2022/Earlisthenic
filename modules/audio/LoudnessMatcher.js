/**
 * Earlisthenic — modules/audio/LoudnessMatcher.js
 * Studio-Grade Auto Loudness Matching Engine based on ITU-R BS.1770-4 standard.
 *
 * Eliminates "Loudness Bias" during auditory training A/B testing:
 * Automatically matches the integrated/momentary loudness (LUFS) between the
 * reference (bypass/original) signal and the processed (target/user filter) signal.
 * Ensures the listener discerns pure frequency timbre changes rather than volume differentials.
 */

class EarlisthenicLoudnessMatcher {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.enabled = true;
    this.maxCompensationDb = 12.0; // Safety clamp against extreme compensation
    this.cachedRefLufs = null;
    this.cachedTargetLufs = null;
    this.currentMakeupGain = 1.0;
    this.currentMakeupDb = 0.0;
    this._coeffs = this._computeKWeightingCoefficients(this.sampleRate);
  }

  setSampleRate(sr) {
    if (typeof sr === 'number' && sr > 0 && sr !== this.sampleRate) {
      this.sampleRate = sr;
      this._coeffs = this._computeKWeightingCoefficients(sr);
      this.reset();
    }
  }

  setEnabled(enable) {
    this.enabled = !!enable;
  }

  reset() {
    this.cachedRefLufs = null;
    this.cachedTargetLufs = null;
    this.currentMakeupGain = 1.0;
    this.currentMakeupDb = 0.0;
  }

  /**
   * Computes exact ITU-R BS.1770-4 K-weighting biquad coefficients for the given sample rate.
   * Stage 1: High-shelf pre-filter (head acoustic modeling: +4 dB above ~1.5 kHz)
   * Stage 2: High-pass RLB weighting filter (models human low-frequency roll-off at 38 Hz)
   */
  _computeKWeightingCoefficients(sr) {
    // Stage 1: Pre-filter (high shelf)
    const f0_hs = 1681.9744509555319;
    const G_hs = 3.999843883652875; // dB
    const Q_hs = 0.7071752369554193;

    const V_hs = Math.pow(10, G_hs / 20);
    const K_hs = Math.tan((Math.PI * f0_hs) / sr);
    const K2_hs = K_hs * K_hs;
    const norm_hs = 1 + Math.SQRT2 * K_hs + K2_hs;

    const b0_hs = (V_hs + Math.sqrt(2 * V_hs) * K_hs + K2_hs) / norm_hs;
    const b1_hs = (2 * (K2_hs - V_hs)) / norm_hs;
    const b2_hs = (V_hs - Math.sqrt(2 * V_hs) * K_hs + K2_hs) / norm_hs;
    const a1_hs = (2 * (K2_hs - 1)) / norm_hs;
    const a2_hs = (1 - Math.SQRT2 * K_hs + K2_hs) / norm_hs;

    // Stage 2: RLB weighting filter (high-pass at ~38.13 Hz)
    const f0_hp = 38.13547087602444;
    const Q_hp = 0.5003270373238773;

    const K_hp = Math.tan((Math.PI * f0_hp) / sr);
    const K2_hp = K_hp * K_hp;
    const norm_hp = 1 + K_hp / Q_hp + K2_hp;

    const b0_hp = 1.0 / norm_hp;
    const b1_hp = -2.0 / norm_hp;
    const b2_hp = 1.0 / norm_hp;
    const a1_hp = (2 * (K2_hp - 1)) / norm_hp;
    const a2_hp = (1 - K_hp / Q_hp + K2_hp) / norm_hp;

    return {
      hs: { b0: b0_hs, b1: b1_hs, b2: b2_hs, a1: a1_hs, a2: a2_hs },
      hp: { b0: b0_hp, b1: b1_hp, b2: b2_hp, a1: a1_hp, a2: a2_hp }
    };
  }

  /**
   * Applies 2-stage Direct Form II transposed biquad filter in-place to single channel array.
   */
  _applyKWeightingToChannel(input, output, coeffs) {
    const len = input.length;
    const hs = coeffs.hs;
    const hp = coeffs.hp;

    // State registers for stage 1 (high shelf)
    let d1_hs = 0, d2_hs = 0;
    // State registers for stage 2 (RLB high pass)
    let d1_hp = 0, d2_hp = 0;

    for (let i = 0; i < len; i++) {
      const x = input[i];

      // Stage 1
      const y1 = hs.b0 * x + d1_hs;
      d1_hs = hs.b1 * x - hs.a1 * y1 + d2_hs;
      d2_hs = hs.b2 * x - hs.a2 * y1;

      // Stage 2
      const y2 = hp.b0 * y1 + d1_hp;
      d1_hp = hp.b1 * y1 - hp.a1 * y2 + d2_hp;
      d2_hp = hp.b2 * y1 - hp.a2 * y2;

      output[i] = y2;
    }
  }

  /**
   * Measures integrated/short-term loudness in LUFS for an AudioBuffer according to ITU-R BS.1770-4.
   * @param {AudioBuffer} audioBuffer
   * @param {number} [startSec=0]
   * @param {number} [durationSec]
   * @returns {number} Loudness in LUFS (dB relative to full scale)
   */
  measureBufferLufs(audioBuffer, startSec = 0, durationSec = null) {
    if (!audioBuffer || !audioBuffer.length) return -70.0;
    const sr = audioBuffer.sampleRate;
    const coeffs = (sr === this.sampleRate) ? this._coeffs : this._computeKWeightingCoefficients(sr);

    const numChannels = Math.min(2, audioBuffer.numberOfChannels);
    const totalSamples = audioBuffer.length;
    const startSample = Math.max(0, Math.floor(startSec * sr));
    const maxDurSamples = (typeof durationSec === 'number' && durationSec > 0)
      ? Math.min(totalSamples - startSample, Math.floor(durationSec * sr))
      : (totalSamples - startSample);

    if (maxDurSamples <= 0) return -70.0;

    // Use stride for fast calculation on long audio buffers while preserving high statistical accuracy
    const stride = maxDurSamples > 192000 ? Math.floor(maxDurSamples / 96000) : 1;
    const effectiveSamples = Math.floor(maxDurSamples / stride);

    let sumSquarePower = 0.0;
    const scratchIn = new Float32Array(maxDurSamples);
    const scratchOut = new Float32Array(maxDurSamples);

    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      scratchIn.set(channelData.subarray(startSample, startSample + maxDurSamples));

      this._applyKWeightingToChannel(scratchIn, scratchOut, coeffs);

      let chSquareSum = 0.0;
      for (let i = 0; i < maxDurSamples; i += stride) {
        const s = scratchOut[i];
        chSquareSum += s * s;
      }
      const meanSquare = chSquareSum / effectiveSamples;
      // Channel weighting: GL = 1.0 (0 dB), GR = 1.0 (0 dB) per BS.1770
      sumSquarePower += meanSquare;
    }

    if (sumSquarePower <= 1e-12) return -70.0;

    // BS.1770 formula: LKFS = -0.691 + 10 * log10(sum of channel powers)
    const lufs = -0.691 + 10.0 * Math.log10(sumSquarePower);
    return Math.max(-70.0, Math.min(10.0, Number(lufs.toFixed(2))));
  }

  /**
   * Calculates the exact compensation gain required to match target loudness to reference loudness.
   * @param {number} refLufs - Loudness of original / reference track
   * @param {number} targetLufs - Loudness of equalized / processed track
   * @returns {{ makeupGain: number, makeupDb: number }}
   */
  calculateMakeup(refLufs, targetLufs) {
    if (!this.enabled || typeof refLufs !== 'number' || typeof targetLufs !== 'number') {
      return { makeupGain: 1.0, makeupDb: 0.0 };
    }
    // If target is quieter than ref by 3 dB, makeupDb = +3 dB
    // If target is boosted by +6 dB, makeupDb = -6 dB
    let deltaDb = refLufs - targetLufs;

    // Clamp within safety bounds to prevent clipping or excessive attenuation
    deltaDb = Math.max(-this.maxCompensationDb, Math.min(this.maxCompensationDb, deltaDb));

    const makeupGain = Math.pow(10, deltaDb / 20);
    this.currentMakeupGain = makeupGain;
    this.currentMakeupDb = deltaDb;

    return {
      makeupGain,
      makeupDb: Number(deltaDb.toFixed(2))
    };
  }

  /**
   * Smoothly applies calculated loudness compensation to a Web Audio GainNode.
   * @param {GainNode} gainNode - Target GainNode in signal path
   * @param {number} targetGain - Linear gain factor
   * @param {AudioContext} audioCtx - Active AudioContext
   * @param {number} [rampTimeSec=0.035] - Smooth exponential/linear ramp time
   */
  applyToGainNode(gainNode, targetGain, audioCtx, rampTimeSec = 0.035) {
    if (!gainNode || !audioCtx) return;
    const now = audioCtx.currentTime;
    const safeGain = Math.max(0.0001, Math.min(4.0, targetGain));
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.setTargetAtTime(safeGain, now, rampTimeSec);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EarlisthenicLoudnessMatcher };
}
