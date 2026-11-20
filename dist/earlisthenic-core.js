/* Earlisthenic High-Performance Core Engine Bundle v2.10.16 */

/* ==================== [MODULE: AudioEngine.html] ==================== */

/**
 * Earlisthenic — AudioEngine.html
 * True Linear-Phase symmetric FIR Convolver EQ engine (Web Audio ConvolverNode with
 * normalize=false and dual-convolver click-free crossfade), exact RBJ magnitude synthesis,
 * latency-matched unit-impulse flat bypass, pure L/R stereo preservation, transparent linear
 * safety headroom, peak metering, and isolated UI SFX cues.
 *
 * Signal Path:
 * Selected Source (Studio Loop / Local File)
 *   + Feedback Oscillator (when in Feedback Eliminator mode)
 *   → inputTrimNode (GainNode)
 *   → preEqAnalyser (AnalyserNode)
 *   → Dual Linear-Phase FIR Convolver Bank (eqConvolverA/B, normalize=false, equal delay M=(N-1)/2)
 *   → pannerNode (StereoPannerNode — clean transparent center pan)
 *   → postEqAnalyser (AnalyserNode)
 *   → headroomGainNode (clean linear attenuation; prevents saturation)
 *   → masterGainNode (GainNode)
 *   → limiterNode (DynamicsCompressorNode configured purely as -0.2 dBFS emergency DAC ceiling)
 *   → audioCtx.destination
 *
 * UI SFX Path (isolated from exercise analysers):
 *   SFX Oscillator → sfxGainNode → masterGainNode
 */

const LINEAR_PHASE_FFT_SIZE = 8192;
const LINEAR_PHASE_TAPS = 8191; // Odd length => exact integer center sample M = 4095
const LINEAR_PHASE_CENTER = (LINEAR_PHASE_TAPS - 1) / 2;
const LINEAR_HEADROOM_GAIN = Math.pow(10, -3.5 / 20); // -3.5 dB static headroom

const SUPPORTED_SAMPLE_RATES = [44100, 48000, 88200, 96000, 176400, 192000];
const SUPPORTED_BIT_DEPTHS = ['64f', '32f', '24', '16'];
const DEFAULT_AUDIO_SAMPLE_RATE = 'auto'; // Match Windows/Soundcard/DAC native clock (zero browser mixer SRC)
const DEFAULT_AUDIO_BIT_DEPTH = '64f'; // Max precision: 64-bit float FIR math + max native 32-bit float bus

const _cachedFftTablesBySize = {};
function getLinearPhaseFftTables_(fftSize) {
  const N = fftSize || LINEAR_PHASE_FFT_SIZE;
  if (_cachedFftTablesBySize[N]) {
    return _cachedFftTablesBySize[N];
  }
  const bits = Math.round(Math.log2(N));
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  const cosTable = new Float64Array(N / 2);
  const sinTable = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    const angle = (2 * Math.PI * i) / N; // +2pi for IFFT
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }
  const bhWindow = new Float64Array(LINEAR_PHASE_TAPS);
  const hannWindow = new Float64Array(LINEAR_PHASE_TAPS);
  const denom = LINEAR_PHASE_TAPS - 1;
  for (let n = 0; n < LINEAR_PHASE_TAPS; n++) {
    const p = (2 * Math.PI * n) / denom;
    bhWindow[n] = 0.35875 - 0.48829 * Math.cos(p) + 0.14128 * Math.cos(2 * p) - 0.01168 * Math.cos(3 * p);
    hannWindow[n] = 0.5 * (1 - Math.cos(p));
  }
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const entry = { N, rev, cosTable, sinTable, bhWindow, hannWindow, re, im };
  _cachedFftTablesBySize[N] = entry;
  return entry;
}

class EarlisthenicAudioEngine {
  constructor() {
    this.audioCtx = null;
    this.inputTrimNode = null;
    this.preEqAnalyser = null;

    // Dual Linear-Phase FIR Convolver Bank + direct unity wire bypass for transparent flat listening
    this.eqConvolverA = null;
    this.eqConvolverB = null;
    this.eqGainA = null;
    this.eqGainB = null;
    this.directBypassGainNode = null;
    this.activeConvolverSlot = 'A';
    this.flatBypassBuffer = null;

    // Zero-latency lock-free Biquad sweep path for glitch-free 60-240fps interactive sweeps
    this.sweepFilter1 = null;
    this.sweepFilter2 = null;
    this.sweepGainNode = null;
    this._isSweepBusActive = false;

    this.pannerNode = null;
    this.postSumNode = null;
    this.postEqAnalyser = null;
    this.stereoSplitter = null;
    this.postAnalyserL = null;
    this.postAnalyserR = null;
    this.timeDomainBufferL = null;
    this.timeDomainBufferR = null;
    this.headroomGainNode = null;
    this.masterGainNode = null;
    this.limiterNode = null;

    // Active source tracking
    this.activeBufferSource = null;
    this.activeSourceGain = null;
    this.activeLoopStartSec = 0;
    this.activeLoopEndSec = 0;
    this.nextLoopWrapCtxTime = 0;
    this.feedbackOscNode = null;
    this.feedbackGainNode = null;

    // Metering & high-resolution FFT configuration
    this.fftSize = 4096;
    this.smoothingTimeConstant = 0.72;
    this.analyserTap = 'post'; // 'pre' | 'post'
    this.inputTrimDb = 0.0;
    this.masterVolumePct = 100;
    this.peakDbFs = -Infinity;
    this.clipDetected = false;
    this.timeDomainBuffer = null;

    // Audio format engine defaults: lock natively to OS/DAC sample rate ('auto') in transparent 32-bit float
    this.requestedSampleRate = DEFAULT_AUDIO_SAMPLE_RATE;
    this.actualSampleRate = null;
    this.bitDepth = DEFAULT_AUDIO_BIT_DEPTH;
    this.quantizerNode = null;
    this.ditherGainNode = null;

    // Current DSP state & throttling (pre-allocated kernel scratch eliminates drag GC churn)
    this.listenMode = 'target'; // 'original' | 'target' | 'user'
    this.currentDspSpec = null;
    this._lastFirSignature = '';
    this._lastFirSwapMs = 0;
    this._pendingFirTimer = null;
    this._pendingFirSpec = null;
    this._convolverIdleTimer = null;
    this._reusableFirKernel = new Float32Array(LINEAR_PHASE_TAPS);
  }

  static normalizeSampleRate(sr) {
    if (sr === 'auto' || sr === '' || sr == null) return 'auto';
    const str = String(sr).trim().toLowerCase();
    if (str === 'auto' || str === 'native') return 'auto';
    const num = Math.round(Number(sr));
    return SUPPORTED_SAMPLE_RATES.includes(num) ? num : 'auto';
  }

  static normalizeBitDepth(depth) {
    const val = String(depth || DEFAULT_AUDIO_BIT_DEPTH).trim();
    return SUPPORTED_BIT_DEPTHS.includes(val) ? val : DEFAULT_AUDIO_BIT_DEPTH;
  }

  static getBitDepthLabel(depth) {
    switch (EarlisthenicAudioEngine.normalizeBitDepth(depth)) {
      case '64f': return '64-bit float';
      case '24': return '24-bit PCM';
      case '16': return '16-bit PCM';
      case '32f':
      default:
        return '32-bit float';
    }
  }

  /**
   * Lazily initializes or resumes AudioContext synced natively to OS/DAC sample rate ('auto')
   * or an explicit numeric sample rate when supplied.
   */
  ensureContext() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('Web Audio API is not supported in this browser.');
      }
      const req = EarlisthenicAudioEngine.normalizeSampleRate(this.requestedSampleRate);
      try {
        const ctxOpts = req === 'auto'
          ? { latencyHint: 'balanced' }
          : { sampleRate: req, latencyHint: 'balanced' };
        this.audioCtx = new AudioContextClass(ctxOpts);
      } catch (rateErr) {
        this.audioCtx = new AudioContextClass();
      }
      this.actualSampleRate = (this.audioCtx && this.audioCtx.sampleRate)
        ? this.audioCtx.sampleRate
        : (typeof req === 'number' ? req : 48000);
      this._buildGraph();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(err => {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('AudioContext resume deferred:', err && err.message ? err.message : err);
        }
      });
    }
    return this.audioCtx;
  }

  getAudioFormatStatus() {
    const req = EarlisthenicAudioEngine.normalizeSampleRate(this.requestedSampleRate);
    const act = (this.audioCtx && this.audioCtx.sampleRate)
      ? this.audioCtx.sampleRate
      : (this.actualSampleRate || (typeof req === 'number' ? req : null));
    const nativeMode = req === 'auto';
    return {
      requestedSampleRate: req,
      actualSampleRate: act,
      nativeOsSync: nativeMode,
      bitDepth: this.bitDepth || DEFAULT_AUDIO_BIT_DEPTH,
      bitDepthLabel: EarlisthenicAudioEngine.getBitDepthLabel(this.bitDepth),
      resampledByHardware: Boolean(!nativeMode && this.audioCtx && act && act !== req)
    };
  }

  async resyncNativeAudioClock() {
    return this.setAudioFormat({ sampleRate: 'auto', bitDepth: '64f', forceRebuild: true });
  }

  /**
   * Syncs AudioContext to OS/DAC clock ('auto') or explicit sampleRate, preserving pure DSP state.
   */
  async setAudioFormat(options) {
    const opts = options || {};
    const nextSr = opts.sampleRate != null
      ? EarlisthenicAudioEngine.normalizeSampleRate(opts.sampleRate)
      : this.requestedSampleRate;
    const nextDepth = opts.bitDepth != null
      ? EarlisthenicAudioEngine.normalizeBitDepth(opts.bitDepth)
      : this.bitDepth;

    const srChanged = Boolean(opts.forceRebuild)
      || nextSr !== this.requestedSampleRate
      || (typeof nextSr === 'number' && this.audioCtx && this.audioCtx.sampleRate && this.audioCtx.sampleRate !== nextSr);
    const depthChanged = nextDepth !== this.bitDepth;

    this.requestedSampleRate = nextSr;
    this.bitDepth = nextDepth;

    if (srChanged && this.audioCtx) {
      if (this._pendingFirTimer) {
        clearTimeout(this._pendingFirTimer);
        this._pendingFirTimer = null;
        this._pendingFirSpec = null;
      }
      if (this._convolverIdleTimer) {
        clearTimeout(this._convolverIdleTimer);
        this._convolverIdleTimer = null;
      }
      const oldCtx = this.audioCtx;
      const oldMaster = this.masterGainNode;
      const prevDspSpec = this.currentDspSpec;
      const hadActivePlayback = Boolean(this.activeBufferSource);
      if (oldMaster && oldMaster.gain && oldCtx.currentTime != null) {
        try {
          oldMaster.gain.cancelScheduledValues(oldCtx.currentTime);
          oldMaster.gain.setValueAtTime(oldMaster.gain.value, oldCtx.currentTime);
          oldMaster.gain.linearRampToValueAtTime(0.0, oldCtx.currentTime + 0.015);
        } catch (e) {}
      }
      this.activeBufferSource = null;
      this.activeSourceGain = null;
      this.feedbackOscNode = null;
      this.feedbackGainNode = null;
      this.audioCtx = null;
      this.inputTrimNode = null;
      this.preEqAnalyser = null;
      this.eqConvolverA = null;
      this.eqConvolverB = null;
      this.eqGainA = null;
      this.eqGainB = null;
      this.directBypassGainNode = null;
      this.sweepFilter1 = null;
      this.sweepFilter2 = null;
      this.sweepGainNode = null;
      this.quantizerNode = null;
      this.ditherGainNode = null;
      this.pannerNode = null;
      this.postSumNode = null;
      this.postEqAnalyser = null;
      this.headroomGainNode = null;
      this.masterGainNode = null;
      this.limiterNode = null;
      this.flatBypassBuffer = null;
      this._lastFirSignature = '';
      this._isSweepBusActive = false;

      // Drain and close the previous AudioContext before reading OS/DAC clock cleanly
      if (oldCtx && typeof oldCtx.close === 'function') {
        if (hadActivePlayback) {
          await new Promise(resolve => setTimeout(resolve, 18));
        }
        try {
          await Promise.race([
            Promise.resolve(oldCtx.close()).catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 40))
          ]);
        } catch (e) {}
      }
      this.ensureContext();
      if (prevDspSpec) {
        this.applyDspConfiguration(prevDspSpec);
      }
    } else if (!this.audioCtx) {
      this.ensureContext();
    }

    return Object.assign(this.getAudioFormatStatus(), { srChanged, depthChanged });
  }

  /**
   * Adjusts analyser FFT size dynamically per device hardware tier (2048 | 4096 | 8192).
   */
  setFftSize(size) {
    const valid = [2048, 4096, 8192].includes(size) ? size : 4096;
    this.fftSize = valid;
    if (this.preEqAnalyser) this.preEqAnalyser.fftSize = valid;
    if (this.postEqAnalyser) {
      this.postEqAnalyser.fftSize = valid;
      this.timeDomainBuffer = new Float32Array(valid);
    }
  }

  /**
   * Constructs and connects all Web Audio nodes explicitly.
   */
  _buildGraph() {
    const ctx = this.audioCtx;
    const sr = ctx.sampleRate || 48000;

    this.inputTrimNode = ctx.createGain();
    this.inputTrimNode.gain.value = Math.pow(10, (this.inputTrimDb || 0) / 20);

    this.preEqAnalyser = ctx.createAnalyser();
    this.preEqAnalyser.fftSize = this.fftSize;
    this.preEqAnalyser.smoothingTimeConstant = this.smoothingTimeConstant;

    // Flat unit-impulse Linear-Phase buffer (created lazily only if needed)
    this.flatBypassBuffer = null;

    // Direct zero-DSP unity bypass path (used whenever flat / Original / Lobby listening)
    this.directBypassGainNode = ctx.createGain();
    this.directBypassGainNode.gain.value = 1.0;

    // Dual Convolvers (CRITICAL: normalize=false preserves exact EQ gain & stereo image!
    // Leave buffers null while in direct bypass so zero FFT convolution executes at idle.)
    this.eqConvolverA = ctx.createConvolver();
    this.eqConvolverA.normalize = false;
    this.eqConvolverA.buffer = null;
    this.eqGainA = ctx.createGain();
    this.eqGainA.gain.value = 0.0;

    this.eqConvolverB = ctx.createConvolver();
    this.eqConvolverB.normalize = false;
    this.eqConvolverB.buffer = null;
    this.eqGainB = ctx.createGain();
    this.eqGainB.gain.value = 0.0;
    this.activeConvolverSlot = 'A';

    // Real-time parameter-automated sweep branch (muted at idle; zero buffer swaps while sweeping)
    this.sweepFilter1 = ctx.createBiquadFilter();
    this.sweepFilter1.type = 'peaking';
    this.sweepFilter1.frequency.value = 1000;
    this.sweepFilter1.Q.value = 1.0;
    this.sweepFilter1.gain.value = 0.0;

    this.sweepFilter2 = ctx.createBiquadFilter();
    this.sweepFilter2.type = 'peaking';
    this.sweepFilter2.frequency.value = 1000;
    this.sweepFilter2.Q.value = 1.0;
    this.sweepFilter2.gain.value = 0.0;

    this.sweepGainNode = ctx.createGain();
    this.sweepGainNode.gain.value = 0.0;
    this._isSweepBusActive = false;

    if (typeof ctx.createStereoPanner === 'function') {
      this.pannerNode = ctx.createStereoPanner();
      this.pannerNode.pan.value = 0;
    } else {
      // Fallback transparent unity node with pan-compatible API for restricted WebViews
      const fallbackGain = ctx.createGain();
      fallbackGain.gain.value = 1.0;
      fallbackGain.pan = { value: 0, setTargetAtTime: () => {} };
      this.pannerNode = fallbackGain;
    }

    this.postSumNode = ctx.createGain();
    this.postSumNode.gain.value = 1.0;

    this.postEqAnalyser = ctx.createAnalyser();
    this.postEqAnalyser.fftSize = this.fftSize;
    this.postEqAnalyser.smoothingTimeConstant = this.smoothingTimeConstant;

    // Clean -3.5 dB static linear headroom in Arena EQ mode; immediate unity 1.0 in Lobby/bypass
    this.headroomGainNode = ctx.createGain();
    this.headroomGainNode.gain.value = (this.currentDspSpec && this.currentDspSpec.bypassHeadroom)
      ? 1.0
      : LINEAR_HEADROOM_GAIN;

    this.masterGainNode = ctx.createGain();
    this.masterGainNode.gain.value = this.masterVolumePct / 100;

    // No DynamicsCompressorNode in live output stage: Chromium's lookahead/emphasis compressor
    // colors flat high-res audio, chokes low-mids, and narrows stereo image.
    this.limiterNode = null;

    // Connect direct unity bypass + dual linear-phase DSP chain + parallel live sweep path.
    // Analysers are strictly parallel side-chain taps so raw audio never transits an AnalyserNode.
    this.inputTrimNode.connect(this.preEqAnalyser);
    this.inputTrimNode.connect(this.directBypassGainNode);
    this.directBypassGainNode.connect(this.postSumNode);

    this.inputTrimNode.connect(this.eqConvolverA);
    this.inputTrimNode.connect(this.eqConvolverB);
    this.eqConvolverA.connect(this.eqGainA);
    this.eqConvolverB.connect(this.eqGainB);
    this.eqGainA.connect(this.pannerNode);
    this.eqGainB.connect(this.pannerNode);

    this.inputTrimNode.connect(this.sweepFilter1);
    this.sweepFilter1.connect(this.sweepFilter2);
    this.sweepFilter2.connect(this.sweepGainNode);
    this.sweepGainNode.connect(this.pannerNode);

    this.pannerNode.connect(this.postSumNode);
    this.postSumNode.connect(this.postEqAnalyser);

    if (typeof ctx.createChannelSplitter === 'function') {
      try {
        this.stereoSplitter = ctx.createChannelSplitter(2);
        this.postAnalyserL = ctx.createAnalyser();
        this.postAnalyserR = ctx.createAnalyser();
        this.postAnalyserL.fftSize = 512;
        this.postAnalyserR.fftSize = 512;
        this.postAnalyserL.smoothingTimeConstant = 0.2;
        this.postAnalyserR.smoothingTimeConstant = 0.2;
        this.postSumNode.connect(this.stereoSplitter);
        this.stereoSplitter.connect(this.postAnalyserL, 0);
        this.stereoSplitter.connect(this.postAnalyserR, 1);
        this.timeDomainBufferL = new Float32Array(512);
        this.timeDomainBufferR = new Float32Array(512);
      } catch (err) {
        this.stereoSplitter = null;
        this.postAnalyserL = null;
        this.postAnalyserR = null;
      }
    }

    this.postSumNode.connect(this.headroomGainNode);
    this.headroomGainNode.connect(this.masterGainNode);

    // Pure bit-transparent direct wire to hardware output (zero WaveShaper, zero synthetic dither)
    this.quantizerNode = null;
    this.ditherGainNode = null;
    this.masterGainNode.connect(ctx.destination);

    this.timeDomainBuffer = new Float32Array(this.postEqAnalyser.fftSize);
  }

  /**
   * Disconnects and stops any active buffer source node cleanly.
   */
  disconnectActiveSources() {
    if (this.activeSourceGain && this.audioCtx) {
      try {
        if (typeof this.activeSourceGain.gain.cancelScheduledValues === 'function') {
          this.activeSourceGain.gain.cancelScheduledValues(this.audioCtx.currentTime);
        }
      } catch (e) {}
    }
    this.nextLoopWrapCtxTime = 0;

    if (this.activeBufferSource) {
      try {
        this.activeBufferSource.onended = null;
        this.activeBufferSource.stop();
      } catch (e) {}
      try {
        this.activeBufferSource.disconnect();
      } catch (e) {}
      this.activeBufferSource = null;
    }
    if (this.activeSourceGain) {
      try {
        this.activeSourceGain.disconnect();
      } catch (e) {}
      this.activeSourceGain = null;
    }

    this.stopFeedbackOscillator();
  }

  /**
   * Schedules smooth, click-free boundary fade-in/fade-out ramps on activeSourceGain
   * whenever audio loops back from loopEnd to loopStart. Eliminates abrupt transient
   * blasts, startle, and DC/phase discontinuity pops.
   */
  scheduleLoopBoundaryFades(lookaheadSec = 8.0) {
    if (!this.activeSourceGain || !this.activeSourceGain.gain) return;
    if (!this.activeBufferSource || !this.audioCtx) return;

    const now = this.audioCtx.currentTime;
    const s = this.activeLoopStartSec || 0;
    const e = this.activeLoopEndSec || 0;
    const loopLen = e - s;
    if (loopLen <= 0.1) return;

    // Boundary fade: 40ms to 80ms based on loop length (guarantees zero overlap on short loops)
    const maxAllowedFade = Math.max(0.02, loopLen * 0.2);
    const fade = Math.max(0.025, Math.min(0.08, Math.min(maxAllowedFade, loopLen * 0.12)));

    let guard = 0;
    while (this.nextLoopWrapCtxTime < now + lookaheadSec && guard < 60) {
      guard++;
      const tWrap = this.nextLoopWrapCtxTime;
      if (tWrap > now) {
        const tFadeStart = Math.max(now, tWrap - fade);
        try {
          this.activeSourceGain.gain.setValueAtTime(1.0, tFadeStart);
          this.activeSourceGain.gain.linearRampToValueAtTime(0.0, tWrap);
          this.activeSourceGain.gain.linearRampToValueAtTime(1.0, tWrap + fade);
        } catch (err) {}
      }
      this.nextLoopWrapCtxTime += loopLen;
    }
  }

  /**
   * Starts looping an AudioBuffer between loopStartSec and loopEndSec with smooth transient-safe
   * initial fade-in and automatic seamless loop wrap boundary cross-fades.
   */
  startBufferLoop(audioBuffer, loopStartSec, loopEndSec, startOffsetSec) {
    this.ensureContext();
    this.disconnectActiveSources();
    if (!audioBuffer) return false;

    const dur = audioBuffer.duration;
    const safeStart = Math.max(0, Math.min(dur - 0.1, loopStartSec || 0));
    const safeEnd = Math.max(safeStart + 0.1, Math.min(dur, loopEndSec || dur));
    const offset = Math.max(safeStart, Math.min(safeEnd - 0.02, startOffsetSec != null ? startOffsetSec : safeStart));

    const now = this.audioCtx.currentTime;
    const loopLen = safeEnd - safeStart;
    const initFadeIn = Math.max(0.03, Math.min(0.08, loopLen * 0.12));

    const srcGain = this.audioCtx.createGain();
    srcGain.gain.setValueAtTime(0.0, now);
    srcGain.gain.linearRampToValueAtTime(1.0, now + initFadeIn);

    const src = this.audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;
    src.loopStart = safeStart;
    src.loopEnd = safeEnd;
    src.connect(srcGain);
    srcGain.connect(this.inputTrimNode);
    src.start(0, offset);

    this.activeSourceGain = srcGain;
    this.activeBufferSource = src;
    this.activeLoopStartSec = safeStart;
    this.activeLoopEndSec = safeEnd;

    const timeToFirstWrap = Math.max(0.02, safeEnd - offset);
    this.nextLoopWrapCtxTime = now + timeToFirstWrap;
    this.scheduleLoopBoundaryFades(8.0);

    return {
      startedAtContextTime: now,
      loopStartSec: safeStart,
      loopEndSec: safeEnd,
      offsetSec: offset
    };
  }

  /**
   * Seamlessly crossfades (18ms equal-sum ramp) from the currently playing buffer
   * onto a newly expanded or completed buffer at the exact continuing offset without clipping.
   */
  hotSwapBufferLoop(audioBuffer, loopStartSec, loopEndSec, startOffsetSec) {
    if (!this.activeBufferSource || !this.activeSourceGain) {
      return this.startBufferLoop(audioBuffer, loopStartSec, loopEndSec, startOffsetSec);
    }
    this.ensureContext();
    if (!audioBuffer) return false;

    const oldSrc = this.activeBufferSource;
    const oldGain = this.activeSourceGain;
    const dur = audioBuffer.duration;
    const safeStart = Math.max(0, Math.min(dur - 0.1, loopStartSec || 0));
    const safeEnd = Math.max(safeStart + 0.1, Math.min(dur, loopEndSec || dur));
    const offset = Math.max(safeStart, Math.min(safeEnd - 0.02, startOffsetSec != null ? startOffsetSec : safeStart));

    const now = this.audioCtx.currentTime;
    const fadeSec = 0.018;

    try {
      if (typeof oldGain.gain.cancelScheduledValues === 'function') oldGain.gain.cancelScheduledValues(now);
      oldGain.gain.setValueAtTime(typeof oldGain.gain.value === 'number' ? oldGain.gain.value : 1.0, now);
      oldGain.gain.linearRampToValueAtTime(0.0, now + fadeSec);
    } catch (e) {}
    try { oldSrc.stop(now + fadeSec + 0.004); } catch (e) {}
    oldSrc.onended = () => {
      try { oldSrc.disconnect(); } catch (e) {}
      try { oldGain.disconnect(); } catch (e) {}
    };

    const srcGain = this.audioCtx.createGain();
    srcGain.gain.setValueAtTime(0.0, now);
    srcGain.gain.linearRampToValueAtTime(1.0, now + fadeSec);

    const src = this.audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;
    src.loopStart = safeStart;
    src.loopEnd = safeEnd;
    src.connect(srcGain);
    srcGain.connect(this.inputTrimNode);
    src.start(0, offset);

    this.activeSourceGain = srcGain;
    this.activeBufferSource = src;
    this.activeLoopStartSec = safeStart;
    this.activeLoopEndSec = safeEnd;

    const timeToFirstWrap = Math.max(0.02, safeEnd - offset);
    this.nextLoopWrapCtxTime = now + timeToFirstWrap;
    this.scheduleLoopBoundaryFades(8.0);

    return {
      startedAtContextTime: now,
      loopStartSec: safeStart,
      loopEndSec: safeEnd,
      offsetSec: offset
    };
  }

  /**
   * Updates loop points on a currently playing AudioBufferSourceNode without restarting,
   * cleanly resetting scheduled boundary fade ramps to match newly dragged bounds.
   */
  updateActiveLoopBounds(loopStartSec, loopEndSec, currentPosSec) {
    if (this.activeBufferSource && this.activeBufferSource.buffer) {
      const dur = this.activeBufferSource.buffer.duration;
      const s = Math.max(0, Math.min(dur - 0.1, loopStartSec));
      const e = Math.max(s + 0.1, Math.min(dur, loopEndSec));
      this.activeBufferSource.loopStart = s;
      this.activeBufferSource.loopEnd = e;
      this.activeLoopStartSec = s;
      this.activeLoopEndSec = e;

      if (this.activeSourceGain && this.audioCtx) {
        const now = this.audioCtx.currentTime;
        const loopLen = e - s;
        try {
          if (typeof this.activeSourceGain.gain.cancelScheduledValues === 'function') {
            this.activeSourceGain.gain.cancelScheduledValues(now);
          }
          this.activeSourceGain.gain.setValueAtTime(1.0, now);
        } catch (err) {}

        const pos = (typeof currentPosSec === 'number' && isFinite(currentPosSec)) ? currentPosSec : s;
        const timeToNext = (pos < e) ? Math.max(0.02, e - pos) : loopLen;
        this.nextLoopWrapCtxTime = now + timeToNext;
        this.scheduleLoopBoundaryFades(8.0);
      }
    }
  }

  /**
   * Starts or updates the continuous sine feedback tone for Feedback Eliminator.
   * Routed into `inputTrimNode` BEFORE the Linear-Phase Convolver so the user's selected
   * ISO notch filter genuinely attenuates the feedback oscillator with zero phase smear!
   */
  syncFeedbackTone(enabled, targetFrequencyHz, isOriginalBypass) {
    if (!enabled || !this.audioCtx) {
      this.stopFeedbackOscillator();
      return;
    }

    const now = this.audioCtx.currentTime;
    if (!this.feedbackOscNode) {
      this.feedbackOscNode = this.audioCtx.createOscillator();
      this.feedbackGainNode = this.audioCtx.createGain();
      this.feedbackOscNode.type = 'sine';
      this.feedbackOscNode.frequency.setValueAtTime(targetFrequencyHz || 1000, now);
      this.feedbackGainNode.gain.setValueAtTime(0.0001, now);

      // Connect into inputTrimNode so Linear-Phase FIR notch attenuates the feedback tone!
      this.feedbackOscNode.connect(this.feedbackGainNode);
      this.feedbackGainNode.connect(this.inputTrimNode);
      this.feedbackOscNode.start(now);
    } else {
      this.feedbackOscNode.frequency.setTargetAtTime(targetFrequencyHz || 1000, now, 0.012);
    }

    const targetAmp = isOriginalBypass ? 0.0001 : 0.14;
    this.feedbackGainNode.gain.setTargetAtTime(targetAmp, now, 0.02);
  }

  stopFeedbackOscillator() {
    if (this.feedbackOscNode) {
      try {
        this.feedbackOscNode.stop();
      } catch (e) {}
      try {
        this.feedbackOscNode.disconnect();
      } catch (e) {}
      this.feedbackOscNode = null;
    }
    if (this.feedbackGainNode) {
      try {
        this.feedbackGainNode.disconnect();
      } catch (e) {}
      this.feedbackGainNode = null;
    }
  }

  /**
   * Sets input trim in dB (-12 dB to +6 dB).
   */
  setInputTrimDb(db) {
    const clamped = Math.max(-12, Math.min(6, Number(db) || 0));
    this.inputTrimDb = clamped;
    const linear = Math.pow(10, clamped / 20);
    if (this.inputTrimNode && this.audioCtx) {
      this.inputTrimNode.gain.setTargetAtTime(linear, this.audioCtx.currentTime, 0.015);
    }
  }

  /**
   * Sets master output level (0 to 100%).
   */
  setMasterVolumePct(pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    this.masterVolumePct = clamped;
    if (this.masterGainNode && this.audioCtx) {
      this.masterGainNode.gain.setTargetAtTime(clamped / 100, this.audioCtx.currentTime, 0.015);
    }
  }

  /**
   * Creates a unit-impulse symmetric Linear-Phase bypass kernel (pure integer sample delay M).
   */
  static createFlatLinearPhaseKernel() {
    const h = new Float32Array(LINEAR_PHASE_TAPS);
    h[LINEAR_PHASE_CENTER] = 1.0;
    return h;
  }

  /**
   * Resolves the filter chain stages (`bands`) + stereo pan from a DSP configuration spec.
   */
  static resolveDspBandsFromSpec(spec) {
    const s = spec || {};
    const mode = s.listenState || 'target';
    if (s.gameMode === 'feedback') {
      if (mode === 'original') {
        return { isFlat: true, pan: 0, bands: [] };
      }
      return {
        isFlat: false,
        pan: 0,
        bands: [{ type: 'notch', freq: s.userFreq || 1000, gain: 0, q: 10.0 }]
      };
    }

    if (mode === 'original') {
      return { isFlat: true, pan: 0, bands: [] };
    }

    const isUser = mode === 'user';
    switch (s.gameMode) {
      case 'peak':
      case 'bass':
        return {
          isFlat: false,
          pan: 0,
          bands: [{
            type: 'peaking',
            freq: isUser ? s.userFreq : s.targetFreq,
            gain: Math.abs(Number(s.targetGain) || 0),
            q: Number(s.targetQ) || 2.0
          }]
        };
      case 'cut':
        return {
          isFlat: false,
          pan: 0,
          bands: [{
            type: 'peaking',
            freq: isUser ? s.userFreq : s.targetFreq,
            gain: -Math.abs(Number(s.targetGain) || 0) - 1.5,
            q: Number(s.targetQ) || 2.0
          }]
        };
      case 'mirror':
      case 'cheetah':
        return {
          isFlat: false,
          pan: 0,
          bands: [{
            type: 'peaking',
            freq: isUser ? s.userFreq : s.targetFreq,
            gain: isUser ? (Number(s.userGain) || 0) : (Number(s.targetGain) || 0),
            q: Number(s.targetQ) || 2.0
          }]
        };
      case 'filter': {
        const fType = isUser ? (s.userFilterType || 'lowpass') : (s.targetFilterType || 'lowpass');
        const qVal = fType === 'notch' ? 4.5 : (fType === 'bandpass' ? 2.2 : 0.707);
        return {
          isFlat: false,
          pan: 0,
          bands: [{
            type: fType,
            freq: isUser ? s.userFreq : s.targetFreq,
            gain: 0,
            q: qVal
          }]
        };
      }
      case 'knight': {
        const curve = s.activeKnightCurve;
        const bands = [];
        if (curve && curve.b1) bands.push(curve.b1);
        if (curve && curve.b2) bands.push(curve.b2);
        return { isFlat: bands.length === 0, pan: 0, bands };
      }
      default:
        return { isFlat: true, pan: 0, bands: [] };
    }
  }

  /**
   * Computes an exact symmetric odd-length Zero-Phase / Linear-Phase FIR impulse response
   * from any multi-band EQ specification via Radix-2 Hermitian IFFT + Blackman-Harris windowing.
   * Guarantees exact symmetry h[n] === h[N-1-n] (zero phase distortion & zero stereo shift).
   */
  static synthesizeLinearPhaseKernel(bands, sampleRate, outKernel) {
    if (!Array.isArray(bands) || bands.length === 0) {
      if (outKernel && outKernel.length === LINEAR_PHASE_TAPS) {
        outKernel.fill(0);
        outKernel[LINEAR_PHASE_CENTER] = 1.0;
        return outKernel;
      }
      return EarlisthenicAudioEngine.createFlatLinearPhaseKernel();
    }

    const Fs = sampleRate || 48000;
    // Scale FFT bin resolution with sample rate so low-mid bin width stays ~5.86 Hz/bin up to 192 kHz
    const fftN = Fs >= 176400 ? 32768 : (Fs >= 88200 ? 16384 : LINEAR_PHASE_FFT_SIZE);
    const { N, rev, cosTable, sinTable, bhWindow, hannWindow, re, im } = getLinearPhaseFftTables_(fftN);
    const half = N / 2;
    const df = Fs / N;

    for (let k = 0; k <= half; k++) {
      const freq = k * df;
      let mag = 1.0;

      for (let b = 0; b < bands.length; b++) {
        const band = bands[b];
        if (!band) continue;
        let bMag;
        // Handle exact DC behavior directly on k === 0 without redundant biquad math
        if (k === 0) {
          if (band.type === 'highpass' || band.type === 'bandpass') bMag = 0.0;
          else if (band.type === 'lowshelf') bMag = Math.pow(10, (Number(band.gain) || 0) / 20);
          else if (band.type === 'lowpass') {
            bMag = EarlisthenicAudioEngine.computeBiquadLinearGain(10, band.type, band.freq, band.gain, band.q, Fs);
          } else {
            const dcBiquad = EarlisthenicAudioEngine.computeBiquadLinearGain(10, band.type, band.freq, band.gain, band.q, Fs);
            bMag = Math.min(1.5, Math.max(0.5, dcBiquad));
          }
        } else {
          bMag = EarlisthenicAudioEngine.computeBiquadLinearGain(freq, band.type, band.freq, band.gain, band.q, Fs);
          // Narrow low-frequency surgical notch refinement (ensures >=28 dB attenuation even at 31.5 Hz ISO)
          if (band.type === 'notch') {
            const bw = (Number(band.freq) || 1000) / Math.max(1, Number(band.q) || 10);
            if (bw < df * 2.5 && Math.abs(freq - band.freq) <= df * 1.15) {
              const distRatio = Math.abs(freq - band.freq) / (df * 1.15);
              const floorGain = 0.008 + 0.04 * distRatio * distRatio;
              if (floorGain < bMag) bMag = floorGain;
            }
          }
        }
        mag *= bMag;
      }

      re[k] = mag;
      im[k] = 0;
      if (k > 0 && k < half) {
        re[N - k] = mag;
        im[N - k] = 0;
      }
    }

    // In-place Radix-2 Cooley-Tukey IFFT
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }

    for (let size = 2; size <= N; size <<= 1) {
      const halfSize = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < halfSize; j++) {
          const twIdx = j * step;
          const wr = cosTable[twIdx];
          const wi = sinTable[twIdx];
          const even = i + j;
          const odd = even + halfSize;
          const tr = re[odd] * wr - im[odd] * wi;
          const ti = re[odd] * wi + im[odd] * wr;
          re[odd] = re[even] - tr;
          im[odd] = im[even] - ti;
          re[even] += tr;
          im[even] += ti;
        }
      }
    }

    // Center, apply Blackman-Harris window, and enforce strict mathematical symmetry
    const kernel = (outKernel && outKernel.length === LINEAR_PHASE_TAPS)
      ? outKernel
      : new Float32Array(LINEAR_PHASE_TAPS);
    const invN = 1.0 / N;
    for (let n = 0; n < LINEAR_PHASE_TAPS; n++) {
      const srcIdx = (n - LINEAR_PHASE_CENTER + N) % N;
      kernel[n] = re[srcIdx] * invN * bhWindow[n];
    }

    // Apply symmetric zero-phase Hann-windowed cosine null projection for notch bands
    // so surgical ISO notches (even 31.5 Hz & 50 Hz) achieve deep elimination with zero passband ripple
    for (let b = 0; b < bands.length; b++) {
      const band = bands[b];
      if (!band || band.type !== 'notch') continue;
      const wNotch = (2 * Math.PI * (Number(band.freq) || 1000)) / Fs;
      let gainAtNotch = 0;
      let norm = 0;
      for (let n = 0; n < LINEAR_PHASE_TAPS; n++) {
        const c = Math.cos(wNotch * (n - LINEAR_PHASE_CENTER));
        gainAtNotch += kernel[n] * c;
        norm += hannWindow[n] * c * c;
      }
      if (Math.abs(norm) > 1e-12) {
        const scale = gainAtNotch / norm;
        for (let n = 0; n < LINEAR_PHASE_TAPS; n++) {
          kernel[n] -= scale * hannWindow[n] * Math.cos(wNotch * (n - LINEAR_PHASE_CENTER));
        }
      }
    }

    for (let n = 0; n <= LINEAR_PHASE_CENTER; n++) {
      const mirror = LINEAR_PHASE_TAPS - 1 - n;
      const avg = 0.5 * (kernel[n] + kernel[mirror]);
      kernel[n] = avg;
      kernel[mirror] = avg;
    }

    return kernel;
  }

  /**
   * Builds an immutable identical-channel Stereo AudioBuffer from a symmetric FIR kernel
   * so active ConvolverNodes never share mutable backing memory across transitions.
   */
  _createStereoFirAudioBuffer(monoKernel, sampleRate) {
    const ctx = this.audioCtx;
    const buf = ctx.createBuffer(2, monoKernel.length, sampleRate);
    buf.getChannelData(0).set(monoKernel);
    buf.getChannelData(1).set(monoKernel);
    return buf;
  }

  /**
   * Steers a Web Audio BiquadFilterNode cleanly with zero allocation or re-buffering.
   */
  _applyBandToSweepBiquad(node, band, now, immediate) {
    if (!node) return;
    if (!band) {
      if (node.type !== 'peaking') node.type = 'peaking';
      if (immediate) {
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(0.0, now);
      } else {
        node.gain.setTargetAtTime(0.0, now, 0.004);
      }
      return;
    }
    const targetType = band.type || 'peaking';
    if (node.type !== targetType) node.type = targetType;
    const sr = (this.audioCtx && this.audioCtx.sampleRate) || 48000;
    const freq = Math.max(15, Math.min(sr * 0.48, Number(band.freq) || 1000));
    const q = Math.max(0.1, Number(band.q) || 1.0);
    const gain = (targetType === 'peaking' || targetType === 'lowshelf' || targetType === 'highshelf')
      ? (Number(band.gain) || 0)
      : 0.0;
    if (immediate) {
      node.frequency.cancelScheduledValues(now);
      node.Q.cancelScheduledValues(now);
      node.gain.cancelScheduledValues(now);
      node.frequency.setValueAtTime(freq, now);
      node.Q.setValueAtTime(q, now);
      node.gain.setValueAtTime(gain, now);
    } else {
      node.frequency.setTargetAtTime(freq, now, 0.004);
      node.Q.setTargetAtTime(q, now, 0.004);
      node.gain.setTargetAtTime(gain, now, 0.004);
    }
  }

  /**
   * Crossfades to the supplied stereo FIR buffer using the inactive convolver slot (or from the live sweep bus).
   */
  _activateDirectBypassClickFree(fromSweepBus = false) {
    const ctx = this.audioCtx;
    if (!ctx || !this.directBypassGainNode || !this.eqGainA || !this.eqGainB) return;

    if (this._convolverIdleTimer) {
      clearTimeout(this._convolverIdleTimer);
      this._convolverIdleTimer = null;
    }

    const now = ctx.currentTime;
    const xfadeSec = 0.018;
    const directGain = this.directBypassGainNode.gain;
    directGain.cancelScheduledValues(now);
    this.eqGainA.gain.cancelScheduledValues(now);
    this.eqGainB.gain.cancelScheduledValues(now);

    directGain.setValueAtTime(directGain.value, now);
    this.eqGainA.gain.setValueAtTime(this.eqGainA.gain.value, now);
    this.eqGainB.gain.setValueAtTime(this.eqGainB.gain.value, now);

    directGain.linearRampToValueAtTime(1.0, now + xfadeSec);
    this.eqGainA.gain.linearRampToValueAtTime(0.0, now + xfadeSec);
    this.eqGainB.gain.linearRampToValueAtTime(0.0, now + xfadeSec);

    if (fromSweepBus && this.sweepGainNode) {
      this.sweepGainNode.gain.cancelScheduledValues(now);
      this.sweepGainNode.gain.setValueAtTime(this.sweepGainNode.gain.value, now);
      this.sweepGainNode.gain.linearRampToValueAtTime(0.0, now + xfadeSec);
    }

    // Release Convolver buffers once fade-out completes so zero FFT processing runs in bypass
    this._convolverIdleTimer = setTimeout(() => {
      this._convolverIdleTimer = null;
      if (this.audioCtx === ctx && this._lastFirSignature === 'FLAT' && !this._isSweepBusActive) {
        if (this.eqConvolverA) this.eqConvolverA.buffer = null;
        if (this.eqConvolverB) this.eqConvolverB.buffer = null;
      }
    }, 30);
  }

  _swapConvolverBufferClickFree(stereoAudioBuffer, fromSweepBus = false) {
    const ctx = this.audioCtx;
    if (!ctx || !stereoAudioBuffer || !this.eqConvolverA || !this.eqConvolverB) return;

    if (this._convolverIdleTimer) {
      clearTimeout(this._convolverIdleTimer);
      this._convolverIdleTimer = null;
    }

    const now = ctx.currentTime;
    const xfadeSec = 0.018;
    const toB = this.activeConvolverSlot === 'A';
    const nextConv = toB ? this.eqConvolverB : this.eqConvolverA;
    const prevConv = toB ? this.eqConvolverA : this.eqConvolverB;
    const nextGain = toB ? this.eqGainB : this.eqGainA;
    const prevGain = toB ? this.eqGainA : this.eqGainB;

    nextConv.buffer = stereoAudioBuffer;
    nextGain.gain.cancelScheduledValues(now);
    prevGain.gain.cancelScheduledValues(now);

    if (this.directBypassGainNode) {
      const directGain = this.directBypassGainNode.gain;
      directGain.cancelScheduledValues(now);
      directGain.setValueAtTime(directGain.value, now);
      directGain.linearRampToValueAtTime(0.0, now + xfadeSec);
    }

    if (fromSweepBus && this.sweepGainNode) {
      this.sweepGainNode.gain.cancelScheduledValues(now);
      this.sweepGainNode.gain.setValueAtTime(this.sweepGainNode.gain.value, now);
      this.sweepGainNode.gain.linearRampToValueAtTime(0.0, now + xfadeSec);
      prevGain.gain.setValueAtTime(0.0, now);
      nextGain.gain.setValueAtTime(nextGain.gain.value, now);
      nextGain.gain.linearRampToValueAtTime(1.0, now + xfadeSec);
    } else {
      nextGain.gain.setValueAtTime(nextGain.gain.value, now);
      prevGain.gain.setValueAtTime(prevGain.gain.value, now);
      nextGain.gain.linearRampToValueAtTime(1.0, now + xfadeSec);
      prevGain.gain.linearRampToValueAtTime(0.0, now + xfadeSec);
    }
    this.activeConvolverSlot = toB ? 'B' : 'A';

    // Release inactive convolver slot once crossfade finishes so only one FFT convolver runs
    const settledSlot = this.activeConvolverSlot;
    this._convolverIdleTimer = setTimeout(() => {
      this._convolverIdleTimer = null;
      if (this.audioCtx === ctx && this.activeConvolverSlot === settledSlot && !this._isSweepBusActive) {
        prevConv.buffer = null;
      }
    }, 30);
  }

  static _buildFirBandSignature(resolved) {
    if (!resolved || resolved.isFlat || !Array.isArray(resolved.bands) || resolved.bands.length === 0) {
      return 'FLAT';
    }
    let sig = '';
    for (let i = 0; i < resolved.bands.length; i++) {
      const b = resolved.bands[i];
      if (!b) continue;
      if (sig) sig += '|';
      sig += `${b.type}:${Math.round(b.freq * 10)}:${Math.round((b.gain || 0) * 10)}:${Math.round((b.q || 1) * 100)}`;
    }
    return sig || 'FLAT';
  }

  /**
   * Applies Linear-Phase DSP parameters smoothly according to game mode and listen state.
   * Uses the lock-free zero-latency Biquad sweep path while actively dragging/sweeping, then
   * settles back into the exact 8191-tap Linear-Phase FIR Convolver once interaction ends.
   */
  applyDspConfiguration(spec) {
    this.currentDspSpec = spec;
    if (!this.audioCtx || !this.eqConvolverA || !this.pannerNode) return;

    const now = this.audioCtx.currentTime;
    const mode = spec.listenState || 'target';
    this.listenMode = mode;

    // Handle Feedback Eliminator continuous sine tone
    if (spec.gameMode === 'feedback') {
      this.syncFeedbackTone(Boolean(spec.isPlaying), spec.targetFreq, mode === 'original');
    } else {
      this.stopFeedbackOscillator();
    }

    const resolved = EarlisthenicAudioEngine.resolveDspBandsFromSpec(spec);
    this.pannerNode.pan.setTargetAtTime(resolved.pan || 0, now, 0.010);
    if (this.headroomGainNode) {
      const targetHeadroom = (spec && spec.bypassHeadroom) ? 1.0 : LINEAR_HEADROOM_GAIN;
      this.headroomGainNode.gain.setTargetAtTime(targetHeadroom, now, 0.015);
    }

    const canUseSweepBus = Boolean(
      spec.isSweeping
      && !resolved.isFlat
      && resolved.bands.length <= 2
      && this.sweepFilter1
      && this.sweepGainNode
    );

    if (canUseSweepBus) {
      if (this._pendingFirTimer) {
        clearTimeout(this._pendingFirTimer);
        this._pendingFirTimer = null;
        this._pendingFirSpec = null;
      }
      const enteringSweep = !this._isSweepBusActive;
      this._applyBandToSweepBiquad(this.sweepFilter1, resolved.bands[0], now, enteringSweep);
      this._applyBandToSweepBiquad(this.sweepFilter2, resolved.bands[1], now, enteringSweep);
      if (enteringSweep) {
        const fadeSec = 0.014;
        if (this.directBypassGainNode) {
          this.directBypassGainNode.gain.cancelScheduledValues(now);
          this.directBypassGainNode.gain.setValueAtTime(this.directBypassGainNode.gain.value, now);
          this.directBypassGainNode.gain.linearRampToValueAtTime(0.0, now + fadeSec);
        }
        this.eqGainA.gain.cancelScheduledValues(now);
        this.eqGainB.gain.cancelScheduledValues(now);
        this.sweepGainNode.gain.cancelScheduledValues(now);
        this.eqGainA.gain.setValueAtTime(this.eqGainA.gain.value, now);
        this.eqGainB.gain.setValueAtTime(this.eqGainB.gain.value, now);
        this.sweepGainNode.gain.setValueAtTime(this.sweepGainNode.gain.value, now);
        this.eqGainA.gain.linearRampToValueAtTime(0.0, now + fadeSec);
        this.eqGainB.gain.linearRampToValueAtTime(0.0, now + fadeSec);
        this.sweepGainNode.gain.linearRampToValueAtTime(1.0, now + fadeSec);
        this._isSweepBusActive = true;
      }
      return;
    }

    const sig = EarlisthenicAudioEngine._buildFirBandSignature(resolved);
    if (sig === this._lastFirSignature && !this._isSweepBusActive) return;

    const commitFirUpdate = (targetSig, targetResolved) => {
      const fromSweep = this._isSweepBusActive;
      this._isSweepBusActive = false;
      this._lastFirSignature = targetSig;
      this._lastFirSwapMs = performance.now();
      if (targetResolved.isFlat) {
        this._activateDirectBypassClickFree(fromSweep);
      } else {
        const sr = this.audioCtx.sampleRate || 48000;
        const kernel = EarlisthenicAudioEngine.synthesizeLinearPhaseKernel(
          targetResolved.bands,
          sr,
          this._reusableFirKernel
        );
        const buf = this._createStereoFirAudioBuffer(kernel, sr);
        this._swapConvolverBufferClickFree(buf, fromSweep);
      }
    };

    // Debounce rapid discrete button transitions only when already running an active FIR buffer
    const activeConvNow = this.activeConvolverSlot === 'A' ? this.eqConvolverA : this.eqConvolverB;
    const hasActiveFirBuffer = Boolean(activeConvNow && activeConvNow.buffer && this._lastFirSignature && this._lastFirSignature !== 'FLAT');
    const elapsedMs = performance.now() - this._lastFirSwapMs;
    if (!this._isSweepBusActive && hasActiveFirBuffer && elapsedMs < 24 && !resolved.isFlat) {
      this._pendingFirSpec = { sig, resolved };
      if (!this._pendingFirTimer) {
        this._pendingFirTimer = setTimeout(() => {
          const pending = this._pendingFirSpec;
          this._pendingFirTimer = null;
          this._pendingFirSpec = null;
          if (pending && this.audioCtx) {
            commitFirUpdate(pending.sig, pending.resolved);
          }
        }, 25);
      }
      return;
    }

    if (this._pendingFirTimer) {
      clearTimeout(this._pendingFirTimer);
      this._pendingFirTimer = null;
      this._pendingFirSpec = null;
    }
    commitFirUpdate(sig, resolved);
  }

  /**
   * Computes exact RBJ linear magnitude response |H(e^jw)| for a given frequency.
   */
  static computeBiquadLinearGain(freqHz, type, f0, gainDb, Q, sampleRate) {
    const Fs = sampleRate || 48000;
    const f = Math.max(10, Math.min(Fs * 0.49, freqHz));
    const center = Math.max(15, Math.min(Fs * 0.48, f0 || 1000));
    const qVal = Math.max(0.1, Q || 1.0);
    const dBgain = Number(gainDb) || 0;

    const A = Math.pow(10, dBgain / 40);
    const w0 = (2 * Math.PI * center) / Fs;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * qVal);

    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

    switch (type) {
      case 'peaking':
        b0 = 1 + alpha * A;
        b1 = -2 * cosw0;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cosw0;
        a2 = 1 - alpha / A;
        break;
      case 'lowpass':
        b0 = (1 - cosw0) / 2;
        b1 = 1 - cosw0;
        b2 = (1 - cosw0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosw0;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cosw0) / 2;
        b1 = -(1 + cosw0);
        b2 = (1 + cosw0) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosw0;
        a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cosw0;
        a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1;
        b1 = -2 * cosw0;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cosw0;
        a2 = 1 - alpha;
        break;
      case 'lowshelf':
      case 'highshelf': {
        const sqrtA = Math.sqrt(A);
        const shelfAlpha = (sinw0 / 2) * Math.sqrt((A + 1 / A) * (1 / 0.9 - 1) + 2);
        const twoSqrtAAlpha = 2 * sqrtA * shelfAlpha;
        const aPlus1 = A + 1;
        const aMinus1 = A - 1;
        const sgn = type === 'lowshelf' ? 1 : -1;
        b0 = A * (aPlus1 - sgn * aMinus1 * cosw0 + twoSqrtAAlpha);
        b1 = sgn * 2 * A * (aMinus1 - sgn * aPlus1 * cosw0);
        b2 = A * (aPlus1 - sgn * aMinus1 * cosw0 - twoSqrtAAlpha);
        a0 = aPlus1 + sgn * aMinus1 * cosw0 + twoSqrtAAlpha;
        a1 = -sgn * 2 * (aMinus1 + sgn * aPlus1 * cosw0);
        a2 = aPlus1 + sgn * aMinus1 * cosw0 - twoSqrtAAlpha;
        break;
      }
      default:
        return 1.0;
    }

    b0 /= a0; b1 /= a0; b2 /= a0;
    a1 /= a0; a2 /= a0;

    const w = (2 * Math.PI * f) / Fs;
    const cosw = Math.cos(w);
    const cos2w = Math.cos(2 * w);
    const sinw = Math.sin(w);
    const sin2w = Math.sin(2 * w);

    const numRe = b0 + b1 * cosw + b2 * cos2w;
    const numIm = -(b1 * sinw + b2 * sin2w);
    const denRe = 1 + a1 * cosw + a2 * cos2w;
    const denIm = -(a1 * sinw + a2 * sin2w);

    const numMagSq = numRe * numRe + numIm * numIm;
    const denMagSq = Math.max(1e-12, denRe * denRe + denIm * denIm);
    return Math.max(1e-5, Math.min(16.0, Math.sqrt(numMagSq / denMagSq)));
  }

  /**
   * Computes exact filter magnitude response in dB (clamped [-30, +24] for clean analyzer plot).
   */
  static computeBiquadMagnitudeDb(freqHz, type, f0, gainDb, Q, sampleRate) {
    const mag = EarlisthenicAudioEngine.computeBiquadLinearGain(freqHz, type, f0, gainDb, Q, sampleRate);
    const db = 20 * Math.log10(Math.max(1e-4, mag));
    return Math.max(-30, Math.min(24, db));
  }

  /**
   * Samples current frequency spectrum from the selected analyser tap ('pre' or 'post')
   * and updates peak level readout in dBFS.
   */
  getSpectrumAndPeakData(targetByteArray) {
    const analyser = this.analyserTap === 'pre' ? this.preEqAnalyser : this.postEqAnalyser;
    if (!analyser || !this.audioCtx) {
      return { hasSignal: false, peakDb: -Infinity, peakDbL: -Infinity, peakDbR: -Infinity, clipped: false };
    }

    if (targetByteArray && targetByteArray.length === analyser.frequencyBinCount) {
      analyser.getByteFrequencyData(targetByteArray);
    }

    let maxAbsL = 0;
    let maxAbsR = 0;
    if (this.postAnalyserL && this.timeDomainBufferL) {
      this.postAnalyserL.getFloatTimeDomainData(this.timeDomainBufferL);
      for (let i = 0; i < this.timeDomainBufferL.length; i += 2) {
        const v = Math.abs(this.timeDomainBufferL[i]);
        if (v > maxAbsL) maxAbsL = v;
      }
    }
    if (this.postAnalyserR && this.timeDomainBufferR) {
      this.postAnalyserR.getFloatTimeDomainData(this.timeDomainBufferR);
      for (let i = 0; i < this.timeDomainBufferR.length; i += 2) {
        const v = Math.abs(this.timeDomainBufferR[i]);
        if (v > maxAbsR) maxAbsR = v;
      }
    }

    let maxAbs = Math.max(maxAbsL, maxAbsR);
    if (this.timeDomainBuffer && maxAbs === 0) {
      analyser.getFloatTimeDomainData(this.timeDomainBuffer);
      for (let i = 0; i < this.timeDomainBuffer.length; i += 4) {
        const v = Math.abs(this.timeDomainBuffer[i]);
        if (v > maxAbs) maxAbs = v;
      }
    }

    const dbL = maxAbsL > 0.00001 ? 20 * Math.log10(maxAbsL) : (maxAbs > 0.00001 ? 20 * Math.log10(maxAbs) : -Infinity);
    const dbR = maxAbsR > 0.00001 ? 20 * Math.log10(maxAbsR) : (maxAbs > 0.00001 ? 20 * Math.log10(maxAbs) : -Infinity);
    const db = maxAbs > 0.00001 ? 20 * Math.log10(maxAbs) : -Infinity;
    this.peakDbFs = db;
    if (maxAbs >= 0.99) {
      this.clipDetected = true;
    }

    return {
      hasSignal: true,
      peakDb: this.peakDbFs,
      peakDbL: dbL,
      peakDbR: dbR,
      clipped: this.clipDetected,
      sampleRate: this.audioCtx.sampleRate,
      binCount: analyser.frequencyBinCount
    };
  }

  resetClipIndicator() {
    this.clipDetected = false;
  }

  /**
   * Spawns a short self-cleaning oscillator cue node routed to masterGainNode,
   * optionally conditioned by a low-pass filter to prevent high-frequency ear fatigue.
   */
  _spawnUiTone(ctx, type, freqStart, freqEnd, gainPeak, startTime, rampEndTime, stopTime, lpfFreq) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, startTime);
    if (freqEnd !== null && freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), rampEndTime);
    }
    g.gain.setValueAtTime(gainPeak, startTime);
    g.gain.exponentialRampToValueAtTime(0.0005, rampEndTime);

    if (lpfFreq && typeof ctx.createBiquadFilter === 'function') {
      try {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(lpfFreq, startTime);
        osc.connect(filter);
        filter.connect(g);
      } catch (err) {
        osc.connect(g);
      }
    } else {
      osc.connect(g);
    }

    g.connect(this.masterGainNode);
    osc.onended = () => {
      try { osc.disconnect(); } catch (e) {}
      try { g.disconnect(); } catch (e) {}
    };
    osc.start(startTime);
    osc.stop(stopTime);
  }

  /**
   * Plays subtle, non-intrusive studio UI cues routed directly to masterGainNode
   * so they never pass through the exercise EQ or spectrum analysers.
   * Adheres to Fletcher-Munson ear fatigue prevention and anti-machine-gun micro-variation.
   */
  playUiCue(type, enabled) {
    if (!enabled) return;
    try {
      this.ensureContext();
      const ctx = this.audioCtx;
      const now = ctx.currentTime;
      // Anti-machine-gun micro-variation (±3% detune, ±8% gain)
      const pitchVar = 1 + (Math.random() * 2 - 1) * 0.03;
      const gainVar = 1 + (Math.random() * 2 - 1) * 0.08;

      if (type === 'correct' || type === 'success') {
        // Natural pure 5th harmonic (C5: 523.25Hz + G5: 783.99Hz)
        const notes = [523.25 * pitchVar, 783.99 * pitchVar];
        for (let idx = 0; idx < notes.length; idx++) {
          const t0 = now + idx * 0.07;
          this._spawnUiTone(ctx, 'sine', notes[idx], null, 0.05 * gainVar, t0, t0 + 0.16, t0 + 0.18, 1200);
        }
      } else if (type === 'levelup') {
        const notes = [440, 554.37, 659.25, 880];
        for (let idx = 0; idx < notes.length; idx++) {
          const t0 = now + idx * 0.07;
          this._spawnUiTone(ctx, 'triangle', notes[idx] * pitchVar, null, 0.06 * gainVar, t0, t0 + 0.26, t0 + 0.28, 1400);
        }
      } else if (type === 'wrong' || type === 'warning') {
        // Warm low-frequency warning: 190Hz -> 155Hz with 420Hz LPF (anti-harshness)
        this._spawnUiTone(ctx, 'triangle', 190 * pitchVar, 155 * pitchVar, 0.06 * gainVar, now, now + 0.18, now + 0.20, 420);
      } else if (type === 'click') {
        // Positive tactile click: 440Hz -> 580Hz with 900Hz LPF
        this._spawnUiTone(ctx, 'triangle', 440 * pitchVar, 580 * pitchVar, 0.04 * gainVar, now, now + 0.032, now + 0.036, 900);
      } else if (type === 'tick') {
        // Mechanical micro-tick: 340Hz -> 180Hz with 650Hz LPF (avoids harsh 2.5kHz-5kHz band)
        this._spawnUiTone(ctx, 'sine', 340 * pitchVar, 180 * pitchVar, 0.035 * gainVar, now, now + 0.016, now + 0.020, 650);
      }
    } catch (e) {}
  }
}

const SoundGymAudioEngine = EarlisthenicAudioEngine;
window.EarlisthenicAudioEngine = EarlisthenicAudioEngine;
window.sgAudioEngine = new EarlisthenicAudioEngine();


/* ==================== [MODULE: AudioSources.html] ==================== */

/**
 * Earlisthenic — AudioSources.html
 * Manages audio studio sources:
 * 1. Shared Drive `FREE AUDIO` Repository (primary library managed by Master Profile; fallback synthetic reference loops when empty/offline)
 * 2. Local Audio File (decodeAudioData with metadata, format error diagnostics, size warnings, and Clear action)
 * 3. Playback PCM Bit-Depth Quantization cache & IndexedDB binary track caching for instant subsequent playback
 */

const STUDIO_LOOP_CATALOG = {
  drums: {
    id: 'drums',
    title: 'Pop/Rock Drum Groove (Fallback)',
    subtitle: 'Full-range kit + harmonic pad (4.0s loop)'
  },
  bass: {
    id: 'bass',
    title: 'Funk Electric Bassline (Fallback)',
    subtitle: 'Rich 45 Hz – 3.5 kHz harmonic slap & fingered groove'
  },
  synth: {
    id: 'synth',
    title: 'Warm Poly Synth Pad (Fallback)',
    subtitle: 'Dense sawtooth chord progression across 60 Hz – 16 kHz'
  },
  acoustic: {
    id: 'acoustic',
    title: 'Acoustic Guitar Strum (Fallback)',
    subtitle: 'Plucked steel-string transients & upper-mid presence'
  },
  pink: {
    id: 'pink',
    title: 'Full-Spectrum Pink Noise (Fallback)',
    subtitle: 'Calibrated -3 dB/octave broadband reference signal'
  }
};

const MAX_LOCAL_AUDIO_FILE_MB = 250;
const FREE_AUDIO_CHUNK_BYTES = 2 * 1024 * 1024;
const FREE_AUDIO_IDB_NAME = 'earlisthenic_free_audio_v1';
const FREE_AUDIO_IDB_STORE = 'tracks';
const SIN_LUT_SIZE = 4096;
const SIN_LUT = (() => {
  const lut = new Float32Array(SIN_LUT_SIZE + 1);
  for (let i = 0; i <= SIN_LUT_SIZE; i++) {
    lut[i] = Math.sin((2 * Math.PI * i) / SIN_LUT_SIZE);
  }
  return lut;
})();

function fastSinTurns_(turns) {
  const positiveTurns = turns + 1024;
  const frac = positiveTurns - (positiveTurns | 0);
  const pos = frac * SIN_LUT_SIZE;
  const idx = pos | 0;
  return SIN_LUT[idx] + (pos - idx) * (SIN_LUT[idx + 1] - SIN_LUT[idx]);
}

const STUDIO_SYNTH_CHORD_HARMONICS = [
  [110, 220, 261.63, 329.63, 392.00, 523.25],
  [87.31, 174.61, 261.63, 349.23, 440.00, 523.25],
  [98.00, 196.00, 246.94, 293.66, 392.00, 587.33],
  [82.41, 164.81, 246.94, 329.63, 415.30, 493.88]
].map(chord => {
  const entries = [];
  for (let c = 0; c < chord.length; c++) {
    const f = chord[c];
    for (let h = 1; h <= 16; h++) {
      if (f * h < 16000) {
        entries.push({ freq: f * 1.002 * h, amp: 0.042 / h });
      }
    }
  }
  return entries;
});

const STUDIO_ACOUSTIC_STRUM_NOTES = [130.81, 196.00, 261.63, 329.63, 392.00, 523.25];
const STUDIO_DRUM_PAD_FREQS = [110, 164.81, 220, 277.18, 329.63, 440];
const STUDIO_BASS_NOTES = [55, 55, 65.41, 73.42, 82.41, 73.42, 65.41, 61.74];
const STUDIO_ACOUSTIC_H_INV = Array.from({ length: 19 }, (_, h) => (h > 0 ? 1 / Math.pow(h, 0.85) : 0));

class EarlisthenicSourceManager {
  constructor(engine) {
    this.engine = engine;
    this.generatedLoopCache = {};
    this.sourceMode = 'studio'; // 'studio' (FREE AUDIO + fallback loops) | 'file'
    this.studioLoopKey = 'drums';

    // Shared Drive FREE AUDIO library state
    this.driveTracks = [];
    this.selectedDriveTrackId = '';
    this.driveRawCache = new Map(); // fileId -> { updatedAt, arrayBuffer }
    this.driveDecodedCache = new Map(); // `${fileId}@${sampleRate}` -> AudioBuffer
    this.drivePreviewCache = new Map(); // `${fileId}@${sampleRate}` -> partial prefix AudioBuffer while streaming
    this.driveWaveformCache = new Map(); // fileId -> { updatedAt, durationSec, bins, mins, maxs, rms }

    // Local file state
    this.customAudioBuffer = null;
    this.customRawBytes = null;
    this.customFileMeta = null;
  }

  /**
   * Releases cached synthetic & decoded buffers when sample rate changes or memory cleanup runs.
   */
  clearLoopCache() {
    this.generatedLoopCache = {};
    this.driveDecodedCache.clear();
    if (this.drivePreviewCache) this.drivePreviewCache.clear();
  }

  setDriveTracks(tracks) {
    this.driveTracks = Array.isArray(tracks) ? tracks.slice() : [];
    for (let i = 0; i < this.driveTracks.length; i++) {
      const t = this.driveTracks[i];
      if (t && t.fileId && t.waveform && Array.isArray(t.waveform.mins) && t.waveform.mins.length > 0) {
        this.driveWaveformCache.set(t.fileId, t.waveform);
      }
    }
    return this.driveTracks;
  }

  getSelectedDriveTrack() {
    if (!this.selectedDriveTrackId) return null;
    return this.driveTracks.find(t => t && t.fileId === this.selectedDriveTrackId) || null;
  }

  getSelectedDriveWaveformMeta() {
    const track = this.getSelectedDriveTrack();
    if (!track) return null;
    const cached = this.driveWaveformCache.get(track.fileId);
    if (cached && Array.isArray(cached.mins) && cached.mins.length > 0) return cached;
    if (track.waveform && Array.isArray(track.waveform.mins) && track.waveform.mins.length > 0) return track.waveform;
    return null;
  }

  static extractCompactWaveform(audioBuffer, targetBins) {
    if (!audioBuffer || !audioBuffer.length || !audioBuffer.duration) return null;
    const bins = Math.max(32, Math.min(256, Math.round(Number(targetBins) || 128)));
    const len = audioBuffer.length;
    const step = Math.max(1, Math.floor(len / bins));
    const stride = Math.max(1, Math.floor(step / 96));
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    const mins = new Array(bins);
    const maxs = new Array(bins);
    const rms = new Array(bins);
    for (let i = 0; i < bins; i++) {
      const start = Math.floor((i * len) / bins);
      const end = Math.min(len, Math.floor(((i + 1) * len) / bins));
      let minV = 0;
      let maxV = 0;
      let sq = 0;
      let count = 0;
      for (let idx = start; idx < end; idx += stride) {
        const s = (left[idx] + right[idx]) * 0.5;
        if (s < minV) minV = s;
        if (s > maxV) maxV = s;
        sq += s * s;
        count++;
      }
      mins[i] = Math.max(-1000, Math.min(0, Math.round(minV * 1000)));
      maxs[i] = Math.max(0, Math.min(1000, Math.round(maxV * 1000)));
      rms[i] = Math.max(0, Math.min(1000, Math.round(Math.sqrt(sq / Math.max(1, count)) * 1000)));
    }
    return {
      durationSec: Number(audioBuffer.duration.toFixed(2)),
      bins,
      mins,
      maxs,
      rms
    };
  }

  static decodeBase64ToUint8Array(b64) {
    const clean = String(b64 || '');
    if (typeof atob === 'function') {
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return bytes;
    }
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(clean, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    throw new Error('Base64 decoder unavailable.');
  }

  static createCleanFlacSlice(assembled, contiguousBytes) {
    if (!assembled || contiguousBytes < 42) return null;
    if (assembled[0] !== 0x66 || assembled[1] !== 0x4C || assembled[2] !== 0x61 || assembled[3] !== 0x43) {
      return null;
    }
    let metaOffset = 4;
    let isLastBlock = false;
    while (!isLastBlock && metaOffset + 4 <= contiguousBytes) {
      isLastBlock = (assembled[metaOffset] & 0x80) !== 0;
      const len = (assembled[metaOffset + 1] << 16) | (assembled[metaOffset + 2] << 8) | assembled[metaOffset + 3];
      metaOffset += 4 + len;
    }
    if (!isLastBlock || metaOffset >= contiguousBytes) return null;

    let lastSync = -1;
    for (let i = metaOffset; i < contiguousBytes - 2; i++) {
      if (assembled[i] === 0xFF && (assembled[i + 1] & 0xFE) === 0xF8) {
        lastSync = i;
      }
    }
    if (lastSync <= metaOffset) return null;

    const cleanSlice = new Uint8Array(assembled.subarray(0, lastSync));
    // Zero totalSamples in STREAMINFO (offset 8 + 13..17) so browser decoder doesn't expect full stream
    cleanSlice[8 + 13] = cleanSlice[8 + 13] & 0xF0;
    cleanSlice[8 + 14] = 0;
    cleanSlice[8 + 15] = 0;
    cleanSlice[8 + 16] = 0;
    cleanSlice[8 + 17] = 0;
    // Zero MD5 signature (16 bytes: offset 8 + 18..33)
    for (let m = 8 + 18; m < 8 + 34; m++) cleanSlice[m] = 0;

    return cleanSlice;
  }

  async _idbOpen() {
    if (typeof indexedDB === 'undefined') return null;
    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
      const timer = setTimeout(() => done(null), 800);
      try {
        const req = indexedDB.open(FREE_AUDIO_IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(FREE_AUDIO_IDB_STORE)) {
            db.createObjectStore(FREE_AUDIO_IDB_STORE, { keyPath: 'fileId' });
          }
        };
        req.onsuccess = () => { clearTimeout(timer); done(req.result); };
        req.onerror = () => { clearTimeout(timer); done(null); };
        req.onblocked = () => { clearTimeout(timer); done(null); };
      } catch (e) {
        clearTimeout(timer);
        done(null);
      }
    });
  }

  async _idbGetTrack(fileId) {
    const db = await this._idbOpen();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(FREE_AUDIO_IDB_STORE, 'readonly');
        const store = tx.objectStore(FREE_AUDIO_IDB_STORE);
        const req = store.get(fileId);
        req.onsuccess = () => { try { db.close(); } catch (e) {} resolve(req.result || null); };
        req.onerror = () => { try { db.close(); } catch (e) {} resolve(null); };
      } catch (e) {
        try { db.close(); } catch (err) {}
        resolve(null);
      }
    });
  }

  async _idbPutTrack(record) {
    const db = await this._idbOpen();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(FREE_AUDIO_IDB_STORE, 'readwrite');
        tx.objectStore(FREE_AUDIO_IDB_STORE).put(record);
        tx.oncomplete = () => { try { db.close(); } catch (e) {} resolve(); };
        tx.onerror = () => { try { db.close(); } catch (e) {} resolve(); };
      } catch (e) {
        try { db.close(); } catch (err) {}
        resolve();
      }
    });
  }

  async _downloadTrackRawArrayBuffer(track, fetchChunkFn, onProgress, abortCheckFn) {
    let rawRecord = this.driveRawCache.get(track.fileId);
    if (!rawRecord || rawRecord.updatedAt !== track.updatedAt) {
      const idbRec = await this._idbGetTrack(track.fileId);
      if (idbRec && (idbRec.updatedAt === track.updatedAt || (idbRec.arrayBuffer && idbRec.arrayBuffer.byteLength > 1024))) {
        if (idbRec.waveform && Array.isArray(idbRec.waveform.mins)) {
          this.driveWaveformCache.set(track.fileId, idbRec.waveform);
        }
        if (idbRec.arrayBuffer) {
          rawRecord = { updatedAt: track.updatedAt || idbRec.updatedAt, arrayBuffer: idbRec.arrayBuffer };
          this.driveRawCache.set(track.fileId, rawRecord);
        }
      }
    }

    if (rawRecord && rawRecord.arrayBuffer) {
      return rawRecord;
    }

    this._inFlightDownloads = this._inFlightDownloads || new Map();
    if (this._inFlightDownloads.has(track.fileId)) {
      const inFlight = this._inFlightDownloads.get(track.fileId);
      if (typeof onProgress === 'function' && inFlight.listeners) {
        inFlight.listeners.push(onProgress);
      }
      return inFlight.promise;
    }

    const listeners = typeof onProgress === 'function' ? [onProgress] : [];
    const broadcastProgress = (loaded, total, trk) => {
      for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](loaded, total, trk); } catch (e) {}
      }
    };

    const downloadPromise = (async () => {
      try {
        return await this._executeRawDownload(track, fetchChunkFn, broadcastProgress, abortCheckFn);
      } finally {
        if (this._inFlightDownloads) this._inFlightDownloads.delete(track.fileId);
      }
    })();

    this._inFlightDownloads.set(track.fileId, {
      promise: downloadPromise,
      listeners: listeners
    });

    return downloadPromise;
  }

  async _executeRawDownload(track, fetchChunkFn, onProgress, abortCheckFn) {

    if (typeof fetchChunkFn !== 'function') {
      throw new Error('Drive streaming bridge is unavailable offline.');
    }

    let totalBytes = Number(track.sizeBytes) || 0;
    let assembledBuf = null;

    if (totalBytes > FREE_AUDIO_CHUNK_BYTES) {
      // Head-first parallel slice plan across workers for fast full-file transfer into IndexedDB
      const assembled = new Uint8Array(totalBytes);
      const plan = [];
      const headSizes = [384 * 1024, 640 * 1024, 1024 * 1024];
      let pos = 0;
      for (let i = 0; i < headSizes.length && pos < totalBytes; i++) {
        const sz = Math.min(headSizes[i], totalBytes - pos);
        plan.push({ offset: pos, size: sz });
        pos += sz;
      }
      while (pos < totalBytes) {
        const sz = Math.min(FREE_AUDIO_CHUNK_BYTES, totalBytes - pos);
        plan.push({ offset: pos, size: sz });
        pos += sz;
      }

      let cursorIdx = 0;
      let loadedBytes = 0;
      // Cap parallel worker count to max 2 to prevent thread starvation and 25s Apps Script RPC timeout
      const workerCount = Math.min(2, plan.length);

      const runWorker = async () => {
        while (cursorIdx < plan.length) {
          if (abortCheckFn && abortCheckFn()) {
            const abortedErr = new Error('Track load superseded.');
            abortedErr.isAborted = true;
            throw abortedErr;
          }
          const stepIdx = cursorIdx++;
          const step = plan[stepIdx];
          let res = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              res = await fetchChunkFn(track.fileId, step.offset, step.size);
              if (res && res.ok && res.base64) break;
            } catch (rpcErr) {
              if (attempt === 2) throw rpcErr;
              await new Promise(r => setTimeout(r, 400));
            }
          }
          if (!res || !res.ok || !res.base64) {
            throw new Error((res && res.error) || `Failed to stream "${track.name}" from Drive.`);
          }
          const bytes = EarlisthenicSourceManager.decodeBase64ToUint8Array(res.base64);
          const copyLen = Math.min(bytes.length, totalBytes - step.offset);
          assembled.set(bytes.subarray(0, copyLen), step.offset);
          loadedBytes += copyLen;
          if (onProgress) onProgress(Math.min(loadedBytes, totalBytes), totalBytes, track);
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      assembledBuf = assembled.buffer;
    } else {
      const chunks = [];
      let offset = 0;
      while (true) {
        if (abortCheckFn && abortCheckFn()) {
          const abortedErr = new Error('Track load superseded.');
          abortedErr.isAborted = true;
          throw abortedErr;
        }
        const res = await fetchChunkFn(track.fileId, offset, FREE_AUDIO_CHUNK_BYTES);
        if (!res || !res.ok || !res.base64) {
          throw new Error((res && res.error) || `Failed to stream "${track.name}" from Drive.`);
        }
        const bytes = EarlisthenicSourceManager.decodeBase64ToUint8Array(res.base64);
        chunks.push(bytes);
        offset += bytes.length;
        totalBytes = res.totalBytes || totalBytes || offset;
        if (onProgress) onProgress(offset, totalBytes, track);
        if (res.eof || bytes.length === 0 || offset >= totalBytes) break;
      }
      const assembled = new Uint8Array(offset);
      let cursor = 0;
      for (let i = 0; i < chunks.length; i++) {
        assembled.set(chunks[i], cursor);
        cursor += chunks[i].length;
      }
      assembledBuf = assembled.buffer;
      totalBytes = offset;
    }

    const rawRecord = { updatedAt: track.updatedAt, arrayBuffer: assembledBuf };
    this.driveRawCache.set(track.fileId, rawRecord);
    if (this.driveRawCache.size > 3) {
      const oldestRawId = this.driveRawCache.keys().next().value;
      if (oldestRawId && oldestRawId !== track.fileId && oldestRawId !== this.selectedDriveTrackId) {
        this.driveRawCache.delete(oldestRawId);
      }
    }
    await this._idbPutTrack({
      fileId: track.fileId,
      name: track.name,
      updatedAt: track.updatedAt,
      sizeBytes: totalBytes,
      arrayBuffer: rawRecord.arrayBuffer,
      waveform: track.waveform || this.driveWaveformCache.get(track.fileId) || null
    });
    return rawRecord;
  }

  _extractAndStoreWaveform(track, decodedBuffer, onWaveformReady) {
    const existing = this.driveWaveformCache.get(track.fileId);
    const hasMatching = (existing && existing.updatedAt === track.updatedAt) ||
      (track.waveform && track.waveform.updatedAt === track.updatedAt);
    const wfMeta = EarlisthenicSourceManager.extractCompactWaveform(decodedBuffer, 128);
    if (!wfMeta) return null;
    wfMeta.updatedAt = track.updatedAt;
    this.driveWaveformCache.set(track.fileId, wfMeta);
    track.waveform = wfMeta;
    if (!hasMatching && typeof onWaveformReady === 'function') {
      try { onWaveformReady(track, wfMeta); } catch (e) {}
    }
    return wfMeta;
  }

  async prefetchTrackRawToIndexedDB(track, fetchChunkFn, abortCheckFn, onWaveformReady) {
    if (!track || !track.fileId) return false;
    const rawRecord = await this._downloadTrackRawArrayBuffer(track, fetchChunkFn, null, abortCheckFn);
    const hasMatchingWave = (this.driveWaveformCache.get(track.fileId) || {}).updatedAt === track.updatedAt ||
      (track.waveform && track.waveform.updatedAt === track.updatedAt);
    if (!hasMatchingWave && rawRecord && rawRecord.arrayBuffer) {
      try {
        const ctx = this.engine.ensureContext();
        const decoded = await ctx.decodeAudioData(rawRecord.arrayBuffer.slice(0));
        const wfMeta = this._extractAndStoreWaveform(track, decoded, onWaveformReady);
        if (wfMeta) {
          this._idbPutTrack({
            fileId: track.fileId,
            name: track.name,
            updatedAt: track.updatedAt,
            sizeBytes: rawRecord.arrayBuffer.byteLength,
            arrayBuffer: rawRecord.arrayBuffer,
            waveform: wfMeta
          });
        }
      } catch (e) {}
    }
    return true;
  }

  async loadDriveAudioTrack(track, fetchChunkFn, onProgress, abortCheckFn, onWaveformReady) {
    if (!track || !track.fileId) {
      throw new Error('Missing FREE AUDIO track metadata.');
    }
    const ctx = this.engine.ensureContext();
    const sr = ctx.sampleRate || 48000;
    const decodedKey = `${track.fileId}@${sr}`;
    if (this.driveDecodedCache.has(decodedKey)) {
      const hit = this.driveDecodedCache.get(decodedKey);
      this._extractAndStoreWaveform(track, hit, onWaveformReady);
      return hit;
    }

    const rawRecord = await this._downloadTrackRawArrayBuffer(track, fetchChunkFn, onProgress, abortCheckFn);
    let decoded = null;
    try {
      decoded = await ctx.decodeAudioData(rawRecord.arrayBuffer.slice(0));
    } catch (decodeErr) {
      throw new Error(`Audio decode failed for "${track.name}": ${(decodeErr && decodeErr.message) || 'EncodingError'}`);
    }
    this.driveDecodedCache.set(decodedKey, decoded);
    this._extractAndStoreWaveform(track, decoded, onWaveformReady);
    return decoded;
  }

  /**
   * Re-decodes active Drive/Local audio only when the target sample rate isn't already cached.
   */
  async redecodeForCurrentSampleRate() {
    this.generatedLoopCache = {};
    const ctx = this.engine.ensureContext();
    const sr = ctx.sampleRate || 48000;
    if (this.sourceMode === 'file' && this.customRawBytes) {
      if (!this.customAudioBuffer || this.customAudioBuffer.sampleRate !== sr) {
        this.customAudioBuffer = await ctx.decodeAudioData(this.customRawBytes.slice(0));
        if (this.customFileMeta) this.customFileMeta.sampleRate = sr;
      }
    }
    if (this.sourceMode === 'studio' && this.selectedDriveTrackId) {
      const cacheKey = `${this.selectedDriveTrackId}@${sr}`;
      if (!this.driveDecodedCache.has(cacheKey)) {
        let rawRec = this.driveRawCache.get(this.selectedDriveTrackId);
        if (!rawRec || !rawRec.arrayBuffer) {
          const idbRec = await this._idbGetTrack(this.selectedDriveTrackId);
          if (idbRec && idbRec.arrayBuffer) {
            rawRec = { updatedAt: idbRec.updatedAt, arrayBuffer: idbRec.arrayBuffer };
            this.driveRawCache.set(this.selectedDriveTrackId, rawRec);
          }
        }
        if (rawRec && rawRec.arrayBuffer) {
          const decoded = await ctx.decodeAudioData(rawRec.arrayBuffer.slice(0));
          this.driveDecodedCache.set(cacheKey, decoded);
          if (this.driveDecodedCache.size > 24) {
            const oldestKey = this.driveDecodedCache.keys().next().value;
            if (oldestKey && oldestKey !== cacheKey) {
              this.driveDecodedCache.delete(oldestKey);
            }
          }
        }
      }
    }
  }

  _fillStudioChannel(out, ch, key, totalSamples, fadeSamples, sr) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    const chPhaseSynth = (ch * 0.4) / (2 * Math.PI);
    const chPhaseDrum = (ch * 0.3) / (2 * Math.PI);

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sr;
      const beatPos = (t * 2) % 1.0;
      const eighthPos = (t * 4) % 1.0;
      const sixteenthPos = (t * 8) % 1.0;
      const beatIndex = Math.floor(t * 2) % 8;
      let sample = 0;

      if (key === 'pink') {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.042;
        b6 = white * 0.115926;
      } else if (key === 'drums') {
        if (beatIndex % 2 === 0) {
          const kEnv = Math.exp(-beatPos * 16);
          const kPitch = 54 + 130 * Math.exp(-beatPos * 35);
          sample += fastSinTurns_(kPitch * beatPos) * kEnv * 0.52;
        } else {
          const sBodyEnv = Math.exp(-beatPos * 22);
          const sNoiseEnv = Math.exp(-beatPos * 14);
          sample += fastSinTurns_(195 * beatPos) * sBodyEnv * 0.30;
          sample += (Math.random() * 2 - 1) * sNoiseEnv * 0.25;
        }
        sample += (Math.random() * 2 - 1) * Math.exp(-sixteenthPos * 38) * 0.15;
        for (let p = 0; p < STUDIO_DRUM_PAD_FREQS.length; p++) {
          const pf = STUDIO_DRUM_PAD_FREQS[p];
          sample += (fastSinTurns_(pf * t + chPhaseDrum) + 0.4 * fastSinTurns_(2 * pf * t)) * 0.032;
        }
      } else if (key === 'bass') {
        const f0 = STUDIO_BASS_NOTES[beatIndex];
        const env = Math.exp(-eighthPos * 5.5);
        const hDecayBase = Math.exp(-eighthPos * 0.8);
        let hDecay = hDecayBase;
        for (let h = 1; h <= 14; h++) {
          sample += fastSinTurns_(f0 * h * t) * ((1 / h) * hDecay) * env * 0.23;
          hDecay *= hDecayBase;
        }
        const kEnv = Math.exp(-beatPos * 18);
        sample += fastSinTurns_((50 + 90 * kEnv) * beatPos) * kEnv * 0.24;
        sample += (Math.random() * 2 - 1) * Math.exp(-eighthPos * 35) * 0.05;
      } else if (key === 'synth') {
        const chordEntries = STUDIO_SYNTH_CHORD_HARMONICS[Math.floor(t) % 4];
        for (let e = 0; e < chordEntries.length; e++) {
          const entry = chordEntries[e];
          sample += fastSinTurns_(entry.freq * t + chPhaseSynth) * entry.amp;
        }
      } else if (key === 'acoustic') {
        const decayBase = Math.exp(-eighthPos * 4);
        const stepDecay = Math.exp(-eighthPos * 1.1);
        for (let c = 0; c < STUDIO_ACOUSTIC_STRUM_NOTES.length; c++) {
          const f = STUDIO_ACOUSTIC_STRUM_NOTES[c];
          const dt = t - c * 0.012;
          let decay = decayBase * stepDecay;
          for (let h = 1; h <= 18; h++) {
            sample += fastSinTurns_(f * h * dt) * STUDIO_ACOUSTIC_H_INV[h] * decay * 0.058;
            decay *= stepDecay;
          }
        }
        sample += (Math.random() * 2 - 1) * Math.exp(-eighthPos * 55) * 0.11;
      }

      // Smooth boundary envelope to eliminate wrap-around clicks
      let envBound = 1.0;
      if (i < fadeSamples) {
        envBound = i / fadeSamples;
      } else if (i > totalSamples - fadeSamples) {
        envBound = (totalSamples - i) / fadeSamples;
      }

      // Smooth soft-knee headroom limiter avoids harsh digital clipping on transient peaks
      out[i] = 0.68 * Math.tanh((sample * envBound * 0.72) / 0.68);
    }
  }

  /**
   * Synthesizes and caches one of the 5 studio reference loops with a 25ms boundary crossfade
   * to prevent any discontinuity or click at loop wraparound.
   */
  getOrCreateStudioBuffer(loopKey) {
    const ctx = this.engine.ensureContext();
    const key = STUDIO_LOOP_CATALOG[loopKey] ? loopKey : 'drums';
    if (this.generatedLoopCache[key]) {
      return this.generatedLoopCache[key];
    }

    const sr = ctx.sampleRate;
    const duration = 4.0;
    const totalSamples = Math.floor(sr * duration);
    const fadeSamples = Math.floor(sr * 0.025); // 25ms boundary smoothing
    const buf = ctx.createBuffer(2, totalSamples, sr);

    for (let ch = 0; ch < 2; ch++) {
      this._fillStudioChannel(buf.getChannelData(ch), ch, key, totalSamples, fadeSamples, sr);
    }

    this.generatedLoopCache[key] = buf;
    return buf;
  }

  /**
   * Decodes a local audio file selected by the user and returns rich metadata or a descriptive error.
   */
  async loadLocalAudioFile(file) {
    if (!file) {
      throw new Error('No audio file selected.');
    }

    const sizeMb = file.size / (1024 * 1024);
    if (sizeMb > MAX_LOCAL_AUDIO_FILE_MB) {
      throw new Error(`Audio file (${sizeMb.toFixed(1)} MB) exceeds the ${MAX_LOCAL_AUDIO_FILE_MB} MB browser decode limit.`);
    }
    const warnings = [];
    if (sizeMb > 45) {
      warnings.push(`Large file (${sizeMb.toFixed(1)} MB): decoding may consume substantial browser memory.`);
    }

    const ctx = this.engine.ensureContext();
    let arrayBuffer = typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve((ev && ev.target && ev.target.result) || reader.result);
          reader.onerror = () => reject(new Error(`Unable to read "${file.name}".`));
          reader.readAsArrayBuffer(file);
        });

    let decodedBuffer = null;
    try {
      const decodeCopy = (arrayBuffer && typeof arrayBuffer.slice === 'function')
        ? arrayBuffer.slice(0)
        : arrayBuffer;
      decodedBuffer = await ctx.decodeAudioData(decodeCopy);
    } catch (decodeErr) {
      arrayBuffer = null;
      throw new Error(
        `Unable to decode "${file.name}". Your browser may not support this codec or container. Try uncompressed WAV, MP3, OGG, or FLAC.`
      );
    }

    if (decodedBuffer.duration > 900) {
      warnings.push(`Long audio track (${Math.round(decodedBuffer.duration / 60)} min): use the loop handles to focus on a passage.`);
    }

    this.customRawBytes = arrayBuffer;
    this.customAudioBuffer = decodedBuffer;
    this.customFileMeta = {
      name: file.name,
      sizeBytes: file.size,
      sizeMb: Number(sizeMb.toFixed(2)),
      durationSec: Number(decodedBuffer.duration.toFixed(2)),
      sampleRate: decodedBuffer.sampleRate,
      numberOfChannels: decodedBuffer.numberOfChannels,
      warnings: warnings
    };
    this.sourceMode = 'file';
    return this.customFileMeta;
  }

  /**
   * Clears the loaded custom audio file and reverts cleanly to the active studio loop.
   */
  clearLocalAudioFile() {
    this.customAudioBuffer = null;
    this.customRawBytes = null;
    this.customFileMeta = null;
    if (this.sourceMode === 'file') {
      this.sourceMode = 'studio';
    }
  }

  /**
   * Returns the active decoded AudioBuffer directly without artificial sample modification.
   */
  getActiveBuffer() {
    if (this.sourceMode === 'file' && this.customAudioBuffer) {
      return this.customAudioBuffer;
    }
    if (this.selectedDriveTrackId) {
      const sr = (this.engine && this.engine.audioCtx && this.engine.audioCtx.sampleRate) || 48000;
      const key = `${this.selectedDriveTrackId}@${sr}`;
      return this.driveDecodedCache.get(key) || null;
    }
    return this.getOrCreateStudioBuffer(this.studioLoopKey);
  }
}

const SoundGymSourceManager = EarlisthenicSourceManager;
window.EarlisthenicSourceManager = EarlisthenicSourceManager;
window.sgSourceManager = new EarlisthenicSourceManager(window.sgAudioEngine);


/* ==================== [MODULE: Games.html] ==================== */

/**
 * Earlisthenic — Games.html
 * Catalog, line-art SVG illustrations, psychoacoustic Level 1-10 target generation,
 * Heart Point scaling, Scoring v3 precision-graded & habit-weighted evaluation,
 * and specialized controls for all 9 training modules.
 */

const GAME_SVG_ART = {
  peak: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <line x1="20" y1="98" x2="300" y2="98" class="svg-art-line" stroke="var(--sg-border, #D8CDBB)" stroke-width="1"/>
    <path d="M20 98 C95 98 125 98 144 42 C153 16 167 16 176 42 C195 98 225 98 300 98" stroke="var(--sg-terracotta, #B56D4E)" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="160" cy="23" r="5" fill="var(--sg-terracotta, #B56D4E)"/>
    <text x="160" y="116" class="svg-art-text" fill="var(--sg-muted, #6E675B)" font-family="JetBrains Mono" font-size="10" text-anchor="middle">PEAKING BOOST (+dB)</text>
  </svg>`,

  cut: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <line x1="20" y1="36" x2="300" y2="36" class="svg-art-line" stroke="var(--sg-border, #D8CDBB)" stroke-width="1"/>
    <path d="M20 36 C95 36 125 36 144 90 C153 114 167 114 176 90 C195 36 225 36 300 36" stroke="var(--sg-danger, #A8463B)" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="160" cy="107" r="5" fill="var(--sg-danger, #A8463B)"/>
    <text x="160" y="22" class="svg-art-text" fill="var(--sg-muted, #6E675B)" font-family="JetBrains Mono" font-size="10" text-anchor="middle">PEAKING CUT (-dB)</text>
  </svg>`,

  bass: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <path d="M20 75 Q55 35 90 75 T160 75 T230 75 T300 75" stroke="var(--sg-ochre, #9E7B42)" stroke-width="2.2" fill="none"/>
    <circle cx="160" cy="64" r="26" class="svg-art-surface" fill="var(--sg-surface, #FBF8F1)" stroke="var(--sg-border-strong, #302D28)" stroke-width="2"/>
    <text x="160" y="68" class="svg-art-text-strong" fill="var(--sg-ink, #302D28)" font-family="JetBrains Mono" font-weight="600" font-size="10" text-anchor="middle">50–400Hz</text>
  </svg>`,

  mirror: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <line x1="160" y1="14" x2="160" y2="116" class="svg-art-line-strong" stroke="var(--sg-border-strong, #BFB29C)" stroke-width="1.5" stroke-dasharray="4 4"/>
    <path d="M20 88 C58 88 74 32 102 32 C130 32 144 88 160 88" stroke="var(--sg-moss, #5E6B50)" stroke-width="2.4"/>
    <path d="M160 88 C176 88 190 32 218 32 C246 32 262 88 300 88" stroke="var(--sg-terracotta, #B56D4E)" stroke-width="2.4" stroke-dasharray="5 3"/>
    <circle cx="102" cy="32" r="4.5" fill="var(--sg-moss, #5E6B50)"/>
    <circle cx="218" cy="32" r="4.5" fill="var(--sg-terracotta, #B56D4E)"/>
  </svg>`,

  knight: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <rect x="44" y="22" width="232" height="86" rx="6" class="svg-art-surface" fill="var(--sg-surface, #FBF8F1)" stroke="var(--sg-border, #D8CDBB)" stroke-width="1.5"/>
    <path d="M60 56 Q110 28 160 56 T260 56" stroke="var(--sg-terracotta, #B56D4E)" stroke-width="2.2"/>
    <path d="M60 78 Q110 102 160 78 T260 78" stroke="var(--sg-slate-blue, #526069)" stroke-width="2" stroke-dasharray="4 3"/>
    <text x="160" y="100" class="svg-art-text" fill="var(--sg-muted, #6E675B)" font-family="JetBrains Mono" font-size="10" text-anchor="middle">CURVE A / B / C / D</text>
  </svg>`,

  filter: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <path d="M28 40 H136 C172 40 188 100 232 100 H292" stroke="var(--sg-moss, #5E6B50)" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M28 100 H88 C132 100 148 40 184 40 H292" stroke="var(--sg-slate-blue, #526069)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>
    <circle cx="152" cy="48" r="5" fill="var(--sg-moss, #5E6B50)"/>
  </svg>`,

  cheetah: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <path d="M36 96 L96 42 L138 78 L204 28 L284 96" stroke="var(--sg-ochre, #9E7B42)" stroke-width="2.5" stroke-linecap="round"/>
    <rect x="112" y="88" width="96" height="24" rx="5" class="svg-art-surface" fill="var(--sg-surface, #FBF8F1)" stroke="var(--sg-ochre, #9E7B42)" stroke-width="1.5"/>
    <text x="160" y="104" class="svg-art-text-strong" fill="var(--sg-ink, #302D28)" font-family="JetBrains Mono" font-size="10" font-weight="600" text-anchor="middle">60.0s BLITZ</text>
  </svg>`,

  feedback: `<svg viewBox="0 0 320 130" class="w-full h-full" fill="none" aria-hidden="true">
    <rect width="320" height="130" class="svg-art-bg" fill="var(--sg-card-art-bg, #F4F0E7)"/>
    <g class="svg-art-line" stroke="var(--sg-border, #D8CDBB)" stroke-width="3" stroke-linecap="round">
      <line x1="65" y1="24" x2="65" y2="104"/><line x1="98" y1="24" x2="98" y2="104"/>
      <line x1="131" y1="24" x2="131" y2="104"/><line x1="164" y1="24" x2="164" y2="104"/>
      <line x1="197" y1="24" x2="197" y2="104"/><line x1="230" y1="24" x2="230" y2="104"/>
      <line x1="263" y1="24" x2="263" y2="104"/>
    </g>
    <rect x="58" y="54" width="14" height="8" rx="2" fill="var(--sg-slate-blue, #526069)"/>
    <rect x="91" y="54" width="14" height="8" rx="2" fill="var(--sg-slate-blue, #526069)"/>
    <rect x="124" y="54" width="14" height="8" rx="2" fill="var(--sg-slate-blue, #526069)"/>
    <rect x="157" y="88" width="14" height="8" rx="2" fill="var(--sg-danger, #A8463B)"/>
    <rect x="190" y="54" width="14" height="8" rx="2" fill="var(--sg-slate-blue, #526069)"/>
    <rect x="223" y="54" width="14" height="8" rx="2" fill="var(--sg-slate-blue, #526069)"/>
    <rect x="256" y="54" width="14" height="8" rx="2" fill="var(--sg-slate-blue, #526069)"/>
  </svg>`,

};

const SG_GAMES = {
  peak: {
    id: 'peak',
    name: 'Peak Master',
    category: 'eq',
    tag: 'PEAKING BOOST',
    spiAxis: 'freq',
    desc: 'Identify the center frequency of a peaking EQ boost across the full spectrum (20 Hz – 20 kHz).',
    instruction: 'PEAK MASTER • CLICK OR DRAG ON SPECTRUM TO SELECT BOOST FREQUENCY'
  },
  cut: {
    id: 'cut',
    name: 'Kit Cut',
    category: 'eq',
    tag: 'PEAKING CUT',
    spiAxis: 'freq',
    desc: 'Identify the frequency region attenuated by a peaking EQ cut across the spectrum.',
    instruction: 'KIT CUT • LOCATE THE ATTENUATED FREQUENCY REGION'
  },
  bass: {
    id: 'bass',
    name: 'Bass Detective',
    category: 'filter',
    tag: 'LOW-END 50–400 Hz',
    spiAxis: 'bass',
    desc: 'Identify a boosted low-frequency region within the dedicated 50 Hz – 400 Hz zoom window.',
    instruction: 'BASS DETECTIVE • DEDICATED LOW-FREQUENCY ZOOM (50 Hz – 400 Hz)'
  },
  mirror: {
    id: 'mirror',
    name: 'EQ Mirror',
    category: 'eq',
    tag: '2D FREQ + GAIN',
    spiAxis: 'symmetry',
    desc: 'Match both the target center frequency (Hz) and peaking gain (±dB) by auditioning Target vs. Your EQ.',
    instruction: 'EQ MIRROR • DRAG 2D HANDLE (HORIZONTAL = FREQUENCY, VERTICAL = GAIN ±dB)'
  },
  knight: {
    id: 'knight',
    name: 'EQ Knight',
    category: 'eq',
    tag: 'MULTIBAND CURVE',
    spiAxis: 'filter',
    desc: 'Listen to the processed signal and identify the active two-band EQ curve from four visual choices (A–D).',
    instruction: 'EQ KNIGHT • COMPARE FLAT VS. TARGET EQ AND CHOOSE CURVE A, B, C, OR D'
  },
  filter: {
    id: 'filter',
    name: 'Filter Expert',
    category: 'filter',
    tag: 'LPF / HPF / BPF / NOTCH',
    spiAxis: 'filter',
    desc: 'Recognize both the active filter type (Low-Pass, High-Pass, Band-Pass, or Notch) and its cutoff frequency.',
    instruction: 'FILTER EXPERT • SELECT FILTER TYPE BELOW + CLICK CUTOFF FREQUENCY ON SPECTRUM'
  },
  cheetah: {
    id: 'cheetah',
    name: 'EQ Cheetah',
    category: 'spatial',
    tag: '60s SPEED BLITZ',
    spiAxis: 'speed',
    desc: 'High-speed 60-second frequency-identification blitz with rapid consecutive questions and end-of-run summary.',
    instruction: 'EQ CHEETAH 60s BLITZ • SWEEP TO MATCH BOOST FREQUENCY & PRESS ENTER'
  },
  feedback: {
    id: 'feedback',
    name: 'Feedback Eliminator',
    category: 'spatial',
    tag: '20-BAND ISO (31.5Hz–10kHz)',
    spiAxis: 'feedback',
    desc: 'Identify the ringing sine feedback tone and attenuate it using the 20-band ISO graphic EQ notch filter (31.5 Hz – 10 kHz).',
    instruction: 'FEEDBACK ELIMINATOR • SELECT THE MATCHING ISO GRAPHIC EQ BAND TO NOTCH OUT THE SINE RING'
  }
};

// 20-Band Graphic EQ Center Frequencies covering 31.5 Hz to 10,000 Hz
const ISO_20_BANDS = [
  31.5, 50, 80, 125, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 6300, 10000
];

// Progressive Level 1–10 Psychoacoustic & Heart Point Scaling (Scoring v6)
const LEVEL_SCALING = {
  1:  { gain: 12.0, q: 1.3, maxTolCents: 1350, baseTolErb: 6.20, freqMin: 180, freqMax: 5000,  hearts: 5, label: 'Foundations' },
  2:  { gain: 10.0, q: 1.5, maxTolCents: 1260, baseTolErb: 5.75, freqMin: 125, freqMax: 6800,  hearts: 5, label: 'Warmup' },
  3:  { gain: 8.5,  q: 1.9, maxTolCents: 1180, baseTolErb: 5.30, freqMin: 90,  freqMax: 9000,  hearts: 4, label: 'Core Studio' },
  4:  { gain: 7.0,  q: 2.3, maxTolCents: 1080, baseTolErb: 4.85, freqMin: 75,  freqMax: 11000, hearts: 4, label: 'Critical Mix' },
  5:  { gain: 6.0,  q: 2.7, maxTolCents: 980,  baseTolErb: 4.40, freqMin: 60,  freqMax: 12500, hearts: 3, label: 'Pro Balance' },
  6:  { gain: 5.0,  q: 3.2, maxTolCents: 900,  baseTolErb: 4.00, freqMin: 50,  freqMax: 14000, hearts: 3, label: 'Surgical' },
  7:  { gain: 4.0,  q: 3.7, maxTolCents: 820,  baseTolErb: 3.65, freqMin: 42,  freqMax: 15000, hearts: 3, label: 'Precision' },
  8:  { gain: 3.2,  q: 4.3, maxTolCents: 740,  baseTolErb: 3.30, freqMin: 36,  freqMax: 15800, hearts: 2, label: 'Master Cut' },
  9:  { gain: 2.6,  q: 4.9, maxTolCents: 660,  baseTolErb: 2.95, freqMin: 32,  freqMax: 16500, hearts: 2, label: 'Mastering I' },
  10: { gain: 2.0,  q: 5.6, maxTolCents: 580,  baseTolErb: 2.60, freqMin: 28,  freqMax: 17500, hearts: 2, label: 'Mastering II' }
};

function getMaxHeartsForLevel(level) {
  const lvlSpec = LEVEL_SCALING[Math.max(1, Math.min(10, parseInt(level, 10) || 3))] || LEVEL_SCALING[3];
  return lvlSpec.hearts || 3;
}

/**
 * Converts frequency in Hz to Moore & Glasberg ERB-rate (Cam scale).
 */
function camScaleErb(freqHz) {
  return 21.4 * Math.log10(1 + 0.00437 * Math.max(20, Math.min(20000, Number(freqHz) || 1000)));
}

/**
 * Advanced ISO-226 Equal-Loudness, Auditory Filter ERB & Neural Phase-Locking Model (Scoring v6).
 * - Peak auditory acuity around ear canal resonance (2.2 kHz - 4.0 kHz) receives tighter tolerance demand.
 * - High-Air brilliance (>4.2 kHz) receives decompression compensation for loss of auditory nerve phase-locking.
 * - Sub-bass (<140 Hz) receives temporal integration compensation.
 * - Kit Cut (cut mode) receives asymmetric spectral gap masking compensation (+35%).
 */
function getPsychoacousticBandFactor(freqHz, gameMode) {
  const f = Math.max(20, Math.min(20000, Number(freqHz) || 1000));
  const logF = Math.log10(f);

  // 1. Cochlear Ear Canal Resonance (ISO 226 peak sensitivity around 2.2 - 4.0 kHz)
  const presDist = Math.abs(logF - Math.log10(3000)) / 0.35;
  const presencePeak = Math.max(0, 1 - presDist);

  // 2. High-Air Phase-Locking Loss Zone (>3.5 kHz, steep biological loss at 5k-16k)
  const highAir = Math.max(0, (logF - Math.log10(3500)) / (Math.log10(16000) - Math.log10(3500)));
  const highAirComp = Math.pow(highAir, 0.85);

  // 3. Sub-Bass Tactile & Temporal Integration Zone (<140 Hz)
  const subBass = Math.max(0, (Math.log10(140) - logF) / (Math.log10(140) - Math.log10(30)));

  // 4. Asymmetric Masking Factor by Game Mode (Cuts masked by adjacent energy)
  const modeMaskingMult = (gameMode === 'cut') ? 1.35 : (gameMode === 'bass' ? 0.90 : 1.0);

  // Tolerance multiplier across ERB domain (Scoring v7)
  const toleranceMult = (1.0 - presencePeak * 0.12 + subBass * 0.18 + highAirComp * 1.15) * modeMaskingMult;

  // Synthesis gain/Q multipliers
  const lowAtt = Math.min(1, Math.max(0, (Math.log10(160) - logF) / (Math.log10(160) - Math.log10(30))));
  const highAtt = Math.min(1, Math.max(0, (logF - Math.log10(6000)) / (Math.log10(18000) - Math.log10(6000))));
  const presenceFactor = Math.max(0, 1 - (Math.abs(logF - Math.log10(2200)) / 0.35));

  return {
    gainMult: Number(Math.max(0.95, Math.min(1.28, 1.0 + lowAtt * 0.25 + highAtt * 0.22 - presenceFactor * 0.05)).toFixed(3)),
    qMult: Number(Math.max(0.78, Math.min(1.0, 1.0 - lowAtt * 0.22 - highAtt * 0.12)).toFixed(3)),
    toleranceMult: Number(toleranceMult.toFixed(3)),
    region: subBass > 0.25 ? 'Sub-Bass Compensated' : (highAir > 0.25 ? 'Upper-Air Decompressed' : (presencePeak > 0.35 ? 'Peak Acuity (1–4 kHz)' : 'Neutral Studio Band')),
    presencePeak: Number(presencePeak.toFixed(2)),
    highAir: Number(highAir.toFixed(2)),
    subBass: Number(subBass.toFixed(2))
  };
}

// Starting 6-Curve Multi-Band Preset Library for EQ Knight
const KNIGHT_CURVES = [
  {
    name: 'Low Warmth + High Roll-Off',
    desc: 'Low-shelf boost @ 180 Hz + High-shelf cut @ 4.2 kHz',
    b1: { type: 'lowshelf', freq: 180, gain: 9.0, q: 0.9 },
    b2: { type: 'highshelf', freq: 4200, gain: -9.5, q: 0.9 }
  },
  {
    name: 'Vocal Air + Low Cut',
    desc: 'High-pass @ 300 Hz + High-shelf boost @ 4.8 kHz',
    b1: { type: 'highpass', freq: 300, gain: 0, q: 0.8 },
    b2: { type: 'highshelf', freq: 4800, gain: 10.0, q: 0.9 }
  },
  {
    name: 'Scooped Mid V-Curve',
    desc: 'Mid cut @ 950 Hz + Low-shelf boost @ 140 Hz',
    b1: { type: 'peaking', freq: 950, gain: -11.0, q: 1.3 },
    b2: { type: 'lowshelf', freq: 140, gain: 7.5, q: 0.9 }
  },
  {
    name: 'Midrange Presence Focus',
    desc: 'Peaking boost @ 1.25 kHz + Low-shelf cut @ 220 Hz',
    b1: { type: 'peaking', freq: 1250, gain: 11.5, q: 1.8 },
    b2: { type: 'lowshelf', freq: 220, gain: -8.5, q: 0.9 }
  },
  {
    name: 'Low-Mid Boxiness Bump',
    desc: 'Peaking boost @ 360 Hz + Upper-mid cut @ 3.5 kHz',
    b1: { type: 'peaking', freq: 360, gain: 10.5, q: 1.6 },
    b2: { type: 'peaking', freq: 3500, gain: -5.5, q: 1.2 }
  },
  {
    name: 'Upper-Mid Attack (3.2 kHz)',
    desc: 'Peaking boost @ 3.2 kHz + Low-shelf trim @ 150 Hz',
    b1: { type: 'peaking', freq: 3200, gain: 11.0, q: 1.8 },
    b2: { type: 'lowshelf', freq: 150, gain: -5.0, q: 0.8 }
  },
  {
    name: 'Sub Weight + Harshness Cut',
    desc: 'Low-shelf boost @ 95 Hz + Peaking cut @ 2.8 kHz',
    b1: { type: 'lowshelf', freq: 95, gain: 8.5, q: 0.85 },
    b2: { type: 'peaking', freq: 2800, gain: -10.0, q: 1.6 }
  },
  {
    name: 'Telephone Bandpass Character',
    desc: 'High-pass @ 420 Hz + Low-pass @ 2.6 kHz',
    b1: { type: 'highpass', freq: 420, gain: 0, q: 0.85 },
    b2: { type: 'lowpass', freq: 2600, gain: 0, q: 0.85 }
  },
  {
    name: 'De-Mud + Brilliance Lift',
    desc: 'Peaking cut @ 280 Hz + High-shelf boost @ 7.5 kHz',
    b1: { type: 'peaking', freq: 280, gain: -9.5, q: 1.4 },
    b2: { type: 'highshelf', freq: 7500, gain: 9.0, q: 0.85 }
  },
  {
    name: 'Nasal Honk + Air Attenuation',
    desc: 'Peaking boost @ 750 Hz + Low-pass @ 5.2 kHz',
    b1: { type: 'peaking', freq: 750, gain: 10.0, q: 1.7 },
    b2: { type: 'lowpass', freq: 5200, gain: 0, q: 0.85 }
  },
  {
    name: 'Sibilance Tame + Punch',
    desc: 'Peaking cut @ 6.2 kHz + Peaking boost @ 110 Hz',
    b1: { type: 'peaking', freq: 6200, gain: -10.5, q: 2.0 },
    b2: { type: 'peaking', freq: 110, gain: 8.5, q: 1.4 }
  },
  {
    name: 'Hollow Body + Gloss',
    desc: 'Peaking cut @ 480 Hz + High-shelf boost @ 6.0 kHz',
    b1: { type: 'peaking', freq: 480, gain: -10.0, q: 1.5 },
    b2: { type: 'highshelf', freq: 6000, gain: 9.5, q: 0.9 }
  }
];

/**
 * Optional deterministic PRNG for reproducible test runs.
 */
function createSeededRandomGenerator(seedVal) {
  let s = (Number(seedVal) || 123456789) >>> 0;
  return function() {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let activeRngFn = Math.random;
function setGameRandomSeed(seedVal) {
  activeRngFn = seedVal != null ? createSeededRandomGenerator(seedVal) : Math.random;
}

/**
 * Generates psychoacoustically scaled target parameters across Levels 1-10 for any module.
 */
function generateQuestionTarget(gameMode, level, mockConfig) {
  const safeLevel = Math.max(1, Math.min(10, parseInt(level, 10) || 3));
  const lvlSpec = LEVEL_SCALING[safeLevel] || LEVEL_SCALING[3];
  const baseQ = (mockConfig && mockConfig.q) ? Number(mockConfig.q) : lvlSpec.q;
  const baseGain = (mockConfig && mockConfig.gain) ? Number(mockConfig.gain) : lvlSpec.gain;

  const target = {
    frequencyHz: 1000,
    gainDb: baseGain,
    q: baseQ,
    filterType: 'lowpass',
    pan: 0.0,
    knightChoices: [],
    targetKnightIdx: 0,
    maxHearts: lvlSpec.hearts || 3,
    freqRange: [lvlSpec.freqMin || 80, lvlSpec.freqMax || 12000],
    psychoacousticRegion: 'Neutral Studio Band'
  };

  if (gameMode === 'bass') {
    // Unified Bass Detective stage zoom: 50–400 Hz; narrows gently at lower levels
    const fMin = safeLevel <= 2 ? 70 : (safeLevel <= 4 ? 58 : 50);
    const fMax = safeLevel <= 2 ? 320 : 400;
    const minL = Math.log10(fMin);
    const maxL = Math.log10(fMax);
    target.frequencyHz = Math.round(Math.pow(10, minL + activeRngFn() * (maxL - minL)));
    target.freqRange = [fMin, fMax];
  } else if (gameMode === 'feedback') {
    const pool = safeLevel <= 2
      ? ISO_20_BANDS.filter(f => f >= 200 && f <= 4000)
      : (safeLevel <= 5 ? ISO_20_BANDS.filter(f => f >= 80 && f <= 6300) : ISO_20_BANDS);
    const idx = Math.floor(activeRngFn() * pool.length);
    target.frequencyHz = pool[idx];
    target.q = 10.0;
    target.freqRange = [pool[0], pool[pool.length - 1]];
  } else if (gameMode === 'filter') {
    const fTypes = ['lowpass', 'highpass', 'bandpass', 'notch'];
    target.filterType = fTypes[Math.floor(activeRngFn() * fTypes.length)];
    const fMin = Math.round(220 - ((safeLevel - 1) / 9) * 150); // 220 Hz -> 70 Hz
    const fMax = Math.round(4500 + ((safeLevel - 1) / 9) * 8500); // 4.5 kHz -> 13 kHz
    const minL = Math.log10(fMin);
    const maxL = Math.log10(fMax);
    target.frequencyHz = Math.round(Math.pow(10, minL + activeRngFn() * (maxL - minL)));
    target.freqRange = [fMin, fMax];
  } else {
    const fMin = (mockConfig && mockConfig.blindFft) ? 60 : (lvlSpec.freqMin || 80);
    const fMax = (mockConfig && mockConfig.blindFft) ? 14000 : (lvlSpec.freqMax || 12000);
    const minL = Math.log10(fMin);
    const maxL = Math.log10(fMax);
    target.frequencyHz = Math.round(Math.pow(10, minL + activeRngFn() * (maxL - minL)));
    target.freqRange = [fMin, fMax];
  }

  // Apply ISO-226 psychoacoustic compensation for gain & Q so extreme frequencies stay audible
  // while mid-presence (1-4 kHz) tests razor-sharp discrimination
  const psycho = getPsychoacousticBandFactor(target.frequencyHz, gameMode);
  target.psychoacousticRegion = psycho.region;
  const effectiveGain = Number(Math.max(1.5, Math.min(13.5, baseGain * psycho.gainMult)).toFixed(1));
  const effectiveQ = gameMode === 'feedback'
    ? 10.0
    : Number(Math.max(1.1, Math.min(6.0, baseQ * psycho.qMult)).toFixed(2));

  target.gainDb = effectiveGain;
  target.q = effectiveQ;

  if (gameMode === 'cut') {
    target.gainDb = Number((-Math.abs(effectiveGain) - 1.5).toFixed(1));
  } else if (gameMode === 'mirror') {
    const sign = activeRngFn() > 0.4 ? 1 : -1;
    const floorMag = Math.max(2.5, Math.round(effectiveGain * 0.7 * 2) / 2);
    const spanSteps = Math.max(4, Math.round((effectiveGain * 1.15 - floorMag) * 2));
    const mag = Math.min(12.0, floorMag + Math.floor(activeRngFn() * spanSteps) * 0.5);
    target.gainDb = sign * mag;
  } else if (gameMode === 'knight') {
    const pool = KNIGHT_CURVES.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(activeRngFn() * (i + 1));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    target.knightChoices = pool.slice(0, 4);
    target.targetKnightIdx = Math.floor(activeRngFn() * 4);
  }

  return target;
}

const SG_PASS_ACCURACY_THRESHOLD = 70;

function shiftYmdDateKey(ymd, deltaDays) {
  const parts = String(ymd || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return '';
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + (deltaDays || 0)));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isDailyRecordActiveForHabit(rec) {
  return Boolean(rec && ((rec.practiceSec || 0) >= 10 || (rec.questionsAnswered || 0) >= 1));
}

/**
 * Computes the user's current Habit & Consistency Weighting Profile (0.65x to 1.50x).
 * Rewards consecutive practice days, weekly cadence, Daily Circuit completion, Mock Exams,
 * and Daily Time Goals; reduces gain multiplier when skipping days or abandoning tests early.
 */
function computeHabitWeightingProfile(dataRoot, todayKeyInput) {
  const root = dataRoot || {};
  const dailyMap = root.dailyStats || {};
  const tz = (root.app && root.app.timeZone) || 'Asia/Ho_Chi_Minh';
  const todayKey = todayKeyInput || (typeof formatDateToKeyInTz === 'function'
    ? formatDateToKeyInTz(new Date(), tz)
    : new Date().toISOString().slice(0, 10));

  // Consecutive practice-day streak ending today or yesterday (capped at 60 matching bonus formula)
  let dayStreak = 0;
  for (let i = 0; i < 62; i++) {
    const dk = shiftYmdDateKey(todayKey, -i);
    if (isDailyRecordActiveForHabit(dailyMap[dk])) {
      dayStreak++;
      if (dayStreak >= 60) break;
    } else if (i === 0) {
      continue;
    } else {
      break;
    }
  }

  // Rolling 7-day cadence & recent skipped days
  const firstKey = root.app && root.app.firstUseAt
    ? (typeof formatDateToKeyInTz === 'function'
        ? formatDateToKeyInTz(new Date(root.app.firstUseAt), tz)
        : String(root.app.firstUseAt).slice(0, 10))
    : todayKey;

  let activeDaysLast7 = 0;
  let skippedDaysLast7 = 0;
  for (let i = 0; i < 7; i++) {
    const dk = shiftYmdDateKey(todayKey, -i);
    const rec = dailyMap[dk];
    if (isDailyRecordActiveForHabit(rec)) {
      activeDaysLast7++;
    } else if (i > 0 && dk > firstKey && dk < todayKey) {
      skippedDaysLast7++;
    } else if (rec && rec.skipPenaltyApplied) {
      skippedDaysLast7++;
    }
  }

  const todayRec = dailyMap[todayKey] || {};
  const goalSec = Math.max(60, ((root.settings && root.settings.dailyGoalMinutes) || 15) * 60);
  const dailyGoalMetToday = (todayRec.practiceSec || 0) >= goalSec;

  const circuitMap = (root.dailyCompletedByDate && root.dailyCompletedByDate[todayKey]) || {};
  const circuitDoneCount = ['peak', 'bass', 'feedback'].filter(k => Boolean(circuitMap[k])).length;
  const circuitCompletedToday = circuitDoneCount === 3;

  const mockCompletedToday = (root.mockExamHistory || []).some(
    m => m && m.date === todayKey && m.status !== 'aborted'
  );
  const abandonedTodayCount = Math.max(0, Number(todayRec.abandonedCount) || 0);

  let rawWeight = 1.00;
  rawWeight += Math.min(0.28, dayStreak * 0.04);
  if (activeDaysLast7 >= 5) rawWeight += 0.06;
  else if (activeDaysLast7 >= 3) rawWeight += 0.03;
  if (circuitCompletedToday) rawWeight += 0.08;
  if (mockCompletedToday) rawWeight += 0.08;
  if (dailyGoalMetToday) rawWeight += 0.05;
  rawWeight -= Math.min(0.24, skippedDaysLast7 * 0.08);
  rawWeight -= Math.min(0.16, abandonedTodayCount * 0.08);

  const weight = Number(Math.max(0.65, Math.min(1.50, rawWeight)).toFixed(2));
  let tier = 'Baseline';
  if (weight >= 1.25) tier = 'Locked-In Habit';
  else if (weight >= 1.05) tier = 'Steady Momentum';
  else if (weight < 0.95) tier = 'Habit Rust';

  // Dynamic user behavioral archetype & volume resilience
  const todayQuestions = Math.max(0, Number(todayRec.questionsAnswered) || 0);
  const todayPracticeSec = Math.max(0, Number(todayRec.practiceSec) || 0);
  let trainingArchetype = 'REGULAR_TRAINER';
  if (activeDaysLast7 >= 4 && (todayQuestions >= 30 || dayStreak >= 3 || todayPracticeSec >= 600)) {
    trainingArchetype = 'DEDICATED_GRINDER';
  } else if (activeDaysLast7 < 2 && dayStreak < 2) {
    trainingArchetype = 'CASUAL_SPORADIC';
  }

  const fatigueDamping = (isDailyRecordActiveForHabit(todayRec) && todayQuestions >= 30)
    ? Math.min(0.35, Number(((todayQuestions - 30) * 0.007).toFixed(3)))
    : 0.0;

  return {
    weight,
    tier,
    dayStreak,
    activeDaysLast7,
    skippedDaysLast7,
    circuitDoneCount,
    circuitCompletedToday,
    mockCompletedToday,
    dailyGoalMetToday,
    abandonedTodayCount,
    todayQuestions,
    todayPracticeSec,
    trainingArchetype,
    fatigueDamping
  };
}

/**
 * Non-Linear ELO Diminishing Returns Curve (Scoring v8):
 * Makes gaining additional SPI points progressively harder at high and master tiers.
 * - Low Tier (<= 1200 SPI): Accelerated growth factor 1.30x (encourages newcomers)
 * - Core Tier (1200 - 2000 SPI): Standard progression 1.30x -> 0.90x
 * - Advanced Tier (2000 - 2800 SPI): Moderate resistance 0.90x -> 0.55x
 * - Senior Mix Tier (2800 - 3600 SPI): High resistance 0.55x -> 0.30x
 * - Golden Ears Master Tier (> 3600 SPI): Asymptotic ceiling 0.30x -> 0.18x
 */
function getSpiDiminishingFactor(currentSpi) {
  const s = Math.max(500, Number(currentSpi) || 1000);
  if (s <= 1200) return 1.30;
  if (s <= 2000) return Number((1.30 - 0.40 * ((s - 1200) / 800)).toFixed(3));
  if (s <= 2800) return Number((0.90 - 0.35 * ((s - 2000) / 800)).toFixed(3));
  if (s <= 3600) return Number((0.55 - 0.25 * ((s - 2800) / 800)).toFixed(3));
  return Number(Math.max(0.18, 0.30 - 0.12 * ((s - 3600) / 1400)).toFixed(3));
}

/**
 * Reconciles missed completed calendar days strictly before `todayKey` (idempotently).
 * Applies progressive SPI decay (-10, -15, -22/day for consecutive skipped days) when no
 * qualifying training activity occurred on a past completed day since `firstUseAt`.
 */
function reconcileSkippedDayPenalties(dataRoot, todayKeyInput) {
  if (!dataRoot || !dataRoot.app || !dataRoot.app.firstUseAt || !dataRoot.score) {
    return { appliedDays: 0, totalPenalty: 0 };
  }
  const tz = dataRoot.app.timeZone || 'Asia/Ho_Chi_Minh';
  const todayKey = todayKeyInput || (typeof formatDateToKeyInTz === 'function'
    ? formatDateToKeyInTz(new Date(), tz)
    : new Date().toISOString().slice(0, 10));

  const firstKey = typeof formatDateToKeyInTz === 'function'
    ? formatDateToKeyInTz(new Date(dataRoot.app.firstUseAt), tz)
    : String(dataRoot.app.firstUseAt).slice(0, 10);

  if (!firstKey || firstKey >= todayKey) {
    return { appliedDays: 0, totalPenalty: 0 };
  }

  dataRoot.dailyStats = dataRoot.dailyStats || {};
  dataRoot.recentBehaviorEvents = Array.isArray(dataRoot.recentBehaviorEvents) ? dataRoot.recentBehaviorEvents : [];

  // Build up to last 90 completed days between firstKey and todayKey - 1
  const firstMs = Date.parse(dataRoot.app.firstUseAt);
  const startOffsetCheck = !isNaN(firstMs) && (Date.now() - firstMs) >= 18 * 3600000 ? 0 : 1;
  const candidateStart = shiftYmdDateKey(firstKey, startOffsetCheck);
  const earliestWindow = shiftYmdDateKey(todayKey, -90);
  const scanStart = candidateStart > earliestWindow ? candidateStart : earliestWindow;

  if (!scanStart || scanStart >= todayKey) {
    return { appliedDays: 0, totalPenalty: 0 };
  }

  // Track running SPI before scanStart
  const sortedKeys = Object.keys(dataRoot.dailyStats).sort();
  let runningSpi = dataRoot.score.currentSpi || 1000;
  for (let i = sortedKeys.length - 1; i >= 0; i--) {
    const dk = sortedKeys[i];
    if (dk < scanStart && dataRoot.dailyStats[dk] && typeof dataRoot.dailyStats[dk].spiEnd === 'number') {
      runningSpi = dataRoot.dailyStats[dk].spiEnd;
      break;
    }
  }

  let consecutiveSkips = 0;
  let appliedDays = 0;
  let totalPenalty = 0;
  let curKey = scanStart;
  let guard = 0;

  while (curKey < todayKey && guard < 95) {
    guard++;
    const existing = dataRoot.dailyStats[curKey];
    if (isDailyRecordActiveForHabit(existing)) {
      consecutiveSkips = 0;
      if (typeof existing.spiEnd === 'number') {
        runningSpi = existing.spiEnd;
      }
    } else if (existing && existing.skipPenaltyApplied) {
      consecutiveSkips++;
      if (typeof existing.spiEnd === 'number') {
        runningSpi = existing.spiEnd;
      }
    } else {
      consecutiveSkips++;
      const plannedDrop = consecutiveSkips === 1 ? 5 : (consecutiveSkips === 2 ? 8 : 12);
      const curSpi = typeof dataRoot.score.currentSpi === 'number' ? dataRoot.score.currentSpi : runningSpi;
      const nextSpi = Math.max(500, curSpi - plannedDrop);
      const actualDrop = curSpi - nextSpi;

      const dayStartSpi = curSpi;
      dataRoot.score.currentSpi = nextSpi;
      runningSpi = nextSpi;

      dataRoot.dailyStats[curKey] = Object.assign({
        date: curKey,
        practiceSec: 0,
        spiStart: dayStartSpi,
        spiEnd: nextSpi,
        spiDelta: -actualDrop,
        questionsAnswered: 0,
        accuracySum: 0,
        scorePoints: 0,
        sessionsCompleted: 0,
        mockExams: 0,
        abandonedCount: 0
      }, existing || {}, {
        spiStart: existing && typeof existing.spiStart === 'number' ? existing.spiStart : dayStartSpi,
        spiEnd: nextSpi,
        spiDelta: -actualDrop,
        skipPenaltyApplied: true,
        skipPenaltyDelta: -actualDrop
      });

      const behaviorId = `skip-${curKey}`;
      if (!dataRoot.recentBehaviorEvents.some(ev => ev && ev.behaviorId === behaviorId)) {
        dataRoot.recentBehaviorEvents.unshift({
          behaviorId,
          type: 'skip_day',
          localDate: curKey,
          timestamp: new Date().toISOString(),
          label: `Skipped Practice Day (${curKey})`,
          detail: `Consecutive skip #${consecutiveSkips} decay`,
          spiDelta: -actualDrop
        });
      }

      appliedDays++;
      totalPenalty += actualDrop;
    }
    curKey = shiftYmdDateKey(curKey, 1);
  }

  // Keep today's spiStart aligned if today has no activity yet
  const todayRec = dataRoot.dailyStats[todayKey];
  if (todayRec && !isDailyRecordActiveForHabit(todayRec) && !todayRec.abandonedCount) {
    todayRec.spiStart = dataRoot.score.currentSpi;
    todayRec.spiEnd = dataRoot.score.currentSpi;
    todayRec.spiDelta = 0;
  }

  dataRoot.recentBehaviorEvents = dataRoot.recentBehaviorEvents.slice(0, 100);
  return { appliedDays, totalPenalty };
}

/**
 * Evaluates a user response (or timeout) against the target parameters using
 * psychoacoustic tolerance scaling, precision-convex reward curves, near-miss
 * heart protection (Scoring Algorithm v5), and habit weighting.
 */
function scoreQuestionSubmission(params) {
  const {
    gameMode,
    level,
    target,
    reactionSec,
    isTimeout,
    habitWeight
  } = params;
  const user = params.user || {};
  const fmtHz = typeof formatHz === 'function' ? formatHz : (hz => `${Math.round(Number(hz) || 0)} Hz`);

  const safeLevel = Math.max(1, Math.min(10, parseInt(level, 10) || 3));
  const lvlSpec = LEVEL_SCALING[safeLevel] || LEVEL_SCALING[3];
  const baseTolCents = lvlSpec.maxTolCents || 1180;
  const safeHabitWeight = Math.max(0.65, Math.min(1.50, Number(habitWeight) || 1.0));

  if (isTimeout) {
    return {
      status: 'timeout',
      passed: false,
      isNearMiss: false,
      deductHeart: true,
      accuracy: 0,
      scorePoints: 0,
      spiDelta: -10,
      habitWeightApplied: safeHabitWeight,
      errors: { timeout: true },
      feedbackDetail: `Time expired! Target was ${fmtHz(target.frequencyHz)}. Timeout penalty applied (-10 SPI).`
    };
  }

  const safeUserFreq = Math.max(20, Number(user.frequencyHz) || 1000);
  const safeTargetFreq = Math.max(20, Number(target.frequencyHz) || 1000);
  const psycho = getPsychoacousticBandFactor(safeTargetFreq, gameMode);
  const baseTolErb = lvlSpec.baseTolErb || 5.3;
  const effectiveTolErb = baseTolErb * psycho.toleranceMult;

  const userErb = camScaleErb(safeUserFreq);
  const targetErb = camScaleErb(safeTargetFreq);
  const deltaErb = Math.abs(userErb - targetErb);

  const frequencyErrorCents = 1200 * Math.abs(Math.log2(safeUserFreq / safeTargetFreq));
  const octDiff = frequencyErrorCents / 1200;

  // Primary psychoacoustic ERB-rate accuracy (Scoring v7)
  let freqAcc = Math.max(0, Math.min(100, Math.round((1 - deltaErb / effectiveTolErb) * 100)));

  // Physical Filter Bandwidth Awareness (-3 dB passband identification for parametric filters)
  // For games with peaking/bell/shelf filters (Peak Master, Kit Cut, Mirror, Filter),
  // falling within the active half-power bandwidth (BW = f0 / Q) is an acoustically valid detection.
  let isPassbandHit = false;
  if (gameMode !== 'feedback' && gameMode !== 'knight') {
    const targetQ = Number(target.q) || lvlSpec.q || 2.0;
    const halfBwCents = 865 / Math.max(0.5, targetQ);
    const passbandRatio = frequencyErrorCents / halfBwCents;
    const filterAcc = Math.max(0, Math.min(100, Math.round(100 - passbandRatio * 24)));
    if (filterAcc > freqAcc) {
      freqAcc = filterAcc;
      isPassbandHit = (passbandRatio <= 1.05);
    }
  }

  // Octave Harmonic Awareness:
  // If user hit near +/- 85 cents of 1 octave (1200 cents) or 2 octaves (2400 cents),
  // recognize correct pitch chroma / harmonic resonance and grant near-miss heart protection (52% accuracy).
  const isOctaveHarmonicNearMiss = (Math.abs(frequencyErrorCents - 1200) <= 85 || Math.abs(frequencyErrorCents - 2400) <= 85);
  let octaveHarmonicBonus = false;
  if (freqAcc < 45 && isOctaveHarmonicNearMiss) {
    freqAcc = 52;
    octaveHarmonicBonus = true;
  }

  let finalAcc = freqAcc;
  let feedbackDetail = '';
  const errors = {
    frequencyCents: Number(frequencyErrorCents.toFixed(1)),
    octaveDiff: Number(octDiff.toFixed(2)),
    deltaErb: Number(deltaErb.toFixed(2)),
    isPassbandHit: isPassbandHit,
    octaveHarmonicBonus: octaveHarmonicBonus
  };

  if (gameMode === 'mirror') {
    const gainErrorDb = Math.abs((user.gainDb || 0) - (target.gainDb || 0));
    const polarityMismatch = (user.gainDb || 0) * (target.gainDb || 0) < -1.0;
    errors.gainErrorDb = Number(gainErrorDb.toFixed(1));
    errors.polarityMismatch = polarityMismatch;
    let gainAcc = Math.max(0, Math.min(100, Math.round((1 - gainErrorDb / 11.0) * 100)));
    if (polarityMismatch) gainAcc = Math.round(gainAcc * 0.25);
    finalAcc = Math.round(freqAcc * 0.65 + gainAcc * 0.35);
    if (polarityMismatch) finalAcc = Math.min(finalAcc, 55);
    feedbackDetail = `Your EQ: ${fmtHz(safeUserFreq)} (${user.gainDb > 0 ? '+' : ''}${user.gainDb} dB) • Target: ${fmtHz(safeTargetFreq)} (${target.gainDb > 0 ? '+' : ''}${target.gainDb} dB) • Error: ${errors.frequencyCents} cents, ${errors.gainErrorDb} dB`;
  } else if (gameMode === 'filter') {
    const filterTypeMatched = user.filterType === target.filterType;
    errors.filterTypeMatched = filterTypeMatched;
    finalAcc = filterTypeMatched ? Math.round(freqAcc * 0.65 + 35) : Math.round(freqAcc * 0.25);
    feedbackDetail = `Filter Type: ${filterTypeMatched ? 'Matched' : 'Mismatch'} (Target: ${String(target.filterType).toUpperCase()}) • Cutoff Target: ${fmtHz(safeTargetFreq)} (Error: ${errors.frequencyCents} cents)`;
  } else if (gameMode === 'knight') {
    const curveMatched = user.knightIdx === target.targetKnightIdx;
    errors.curveMatched = curveMatched;
    delete errors.frequencyCents;
    delete errors.octaveDiff;
    finalAcc = curveMatched ? 100 : 0;
    const correctCurve = (target.knightChoices && target.knightChoices[target.targetKnightIdx]) || KNIGHT_CURVES[0];
    const letters = ['A', 'B', 'C', 'D'];
    feedbackDetail = curveMatched
      ? `Correct curve [${letters[target.targetKnightIdx]}]: ${correctCurve.name} (${correctCurve.desc})`
      : `Incorrect choice. Target was [${letters[target.targetKnightIdx]}]: ${correctCurve.name} (${correctCurve.desc})`;
  } else if (gameMode === 'feedback') {
    const exactBand = safeUserFreq === safeTargetFreq;
    errors.exactBandMatched = exactBand;
    finalAcc = exactBand ? 100 : Math.max(0, Math.min(95, Math.round((1 - frequencyErrorCents / 700) * 100)));
    feedbackDetail = exactBand
      ? `Attenuated feedback tone at ${fmtHz(safeTargetFreq)} in ${(reactionSec || 0).toFixed(1)}s!`
      : `Feedback ring was at ${fmtHz(safeTargetFreq)} • You notched ${fmtHz(safeUserFreq)} (${errors.frequencyCents} cents off)`;
  } else {
    if (octaveHarmonicBonus) {
      feedbackDetail = `Octave Harmonic Awareness: ${fmtHz(safeUserFreq)} (${errors.octaveDiff} oct from ${fmtHz(safeTargetFreq)}) • Chroma matched! Heart protected.`;
    } else {
      feedbackDetail = `Your Selection: ${fmtHz(safeUserFreq)} • Target: ${fmtHz(safeTargetFreq)} • Error: ${errors.frequencyCents} cents (${errors.deltaErb} ERB, ${errors.octaveDiff} oct)`;
    }
  }

  const passed = finalAcc >= SG_PASS_ACCURACY_THRESHOLD;
  const isNearMiss = !passed && !isTimeout && finalAcc >= 45 &&
    (gameMode !== 'mirror' || !errors.polarityMismatch) &&
    (gameMode !== 'filter' || errors.filterTypeMatched) &&
    (gameMode !== 'knight');
  const deductHeart = !passed && !isNearMiss;

  const levelMult = 1 + (safeLevel - 1) * 0.14;
  const spiLevelMult = 0.86 + (safeLevel - 1) * 0.06;

  const currentSpi = Math.max(500, Number(params.currentSpi) || 1000);
  const spiDiminish = getSpiDiminishingFactor(currentSpi);
  const isPractice = (params.mode === 'practice' || (!params.isMockExam && !params.mockExamActive));
  const todayQuestions = Math.max(0, Number(params.todayQuestions) || 0);

  let scorePoints = 0;
  let spiDelta = 0;

  if (passed) {
    const precisionRatio = Math.max(0, Math.min(1, (finalAcc - SG_PASS_ACCURACY_THRESHOLD) / (100 - SG_PASS_ACCURACY_THRESHOLD)));
    const precisionFactor = 0.28 + 0.72 * Math.pow(precisionRatio, 1.55);

    let speedBonusPts = 0;
    if ((gameMode === 'feedback' || gameMode === 'cheetah') && reactionSec > 0 && reactionSec < 6) {
      speedBonusPts = Math.round((6 - reactionSec) * 10 * (0.5 + 0.5 * precisionRatio));
    }

    scorePoints = Math.round((1000 * precisionFactor * levelMult + speedBonusPts) * safeHabitWeight);
    const baseSpi = gameMode === 'knight'
      ? 12
      : (3 + 14 * Math.pow(precisionRatio, 1.15));
    // Scoring v8: Non-linear ELO diminishing returns curve & habit volume scaling
    const rawDelta = Math.round(baseSpi * spiLevelMult * safeHabitWeight * spiDiminish);
    spiDelta = Math.max(1, Math.min(28, rawDelta));
  } else if (isNearMiss) {
    // Scoring v8: Near-miss (45%-69%) rewards ear effort with diminishing returns
    scorePoints = Math.round(300 * (finalAcc / SG_PASS_ACCURACY_THRESHOLD) * safeHabitWeight);
    if (finalAcc >= 60) {
      // 60%-69%: High near-miss (within ~1/3 octave) earns +1 to +2 SPI, scaled down at master SPI
      const nearDelta = Math.round(1.5 * safeHabitWeight * spiDiminish);
      spiDelta = Math.max(1, Math.min(3, nearDelta));
    } else if (finalAcc >= 50) {
      // 50%-59%: Solid effort, neutral SPI
      spiDelta = 0;
    } else {
      // 45%-49%: Outer edge of near miss, gentle -1 SPI
      spiDelta = -1;
    }
  } else {
    // Scoring v8: Severe miss (<45%, timeout, or inverted polarity)
    scorePoints = 0;
    if (gameMode === 'knight') {
      const knightRiskMult = 0.92 + (safeLevel - 1) * 0.025;
      spiDelta = -Math.round(6 * knightRiskMult);
    } else {
      const missRatio = Math.max(0.02, Math.min(1, (SG_PASS_ACCURACY_THRESHOLD - finalAcc) / SG_PASS_ACCURACY_THRESHOLD));
      const levelRiskMult = 0.88 + (safeLevel - 1) * 0.025;
      // At Master tier (>=2800 SPI), blunders face tighter scrutiny/accountability
      const masterAccountability = currentSpi >= 2800 ? 1.15 : 1.0;
      const rawPenalty = Math.round((2 + 8 * Math.pow(missRatio, 1.75)) * levelRiskMult * masterAccountability);

      const maxPenalty = isPractice ? (currentSpi >= 2800 ? 6 : 5) : 10;
      const basePenalty = Math.min(maxPenalty, rawPenalty);

      // Dedicated / Heavy-volume trainers get ear fatigue damping during long practice sessions
      let fatigueDamping = 0;
      if (isPractice && todayQuestions >= 30) {
        fatigueDamping = Math.min(0.35, (todayQuestions - 30) * 0.007);
      }
      const dampedPenalty = Math.round(basePenalty * (1.0 - fatigueDamping));
      spiDelta = -Math.max(1, dampedPenalty);
    }
  }

  return {
    status: passed ? 'correct' : (isNearMiss ? 'near_miss' : (isTimeout ? 'timeout' : 'incorrect')),
    passed: passed,
    isNearMiss: isNearMiss,
    deductHeart: deductHeart,
    accuracy: finalAcc,
    scorePoints: scorePoints,
    spiDelta: spiDelta,
    habitWeightApplied: safeHabitWeight,
    errors: errors,
    feedbackDetail: feedbackDetail
  };
}


/* ==================== [MODULE: MockTests.html] ==================== */

/**
 * Earlisthenic — MockTests.html
 * Weekly 7-day Mock Exam Builder, deterministic question queue, per-question timer,
 * race-safe timeout/submission handling, and per-game score attribution.
 */

const DAY_META_EN = [
  { id: 1, short: 'Mon', name: 'Monday', focus: 'Peak & Cut Foundations' },
  { id: 2, short: 'Tue', name: 'Tuesday', focus: 'Low-End & Filter Control' },
  { id: 3, short: 'Wed', name: 'Wednesday', focus: 'EQ Mirror & Curve Match' },
  { id: 4, short: 'Thu', name: 'Thursday', focus: 'Live Sound & Spatial' },
  { id: 5, short: 'Fri', name: 'Friday', focus: 'High-Speed Reflex Blitz' },
  { id: 6, short: 'Sat', name: 'Saturday', focus: 'Full Studio Mix Audit' },
  { id: 0, short: 'Sun', name: 'Sunday', focus: 'Mastering Precision Exam' }
];

const MOCK_EXAM_TIERS = {
  intern: {
    id: 'intern',
    name: 'Intern',
    levelLabel: 'Entry / Foundation',
    badge: '10 QUESTIONS • 5 MIN',
    desc: 'Ideal for beginners and quick warm-ups. Clear gain differences and broad filter curves across peaking boosts, cuts, and low-end detection.',
    gain: 8.5,
    q: 1.8,
    timeLimit: 300,
    lives: 4,
    stages: { peak: 3, cut: 3, bass: 2, filter: 2 }
  },
  engineer: {
    id: 'engineer',
    name: 'Engineer',
    levelLabel: 'Studio Pro • Recommended',
    badge: '15 QUESTIONS • 5 MIN',
    desc: 'Standard professional certification. Full-spectrum EQ matching, multiband curves, low-end resonance, and live sound feedback notch control.',
    gain: 5.5,
    q: 2.4,
    timeLimit: 300,
    lives: 3,
    stages: { peak: 3, cut: 3, bass: 2, mirror: 2, knight: 2, feedback: 3 }
  },
  legend: {
    id: 'legend',
    name: 'Legend',
    levelLabel: 'Golden Ears / Master',
    badge: '20 QUESTIONS • 5 MIN',
    desc: 'Ultimate mastering-grade challenge. Subtle ±3 dB equalization, surgical Q notches, multiband comparisons, and rapid reflex sweeps.',
    gain: 3.0,
    q: 3.8,
    timeLimit: 300,
    lives: 2,
    stages: { peak: 3, cut: 3, bass: 2, mirror: 3, knight: 3, filter: 2, cheetah: 2, feedback: 2 }
  }
};

function renderMockTierCards() {
  const container = document.getElementById('mock-tier-cards-grid');
  if (!container) return;

  const currentTier = appState.selectedMockTier || 'engineer';

  container.innerHTML = Object.values(MOCK_EXAM_TIERS).map(tier => {
    const isSelected = tier.id === currentTier;
    const isRecommended = tier.id === 'engineer';
    return `
      <div class="washi-card p-5 sm:p-6 flex flex-col justify-between space-y-4 border-2 transition-all ${
        isSelected
          ? 'border-[#B56D4E] shadow-md bg-[#FBF8F1]'
          : 'border-[#D8CDBB] hover:border-[#BFB29C] bg-[#FBF8F1]/80'
      }">
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[10px] font-mono-tabular uppercase font-semibold px-2 py-0.5 rounded ${
              isRecommended ? 'bg-[#E6ECE0] text-[#5E6B50] border border-[#5E6B50]/30' : 'bg-[#EAE2D4] text-[#6E675B]'
            }">
              ${tier.levelLabel}
            </span>
            <span class="text-xs font-mono-tabular font-bold text-[#B56D4E]">
              ${tier.badge}
            </span>
          </div>

          <div>
            <h3 class="text-xl font-serif-editorial font-bold text-[#302D28]">
              ${tier.name}
            </h3>
            <p class="text-xs text-[#6E675B] mt-1 leading-relaxed">
              ${tier.desc}
            </p>
          </div>

          <div class="grid grid-cols-2 gap-2 text-xs font-mono-tabular pt-2 border-t border-[#D8CDBB]/70">
            <div class="washi-panel-muted p-2 rounded-lg">
              <span class="text-[10px] text-[#6E675B] block uppercase">DSP Tolerances</span>
              <span class="font-bold text-[#302D28]">±${tier.gain} dB · Q ${tier.q}</span>
            </div>
            <div class="washi-panel-muted p-2 rounded-lg">
              <span class="text-[10px] text-[#6E675B] block uppercase">Lives &amp; Timer</span>
              <span class="font-bold text-[#B56D4E]">${tier.lives} Hearts · 5:00</span>
            </div>
          </div>
        </div>

        <button type="button" onclick="startMockExamByTier('${tier.id}')" class="w-full py-2.5 rounded-lg text-xs font-semibold uppercase tracking-wider flex items-center justify-center gap-2 transition ${
          isRecommended ? 'btn-terracotta shadow-xs' : 'btn-outline-washi'
        }">
          <i class="fa-solid fa-play" aria-hidden="true"></i>
          <span>Start ${tier.name} Exam</span>
        </button>
      </div>
    `;
  }).join('');
}

function startMockExamByPlan(plan) {
  const queue = [];
  const activeEntries = Object.entries(plan.stages || {}).filter(([gId, cnt]) => SG_GAMES[gId] && Number(cnt) > 0);
  activeEntries.forEach(([gId, cnt], sIdx) => {
    const count = Number(cnt);
    for (let q = 1; q <= count; q++) {
      queue.push({
        gameId: gId,
        stageIndex: sIdx + 1,
        totalStages: activeEntries.length,
        qInStage: q,
        stageTotalQ: count
      });
    }
  });

  appState.mockExamActive = true;
  appState.mockExamFinished = false;
  appState.mockQueue = queue;
  appState.mockCursor = 0;
  appState.mockConfig = {
    title: plan.title || 'Mock Exam',
    tier: plan.tier || 'custom',
    gain: plan.gain !== undefined ? plan.gain : 7.5,
    q: plan.q !== undefined ? plan.q : 2.4,
    timeLimit: plan.timeLimit !== undefined ? plan.timeLimit : 300,
    blindFft: Boolean(plan.blindFft),
    stages: plan.stages
  };
  appState.mockStartTimeMs = performance.now();
  appState.mockStartedAtIso = new Date().toISOString();
  appState.mockSpiBefore = getActiveDataRoot().score.currentSpi;
  appState.mockQuestionResults = [];
  appState.mockPerGamePoints = {};
  appState.score = 0;
  appState.lives = plan.lives || 3;
  appState.maxLives = plan.lives || 3;

  startMockExamTimer();
  loadCurrentMockQueueItem();
}

function startMockExamByTier(tierId) {
  const tier = MOCK_EXAM_TIERS[tierId] || MOCK_EXAM_TIERS.engineer;
  appState.selectedMockTier = tier.id;
  startMockExamByPlan({
    title: `${tier.name} Mock Exam`,
    tier: tier.id,
    gain: tier.gain,
    q: tier.q,
    timeLimit: tier.timeLimit,
    blindFft: Boolean(tier.blindFft),
    lives: tier.lives,
    stages: tier.stages
  });
}

function createDefaultWeeklyMockPlansClient() {
  return {
    '1': { title: 'Monday: Peak & Cut Foundations', gain: 7.5, q: 2.4, timeLimit: 300, blindFft: false, stages: { peak: 3, cut: 3, bass: 2, knight: 2 } },
    '2': { title: 'Tuesday: Low-End & Filter Control', gain: 7.5, q: 2.4, timeLimit: 300, blindFft: false, stages: { bass: 4, filter: 3, cut: 3 } },
    '3': { title: 'Wednesday: EQ Mirror & Curve Match', gain: 5.5, q: 2.4, timeLimit: 360, blindFft: false, stages: { mirror: 3, knight: 3, peak: 2, filter: 2 } },
    '4': { title: 'Thursday: Live Sound & Spatial', gain: 7.5, q: 3.8, timeLimit: 300, blindFft: false, stages: { feedback: 4, cheetah: 3, peak: 3 } },
    '5': { title: 'Friday: High-Speed Reflex Blitz', gain: 5.5, q: 2.4, timeLimit: 180, blindFft: false, stages: { peak: 3, cut: 3, feedback: 2, bass: 2 } },
    '6': { title: 'Saturday: Full Studio Mix Audit', gain: 5.5, q: 3.8, timeLimit: 360, blindFft: false, stages: { peak: 2, cut: 2, bass: 2, mirror: 2, filter: 2, feedback: 2 } },
    '0': { title: 'Sunday: Mastering Precision Exam', gain: 3.5, q: 3.8, timeLimit: 300, blindFft: false, stages: { peak: 3, cut: 3, mirror: 2, bass: 2, knight: 2 } }
  };
}

function getSelectedMockPlan() {
  const dayKey = String(appState.selectedMockDay);
  if (!appState.weeklyMockPlans[dayKey]) {
    appState.weeklyMockPlans[dayKey] = createDefaultWeeklyMockPlansClient()[dayKey];
  }
  return appState.weeklyMockPlans[dayKey];
}

function renderMockDayTabsOnly() {
  const dayGrid = document.getElementById('mock-day-selector-grid');
  if (!dayGrid) return;
  const todayDow = new Date().getDay();

  dayGrid.innerHTML = DAY_META_EN.map(d => {
    const isSelected = Number(appState.selectedMockDay) === d.id;
    const isToday = todayDow === d.id;
    const plan = appState.weeklyMockPlans[String(d.id)] || createDefaultWeeklyMockPlansClient()[String(d.id)];
    const qCount = Object.values(plan.stages || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const sCount = Object.values(plan.stages || {}).filter(v => Number(v) > 0).length;

    return `
      <button type="button" onclick="selectMockBuilderDay(${d.id})" class="h-full min-h-[82px] p-3 rounded-lg border text-left transition-all flex flex-col justify-between ${
        isSelected
          ? 'bg-[#B56D4E] text-[#FBF8F1] border-[#965438]'
          : 'bg-[#FBF8F1] text-[#302D28] border-[#D8CDBB] hover:bg-[#EAE2D4]'
      }">
        <div class="flex items-center justify-between w-full">
          <span class="font-serif-editorial font-bold text-xs">${d.name}</span>
          ${isToday
            ? `<span class="px-1.5 py-0.2 rounded ${isSelected ? 'bg-black/20 text-[#FBF8F1]' : 'bg-[#E6ECE0] text-[#5E6B50]'} font-mono-tabular font-semibold text-[9px]">TODAY</span>`
            : `<span class="text-[10px] font-mono-tabular opacity-75">${d.short}</span>`
          }
        </div>
        <div class="text-[11px] font-medium truncate mt-1.5" id="mock-tab-title-${d.id}">${escapeHtml(plan.title)}</div>
        <div class="text-[10px] font-mono-tabular opacity-85 mt-1 flex items-center justify-between">
          <span id="mock-tab-counts-${d.id}">${qCount} Q • ${sCount} Mod</span>
          <span id="mock-tab-gain-${d.id}">±${plan.gain}dB</span>
        </div>
      </button>
    `;
  }).join('');
}

function renderMockTestBuilderView() {
  renderMockTierCards();
  renderMockExamHistoryList();

  // Backward-safe updates if legacy elements exist
  renderMockDayTabsOnly();
  const curDayObj = DAY_META_EN.find(d => d.id === Number(appState.selectedMockDay)) || DAY_META_EN[0];
  const curPlan = getSelectedMockPlan();

  const dayTitleEl = document.getElementById('mock-editing-day-title');
  if (dayTitleEl) dayTitleEl.textContent = curDayObj.name;

  const titleInput = document.getElementById('mock-custom-title-input');
  if (titleInput) titleInput.value = curPlan.title || `${curDayObj.name} Exam`;

  const gainSel = document.getElementById('mock-param-gain');
  if (gainSel) gainSel.value = String(curPlan.gain || 7.5);

  const qSel = document.getElementById('mock-param-q');
  if (qSel) qSel.value = String(curPlan.q || 2.4);

  const timeSel = document.getElementById('mock-param-time');
  if (curPlan.timeLimit > 0 && curPlan.timeLimit <= 60) {
    curPlan.timeLimit = 300;
  }
  if (timeSel) timeSel.value = String(curPlan.timeLimit != null ? curPlan.timeLimit : 300);

  const blindChk = document.getElementById('mock-param-blind');
  if (blindChk) blindChk.checked = Boolean(curPlan.blindFft);

  updateMockBlueprintSummary();
}

function selectMockBuilderDay(dayId) {
  appState.selectedMockDay = Number(dayId);
  sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);
  renderMockTestBuilderView();
}

function toggleMockStageGame(gameId, checked) {
  const plan = getSelectedMockPlan();
  if (!plan.stages) plan.stages = {};
  plan.stages[gameId] = checked ? 3 : 0;
  setMockStageCountLive(gameId, plan.stages[gameId]);
  commitMockPlanChange();
}

/**
 * Updates stage question count live WITHOUT rebuilding the entire form DOM on slider input.
 */
function setMockStageCountLive(gameId, val) {
  const count = Math.max(0, Math.min(10, parseInt(val, 10) || 0));
  const plan = getSelectedMockPlan();
  if (!plan.stages) plan.stages = {};
  plan.stages[gameId] = count;

  const enabled = count > 0;
  const card = document.getElementById(`mock-stage-card-${gameId}`);
  const chk = document.getElementById(`mock-stage-chk-${gameId}`);
  const badge = document.getElementById(`mock-stage-badge-${gameId}`);
  const rng = document.getElementById(`mock-stage-rng-${gameId}`);

  if (chk) chk.checked = enabled;
  if (rng && rng.value !== String(count)) rng.value = String(count);
  if (badge) {
    badge.textContent = `${count} Q`;
    badge.className = `font-mono-tabular font-semibold text-xs px-2 py-0.5 rounded ${
      enabled ? 'bg-[#EAE2D4] text-[#302D28]' : 'bg-[#F4F0E7] text-[#6E675B]'
    }`;
  }
  if (card) {
    card.className = `p-3.5 rounded-lg border transition-all flex flex-col justify-between gap-2.5 ${
      enabled ? 'bg-[#FBF8F1] border-[#B56D4E]' : 'bg-[#F4F0E7]/60 border-[#D8CDBB] opacity-75'
    }`;
  }

  updateMockBlueprintSummary();
}

function commitMockPlanChange() {
  queueProgressSync('mock-plan-update');
}

function updateCurrentMockPlanMeta() {
  const plan = getSelectedMockPlan();
  const titleEl = document.getElementById('mock-custom-title-input');
  if (titleEl) {
    plan.title = titleEl.value.trim() || 'Custom Mock Exam';
  }
  plan.gain = parseFloat(document.getElementById('mock-param-gain').value) || 7.5;
  plan.q = parseFloat(document.getElementById('mock-param-q').value) || 2.4;
  plan.timeLimit = parseInt(document.getElementById('mock-param-time').value, 10) || 0;
  plan.blindFft = Boolean(document.getElementById('mock-param-blind').checked);
  updateMockBlueprintSummary();
  queueProgressSync('mock-meta-update');
}

function applyMockPreset(presetKey) {
  const plan = getSelectedMockPlan();
  sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);

  if (presetKey === 'standard') {
    plan.title = 'Standard 10-Question Test';
    plan.gain = 7.5; plan.q = 2.4; plan.timeLimit = 300; plan.blindFft = false;
    plan.stages = { peak: 3, cut: 3, bass: 2, filter: 2 };
  } else if (presetKey === 'lowend') {
    plan.title = 'Low-End & Low-Mid Focus';
    plan.gain = 5.5; plan.q = 2.4; plan.timeLimit = 300; plan.blindFft = false;
    plan.stages = { bass: 5, cut: 3, mirror: 2, filter: 2 };
  } else if (presetKey === 'livesound') {
    plan.title = 'Live Sound & Feedback Control';
    plan.gain = 7.5; plan.q = 3.8; plan.timeLimit = 300; plan.blindFft = false;
    plan.stages = { feedback: 5, peak: 3, cheetah: 3 };
  } else if (presetKey === 'mastering') {
    plan.title = 'Mastering Precision (±2.5 dB)';
    plan.gain = 2.5; plan.q = 3.8; plan.timeLimit = 300; plan.blindFft = false;
    plan.stages = { peak: 3, cut: 3, mirror: 3, knight: 3 };
  }

  renderMockTestBuilderView();
  queueProgressSync('mock-preset');
}

function copyMockPlanToAllDays() {
  const src = JSON.parse(JSON.stringify(getSelectedMockPlan()));
  DAY_META_EN.forEach(d => {
    appState.weeklyMockPlans[String(d.id)] = {
      ...JSON.parse(JSON.stringify(src)),
      title: `${src.title} (${d.short})`
    };
  });
  sgAudioEngine.playUiCue('correct', appState.settings.uiSfxEnabled);
  renderMockTestBuilderView();
  showTransportNotice('Copied exam configuration to all 7 days of the week.');
  queueProgressSync('mock-copy-week');
}

function updateMockBlueprintSummary() {
  const plan = getSelectedMockPlan();
  const activeEntries = Object.entries(plan.stages || {}).filter(([_, cnt]) => Number(cnt) > 0);
  const totalQ = activeEntries.reduce((s, [_, cnt]) => s + Number(cnt), 0);
  const estMins = plan.timeLimit > 0 ? Math.max(1, Math.round(plan.timeLimit / 60)) : Math.max(1, Math.round(totalQ * 0.4));

  let mult = 1.0 + (10 - plan.gain) * 0.08 + (plan.q - 1.5) * 0.08;
  if (plan.blindFft) mult += 0.25;
  if (plan.timeLimit > 0 && plan.timeLimit <= 180) mult += 0.20;
  else if (plan.timeLimit > 0 && plan.timeLimit <= 300) mult += 0.10;

  const sumTitle = document.getElementById('mock-summary-title');
  if (sumTitle) sumTitle.textContent = plan.title;
  const sumBadge = document.getElementById('mock-summary-badge');
  if (sumBadge) sumBadge.textContent = `${totalQ} Questions`;
  const sumStages = document.getElementById('mock-sum-stages');
  if (sumStages) sumStages.textContent = `${activeEntries.length} Modules`;
  const sumDur = document.getElementById('mock-sum-duration');
  if (sumDur) sumDur.textContent = plan.timeLimit > 0 ? `${Math.round(plan.timeLimit / 60)} min` : 'Untimed';
  const sumMult = document.getElementById('mock-sum-mult');
  if (sumMult) sumMult.textContent = `${mult.toFixed(2)}x`;

  // Update day tab counts inline
  const dayId = appState.selectedMockDay;
  const tabTitle = document.getElementById(`mock-tab-title-${dayId}`);
  const tabCounts = document.getElementById(`mock-tab-counts-${dayId}`);
  const tabGain = document.getElementById(`mock-tab-gain-${dayId}`);
  if (tabTitle) tabTitle.textContent = plan.title;
  if (tabCounts) tabCounts.textContent = `${totalQ} Q • ${activeEntries.length} Mod`;
  if (tabGain) tabGain.textContent = `±${plan.gain}dB`;

  const listEl = document.getElementById('mock-summary-stage-list');
  if (!listEl) return;

  if (activeEntries.length === 0) {
    listEl.innerHTML = `<div class="text-xs text-[#A8463B] py-3 text-center">Enable at least 1 module to build an exam.</div>`;
  } else {
    listEl.innerHTML = activeEntries.map(([gId, cnt], idx) => {
      const g = SG_GAMES[gId];
      if (!g) return '';
      return `
        <div class="flex items-center justify-between washi-panel-muted px-3 py-1.5 text-xs">
          <span class="font-semibold text-[#302D28]"><span class="text-[#B56D4E] font-mono-tabular mr-1.5">#${idx + 1}</span>${g.name}</span>
          <span class="font-mono-tabular text-[#5E6B50] font-semibold">${cnt} Q</span>
        </div>
      `;
    }).join('');
  }
}

function startScheduledDailyMockTest() {
  startMockExamByTier('engineer');
}

function startMockTestFromBuilder() {
  if (appState.selectedMockTier && MOCK_EXAM_TIERS[appState.selectedMockTier]) {
    startMockExamByTier(appState.selectedMockTier);
    return;
  }
  const curPlan = typeof getSelectedMockPlan === 'function' ? getSelectedMockPlan() : null;
  if (curPlan && curPlan.stages && Object.values(curPlan.stages).some(c => Number(c) > 0)) {
    startMockExamByPlan(curPlan);
    return;
  }
  startMockExamByTier('engineer');
}

function loadCurrentMockQueueItem() {
  const item = appState.mockQueue[appState.mockCursor];
  if (!item) return;

  const banner = document.getElementById('arena-mock-banner');
  if (banner) {
    banner.classList.remove('hidden');
    banner.classList.add('flex');
  }

  const quickSwitcher = document.getElementById('arena-quick-switcher');
  if (quickSwitcher) {
    quickSwitcher.classList.add('xl:hidden');
  }

  document.getElementById('arena-mock-title').textContent = appState.mockConfig.title;
  document.getElementById('arena-mock-stage-info').textContent =
    `Stage ${item.stageIndex}/${item.totalStages} (${SG_GAMES[item.gameId].name}) • Question ${appState.mockCursor + 1}/${appState.mockQueue.length}`;

  const pct = Math.round(((appState.mockCursor + 1) / appState.mockQueue.length) * 100);
  document.getElementById('arena-mock-progress-bar').style.width = `${pct}%`;
  document.getElementById('arena-mock-blind-badge').classList.toggle('hidden', !appState.mockConfig.blindFft);

  launchGameFromLobby(item.gameId, true);
  appState.round = appState.mockCursor + 1;
  appState.maxRounds = appState.mockQueue.length;
  updateArenaHUD();
}

/**
 * Total Exam Timer: runs continuously across all exam questions without per-question interruptions.
 * Questions proceed smoothly like normal exercises, with live waveform/spectrum visible.
 * Answer comparisons are revealed ONLY when user clicks Submit Answer.
 */
function startMockExamTimer() {
  clearMockExamTimer();
  const qBox = document.getElementById('arena-mock-qtimer-box');
  const timerTxt = document.getElementById('arena-mock-qtimer');
  if (!appState.mockExamActive || !appState.mockConfig) {
    if (qBox) qBox.classList.add('hidden');
    return;
  }

  // Legacy per-question limit migration guard
  if (appState.mockConfig.timeLimit > 0 && appState.mockConfig.timeLimit <= 60) {
    appState.mockConfig.timeLimit = 300;
  }

  const isUntimed = !appState.mockConfig.timeLimit || appState.mockConfig.timeLimit <= 0;
  appState.mockExamTotalSec = isUntimed ? 0 : Number(appState.mockConfig.timeLimit);
  appState.mockExamSecLeft = isUntimed ? 0 : appState.mockExamTotalSec;
  appState.mockExamElapsedSec = 0;

  if (qBox) {
    qBox.classList.remove('hidden');
    qBox.className = 'px-2.5 py-1 rounded bg-[#EAE2D4] border border-[#D8CDBB] text-[#302D28] font-mono-tabular font-semibold text-xs flex items-center gap-1.5 transition-colors';
  }
  if (timerTxt) {
    timerTxt.textContent = isUntimed ? '00:00' : formatTimeMMSS(appState.mockExamSecLeft);
  }

  appState.mockExamTimerInterval = setInterval(() => {
    if (!appState.mockExamActive || appState.mockExamFinished) {
      clearMockExamTimer();
      return;
    }

    if (isUntimed) {
      appState.mockExamElapsedSec = (appState.mockExamElapsedSec || 0) + 1;
      const curTxt = document.getElementById('arena-mock-qtimer');
      if (curTxt) curTxt.textContent = formatTimeMMSS(appState.mockExamElapsedSec);
      return;
    }

    appState.mockExamSecLeft = Math.max(0, appState.mockExamSecLeft - 1);
    const curTxt = document.getElementById('arena-mock-qtimer');
    if (curTxt) curTxt.textContent = formatTimeMMSS(appState.mockExamSecLeft);

    const curBox = document.getElementById('arena-mock-qtimer-box');
    if (curBox) {
      if (appState.mockExamSecLeft <= 60) {
        curBox.className = 'px-2.5 py-1 rounded bg-[#F5E4E1] border border-[#A8463B] text-[#A8463B] font-mono-tabular font-semibold text-xs flex items-center gap-1.5 animate-pulse';
      } else {
        curBox.className = 'px-2.5 py-1 rounded bg-[#EAE2D4] border border-[#D8CDBB] text-[#302D28] font-mono-tabular font-semibold text-xs flex items-center gap-1.5 transition-colors';
      }
    }

    if (appState.mockExamSecLeft <= 0) {
      clearMockExamTimer();
      handleMockExamTimeExpired();
    }
  }, 1000);
}

function handleMockExamTimeExpired() {
  if (!appState.mockExamActive || appState.mockExamFinished) return;

  // 1. If currently in middle of an unsubmitted question:
  if (!appState.roundSubmitted) {
    evaluateArenaRound(true);
  }

  // 2. Fill any unreached questions in the queue as timeouts
  const totalQ = (appState.mockQueue || []).length;
  while ((appState.mockQuestionResults || []).length < totalQ) {
    const qIdx = appState.mockQuestionResults.length;
    const item = appState.mockQueue[qIdx];
    const gSpec = (typeof SG_GAMES !== 'undefined' && SG_GAMES[item.gameId]) || { name: item.gameId };
    appState.mockQuestionResults.push({
      eventId: generateUuid(),
      gameId: item.gameId,
      gameName: gSpec.name,
      status: 'timeout',
      passed: false,
      accuracy: 0,
      scorePoints: 0,
      spiDelta: -10,
      targetFreq: 1000,
      userFreq: 1000,
      userSummary: 'Exam Time Expired',
      targetSummary: 'Exam Time Expired',
      reactionSec: 0
    });
  }

  if (typeof showTransportNotice === 'function') {
    showTransportNotice('Total exam time expired (00:00). Finalizing exam report...', true);
  }
  finishMockTestExam();
}

function clearMockExamTimer() {
  if (appState.mockExamTimerInterval) {
    clearInterval(appState.mockExamTimerInterval);
    appState.mockExamTimerInterval = null;
  }
}

// Backwards-compatible aliases
function clearMockQuestionTimer() {
  clearMockExamTimer();
}

function startMockQuestionTimerIfNeeded() {
  // Deliberate no-op: mock test questions proceed smoothly like normal exercises without per-question interruptions!
}

function abortMockTestExam() {
  clearMockExamTimer();
  const wasActive = Boolean(appState.mockExamActive && !appState.mockExamFinished);
  const answeredQ = (appState.mockQuestionResults || []).length;
  const totalQ = (appState.mockQueue || []).length;
  const remainingQ = Math.max(1, totalQ - answeredQ);

  endActivePracticeSession('mock-aborted');
  appState.mockExamActive = false;
  appState.mockExamFinished = false;
  const banner = document.getElementById('arena-mock-banner');
  if (banner) {
    banner.classList.add('hidden');
    banner.classList.remove('flex');
  }
  const quickSwitcher = document.getElementById('arena-quick-switcher');
  if (quickSwitcher) {
    quickSwitcher.classList.remove('xl:hidden');
  }

  if (wasActive && totalQ > 0) {
    const rawPenalty = -Math.min(18, Math.max(4, Math.ceil(remainingQ * 1.5)));
    const appliedDelta = typeof applyBehavioralSpiChange === 'function'
      ? applyBehavioralSpiChange(rawPenalty, {
          type: 'incomplete_mock',
          label: `Aborted Mock Exam (${answeredQ}/${totalQ} Q)`,
          detail: `${remainingQ} remaining question${remainingQ === 1 ? '' : 's'} left unfinished`,
          countAsAbandon: true,
          skipSyncQueue: true
        })
      : rawPenalty;

    const todayKey = getLocalDateKey();
    const results = appState.mockQuestionResults || [];
    const avgAcc = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.accuracy, 0) / results.length)
      : 0;
    const totalScore = results.reduce((s, r) => s + r.scorePoints, 0);
    const dataRoot = getActiveDataRoot();
    const abortRecord = {
      examId: generateUuid(),
      timestamp: new Date().toISOString(),
      date: todayKey,
      timeLabel: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      title: `${(appState.mockConfig && appState.mockConfig.title) || 'Mock Exam'} (Incomplete)`,
      status: 'aborted',
      questionsCount: results.length,
      plannedQuestions: totalQ,
      avgAccuracy: avgAcc,
      totalScore: totalScore,
      spiChange: (dataRoot.score.currentSpi || 1000) - (appState.mockSpiBefore || 1000),
      grade: 'INC',
      durationSec: Math.max(1, Math.round((performance.now() - (appState.mockStartTimeMs || performance.now())) / 1000)),
      config: appState.mockConfig,
      perGameBreakdown: [],
      questionResults: results.slice()
    };

    dataRoot.mockExamHistory.unshift(abortRecord);
    if (!appState.demoModeActive) {
      appState.pendingSync.mockExams.push(abortRecord);
      queueProgressSync('mock-exam-aborted');
    }
    if (typeof showTransportNotice === 'function') {
      showTransportNotice(`Mock exam aborted early (${answeredQ}/${totalQ} Q): ${appliedDelta} SPI penalty applied.`, true);
    }
  }

  switchMainView('mock');
}

function finishMockTestExam() {
  if (appState.mockExamFinished) return; // Idempotency guard: finish exactly once
  appState.mockExamFinished = true;
  clearMockQuestionTimer();
  endActivePracticeSession('mock-completed', true);

  appState.mockExamActive = false;
  const banner = document.getElementById('arena-mock-banner');
  if (banner) {
    banner.classList.add('hidden');
    banner.classList.remove('flex');
  }
  const quickSwitcher = document.getElementById('arena-quick-switcher');
  if (quickSwitcher) {
    quickSwitcher.classList.remove('xl:hidden');
  }

  const elapsedSec = Math.max(1, Math.round((performance.now() - appState.mockStartTimeMs) / 1000));
  const results = appState.mockQuestionResults || [];
  const totalQ = Math.max(1, results.length);
  const avgAcc = Math.round(results.reduce((s, r) => s + r.accuracy, 0) / totalQ);
  const totalScore = results.reduce((s, r) => s + r.scorePoints, 0);
  const dataRoot = getActiveDataRoot();

  const habitProfile = typeof computeHabitWeightingProfile === 'function'
    ? computeHabitWeightingProfile(dataRoot, getLocalDateKey())
    : { weight: 1.0 };
  const completionBonus = avgAcc >= 70 ? Math.round(8 * habitProfile.weight) : 3;
  if (typeof applyBehavioralSpiChange === 'function' && completionBonus > 0) {
    applyBehavioralSpiChange(completionBonus, {
      type: 'mock_completed',
      label: `Completed Mock Exam (${results.length} Q • ${avgAcc}%)`,
      detail: `Full exam completion bonus (${habitProfile.weight.toFixed(2)}x habit weight)`,
      skipSyncQueue: true
    });
  }

  const spiChange = dataRoot.score.currentSpi - appState.mockSpiBefore;

  let grade = 'F';
  if (avgAcc >= 90) grade = 'S+';
  else if (avgAcc >= 82) grade = 'S';
  else if (avgAcc >= 74) grade = 'A';
  else if (avgAcc >= 62) grade = 'B';
  else if (avgAcc >= 50) grade = 'C';
  else grade = 'D';

  // Record per-game scores from the exam separately (never comparing cumulative exam score to a single game's high score)
  const byGame = {};
  results.forEach(r => {
    if (!byGame[r.gameId]) {
      byGame[r.gameId] = {
        gameId: r.gameId,
        gameName: r.gameName,
        count: 0,
        accSum: 0,
        points: 0,
        timeouts: 0
      };
    }
    byGame[r.gameId].count++;
    byGame[r.gameId].accSum += r.accuracy;
    byGame[r.gameId].points += r.scorePoints;
    if (r.status === 'timeout') byGame[r.gameId].timeouts++;
  });

  Object.values(byGame).forEach(gSummary => {
    // Normalize stage score to a 10-question equivalent so high-score comparison is fair
    const normalized10QScore = Math.round((gSummary.points / Math.max(1, gSummary.count)) * 10);
    recordCompletedGameSessionStats(gSummary.gameId, normalized10QScore);
  });

  const todayKey = getLocalDateKey();
  const todayRec = ensureDailyRecordForDate(todayKey);
  todayRec.mockExams = (todayRec.mockExams || 0) + 1;

  const examRecord = {
    examId: generateUuid(),
    timestamp: new Date().toISOString(),
    date: todayKey,
    timeLabel: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    title: appState.mockConfig ? appState.mockConfig.title : 'Mock Exam',
    questionsCount: results.length,
    avgAccuracy: avgAcc,
    totalScore: totalScore,
    spiChange: spiChange,
    grade: grade,
    durationSec: elapsedSec,
    config: appState.mockConfig,
    perGameBreakdown: Object.values(byGame),
    questionResults: results
  };

  dataRoot.mockExamHistory.unshift(examRecord);
  if (!appState.demoModeActive) {
    appState.pendingSync.mockExams.push(examRecord);
    queueProgressSync('mock-exam-finished');
  }

  sgAudioEngine.playUiCue('levelup', appState.settings.uiSfxEnabled);
  openMockExamReportModal(examRecord);
}

function openMockExamReportModal(examRecord) {
  if (!examRecord) return;
  document.getElementById('report-modal-title').textContent = examRecord.title || 'Mock Exam Report';
  document.getElementById('report-modal-date').textContent =
    `${examRecord.date} at ${examRecord.timeLabel || ''} • ${examRecord.questionsCount} questions`;
  document.getElementById('report-modal-grade').textContent = examRecord.grade || 'B';
  document.getElementById('report-modal-score').textContent = (examRecord.totalScore || 0).toLocaleString();
  document.getElementById('report-modal-acc').textContent = `${examRecord.avgAccuracy || 0}%`;
  const spiDelta = examRecord.spiChange || 0;
  document.getElementById('report-modal-spi-delta').textContent = `${spiDelta >= 0 ? '+' : ''}${spiDelta} SPI`;
  document.getElementById('report-modal-time').textContent = formatTimeMMSS(examRecord.durationSec || 0);

  const bdEl = document.getElementById('report-modal-breakdown');
  const breakdownList = examRecord.perGameBreakdown || [];
  bdEl.innerHTML = breakdownList.map(info => {
    const gAcc = Math.round(info.accSum / Math.max(1, info.count));
    return `
      <div class="flex items-center justify-between washi-panel-muted px-3.5 py-2">
        <span class="font-semibold text-[#302D28]">${escapeHtml(info.gameName)} (${info.count} Q${info.timeouts ? `, ${info.timeouts} timeout` : ''})</span>
        <div class="flex items-center gap-3">
          <span class="${gAcc >= 70 ? 'text-[#5E6B50]' : 'text-[#A8463B]'} font-semibold">${gAcc}% Accuracy</span>
          <span class="text-[#B56D4E] font-semibold">+${info.points.toLocaleString()} pts</span>
        </div>
      </div>
    `;
  }).join('');

  const qEl = document.getElementById('report-modal-questions');
  const qList = examRecord.questionResults || [];
  qEl.innerHTML = qList.map((q, idx) => {
    const statusBadge = q.status === 'timeout'
      ? '<span class="text-[#A8463B] font-semibold">TIMEOUT</span>'
      : `<span class="${q.passed ? 'text-[#5E6B50]' : 'text-[#A8463B]'} font-semibold">${q.accuracy}%</span>`;
    return `
      <div class="flex items-center justify-between bg-[#FBF8F1] px-3 py-1.5 rounded border border-[#D8CDBB]">
        <span>#${idx + 1} <strong>${escapeHtml(q.gameName)}</strong></span>
        <span class="text-[#6E675B]">You: ${escapeHtml(q.userSummary || formatHz(q.userFreq))} • Target: ${escapeHtml(q.targetSummary || formatHz(q.targetFreq))}</span>
        <div class="flex items-center gap-2">
          ${statusBadge}
          <span>+${q.scorePoints} pts</span>
        </div>
      </div>
    `;
  }).join('');

  const rModal = document.getElementById('mock-report-modal');
  if (rModal) {
    rModal.classList.remove('hidden');
    rModal.classList.add('flex');
  }
}

function inspectHistoricalMockExam(examId) {
  const dataRoot = getActiveDataRoot();
  const found = (dataRoot.mockExamHistory || []).find(x => x.examId === examId);
  if (found) {
    openMockExamReportModal(found);
  }
}

function closeMockReportModal(targetView) {
  const rModal = document.getElementById('mock-report-modal');
  if (rModal) {
    rModal.classList.remove('flex');
    rModal.classList.add('hidden');
  }
  switchMainView(targetView || 'stats');
}

function renderMockExamHistoryList() {
  const listEl = document.getElementById('mock-exam-history-list');
  const cntEl = document.getElementById('mock-history-count');
  if (!listEl) return;

  const dataRoot = getActiveDataRoot();
  const history = dataRoot.mockExamHistory || [];
  if (cntEl) cntEl.textContent = `${history.length} exam${history.length === 1 ? '' : 's'}`;

  if (history.length === 0) {
    listEl.innerHTML = `<div class="text-[#6E675B] text-center py-6">No completed mock exams yet. Click "Launch Selected Mock Exam" to begin.</div>`;
    return;
  }

  listEl.innerHTML = history.map(m => {
    const isAborted = m.status === 'aborted' || m.grade === 'INC';
    const deltaVal = m.spiChange || 0;
    const accDisplay = isAborted && (m.questionsCount || 0) === 0 ? 'Aborted' : `${m.avgAccuracy != null ? m.avgAccuracy : m.avgAcc}%`;
    return `
    <button type="button" onclick="inspectHistoricalMockExam('${escapeHtml(m.examId || '')}')" class="w-full text-left washi-panel-muted p-3 hover:border-[#B56D4E] transition flex items-center justify-between gap-2">
      <div>
        <div class="font-semibold text-[#302D28]">${escapeHtml(m.title)}</div>
        <div class="text-[10px] text-[#6E675B]">${escapeHtml(m.date)} ${escapeHtml(m.timeLabel || '')} • ${m.questionsCount || m.questions || 0}${m.plannedQuestions ? '/' + m.plannedQuestions : ''} Q • ${formatTimeMMSS(m.durationSec || 0)}</div>
      </div>
      <div class="text-right">
        <span class="px-2 py-0.5 rounded bg-[#FBF8F1] border border-[#D8CDBB] ${isAborted ? 'text-[#A8463B]' : 'text-[#B56D4E]'} font-serif-editorial font-bold text-xs">Grade ${escapeHtml(m.grade)}</span>
        <div class="text-[11px] ${deltaVal >= 0 && !isAborted ? 'text-[#5E6B50]' : 'text-[#A8463B]'} font-semibold mt-0.5">${accDisplay} (${deltaVal >= 0 ? '+' : ''}${deltaVal} SPI)</div>
      </div>
    </button>
  `;
  }).join('');
}


/* ==================== [MODULE: Analytics.html] ==================== */

/**
 * Earlisthenic — Analytics.html
 * Period aggregation (Last 7 Days, Last 30 Days, All Time from firstUseAt),
 * KPI computation, SPI carry-forward timeline chart, daily practice time bar chart,
 * 6-axis radar chart, and isolated Demo Mode preview.
 */

const PERIOD_LABELS = {
  '7d': 'Last 7 Days',
  '30d': 'Last 30 Days',
  'all': 'All Time'
};

/**
 * Generates an array of `YYYY-MM-DD` date strings in `Asia/Ho_Chi_Minh` for the selected period.
 * - '7d': today and the previous 6 local calendar days
 * - '30d': today and the previous 29 local calendar days
 * - 'all': every local calendar day from earliest recorded activity to today
 */
function getPeriodDateKeys(periodKey, firstUseAtIso, dailyMap) {
  const todayKey = getLocalDateKey(0);
  if (periodKey === '7d') {
    const keys = [];
    for (let i = 6; i >= 0; i--) keys.push(getLocalDateKey(-i));
    return keys;
  }
  if (periodKey === '30d') {
    const keys = [];
    for (let i = 29; i >= 0; i--) keys.push(getLocalDateKey(-i));
    return keys;
  }

  // 'all': from the true earliest recorded activity (dailyMap, firstUseAt, etc.) to todayKey
  let earliestKey = todayKey;
  if (firstUseAtIso) {
    const fuKey = formatDateToKeyInTz(new Date(firstUseAtIso));
    if (fuKey && fuKey < earliestKey) earliestKey = fuKey;
  }
  if (dailyMap && typeof dailyMap === 'object') {
    const dKeys = Object.keys(dailyMap).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    if (dKeys.length > 0 && dKeys[0] < earliestKey) earliestKey = dKeys[0];
  }

  const startParts = earliestKey.split('-').map(Number);
  const endParts = todayKey.split('-').map(Number);
  const startDate = new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2]));
  const endDate = new Date(Date.UTC(endParts[0], endParts[1] - 1, endParts[2]));

  const diffDays = Math.max(0, Math.min(3650, Math.round((endDate - startDate) / 86400000)));
  const allKeys = [];
  for (let i = diffDays; i >= 0; i--) {
    allKeys.push(new Date(endDate.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  return allKeys.length > 0 ? allKeys : [todayKey];
}

/**
 * Computes comprehensive metrics for the selected period (`7d`, `30d`, or `all`).
 */
function computeAnalyticsForPeriod(dataRoot, periodKey) {
  const dateKeys = getPeriodDateKeys(periodKey, dataRoot.app && dataRoot.app.firstUseAt, dataRoot.dailyStats);
  const dateSet = new Set(dateKeys);
  const dailyMap = dataRoot.dailyStats || {};
  const initialBaselineSpi = (dataRoot.score && dataRoot.score.initialSpi) || 1000;

  // Determine SPI carried into the first date of the period
  const allSortedDates = Object.keys(dailyMap).sort();
  let runningSpi = initialBaselineSpi;
  for (let i = 0; i < allSortedDates.length; i++) {
    const dk = allSortedDates[i];
    if (dk < dateKeys[0]) {
      const r = dailyMap[dk];
      if (r && typeof r.spiEnd === 'number') {
        runningSpi = r.spiEnd;
      }
    } else {
      break;
    }
  }

  const startSpi = runningSpi;
  const series = [];
  let totalPracticeSec = 0;
  let activeDaysCount = 0;
  let totalQuestions = 0;
  let totalAccSum = 0;
  let totalPoints = 0;
  let sessionsCompleted = 0;

  dateKeys.forEach(dk => {
    const rec = dailyMap[dk];
    const hasActivity = Boolean(rec && ((rec.practiceSec || 0) > 0 || (rec.questionsAnswered || 0) > 0));
    const hasSkipDecay = Boolean(rec && rec.skipPenaltyApplied);
    if (rec && typeof rec.spiEnd === 'number' && (hasActivity || hasSkipDecay)) {
      runningSpi = rec.spiEnd;
    }
    const dayPracticeSec = rec ? (rec.practiceSec || 0) : 0;
    const dayQuestions = rec ? (rec.questionsAnswered || 0) : 0;
    const dayAccSum = rec ? (rec.accuracySum || 0) : 0;
    const dayPoints = rec ? (rec.scorePoints || 0) : 0;
    const daySessions = rec ? (rec.sessionsCompleted || 0) : 0;

    if (dayPracticeSec >= 10 || dayQuestions > 0) {
      activeDaysCount++;
    }
    totalPracticeSec += dayPracticeSec;
    totalQuestions += dayQuestions;
    totalAccSum += dayAccSum;
    totalPoints += dayPoints;
    sessionsCompleted += daySessions;

    series.push({
      date: dk,
      label: dk.slice(5, 7) + '/' + dk.slice(8, 10),
      spi: runningSpi,
      spiDelta: rec && (hasActivity || hasSkipDecay) ? (rec.spiDelta || 0) : 0,
      carriedForward: !hasActivity && !hasSkipDecay,
      skipDecay: hasSkipDecay,
      practiceSec: dayPracticeSec,
      practiceMins: Number((dayPracticeSec / 60).toFixed(1)),
      questions: dayQuestions
    });
  });

  const endSpi = series.length > 0 ? series[series.length - 1].spi : startSpi;
  const netSpiDelta = endSpi - startSpi;
  const pctSpiChange = startSpi > 0 ? Number(((netSpiDelta / startSpi) * 100).toFixed(1)) : 0;
  const avgAccuracy = totalQuestions > 0 ? Math.round(totalAccSum / totalQuestions) : null;

  // Filter mock exams in period
  const periodExams = (dataRoot.mockExamHistory || []).filter(m => dateSet.has(m.date));
  const avgExamAcc = periodExams.length > 0
    ? Math.round(periodExams.reduce((s, m) => s + (m.avgAccuracy || 0), 0) / periodExams.length)
    : null;
  const bestExam = periodExams.reduce((best, m) => {
    if (!best || (m.totalScore || 0) > (best.totalScore || 0)) return m;
    return best;
  }, null);

  // Compute per-game breakdown for the selected period from questionEvents + sessionEvents
  // (falling back to lifetime gameStats when period is 'all')
  const perGamePeriod = {};
  Object.keys(SG_GAMES).forEach(gid => {
    const lifetime = (dataRoot.gameStats && dataRoot.gameStats[gid]) || {};
    if (periodKey === 'all') {
      perGamePeriod[gid] = {
        gameId: gid,
        highScore: lifetime.highScore || 0,
        lastScore: lifetime.lastScore || 0,
        lastDelta: lifetime.lastDelta || 0,
        maxLevel: lifetime.maxLevel || 1,
        sessionsCompleted: lifetime.sessionsCompleted || 0,
        questionsAnswered: lifetime.questionsAnswered || 0,
        avgAccuracy: (lifetime.questionsAnswered || 0) > 0
          ? Math.round((lifetime.totalAccuracySum || 0) / lifetime.questionsAnswered)
          : null,
        practiceTimeSec: lifetime.practiceTimeSec || 0
      };
    } else {
      perGamePeriod[gid] = {
        gameId: gid,
        highScore: lifetime.highScore || 0,
        lastScore: lifetime.lastScore || 0,
        lastDelta: lifetime.lastDelta || 0,
        maxLevel: lifetime.maxLevel || 1,
        sessionsCompleted: 0,
        questionsAnswered: 0,
        accSum: 0,
        avgAccuracy: null,
        practiceTimeSec: 0
      };
    }
  });

  if (periodKey !== 'all') {
    (dataRoot.recentQuestionEvents || []).forEach(ev => {
      const dk = ev.localDate || formatDateToKeyInTz(new Date(ev.timestamp));
      if (dateSet.has(dk) && perGamePeriod[ev.gameId]) {
        perGamePeriod[ev.gameId].questionsAnswered++;
        perGamePeriod[ev.gameId].accSum += (ev.accuracy || 0);
      }
    });
    (dataRoot.recentSessions || []).forEach(sess => {
      const dk = sess.localDate || formatDateToKeyInTz(new Date(sess.startedAt));
      if (dateSet.has(dk) && perGamePeriod[sess.gameId]) {
        perGamePeriod[sess.gameId].sessionsCompleted += (sess.completed ? 1 : 0);
        perGamePeriod[sess.gameId].practiceTimeSec += (sess.durationSec || 0);
      }
    });
    Object.keys(perGamePeriod).forEach(gid => {
      const item = perGamePeriod[gid];
      const lifetime = (dataRoot.gameStats && dataRoot.gameStats[gid]) || {};
      if (item.questionsAnswered > 0) {
        item.avgAccuracy = Math.round(item.accSum / item.questionsAnswered);
      } else if ((lifetime.questionsAnswered || 0) > 0) {
        // Fallback to lifetime historical accuracy & practice so player stats are never lost
        item.avgAccuracy = Math.round((lifetime.totalAccuracySum || 0) / lifetime.questionsAnswered);
        item.sessionsCompleted = lifetime.sessionsCompleted || 0;
        item.practiceTimeSec = lifetime.practiceTimeSec || 0;
        item.isAllTimeFallback = true;
      } else {
        item.avgAccuracy = null;
      }
    });
  }

  const streaks = computePracticeDayStreaks(dailyMap);

  return {
    periodKey,
    periodLabel: PERIOD_LABELS[periodKey] || 'Last 7 Days',
    dateKeys,
    series,
    startSpi,
    endSpi,
    netSpiDelta,
    pctSpiChange,
    peakSpi: (dataRoot.score && dataRoot.score.peakSpi) || endSpi,
    totalPracticeSec,
    activeDaysCount,
    sessionsCompleted,
    totalQuestions,
    avgAccuracy,
    totalPoints,
    periodExamsCount: periodExams.length,
    avgExamAcc,
    bestExam,
    currentDayStreak: streaks.currentStreak,
    bestDayStreak: streaks.bestStreak,
    currentAnswerStreak: (dataRoot.score && dataRoot.score.currentAnswerStreak) || 0,
    bestAnswerStreak: (dataRoot.score && dataRoot.score.bestAnswerStreak) || 0,
    perGamePeriod
  };
}

/**
 * Computes both current and best Practice-Day Streaks across all recorded dates.
 * Documented rule: A day counts as an active practice day if `practiceSec >= 10` OR `questionsAnswered >= 1`.
 */
function computePracticeDayStreaks(dailyMap) {
  const allKeys = Object.keys(dailyMap || {}).sort();
  if (allKeys.length === 0) return { currentStreak: 0, bestStreak: 0 };

  const isActive = (dk) => {
    const r = dailyMap[dk];
    return Boolean(r && ((r.practiceSec || 0) >= 10 || (r.questionsAnswered || 0) >= 1));
  };

  // Current streak ending today or yesterday
  let currentStreak = 0;
  for (let i = 0; i < 3650; i++) {
    const dk = getLocalDateKey(-i);
    if (isActive(dk)) {
      currentStreak++;
    } else if (i === 0) {
      // Today has not been active yet; check if yesterday's streak is still alive
      continue;
    } else {
      break;
    }
  }

  // Best historical streak across all calendar dates
  let bestStreak = currentStreak;
  let run = 0;
  let prevDateMs = null;

  allKeys.forEach(dk => {
    if (!isActive(dk)) {
      run = 0;
      prevDateMs = null;
      return;
    }
    const parts = dk.split('-').map(Number);
    const curMs = Date.UTC(parts[0], parts[1] - 1, parts[2]);
    if (prevDateMs !== null && Math.round((curMs - prevDateMs) / 86400000) === 1) {
      run++;
    } else {
      run = 1;
    }
    prevDateMs = curMs;
    if (run > bestStreak) bestStreak = run;
  });

  return { currentStreak, bestStreak };
}

function setAnalyticsPeriod(periodKey) {
  appState.analyticsPeriod = ['7d', '30d', 'all'].includes(periodKey) ? periodKey : '7d';
  ['7d', '30d', 'all'].forEach(k => {
    // 1. SPI Progression chart header buttons
    const chartBtn = document.getElementById(`chart-btn-${k}`);
    if (chartBtn) {
      chartBtn.className = k === appState.analyticsPeriod
        ? 'px-2.5 py-0.5 rounded-md transition-all bg-[#B56D4E] text-[#FBF8F1] shadow-xs'
        : 'px-2.5 py-0.5 rounded-md transition-all text-[#302D28] dark:text-[#EAE2D4] hover:bg-[#FBF8F1]/60 dark:hover:bg-[#25221E]';
    }
    // 2. Practice time chart header buttons
    const timeBtn = document.getElementById(`timechart-btn-${k}`);
    if (timeBtn) {
      timeBtn.className = k === appState.analyticsPeriod
        ? 'px-2.5 py-0.5 rounded-md transition-all bg-[#B56D4E] text-[#FBF8F1] shadow-xs'
        : 'px-2.5 py-0.5 rounded-md transition-all text-[#302D28] dark:text-[#EAE2D4] hover:bg-[#FBF8F1]/60 dark:hover:bg-[#25221E]';
    }
  });
  renderSpiAnalyticsDashboard();
}

function highlightInfographicDiscipline(gameId, axisKey) {
  const allCards = document.querySelectorAll('#stats-per-game-grid [data-game-id]');
  allCards.forEach(card => {
    if (card.getAttribute('data-game-id') === gameId) {
      card.classList.add('ring-2', 'ring-[#B56D4E]', 'border-[#B56D4E]', 'shadow-md');
      card.classList.remove('opacity-60');
    } else {
      card.classList.add('opacity-60');
      card.classList.remove('ring-2', 'ring-[#B56D4E]', 'border-[#B56D4E]', 'shadow-md');
    }
  });
  draw6AxisRadarChart(_lastAnalyticsSkillAxes, axisKey);
}

function highlightInfographicFromAxis(axisKey) {
  const allCards = document.querySelectorAll('#stats-per-game-grid [data-game-id]');
  allCards.forEach(card => {
    if (card.getAttribute('data-axis') === axisKey) {
      card.classList.add('ring-2', 'ring-[#B56D4E]', 'border-[#B56D4E]', 'shadow-md');
      card.classList.remove('opacity-60');
    } else {
      card.classList.add('opacity-60');
      card.classList.remove('ring-2', 'ring-[#B56D4E]', 'border-[#B56D4E]', 'shadow-md');
    }
  });
  draw6AxisRadarChart(_lastAnalyticsSkillAxes, axisKey);
}

function clearInfographicHighlight() {
  const allCards = document.querySelectorAll('#stats-per-game-grid [data-game-id]');
  allCards.forEach(card => {
    card.classList.remove('ring-2', 'ring-[#B56D4E]', 'border-[#B56D4E]', 'shadow-md', 'opacity-60');
  });
  draw6AxisRadarChart(_lastAnalyticsSkillAxes, null);
}

function renderSixAxisMiniMeters(skillAxes, highlightAxisKey) {
  // Obsolete HUD intentionally eliminated to prevent duplicate scoring scales under Hexagon
  return;
}

let _lastAnalyticsSeries = null;
let _lastAnalyticsGoalMins = 15;
let _lastAnalyticsSkillAxes = {};

function redrawAnalyticsChartsOnly() {
  if (!_lastAnalyticsSeries) {
    renderSpiAnalyticsDashboard();
    return;
  }
  drawPeriodSpiTrendChart(_lastAnalyticsSeries);
  drawPeriodPracticeTimeChart(_lastAnalyticsSeries, _lastAnalyticsGoalMins);
  draw6AxisRadarChart(_lastAnalyticsSkillAxes);
  renderSixAxisMiniMeters(_lastAnalyticsSkillAxes, null);
}

function renderSpiAnalyticsDashboard(options) {
  const dataRoot = getActiveDataRoot();
  const periodKey = appState.analyticsPeriod || '7d';
  const stats = computeAnalyticsForPeriod(dataRoot, periodKey);
  _lastAnalyticsSeries = stats.series;
  _lastAnalyticsGoalMins = dataRoot.settings.dailyGoalMinutes || 15;
  _lastAnalyticsSkillAxes = dataRoot.score.skillAxes || {};

  if (options && options.chartsOnly) {
    redrawAnalyticsChartsOnly();
    return;
  }
  const todayRec = ensureDailyRecordForDate(getLocalDateKey(0));

  const firstUseDate = dataRoot.app && dataRoot.app.firstUseAt
    ? new Date(dataRoot.app.firstUseAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Today';
  const firstUseLbl = document.getElementById('stats-first-use-label');
  if (firstUseLbl) {
    firstUseLbl.textContent = appState.demoModeActive ? `${firstUseDate} (Demo Sandbox)` : firstUseDate;
  }

  document.getElementById('kpi-period-tag-1').textContent = stats.periodLabel;
  document.getElementById('chart-spi-period-label').textContent = stats.periodLabel;
  document.getElementById('table-game-period-label').textContent = stats.periodLabel;

  // Card 1: SPI Start / End / Delta / %
  document.getElementById('kpi-spi-current').textContent = stats.endSpi.toLocaleString();
  const kpiDeltaEl = document.getElementById('kpi-spi-delta');
  const sign = stats.netSpiDelta >= 0 ? '+' : '';
  kpiDeltaEl.textContent = `${sign}${stats.netSpiDelta} (${sign}${stats.pctSpiChange}%)`;
  kpiDeltaEl.className = stats.netSpiDelta >= 0
    ? 'text-xs font-mono-tabular font-semibold px-1.5 py-0.5 rounded bg-[#E6ECE0] text-[#5E6B50]'
    : 'text-xs font-mono-tabular font-semibold px-1.5 py-0.5 rounded bg-[#F5E4E1] text-[#A8463B]';
  document.getElementById('kpi-spi-start-peak').textContent =
    `Start: ${stats.startSpi.toLocaleString()} • Peak: ${stats.peakSpi.toLocaleString()}`;
  document.getElementById('stats-spi-summary').textContent = `Current: ${stats.endSpi.toLocaleString()} SPI`;

  // Card 2: Practice Time & Sessions
  const pMins = Math.floor(stats.totalPracticeSec / 60);
  const pSecs = Math.floor(stats.totalPracticeSec % 60);
  document.getElementById('kpi-time-period').textContent =
    pMins >= 60 ? `${(stats.totalPracticeSec / 3600).toFixed(1)} hrs` : `${pMins}m ${String(pSecs).padStart(2, '0')}s`;
  document.getElementById('kpi-sessions-count').textContent = `${stats.sessionsCompleted} sessions`;
  document.getElementById('kpi-time-today-sub').textContent =
    `Today: ${formatSecondsHHMMSS(todayRec.practiceSec || 0)} (Goal: ${dataRoot.settings.dailyGoalMinutes}m)`;
  document.getElementById('chart-time-goal-label').textContent = `Goal: ${dataRoot.settings.dailyGoalMinutes} min/day`;
  document.getElementById('stats-daily-goal-select').value = String(dataRoot.settings.dailyGoalMinutes || 15);

  // Card 3: Active Days, Habit Weight & Streaks
  document.getElementById('kpi-active-days').textContent = `${stats.activeDaysCount} day${stats.activeDaysCount === 1 ? '' : 's'}`;
  const habitProfile = typeof computeHabitWeightingProfile === 'function'
    ? computeHabitWeightingProfile(dataRoot, getLocalDateKey(0))
    : { weight: 1.0, tier: 'Baseline' };
  const weightBadgeEl = document.getElementById('kpi-habit-weight-badge');
  if (weightBadgeEl) {
    weightBadgeEl.textContent = `${habitProfile.weight.toFixed(2)}x (${habitProfile.tier})`;
    weightBadgeEl.className = habitProfile.weight < 0.95
      ? 'text-xs font-mono-tabular font-semibold px-1.5 py-0.5 rounded bg-[#F5E4E1] text-[#A8463B]'
      : (habitProfile.weight >= 1.15
          ? 'text-xs font-mono-tabular font-semibold px-1.5 py-0.5 rounded bg-[#E6ECE0] text-[#5E6B50]'
          : 'text-xs font-mono-tabular font-semibold px-1.5 py-0.5 rounded bg-[#EAE2D4] text-[#302D28]');
  }
  document.getElementById('kpi-day-streak').textContent =
    `Day Streak: ${stats.currentDayStreak} (Best: ${stats.bestDayStreak})`;
  document.getElementById('kpi-answer-streak-sub').textContent =
    `Answer Streak: ${stats.currentAnswerStreak} (Best: ${stats.bestAnswerStreak})`;

  // Card 4: Accuracy, Points & Mock Exams
  document.getElementById('kpi-avg-accuracy').textContent = stats.avgAccuracy !== null ? `${stats.avgAccuracy}%` : '--%';
  document.getElementById('kpi-total-points').textContent = `${stats.totalPoints.toLocaleString()} pts`;
  const bestExamLabel = stats.bestExam ? `${stats.bestExam.grade} (${stats.bestExam.avgAccuracy}%)` : '--';
  document.getElementById('kpi-questions-exams-sub').textContent =
    `${stats.totalQuestions} Q • ${stats.periodExamsCount} exams (Best: ${bestExamLabel})`;

  // Update Rank Badge in Infographic Header & Left Studio Mastery Hub Scorecard
  const curSpiVal = Math.round(Number(stats.endSpi) || 1000);
  const rankTitle = curSpiVal >= 2800
    ? 'Master Audio Engineer'
    : (curSpiVal >= 2000 ? 'Senior Audio Specialist' : (curSpiVal >= 1400 ? 'Intermediate Mixing Engineer' : 'Apprentice Sound Trainer'));

  const rankBadgeEl = document.getElementById('infographic-rank-badge');
  if (rankBadgeEl) {
    rankBadgeEl.textContent = `${rankTitle} • ${curSpiVal.toLocaleString()} SPI`;
  }

  const hubSpiEl = document.getElementById('hub-spi-score');
  if (hubSpiEl) hubSpiEl.textContent = curSpiVal.toLocaleString();

  const hubTierEl = document.getElementById('hub-tier-badge');
  if (hubTierEl) hubTierEl.textContent = rankTitle;

  const hubPeriodTag = document.getElementById('hub-period-tag');
  if (hubPeriodTag) hubPeriodTag.textContent = stats.periodLabel || 'Active Period';

  // Compute Top Strength & Focus Area
  const skillAxes = dataRoot.score && dataRoot.score.skillAxes ? dataRoot.score.skillAxes : {};
  const axisEntries = [
    { name: 'Peak/Cut', val: skillAxes.freq || 0 },
    { name: 'Bass', val: skillAxes.bass || 0 },
    { name: 'Symmetry', val: skillAxes.symmetry || 0 },
    { name: 'Filters', val: skillAxes.filter || 0 },
    { name: 'Speed', val: skillAxes.speed || 0 },
    { name: 'Feedback', val: skillAxes.feedback || 0 }
  ].sort((a, b) => b.val - a.val);

  const topStrEl = document.getElementById('hub-top-strength');
  if (topStrEl) topStrEl.textContent = `Strength: ${axisEntries[0].name} (${Math.round(axisEntries[0].val)}%)`;

  const focusEl = document.getElementById('hub-focus-area');
  if (focusEl) focusEl.textContent = `Focus: ${axisEntries[axisEntries.length - 1].name} (${Math.round(axisEntries[axisEntries.length - 1].val)}%)`;

  // Per-Game Grid for Selected Period (Dynamic Infographic: Discipline Icons, Linked Axis, Best Score, Delta, Progress)
  const gGrid = document.getElementById('stats-per-game-grid');
  if (gGrid) {
    const gMeta = {
      peak: { icon: 'fa-wave-square', color: '#B56D4E', axisName: 'Peak / Cut EQ', axisKey: 'freq' },
      cut: { icon: 'fa-scissors', color: '#B56D4E', axisName: 'Peak / Cut EQ', axisKey: 'freq' },
      bass: { icon: 'fa-layer-group', color: '#5E6B50', axisName: 'Low-End Bass', axisKey: 'bass' },
      mirror: { icon: 'fa-arrows-left-right', color: '#9E7B42', axisName: 'Harmonic Symmetry', axisKey: 'symmetry' },
      knight: { icon: 'fa-chess-knight', color: '#8E5A78', axisName: 'Curve Chroma', axisKey: 'filter' },
      filter: { icon: 'fa-sliders', color: '#4E7285', axisName: 'Filter Slopes', axisKey: 'filter' },
      cheetah: { icon: 'fa-bolt', color: '#D9822B', axisName: 'Speed Blitz', axisKey: 'speed' },
      feedback: { icon: 'fa-shield-halved', color: '#B83E2E', axisName: 'ISO Feedback', axisKey: 'feedback' }
    };

    gGrid.innerHTML = Object.values(SG_GAMES).map(g => {
      const meta = gMeta[g.id] || { icon: 'fa-headphones', color: '#B56D4E', axisName: 'Ear Discipline', axisKey: g.spiAxis || 'freq' };
      const r = stats.perGamePeriod[g.id] || {};
      const dVal = r.lastDelta || 0;
      const accVal = r.avgAccuracy !== null ? Number(r.avgAccuracy) : 0;
      const accTxt = r.avgAccuracy !== null ? `${r.avgAccuracy}%` : '--%';
      const mins = Math.round(((r.practiceTimeSec || 0) / 60) * 10) / 10;
      const deltaClass = dVal > 0
        ? 'bg-[#EAF2E4] text-[#345924] dark:bg-[#293126] dark:text-[#C0D0B5] border border-[#C0D0B5]/40'
        : (dVal < 0
          ? 'bg-[#FCE8E6] text-[#A8382B] dark:bg-[#342521] dark:text-[#E0A89D] border border-[#E0A89D]/40'
          : 'bg-[#EAE2D4]/70 text-[#596052] dark:bg-[#1C1F19] dark:text-[#A0A597] border border-black/[0.05] dark:border-white/[0.05]');

      const accBarColor = accVal >= 80 ? 'bg-[#5E6B50]' : (accVal >= 50 ? 'bg-[#9E7B42]' : 'bg-[#B56D4E]');

      return `
        <div data-game-id="${g.id}" data-axis="${meta.axisKey}" onmouseenter="highlightInfographicDiscipline('${g.id}', '${meta.axisKey}')" onmouseleave="clearInfographicHighlight()" class="module-card-${g.id} p-3 sm:p-3.5 rounded-xl border border-black/[0.08] dark:border-[#394036] flex flex-col justify-between gap-2.5 bg-white dark:bg-[#202620] shadow-xs hover:shadow-md transition-all cursor-pointer group">
          <div class="flex items-center justify-between gap-2 border-b border-black/[0.05] dark:border-white/[0.06] pb-2">
            <div class="flex items-center gap-2 min-w-0">
              <div class="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-xs" style="background-color: ${meta.color}">
                <i class="fa-solid ${meta.icon}" aria-hidden="true"></i>
              </div>
              <div class="min-w-0">
                <h4 class="font-serif-editorial font-bold text-sm sm:text-base text-[#171915] dark:text-[#ECEBE2] tracking-tight leading-tight truncate group-hover:text-[#B56D4E] transition-colors" title="${g.name}">
                  ${g.name}
                </h4>
                <span class="text-[9px] font-mono-tabular text-[#6E675B] dark:text-[#A89F91] block truncate">${meta.axisName}</span>
              </div>
            </div>
            <span class="text-[10px] font-mono-tabular font-bold px-2 py-0.5 rounded-md bg-[#EAE2D4] dark:bg-[#1C1F19] border border-[#D5CEBF] dark:border-[#454E42] text-[#B56D51] dark:text-[#DFA58D] shrink-0">
              LVL ${r.maxLevel || 1}
            </span>
          </div>

          <div class="flex items-baseline justify-between gap-2 my-0.5">
            <div>
              <span class="text-[9px] font-bold uppercase tracking-wider font-mono-tabular text-[#596052] dark:text-[#A0A597] block">Best Score</span>
              <div class="text-xl sm:text-2xl font-extrabold font-mono-tabular text-[#171915] dark:text-[#ECEBE2] tracking-tight">
                ${(r.highScore || 0).toLocaleString()}
              </div>
            </div>
            <span class="text-[10px] font-mono-tabular font-bold px-2 py-0.5 rounded-md ${deltaClass} shrink-0">
              ${dVal >= 0 ? '+' : ''}${dVal} Δ
            </span>
          </div>

          <div class="space-y-1">
            <div class="flex items-center justify-between text-[10px] font-mono-tabular">
              <span class="text-[#596052] dark:text-[#A0A597] font-semibold">Accuracy</span>
              <span class="font-bold text-[#171915] dark:text-[#ECEBE2]">${accTxt}${r.isAllTimeFallback ? ' <span class="text-[9px] font-normal text-[#6E675B] dark:text-[#A89F91]">(all-time)</span>' : ''}</span>
            </div>
            <div class="w-full h-1.5 bg-black/[0.06] dark:bg-white/[0.08] rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all duration-500 ${accBarColor}" style="width: ${accVal}%"></div>
            </div>
          </div>

          <div class="flex items-center justify-between pt-2 border-t border-black/[0.04] dark:border-white/[0.05] text-[10px] font-mono-tabular text-[#596052] dark:text-[#A0A597]">
            <span>Practice</span>
            <span class="font-semibold text-[#30352E] dark:text-[#C6C8BB] truncate">${r.sessionsCompleted || 0} sess · ${mins}m${r.isAllTimeFallback ? ' (all-time)' : ''}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Recent Question, Behavioral & Decay Events Log
  const logEl = document.getElementById('stats-history-log');
  if (logEl) {
    const qEvents = (dataRoot.recentQuestionEvents || []).map(ev => ({ kind: 'question', ts: ev.timestamp || '', ev }));
    const bEvents = (dataRoot.recentBehaviorEvents || []).map(ev => ({ kind: 'behavior', ts: ev.timestamp || '', ev }));
    const merged = qEvents.concat(bEvents).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

    if (merged.length === 0) {
      logEl.innerHTML = `
        <div class="px-4 py-8 text-center rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-dashed border-[#D8CDBB] dark:border-[#38332B]">
          <div class="w-10 h-10 mx-auto mb-2 rounded-full bg-[var(--sg-terracotta)]/10 text-[var(--sg-terracotta)] flex items-center justify-center text-base">
            <i class="fa-solid fa-chart-line" aria-hidden="true"></i>
          </div>
          <div class="text-xs font-semibold text-[#302D28] dark:text-[#EAE2D4]">Awaiting Studio Training Telemetry</div>
          <div class="text-[11px] text-[#6E675B] dark:text-[#A0A597] mt-1 max-w-sm mx-auto">Complete your first exercise or workout circuit in the Training Arena to record verified psychoacoustic events.</div>
          <button type="button" onclick="launchGameFromLobby('peak')" class="mt-3.5 px-4 py-2 rounded-lg bg-[var(--sg-terracotta)] hover:bg-[var(--sg-terracotta-dark)] text-[#FBF8F1] text-xs font-semibold tracking-wide shadow-xs transition-colors cursor-pointer">
            <i class="fa-solid fa-sliders mr-1.5" aria-hidden="true"></i>Start Peak Master Workout
          </button>
        </div>
      `;
    } else {
      logEl.innerHTML = merged.slice(0, 40).map(item => {
        const ev = item.ev;
        const delta = ev.spiDelta || 0;
        const spiBadgeClass = delta > 0
          ? 'bg-[#EAF2E4] text-[#345924] dark:bg-[#293126] dark:text-[#C0D0B5] dark:border dark:border-[#53634A]'
          : (delta < 0 ? 'bg-[#FCE8E6] text-[#A8382B] dark:bg-[#342521] dark:text-[#E0A89D] dark:border dark:border-[#765047]' : 'bg-[#EAE2D4] text-[#454E42] dark:bg-[#1C1F19] dark:text-[#A0A597]');

        if (item.kind === 'behavior') {
          const badgeTxt = ev.type === 'skip_day'
            ? 'Skip Decay'
            : (delta < 0 ? 'Incomplete' : 'Habit Bonus');
          const badgeClr = delta < 0
            ? 'bg-[#FCE8E6] text-[#A8382B] dark:bg-[#342521] dark:text-[#E0A89D] dark:border dark:border-[#765047]'
            : 'bg-[#EAF2E4] text-[#345924] dark:bg-[#293126] dark:text-[#C0D0B5] dark:border dark:border-[#53634A]';
          const dateLabel = ev.localDate || String(ev.timestamp || '').slice(0, 10);
          const evLabel = escapeHtml(ev.label || 'Habit Event');
          const evDetail = escapeHtml(ev.reason || ev.detail || 'Practice streak adjustment');
          return `
            <div class="grid grid-cols-12 items-center px-3.5 py-2 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors gap-2 text-xs font-mono-tabular">
              <div class="col-span-5 sm:col-span-4 flex items-center gap-2 min-w-0">
                <span class="text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider shrink-0 ${badgeClr}">${badgeTxt}</span>
                <span class="text-[#171915] dark:text-[#ECEBE2] font-semibold text-xs truncate" title="${evLabel}">${evLabel}</span>
                <span class="text-[10px] text-[#596052] dark:text-[#A0A597] shrink-0 hidden sm:inline">${escapeHtml(dateLabel)}</span>
              </div>
              <div class="col-span-4 sm:col-span-5 text-xs text-[#30352E] dark:text-[#C6C8BB] truncate" title="${evDetail}">
                ${evDetail}
              </div>
              <div class="col-span-3 flex items-center justify-end gap-1.5 shrink-0">
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${spiBadgeClass} shrink-0">
                  ${delta >= 0 ? '+' : ''}${delta} SPI
                </span>
              </div>
            </div>
          `;
        }

        const gName = (SG_GAMES[ev.gameId] && SG_GAMES[ev.gameId].name) || ev.gameId;
        const timeStr = new Date(ev.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const modeLabel = ev.mode === 'mock' ? 'Mock Exam' : 'Practice';
        const passed = typeof ev.passed === 'boolean' ? ev.passed : (ev.accuracy >= 70 && ev.status !== 'timeout');
        const ptsTxt = (ev.scorePoints || 0) > 0 ? `+${ev.scorePoints}` : '0 pts';
        const uTxt = escapeHtml(ev.userSummary || '');
        const tTxt = escapeHtml(ev.targetSummary || '');
        const plainSummary = `You: ${ev.userSummary || ''} • Target: ${ev.targetSummary || ''}`;
        const summaryHtml = `<span class="text-[#6E675B] dark:text-[#9A9890]">You:</span> <span class="font-bold text-[#2A2722] dark:text-[#EAE2D4]">${uTxt}</span> <span class="text-[#8B9384] dark:text-[#7A8374] mx-1">•</span> <span class="text-[#6E675B] dark:text-[#9A9890]">Target:</span> <span class="font-bold text-[#3E7A2E] dark:text-[#B0D8A0]">${tTxt}</span>`;
        return `
          <div class="grid grid-cols-12 items-center px-3.5 py-2 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors gap-2 text-xs font-mono-tabular">
            <div class="col-span-5 sm:col-span-4 flex items-center gap-2 min-w-0">
              <span class="text-[9px] px-2 py-0.5 rounded bg-[#EAE2D4] dark:bg-[#1C1F19] text-[#171915] dark:text-[#ECEBE2] font-bold uppercase shrink-0">${modeLabel}</span>
              <span class="text-[#171915] dark:text-[#ECEBE2] font-semibold text-xs truncate" title="${escapeHtml(gName)} (L${ev.difficulty})">${escapeHtml(gName)} (L${ev.difficulty})</span>
              <span class="text-[10px] text-[#596052] dark:text-[#A0A597] shrink-0 hidden sm:inline">${timeStr}</span>
            </div>
            <div class="col-span-4 sm:col-span-5 text-xs text-[#30352E] dark:text-[#C6C8BB] truncate" title="${escapeHtml(plainSummary)}">
              ${summaryHtml}
            </div>
            <div class="col-span-3 flex items-center justify-end gap-1.5 shrink-0">
              <span class="${passed ? 'text-[#3E7A2E] dark:text-[#C0D0B5]' : 'text-[#B83E2E] dark:text-[#E0A89D]'} font-bold text-xs shrink-0">${ev.status === 'timeout' ? 'TIMEOUT' : ev.accuracy + '%'}</span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${spiBadgeClass} shrink-0">
                ${delta >= 0 ? '+' : ''}${delta} SPI
              </span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Screen-reader accessible summary for SPI chart
  const srEl = document.getElementById('spi-chart-sr-summary');
  if (srEl) {
    srEl.textContent = `${stats.periodLabel} SPI summary: starting SPI ${stats.startSpi}, ending SPI ${stats.endSpi}, net change ${stats.netSpiDelta}, active days ${stats.activeDaysCount}, total practice time ${Math.round(stats.totalPracticeSec / 60)} minutes.`;
  }

  drawPeriodSpiTrendChart(stats.series);
  drawPeriodPracticeTimeChart(stats.series, dataRoot.settings.dailyGoalMinutes || 15);
  draw6AxisRadarChart(dataRoot.score.skillAxes || {});
}

function drawPeriodSpiTrendChart(series) {
  const canvas = document.getElementById('spi-trend-canvas');
  if (!canvas || !canvas.parentElement) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 3);
  const w = Math.floor(rect.width > 20 ? rect.width - 16 : (canvas.clientWidth || 320));
  const h = Math.floor(rect.height > 20 ? rect.height - 16 : (canvas.clientHeight || 220));

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);

  const data = series && series.length > 0 ? series : [{ label: 'Today', spi: 1000, spiDelta: 0, carriedForward: true }];
  const spiVals = data.map(d => d.spi);
  const minSpi = Math.min(...spiVals) - 25;
  const maxSpi = Math.max(...spiVals) + 25;

  const padL = 44, padR = 16, padT = 20, padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.strokeStyle = (typeof getThemeColor === 'function' ? getThemeColor('--sg-border', '#D8CDBB') : '#D8CDBB');
  ctx.lineWidth = 1;
  ctx.font = '10px "JetBrains Mono"';
  ctx.fillStyle = (typeof getThemeColor === 'function' ? getThemeColor('--sg-muted', '#6E675B') : '#6E675B');
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * plotH;
    const val = Math.round(maxSpi - (g / 4) * (maxSpi - minSpi));
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(String(val), 4, y + 3);
  }

  const denom = Math.max(1, data.length - 1);

  // Subtle gradient fill under the SPI line for pro-audio visualization
  if (typeof ctx.createLinearGradient === 'function') {
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, 'rgba(181, 109, 78, 0.28)');
    grad.addColorStop(1, 'rgba(181, 109, 78, 0.02)');
    ctx.beginPath();
    data.forEach((pt, idx) => {
      const x = padL + (data.length === 1 ? plotW / 2 : (idx / denom) * plotW);
      const y = padT + ((maxSpi - pt.spi) / Math.max(1, maxSpi - minSpi)) * plotH;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    const lastX = padL + (data.length === 1 ? plotW / 2 : plotW);
    const firstX = padL + (data.length === 1 ? plotW / 2 : 0);
    ctx.lineTo(lastX, padT + plotH);
    ctx.lineTo(firstX, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Draw main trend line
  ctx.beginPath();
  data.forEach((pt, idx) => {
    const x = padL + (data.length === 1 ? plotW / 2 : (idx / denom) * plotW);
    const y = padT + ((maxSpi - pt.spi) / Math.max(1, maxSpi - minSpi)) * plotH;
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#B56D4E';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // Plot markers
  const labelStride = Math.max(1, Math.ceil(data.length / (w > 450 ? 7 : 5)));
  ctx.textAlign = 'center';
  data.forEach((pt, idx) => {
    const x = padL + (data.length === 1 ? plotW / 2 : (idx / denom) * plotW);
    const y = padT + ((maxSpi - pt.spi) / Math.max(1, maxSpi - minSpi)) * plotH;

    if (data.length <= 14 || !pt.carriedForward || idx === 0 || idx === data.length - 1) {
      ctx.beginPath();
      ctx.arc(x, y, data.length > 20 ? 3 : 3.8, 0, Math.PI * 2);
      if (pt.carriedForward) {
        ctx.fillStyle = (typeof getThemeColor === 'function' ? getThemeColor('--sg-surface', '#FBF8F1') : '#FBF8F1');
        ctx.fill();
        ctx.strokeStyle = '#B56D4E';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = pt.spiDelta >= 0 ? '#5E6B50' : '#A8463B';
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (idx % labelStride === 0 || idx === data.length - 1) {
      ctx.fillStyle = (typeof getThemeColor === 'function' ? getThemeColor('--sg-muted', '#6E675B') : '#6E675B');
      ctx.font = '9px "JetBrains Mono"';
      ctx.fillText(pt.label, x, h - 6);
    }
  });
}

function drawPeriodPracticeTimeChart(series, goalMins) {
  const canvas = document.getElementById('daily-time-canvas');
  if (!canvas || !canvas.parentElement) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 3);
  const w = Math.floor(rect.width > 20 ? rect.width - 16 : (canvas.clientWidth || 320));
  const h = Math.floor(rect.height > 20 ? rect.height - 16 : (canvas.clientHeight || 220));

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);

  const data = series && series.length > 0 ? series : [{ label: 'Today', practiceMins: 0 }];
  const totalMins = data.reduce((acc, d) => acc + (d.practiceMins || 0), 0);
  const totalSummaryEl = document.getElementById('chart-time-period-summary');
  if (totalSummaryEl) {
    totalSummaryEl.textContent = totalMins >= 60 ? `Total: ${(totalMins / 60).toFixed(1)}h` : `Total: ${Math.round(totalMins)}m`;
  }

  const maxM = Math.max(goalMins * 1.35, ...data.map(d => d.practiceMins), 20);

  const padL = 32, padR = 12, padT = 18, padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const goalY = padT + ((maxM - goalMins) / maxM) * plotH;
  ctx.strokeStyle = '#9E7B42';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(padL, goalY); ctx.lineTo(w - padR, goalY); ctx.stroke();
  ctx.setLineDash([]);

  const barW = Math.max(3, Math.min(26, (plotW / data.length) * 0.65));
  const labelStride = Math.max(1, Math.ceil(data.length / (w > 450 ? 7 : 5)));
  ctx.textAlign = 'center';

  data.forEach((pt, idx) => {
    const xCenter = padL + ((idx + 0.5) / data.length) * plotW;
    const barH = pt.practiceMins > 0 ? Math.max(4, (pt.practiceMins / maxM) * plotH) : 2;
    const y = padT + plotH - barH;

    ctx.fillStyle = pt.practiceMins >= goalMins
      ? '#5E6B50'
      : (pt.practiceMins > 0 ? '#B56D4E' : '#D8CDBB');
    ctx.fillRect(xCenter - barW / 2, y, barW, barH);

    if (pt.practiceMins > 0 && data.length <= 14) {
      ctx.fillStyle = (typeof getThemeColor === 'function' ? getThemeColor('--sg-ink', '#302D28') : '#302D28');
      ctx.font = '9px "JetBrains Mono"';
      ctx.fillText(pt.practiceMins + 'm', xCenter, y - 4);
    }

    if (idx % labelStride === 0 || idx === data.length - 1) {
      ctx.fillStyle = (typeof getThemeColor === 'function' ? getThemeColor('--sg-muted', '#6E675B') : '#6E675B');
      ctx.font = '9px "JetBrains Mono"';
      ctx.fillText(pt.label, xCenter, h - 6);
    }
  });
}

function draw6AxisRadarChart(skillAxes, highlightKey) {
  const c = document.getElementById('spi-radar-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 3);
  const w = 340, h = 280;
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  c.style.width = w + 'px';
  c.style.height = h + 'px';
  if (c.width !== targetW || c.height !== targetH) {
    c.width = targetW;
    c.height = targetH;
  }
  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const cx = w / 2, cy = h / 2 - 2, r = 94;
  ctx.clearRect(0, 0, w, h);

  const axes = [
    { key: 'freq', label: 'Peak / Cut' },
    { key: 'bass', label: 'Low-End Bass' },
    { key: 'symmetry', label: 'Harmonic Symmetry' },
    { key: 'filter', label: 'Filter Slopes' },
    { key: 'speed', label: 'Speed Blitz' },
    { key: 'feedback', label: 'ISO Feedback' }
  ];

  const gridColor = (typeof getThemeColor === 'function' ? getThemeColor('--sg-border', '#D8CDBB') : '#D8CDBB');
  [0.2, 0.4, 0.6, 0.8, 1.0].forEach(scale => {
    ctx.strokeStyle = scale === 1.0 ? gridColor : 'rgba(150, 150, 150, 0.18)';
    ctx.lineWidth = scale === 1.0 ? 1.5 : 0.8;
    ctx.beginPath();
    axes.forEach((_, i) => {
      const ang = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
      const x = cx + Math.cos(ang) * r * scale;
      const y = cy + Math.sin(ang) * r * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  });

  // Center radial spokes
  axes.forEach((ax, i) => {
    const isHighlighted = (ax.key === highlightKey);
    const ang = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    if (highlightKey) {
      ctx.strokeStyle = isHighlighted ? '#B56D4E' : 'rgba(150, 150, 150, 0.12)';
      ctx.lineWidth = isHighlighted ? 2.5 : 0.8;
    } else {
      ctx.strokeStyle = 'rgba(150, 150, 150, 0.22)';
      ctx.lineWidth = 1;
    }
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
  });

  // Shaded polygon with smooth gradient
  if (typeof ctx.createRadialGradient === 'function') {
    const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, r);
    grad.addColorStop(0, 'rgba(181, 109, 78, 0.38)');
    grad.addColorStop(1, 'rgba(181, 109, 78, 0.10)');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = 'rgba(181, 109, 78, 0.22)';
  }
  ctx.strokeStyle = '#B56D4E';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  axes.forEach((ax, i) => {
    const rawVal = Math.max(0, Math.min(100, Number(skillAxes[ax.key]) || 0));
    const plotRatio = Math.max(0.06, rawVal / 100);
    const ang = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    const x = cx + Math.cos(ang) * r * plotRatio;
    const y = cy + Math.sin(ang) * r * plotRatio;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Vertex points
  axes.forEach((ax, i) => {
    const isHighlighted = (ax.key === highlightKey);
    const rawVal = Math.max(0, Math.min(100, Number(skillAxes[ax.key]) || 0));
    const plotRatio = Math.max(0.06, rawVal / 100);
    const ang = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    const x = cx + Math.cos(ang) * r * plotRatio;
    const y = cy + Math.sin(ang) * r * plotRatio;

    ctx.beginPath();
    if (highlightKey) {
      if (isHighlighted) {
        ctx.arc(x, y, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(181, 109, 78, 0.35)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#B56D4E';
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2.0;
        ctx.stroke();
      } else {
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(181, 109, 78, 0.35)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1.0;
        ctx.stroke();
      }
    } else {
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#B56D4E';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  });

  // Axis Labels with Values
  ctx.textAlign = 'center';
  axes.forEach((ax, i) => {
    const rawVal = Math.round(Number(skillAxes[ax.key]) || 0);
    const isHighlighted = (ax.key === highlightKey);
    const ang = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    const x = cx + Math.cos(ang) * (r + 26);
    const y = cy + Math.sin(ang) * (r + 14);

    if (highlightKey) {
      if (isHighlighted) {
        ctx.fillStyle = '#B56D4E';
        ctx.font = '700 11px "JetBrains Mono"';
      } else {
        ctx.fillStyle = 'rgba(120, 120, 120, 0.45)';
        ctx.font = '500 10px "JetBrains Mono"';
      }
    } else {
      ctx.fillStyle = (typeof getThemeColor === 'function' ? getThemeColor('--sg-ink', '#302D28') : '#302D28');
      ctx.font = '600 10px "JetBrains Mono"';
    }
    ctx.fillText(ax.label, x, y);
  });
}

/**
 * Creates an isolated in-memory Demo Mode dataset so the user can preview 30-day charts
 * without ever contaminating or overwriting their real production progress.
 */
function buildIsolatedDemoDataset() {
  const firstUseIso = new Date(Date.now() - 29 * 86400000).toISOString();
  const demoDoc = {
    schemaVersion: 1,
    scoringVersion: 4,
    app: {
      firstUseAt: firstUseIso,
      lastOpenedAt: new Date().toISOString(),
      timeZone: 'Asia/Ho_Chi_Minh'
    },
    settings: {
      dailyGoalMinutes: 15,
      uiSfxEnabled: true
    },
    score: {
      initialSpi: 1000,
      currentSpi: 1215,
      peakSpi: 1225,
      totalPoints: 28400,
      bestAnswerStreak: 14,
      currentAnswerStreak: 5,
      skillAxes: { freq: 78, bass: 72, symmetry: 69, filter: 74, speed: 65, feedback: 81 }
    },
    dailyStats: {},
    dailyCompletedByDate: {},
    gameStats: {},
    recentQuestionEvents: [],
    recentSessions: [],
    recentBehaviorEvents: [],
    mockExamHistory: []
  };

  let spi = 1000;
  let peak = 1000;
  for (let i = 29; i >= 0; i--) {
    const dk = getLocalDateKey(-i);
    if (i > 0 && i % 7 === 4) {
      const sStart = spi;
      spi = Math.max(500, spi - 10);
      demoDoc.dailyStats[dk] = {
        date: dk,
        practiceSec: 0,
        spiStart: sStart,
        spiEnd: spi,
        spiDelta: spi - sStart,
        questionsAnswered: 0,
        accuracySum: 0,
        scorePoints: 0,
        sessionsCompleted: 0,
        mockExams: 0,
        abandonedCount: 0,
        skipPenaltyApplied: true,
        skipPenaltyDelta: spi - sStart
      };
      demoDoc.recentBehaviorEvents.unshift({
        behaviorId: `demo-skip-${dk}`,
        type: 'skip_day',
        localDate: dk,
        timestamp: new Date(Date.now() - i * 86400000).toISOString(),
        label: `Skipped Practice Day (${dk})`,
        detail: 'Sample consecutive skip decay',
        spiDelta: spi - sStart
      });
      continue;
    }
    const mins = 12 + ((i * 7) % 16);
    const delta = ((i % 5 === 0) ? -4 : 9 + (i % 7));
    const sStart = spi;
    spi = Math.max(500, spi + delta);
    if (spi > peak) peak = spi;
    const qCount = 10 + (i % 3) * 5;
    demoDoc.dailyStats[dk] = {
      date: dk,
      practiceSec: mins * 60,
      spiStart: sStart,
      spiEnd: spi,
      spiDelta: delta,
      questionsAnswered: qCount,
      accuracySum: qCount * (76 + (i % 14)),
      scorePoints: qCount * 110,
      sessionsCompleted: 2,
      mockExams: i % 6 === 0 ? 1 : 0,
      abandonedCount: 0
    };
  }
  demoDoc.score.currentSpi = spi;
  demoDoc.score.peakSpi = Math.max(peak, spi);

  Object.keys(SG_GAMES).forEach((gid, idx) => {
    demoDoc.gameStats[gid] = {
      highScore: 1150 + idx * 65,
      lastScore: 1100 + idx * 50,
      lastDelta: 45,
      maxLevel: 3 + (idx % 4),
      sessionsCompleted: 6 + idx,
      questionsAnswered: 60 + idx * 10,
      totalAccuracySum: (60 + idx * 10) * (78 + (idx % 10)),
      practiceTimeSec: (18 + idx * 4) * 60
    };
  });

  return demoDoc;
}

function toggleDemoMode(forceState) {
  const nextState = typeof forceState === 'boolean' ? forceState : !appState.demoModeActive;
  appState.demoModeActive = nextState;
  if (nextState && !appState.demoDataRoot) {
    appState.demoDataRoot = buildIsolatedDemoDataset();
  }

  const badge = document.getElementById('header-demo-badge');
  const btn = document.getElementById('btn-toggle-demo');
  if (badge) {
    badge.classList.toggle('hidden', !nextState);
    badge.classList.toggle('flex', nextState);
  }
  if (btn) {
    btn.textContent = nextState ? 'Exit Demo Mode' : 'Preview Demo Mode';
    btn.className = nextState
      ? 'btn-terracotta h-10 w-[162px] shrink-0 px-3 rounded-lg text-xs font-semibold inline-flex items-center justify-center whitespace-nowrap'
      : 'btn-outline-washi h-10 w-[162px] shrink-0 px-3 rounded-lg text-xs font-medium inline-flex items-center justify-center whitespace-nowrap';
  }

  updateGlobalHeaderTrackingUI();
  if (appState.currentView === 'stats') renderSpiAnalyticsDashboard();
  if (appState.currentView === 'lobby') {
    renderLobbyGamesGrid();
    renderDailyWorkoutCircuit();
  }
}


/* ==================== [MODULE: ClientApp.html] ==================== */

/**
 * Earlisthenic — ClientApp.html
 * Central application state, clean first-use initialization, explicit timestamp-based
 * practice-time accounting, Heart-Point level-restart progression, Drive RPC synchronization,
 * hardware-accelerated waveform/arena renderers, and global keyboard navigation.
 */

const LOCAL_CACHE_KEY = 'earlisthenic_v2_clean_cache';
const LEGACY_CLEAN_V1_KEY = 'soundgym_studio_v1_clean_cache';
const PROFILE_ID_STORAGE_KEY = 'earlisthenic_profile_id';
const AUTH_PROFILE_STORAGE_KEY = 'earlisthenic_user_profile';
const DEVICE_ID_STORAGE_KEY = 'earlisthenic_device_id';
const AUTH_DECISION_KEY = 'earlisthenic_auth_established';
const CONFIGURED_TIMEZONE = 'Asia/Ho_Chi_Minh';

function sanitizeProfileIdClient(raw) {
  if (raw === null || typeof raw === 'undefined') return '';
  const str = String(raw).trim();
  if (!str || str.indexOf('\u003c?') !== -1) return '';
  const cleaned = str.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned || cleaned.length < 3) return '';
  if (cleaned === 'default' || cleaned === 'owner') return 'default';
  return cleaned.slice(0, 48);
}

function getOrCreateDeviceIdClient() {
  try {
    let devId = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (!devId || !/^[a-f0-9]{8,16}$/i.test(devId)) {
      let hex = '';
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        for (let i = 0; i < bytes.length; i++) {
          hex += ('0' + bytes[i].toString(16)).slice(-2);
        }
      } else {
        hex = Math.random().toString(16).slice(2, 14);
      }
      devId = hex.toLowerCase();
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, devId);
    }
    return devId;
  } catch (e) {
    return 'dev000000000';
  }
}

function getUserProfileClient() {
  try {
    const raw = localStorage.getItem(AUTH_PROFILE_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') return p;
    }
  } catch (e) {}
  return null;
}

function saveUserProfileClient(profile) {
  try {
    if (!profile) {
      localStorage.removeItem(AUTH_PROFILE_STORAGE_KEY);
    } else {
      localStorage.setItem(AUTH_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    }
  } catch (e) {}
  if (typeof appState !== 'undefined' && appState && appState.data) {
    appState.data.userProfile = profile || {
      role: 'guest',
      email: '',
      name: 'Guest Visitor',
      contact: '',
      deviceId: getOrCreateDeviceIdClient(),
      authorizedAt: ''
    };
  }
}

function generateProfileIdFromEmailClient(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (cleanEmail === '4wards.music@gmail.com') {
    return 'default';
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x5be0cd19;
  for (let i = 0; i < cleanEmail.length; i++) {
    const c = cleanEmail.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c * 31), 0x01000193);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return 'usr-u-' + (p1 + p2).slice(0, 10);
}

function isTestRunnerEnvironment() {
  try {
    if (typeof process !== 'undefined' && process.env && (process.env.NODE_ENV === 'test' || process.env.EARLISTHENIC_TEST)) {
      return true;
    }
    if (typeof window !== 'undefined') {
      if (window.__EARLISTHENIC_TEST_RUNNER__) return true;
      if (window.location && window.location.href && (window.location.href.indexOf('/test/') !== -1 || window.location.href.indexOf('test=1') !== -1)) return true;
    }
    if (typeof window === 'undefined') return true;
  } catch (e) {}
  return false;
}

function isOwnerAuthorizedClient() {
  if (typeof appState !== 'undefined' && appState && appState.serverIsOwner) {
    return true;
  }
  const prof = getUserProfileClient();
  if (prof && prof.role === 'owner' && prof.email && prof.email.toLowerCase() === '4wards.music@gmail.com') {
    return true;
  }
  try {
    const rawLegacy = localStorage.getItem(LOCAL_CACHE_KEY) || localStorage.getItem(LEGACY_CLEAN_V1_KEY);
    if (rawLegacy) {
      const parsed = JSON.parse(rawLegacy);
      const lp = (parsed && parsed.data && parsed.data.userProfile) || (parsed && parsed.userProfile) || {};
      if (lp && lp.email && lp.email.toLowerCase() === '4wards.music@gmail.com') {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function generateNewProfileIdClient() {
  const devId = getOrCreateDeviceIdClient();
  return 'usr-dev-' + devId;
}

/**
 * Automatically determines active user identity and resolves granted scope:
 * 1. Owner: 'owner' -> strictly bound to 'default'
 * 2. Member: 'member' -> strictly bound to 'usr-u-<hash(email)>'
 * 3. Guest: 'guest' -> strictly bound to 'usr-dev-<deviceId>'
 */
function resolveUserIdentityAndScope() {
  if (isOwnerAuthorizedClient()) {
    return {
      role: 'owner',
      profileId: 'default',
      email: '4wards.music@gmail.com'
    };
  }

  const prof = getUserProfileClient();
  if (prof && prof.role === 'member' && prof.email) {
    const memberPid = generateProfileIdFromEmailClient(prof.email);
    return {
      role: 'member',
      profileId: memberPid,
      email: prof.email,
      name: prof.name || 'Member',
      contact: prof.contact || ''
    };
  }

  const devId = getOrCreateDeviceIdClient();
  return {
    role: 'guest',
    profileId: 'usr-dev-' + devId,
    deviceId: devId
  };
}

function resolveProfileIdOnStartup() {
  const identity = resolveUserIdentityAndScope();

  // If Owner: allowed to access root 'default', or inspect via URL param
  if (identity.role === 'owner') {
    try {
      if (typeof window !== 'undefined' && window.location && window.location.search) {
        const params = new URLSearchParams(window.location.search);
        const fromUrl = sanitizeProfileIdClient(params.get('profile'));
        if (fromUrl) {
          try { localStorage.setItem(PROFILE_ID_STORAGE_KEY, fromUrl); } catch (e) {}
          return fromUrl;
        }
      }
    } catch (e) {}
    try { localStorage.setItem(PROFILE_ID_STORAGE_KEY, 'default'); } catch (e) {}
    return 'default';
  }

  // Non-owner (Member or Guest): STRICTLY CONFINED to their granted scope!
  // Cannot be routed to other users or owner via URL or document attributes
  try { localStorage.setItem(PROFILE_ID_STORAGE_KEY, identity.profileId); } catch (e) {}
  return identity.profileId;
}

function getActiveProfileId() {
  if (!appState.activeProfileId) {
    appState.activeProfileId = resolveProfileIdOnStartup();
  }
  return appState.activeProfileId;
}

function getScopedLocalCacheKey(profileId) {
  const pid = sanitizeProfileIdClient(profileId) || getActiveProfileId();
  return `${LOCAL_CACHE_KEY}::${pid}`;
}

function generateUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'sg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateToKeyInTz(dateObj, tz) {
  const d = dateObj instanceof Date && !isNaN(dateObj.getTime()) ? dateObj : new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || CONFIGURED_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return fmt.format(d);
  } catch (e) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}

function getLocalDateKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return formatDateToKeyInTz(d, CONFIGURED_TIMEZONE);
}

function createCleanClientDataRoot() {
  const nowIso = new Date().toISOString();
  const gameStats = {};
  Object.keys(SG_GAMES).forEach(id => {
    gameStats[id] = {
      highScore: 0,
      lastScore: 0,
      lastDelta: 0,
      maxLevel: 1,
      sessionsCompleted: 0,
      questionsAnswered: 0,
      totalAccuracySum: 0,
      practiceTimeSec: 0,
      bestStreak: 0
    };
  });

  return {
    schemaVersion: 1,
    scoringVersion: 8,
    revision: 1,
    app: {
      firstUseAt: nowIso,
      lastOpenedAt: nowIso,
      lastSavedAt: nowIso,
      timeZone: CONFIGURED_TIMEZONE
    },
    userProfile: (typeof getUserProfileClient === 'function' ? getUserProfileClient() : null) || {
      role: 'guest',
      email: '',
      name: 'Guest Visitor',
      contact: '',
      deviceId: (typeof getOrCreateDeviceIdClient === 'function' ? getOrCreateDeviceIdClient() : 'dev000000'),
      authorizedAt: ''
    },
    settings: {
      dailyGoalMinutes: 15,
      uiSfxEnabled: true,
      preferredSource: 'drums',
      masterVolumePct: 100,
      audioSampleRate: 'auto',
      audioBitDepth: '64f'
    },
    score: {
      initialSpi: 1000,
      currentSpi: 1000,
      peakSpi: 1000,
      totalPoints: 0,
      bestAnswerStreak: 0,
      currentAnswerStreak: 0,
      skillAxes: { freq: 0, bass: 0, symmetry: 0, filter: 0, speed: 0, feedback: 0 }
    },
    dailyCompletedByDate: {},
    dailyStats: {},
    gameStats: gameStats,
    weeklyMockPlans: createDefaultWeeklyMockPlansClient(),
    recentSessions: [],
    recentQuestionEvents: [],
    recentBehaviorEvents: [],
    mockExamHistory: [],
    legacyImportMeta: null
  };
}

const appState = {
  currentView: 'lobby',
  lobbyFilter: 'all',
  analyticsPeriod: '7d',
  demoModeActive: false,
  demoDataRoot: null,

  // Real persistent data root (no fabricated history!)
  data: createCleanClientDataRoot(),
  settings: {
    dailyGoalMinutes: 15,
    uiSfxEnabled: true,
    preferredSource: 'drums',
    masterVolumePct: 100,
    audioSampleRate: 'auto',
    audioBitDepth: '64f'
  },
  weeklyMockPlans: createDefaultWeeklyMockPlansClient(),
  selectedMockDay: new Date().getDay(),

  // Audio playback & loop region state
  isPlaying: false,
  loopStartRatio: 0.0,
  loopEndRatio: 1.0,
  draggingHandle: null,
  playbackStartedAtCtxTime: 0,
  playbackOffsetSec: 0,
  playbackAnchorCtxTime: 0,
  playbackAnchorPosSec: 0,
  playbackAnchorLoopStartSec: 0,
  playbackAnchorLoopEndSec: 0,

  // Active Arena exercise state
  gameMode: 'peak',
  level: 3,
  lives: 4,
  maxLives: 4,
  round: 1,
  maxRounds: 10,
  score: 0,
  listenState: 'target', // 'original' | 'target' | 'user'
  roundSubmitted: false,
  roundSubmittingLock: false,
  roundStartTimeMs: 0,

  // Hidden Target vs User Selection
  targetFreq: 1000,
  targetGain: 8.5,
  targetQ: 2.0,
  targetFilterType: 'lowpass',
  targetPan: 0.0,
  targetKnightIdx: 0,
  knightChoices: [],

  userFreq: 1000,
  userGain: 6.0,
  userFilterType: 'lowpass',
  userPan: 0.0,
  userKnightIdx: 0,
  isDraggingStage: false,

  // Cheetah 60s Blitz state
  cheetahRunning: false,
  cheetahSecLeft: 60.0,
  cheetahInterval: null,
  lastTickSecond: 11,

  // Mock Exam Queue state
  mockExamActive: false,
  mockExamFinished: false,
  mockQueue: [],
  mockCursor: 0,
  mockConfig: null,
  mockStartTimeMs: 0,
  mockStartedAtIso: '',
  mockSpiBefore: 1000,
  mockQuestionResults: [],
  mockQuestionTimerInterval: null,
  mockQuestionSecLeft: 0,
  mockExamTimerInterval: null,
  mockExamSecLeft: 300,
  mockExamTotalSec: 300,
  mockExamElapsedSec: 0,
  roundSubmittedAt: 0,

  // Explicit timestamp-based Practice Session accounting
  activeSession: null, // { sessionId, gameId, mode, startedAtIso, lastCheckpointMs, accumulatedSec, lastInteractionMs }

  // Drive synchronization, per-device profile isolation & FREE AUDIO library state
  activeProfileId: '',
  _profileLoadToken: 0,
  _baseDeploymentUrl: '',
  freeAudioTracks: [],
  _driveTrackLoadToken: 0,
  _freeAudioRenameTargetId: '',
  _freeAudioManagerBusy: false,
  syncState: 'saved', // 'saved' | 'saving' | 'offline' | 'error'
  syncInFlight: false,
  syncQueued: false,
  pendingSync: {
    questionEvents: [],
    sessions: [],
    mockExams: [],
    behaviorEvents: []
  },
  pendingMigrationObject: null
};

function getActiveDataRoot() {
  return appState.demoModeActive && appState.demoDataRoot ? appState.demoDataRoot : appState.data;
}

function ensureDailyRecordForDate(dateKey, baselineSpiOverride) {
  const root = getActiveDataRoot();
  const dk = dateKey || getLocalDateKey(0);
  if (!root.dailyStats[dk]) {
    const sorted = Object.keys(root.dailyStats).sort();
    let prevSpi = typeof baselineSpiOverride === 'number'
      ? baselineSpiOverride
      : (root.score.initialSpi || 1000);
    if (typeof baselineSpiOverride !== 'number') {
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i] < dk && root.dailyStats[sorted[i]]) {
          prevSpi = root.dailyStats[sorted[i]].spiEnd;
          break;
        }
      }
    }
    root.dailyStats[dk] = {
      date: dk,
      practiceSec: 0,
      spiStart: prevSpi,
      spiEnd: root.score.currentSpi,
      spiDelta: root.score.currentSpi - prevSpi,
      questionsAnswered: 0,
      accuracySum: 0,
      scorePoints: 0,
      sessionsCompleted: 0,
      mockExams: 0,
      abandonedCount: 0
    };
  }
  return root.dailyStats[dk];
}

function getTodayCircuitCompletionMap() {
  const root = getActiveDataRoot();
  const todayKey = getLocalDateKey(0);
  if (!root.dailyCompletedByDate) root.dailyCompletedByDate = {};
  if (!root.dailyCompletedByDate[todayKey]) {
    root.dailyCompletedByDate[todayKey] = { peak: false, bass: false, feedback: false };
  }
  return root.dailyCompletedByDate[todayKey];
}

/**
 * Applies a behavioral SPI bonus or penalty (incomplete session/mock, set completion,
 * daily circuit bonus), updates today's daily record, logs the event, and queues sync.
 */
function applyBehavioralSpiChange(delta, opts) {
  const o = opts || {};
  const dataRoot = getActiveDataRoot();
  if (!dataRoot || !dataRoot.score) return 0;

  const prevSpi = typeof dataRoot.score.currentSpi === 'number' ? dataRoot.score.currentSpi : 1000;
  const nextSpi = Math.max(500, prevSpi + Math.round(Number(delta) || 0));
  const actualDelta = nextSpi - prevSpi;

  dataRoot.score.currentSpi = nextSpi;
  if (nextSpi > (dataRoot.score.peakSpi || 0)) {
    dataRoot.score.peakSpi = nextSpi;
  }

  const dk = o.localDate || getLocalDateKey(0);
  const rec = ensureDailyRecordForDate(dk, prevSpi);
  if (actualDelta !== 0) {
    rec.spiEnd = nextSpi;
    rec.spiDelta = nextSpi - (typeof rec.spiStart === 'number' ? rec.spiStart : prevSpi);
  }
  if (o.countAsAbandon) {
    rec.abandonedCount = (rec.abandonedCount || 0) + 1;
  }

  const behEvent = {
    behaviorId: o.behaviorId || generateUuid(),
    type: o.type || (actualDelta < 0 ? 'penalty' : 'bonus'),
    localDate: dk,
    timestamp: new Date().toISOString(),
    label: o.label || 'Habit Adjustment',
    detail: o.detail || '',
    spiDelta: actualDelta
  };

  dataRoot.recentBehaviorEvents = Array.isArray(dataRoot.recentBehaviorEvents) ? dataRoot.recentBehaviorEvents : [];
  dataRoot.recentBehaviorEvents.unshift(behEvent);
  if (dataRoot.recentBehaviorEvents.length > 100) dataRoot.recentBehaviorEvents.length = 100;

  if (!appState.demoModeActive) {
    appState.pendingSync.behaviorEvents.push(behEvent);
    if (!o.skipSyncQueue) {
      queueProgressSync(o.type || 'behavior-spi');
    } else {
      saveStateToLocalCache();
    }
  }

  updateGlobalHeaderTrackingUI();
  return actualDelta;
}

/**
 * Explicit Timestamp-Based Practice Session Accounting
 * Counts practice time ONLY when:
 * 1. The user is in the Training Arena (`appState.currentView === 'arena'`),
 * 2. The document is visible (`!document.hidden`), AND
 * 3. Either audio is actively playing OR the user has interacted within the last 45 seconds.
 */
function startOrResumePracticeSession(gameId, mode) {
  const nowMs = performance.now();
  if (appState.activeSession && appState.activeSession.gameId === gameId && appState.activeSession.mode === mode) {
    appState.activeSession.lastCheckpointMs = nowMs;
    appState.activeSession.lastInteractionMs = nowMs;
    return;
  }
  endActivePracticeSession('switched');
  appState.activeSession = {
    sessionId: generateUuid(),
    gameId: gameId,
    mode: mode || (appState.mockExamActive ? 'mock' : 'practice'),
    startedAt: new Date().toISOString(),
    localDate: getLocalDateKey(0),
    lastCheckpointMs: nowMs,
    lastInteractionMs: nowMs,
    accumulatedMs: 0,
    questionsCount: 0,
    completed: false
  };
}

function markUserTrainingInteraction() {
  if (appState.activeSession) {
    reconcilePracticeSessionTime();
    appState.activeSession.lastInteractionMs = performance.now();
  }
}

function isPracticeSessionActivelyEngaged() {
  if (!appState.activeSession) return false;
  if (document.hidden) return false;
  if (appState.currentView !== 'arena') return false;
  const nowMs = performance.now();
  const idleMs = nowMs - (appState.activeSession.lastInteractionMs || nowMs);
  return Boolean(appState.isPlaying || appState.cheetahRunning || appState.mockExamActive || idleMs < 45000);
}

function reconcilePracticeSessionTime() {
  if (!appState.activeSession) return;
  const nowMs = performance.now();
  const elapsedMs = Math.max(0, nowMs - appState.activeSession.lastCheckpointMs);
  appState.activeSession.lastCheckpointMs = nowMs;

  if (!isPracticeSessionActivelyEngaged()) return;

  // Cap single delta to 10 seconds to prevent sleep/wake jumps
  const validDeltaMs = Math.min(10000, elapsedMs);
  appState.activeSession.accumulatedMs += validDeltaMs;

  const wholeNewSec = Math.floor(appState.activeSession.accumulatedMs / 1000);
  if (wholeNewSec >= 1) {
    appState.activeSession.accumulatedMs -= wholeNewSec * 1000;
    appState.activeSession.totalSec = (appState.activeSession.totalSec || 0) + wholeNewSec;

    const todayRec = ensureDailyRecordForDate(getLocalDateKey(0));
    todayRec.practiceSec = (todayRec.practiceSec || 0) + wholeNewSec;

    const root = getActiveDataRoot();
    const gStat = root.gameStats[appState.activeSession.gameId];
    if (gStat) {
      gStat.practiceTimeSec = (gStat.practiceTimeSec || 0) + wholeNewSec;
    }

    appState._unsyncedPracticeSec = (appState._unsyncedPracticeSec || 0) + wholeNewSec;
    // Auto-save to localStorage every 5 seconds of active practice
    if (appState._unsyncedPracticeSec % 5 === 0) {
      saveStateToLocalCache();
    }
    // Auto-sync to Drive every 30 seconds of practice
    if (appState._unsyncedPracticeSec >= 30) {
      appState._unsyncedPracticeSec = 0;
      saveStateToLocalCache();
      if (typeof flushDriveSyncQueue === 'function') {
        flushDriveSyncQueue();
      }
    }
  }
}

function endActivePracticeSession(reason, markCompleted = false) {
  if (!appState.activeSession) return;
  reconcilePracticeSessionTime();
  saveStateToLocalCache();
  const sess = appState.activeSession;
  appState.activeSession = null;

  const durationSec = sess.totalSec || 0;
  if (durationSec <= 0 && sess.questionsCount <= 0 && !markCompleted) return;

  const gSpec = SG_GAMES[sess.gameId] || { name: sess.gameId };
  const isAbandonedBlitz = Boolean(sess.cheetahBlitzActive && !markCompleted);
  const isAbandonedSet = Boolean(
    !markCompleted &&
    sess.mode === 'practice' &&
    sess.gameId !== 'cheetah' &&
    (sess.questionsCount || 0) >= 1 &&
    (sess.questionsCount || 0) < (appState.maxRounds || 10) &&
    appState.lives > 0 &&
    ['switched', 'restarted', 'left-to-lobby', 'left-to-mock'].includes(reason)
  );

  let incompletePenalty = 0;
  if (isAbandonedBlitz) {
    incompletePenalty = applyBehavioralSpiChange(-5, {
      type: 'incomplete_session',
      label: `Aborted 60s Blitz (${sess.questionsCount || 0} Q)`,
      detail: 'Left timed blitz early before 60s countdown finished',
      countAsAbandon: true,
      skipSyncQueue: true
    });
  } else if (isAbandonedSet) {
    const answered = sess.questionsCount || 0;
    const rawDrop = -Math.min(8, 2 + Math.ceil(Math.max(1, (appState.maxRounds || 10) - answered) * 0.6));
    incompletePenalty = applyBehavioralSpiChange(rawDrop, {
      type: 'incomplete_session',
      label: `Quit ${gSpec.name} Early (${answered}/${appState.maxRounds || 10} Q)`,
      detail: 'Incomplete 10-round practice set penalty',
      countAsAbandon: true,
      skipSyncQueue: true
    });
  }

  const sessionRecord = {
    sessionId: sess.sessionId,
    gameId: sess.gameId,
    mode: sess.mode,
    startedAt: sess.startedAt,
    endedAt: new Date().toISOString(),
    localDate: sess.localDate,
    durationSec: durationSec,
    questionsCount: sess.questionsCount || 0,
    completed: Boolean(markCompleted),
    endReason: reason || 'ended'
  };

  const root = getActiveDataRoot();
  root.recentSessions.unshift(sessionRecord);
  root.recentSessions = root.recentSessions.slice(0, 100);

  if (markCompleted) {
    const dayRec = ensureDailyRecordForDate(sess.localDate);
    dayRec.sessionsCompleted = (dayRec.sessionsCompleted || 0) + 1;
  }

  if (!appState.demoModeActive) {
    appState.pendingSync.sessions.push(sessionRecord);
    if (incompletePenalty < 0) {
      queueProgressSync('incomplete-session-penalty');
    } else {
      saveStateToLocalCache();
    }
  }

  if (incompletePenalty < 0 && typeof showTransportNotice === 'function') {
    showTransportNotice(`Incomplete session (${gSpec.name}): ${incompletePenalty} SPI penalty applied.`, true);
  }
}

document.addEventListener('visibilitychange', () => {
  reconcilePracticeSessionTime();
  updateGlobalHeaderTrackingUI();
  if (!document.hidden && typeof ensureStudioAnimationLoopRunning === 'function') {
    ensureStudioAnimationLoopRunning();
  }
});

// Reconcile active session time once per second using lightweight clock-only DOM updates
let _practiceClockIntervalId = setInterval(() => {
  reconcilePracticeSessionTime();
  updatePracticeClockDisplayOnly();
}, 1000);

function updatePracticeClockDisplayOnly() {
  const root = getActiveDataRoot();
  const todayRec = ensureDailyRecordForDate(getLocalDateKey(0));

  const timerEl = document.getElementById('header-practice-timer');
  const nextTime = formatSecondsHHMMSS(todayRec.practiceSec || 0);
  if (timerEl && timerEl.textContent !== nextTime) timerEl.textContent = nextTime;

  const goalSec = Math.max(60, (root.settings.dailyGoalMinutes || 15) * 60);
  const pct = Math.min(100, Math.round(((todayRec.practiceSec || 0) / goalSec) * 100));
  const pctEl = document.getElementById('header-goal-pct');
  const nextPct = `${pct}%`;
  if (pctEl && pctEl.textContent !== nextPct) pctEl.textContent = nextPct;

  // Also update Dashboard practice time display synchronously
  const dashTime = document.getElementById('dashboard-today-time');
  if (dashTime && dashTime.textContent !== nextTime) dashTime.textContent = nextTime;
  const dashPct = document.getElementById('dashboard-today-goal-pct');
  if (dashPct && dashPct.textContent !== nextPct) dashPct.textContent = nextPct;

  const led = document.getElementById('header-time-led');
  if (led) {
    const ledClass = isPracticeSessionActivelyEngaged()
      ? 'w-2 h-2 rounded-full bg-[#5E6B50]'
      : 'w-2 h-2 rounded-full bg-[#BFB29C]';
    if (led.className !== ledClass) led.className = ledClass;
  }
}

function formatSecondsHHMMSS(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTimeMMSS(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function formatHz(hz) {
  const val = Number(hz) || 0;
  if (val >= 1000) {
    return (val / 1000).toFixed(val >= 10000 ? 1 : 2).replace(/\.00$/, '') + ' kHz';
  }
  return (val % 1 === 0 ? Math.round(val) : val.toFixed(1)) + ' Hz';
}

function describeFreqBand(hz) {
  if (hz < 60) return 'Sub-Bass (<60 Hz)';
  if (hz < 250) return 'Bass Body (60–250 Hz)';
  if (hz < 500) return 'Low-Mid / Warmth (250–500 Hz)';
  if (hz < 2000) return 'Midrange / Presence (500 Hz–2 kHz)';
  if (hz < 4000) return 'Upper-Mid / Attack (2–4 kHz)';
  if (hz < 8000) return 'Clarity / Sibilance (4–8 kHz)';
  return 'Brilliance / Air (>8 kHz)';
}

function updateGlobalHeaderTrackingUI() {
  updatePracticeClockDisplayOnly();
  const root = getActiveDataRoot();
  const todayRec = ensureDailyRecordForDate(getLocalDateKey(0));

  const spiValEl = document.getElementById('header-spi-val');
  if (spiValEl) spiValEl.textContent = (root.score.currentSpi || 1000).toLocaleString();

  const delta = todayRec.spiDelta || 0;
  const deltaEl = document.getElementById('header-spi-delta');
  if (deltaEl) {
    deltaEl.textContent = `${delta >= 0 ? '+' : ''}${delta}`;
    deltaEl.className = delta >= 0
      ? 'text-[10px] px-1.5 py-0.2 rounded bg-[#E6ECE0] text-[#5E6B50] font-semibold'
      : 'text-[10px] px-1.5 py-0.2 rounded bg-[#F5E4E1] text-[#A8463B] font-semibold';
  }

  const streaks = computePracticeDayStreaks(root.dailyStats);
  const dayStreakEl = document.getElementById('header-day-streak-val');
  if (dayStreakEl) {
    dayStreakEl.textContent = `${streaks.currentStreak} day${streaks.currentStreak === 1 ? '' : 's'}`;
  }
  const ansStreakEl = document.getElementById('header-ans-streak-val');
  if (ansStreakEl) {
    ansStreakEl.textContent = String(root.score.currentAnswerStreak || 0);
  }

  const habitProfile = typeof computeHabitWeightingProfile === 'function'
    ? computeHabitWeightingProfile(root, getLocalDateKey(0))
    : { weight: 1.0, tier: 'Baseline' };
  const weightValEl = document.getElementById('header-habit-weight-val');
  if (weightValEl) {
    weightValEl.textContent = `${habitProfile.weight.toFixed(2)}x`;
    weightValEl.className = habitProfile.weight < 0.95
      ? 'font-mono-tabular font-semibold text-xs text-[#A8463B] leading-tight'
      : 'font-mono-tabular font-semibold text-xs text-[#5E6B50] leading-tight';
  }
  const lobbyWeightPill = document.getElementById('lobby-habit-weight-pill');
  if (lobbyWeightPill) {
    lobbyWeightPill.textContent = `Habit Weight: ${habitProfile.weight.toFixed(2)}x (${habitProfile.tier})`;
    lobbyWeightPill.className = habitProfile.weight < 0.95
      ? 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#F5E4E1] text-[#A8463B] border border-[#A8463B]/30 text-[11px] font-mono-tabular font-semibold'
      : 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#E6ECE0] text-[#5E6B50] border border-[#5E6B50]/30 text-[11px] font-mono-tabular font-semibold';
  }
}

/********************************************************************
 * DRIVE PERSISTENCE & LOCAL CACHE SYNCHRONIZATION
 ********************************************************************/
function setDriveSyncStatusUI(state, message) {
  appState.syncState = state;
  const dot = document.getElementById('drive-sync-dot');
  const lbl = document.getElementById('drive-sync-label');
  const retryBtn = document.getElementById('btn-drive-retry');
  if (!dot || !lbl || !retryBtn) return;

  if (state === 'saving') {
    dot.className = 'w-2 h-2 rounded-full bg-[#9E7B42]';
    lbl.textContent = message || 'Saving…';
    retryBtn.classList.add('hidden');
  } else if (state === 'saved') {
    dot.className = 'w-2 h-2 rounded-full bg-[#5E6B50]';
    lbl.textContent = message || 'Saved to Drive';
    retryBtn.classList.add('hidden');
  } else if (state === 'offline') {
    dot.className = 'w-2 h-2 rounded-full bg-[#6E675B] shrink-0';
    lbl.textContent = message || 'Local Cache';
    retryBtn.classList.remove('hidden');
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-[#A8463B] shrink-0';
    lbl.textContent = message || 'Save failed';
    retryBtn.classList.remove('hidden');
  }
}

function saveStateToLocalCache() {
  if (appState.demoModeActive) return;
  try {
    const pid = getActiveProfileId();
    appState.data.settings = Object.assign({}, appState.settings);
    appState.data.weeklyMockPlans = appState.weeklyMockPlans;
    appState.data.app.lastSavedAt = new Date().toISOString();
    localStorage.setItem(getScopedLocalCacheKey(pid), JSON.stringify({
      profileId: pid,
      data: appState.data,
      pendingSync: appState.pendingSync
    }));
  } catch (e) {}
}

function rescoreRecentQuestionEventsClient() {
  const root = getActiveDataRoot();
  if (!root || !Array.isArray(root.recentQuestionEvents) || root.recentQuestionEvents.length === 0) {
    if (root) root.scoringVersion = 8;
    return 0;
  }
  let rescoredCount = 0;
  const runningSpi = root.score.currentSpi || 1000;
  for (const ev of root.recentQuestionEvents) {
    if (!ev || !ev.target || !ev.response) continue;
    if (typeof scoreQuestionSubmission === 'function') {
      const res = scoreQuestionSubmission({
        gameMode: ev.gameId || 'peak',
        level: ev.difficulty || 1,
        mode: ev.mode || 'practice',
        currentSpi: runningSpi,
        todayQuestions: 30,
        target: ev.target,
        user: ev.response,
        habitWeight: ev.habitWeightApplied || 1.0,
        reactionSec: (ev.responseTimeMs || 2000) / 1000,
        isTimeout: ev.status === 'timeout'
      });
      ev.accuracy = res.accuracy;
      ev.scorePoints = res.scorePoints;
      ev.spiDelta = res.spiDelta;
      ev.passed = res.passed;
      ev.isNearMiss = res.isNearMiss;
      ev.deductHeart = res.deductHeart;
      ev.status = res.status;
      ev.errors = res.errors;
      ev.scoringVersion = 8;
      rescoredCount++;
    }
  }
  root.scoringVersion = 8;
  return rescoredCount;
}

function loadStateFromLocalCache() {
  try {
    const pid = getActiveProfileId();
    let raw = localStorage.getItem(getScopedLocalCacheKey(pid));
    if (!raw && pid === 'default' && isOwnerAuthorizedClient()) {
      raw = localStorage.getItem(LOCAL_CACHE_KEY) || localStorage.getItem(LEGACY_CLEAN_V1_KEY);
    }
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.data && parsed.data.app && parsed.data.app.firstUseAt) {
      // Contamination Defense: Guest profile must never adopt Owner email or leaked metrics
      if (pid.startsWith('usr-dev-')) {
        const uEmail = (parsed.data.userProfile && parsed.data.userProfile.email) || '';
        if (uEmail && uEmail.toLowerCase() === '4wards.music@gmail.com') {
          try { localStorage.removeItem(getScopedLocalCacheKey(pid)); } catch (e) {}
          return false;
        }
      }
      applyLoadedProgressDocument(parsed.data);
      if (parsed.pendingSync) {
        appState.pendingSync = {
          questionEvents: parsed.pendingSync.questionEvents || [],
          sessions: parsed.pendingSync.sessions || [],
          mockExams: parsed.pendingSync.mockExams || [],
          behaviorEvents: parsed.pendingSync.behaviorEvents || []
        };
      }
      if (!appState.data.scoringVersion || appState.data.scoringVersion < 8) {
        const rescored = rescoreRecentQuestionEventsClient();
        if (rescored > 0) {
          saveStateToLocalCache();
        }
      }
      return true;
    }
  } catch (e) {}
  return false;
}

function applyLoadedProgressDocument(doc) {
  if (!doc || typeof doc !== 'object') return;
  const currentPid = getActiveProfileId();
  const isSameProfile = (appState._lastLoadedProfileId === currentPid);
  const previousDailyStats = (isSameProfile && appState.data && appState.data.dailyStats) ? Object.assign({}, appState.data.dailyStats) : {};
  const previousGameStats = (isSameProfile && appState.data && appState.data.gameStats) ? Object.assign({}, appState.data.gameStats) : {};

  const base = createCleanClientDataRoot();
  appState.data = Object.assign(base, doc);
  appState._lastLoadedProfileId = currentPid;
  appState.data.scoringVersion = doc.scoringVersion || 8;
  appState.data.app = Object.assign(base.app, doc.app || {});
  appState.data.settings = Object.assign(base.settings, doc.settings || {});
  appState.data.score = Object.assign(base.score, doc.score || {});
  appState.data.score.skillAxes = Object.assign(base.score.skillAxes, (doc.score && doc.score.skillAxes) || {});
  appState.data.gameStats = Object.assign(base.gameStats, doc.gameStats || {});
  appState.data.dailyStats = Object.assign({}, base.dailyStats, doc.dailyStats || {});
  appState.data.dailyCompletedByDate = Object.assign({}, base.dailyCompletedByDate, doc.dailyCompletedByDate || {});

  // Only reconcile in-flight offline practice time if refreshing the SAME active profile session
  if (isSameProfile) {
    for (const dk of Object.keys(previousDailyStats)) {
      if (!appState.data.dailyStats[dk]) {
        appState.data.dailyStats[dk] = previousDailyStats[dk];
      } else {
        appState.data.dailyStats[dk].practiceSec = Math.max(
          Number(appState.data.dailyStats[dk].practiceSec) || 0,
          Number(previousDailyStats[dk].practiceSec) || 0
        );
      }
    }
    for (const gk of Object.keys(previousGameStats)) {
      if (appState.data.gameStats[gk]) {
        appState.data.gameStats[gk].practiceTimeSec = Math.max(
          Number(appState.data.gameStats[gk].practiceTimeSec) || 0,
          Number(previousGameStats[gk].practiceTimeSec) || 0
        );
      }
    }
  }
  appState.data.recentBehaviorEvents = Array.isArray(doc.recentBehaviorEvents) ? doc.recentBehaviorEvents : [];
  appState.data.weeklyMockPlans = Object.assign(createDefaultWeeklyMockPlansClient(), doc.weeklyMockPlans || {});
  if (doc && doc.userProfile && typeof doc.userProfile === 'object') {
    appState.data.userProfile = Object.assign({
      role: 'guest',
      email: '',
      name: 'Guest Visitor',
      contact: '',
      deviceId: getOrCreateDeviceIdClient(),
      authorizedAt: ''
    }, doc.userProfile);
    if (doc.userProfile.email && typeof saveUserProfileClient === 'function') {
      saveUserProfileClient(appState.data.userProfile);
    }
  }

  appState.settings = Object.assign({}, appState.data.settings);
  appState.weeklyMockPlans = appState.data.weeklyMockPlans;

  // Always align Web Audio with OS/Soundcard/DAC clock ('auto') & max bit precision ('64f' FIR / max native OS bus),
  // and default untouched 80% output to 100% digital unity gain.
  appState.settings.audioSampleRate = 'auto';
  appState.settings.audioBitDepth = '64f';
  if (!appState.settings.masterVolumeUserSet && (appState.settings.masterVolumePct == null || appState.settings.masterVolumePct === 80)) {
    appState.settings.masterVolumePct = 100;
  }
  if (appState.data && appState.data.settings) {
    appState.data.settings.audioSampleRate = 'auto';
    appState.data.settings.audioBitDepth = '64f';
    appState.data.settings.masterVolumePct = appState.settings.masterVolumePct;
  }
  const activeVol = typeof appState.settings.masterVolumePct === 'number' ? appState.settings.masterVolumePct : 100;
  const volSlider = document.getElementById('master-vol-slider');
  if (volSlider) volSlider.value = String(activeVol);
  const volLbl = document.getElementById('lbl-master-vol');
  if (volLbl) volLbl.textContent = `${activeVol}%`;
  if (typeof sgAudioEngine !== 'undefined' && sgAudioEngine) {
    sgAudioEngine.requestedSampleRate = 'auto';
    sgAudioEngine.bitDepth = '64f';
    sgAudioEngine.setMasterVolumePct(activeVol);
  }
  syncAudioFormatControlsUI();
}

function hasAppsScriptBridge() {
  return Boolean(typeof google !== 'undefined' && google.script && google.script.run);
}

function applyStartupSkippedDayDecay(remoteKnownBehaviorIds) {
  if (typeof reconcileSkippedDayPenalties !== 'function') return { appliedDays: 0, totalPenalty: 0 };
  const decayRes = reconcileSkippedDayPenalties(appState.data, getLocalDateKey(0));
  if (decayRes.appliedDays > 0) {
    (appState.data.recentBehaviorEvents || []).forEach(ev => {
      if (ev && ev.type === 'skip_day') {
        const known = remoteKnownBehaviorIds && remoteKnownBehaviorIds.has(ev.behaviorId);
        const queued = appState.pendingSync.behaviorEvents.some(p => p && p.behaviorId === ev.behaviorId);
        if (!known && !queued) {
          appState.pendingSync.behaviorEvents.push(ev);
        }
      }
    });
    saveStateToLocalCache();
    if (typeof showTransportNotice === 'function') {
      showTransportNotice(`Skipped ${decayRes.appliedDays} recent day(s): -${decayRes.totalPenalty} SPI decay applied.`, true);
    }
  }
  return decayRes;
}

function buildProfileShareUrl(profileId) {
  const pid = sanitizeProfileIdClient(profileId) || getActiveProfileId();
  const baseUrl = 'https://sinh2022.github.io/Earlisthenic/';
  if (pid === 'default') {
    return baseUrl;
  }
  return `${baseUrl}?profile=${encodeURIComponent(pid)}`;
}

function updateProfileHeaderUI() {
  const pid = getActiveProfileId();
  const isOwner = pid === 'default';
  const prof = (appState && appState.data && appState.data.userProfile) || getUserProfileClient() || {
    role: isOwner ? 'owner' : 'guest',
    email: isOwner ? '4wards.music@gmail.com' : '',
    name: isOwner ? 'Master Administrator' : 'Guest Visitor',
    contact: '',
    deviceId: getOrCreateDeviceIdClient()
  };
  const role = isOwner ? 'owner' : (prof.role || (pid.startsWith('usr-u-') ? 'member' : 'guest'));

  const lbl = document.getElementById('header-profile-label');
  if (lbl) {
    lbl.textContent = isOwner ? 'Owner' : (pid.length > 12 ? pid.slice(0, 12) + '…' : pid);
  }
  const btn = document.getElementById('btn-profile-switcher');
  if (btn) {
    btn.title = isOwner
      ? 'Active Workspace: Owner root (My Drive/Earlisthenic/)'
      : `Active Isolated Profile: ${pid} (My Drive/Earlisthenic/profiles/${pid}/)`;
  }
  const disp = document.getElementById('profile-active-id-display');
  if (disp) disp.value = pid;
  const hint = document.getElementById('profile-storage-path-hint');
  if (hint) {
    hint.textContent = isOwner ? 'Earlisthenic/' : `Earlisthenic/profiles/${pid}/`;
  }

  // Update Profile Card elements
  const badgeEl = document.getElementById('profile-role-badge');
  if (badgeEl) {
    if (role === 'owner') {
      badgeEl.textContent = 'Owner (Root)';
      badgeEl.className = 'px-2 py-0.5 rounded text-[10px] font-mono-tabular font-bold bg-[#B56D4E] text-white';
    } else if (role === 'member') {
      badgeEl.textContent = 'Member';
      badgeEl.className = 'px-2 py-0.5 rounded text-[10px] font-mono-tabular font-bold bg-[#5E6B50] text-white';
    } else {
      badgeEl.textContent = 'Guest';
      badgeEl.className = 'px-2 py-0.5 rounded text-[10px] font-mono-tabular font-bold bg-[#EAE2D4] text-[#302D28]';
    }
  }

  const nameEl = document.getElementById('profile-card-name');
  if (nameEl) nameEl.textContent = prof.name || (isOwner ? 'Master Administrator' : 'Guest Visitor');

  const emailEl = document.getElementById('profile-card-email');
  if (emailEl) emailEl.textContent = prof.email || (isOwner ? '4wards.music@gmail.com' : 'Not linked (Device ID only)');

  const contactEl = document.getElementById('profile-card-contact');
  if (contactEl) contactEl.textContent = prof.contact || 'None provided';

  const devEl = document.getElementById('profile-card-device');
  if (devEl) devEl.textContent = prof.deviceId || getOrCreateDeviceIdClient();

  const guestActions = document.getElementById('profile-guest-actions');
  if (guestActions) guestActions.classList.toggle('hidden', role !== 'guest');

  const memberActions = document.getElementById('profile-member-actions');
  if (memberActions) memberActions.classList.toggle('hidden', role !== 'member');

  const ownerActions = document.getElementById('profile-owner-actions');
  if (ownerActions) ownerActions.classList.toggle('hidden', role !== 'owner');

  const manageBtn = document.getElementById('btn-manage-free-audio');
  if (manageBtn) {
    manageBtn.classList.toggle('hidden', !isOwner);
    manageBtn.classList.toggle('inline-flex', isOwner);
  }
  if (!isOwner) {
    closeFreeAudioManagerModal();
  }
}

function openProfileModal() {
  updateProfileHeaderUI();
  const input = document.getElementById('profile-switch-input');
  if (input) input.value = '';
  const goalSelect = document.getElementById('profile-daily-goal-select');
  if (goalSelect) {
    const dataRoot = getActiveDataRoot();
    goalSelect.value = String((dataRoot.settings && dataRoot.settings.dailyGoalMinutes) || 15);
  }
  const modal = document.getElementById('profile-manager-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeProfileModal() {
  const modal = document.getElementById('profile-manager-modal');
  if (modal) {
    modal.classList.remove('flex');
    modal.classList.add('hidden');
  }
}

function openAuthGatewayModal() {
  closeProfileModal();
  closeUserProfileAuthModal();
  const modal = document.getElementById('auth-gateway-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeAuthGatewayModal() {
  const modal = document.getElementById('auth-gateway-modal');
  if (modal) {
    modal.classList.remove('flex');
    modal.classList.add('hidden');
  }
}

function handleGuestLogin() {
  const devId = getOrCreateDeviceIdClient();
  const guestPid = 'usr-dev-' + devId;
  const prof = {
    role: 'guest',
    email: '',
    name: 'Guest Visitor',
    contact: '',
    deviceId: devId,
    authorizedAt: new Date().toISOString()
  };
  saveUserProfileClient(prof);
  try {
    localStorage.setItem(AUTH_DECISION_KEY, 'guest');
    localStorage.setItem(PROFILE_ID_STORAGE_KEY, guestPid);
  } catch (e) {}
  closeAuthGatewayModal();
  switchToProfileId(guestPid);
}

function openUserProfileAuthModal() {
  closeAuthGatewayModal();
  const prof = getUserProfileClient();
  const emailInput = document.getElementById('auth-input-email');
  if (emailInput) emailInput.value = (prof && prof.email) || '';
  const nameInput = document.getElementById('auth-input-name');
  if (nameInput) nameInput.value = (prof && prof.name) || '';
  const contactInput = document.getElementById('auth-input-contact');
  if (contactInput) contactInput.value = (prof && prof.contact) || '';
  const chk = document.getElementById('auth-consent-checkbox');
  if (chk) chk.checked = !!(prof && prof.authorizedAt);
  const errEl = document.getElementById('auth-form-error');
  if (errEl) errEl.classList.add('hidden');

  const modal = document.getElementById('user-profile-auth-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeUserProfileAuthModal() {
  const modal = document.getElementById('user-profile-auth-modal');
  if (modal) {
    modal.classList.remove('flex');
    modal.classList.add('hidden');
  }
}

function openOwnerLoginPrompt() {
  openUserProfileAuthModal();
  const emailInput = document.getElementById('auth-input-email');
  if (emailInput) {
    emailInput.value = '4wards.music@gmail.com';
    emailInput.focus();
  }
  const nameInput = document.getElementById('auth-input-name');
  if (nameInput) nameInput.value = 'Owner Administrator';
}

// =====================================================================
// GOOGLE IDENTITY SERVICES (GIS) & ACCOUNT CHOOSER (LEAST PRIVILEGE)
// Standard Non-Sensitive Scopes: openid, email, profile
// Zero Apps Script Manifest / Drive / Mail authorization prompts for users
// =====================================================================
const DEFAULT_GOOGLE_CLIENT_ID = '961712975978-aj2iacanscc48ahmj619uud9hgha09nn.apps.googleusercontent.com';
let g_gisInitialized = false;

function initGoogleIdentityServicesClient(customClientId) {
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) return;
  const metaEl = typeof document !== 'undefined' ? document.querySelector('meta[name="google-signin-client_id"]') : null;
  const metaClientId = metaEl ? metaEl.getAttribute('content') : '';
  const effectiveClientId = customClientId || window.EARLISTHENIC_GOOGLE_CLIENT_ID || metaClientId || DEFAULT_GOOGLE_CLIENT_ID || (function() {
    try { return localStorage.getItem('earlisthenic_google_client_id') || ''; } catch (e) { return ''; }
  })();
  if (!effectiveClientId) return;

  try {
    google.accounts.id.initialize({
      client_id: effectiveClientId,
      callback: handleGoogleIdentityCredentialResponse_,
      auto_select: false,
      cancel_on_tap_outside: true
    });
    g_gisInitialized = true;

    const btnContainer = document.getElementById('gsi-button-container');
    if (btnContainer) {
      btnContainer.innerHTML = '';
      google.accounts.id.renderButton(btnContainer, {
        theme: 'filled_blue',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width: 280
      });
    }
  } catch (err) {
    console.warn('GIS initialization notice:', err);
  }
}

function handleGoogleIdentityCredentialResponse_(response) {
  if (!response || !response.credential) return;
  const idToken = response.credential;
  const claims = parseJwtPayloadClient_(idToken);
  if (!claims || !claims.email) return;

  const email = claims.email.toLowerCase();
  const name = claims.name || email.split('@')[0];
  const devId = getOrCreateDeviceIdClient();

  try {
    localStorage.setItem('earlisthenic_last_google_account', JSON.stringify({
      email: email,
      name: name,
      picture: claims.picture || ''
    }));
  } catch (e) {}

  closeGoogleAccountPickerModal();
  completeGoogleMemberRegistration_(email, name, devId, idToken);
}

function parseJwtPayloadClient_(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function triggerGoogleIdentityPromptOrPicker_() {
  if (typeof google !== 'undefined' && google.accounts && google.accounts.id && g_gisInitialized) {
    try {
      google.accounts.id.prompt(function(notification) {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          openGoogleAccountPickerModal();
        }
      });
      return;
    } catch (e) {}
  }
  openGoogleAccountPickerModal();
}

function renderGooglePickerAccountsList(accounts) {
  const accountsContainer = document.getElementById('google-picker-accounts-container');
  const inputContainer = document.getElementById('google-picker-input-container');
  const useAnotherBtn = document.getElementById('btn-google-use-another');
  if (!accountsContainer) return;

  if (accounts && accounts.length > 0) {
    accountsContainer.innerHTML = accounts.map(acc => {
      const initial = (acc.name || acc.email || 'G').charAt(0).toUpperCase();
      const safeEmail = escapeHtml(acc.email);
      const safeName = escapeHtml(acc.name || (acc.email ? acc.email.split('@')[0] : ''));
      const encEmail = encodeURIComponent(acc.email || '');
      const encName = encodeURIComponent(acc.name || (acc.email ? acc.email.split('@')[0] : ''));
      return `
        <button type="button" onclick="selectGoogleAccountFromPicker(decodeURIComponent('${encEmail}'), decodeURIComponent('${encName}'))" class="w-full flex items-center gap-3 p-3 rounded-xl border border-[#DADCE0] hover:bg-[#F8F9FA] transition text-left cursor-pointer group">
          <div class="w-10 h-10 rounded-full bg-[#1A73E8] text-white flex items-center justify-center font-medium text-base shrink-0 shadow-sm">
            ${initial}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-medium text-sm text-[#202124] truncate group-hover:text-[#1A73E8] transition-colors">${safeName}</div>
            <div class="text-xs text-[#5F6368] truncate">${safeEmail}</div>
          </div>
          <span class="text-[10px] font-mono-tabular px-2 py-0.5 rounded bg-[#E8F0FE] text-[#1A73E8] font-semibold shrink-0">1-Click</span>
        </button>
      `;
    }).join('');
    accountsContainer.classList.remove('hidden');
    if (useAnotherBtn) useAnotherBtn.classList.remove('hidden');
    if (inputContainer) inputContainer.classList.add('hidden');
  } else {
    accountsContainer.classList.add('hidden');
    if (useAnotherBtn) useAnotherBtn.classList.add('hidden');
    if (inputContainer) {
      inputContainer.classList.remove('hidden');
      const input = document.getElementById('google-picker-email-input');
      if (input) setTimeout(() => input.focus(), 60);
    }
  }
}

function openGoogleAccountPickerModal() {
  closeAuthGatewayModal();
  closeUserProfileAuthModal();
  closeProfileModal();

  initGoogleIdentityServicesClient();

  const errEl = document.getElementById('google-picker-error');
  if (errEl) errEl.classList.add('hidden');

  let accounts = [];

  // Check remembered account from previous session
  try {
    const rememberedJson = localStorage.getItem('earlisthenic_last_google_account');
    if (rememberedJson) {
      const parsed = JSON.parse(rememberedJson);
      if (parsed && parsed.email) accounts.push(parsed);
    }
  } catch (e) {}

  // Check current profile email if member or owner
  const currentProf = getUserProfileClient();
  if (currentProf && currentProf.email && !accounts.some(a => a.email.toLowerCase() === currentProf.email.toLowerCase())) {
    accounts.push({
      email: currentProf.email,
      name: currentProf.name || currentProf.email.split('@')[0]
    });
  }

  // Check if manual email input has candidate email
  const emailInput = document.getElementById('auth-input-email');
  const candidate = (emailInput && emailInput.value ? emailInput.value.trim() : '');
  if (candidate && candidate.includes('@') && !accounts.some(a => a.email.toLowerCase() === candidate.toLowerCase())) {
    accounts.push({ email: candidate, name: candidate.split('@')[0] });
  }

  renderGooglePickerAccountsList(accounts);

  // If in Apps Script environment, probe active Google Session email asynchronously to augment choices
  if (typeof hasAppsScriptBridge === 'function' && hasAppsScriptBridge() && typeof google !== 'undefined' && google.script && google.script.run) {
    google.script.run
      .withSuccessHandler(function(sessionRes) {
        if (sessionRes && sessionRes.email) {
          const emLower = sessionRes.email.toLowerCase();
          if (!accounts.some(a => a.email.toLowerCase() === emLower)) {
            accounts.unshift({
              email: sessionRes.email,
              name: sessionRes.email.split('@')[0]
            });
            renderGooglePickerAccountsList(accounts);
          }
        }
      })
      .checkGoogleSessionServer();
  }

  const modal = document.getElementById('google-account-picker-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closeGoogleAccountPickerModal() {
  const modal = document.getElementById('google-account-picker-modal');
  if (modal) {
    modal.classList.remove('flex');
    modal.classList.add('hidden');
  }
}

function toggleGooglePickerManualInput(showManual) {
  const accountsContainer = document.getElementById('google-picker-accounts-container');
  const inputContainer = document.getElementById('google-picker-input-container');
  const useAnotherBtn = document.getElementById('btn-google-use-another');
  const err = document.getElementById('google-picker-error');
  if (err) err.classList.add('hidden');

  if (showManual) {
    if (accountsContainer) accountsContainer.classList.add('hidden');
    if (useAnotherBtn) useAnotherBtn.classList.add('hidden');
    if (inputContainer) {
      inputContainer.classList.remove('hidden');
      const input = document.getElementById('google-picker-email-input');
      if (input) setTimeout(() => input.focus(), 60);
    }
  } else {
    if (accountsContainer) accountsContainer.classList.remove('hidden');
    if (useAnotherBtn) useAnotherBtn.classList.remove('hidden');
    if (inputContainer) inputContainer.classList.add('hidden');
  }
}

function selectGoogleAccountFromPicker(email, name) {
  closeGoogleAccountPickerModal();
  completeGoogleMemberRegistration_(email, name, getOrCreateDeviceIdClient());
}

function submitGoogleAccountFromInput() {
  const input = document.getElementById('google-picker-email-input');
  const err = document.getElementById('google-picker-error');
  const rawEmail = input ? input.value.trim() : '';
  const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

  if (!rawEmail || !EMAIL_REGEX.test(rawEmail)) {
    if (err) {
      err.textContent = 'Please enter a valid Google email address.';
      err.classList.remove('hidden');
    }
    return;
  }
  closeGoogleAccountPickerModal();
  const userName = rawEmail.split('@')[0];
  completeGoogleMemberRegistration_(rawEmail, userName, getOrCreateDeviceIdClient());
}

function openGoogleAuthPopupWindow(url) {
  // Security invariant: never expose Apps Script full-scope OAuth URLs to end-users
  if (!url || typeof url !== 'string' || url.includes('ScriptApp') || url.includes('/macros/d/')) {
    openGoogleAccountPickerModal();
    return;
  }
  const w = 520;
  const h = 640;
  const left = Math.max(0, (window.screen.width - w) / 2);
  const top = Math.max(0, (window.screen.height - h) / 2);
  try {
    const popup = window.open(url, 'GoogleSignIn', `width=${w},height=${h},top=${top},left=${left},status=no,toolbar=no,menubar=no`);
    if (popup) {
      popup.focus();
      showTransportNotice('Google authorization popup opened.');
      return;
    }
  } catch (e) {}
  openGoogleAccountPickerModal();
}

function completeGoogleMemberRegistration_(email, name, devId, idToken) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const isOwner = cleanEmail === '4wards.music@gmail.com';
  const role = isOwner ? 'owner' : 'member';
  const targetPid = isOwner ? 'default' : generateProfileIdFromEmailClient(cleanEmail);
  const userName = (name || cleanEmail.split('@')[0] || 'Member').trim();

  try {
    localStorage.setItem('earlisthenic_last_google_account', JSON.stringify({ email: cleanEmail, name: userName }));
  } catch (e) {}

  if (typeof hasAppsScriptBridge === 'function' && hasAppsScriptBridge() && typeof google !== 'undefined' && google.script && google.script.run) {
    showTransportNotice(`Registering Google Member account for ${userName}...`);
    google.script.run
      .withSuccessHandler(function(regRes) {
        if (regRes && regRes.ok) {
          const prof = regRes.userProfile || {
            role: regRes.role,
            email: cleanEmail,
            name: userName,
            deviceId: devId,
            authProvider: 'google',
            authorizedAt: new Date().toISOString()
          };
          saveUserProfileClient(prof);
          try {
            localStorage.setItem(AUTH_DECISION_KEY, prof.role);
            localStorage.setItem(PROFILE_ID_STORAGE_KEY, regRes.profileId);
          } catch (e) {}

          closeUserProfileAuthModal();
          closeAuthGatewayModal();
          closeProfileModal();
          closeGoogleAccountPickerModal();
          switchToProfileId(regRes.profileId);

          if (regRes.welcomeEmailSent) {
            showTransportNotice(`Welcome, ${prof.name}! Membership confirmed. Confirmation email sent to ${prof.email}.`);
          } else {
            showTransportNotice(`Welcome back, ${prof.name}! Workspace synced.`);
          }
        } else {
          showTransportNotice('Registration error: ' + ((regRes && regRes.error) || 'Unknown error'));
        }
      })
      .withFailureHandler(function(err) {
        showTransportNotice('Registration failed: ' + (err && err.message ? err.message : String(err)));
      })
      .registerGoogleMemberAccountServer({
        email: cleanEmail,
        name: userName,
        deviceId: devId,
        idToken: idToken || ''
      });
    return;
  }

  // Local / Test runner environment
  completeLocalGoogleAuth_(cleanEmail, userName, devId);
}

function completeLocalGoogleAuth_(email, name, devId) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const isOwner = cleanEmail === '4wards.music@gmail.com';
  const role = isOwner ? 'owner' : 'member';
  const targetPid = isOwner ? 'default' : generateProfileIdFromEmailClient(cleanEmail);
  const userName = (name || cleanEmail.split('@')[0] || 'Member').trim();
  const prof = {
    role: role,
    email: cleanEmail,
    name: userName,
    contact: '',
    deviceId: devId,
    authorizedAt: new Date().toISOString(),
    authProvider: 'google',
    welcomeEmailSentAt: new Date().toISOString()
  };
  saveUserProfileClient(prof);
  try {
    localStorage.setItem(AUTH_DECISION_KEY, role);
    localStorage.setItem(PROFILE_ID_STORAGE_KEY, targetPid);
  } catch (e) {}

  closeUserProfileAuthModal();
  closeAuthGatewayModal();
  closeProfileModal();
  closeGoogleAccountPickerModal();
  switchToProfileId(targetPid);
  showTransportNotice(`Google Account authorized for ${userName}. Welcome to Earlisthenic!`);
}

function handleGoogleSignInClient() {
  const devId = getOrCreateDeviceIdClient();
  closeAuthGatewayModal();
  closeUserProfileAuthModal();
  closeProfileModal();

  const emailInput = document.getElementById('auth-input-email');
  const candidateEmail = (emailInput && emailInput.value ? emailInput.value.trim() : '');

  // If candidate email is already provided, complete registration directly
  if (candidateEmail && candidateEmail.includes('@')) {
    completeGoogleMemberRegistration_(candidateEmail, candidateEmail.split('@')[0], devId);
    return;
  }

  // If in test runner, execute deterministic local auth for tests
  if (isTestRunnerEnvironment()) {
    const testEmail = isOwnerAuthorizedClient() ? '4wards.music@gmail.com' : 'musician@studio.vn';
    completeLocalGoogleAuth_(testEmail, testEmail.split('@')[0], devId);
    return;
  }

  // Open Google Account Chooser in a new tab so user can choose / switch their Google account
  try {
    if (typeof window !== 'undefined' && window.open) {
      const chooserUrl = ['https:', String.fromCharCode(47, 47), 'accounts.google.com', String.fromCharCode(47), 'AccountChooser', String.fromCharCode(63), 'service=lso'].join('');
      window.open(chooserUrl, '_blank');
    }
  } catch (e) {}

  // Open the in-app Google account picker modal
  openGoogleAccountPickerModal();
}

function handleUserProfileAuthSubmit(event) {
  if (event && event.preventDefault) event.preventDefault();
  const emailInput = document.getElementById('auth-input-email');
  const nameInput = document.getElementById('auth-input-name');
  const contactInput = document.getElementById('auth-input-contact');
  const chk = document.getElementById('auth-consent-checkbox');
  const errEl = document.getElementById('auth-form-error');

  const rawEmail = (emailInput ? emailInput.value : '').trim();
  const rawName = (nameInput ? nameInput.value : '').trim();
  const rawContact = (contactInput ? contactInput.value : '').trim();

  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    if (errEl) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (!rawName) {
    if (errEl) {
      errEl.textContent = 'Please enter your full name or display name.';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (chk && !chk.checked) {
    if (errEl) {
      errEl.textContent = 'Please authorize profile data storage to proceed.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  const cleanEmail = rawEmail.toLowerCase();
  const isOwner = cleanEmail === '4wards.music@gmail.com';
  const role = isOwner ? 'owner' : 'member';
  const targetPid = isOwner ? 'default' : generateProfileIdFromEmailClient(cleanEmail);
  const devId = getOrCreateDeviceIdClient();
  const nowIso = new Date().toISOString();

  const userProfile = {
    role: role,
    email: cleanEmail,
    name: rawName,
    contact: rawContact,
    deviceId: devId,
    authorizedAt: nowIso,
    authProvider: 'manual'
  };

  saveUserProfileClient(userProfile);
  try {
    localStorage.setItem(AUTH_DECISION_KEY, role);
    localStorage.setItem(PROFILE_ID_STORAGE_KEY, targetPid);
  } catch (e) {}

  closeUserProfileAuthModal();
  closeAuthGatewayModal();
  closeProfileModal();
  switchToProfileId(targetPid);
  showTransportNotice(`Profile authorized for ${rawName} (${isOwner ? 'Owner Root' : 'Member Workspace'}). Cloud sync active!`);

  if (typeof hasAppsScriptBridge === 'function' && hasAppsScriptBridge() && typeof google !== 'undefined' && google.script && google.script.run) {
    try {
      google.script.run.registerGoogleMemberAccountServer({
        email: cleanEmail,
        name: rawName,
        contact: rawContact,
        deviceId: devId
      });
    } catch (e) {}
    triggerManualSync();
  }
}

function checkAuthGatewayOnStartup() {
  if (isTestRunnerEnvironment()) return;
  try {
    const decision = localStorage.getItem(AUTH_DECISION_KEY);
    const prof = getUserProfileClient();
    if (!decision && !prof && !isOwnerAuthorizedClient()) {
      // Auto-provision guest workspace silently so UI is never blocked by a modal on startup
      handleGuestLogin();
    }
  } catch (e) {}
}

function copyTextWithFallback(text, noticeMsg) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showTransportNotice(noticeMsg);
      }).catch(() => {
        showTransportNotice(`${noticeMsg}: ${text}`);
      });
      return;
    }
  } catch (e) {}
  showTransportNotice(`${noticeMsg}: ${text}`);
}

function copyActiveProfileId() {
  const pid = getActiveProfileId();
  copyTextWithFallback(pid, `Copied Profile ID "${pid}"`);
}

function copyActiveProfileLink() {
  const pid = getActiveProfileId();
  const url = buildProfileShareUrl(pid);
  copyTextWithFallback(url, `Copied workspace URL for "${pid}"`);
}

function applyProfileSwitchFromInput() {
  const input = document.getElementById('profile-switch-input');
  const raw = input ? input.value : '';
  const clean = sanitizeProfileIdClient(raw);
  if (!clean) {
    showTransportNotice('Please enter a valid Profile ID.');
    return;
  }
  const identity = resolveUserIdentityAndScope();
  if (identity.role !== 'owner' && !isTestRunnerEnvironment()) {
    if (clean === 'default') {
      showTransportNotice("Unauthorized: Root profile 'default' is strictly restricted to the application Owner.");
      return;
    }
    if (clean !== identity.profileId) {
      showTransportNotice("Unauthorized: You cannot access or switch to another user's profile.");
      return;
    }
  }
  closeProfileModal();
  switchToProfileId(clean);
}

function createNewIsolatedProfile() {
  let freshDev = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i++) freshDev += ('0' + bytes[i].toString(16)).slice(-2);
  } else {
    freshDev = Math.random().toString(16).slice(2, 14);
  }
  try { localStorage.setItem(DEVICE_ID_STORAGE_KEY, freshDev); } catch (e) {}
  const freshPid = 'usr-dev-' + freshDev;
  const guestProf = {
    role: 'guest',
    email: '',
    name: 'Guest Visitor',
    contact: '',
    deviceId: freshDev,
    authorizedAt: new Date().toISOString()
  };
  saveUserProfileClient(guestProf);
  try {
    localStorage.setItem(AUTH_DECISION_KEY, 'guest');
    localStorage.setItem(PROFILE_ID_STORAGE_KEY, freshPid);
  } catch (e) {}
  closeProfileModal();
  switchToProfileId(freshPid);
  showTransportNotice(`Created clean isolated device profile "${freshPid}" (starting at 1000 SPI).`);
}

function handleUserSignOut() {
  closeProfileModal();
  closeUserProfileAuthModal();
  closeGoogleAccountPickerModal();

  try {
    localStorage.removeItem(AUTH_PROFILE_STORAGE_KEY);
    localStorage.removeItem('earlisthenic_last_google_account');
    localStorage.removeItem(AUTH_DECISION_KEY);
    localStorage.removeItem(LOCAL_CACHE_KEY);
    localStorage.removeItem(LEGACY_CLEAN_V1_KEY);
  } catch (e) {}

  let freshDev = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length; i++) freshDev += ('0' + bytes[i].toString(16)).slice(-2);
  } else {
    freshDev = Math.random().toString(16).slice(2, 14);
  }
  try { localStorage.setItem(DEVICE_ID_STORAGE_KEY, freshDev); } catch (e) {}
  const freshPid = 'usr-dev-' + freshDev;

  const guestProf = {
    role: 'guest',
    email: '',
    name: 'Guest Visitor',
    contact: '',
    deviceId: freshDev,
    authorizedAt: new Date().toISOString()
  };
  saveUserProfileClient(guestProf);
  try {
    localStorage.setItem(AUTH_DECISION_KEY, 'guest');
    localStorage.setItem(PROFILE_ID_STORAGE_KEY, freshPid);
  } catch (e) {}

  appState.serverIsOwner = false;
  appState.userRole = 'guest';

  switchToProfileId(freshPid);
  showTransportNotice('Signed out. You are now in Guest mode.');
  openAuthGatewayModal();
}

function switchToProfileId(targetProfileId) {
  const nextId = sanitizeProfileIdClient(targetProfileId) || 'default';
  const identity = resolveUserIdentityAndScope();

  if (identity.role !== 'owner' && !isTestRunnerEnvironment()) {
    if (nextId === 'default') {
      showTransportNotice("Unauthorized: Root profile 'default' is strictly restricted to the application Owner.");
      return;
    }
    if (nextId !== identity.profileId) {
      showTransportNotice("Unauthorized: You cannot access or switch to another user's profile.");
      return;
    }
  }

  if (nextId === getActiveProfileId() && appState._profileLoadToken > 0) {
    return;
  }
  // Persist current profile state to its own local cache slot before switching
  saveStateToLocalCache();
  if (typeof stopAudioPlayback === 'function' && appState.isPlaying) {
    stopAudioPlayback();
  }
  if (appState.demoModeActive && typeof toggleDemoMode === 'function') {
    toggleDemoMode(false);
  }

  appState.activeProfileId = nextId;
  try { localStorage.setItem(PROFILE_ID_STORAGE_KEY, nextId); } catch (e) {}

  // Reset in-memory state cleanly so no previous user's metrics leak during load
  appState.data = createCleanClientDataRoot();
  appState.settings = Object.assign({}, appState.data.settings);
  appState.weeklyMockPlans = appState.data.weeklyMockPlans;
  appState.pendingSync = {
    questionEvents: [],
    sessions: [],
    mockExams: [],
    behaviorEvents: []
  };
  appState.syncInFlight = false;
  appState.syncQueued = false;
  if (appState._syncRetryTimer) {
    clearTimeout(appState._syncRetryTimer);
    appState._syncRetryTimer = null;
  }

  updateProfileHeaderUI();
  loadProgressFromDriveForActiveProfile();
}

function initializePersistenceOnStartup() {
  getActiveProfileId();
  updateProfileHeaderUI();
  loadProgressFromDriveForActiveProfile();
}

function loadProgressFromDriveForActiveProfile() {
  const requestedProfileId = getActiveProfileId();
  const loadToken = ++appState._profileLoadToken;

  const loadedLocal = loadStateFromLocalCache();
  if (!loadedLocal) {
    saveStateToLocalCache();
  }
  renderLobbyGamesGrid();
  renderDailyWorkoutCircuit();
  renderEverydayKnowledge();
  renderDashboardStatsSummary();
  updateGlobalHeaderTrackingUI();
  if ((appState.currentView === 'dashboard' || appState.currentView === 'stats') && typeof renderSpiAnalyticsDashboard === 'function') {
    renderSpiAnalyticsDashboard();
  }
  if (appState.currentView === 'mock' && typeof renderMockTestBuilderView === 'function') renderMockTestBuilderView();

  if (!hasAppsScriptBridge()) {
    applyStartupSkippedDayDecay(null);
    setDriveSyncStatusUI('offline', 'Standalone Mode');
    return;
  }

  setDriveSyncStatusUI('saving', 'Loading Drive…');
  google.script.run
    .withSuccessHandler(res => {
      if (loadToken !== appState._profileLoadToken || requestedProfileId !== getActiveProfileId()) {
        return; // Ignore stale response after a profile switch
      }
      if (res && res.serverAuth && res.serverAuth.isOwner) {
        appState.serverIsOwner = true;
      }
      if (res && res.ok && res.data) {
        const remote = res.data;
        const remoteKnownEvents = new Set((remote.recentQuestionEvents || []).map(e => e && e.eventId).filter(Boolean));
        const remoteKnownBehaviors = new Set((remote.recentBehaviorEvents || []).map(e => e && e.behaviorId).filter(Boolean));
        const hasUnsyncedEvents = (appState.pendingSync.questionEvents || []).some(e => e && !remoteKnownEvents.has(e.eventId))
          || (appState.pendingSync.sessions || []).length > 0
          || (appState.pendingSync.mockExams || []).length > 0
          || (appState.pendingSync.behaviorEvents || []).some(e => e && !remoteKnownBehaviors.has(e.behaviorId));

        if (!hasUnsyncedEvents) {
          applyLoadedProgressDocument(remote);
        } else if (remote.app && remote.app.firstUseAt && (!appState.data.app.firstUseAt || remote.app.firstUseAt < appState.data.app.firstUseAt)) {
          // Preserve earlier Drive firstUseAt while keeping unsynced local deltas intact prior to flush
          appState.data.app.firstUseAt = remote.app.firstUseAt;
        }
        applyStartupSkippedDayDecay(remoteKnownBehaviors);
        saveStateToLocalCache();
        setDriveSyncStatusUI('saved', 'Saved to Drive');
        if (res.recalculated && res.recalculated.questionsRescored > 0) {
          console.log(`[Sync] Upgraded ${res.recalculated.questionsRescored} stored answers to Earlisthenic v4 Balanced Psychoacoustic scoring.`);
        }
        if (res.deploymentUrl) {
          appState._baseDeploymentUrl = String(res.deploymentUrl).split('?')[0];
          updateProfileHeaderUI();
        }
        if (Array.isArray(res.freeAudioTracks)) {
          applyFreeAudioTracksList(res.freeAudioTracks, false);
          startUndergroundMaterialsLoader();
        }
        syncAudioFormatControlsUI();
        renderLobbyGamesGrid();
        renderDailyWorkoutCircuit();
        renderEverydayKnowledge();
        renderDashboardStatsSummary();
        updateGlobalHeaderTrackingUI();
        if ((appState.currentView === 'dashboard' || appState.currentView === 'stats') && typeof renderSpiAnalyticsDashboard === 'function') {
          renderSpiAnalyticsDashboard();
        }
        if (appState.currentView === 'mock') renderMockTestBuilderView();

        // Flush any pending offline events
        if (
          appState.pendingSync.questionEvents.length > 0 ||
          appState.pendingSync.sessions.length > 0 ||
          appState.pendingSync.mockExams.length > 0 ||
          appState.pendingSync.behaviorEvents.length > 0
        ) {
          flushDriveSyncQueue();
        }
      }
    })
    .withFailureHandler(() => {
      if (loadToken !== appState._profileLoadToken || requestedProfileId !== getActiveProfileId()) {
        return;
      }
      applyStartupSkippedDayDecay(null);
      setDriveSyncStatusUI('error', 'Drive load failed');
    })
    .loadStudioProgressFromDrive(requestedProfileId);
}

function queueProgressSync(reason, immediate = false) {
  if (appState.demoModeActive) return;
  saveStateToLocalCache();

  const isDebouncedSetting = !immediate && (
    reason === 'toggle-sfx' ||
    reason === 'audio-format' ||
    reason === 'preferred-source'
  );

  if (isDebouncedSetting) {
    if (appState._syncDebounceTimer) clearTimeout(appState._syncDebounceTimer);
    appState._syncDebounceTimer = setTimeout(() => {
      appState._syncDebounceTimer = null;
      flushDriveSyncQueue();
    }, 1500);
    return;
  }

  // All session completions, mock tests, penalties, and explicit syncs flush immediately
  if (appState._syncDebounceTimer) {
    clearTimeout(appState._syncDebounceTimer);
    appState._syncDebounceTimer = null;
  }
  flushDriveSyncQueue();
}

function triggerManualSync() {
  if (appState._syncDebounceTimer) {
    clearTimeout(appState._syncDebounceTimer);
    appState._syncDebounceTimer = null;
  }
  flushDriveSyncQueue();
}

function flushDriveSyncQueue() {
  if (appState.demoModeActive) return;
  if (!hasAppsScriptBridge()) {
    setDriveSyncStatusUI('offline', 'Saved Locally');
    return;
  }
  if (appState.syncInFlight) {
    appState.syncQueued = true;
    return;
  }

  appState.syncInFlight = true;
  setDriveSyncStatusUI('saving', 'Saving…');

  const batchToSend = {
    settings: appState.settings,
    userProfile: (appState.data && appState.data.userProfile) || getUserProfileClient(),
    weeklyMockPlans: appState.weeklyMockPlans,
    dailyCompletedByDate: appState.data.dailyCompletedByDate,
    questionEvents: appState.pendingSync.questionEvents.slice(),
    sessions: appState.pendingSync.sessions.slice(),
    mockExams: appState.pendingSync.mockExams.slice(),
    behaviorEvents: appState.pendingSync.behaviorEvents.slice(),
    fullStateSnapshot: {
      scoringVersion: 8,
      score: appState.data.score,
      dailyStats: appState.data.dailyStats,
      gameStats: appState.data.gameStats
    }
  };

  const syncProfileId = getActiveProfileId();
  const sentQuestionIds = new Set(batchToSend.questionEvents.map(e => e.eventId));
  const sentSessionIds = new Set(batchToSend.sessions.map(s => s.sessionId));
  const sentExamIds = new Set(batchToSend.mockExams.map(m => m.examId));
  const sentBehaviorIds = new Set(batchToSend.behaviorEvents.map(b => b.behaviorId));

  google.script.run
    .withSuccessHandler(res => {
      if (syncProfileId !== getActiveProfileId()) return;
      appState.syncInFlight = false;
      if (res && res.ok) {
        appState.pendingSync.questionEvents = appState.pendingSync.questionEvents.filter(e => !sentQuestionIds.has(e.eventId));
        appState.pendingSync.sessions = appState.pendingSync.sessions.filter(s => !sentSessionIds.has(s.sessionId));
        appState.pendingSync.mockExams = appState.pendingSync.mockExams.filter(m => !sentExamIds.has(m.examId));
        appState.pendingSync.behaviorEvents = appState.pendingSync.behaviorEvents.filter(b => !sentBehaviorIds.has(b.behaviorId));
        appState.data.revision = res.revision || appState.data.revision;
        appState._syncRetryCount = 0;
        saveStateToLocalCache();
        setDriveSyncStatusUI('saved', 'Saved to Drive');
      } else {
        setDriveSyncStatusUI('error', 'Save failed');
      }
      if (appState.syncQueued) {
        appState.syncQueued = false;
        flushDriveSyncQueue();
      }
    })
    .withFailureHandler(() => {
      if (syncProfileId !== getActiveProfileId()) return;
      appState.syncInFlight = false;
      setDriveSyncStatusUI('error', 'Save failed');
      const hasRemaining = appState.syncQueued
        || (appState.pendingSync.questionEvents && appState.pendingSync.questionEvents.length > 0)
        || (appState.pendingSync.sessions && appState.pendingSync.sessions.length > 0)
        || (appState.pendingSync.mockExams && appState.pendingSync.mockExams.length > 0)
        || (appState.pendingSync.behaviorEvents && appState.pendingSync.behaviorEvents.length > 0);
      if (hasRemaining && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
        appState.syncQueued = false;
        const attempt = Math.min(3, appState._syncRetryCount || 0);
        appState._syncRetryCount = attempt + 1;
        const delayMs = 5000 * Math.pow(2, attempt);
        if (appState._syncRetryTimer) clearTimeout(appState._syncRetryTimer);
        appState._syncRetryTimer = setTimeout(() => {
          appState._syncRetryTimer = null;
          flushDriveSyncQueue();
        }, delayMs);
      }
    })
    .saveStudioProgressToDrive(batchToSend, syncProfileId);
}

function createDriveSnapshotBackup() {
  if (!hasAppsScriptBridge()) {
    exportProgressJson();
    showTransportNotice('Running in standalone mode: downloaded JSON backup snapshot to your computer.');
    return;
  }
  setDriveSyncStatusUI('saving', 'Creating snapshot…');
  google.script.run
    .withSuccessHandler(res => {
      setDriveSyncStatusUI('saved', 'Saved to Drive');
      if (res && res.ok && res.backup) {
        showTransportNotice(`Created Drive backup snapshot: ${res.backup.backupFileName}`);
      }
    })
    .withFailureHandler(err => {
      setDriveSyncStatusUI('error', 'Backup failed');
      showTransportNotice('Could not create Drive backup: ' + (err && err.message ? err.message : 'Unknown error'));
    })
    .createManualDriveBackup('user-manual', getActiveProfileId());
}

/********************************************************************
 * EXPORT / IMPORT & LEGACY MIGRATION FLOW
 ********************************************************************/
function exportProgressJson() {
  saveStateToLocalCache();
  const payload = JSON.stringify(appState.data, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `earlisthenic-backup-${getLocalDateKey(0)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function analyzeImportedObjectClient(rawObj) {
  const report = {
    isModernSchemaFormat: false,
    isLegacyPrototypeFormat: false,
    importableSummary: [],
    discardedSummary: [],
    warnings: []
  };

  if (!rawObj || typeof rawObj !== 'object') {
    report.warnings.push('Selected file does not contain a valid JSON object.');
    return report;
  }

  if (rawObj.schemaVersion === 1 && rawObj.app && rawObj.app.firstUseAt) {
    report.isModernSchemaFormat = true;
    report.importableSummary.push(`Schema v1 backup (First Use: ${rawObj.app.firstUseAt})`);
    report.importableSummary.push(`Current SPI: ${rawObj.score ? rawObj.score.currentSpi : 1000}`);
    report.importableSummary.push(`Recorded Days: ${Object.keys(rawObj.dailyStats || {}).length}`);
    report.importableSummary.push(`Mock Exams: ${(rawObj.mockExamHistory || []).length}`);
    return report;
  }

  report.isLegacyPrototypeFormat = true;
  if (rawObj.dailyGoalMinutes) {
    report.importableSummary.push(`Daily Practice Goal: ${rawObj.dailyGoalMinutes} min`);
  }
  if (rawObj.weeklyMockPlans) {
    report.importableSummary.push(`Custom 7-Day Weekly Mock Plans`);
  }
  if (rawObj.spiTotal === 1250) {
    report.discardedSummary.push('Seeded prototype SPI (1,250) and auto-seeded 7-day/14-day fabricated history');
  }
  if (rawObj.gameRecords) {
    report.discardedSummary.push('Seeded prototype high-score records without event timestamps');
  }
  report.warnings.push(
    'Legacy prototype data lacks verified event provenance. Only your custom settings and weekly mock plans will be merged into active totals; legacy logs will be archived as "legacy-unverified" and your real firstUseAt date will remain untouched.'
  );
  return report;
}

function handleImportJsonFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      appState.pendingMigrationObject = parsed;
      const report = analyzeImportedObjectClient(parsed);
      const bodyEl = document.getElementById('migration-modal-body');
      bodyEl.innerHTML = `
        <div class="p-3 rounded bg-[#F4F0E7] border border-[#D8CDBB]">
          <div class="font-bold text-[#302D28] mb-1">Format Detected: ${report.isModernSchemaFormat ? 'Earlisthenic Schema v1/v3' : 'Legacy Prototype State'}</div>
          ${report.importableSummary.length > 0 ? `<div class="text-[#5E6B50] mt-1"><strong>Importable:</strong> ${escapeHtml(report.importableSummary.join(' • '))}</div>` : ''}
          ${report.discardedSummary.length > 0 ? `<div class="text-[#A8463B] mt-1"><strong>Discarded (Fabricated/Seeded):</strong> ${escapeHtml(report.discardedSummary.join(' • '))}</div>` : ''}
          ${report.warnings.length > 0 ? `<div class="text-[#6E675B] mt-2">${escapeHtml(report.warnings.join(' '))}</div>` : ''}
        </div>
      `;
      document.getElementById('migration-preview-modal').classList.remove('hidden');
    } catch (err) {
      showTransportNotice('Invalid JSON file: could not parse backup.');
    }
    ev.target.value = '';
  };
  reader.readAsText(file);
}

function closeMigrationPreviewModal() {
  appState.pendingMigrationObject = null;
  document.getElementById('migration-preview-modal').classList.add('hidden');
}

function confirmPendingMigrationImport() {
  const rawObj = appState.pendingMigrationObject;
  closeMigrationPreviewModal();
  if (!rawObj) return;

  if (rawObj.schemaVersion === 1 && rawObj.app && rawObj.app.firstUseAt) {
    applyLoadedProgressDocument(rawObj);
  } else {
    // Controlled legacy migration: never overwrite firstUseAt or verified totals with fabricated seeds
    if (typeof rawObj.dailyGoalMinutes === 'number') {
      appState.settings.dailyGoalMinutes = rawObj.dailyGoalMinutes;
      appState.data.settings.dailyGoalMinutes = rawObj.dailyGoalMinutes;
    }
    if (rawObj.weeklyMockPlans && typeof rawObj.weeklyMockPlans === 'object') {
      appState.weeklyMockPlans = Object.assign(createDefaultWeeklyMockPlansClient(), rawObj.weeklyMockPlans);
      appState.data.weeklyMockPlans = appState.weeklyMockPlans;
    }
    appState.data.legacyImportMeta = {
      importedAt: new Date().toISOString(),
      provenanceStatus: 'legacy-unverified',
      archivedHistoryCount: Array.isArray(rawObj.historyLog) ? rawObj.historyLog.length : 0
    };
  }

  if (appState.demoModeActive) {
    toggleDemoMode(false);
  }
  saveStateToLocalCache();
  queueProgressSync('manual-import');
  sgAudioEngine.playUiCue('correct', appState.settings.uiSfxEnabled);
  updateGlobalHeaderTrackingUI();
  renderSpiAnalyticsDashboard();
  showTransportNotice('Import completed and verified.');
}

function triggerHistoryRecalculationFromUI() {
  if (appState.demoModeActive) {
    showTransportNotice('Exit Demo Mode first before recalculating live Drive scores.');
    return;
  }
  const isOwner = typeof isOwnerAuthorizedClient === 'function' ? isOwnerAuthorizedClient() : false;
  const isTest = typeof window !== 'undefined' && window.__isEarlisthenicTestRunner;
  if (!isOwner && !isTest) {
    showTransportNotice('Access Restricted: Historical score recalculation is reserved for the Root Master Administrator.');
    return;
  }
  const btn = document.getElementById('btn-recalc-history');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Recalculating…';
  }
  if (hasAppsScriptBridge()) {
    const recProfileId = getActiveProfileId();
    google.script.run
      .withSuccessHandler(res => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Recalculate Scores';
        }
        if (recProfileId !== getActiveProfileId()) return;
        if (res && res.ok && res.data) {
          applyLoadedProgressDocument(res.data);
          saveStateToLocalCache();
          renderLobbyGamesGrid();
          renderDailyWorkoutCircuit();
          renderEverydayKnowledge();
          renderDashboardStatsSummary();
          updateGlobalHeaderTrackingUI();
          if (appState.currentView === 'stats') renderSpiAnalyticsDashboard();
          const sum = res.summary || {};
          showTransportNotice(
            `Recalculated ${sum.questionsRescored || 0} stored questions across ${sum.sessionsProcessed || 0} sessions -> SPI ${(res.data.score && res.data.score.currentSpi) || 1000}.`
          );
        } else {
          showTransportNotice((res && res.error) || 'Failed to recalculate scores on Drive.');
        }
      })
      .withFailureHandler(err => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Recalculate Scores';
        }
        showTransportNotice((err && err.message) || 'Drive recalculation RPC failed.');
      })
      .recalculateDriveProgressFromHistory(recProfileId);
  } else {
    const rescored = rescoreRecentQuestionEventsClient();
    renderLobbyGamesGrid();
    renderDailyWorkoutCircuit();
    renderEverydayKnowledge();
    renderDashboardStatsSummary();
    updateGlobalHeaderTrackingUI();
    if (appState.currentView === 'stats' && typeof renderSpiAnalyticsDashboard === 'function') {
      renderSpiAnalyticsDashboard();
    }
    saveStateToLocalCache();
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Recalculate Scores';
    }
    showTransportNotice(`Recalculated ${rescored} questions in local cache to Psychoacoustic Scoring v6.`);
  }
}

/********************************************************************
 * TRANSPORT, AUDIO SOURCE SWITCHING & POINTER-EVENT WAVEFORM
 ********************************************************************/
let _transportNoticeTimer = null;
function showTransportNotice(msg, durationOrPersistent) {
  const bar = document.getElementById('transport-notice-bar');
  const txt = document.getElementById('transport-notice-text');
  if (!bar || !txt) return;
  txt.textContent = msg;
  bar.classList.remove('hidden');
  bar.classList.add('flex');
  if (_transportNoticeTimer) {
    clearTimeout(_transportNoticeTimer);
    _transportNoticeTimer = null;
  }
  const ms = typeof durationOrPersistent === 'number' ? durationOrPersistent : (durationOrPersistent === false ? 0 : 4000);
  if (ms > 0) {
    _transportNoticeTimer = setTimeout(() => {
      hideTransportNotice();
    }, ms);
  }
}

function hideTransportNotice() {
  if (_transportNoticeTimer) {
    clearTimeout(_transportNoticeTimer);
    _transportNoticeTimer = null;
  }
  const bar = document.getElementById('transport-notice-bar');
  if (!bar) return;
  bar.classList.add('hidden');
  bar.classList.remove('flex');
}

function handleStandaloneAppLink(ev) {
  if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  return false;
}

function switchAudioSourceMode(mode) {
  markUserTrainingInteraction();
  const validModes = ['studio', 'file'];
  const targetMode = validModes.includes(mode) ? mode : 'studio';

  validModes.forEach(m => {
    const btn = document.getElementById(`src-mode-${m}`);
    const panel = document.getElementById(`src-panel-${m}`);
    if (btn) {
      btn.className = m === targetMode
        ? 'h-full w-full px-2 rounded-md font-semibold border border-[#965438] bg-[#B56D4E] text-[#FBF8F1] flex items-center justify-center whitespace-nowrap transition-all'
        : 'h-full w-full px-2 rounded-md font-semibold border border-transparent text-[#302D28] hover:bg-[#EAE2D4] flex items-center justify-center whitespace-nowrap transition-all';
    }
    if (panel) {
      panel.classList.toggle('hidden', m !== targetMode);
      panel.classList.toggle('flex', m === targetMode);
    }
  });

  sgSourceManager.sourceMode = targetMode;
  appState.playbackOffsetSec = 0;

  if (targetMode === 'studio') {
    appState.loopStartRatio = 0.0;
    appState.loopEndRatio = 1.0;
    updateWaveformLoopUI();
    drawGlobalWaveform();
    if (appState.isPlaying) {
      startAudioPlayback();
    } else if (sgSourceManager.selectedDriveTrackId) {
      const selTrack = sgSourceManager.getSelectedDriveTrack();
      if (selTrack) scheduleDriveTrackPrefetch(selTrack);
    }
  } else if (targetMode === 'file') {
    if (appState._loadingDriveTrackId) {
      cancelPendingDriveTrackLoad();
    }
    if (sgSourceManager.customAudioBuffer) {
      updateWaveformLoopUI();
      drawGlobalWaveform();
      if (appState.isPlaying) startAudioPlayback();
    } else {
      stopAudioPlayback();
      updateTransportPlayUI();
    }
  }
}

function syncAudioFormatControlsUI() {
  const lbl = document.getElementById('lbl-format-status');
  const btn = document.getElementById('btn-resync-audio-clock');
  const status = (typeof sgAudioEngine !== 'undefined' && sgAudioEngine && typeof sgAudioEngine.getAudioFormatStatus === 'function')
    ? sgAudioEngine.getAudioFormatStatus()
    : { requestedSampleRate: 'auto', actualSampleRate: null, nativeOsSync: true, bitDepth: '64f' };

  const activeSr = (typeof sgAudioEngine !== 'undefined' && sgAudioEngine && sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.sampleRate)
    ? sgAudioEngine.audioCtx.sampleRate
    : (typeof status.actualSampleRate === 'number' ? status.actualSampleRate : null);

  if (lbl) {
    if (!activeSr) {
      lbl.textContent = 'OS/DAC: Auto · Max';
    } else {
      const srTxt = (activeSr % 1000 === 0) ? `${activeSr / 1000}k` : `${(activeSr / 1000).toFixed(1)}k`;
      lbl.textContent = `DAC ${srTxt} · Max (64f)`;
    }
  }
  if (btn) {
    btn.title = activeSr
      ? `Synced natively to OS/DAC clock: ${(activeSr / 1000).toFixed(1)} kHz | Max precision: 64-bit float FIR DSP -> max native 32-bit float Web Audio bus (hardware driver outputs max supported bit depth automatically). Click to re-sync.`
      : 'Web Audio locks directly to your Windows / Soundcard / DAC clock at maximum bit precision (64f DSP / max native OS bus).';
  }
}

function getCurrentPlaybackPositionSec(buf) {
  if (!appState.isPlaying || !sgAudioEngine || !sgAudioEngine.audioCtx) {
    return appState.playbackOffsetSec || 0;
  }
  const activeBuf = buf || (sgSourceManager ? sgSourceManager.getActiveBuffer() : null);
  const isDriveTrack = sgSourceManager && sgSourceManager.sourceMode === 'studio' && Boolean(sgSourceManager.selectedDriveTrackId);
  const driveWf = isDriveTrack ? sgSourceManager.getSelectedDriveWaveformMeta() : null;
  const dur = (driveWf && driveWf.durationSec) ? driveWf.durationSec : (activeBuf ? activeBuf.duration : 0);
  if (!dur) return 0;

  const now = sgAudioEngine.audioCtx.currentTime;
  const anchorTime = (typeof appState.playbackAnchorCtxTime === 'number') ? appState.playbackAnchorCtxTime : now;
  const anchorPos = (typeof appState.playbackAnchorPosSec === 'number') ? appState.playbackAnchorPosSec : (appState.playbackOffsetSec || 0);
  const lStart = (typeof appState.playbackAnchorLoopStartSec === 'number') ? appState.playbackAnchorLoopStartSec : ((appState.loopStartRatio || 0) * dur);
  const lEnd = (typeof appState.playbackAnchorLoopEndSec === 'number') ? appState.playbackAnchorLoopEndSec : (Math.max(lStart + 0.15, (appState.loopEndRatio || 1) * dur));
  const loopLen = Math.max(0.1, lEnd - lStart);

  const dt = Math.max(0, now - anchorTime);

  let curSec;
  if (anchorPos < lEnd) {
    const timeToLoopEnd = lEnd - anchorPos;
    if (dt < timeToLoopEnd) {
      curSec = anchorPos + dt;
    } else {
      const remainingDt = dt - timeToLoopEnd;
      curSec = lStart + (remainingDt % loopLen);
    }
  } else {
    curSec = lStart + (dt % loopLen);
  }

  return Math.max(0, Math.min(dur, curSec));
}

function captureCurrentPlayheadOffsetSec() {
  const pos = getCurrentPlaybackPositionSec();
  appState.playbackOffsetSec = pos;
  return pos;
}

async function resyncNativeAudioClockFromUI() {
  markUserTrainingInteraction();
  const wasPlaying = appState.isPlaying;
  if (wasPlaying) {
    captureCurrentPlayheadOffsetSec();
    appState.isPlaying = false;
  }

  appState.settings.audioSampleRate = 'auto';
  appState.settings.audioBitDepth = '64f';
  getActiveDataRoot().settings.audioSampleRate = 'auto';
  getActiveDataRoot().settings.audioBitDepth = '64f';

  const fmt = await sgAudioEngine.resyncNativeAudioClock();
  await sgSourceManager.redecodeForCurrentSampleRate();

  updateWaveformLoopUI();
  drawGlobalWaveform();
  syncAudioFormatControlsUI();

  const actSr = fmt.actualSampleRate || 48000;
  showTransportNotice(
    `Synced to OS / Soundcard clock: ${(actSr / 1000).toFixed(1)} kHz · Max Precision (64-bit float FIR / native 32-bit float bus).`
  );

  if (wasPlaying) {
    await startAudioPlayback();
  }
  queueProgressSync('audio-format');
}

const FREE_AUDIO_LOCAL_CACHE_KEY = 'earlisthenic_free_audio_tracks_v2';

function sanitizeTrackDisplayName(rawName) {
  if (!rawName) return '';
  return String(rawName)
    .replace(/\s*\(\d+(\.\d+)?\s*(MB|KB|GB|B)\)/i, '')
    .replace(/\.(flac|wav|mp3|ogg|m4a|aac|aif|aiff|alac|wma|opus|webm)$/i, '')
    .replace(/\s*\(\d+(\.\d+)?\s*(MB|KB|GB|B)\)/i, '')
    .trim();
}

function getPreloadedFreeAudioTracksClient() {
  if (Array.isArray(window.EARLISTHENIC_PRELOADED_TRACKS) && window.EARLISTHENIC_PRELOADED_TRACKS.length > 0) {
    return window.EARLISTHENIC_PRELOADED_TRACKS;
  }
  const bodyEl = document.body;
  if (bodyEl && bodyEl.dataset && bodyEl.dataset.preloadedTracksB64) {
    try {
      const b64 = bodyEl.dataset.preloadedTracksB64;
      if (b64) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const jsonStr = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed) && parsed.length > 0) {
          window.EARLISTHENIC_PRELOADED_TRACKS = parsed;
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Decode preloaded tracks failed:', e);
    }
  }
  try {
    const cachedRaw = localStorage.getItem(FREE_AUDIO_LOCAL_CACHE_KEY);
    if (cachedRaw) {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

function formatFileBytesHuman(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

function renderStudioSourceSelectOptions() {
  const sel = document.getElementById('studio-source-select');
  if (!sel) return;
  const tracks = Array.isArray(appState.freeAudioTracks) ? appState.freeAudioTracks : [];
  let html = '';

  if (tracks.length > 0) {
    html += '<optgroup label="FREE AUDIO (Shared Drive)">';
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t || !t.fileId) continue;
      const cleanName = sanitizeTrackDisplayName(t.name) || t.name;
      html += `<option value="drive:${escapeHtml(t.fileId)}">${escapeHtml(cleanName)}</option>`;
    }
    html += '</optgroup>';
  }

  html += '<optgroup label="Built-in Reference Fallback">';
  Object.keys(STUDIO_LOOP_CATALOG).forEach(k => {
    const item = STUDIO_LOOP_CATALOG[k];
    html += `<option value="${escapeHtml(k)}">${escapeHtml(item.title)}</option>`;
  });
  html += '</optgroup>';

  sel.innerHTML = html;

  const desiredValue = sgSourceManager.selectedDriveTrackId
    ? `drive:${sgSourceManager.selectedDriveTrackId}`
    : (sgSourceManager.studioLoopKey || 'drums');
  sel.value = desiredValue;
}

function applyFreeAudioTracksList(tracks, autoSelectDefault) {
  const list = Array.isArray(tracks) ? tracks.slice() : [];
  appState.freeAudioTracks = list;
  sgSourceManager.setDriveTracks(list);
  if (list.length > 0) {
    try {
      localStorage.setItem(FREE_AUDIO_LOCAL_CACHE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  // Preserve active user selection and never desynchronize currently playing audio
  const activeSelectedId = sgSourceManager.selectedDriveTrackId;
  const isPlaying = Boolean(appState.isPlaying || (typeof sgAudioEngine !== 'undefined' && sgAudioEngine && sgAudioEngine.isPlaying));

  if (activeSelectedId && list.some(t => t && t.fileId === activeSelectedId)) {
    // Keep active selected track intact
  } else if (!isPlaying) {
    const pref = String(appState.settings.preferredSource || '');
    if (pref.indexOf('drive:') === 0) {
      const prefId = pref.slice(6);
      if (list.some(t => t && t.fileId === prefId)) {
        sgSourceManager.selectedDriveTrackId = prefId;
      } else {
        sgSourceManager.selectedDriveTrackId = list.length > 0 ? list[0].fileId : '';
      }
    } else if (autoSelectDefault && list.length > 0 && (!pref || pref === 'drums')) {
      sgSourceManager.selectedDriveTrackId = list[0].fileId;
    } else if (list.length > 0 && !sgSourceManager.selectedDriveTrackId) {
      sgSourceManager.selectedDriveTrackId = list[0].fileId;
    }
  }

  renderStudioSourceSelectOptions();
  renderFreeAudioManagerList();

  if (sgSourceManager.sourceMode === 'studio' && sgSourceManager.selectedDriveTrackId) {
    updateWaveformLoopUI();
    drawGlobalWaveform();
  }

  if (autoSelectDefault && sgSourceManager.sourceMode === 'studio' && sgSourceManager.selectedDriveTrackId && !appState.isPlaying) {
    const initialTrack = sgSourceManager.getSelectedDriveTrack();
    if (initialTrack) scheduleDriveTrackPrefetch(initialTrack);
  }
}

function syncTrackWaveformToDriveServer(track, wfMeta) {
  if (!track || !track.fileId || !wfMeta || !hasAppsScriptBridge()) return;
  try {
    google.script.run.saveFreeAudioWaveformMeta(
      track.fileId,
      track.updatedAt || wfMeta.updatedAt || '',
      wfMeta.durationSec,
      wfMeta.mins,
      wfMeta.maxs,
      wfMeta.rms
    );
  } catch (e) {}
}

function scheduleDriveTrackPrefetch(track) {
  if (!track || !track.fileId || !hasAppsScriptBridge()) return;
  const sr = (sgAudioEngine && ((sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.sampleRate) || (typeof sgAudioEngine.actualSampleRate === 'number' && sgAudioEngine.actualSampleRate))) || 48000;
  if (sgSourceManager.driveDecodedCache.has(`${track.fileId}@${sr}`)) {
    scheduleFreeAudioLibraryPrewarm(track.fileId);
    return;
  }
  if (appState._loadingDriveTrackId === track.fileId) return;
  if (appState._prefetchTimerId) clearTimeout(appState._prefetchTimerId);
  appState._prefetchTimerId = setTimeout(() => {
    appState._prefetchTimerId = null;
    if (appState.isPlaying || appState._loadingDriveTrackId) return;
    if (!sgSourceManager || sgSourceManager.sourceMode !== 'studio' || sgSourceManager.selectedDriveTrackId !== track.fileId) return;
    const activeTrack = sgSourceManager.getSelectedDriveTrack();
    if (activeTrack && activeTrack.fileId === track.fileId) {
      loadDriveTrackAndMaybePlay(activeTrack, false);
    }
  }, 50);
}

let _undergroundLoaderRunning = false;
let _undergroundLoaderToken = 0;

function cancelUndergroundMaterialsLoader() {
  _undergroundLoaderToken++;
  _undergroundLoaderRunning = false;
  if (appState._prewarmTimerId) {
    clearTimeout(appState._prewarmTimerId);
    appState._prewarmTimerId = null;
  }
}

function cancelFreeAudioLibraryPrewarm() {
  cancelUndergroundMaterialsLoader();
}

function scheduleFreeAudioLibraryPrewarm(priorityFileId) {
  startUndergroundMaterialsLoader(priorityFileId);
}

let _undergroundPriorityId = null;

async function startUndergroundMaterialsLoader(priorityFileId) {
  if (priorityFileId) {
    _undergroundPriorityId = priorityFileId;
  }
  if (!hasAppsScriptBridge()) return;
  const tracks = Array.isArray(appState.freeAudioTracks) ? appState.freeAudioTracks : [];
  if (tracks.length === 0) return;

  if (_undergroundLoaderRunning) {
    if (priorityFileId) {
      _undergroundLoaderToken++;
    }
    return;
  }
  _undergroundLoaderRunning = true;
  const currentToken = ++_undergroundLoaderToken;

  try {
    const sr = (sgAudioEngine && ((sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.sampleRate) || (typeof sgAudioEngine.actualSampleRate === 'number' && sgAudioEngine.actualSampleRate))) || 48000;
    
    // Sort so priority/selected track is loaded first
    const activeId = _undergroundPriorityId || priorityFileId || sgSourceManager.selectedDriveTrackId || (tracks[0] && tracks[0].fileId);
    const sorted = tracks.slice().sort((a, b) => {
      if (a.fileId === activeId) return -1;
      if (b.fileId === activeId) return 1;
      return 0;
    });

    for (let i = 0; i < sorted.length; i++) {
      if (currentToken !== _undergroundLoaderToken) break;
      const track = sorted[i];
      if (!track || !track.fileId) continue;
      const cacheKey = `${track.fileId}@${sr}`;

      // Check if already in IndexedDB or memory (resilient to updatedAt variation)
      let isCachedLocally = false;
      try {
        const idbRec = await sgSourceManager._idbGetTrack(track.fileId);
        if (idbRec && (idbRec.updatedAt === track.updatedAt || (idbRec.arrayBuffer && idbRec.arrayBuffer.byteLength > 1024))) {
          isCachedLocally = true;
          sgSourceManager.driveRawCache.set(track.fileId, { updatedAt: track.updatedAt || idbRec.updatedAt, arrayBuffer: idbRec.arrayBuffer });
          if (idbRec.waveform) sgSourceManager.driveWaveformCache.set(track.fileId, idbRec.waveform);
        }
      } catch (e) {}

      // Pre-decode into RAM decoded cache immediately so Play response is < 1ms
      if (isCachedLocally && !sgSourceManager.driveDecodedCache.has(cacheKey) && (track.fileId === sgSourceManager.selectedDriveTrackId || track.fileId === priorityFileId)) {
        try {
          const rawRec = sgSourceManager.driveRawCache.get(track.fileId);
          if (rawRec && rawRec.arrayBuffer) {
            const ctx = sgAudioEngine.ensureContext();
            const decoded = await ctx.decodeAudioData(rawRec.arrayBuffer.slice(0));
            if (decoded) {
              sgSourceManager.driveDecodedCache.set(cacheKey, decoded);
              sgSourceManager._extractAndStoreWaveform(track, decoded, (trk, w) => syncTrackWaveformToDriveServer(trk, w));
              if (sgSourceManager.selectedDriveTrackId === track.fileId) {
                updateWaveformLoopUI();
                drawGlobalWaveform();
              }
            }
          }
        } catch (decErr) {}
      }

      // If already stored in IndexedDB and active track decoded, skip network download
      if (isCachedLocally) {
        continue;
      }

      // If user is actively streaming another track for immediate playback, wait
      while (appState._loadingDriveTrackId && appState._loadingDriveTrackId !== track.fileId) {
        if (currentToken !== _undergroundLoaderToken) break;
        await new Promise(r => setTimeout(r, 400));
      }
      if (currentToken !== _undergroundLoaderToken) break;

      try {
        // Download track raw bytes into IndexedDB via 2-worker chunk streamer
        const rawRecord = await sgSourceManager._downloadTrackRawArrayBuffer(
          track,
          fetchFreeAudioChunkPromise,
          null, // silent progress
          () => currentToken !== _undergroundLoaderToken || Boolean(appState._loadingDriveTrackId && appState._loadingDriveTrackId !== track.fileId)
        );

        if (currentToken !== _undergroundLoaderToken) break;

        if (rawRecord && rawRecord.arrayBuffer) {
          const shouldDecodeToRam = (track.fileId === sgSourceManager.selectedDriveTrackId || track.fileId === priorityFileId || sgSourceManager.driveDecodedCache.size < 3);
          if (shouldDecodeToRam) {
            const ctx = sgAudioEngine.ensureContext();
            const decoded = await ctx.decodeAudioData(rawRecord.arrayBuffer.slice(0));
            if (decoded) {
              sgSourceManager.driveDecodedCache.set(cacheKey, decoded);
              const wfMeta = sgSourceManager._extractAndStoreWaveform(track, decoded, (trk, w) => syncTrackWaveformToDriveServer(trk, w));
              if (sgSourceManager.selectedDriveTrackId === track.fileId) {
                updateWaveformLoopUI();
                drawGlobalWaveform();
              }
            }
          }
        }
      } catch (err) {
        // Continue quietly to next track
      }

      await new Promise(r => setTimeout(r, 100));
    }
  } finally {
    _undergroundLoaderRunning = false;
  }
}

function fetchFreeAudioChunkOncePromise(fileId, offsetBytes, chunkBytes) {
  return new Promise((resolve, reject) => {
    if (!hasAppsScriptBridge()) {
      reject(new Error('Google Drive streaming is only available in the deployed Web App.'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Drive chunk request timed out (25s).'));
    }, 25000);
    google.script.run
      .withSuccessHandler(res => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      })
      .withFailureHandler(err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err || new Error('Drive chunk RPC failed.'));
      })
      .getFreeAudioTrackChunk(fileId, offsetBytes, chunkBytes);
  });
}

async function fetchFreeAudioChunkPromise(fileId, offsetBytes, chunkBytes) {
  try {
    return await fetchFreeAudioChunkOncePromise(fileId, offsetBytes, chunkBytes);
  } catch (firstErr) {
    // Retry once on transient RPC / timeout glitches before failing loudly
    return await fetchFreeAudioChunkOncePromise(fileId, offsetBytes, chunkBytes);
  }
}

function cancelPendingDriveTrackLoad() {
  cancelFreeAudioLibraryPrewarm();
  if (appState._prefetchTimerId) {
    clearTimeout(appState._prefetchTimerId);
    appState._prefetchTimerId = null;
  }
  appState._driveTrackLoadToken++;
  appState._loadingDriveTrackId = '';
  appState._loadingDriveShouldPlay = false;
  updateTransportPlayUI();
}

async function loadDriveTrackAndMaybePlay(track, shouldPlay) {
  if (!track || !track.fileId) return null;
  cancelFreeAudioLibraryPrewarm();
  if (appState._prefetchTimerId) {
    clearTimeout(appState._prefetchTimerId);
    appState._prefetchTimerId = null;
  }

  const sr = (sgAudioEngine && ((sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.sampleRate) || sgAudioEngine.requestedSampleRate)) || 48000;
  const decodedKey = `${track.fileId}@${sr}`;

  // 1. FAST PATH (< 1ms): Already decoded in RAM
  const memDecoded = sgSourceManager.driveDecodedCache.get(decodedKey);
  if (memDecoded) {
    if (shouldPlay) {
      hideTransportNotice();
      appState._loadingDriveTrackId = '';
      appState._loadingDriveShouldPlay = false;
      appState.isPlaying = true;
      startDecodedActiveBufferPlayback(memDecoded, false);
      updateTransportPlayUI();
    }
    updateWaveformLoopUI();
    drawGlobalWaveform();
    return memDecoded;
  }

  // 2. FAST PATH (< 60ms): Stored in IndexedDB, decode immediately to RAM
  try {
    let raw = sgSourceManager.driveRawCache.get(track.fileId);
    if (!raw || !raw.arrayBuffer) {
      const idb = await sgSourceManager._idbGetTrack(track.fileId);
      if (idb && idb.arrayBuffer && idb.arrayBuffer.byteLength > 1024) {
        raw = { updatedAt: track.updatedAt || idb.updatedAt, arrayBuffer: idb.arrayBuffer };
        sgSourceManager.driveRawCache.set(track.fileId, raw);
        if (idb.waveform) sgSourceManager.driveWaveformCache.set(track.fileId, idb.waveform);
      }
    }
    if (raw && raw.arrayBuffer) {
      const ctx = sgAudioEngine.ensureContext();
      const decoded = await ctx.decodeAudioData(raw.arrayBuffer.slice(0));
      if (decoded) {
        sgSourceManager.driveDecodedCache.set(decodedKey, decoded);
        sgSourceManager._extractAndStoreWaveform(track, decoded, (trk, wf) => syncTrackWaveformToDriveServer(trk, wf));
        updateWaveformLoopUI();
        drawGlobalWaveform();
        if (shouldPlay) {
          hideTransportNotice();
          appState._loadingDriveTrackId = '';
          appState._loadingDriveShouldPlay = false;
          appState.isPlaying = true;
          startDecodedActiveBufferPlayback(decoded, false);
          updateTransportPlayUI();
        }
        return decoded;
      }
    }
  } catch (fastDecodeErr) {}

  if (appState._loadingDriveTrackId === track.fileId) {
    if (shouldPlay) {
      appState._loadingDriveShouldPlay = true;
      updateTransportPlayUI();
    }
    return null;
  }

  const loadToken = ++appState._driveTrackLoadToken;
  appState._loadingDriveTrackId = track.fileId;
  appState._loadingDriveShouldPlay = !!shouldPlay;
  updateTransportPlayUI();

  // Watchdog timer: 15s timeout protection against stalled background downloads
  let lastProgressTime = Date.now();
  const watchdogTimer = setInterval(() => {
    if (loadToken !== appState._driveTrackLoadToken) {
      clearInterval(watchdogTimer);
      return;
    }
    if (Date.now() - lastProgressTime > 15000) {
      clearInterval(watchdogTimer);
      if (appState._loadingDriveTrackId === track.fileId) {
        appState._loadingDriveTrackId = '';
        appState._loadingDriveShouldPlay = false;
        updateTransportPlayUI();
      }
    }
  }, 1000);

  // Render stored full-song waveform immediately before audio download completes
  updateWaveformLoopUI();
  drawGlobalWaveform();

  try {
    appState._driveLoadPercent = 0;
    const buf = await sgSourceManager.loadDriveAudioTrack(
      track,
      fetchFreeAudioChunkPromise,
      (loaded, total) => {
        lastProgressTime = Date.now();
        if (total > 0) {
          appState._driveLoadPercent = Math.min(99, Math.round((loaded / total) * 100));
        }
      },
      () => loadToken !== appState._driveTrackLoadToken,
      (trk, wfMeta) => syncTrackWaveformToDriveServer(trk, wfMeta)
    );
    clearInterval(watchdogTimer);
    if (loadToken !== appState._driveTrackLoadToken) return null;

    const playNow = Boolean(appState._loadingDriveShouldPlay);
    const wasPlaying = Boolean(appState.isPlaying);
    appState._loadingDriveTrackId = '';
    appState._loadingDriveShouldPlay = false;
    updateWaveformLoopUI();
    drawGlobalWaveform();
    if (playNow) {
      startDecodedActiveBufferPlayback(buf, false);
    } else if (wasPlaying) {
      startDecodedActiveBufferPlayback(buf, true);
    } else {
      updateTransportPlayUI();
    }
    scheduleFreeAudioLibraryPrewarm(track.fileId);
    return buf;
  } catch (err) {
    clearInterval(watchdogTimer);
    if (appState._loadingDriveTrackId === track.fileId && loadToken === appState._driveTrackLoadToken) {
      appState._loadingDriveTrackId = '';
      appState._loadingDriveShouldPlay = false;
      updateTransportPlayUI();
    }
    if (err && err.isAborted) return null;
    if (shouldPlay || appState._loadingDriveShouldPlay || appState.isPlaying) {
      showTransportNotice((err && err.message) || `Could not load "${track.name}" from FREE AUDIO. Continuing playback.`, false);
    }
    return null;
  }
}

function startDecodedActiveBufferPlayback(buf, useHotSwap) {
  if (!buf) return false;
  const isDriveTrack = sgSourceManager.sourceMode === 'studio' && Boolean(sgSourceManager.selectedDriveTrackId);
  const driveWf = isDriveTrack ? sgSourceManager.getSelectedDriveWaveformMeta() : null;
  const fullDur = (driveWf && driveWf.durationSec) ? driveWf.durationSec : buf.duration;

  const targetLoopStart = appState.loopStartRatio * fullDur;
  const targetLoopEnd = Math.max(targetLoopStart + 0.15, appState.loopEndRatio * fullDur);

  if (appState.playbackOffsetSec < targetLoopStart || appState.playbackOffsetSec > targetLoopEnd) {
    appState.playbackOffsetSec = targetLoopStart;
  }

  const effectiveLoopStart = Math.min(targetLoopStart, Math.max(0, buf.duration - 0.2));
  const effectiveLoopEnd = Math.max(effectiveLoopStart + 0.15, Math.min(buf.duration, targetLoopEnd));

  const startInfo = (useHotSwap && typeof sgAudioEngine.hotSwapBufferLoop === 'function')
    ? sgAudioEngine.hotSwapBufferLoop(buf, effectiveLoopStart, effectiveLoopEnd, appState.playbackOffsetSec)
    : sgAudioEngine.startBufferLoop(buf, effectiveLoopStart, effectiveLoopEnd, appState.playbackOffsetSec);

  if (startInfo) {
    const now = (sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.currentTime) || 0;
    appState.playbackStartedAtCtxTime = startInfo.startedAtContextTime - (startInfo.offsetSec - startInfo.loopStartSec);
    appState.playbackAnchorCtxTime = now;
    appState.playbackAnchorPosSec = startInfo.offsetSec;
    appState.playbackAnchorLoopStartSec = targetLoopStart;
    appState.playbackAnchorLoopEndSec = targetLoopEnd;
    appState.isPlaying = true;
    applyCurrentArenaDspToEngine();
    updateTransportPlayUI();
    syncAudioFormatControlsUI();
    return true;
  }
  return false;
}

function selectStudioLoop(loopKey) {
  markUserTrainingInteraction();
  const key = String(loopKey || 'drums');
  sgSourceManager.sourceMode = 'studio';
  appState.settings.preferredSource = key;
  appState.loopStartRatio = 0.0;
  appState.loopEndRatio = 1.0;
  appState.playbackOffsetSec = 0;

  if (key.indexOf('drive:') === 0) {
    const fileId = key.slice(6);
    const wasPlaying = Boolean(appState.isPlaying);
    sgSourceManager.selectedDriveTrackId = fileId;
    if (appState._loadingDriveTrackId && appState._loadingDriveTrackId !== fileId) {
      cancelPendingDriveTrackLoad();
    } else {
      cancelFreeAudioLibraryPrewarm();
    }
    const track = sgSourceManager.getSelectedDriveTrack();
    if (track) {
      const sr = (sgAudioEngine && ((sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.sampleRate) || (typeof sgAudioEngine.actualSampleRate === 'number' && sgAudioEngine.actualSampleRate))) || 48000;
      const cached = sgSourceManager.driveDecodedCache.get(`${fileId}@${sr}`);
      // Draw full-song waveform immediately from stored Drive/IndexedDB peak envelope
      updateWaveformLoopUI();
      drawGlobalWaveform();
      if (cached) {
        if (wasPlaying) startDecodedActiveBufferPlayback(cached, false);
        else scheduleFreeAudioLibraryPrewarm(fileId);
      } else if (wasPlaying) {
        // Continuous playback: keep current sound playing smoothly, hot-swap when new track is ready
        loadDriveTrackAndMaybePlay(track, true);
      } else {
        // Pre-decode from IDB in background so Play Audio is < 1ms
        loadDriveTrackAndMaybePlay(track, false);
      }
    }
  } else {
    cancelPendingDriveTrackLoad();
    sgSourceManager.selectedDriveTrackId = '';
    sgSourceManager.studioLoopKey = key;
    updateWaveformLoopUI();
    drawGlobalWaveform();
    if (appState.isPlaying) startAudioPlayback();
  }
  queueProgressSync('preferred-source');
}

function setFreeAudioManagerStatus(msg) {
  const el = document.getElementById('free-audio-manager-status');
  if (el) el.textContent = msg || '';
}

function openFreeAudioManagerModal() {
  if (getActiveProfileId() !== 'default') {
    showTransportNotice('Only the Master Profile (Owner / default) can manage FREE AUDIO files.');
    return;
  }
  appState._freeAudioRenameTargetId = '';
  renderFreeAudioManagerList();
  const modal = document.getElementById('free-audio-manager-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
  refreshFreeAudioTracksFromDrive(false);
}

function closeFreeAudioManagerModal() {
  appState._freeAudioRenameTargetId = '';
  const modal = document.getElementById('free-audio-manager-modal');
  if (modal) {
    modal.classList.remove('flex');
    modal.classList.add('hidden');
  }
}

function renderFreeAudioManagerList() {
  const container = document.getElementById('free-audio-manager-list');
  if (!container) return;
  const tracks = Array.isArray(appState.freeAudioTracks) ? appState.freeAudioTracks : [];
  if (tracks.length === 0) {
    container.innerHTML = '<div class="text-xs text-[#6E675B] p-4 bg-[#FBF8F1] border border-dashed border-[#D8CDBB] rounded-lg text-center">No audio files found in <code class="font-mono-tabular">My Drive/Earlisthenic/FREE AUDIO/</code>. Upload a track above or drop lossless files directly into the folder on Drive.</div>';
    return;
  }

  let html = '';
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || !t.fileId) continue;
    const isSelected = sgSourceManager.selectedDriveTrackId === t.fileId;
    const isRenaming = appState._freeAudioRenameTargetId === t.fileId;
    html += `<div class="p-3 rounded-lg border ${isSelected ? 'border-[#B56D4E] bg-[#FBF4EE]' : 'border-[#D8CDBB] bg-[#FBF8F1]'} flex flex-col gap-2">`;
    if (isRenaming) {
      html += `
        <div class="flex flex-wrap items-center gap-2">
          <input id="free-audio-rename-input-${escapeHtml(t.fileId)}" type="text" maxlength="140" value="${escapeHtml(t.name)}" class="flex-1 min-w-[180px] bg-white border border-[#B56D4E] rounded px-2.5 py-1 text-xs font-mono-tabular text-[#302D28]">
          <button type="button" onclick="confirmInlineRenameFreeAudio('${escapeHtml(t.fileId)}')" class="btn-terracotta px-3 py-1 rounded text-xs font-semibold">Save Name</button>
          <button type="button" onclick="cancelInlineRenameFreeAudio()" class="btn-outline-washi px-2.5 py-1 rounded text-xs font-semibold">Cancel</button>
        </div>`;
    } else {
      html += `
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-[#302D28] truncate" title="${escapeHtml(t.name)}">${escapeHtml(sanitizeTrackDisplayName(t.name) || t.name)}</div>
            <div class="text-[10px] font-mono-tabular text-[#6E675B]">${escapeHtml(formatFileBytesHuman(t.sizeBytes))} • ${escapeHtml((t.extension || '').replace('.', '').toUpperCase() || 'AUDIO')}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" onclick="playFreeAudioFromModal('${escapeHtml(t.fileId)}')" class="btn-moss px-2.5 py-1 rounded text-[11px] font-semibold">Play</button>
            <button type="button" onclick="startInlineRenameFreeAudio('${escapeHtml(t.fileId)}')" class="btn-outline-washi px-2.5 py-1 rounded text-[11px] font-semibold">Rename</button>
            <button type="button" onclick="deleteFreeAudioFromModal('${escapeHtml(t.fileId)}')" class="px-2.5 py-1 rounded text-[11px] font-semibold bg-[#F5E4E1] text-[#A8463B] hover:bg-[#EED2CD] border border-[#DFB9B3]">Delete</button>
          </div>
        </div>`;
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

function playFreeAudioFromModal(fileId) {
  closeFreeAudioManagerModal();
  switchAudioSourceMode('studio');
  const sel = document.getElementById('studio-source-select');
  if (sel) sel.value = `drive:${fileId}`;
  selectStudioLoop(`drive:${fileId}`);
  if (!appState.isPlaying) {
    startAudioPlayback();
  }
}

function startInlineRenameFreeAudio(fileId) {
  appState._freeAudioRenameTargetId = fileId;
  renderFreeAudioManagerList();
}

function cancelInlineRenameFreeAudio() {
  appState._freeAudioRenameTargetId = '';
  renderFreeAudioManagerList();
}

function confirmInlineRenameFreeAudio(fileId) {
  if (getActiveProfileId() !== 'default') return;
  const input = document.getElementById(`free-audio-rename-input-${fileId}`);
  const nextName = input ? input.value.trim() : '';
  if (!nextName) {
    setFreeAudioManagerStatus('Enter a valid filename.');
    return;
  }
  if (!hasAppsScriptBridge()) {
    setFreeAudioManagerStatus('Drive rename requires deployed Web App.');
    return;
  }
  setFreeAudioManagerStatus('Renaming…');
  google.script.run
    .withSuccessHandler(res => {
      if (res && res.ok) {
        appState._freeAudioRenameTargetId = '';
        applyFreeAudioTracksList(res.tracks || [], false);
        setFreeAudioManagerStatus(`Renamed to "${res.track ? res.track.name : nextName}".`);
      } else {
        setFreeAudioManagerStatus((res && res.error) || 'Rename failed.');
      }
    })
    .withFailureHandler(err => {
      setFreeAudioManagerStatus((err && err.message) || 'Rename RPC failed.');
    })
    .renameFreeAudioTrack(fileId, nextName, getActiveProfileId());
}

function deleteFreeAudioFromModal(fileId) {
  if (getActiveProfileId() !== 'default') return;
  if (!hasAppsScriptBridge()) {
    setFreeAudioManagerStatus('Drive delete requires deployed Web App.');
    return;
  }
  setFreeAudioManagerStatus('Deleting…');
  google.script.run
    .withSuccessHandler(res => {
      if (res && res.ok) {
        sgSourceManager.driveRawCache.delete(fileId);
        applyFreeAudioTracksList(res.tracks || [], false);
        setFreeAudioManagerStatus(`Deleted "${res.deletedName || 'track'}" cleanly.`);
      } else {
        setFreeAudioManagerStatus((res && res.error) || 'Delete failed.');
      }
    })
    .withFailureHandler(err => {
      setFreeAudioManagerStatus((err && err.message) || 'Delete RPC failed.');
    })
    .deleteFreeAudioTrack(fileId, getActiveProfileId());
}

function refreshFreeAudioTracksFromDrive(showDoneNotice) {
  if (!hasAppsScriptBridge()) {
    setFreeAudioManagerStatus('Offline standalone mode');
    return;
  }
  setFreeAudioManagerStatus('Scanning Drive folder…');
  google.script.run
    .withSuccessHandler(res => {
      if (res && res.ok) {
        applyFreeAudioTracksList(res.tracks || [], false);
        setFreeAudioManagerStatus(`${(res.tracks || []).length} track(s) in FREE AUDIO`);
        if (showDoneNotice) {
          showTransportNotice(`Refreshed FREE AUDIO: ${(res.tracks || []).length} track(s) available.`);
        }
      } else {
        setFreeAudioManagerStatus((res && res.error) || 'Failed to scan FREE AUDIO.');
      }
    })
    .withFailureHandler(err => {
      setFreeAudioManagerStatus((err && err.message) || 'Drive scan failed.');
    })
    .listFreeAudioTracks(true);
}

function uint8ToBase64Client(u8) {
  let bin = '';
  const block = 32768;
  for (let i = 0; i < u8.length; i += block) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + block)));
  }
  return btoa(bin);
}

function gasRpcPromise(fnName) {
  const args = Array.prototype.slice.call(arguments, 1);
  return new Promise((resolve, reject) => {
    const runner = google.script.run
      .withSuccessHandler(res => resolve(res))
      .withFailureHandler(err => reject(err || new Error(`${fnName} RPC failed.`)));
    runner[fnName].apply(runner, args);
  });
}

function readBlobSliceAsArrayBuffer(blobSlice) {
  if (typeof blobSlice.arrayBuffer === 'function') {
    return blobSlice.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve((ev && ev.target && ev.target.result) || reader.result);
    reader.onerror = () => reject(new Error('Failed to read file slice.'));
    reader.readAsArrayBuffer(blobSlice);
  });
}

const _freeAudioUploadInputEl = document.getElementById('free-audio-upload-input');
if (_freeAudioUploadInputEl) {
  _freeAudioUploadInputEl.addEventListener('change', async (ev) => {
    const file = ev.target && ev.target.files && ev.target.files[0];
    if (!file) return;
    ev.target.value = '';
    if (getActiveProfileId() !== 'default') {
      showTransportNotice('Only Master Profile (Owner / default) can upload to FREE AUDIO.');
      return;
    }
    if (file.size > 250 * 1024 * 1024) {
      setFreeAudioManagerStatus('File exceeds 250 MB upload cap.');
      return;
    }
    if (!hasAppsScriptBridge()) {
      setFreeAudioManagerStatus('Upload requires deployed Web App.');
      return;
    }

    const mime = file.type || 'audio/mpeg';
    const pid = getActiveProfileId();
    try {
      let finalRes = null;
      if (file.size <= 20 * 1024 * 1024) {
        setFreeAudioManagerStatus(`Uploading "${file.name}" (${formatFileBytesHuman(file.size)})…`);
        const rawBuf = await readBlobSliceAsArrayBuffer(file);
        const b64 = uint8ToBase64Client(new Uint8Array(rawBuf));
        finalRes = await gasRpcPromise('uploadFreeAudioTrack', file.name, mime, b64, pid);
      } else {
        // Chunked Drive Resumable Upload (4 MiB slices = multiple of 256 KiB required by Drive API)
        const CHUNK_SIZE = 4 * 1024 * 1024;
        setFreeAudioManagerStatus(`Initializing resumable upload for "${file.name}"…`);
        const initRes = await gasRpcPromise('startFreeAudioResumableUpload', file.name, mime, file.size, pid);
        if (!initRes || !initRes.ok) {
          throw new Error((initRes && initRes.error) || 'Could not start resumable upload.');
        }
        let offset = 0;
        while (offset < file.size) {
          const end = Math.min(file.size, offset + CHUNK_SIZE);
          const pct = Math.min(99, Math.round((offset / file.size) * 100));
          setFreeAudioManagerStatus(`Uploading "${file.name}": ${pct}% (${formatFileBytesHuman(offset)} / ${formatFileBytesHuman(file.size)})`);
          const sliceBuf = await readBlobSliceAsArrayBuffer(file.slice(offset, end));
          const chunkB64 = uint8ToBase64Client(new Uint8Array(sliceBuf));
          const stepRes = await gasRpcPromise(
            'appendFreeAudioUploadChunk',
            initRes.sessionToken,
            initRes.uploadUri || '',
            offset,
            file.size,
            chunkB64,
            pid
          );
          if (!stepRes || !stepRes.ok) {
            throw new Error((stepRes && stepRes.error) || 'Upload chunk failed.');
          }
          if (stepRes.complete) {
            finalRes = stepRes;
            break;
          }
          offset = end;
        }
      }

      if (finalRes && finalRes.ok) {
        if (finalRes.track && finalRes.track.fileId && file.size <= 120 * 1024 * 1024) {
          try {
            const ctx = sgAudioEngine.ensureContext();
            const fileArrBuf = await readBlobSliceAsArrayBuffer(file);
            const decodedUp = await ctx.decodeAudioData(fileArrBuf.slice(0));
            const wfMeta = EarlisthenicSourceManager.extractCompactWaveform(decodedUp, 128);
            if (wfMeta) {
              wfMeta.updatedAt = finalRes.track.updatedAt;
              finalRes.track.waveform = wfMeta;
              sgSourceManager.driveWaveformCache.set(finalRes.track.fileId, wfMeta);
              if (Array.isArray(finalRes.tracks)) {
                const match = finalRes.tracks.find(t => t && t.fileId === finalRes.track.fileId);
                if (match) match.waveform = wfMeta;
              }
              syncTrackWaveformToDriveServer(finalRes.track, wfMeta);
            }
          } catch (wfErr) {}
        }
        applyFreeAudioTracksList(finalRes.tracks || [], false);
        if (finalRes.track && finalRes.track.fileId) {
          selectStudioLoop(`drive:${finalRes.track.fileId}`);
          const sel = document.getElementById('studio-source-select');
          if (sel) sel.value = `drive:${finalRes.track.fileId}`;
        }
        setFreeAudioManagerStatus(`Uploaded "${file.name}"!`);
      } else {
        setFreeAudioManagerStatus((finalRes && finalRes.error) || 'Upload failed.');
      }
    } catch (err) {
      setFreeAudioManagerStatus((err && err.message) || 'Upload RPC failed.');
    }
  });
}

function initAudioFileInputHandler() {
  const fileInput = document.getElementById('audio-file-input');
  if (!fileInput || fileInput._changeHandlerAttached) return;
  fileInput._changeHandlerAttached = true;
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    markUserTrainingInteraction();

    const metaEl = document.getElementById('file-source-meta');
    if (metaEl) {
      metaEl.textContent = `Decoding "${file.name}"…`;
      metaEl.title = `Decoding ${file.name}`;
    }

    try {
      const meta = await sgSourceManager.loadLocalAudioFile(file);
      const chLabel = meta.numberOfChannels === 1 ? 'Mono' : `${meta.numberOfChannels}ch Stereo`;
      const fullMeta = `${meta.name} (${formatTimeMMSS(meta.durationSec)} • ${(meta.sampleRate / 1000).toFixed(1)} kHz • ${chLabel} • ${meta.sizeMb} MB)`;
      if (metaEl) {
        metaEl.textContent = `${meta.name} (${formatTimeMMSS(meta.durationSec)})`;
        metaEl.title = fullMeta;
      }
      const clearBtn = document.getElementById('btn-clear-local-file');
      if (clearBtn) {
        clearBtn.classList.remove('hidden');
        clearBtn.classList.add('inline-flex');
      }
      if (meta.warnings && meta.warnings.length > 0) {
        showTransportNotice(meta.warnings.join(' '));
      } else {
        hideTransportNotice();
      }
      appState.loopStartRatio = 0.0;
      appState.loopEndRatio = 1.0;
      updateWaveformLoopUI();
      drawGlobalWaveform();
      sgAudioEngine.playUiCue('correct', appState.settings.uiSfxEnabled);
      if (appState.isPlaying) startAudioPlayback();
    } catch (err) {
      if (metaEl) {
        metaEl.textContent = 'Decode failed';
        metaEl.title = 'Decode failed — choose WAV, MP3, FLAC, OGG, or M4A';
      }
      showTransportNotice(err && err.message ? err.message : 'Failed to decode audio file.');
    }
  });
}
try { initAudioFileInputHandler(); } catch (e) {}

function clearLoadedLocalFile() {
  sgSourceManager.clearLocalAudioFile();
  const input = document.getElementById('audio-file-input');
  if (input) input.value = '';
  const metaEl = document.getElementById('file-source-meta');
  if (metaEl) {
    metaEl.textContent = 'No file loaded';
    metaEl.title = 'Supported: WAV, MP3, FLAC, OGG, M4A';
  }
  const clearBtn = document.getElementById('btn-clear-local-file');
  if (clearBtn) {
    clearBtn.classList.add('hidden');
    clearBtn.classList.remove('inline-flex');
  }
  switchAudioSourceMode('studio');
}

function toggleAudioPlayback() {
  markUserTrainingInteraction();
  if (appState.isPlaying) {
    stopAudioPlayback();
  } else if (appState._loadingDriveTrackId && appState._loadingDriveShouldPlay) {
    cancelPendingDriveTrackLoad();
    hideTransportNotice();
  } else {
    startAudioPlayback();
  }
  updateTransportPlayUI();
}

function startAudioPlayback() {
  // Synchronize source manager with select dropdown value
  const srcSel = document.getElementById('studio-source-select');
  if (srcSel && srcSel.value && srcSel.value.indexOf('drive:') === 0) {
    const desiredId = srcSel.value.slice(6);
    if (desiredId && sgSourceManager.selectedDriveTrackId !== desiredId) {
      sgSourceManager.selectedDriveTrackId = desiredId;
      sgSourceManager.sourceMode = 'studio';
    }
  }

  // Unlock Web Audio synchronously within user click gesture before any async Drive fetch
  if (typeof sgAudioEngine !== 'undefined' && sgAudioEngine && typeof sgAudioEngine.ensureContext === 'function') {
    sgAudioEngine.ensureContext();
    applyCurrentArenaDspToEngine();
    syncAudioFormatControlsUI();
  }
  if (sgSourceManager.sourceMode === 'file' && !sgSourceManager.customAudioBuffer) {
    showTransportNotice('Please select a local audio file first, or switch to FREE AUDIO.');
    return;
  }

  if (sgSourceManager.sourceMode === 'studio' && sgSourceManager.selectedDriveTrackId) {
    const sr = (sgAudioEngine && sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.sampleRate) || 48000;
    const cacheKey = `${sgSourceManager.selectedDriveTrackId}@${sr}`;
    const cachedDriveBuf = sgSourceManager.driveDecodedCache.get(cacheKey);
    if (!cachedDriveBuf) {
      const track = sgSourceManager.getSelectedDriveTrack();
      if (track) {
        loadDriveTrackAndMaybePlay(track, true);
        return;
      }
    }
  }

  const buf = sgSourceManager.getActiveBuffer();
  if (!buf) return;

  startDecodedActiveBufferPlayback(buf);
}

function stopAudioPlayback() {
  if (appState._loadingDriveTrackId) {
    cancelPendingDriveTrackLoad();
  }
  if (appState.isPlaying) {
    captureCurrentPlayheadOffsetSec();
  }
  sgAudioEngine.disconnectActiveSources();
  appState.isPlaying = false;
  updateTransportPlayUI();
  const buf = sgSourceManager.getActiveBuffer();
  const isDriveTrack = sgSourceManager.sourceMode === 'studio' && Boolean(sgSourceManager.selectedDriveTrackId);
  const driveWf = isDriveTrack ? sgSourceManager.getSelectedDriveWaveformMeta() : null;
  const dur = (driveWf && driveWf.durationSec) ? driveWf.durationSec : (buf ? buf.duration : 4.0);
  if (typeof updatePlayheadUI === 'function') {
    updatePlayheadUI(appState.playbackOffsetSec, dur);
  }
  // Reset peak meters back to resting state
  const barL = document.getElementById('meter-bar-l');
  const barR = document.getElementById('meter-bar-r');
  const holdL = document.getElementById('meter-peak-hold-l');
  const holdR = document.getElementById('meter-peak-hold-r');
  if (barL) barL.style.width = '0%';
  if (barR) barR.style.width = '0%';
  if (holdL) holdL.style.left = '0%';
  if (holdR) holdR.style.left = '0%';
  _peakHoldL = -Infinity;
  _peakHoldR = -Infinity;
  _displayedPeakDb = -Infinity;
  _lastPeakDisplayTime = 0;
  const peakEl = document.getElementById('lbl-peak-db');
  if (peakEl) {
    peakEl.textContent = '-∞ dB';
    peakEl.className = 'w-[44px] text-center font-mono-tabular text-[10px] font-bold text-[#302D28] dark:text-[#EAE2D4] whitespace-nowrap leading-none';
  }
}

function updateTransportPlayUI() {
  const btn = document.getElementById('btn-global-play');
  const icon = document.getElementById('icon-global-play');
  const txt = document.getElementById('txt-global-play');
  if (!btn || !icon || !txt) return;

  if (appState.isPlaying) {
    btn.className = 'h-8 w-[124px] px-3 rounded-lg font-semibold text-xs uppercase tracking-wider inline-flex items-center justify-center gap-2 shrink-0 whitespace-nowrap bg-[#A8463B] text-[#FBF8F1] border border-[#87342B]';
    icon.className = 'fa-solid fa-stop text-[11px]';
    txt.textContent = 'Stop Audio';
  } else {
    btn.className = 'btn-moss h-8 w-[124px] px-3 rounded-lg font-semibold text-xs uppercase tracking-wider inline-flex items-center justify-center gap-2 shrink-0 whitespace-nowrap';
    icon.className = 'fa-solid fa-play text-[11px]';
    txt.textContent = 'Play Audio';
  }
}

function setInputTrimControl(val) {
  const db = parseFloat(val) || 0;
  document.getElementById('lbl-input-trim').textContent = `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
  sgAudioEngine.setInputTrimDb(db);
}

function setMasterVolume(val) {
  const pct = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
  document.getElementById('lbl-master-vol').textContent = `${pct}%`;
  appState.settings.masterVolumePct = pct;
  appState.settings.masterVolumeUserSet = true;
  if (appState.data && appState.data.settings) {
    appState.data.settings.masterVolumePct = pct;
    appState.data.settings.masterVolumeUserSet = true;
  }
  sgAudioEngine.setMasterVolumePct(pct);
}

let _peakHoldL = -Infinity;
let _peakHoldR = -Infinity;
let _peakHoldTimerL = 0;
let _peakHoldTimerR = 0;
let _smoothBarDbL = -60;
let _smoothBarDbR = -60;
let _lastMeterTimestamp = 0;
let _displayedPeakDb = -Infinity;
let _lastPeakDisplayTime = 0;
const PEAK_DISPLAY_HOLD_MS = 280;

function resetPeakClipIndicator() {
  if (typeof sgAudioEngine !== 'undefined' && sgAudioEngine && sgAudioEngine.resetClipIndicator) {
    sgAudioEngine.resetClipIndicator();
  }
  _peakHoldL = -Infinity;
  _peakHoldR = -Infinity;
  _peakHoldTimerL = 0;
  _peakHoldTimerR = 0;
  _smoothBarDbL = -60;
  _smoothBarDbR = -60;
  _lastMeterTimestamp = 0;
  _displayedPeakDb = -Infinity;
  _lastPeakDisplayTime = 0;
  const clipLed = document.getElementById('meter-clip-led');
  if (clipLed) {
    clipLed.className = 'w-1.5 h-1.5 rounded-full bg-[#D8CDBB] dark:bg-[#382624] border border-[#C5B8A5] dark:border-transparent shrink-0 transition-colors';
  }
  const peakEl = document.getElementById('lbl-peak-db');
  if (peakEl) {
    peakEl.textContent = '-∞ dB';
    peakEl.className = 'w-[44px] text-center font-mono-tabular text-[10px] font-bold text-[#302D28] dark:text-[#EAE2D4] whitespace-nowrap leading-none';
  }
  const badge = document.getElementById('peak-meter-badge');
  if (badge) {
    badge.className = 'h-9 w-[140px] shrink-0 px-2 rounded-xl bg-[#FBF8F1] dark:bg-[#141210] border border-black/[0.05] dark:border-white/[0.06] inline-flex items-center justify-between gap-1.5 shadow-xs cursor-pointer hover:border-[#B56D4E]/60 transition-colors select-none';
  }
}

function getMixerThresholdColor(db) {
  if (db >= -1.0) return '#E03E2D'; // Red - peak / near clipping threshold
  if (db >= -6.0) return '#D4AC64'; // Amber / Gold - caution / hot mix
  return '#4E9B3D'; // Studio Green - nominal safe level
}

function updateMixerPeakMeterUI(meter) {
  if (!meter) return;
  const now = performance.now();
  const dt = _lastMeterTimestamp > 0 ? Math.min(0.1, (now - _lastMeterTimestamp) / 1000) : 0.016;
  _lastMeterTimestamp = now;

  const rawDbL = isFinite(meter.peakDbL) ? meter.peakDbL : (isFinite(meter.peakDb) ? meter.peakDb : -60);
  const rawDbR = isFinite(meter.peakDbR) ? meter.peakDbR : (isFinite(meter.peakDb) ? meter.peakDb : -60);

  // IEC 60268-10 PPM Type II Ballistics:
  // 1. Attack: Instant (<10ms) integration capturing transient peaks immediately
  // 2. Fall-back: Smooth analog exponential-like release (~26 dB/s) to avoid optical jitter
  if (rawDbL >= _smoothBarDbL) {
    _smoothBarDbL = rawDbL;
  } else {
    _smoothBarDbL = Math.max(-60, _smoothBarDbL - 26.0 * dt);
  }

  if (rawDbR >= _smoothBarDbR) {
    _smoothBarDbR = rawDbR;
  } else {
    _smoothBarDbR = Math.max(-60, _smoothBarDbR - 26.0 * dt);
  }

  // Peak hold logic with 1200ms hold freeze, followed by smooth fallback (~13.3 dB/s IEC PPM)
  if (rawDbL >= _peakHoldL) {
    _peakHoldL = rawDbL;
    _peakHoldTimerL = now;
  } else if (now - _peakHoldTimerL > 1200) {
    _peakHoldL = Math.max(-60, _peakHoldL - 13.3 * dt);
  }

  if (rawDbR >= _peakHoldR) {
    _peakHoldR = rawDbR;
    _peakHoldTimerR = now;
  } else if (now - _peakHoldTimerR > 1200) {
    _peakHoldR = Math.max(-60, _peakHoldR - 13.3 * dt);
  }

  // -48 dBFS floor mapped to 0%, 0 dBFS mapped to 100%
  const pctL = Math.max(0, Math.min(100, ((_smoothBarDbL + 48) / 48) * 100));
  const pctR = Math.max(0, Math.min(100, ((_smoothBarDbR + 48) / 48) * 100));
  const pctHoldL = Math.max(0, Math.min(100, ((_peakHoldL + 48) / 48) * 100));
  const pctHoldR = Math.max(0, Math.min(100, ((_peakHoldR + 48) / 48) * 100));

  const barL = document.getElementById('meter-bar-l');
  const barR = document.getElementById('meter-bar-r');
  const holdL = document.getElementById('meter-peak-hold-l');
  const holdR = document.getElementById('meter-peak-hold-r');
  const clipLed = document.getElementById('meter-clip-led');
  const peakEl = document.getElementById('lbl-peak-db');

  if (barL) {
    barL.style.width = pctL.toFixed(1) + '%';
    barL.style.backgroundColor = getMixerThresholdColor(_smoothBarDbL);
  }
  if (barR) {
    barR.style.width = pctR.toFixed(1) + '%';
    barR.style.backgroundColor = getMixerThresholdColor(_smoothBarDbR);
  }
  if (holdL) holdL.style.left = pctHoldL.toFixed(1) + '%';
  if (holdR) holdR.style.left = pctHoldR.toFixed(1) + '%';

  if (clipLed) {
    clipLed.className = meter.clipped
      ? 'w-1.5 h-1.5 rounded-full bg-[#E03E2D] border-transparent shadow-[0_0_6px_#E03E2D] shrink-0 transition-colors'
      : 'w-1.5 h-1.5 rounded-full bg-[#D8CDBB] dark:bg-[#382624] border border-[#C5B8A5] dark:border-transparent shrink-0 transition-colors';
  }

  // Throttle numeric peak text for human eye readability (DAW peak-hold behavior)
  const currentPeak = isFinite(meter.peakDb) ? meter.peakDb : -Infinity;
  if (peakEl) {
    const isLouder = currentPeak > _displayedPeakDb;
    const holdExpired = (now - _lastPeakDisplayTime) > PEAK_DISPLAY_HOLD_MS;
    if (isLouder || holdExpired) {
      _displayedPeakDb = currentPeak;
      _lastPeakDisplayTime = now;
      const nextPeakTxt = (isFinite(_displayedPeakDb) && _displayedPeakDb > -60)
        ? `${_displayedPeakDb.toFixed(1)} dB`
        : '-∞ dB';
      if (peakEl.textContent !== nextPeakTxt) {
        peakEl.textContent = nextPeakTxt;
      }
    }
    const peakColor = (meter.clipped || currentPeak >= -1.0)
      ? 'text-[#E03E2D]'
      : (currentPeak >= -6.0 ? 'text-[#D4AC64]' : 'text-[#4E9B3D] dark:text-[#C0D0B5]');
    peakEl.className = `w-[44px] text-center font-mono-tabular text-[10px] font-bold ${peakColor} whitespace-nowrap leading-none transition-colors`;
  }
}

function toggleUiSfx() {
  appState.settings.uiSfxEnabled = !appState.settings.uiSfxEnabled;
  const icon = document.getElementById('icon-sfx-toggle');
  if (icon) {
    icon.className = appState.settings.uiSfxEnabled
      ? 'fa-solid fa-volume-low text-xs text-[#302D28]'
      : 'fa-solid fa-volume-xmark text-xs text-[#6E675B]';
  }
  if (appState.settings.uiSfxEnabled) {
    sgAudioEngine.playUiCue('click', true);
  }
  queueProgressSync('toggle-sfx');
}

/********************************************************************
 * VISUAL THEME ENGINE (Auto / Dark / Light)
 * Persisted in localStorage, updates document attribute and canvas renders
 ********************************************************************/
const SG_THEMES = ['auto', 'dark', 'light'];

function getThemeColor(varName, fallback) {
  try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
      const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      if (val) return val;
    }
  } catch (e) {}
  return fallback;
}
if (typeof window !== 'undefined') {
  window.getThemeColor = getThemeColor;
}

function getThemePreferenceClient() {
  try {
    const saved = localStorage.getItem('earlisthenic_theme');
    if (saved && SG_THEMES.includes(saved)) return saved;
  } catch (e) {}
  return 'auto';
}

function applyThemeClient(theme) {
  const chosen = SG_THEMES.includes(theme) ? theme : 'auto';
  try {
    localStorage.setItem('earlisthenic_theme', chosen);
  } catch (e) {}

  const systemIsDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = chosen === 'dark' || (chosen === 'auto' && systemIsDark);

  if (typeof document !== 'undefined' && document.documentElement) {
    if (chosen === 'auto') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', chosen);
    }
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  // Invalidate offscreen caches so grid and canvases refresh immediately
  arenaGridCacheKey = '';
  invalidateGraphicsCapabilityProfile();

  // Update theme toggle button UI
  const label = document.getElementById('label-theme-toggle');
  const icon = document.getElementById('icon-theme-toggle');
  if (label) {
    label.textContent = chosen === 'auto' ? 'Auto' : (chosen === 'dark' ? 'Dark' : 'Light');
  }
  if (icon) {
    if (chosen === 'dark') {
      icon.className = 'fa-solid fa-moon text-xs text-[#B56D4E]';
    } else if (chosen === 'light') {
      icon.className = 'fa-solid fa-sun text-xs text-[#B56D4E]';
    } else {
      icon.className = 'fa-solid fa-circle-half-stroke text-xs text-[#B56D4E]';
    }
  }

  // Redraw global waveform & active view charts if rendered
  try {
    if (typeof sgAudioEngine !== 'undefined' && sgAudioEngine.audioCtx) {
      drawGlobalWaveform();
    }
    if (typeof redrawAnalyticsChartsOnly === 'function') {
      redrawAnalyticsChartsOnly();
    } else if (appState && (appState.currentView === 'dashboard' || appState.currentView === 'stats' || appState.currentView === 'analytics') && typeof renderSpiAnalyticsDashboard === 'function') {
      renderSpiAnalyticsDashboard({ chartsOnly: true });
    }
  } catch (e) {}
}

function toggleThemeClient() {
  const current = getThemePreferenceClient();
  const nextIdx = (SG_THEMES.indexOf(current) + 1) % SG_THEMES.length;
  const nextTheme = SG_THEMES[nextIdx];
  applyThemeClient(nextTheme);
  try { drawGlobalWaveform(); } catch (e) {}
  if (appState && appState.settings && appState.settings.uiSfxEnabled && typeof sgAudioEngine !== 'undefined') {
    sgAudioEngine.playUiCue('click', true);
  }
}

if (typeof window !== 'undefined' && window.matchMedia) {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getThemePreferenceClient() === 'auto') {
        applyThemeClient('auto');
      }
    });
  } catch (e) {}
}

function getGpu2dContext(canvas, preferDesync = true) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  try {
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: Boolean(preferDesync)
    });
    if (ctx) return ctx;
  } catch (e) {}
  return canvas.getContext('2d');
}

let _cachedGraphicsProfile = null;
let _cachedGraphicsProfileKey = '';

function invalidateGraphicsCapabilityProfile() {
  _cachedGraphicsProfile = null;
  _cachedGraphicsProfileKey = '';
}

function detectGraphicsCapabilityProfile() {
  const rawDpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
  const width = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1280;
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
  const cacheKey = `${rawDpr}:${width}:${cores}`;
  if (_cachedGraphicsProfile && _cachedGraphicsProfileKey === cacheKey) {
    return _cachedGraphicsProfile;
  }
  const isMobile = width <= 640;
  const isTablet = width > 640 && width <= 1024;
  const maxDpr = cores >= 8 ? 2.5 : (isMobile ? 2.0 : 2.25);
  const dpr = Math.max(1, Math.min(rawDpr, maxDpr));
  const fftSize = (cores <= 2 && isMobile) ? 2048 : 4096;
  _cachedGraphicsProfileKey = cacheKey;
  _cachedGraphicsProfile = {
    dpr,
    isMobile,
    isTablet,
    cores,
    fftSize,
    spectrumStepPx: dpr >= 2 && cores <= 2 ? 2 : 1,
    tierLabel: cores >= 8 ? 'High-Perf GPU' : (isMobile ? 'Mobile Adaptive' : 'Standard HD')
  };
  return _cachedGraphicsProfile;
}

const waveformEnvelopeCache = new WeakMap();

function getOrComputeWaveformEnvelope(buf, numColumns) {
  if (!buf || typeof buf.getChannelData !== 'function') return null;
  const cols = Math.max(72, Math.min(640, Math.round(numColumns)));
  const cached = waveformEnvelopeCache.get(buf);
  if (cached && cached.cols === cols) {
    return cached;
  }
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const len = ch0.length;
  const minArr = new Float32Array(cols);
  const maxArr = new Float32Array(cols);
  const rmsArr = new Float32Array(cols);

  for (let i = 0; i < cols; i++) {
    const start = Math.floor((i * len) / cols);
    const end = Math.max(start + 1, Math.floor(((i + 1) * len) / cols));
    const span = end - start;
    const stride = Math.max(1, Math.floor(span / 24));
    let minV = 0;
    let maxV = 0;
    let sumSq = 0;
    let cnt = 0;
    for (let j = start; j < end; j += stride) {
      const s0 = ch0[j] || 0;
      const s = ch1 ? 0.5 * (s0 + (ch1[j] || 0)) : s0;
      if (s < minV) minV = s;
      if (s > maxV) maxV = s;
      sumSq += s * s;
      cnt++;
    }
    minArr[i] = minV;
    maxArr[i] = maxV;
    rmsArr[i] = cnt > 0 ? Math.sqrt(sumSq / cnt) : 0;
  }

  const cache = { cols, minArr, maxArr, rmsArr };
  waveformEnvelopeCache.set(buf, cache);
  return cache;
}

function drawGlobalWaveform() {
  const canvas = document.getElementById('global-waveform-canvas');
  if (!canvas || !canvas.parentElement) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(200, Math.round(rect.width || 360));
  const h = Math.max(24, Math.round(rect.height || 32));
  const profile = detectGraphicsCapabilityProfile();
  const dpr = profile.dpr;

  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = getGpu2dContext(canvas, false);
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = getThemeColor('--sg-surface', '#FBF8F1');
  ctx.fillRect(0, 0, w, h);

  // Subtle zero-crossing axis line
  ctx.fillStyle = getThemeColor('--sg-border', '#E4DCCD');
  ctx.fillRect(0, Math.floor(h * 0.5), w, 1);

  const buf = sgSourceManager.getActiveBuffer();
  const isDriveTrack = sgSourceManager.sourceMode === 'studio' && Boolean(sgSourceManager.selectedDriveTrackId);
  const driveWf = isDriveTrack ? sgSourceManager.getSelectedDriveWaveformMeta() : null;
  const wfMeta = driveWf || (!buf && sgSourceManager.sourceMode === 'studio' ? sgSourceManager.getSelectedDriveWaveformMeta() : null);
  if (!buf && !wfMeta) return;

  const cols = Math.max(96, Math.min(w, 560));
  let env = null;
  if (driveWf && Array.isArray(driveWf.mins) && driveWf.mins.length > 0) {
    const srcLen = driveWf.mins.length;
    const minArr = new Float32Array(cols);
    const maxArr = new Float32Array(cols);
    const rmsArr = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      const srcPos = (i / Math.max(1, cols - 1)) * Math.max(0, srcLen - 1);
      const lo = Math.floor(srcPos);
      const hi = Math.min(srcLen - 1, lo + 1);
      const frac = srcPos - lo;
      minArr[i] = ((driveWf.mins[lo] * (1 - frac)) + (driveWf.mins[hi] * frac)) / 1000;
      maxArr[i] = ((driveWf.maxs[lo] * (1 - frac)) + (driveWf.maxs[hi] * frac)) / 1000;
      rmsArr[i] = ((driveWf.rms[lo] * (1 - frac)) + (driveWf.rms[hi] * frac)) / 1000;
    }
    env = { minArr, maxArr, rmsArr };
  } else if (buf) {
    env = getOrComputeWaveformEnvelope(buf, cols);
  }
  if (!env) return;

  const midY = h * 0.5;
  const ampScale = h * 0.44;
  const colW = w / cols;
  const drawW = Math.max(1, colW - 0.35);

  for (let i = 0; i < cols; i++) {
    const ratio = i / cols;
    const x = i * colW;
    const insideLoop = ratio >= appState.loopStartRatio && ratio <= appState.loopEndRatio;
    const topPx = Math.max(1, env.maxArr[i] * ampScale);
    const botPx = Math.max(1, -env.minArr[i] * ampScale);
    const rmsPx = Math.max(0.8, env.rmsArr[i] * ampScale * 1.25);

    ctx.fillStyle = insideLoop ? 'rgba(181, 109, 78, 0.40)' : 'rgba(142, 133, 118, 0.32)';
    ctx.fillRect(x, midY - topPx, drawW, topPx + botPx);

    ctx.fillStyle = insideLoop ? getThemeColor('--sg-terracotta', '#B56D4E') : getThemeColor('--sg-muted', '#AFA088');
    ctx.fillRect(x, midY - rmsPx, drawW, rmsPx * 2);
  }
}

function updatePlayheadUI(curSec, dur) {
  const phEl = document.getElementById('wf-playhead');
  const curTimeEl = document.getElementById('wf-time-cur');
  if (dur > 0) {
    const pct = Math.max(0, Math.min(100, (curSec / dur) * 100));
    if (phEl) phEl.style.left = pct.toFixed(2) + '%';
  }
  if (curTimeEl) curTimeEl.textContent = formatTimeMMSS(curSec);
}

function updateWaveformLoopUI() {
  const buf = sgSourceManager.getActiveBuffer();
  const isDriveTrack = sgSourceManager.sourceMode === 'studio' && Boolean(sgSourceManager.selectedDriveTrackId);
  const driveWf = isDriveTrack ? sgSourceManager.getSelectedDriveWaveformMeta() : null;
  const dur = (driveWf && driveWf.durationSec) ? driveWf.durationSec : (buf ? buf.duration : 4.0);
  const newStartSec = appState.loopStartRatio * dur;
  const newEndSec = Math.max(newStartSec + 0.15, appState.loopEndRatio * dur);

  const durEl = document.getElementById('wf-time-dur');
  if (durEl) durEl.textContent = (!buf && !driveWf && sgSourceManager.selectedDriveTrackId) ? '--:--' : formatTimeMMSS(dur);

  const leftPct = (appState.loopStartRatio * 100).toFixed(1) + '%';
  const widthPct = ((appState.loopEndRatio - appState.loopStartRatio) * 100).toFixed(1) + '%';
  const rightPct = ((1 - appState.loopEndRatio) * 100).toFixed(1) + '%';

  const hlEl = document.getElementById('wf-loop-highlight');
  const hsEl = document.getElementById('wf-handle-start');
  const heEl = document.getElementById('wf-handle-end');
  if (hlEl) { hlEl.style.left = leftPct; hlEl.style.width = widthPct; }
  if (hsEl) hsEl.style.left = leftPct;
  if (heEl) heEl.style.right = rightPct;

  if (appState.isPlaying && sgAudioEngine.audioCtx) {
    // 1. Capture current playback position BEFORE updating loop bounds
    const curPos = getCurrentPlaybackPositionSec(buf);

    // 2. Update loop points on Web Audio source with dynamic boundary fade rescheduling
    sgAudioEngine.updateActiveLoopBounds(newStartSec, newEndSec, curPos);

    // 3. Smoothly re-anchor at current position with new loop bounds (prevents playhead jumps)
    const now = sgAudioEngine.audioCtx.currentTime;
    appState.playbackAnchorCtxTime = now;
    if (curPos > newEndSec) {
      appState.playbackAnchorPosSec = newStartSec;
      appState.playbackOffsetSec = newStartSec;
      startAudioPlayback();
    } else {
      appState.playbackAnchorPosSec = curPos;
      appState.playbackOffsetSec = curPos;
    }
    appState.playbackAnchorLoopStartSec = newStartSec;
    appState.playbackAnchorLoopEndSec = newEndSec;
  } else {
    // When paused, do NOT drag the playhead along with loop in/out handles!
    // Keep playbackOffsetSec where it is so the playhead stays fixed while dragging brackets.
    updatePlayheadUI(appState.playbackOffsetSec, dur);
  }
}

// Pointer Events for Waveform Seeking & Loop Handles (Touch, Pen, Mouse)
(function bindWaveformPointerEvents() {
  const wfBox = document.getElementById('waveform-loop-box');
  const hStart = document.getElementById('wf-handle-start');
  const hEnd = document.getElementById('wf-handle-end');
  if (!wfBox || !hStart || !hEnd) return;

  hStart.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    appState.draggingHandle = 'start';
    wfBox.setPointerCapture(e.pointerId);
  });

  hEnd.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    appState.draggingHandle = 'end';
    wfBox.setPointerCapture(e.pointerId);
  });

  wfBox.addEventListener('pointerdown', (e) => {
    const rect = wfBox.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    if (Math.abs(ratio - appState.loopStartRatio) < 0.035) {
      appState.draggingHandle = 'start';
      wfBox.setPointerCapture(e.pointerId);
    } else if (Math.abs(ratio - appState.loopEndRatio) < 0.035) {
      appState.draggingHandle = 'end';
      wfBox.setPointerCapture(e.pointerId);
    } else {
      const buf = sgSourceManager.getActiveBuffer();
      const isDriveTrack = sgSourceManager.sourceMode === 'studio' && Boolean(sgSourceManager.selectedDriveTrackId);
      const driveWf = isDriveTrack ? sgSourceManager.getSelectedDriveWaveformMeta() : null;
      const dur = (driveWf && driveWf.durationSec) ? driveWf.durationSec : (buf ? buf.duration : 4.0);
      const clampedRatio = Math.max(appState.loopStartRatio, Math.min(appState.loopEndRatio - 0.01, ratio));
      appState.playbackOffsetSec = clampedRatio * dur;
      if (appState.isPlaying) {
        startAudioPlayback();
      } else {
        updatePlayheadUI(appState.playbackOffsetSec, dur);
      }
    }
  });

  wfBox.addEventListener('pointermove', (e) => {
    if (!appState.draggingHandle) return;
    const rect = wfBox.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    if (appState.draggingHandle === 'start') {
      appState.loopStartRatio = Math.max(0, Math.min(ratio, appState.loopEndRatio - 0.06));
    } else if (appState.draggingHandle === 'end') {
      appState.loopEndRatio = Math.min(1, Math.max(ratio, appState.loopStartRatio + 0.06));
    }
    updateWaveformLoopUI();
    drawGlobalWaveform();
  });

  const releaseDrag = (e) => {
    if (appState.draggingHandle) {
      appState.draggingHandle = null;
      try { wfBox.releasePointerCapture(e.pointerId); } catch (err) {}
    }
  };
  wfBox.addEventListener('pointerup', releaseDrag);
  wfBox.addEventListener('pointercancel', releaseDrag);
})();

/********************************************************************
 * VIEW NAVIGATION & LOBBY RENDERING
 ********************************************************************/
function switchMainView(view) {
  const validViews = ['lobby', 'arena', 'mock', 'about'];
  const target = (view === 'stats') ? 'lobby' : view;
  const nextView = validViews.includes(target) ? target : 'lobby';

  if (appState.currentView === 'arena' && nextView !== 'arena') {
    if (appState.mockExamActive && !appState.mockExamFinished && typeof abortMockTestExam === 'function') {
      abortMockTestExam();
      return;
    }
    stopCheetah60sBlitz();
    const leaveReason = (nextView === 'lobby' || nextView === 'mock' || nextView === 'about') ? `left-to-${nextView}` : 'view-switch';
    endActivePracticeSession(leaveReason, false);
  }

  appState.currentView = nextView;

  validViews.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    const btn = document.getElementById(`nav-btn-${v}`);
    if (!el || !btn) return;
    if (v === nextView) {
      el.classList.remove('hidden');
      if (v === 'arena' || v === 'about') el.classList.add('flex');
      btn.className = 'h-9 px-3.5 sm:px-4 rounded-md text-xs font-semibold border border-[#965438] bg-[#B56D4E] text-[#FBF8F1] flex items-center justify-center whitespace-nowrap transition-all shadow-xs';
    } else {
      el.classList.add('hidden');
      if (v === 'arena' || v === 'about') el.classList.remove('flex');
      btn.className = 'h-9 px-3.5 sm:px-4 rounded-md text-xs font-semibold border border-transparent text-[#6E675B] dark:text-[#EAE2D4] hover:bg-[#FBF8F1]/60 dark:hover:bg-[#201D19] flex items-center justify-center whitespace-nowrap transition-all';
    }
  });

  if (nextView === 'lobby') {
    renderDailyWorkoutCircuit();
    renderEverydayKnowledge();
    renderDashboardStatsSummary();
    if (typeof renderSpiAnalyticsDashboard === 'function') {
      renderSpiAnalyticsDashboard();
    }
  } else if (nextView === 'arena') {
    const libSection = document.getElementById('arena-exercise-library');
    const deckSection = document.getElementById('arena-interactive-deck');
    const shouldShowDeck = Boolean(appState.mockExamActive || appState.arenaDeckVisible);
    if (shouldShowDeck) {
      if (libSection) libSection.classList.add('hidden');
      if (deckSection) deckSection.classList.remove('hidden');
      startOrResumePracticeSession(appState.gameMode, appState.mockExamActive ? 'mock' : 'practice');
      initArenaCanvasInteraction();
      setTimeout(() => resizeArenaCanvas(), 20);
    } else {
      if (libSection) libSection.classList.remove('hidden');
      if (deckSection) deckSection.classList.add('hidden');
      renderLobbyGamesGrid();
    }
  } else if (nextView === 'mock') {
    renderMockTestBuilderView();
  } else if (nextView === 'about') {
    initAboutAccordion();
  } else if (nextView === 'stats') {
    renderSpiAnalyticsDashboard();
  }

  if (nextView !== 'arena' && typeof sgAudioEngine !== 'undefined' && sgAudioEngine.audioCtx) {
    applyCurrentArenaDspToEngine();
  }
}

function initAboutAccordion() {
  if (typeof document === 'undefined') return;
  const container = document.getElementById('view-about');
  if (!container || typeof container.querySelectorAll !== 'function') return;
  const cards = container.querySelectorAll('.about-card');
  if (!cards || !cards.length) return;

  const getCardHeader = (targetCard) => {
    const num = (targetCard.id && targetCard.id.match(/\d+/)) ? targetCard.id.match(/\d+/)[0] : '';
    return (num && document.getElementById(`about-card-header-${num}`)) || (targetCard.querySelector ? targetCard.querySelector('.about-card-header') : null);
  };

  const getCardBar = (targetCard) => {
    const num = (targetCard.id && targetCard.id.match(/\d+/)) ? targetCard.id.match(/\d+/)[0] : '';
    return (num && document.getElementById(`about-card-bar-${num}`)) || (targetCard.querySelector ? targetCard.querySelector('.about-card-loading-bar') : null);
  };

  const openCard = (targetCard) => {
    if (!targetCard) return;
    if (!targetCard.dataset) targetCard.dataset = {};
    targetCard.classList.add('is-open');
    const h = getCardHeader(targetCard);
    if (h && typeof h.setAttribute === 'function') h.setAttribute('aria-expanded', 'true');
    const b = getCardBar(targetCard);
    if (b && b.style) {
      b.style.transition = 'width 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
      b.style.width = '100%';
    }
    // Anti-drift architectural invariant: Never auto-collapse any other card on open!
    // Keeping previously opened cards open guarantees zero vertical layout shifting,
    // ensuring the mouse cursor stays perfectly stationary over the card being viewed.
  };

  const closeCard = (targetCard) => {
    if (!targetCard) return;
    if (!targetCard.dataset) targetCard.dataset = {};
    targetCard.classList.remove('is-open');
    const h = getCardHeader(targetCard);
    if (h && typeof h.setAttribute === 'function') h.setAttribute('aria-expanded', 'false');
    const b = getCardBar(targetCard);
    if (b && b.style) {
      b.style.transition = 'width 0.22s ease-out';
      b.style.width = '0%';
    }
  };

  // Global scroll dampening: pause hover auto-expansion while user is actively scrolling
  let isScrolling = false;
  let scrollTimeout = null;
  if (typeof window !== 'undefined' && !window._aboutScrollBound) {
    window._aboutScrollBound = true;
    window.addEventListener('scroll', () => {
      isScrolling = true;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        isScrolling = false;
      }, 140);
    }, { passive: true });
  }

  // Quick action buttons: Expand All & Collapse All
  const expandAllBtn = document.getElementById('btn-about-expand-all');
  if (expandAllBtn && !expandAllBtn._bound) {
    expandAllBtn._bound = true;
    expandAllBtn.addEventListener('click', () => {
      cards.forEach(c => openCard(c));
    });
  }
  const collapseAllBtn = document.getElementById('btn-about-collapse-all');
  if (collapseAllBtn && !collapseAllBtn._bound) {
    collapseAllBtn._bound = true;
    collapseAllBtn.addEventListener('click', () => {
      cards.forEach(c => closeCard(c));
    });
  }

  cards.forEach(card => {
    if (!card.dataset) card.dataset = {};
    if (card._aboutAccordionInitialized) return;
    card._aboutAccordionInitialized = true;

    const bar = getCardBar(card);
    const header = getCardHeader(card);
    let hoverTimer = null;

    // Hover Enter: gradient beam sweeps from left to right across card.
    // When sweep reaches 100% (after 380ms), the card smoothly unfolds downward.
    card.addEventListener('mouseenter', () => {
      if (isScrolling) return;
      if (card.classList.contains('is-open')) {
        if (bar && bar.style) bar.style.width = '100%';
        return;
      }
      if (bar && bar.style) {
        bar.style.transition = 'width 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
        bar.style.width = '100%';
      }
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!isScrolling) {
          openCard(card);
        }
      }, 380);
    });

    // Hover Leave: if card did not open yet (e.g. mouse just swept past), retract bar smoothly.
    // If card IS ALREADY OPEN, do NOT collapse it to ensure rock-solid stability and zero jump.
    card.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      if (!card.classList.contains('is-open')) {
        if (bar && bar.style) {
          bar.style.transition = 'width 0.2s ease-out';
          bar.style.width = '0%';
        }
      }
    });

    // Click Header: toggle open/closed for instant manual user control
    if (header && typeof header.addEventListener === 'function') {
      header.addEventListener('click', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        clearTimeout(hoverTimer);
        if (card.classList.contains('is-open')) {
          closeCard(card);
        } else {
          openCard(card);
        }
      });
    }
  });
}

function renderDailyWorkoutCircuit() {
  const container = document.getElementById('daily-circuit-cards');
  if (!container) return;

  const dateDisplay = document.getElementById('lobby-date-display');
  if (dateDisplay) {
    dateDisplay.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  }

  const circuitMap = getTodayCircuitCompletionMap();
  const dailyKeys = ['peak', 'bass', 'feedback'];
  let doneCount = 0;

  container.innerHTML = dailyKeys.map(key => {
    const g = SG_GAMES[key];
    const isDone = Boolean(circuitMap[key]);
    if (isDone) doneCount++;
    return `
      <button type="button" onclick="launchGameFromLobby('${key}')" class="p-3.5 rounded-xl border border-black/[0.04] dark:border-white/[0.05] text-left transition-all flex flex-col justify-between shadow-xs hover:shadow-md hover:-translate-y-0.5 ${
        isDone ? 'bg-[#E6ECE0] dark:bg-[#1D2A19]' : 'bg-[#FBF8F1] dark:bg-[#201D19] hover:border-[#B56D4E]'
      }">
        <div class="flex items-center justify-between w-full">
          <span class="text-[10px] font-mono-tabular font-semibold uppercase px-2 py-0.5 rounded-md bg-[#EAE2D4]/70 dark:bg-[#2A251F] text-[#302D28] dark:text-[#EAE2D4]">${g.tag.split(' ')[0]}</span>
          <i class="fa-solid ${isDone ? 'fa-circle-check text-[#5E6B50]' : 'fa-circle-play text-[#B56D4E]'}" aria-hidden="true"></i>
        </div>
        <div class="font-serif-editorial font-bold text-xs text-[#302D28] dark:text-[#FBF8F1] mt-2.5">${g.name}</div>
        <div class="text-[10px] text-[#6E675B] dark:text-[#A89F91] mt-0.5">${isDone ? 'Completed today' : 'Start 10-round set'}</div>
      </button>
    `;
  }).join('');

  const badge = document.getElementById('daily-progress-badge');
  if (badge) badge.textContent = `${doneCount} / 3 Completed`;

  // Update Today's Scheduled Mock Exam summary
  const todayDow = new Date().getDay();
  const dayObj = DAY_META_EN.find(d => d.id === todayDow) || DAY_META_EN[0];
  const plan = appState.weeklyMockPlans[String(todayDow)] || createDefaultWeeklyMockPlansClient()[String(todayDow)];
  const stageKeys = Object.keys(plan.stages || {}).filter(k => Number(plan.stages[k]) > 0);
  const totalQ = stageKeys.reduce((s, k) => s + Number(plan.stages[k]), 0);

  const dayBadgeEl = document.getElementById('lobby-mock-day-badge');
  const sumEl = document.getElementById('lobby-mock-summary');
  if (dayBadgeEl) dayBadgeEl.textContent = dayObj.name.toUpperCase();
  if (sumEl) sumEl.textContent = `${plan.title} (${totalQ} Q • ${stageKeys.length} modules)`;
}

/********************************************************************
 * DASHBOARD STATS SUMMARY & EVERYDAY KNOWLEDGE (MIXING & MASTERING)
 ********************************************************************/
function renderDashboardStatsSummary() {
  const root = getActiveDataRoot();
  const todayKey = getLocalDateKey(0);
  const todayRec = (root.dailyStats && root.dailyStats[todayKey]) || { practiceSec: 0, questionsAnswered: 0 };
  const goalMins = (root.settings && root.settings.dailyGoalMinutes) || 15;
  const goalSec = Math.max(60, goalMins * 60);
  const practiceSec = Math.max(0, Number(todayRec.practiceSec) || 0);
  const pct = Math.min(100, Math.round((practiceSec / goalSec) * 100));

  const timeEl = document.getElementById('dashboard-today-time');
  if (timeEl) timeEl.textContent = formatSecondsHHMMSS(practiceSec);
  const goalMinsEl = document.getElementById('dashboard-today-goal-mins');
  if (goalMinsEl) goalMinsEl.textContent = String(goalMins);
  const goalPctEl = document.getElementById('dashboard-today-goal-pct');
  if (goalPctEl) goalPctEl.textContent = `${pct}%`;

  const spiEl = document.getElementById('dashboard-spi-value');
  const currentSpi = Math.round(Number((root.score && root.score.currentSpi) || 1000));
  if (spiEl) spiEl.textContent = currentSpi.toLocaleString();

  const spiSub = document.getElementById('dashboard-spi-sub');
  if (spiSub) {
    const todaySpiDelta = Math.round((todayRec.spiEnd || currentSpi) - (todayRec.spiStart || currentSpi));
    const sign = todaySpiDelta >= 0 ? '+' : '';
    spiSub.textContent = `${sign}${todaySpiDelta} today • Level ${appState.level || 1}`;
  }

  const streakEl = document.getElementById('dashboard-streak-count');
  const streaks = computePracticeDayStreaks(root.dailyStats);
  if (streakEl) streakEl.textContent = `${streaks.currentStreak} day${streaks.currentStreak === 1 ? '' : 's'}`;

  const habitEl = document.getElementById('dashboard-habit-weight');
  if (habitEl) {
    const habitProfile = typeof computeHabitWeightingProfile === 'function'
      ? computeHabitWeightingProfile(root, todayKey)
      : { weight: 1.0, tier: 'Baseline' };
    const weightVal = habitProfile ? habitProfile.weight.toFixed(2) : '1.00';
    habitEl.innerHTML = `Weight: <span class="font-semibold text-[#5E6B50]">${weightVal}x</span>`;
  }
}

const SVG_XMLNS = "http:" + String.fromCharCode(47, 47) + "www.w3.org/2000/svg";

function getEngineerAvatarFallback(author) {
  const initials = String(author || 'AE')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
  const svg = "<svg xmlns=\"" + SVG_XMLNS + "\" width=\"96\" height=\"96\" viewBox=\"0 0 96 96\"><rect width=\"96\" height=\"96\" rx=\"48\" fill=\"#382720\"/><circle cx=\"48\" cy=\"48\" r=\"44\" fill=\"none\" stroke=\"#B56D51\" stroke-width=\"2\"/><text x=\"48\" y=\"55\" font-family=\"system-ui, -apple-system, sans-serif\" font-weight=\"700\" font-size=\"28\" fill=\"#DFA58D\" text-anchor=\"middle\">" + initials + "</text></svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function getTrackArtworkFallback(song) {
  const svg = "<svg xmlns=\"" + SVG_XMLNS + "\" width=\"96\" height=\"96\" viewBox=\"0 0 96 96\"><rect width=\"96\" height=\"96\" rx=\"12\" fill=\"#202620\"/><circle cx=\"48\" cy=\"48\" r=\"32\" fill=\"#141714\" stroke=\"#4E5A4F\" stroke-width=\"2\"/><circle cx=\"48\" cy=\"48\" r=\"12\" fill=\"#B56D51\"/><circle cx=\"48\" cy=\"48\" r=\"4\" fill=\"#F0EFE7\"/></svg>";
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

const EVERYDAY_KNOWLEDGE = [
  {
    quote: {
      text: "Dynamics are the lifeblood of music. When you compress the life out of a mix, you rob the listener of emotion.",
      author: "Bob Katz",
      role: "3x Grammy-Winning Mastering Engineer",
      category: "Dynamics & Emotion",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Bob_Katz_mastering_engineer.jpg/240px-Bob_Katz_mastering_engineer.jpg"
    },
    technique: {
      title: "Low-End Phase Alignment & Mono Sub",
      band: "Sub-Bass < 60 Hz",
      desc: "Keep frequencies below 90 Hz strictly mono. Stereo sub-bass causes severe phase cancellation on club subwoofers and vinyl lathes. Use a 28 Hz linear-phase HPF to eliminate inaudible excursion rumble and reclaim mix headroom.",
      tip: "Audition in mono to detect bass cancellation instantly"
    },
    mix: {
      song: "Blinding Lights — The Weeknd",
      engineer: "Mixed by Serban Ghenea",
      badge: "Pop / Synthwave",
      notes: "Masterclass in modern clarity: pristine separation between the 60 Hz kick punch and 120 Hz synth bass, with a smooth 10 kHz vocal air shelf that never causes fatigue around 3 kHz.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/c/c1/The_Weeknd_-_After_Hours.png"
    }
  },
  {
    quote: {
      text: "Clarity isn't about boosting top end; it's about carving out space in the midrange so every element speaks effortlessly.",
      author: "Serban Ghenea",
      role: "21x Grammy-Winning Mix Engineer",
      category: "Midrange Clarity",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Concordia_University_Doctor_of_Fine_Arts_convocation_ceremony_2025_Serban_Ghenea.jpg/240px-Concordia_University_Doctor_of_Fine_Arts_convocation_ceremony_2025_Serban_Ghenea.jpg"
    },
    technique: {
      title: "The 250 Hz Mud Scoop & Boxiness Cleanup",
      band: "Low-Mid 200–400 Hz",
      desc: "The 200–400 Hz octave easily accumulates acoustic mud across acoustic guitars, snare body, and vocal chest resonance. Instead of boosting highs, dip 2–3 dB around 250–350 Hz with a moderate Q to reveal natural transparency.",
      tip: "Cut 250 Hz before reaching for a high-shelf boost"
    },
    mix: {
      song: "Get Lucky — Daft Punk",
      engineer: "Mixed by Mick Guzauski",
      badge: "Disco / Funk",
      notes: "Benchmark for groove articulation: perfectly balanced 40–80 Hz bass guitar transients, scooped 300 Hz acoustic guitars, and silken high-frequency headroom.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/a/a7/Random_Access_Memories.jpg"
    }
  },
  {
    quote: {
      text: "Don't be afraid to be bold. If you're going to EQ something, make it count. Committing to a sound is the real secret.",
      author: "Chris Lord-Alge",
      role: "Grammy-Winning Rock Mixer",
      category: "Bold Commitment",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Chris_Lord-Alge_Grammy_Mixer.jpg/240px-Chris_Lord-Alge_Grammy_Mixer.jpg"
    },
    technique: {
      title: "Fletcher-Munson Listening Level Calibration",
      band: "Acoustics & Monitoring",
      desc: "Human ear frequency response changes drastically with volume. Calibrate your studio monitors to 75–83 dBSPL (C-weighted, slow). At this level, bass and treble perception is flattest, preventing mix imbalances.",
      tip: "Check mix at conversational whisper level to check balance"
    },
    mix: {
      song: "Boulevard of Broken Dreams — Green Day",
      engineer: "Mixed by Chris Lord-Alge",
      badge: "Rock / Modern Alternative",
      notes: "Massive vocal presence with aggressive 3 kHz bite, tight 100 Hz kick chest punch, and scooped 400 Hz acoustic guitars to leave room for the lead vocal.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/e/ed/Green_Day_-_American_Idiot_album_cover.png"
    }
  },
  {
    quote: {
      text: "Mix with your ears, not your eyes. The analyzer is a guide, but your emotional connection to frequency balance is what matters.",
      author: "Dave Pensado",
      role: "Legendary Mixer (Pensado's Place)",
      category: "Ear Philosophy",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Dave_Pensado.jpg/240px-Dave_Pensado.jpg"
    },
    technique: {
      title: "2.5–4.5 kHz Ear Sensitivity & Sibilance Guard",
      band: "Presence 2–5 kHz",
      desc: "The human ear canal resonates at 3 kHz, making us hypersensitive to harshness. Use dynamic EQ rather than static cuts to tame 3–4 kHz only on loud vocal peaks or harsh cymbal crashes.",
      tip: "Tame transients dynamically to preserve vocal brightness"
    },
    mix: {
      song: "Dirrty — Christina Aguilera",
      engineer: "Mixed by Dave Pensado",
      badge: "R&B / Hip-Hop",
      notes: "Ultra-heavy 40–55 Hz sub-bass foundation paired with laser-sharp vocal transients that stay upfront without harshness.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/f/f6/Stripped_%28Christina_Aguilera_album%29_cover.png"
    }
  },
  {
    quote: {
      text: "The best EQ is microphone placement. In mixing, the less you have to fix, the more you can enhance.",
      author: "Al Schmitt",
      role: "20x Grammy-Winning Legend",
      category: "Organic Acoustics",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/10/Al_Schmitt_in_2015_at_James_DeFrances_release_party.jpg/240px-Al_Schmitt_in_2015_at_James_DeFrances_release_party.jpg"
    },
    technique: {
      title: "Linear-Phase vs Minimum-Phase EQ Decisions",
      band: "Master Bus & Parallel",
      desc: "Minimum-Phase EQ offers low latency and analog-style phase curve. Use Linear-Phase on the master bus, parallel drum compression, and multi-mic acoustic drums to completely avoid transient phase smear.",
      tip: "Use linear-phase when blending processed and dry signals"
    },
    mix: {
      song: "The Look of Love — Diana Krall",
      engineer: "Mixed by Al Schmitt",
      badge: "Jazz / Orchestral",
      notes: "The epitome of natural acoustic space: warm 150 Hz double-bass resonance, crystal-clear 12 kHz orchestral air, and zero artificial EQ coloration.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/a/a4/The_Look_of_Love_%28Diana_Krall_album%29_cover.jpg"
    }
  },
  {
    quote: {
      text: "Mastering is about perspective. It’s preserving the artist's intent while ensuring translation across every acoustic environment.",
      author: "Bernie Grundman",
      role: "Legendary Mastering Icon",
      category: "Translation & Depth",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/90/Bernie_Grundman.jpg/240px-Bernie_Grundman.jpg"
    },
    technique: {
      title: "The 1 kHz Acoustic Anchor Point",
      band: "Midrange 1 kHz",
      desc: "1 kHz is the psychoacoustic center of the audible spectrum (20 Hz–20 kHz on a logarithmic scale). When ear training, use 1 kHz as your mental compass: warmth lives below 1 kHz; air and snap live above 1 kHz.",
      tip: "Anchor your ear to 1 kHz before guessing boost/cut frequencies"
    },
    mix: {
      song: "Thriller — Michael Jackson",
      engineer: "Mastered by Bernie Grundman",
      badge: "Classic Pop / Funk",
      notes: "Incredible dynamic punch, zero transient clipping, and punchy 100 Hz kick definition paired with Bruce Swedien's Acusonic stereo width.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/5/55/Michael_Jackson_-_Thriller.png"
    }
  },
  {
    quote: {
      text: "Multibus compression is about motion and energy, not volume. Keep the groove breathing.",
      author: "Michael Brauer",
      role: "7x Grammy-Winning Mixer (Coldplay, John Mayer)",
      category: "Motion & Groove",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/Michael_Brauer_Mixer.jpg/240px-Michael_Brauer_Mixer.jpg"
    },
    technique: {
      title: "Crest Factor & Digital Headroom Discipline",
      band: "Gain Staging & Meters",
      desc: "Maintain 10–14 dB crest factor (peak vs RMS) during tracking and mixing. Aim for -18 to -14 dBFS RMS on track channels, and leave -3 to -6 dBFS peak headroom before sending to master bus processing.",
      tip: "Never slam 0 dBFS in 24-bit floating point; leave room for transients"
    },
    mix: {
      song: "Fix You — Coldplay",
      engineer: "Mixed by Michael Brauer",
      badge: "Anthemic Rock / Pop",
      notes: "Masterclass in dynamic evolution: intimate organ and vocal intro exploding into massive wide-open drums with zero harshness.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/2/28/Coldplay_X%26Y.svg"
    }
  },
  {
    quote: {
      text: "The low end is the foundation of modern music. If 50–100 Hz isn't in phase and tight, the whole mix collapses.",
      author: "Manny Marroquin",
      role: "14x Grammy-Winning Mixer",
      category: "Low-End Foundation",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/Manny_Marroquin.jpg/240px-Manny_Marroquin.jpg"
    },
    technique: {
      title: "Vocal Air Shelf vs Sibilance Window",
      band: "Air Band 10–16 kHz",
      desc: "A smooth high shelf starting at 12–14 kHz lifts luxurious air and expensive studio sheen without exaggerating the 5–8 kHz sibilance region.",
      tip: "Boost at 14 kHz instead of 6 kHz to avoid harsh 's' sounds"
    },
    mix: {
      song: "Locked Out of Heaven — Bruno Mars",
      engineer: "Mixed by Manny Marroquin",
      badge: "Retro-Pop / Rock",
      notes: "Vintage tape warmth, punchy 100 Hz drum slam, and razor-sharp dynamic transient control across all sections.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/7/77/BrunoMarsUnorthodoxJukebox.png"
    }
  },
  {
    quote: {
      text: "Leave headroom. 24-bit digital audio gives you a massive 144 dB dynamic floor; you never need to slam the 0 dBFS ceiling in the mix.",
      author: "Leslie Brathwaite",
      role: "Grammy-Winning Mixer (Pharrell, Cardi B)",
      category: "Headroom & Staging",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/Leslie_Brathwaite.jpg/240px-Leslie_Brathwaite.jpg"
    },
    technique: {
      title: "Mono Compatibility & Side-Channel Masking",
      band: "Stereo Imaging 500 Hz–5 kHz",
      desc: "Wide reverbs and chorus effects often cancel out in mono on mobile phone speakers. Regularly audition in mono to verify that lead vocals, kick, and snare maintain solid center presence.",
      tip: "If the snare disappears in mono, wide stereo effects are out of phase"
    },
    mix: {
      song: "Happy — Pharrell Williams",
      engineer: "Mixed by Leslie Brathwaite",
      badge: "Modern Soul / Pop",
      notes: "Crisp handclaps with rich 1.5 kHz transient bite, warm analog bass resonance at 80 Hz, and transparent vocal intelligibility.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/2/22/Pharrell_Williams_-_Girl.png"
    }
  },
  {
    quote: {
      text: "Panning and stereo contrast create depth. You can't have wide elements without a rock-solid, focused mono center.",
      author: "Bob Clearmountain",
      role: "Legendary Mixer (Springsteen, Bowie, Chic)",
      category: "Stereo Contrast & Depth",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Bob_clearmountain.jpg/240px-Bob_clearmountain.jpg"
    },
    technique: {
      title: "Snare Body vs Crack Frequency Placement",
      band: "Snare 200 Hz & 4 kHz",
      desc: "A punchy snare has fundamental body at 180–220 Hz and snap/crack at 3.5–5 kHz. Carve out guitars at 200 Hz and cymbals at 4 kHz to let the snare explode forward naturally.",
      tip: "Boost 200 Hz for fatness and 4 kHz for attack; cut 800 Hz for ring"
    },
    mix: {
      song: "Born in the U.S.A. — Bruce Springsteen",
      engineer: "Mixed by Bob Clearmountain",
      badge: "Classic Rock",
      notes: "The gold standard of gated room reverb and snare weight: heavy 200 Hz body, explosive 4 kHz crack, and pinpoint stereo imaging.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/1/1a/Bornintheusa.jpg"
    }
  },
  {
    quote: {
      text: "Every instrument must fight for its space, but the mix engineer is the referee deciding who gets which frequency lane.",
      author: "Andy Wallace",
      role: "Legendary Mixer (Nirvana, Linkin Park, Slayer)",
      category: "Frequency Separation",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Andy_Wallace.jpg/240px-Andy_Wallace.jpg"
    },
    technique: {
      title: "Kick & Bass Frequency Nesting",
      band: "Bass 50–120 Hz",
      desc: "Decide whether the kick drum or bass guitar owns the lowest sub octave. If kick is tuned to 55 Hz, notch the bass slightly at 55 Hz and boost bass at 90–110 Hz so both stay distinct.",
      tip: "Nest kick at 60 Hz and bass at 100 Hz (or vice versa)"
    },
    mix: {
      song: "Smells Like Teen Spirit — Nirvana",
      engineer: "Mixed by Andy Wallace",
      badge: "Grunge / Rock",
      notes: "Unmatched punch and wall-of-sound clarity: deep 55 Hz kick impact, snarling 1.2 kHz bass guitar grit, and crisp guitar separation.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/b/b7/NirvanaNevermindalbumcover.jpg"
    }
  },
  {
    quote: {
      text: "Distortion and saturation are tone-shaping tools, not just volume boosters. Harmonics make quiet sounds audible on tiny speakers.",
      author: "Tchad Blake",
      role: "Grammy-Winning Pioneer (The Black Keys, Arctic Monkeys)",
      category: "Harmonic Saturation",
      avatarUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Tchad_Blake.jpg/240px-Tchad_Blake.jpg"
    },
    technique: {
      title: "Harmonic Saturation for Bass Audibility",
      band: "Harmonics 200–800 Hz",
      desc: "Sub-bass (40–60 Hz) is inaudible on mobile phone and laptop speakers. Adding subtle tape or tube saturation generates 2nd and 3rd harmonics in the 120–300 Hz region, making the bass audible on any device without boosting volume.",
      tip: "Use saturation to create upper harmonics for small phone speakers"
    },
    mix: {
      song: "Lonely Boy — The Black Keys",
      engineer: "Mixed by Tchad Blake",
      badge: "Garage Rock",
      notes: "Raw, energetic harmonic saturation: gritty midrange drive, explosive drum room compression, and distinct instrument separation.",
      artworkUrl: "https://upload.wikimedia.org/wikipedia/en/5/58/The_Black_Keys_-_El_Camino.png"
    }
  }
];

let currentKnowledgeIndex = -1;

function getDailyKnowledgeDefaultIndex() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  const oneDay = 1000 * 60 * 60 * 24;
  const dayOfYear = Math.floor(diff / oneDay);
  return Math.abs(dayOfYear) % EVERYDAY_KNOWLEDGE.length;
}

function renderEverydayKnowledge(targetIndex) {
  if (!Array.isArray(EVERYDAY_KNOWLEDGE) || EVERYDAY_KNOWLEDGE.length === 0) return;
  if (typeof targetIndex === 'number' && !isNaN(targetIndex)) {
    currentKnowledgeIndex = ((targetIndex % EVERYDAY_KNOWLEDGE.length) + EVERYDAY_KNOWLEDGE.length) % EVERYDAY_KNOWLEDGE.length;
  } else if (currentKnowledgeIndex < 0) {
    currentKnowledgeIndex = getDailyKnowledgeDefaultIndex();
  }

  const item = EVERYDAY_KNOWLEDGE[currentKnowledgeIndex];
  if (!item) return;

  const counterBadge = document.getElementById('ek-counter-badge');
  if (counterBadge) counterBadge.textContent = `${currentKnowledgeIndex + 1} / ${EVERYDAY_KNOWLEDGE.length}`;

  const qCategory = document.getElementById('ek-quote-category');
  if (qCategory) qCategory.textContent = item.quote.category;
  const qText = document.getElementById('ek-quote-text');
  if (qText) qText.textContent = `"${item.quote.text}"`;
  const qAuthor = document.getElementById('ek-quote-author');
  if (qAuthor) qAuthor.textContent = item.quote.author;
  const qRole = document.getElementById('ek-quote-role');
  if (qRole) qRole.textContent = item.quote.role;

  const qAvatar = document.getElementById('ek-quote-avatar');
  if (qAvatar) {
    qAvatar.onerror = function() {
      this.onerror = null;
      this.src = getEngineerAvatarFallback(item.quote.author);
    };
    qAvatar.src = item.quote.avatarUrl || getEngineerAvatarFallback(item.quote.author);
    qAvatar.alt = item.quote.author;
  }

  const tBand = document.getElementById('ek-technique-band');
  if (tBand) tBand.textContent = item.technique.band;
  const tTitle = document.getElementById('ek-technique-title');
  if (tTitle) tTitle.textContent = item.technique.title;
  const tDesc = document.getElementById('ek-technique-desc');
  if (tDesc) tDesc.textContent = item.technique.desc;
  const tTip = document.getElementById('ek-technique-tip');
  if (tTip) tTip.textContent = item.technique.tip;

  const mBadge = document.getElementById('ek-mix-badge');
  if (mBadge) mBadge.textContent = item.mix.badge;
  const mSong = document.getElementById('ek-mix-song');
  if (mSong) mSong.textContent = item.mix.song;
  const mEng = document.getElementById('ek-mix-engineer');
  if (mEng) mEng.textContent = item.mix.engineer;
  const mNotes = document.getElementById('ek-mix-notes');
  if (mNotes) mNotes.textContent = item.mix.notes;

  const mThumb = document.getElementById('ek-mix-thumb');
  if (mThumb) {
    mThumb.onerror = function() {
      this.onerror = null;
      this.src = getTrackArtworkFallback(item.mix.song);
    };
    mThumb.src = item.mix.artworkUrl || getTrackArtworkFallback(item.mix.song);
    mThumb.alt = item.mix.song;
  }

  const mBgArt = document.getElementById('ek-mix-bg-art');
  if (mBgArt) {
    if (item.mix.artworkUrl) {
      mBgArt.style.backgroundImage = `url('${item.mix.artworkUrl}')`;
    } else {
      mBgArt.style.backgroundImage = 'none';
    }
  }
}

function cycleEverydayKnowledge(direction) {
  const step = Number(direction) || 1;
  const next = (currentKnowledgeIndex < 0 ? getDailyKnowledgeDefaultIndex() : currentKnowledgeIndex) + step;
  renderEverydayKnowledge(next);
}

function shuffleEverydayKnowledge() {
  if (!Array.isArray(EVERYDAY_KNOWLEDGE) || EVERYDAY_KNOWLEDGE.length <= 1) return;
  let next = Math.floor(Math.random() * EVERYDAY_KNOWLEDGE.length);
  if (next === currentKnowledgeIndex) {
    next = (next + 1) % EVERYDAY_KNOWLEDGE.length;
  }
  renderEverydayKnowledge(next);
}

function filterLobbyGames(cat) {
  appState.lobbyFilter = cat;
  ['all', 'eq', 'filter', 'spatial'].forEach(c => {
    const btn = document.getElementById(`cat-${c}`);
    if (!btn) return;
    btn.className = c === cat
      ? 'h-9 px-3.5 rounded-full text-xs font-semibold border-0 bg-[#B56D4E] text-[#FBF8F1] flex items-center justify-center whitespace-nowrap transition-all shadow-xs'
      : 'h-9 px-3.5 rounded-full text-xs font-semibold border border-black/[0.04] dark:border-white/[0.06] bg-[#FBF8F1] dark:bg-[#1E1B17] text-[#302D28] dark:text-[#EAE2D4] hover:bg-[#EAE2D4] dark:hover:bg-[#25221E] flex items-center justify-center whitespace-nowrap transition-all';
  });
  renderLobbyGamesGrid();
}

function renderLobbyGamesGrid() {
  const grid = document.getElementById('lobby-games-grid');
  if (!grid) return;

  const root = getActiveDataRoot();
  const list = Object.values(SG_GAMES).filter(g => appState.lobbyFilter === 'all' || g.category === appState.lobbyFilter);

  grid.innerHTML = list.map(g => {
    const rec = (root.gameStats && root.gameStats[g.id]) || { highScore: 0, lastScore: 0, lastDelta: 0, maxLevel: 1, practiceTimeSec: 0, sessionsCompleted: 0 };
    const delta = rec.lastDelta || 0;
    const deltaHtml = delta !== 0
      ? `<span class="text-[10px] font-mono-tabular px-1.5 py-0.5 rounded border ${delta > 0 ? 'bg-[#E6ECE0] text-[#5E6B50] border-[#5E6B50]/30' : 'bg-[#F5E4E1] text-[#A8463B] border-[#A8463B]/30'}">${delta > 0 ? '+' : ''}${delta} Δ</span>`
      : '';
    const minsSpent = Math.round(((rec.practiceTimeSec || 0) / 60) * 10) / 10;

    return `
      <article role="button" tabindex="0" aria-label="Launch ${g.name} (${g.tag})" onclick="launchGameFromLobby('${g.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();launchGameFromLobby('${g.id}');}" class="washi-card washi-card-interactive cursor-pointer overflow-hidden rounded-2xl border border-black/[0.04] dark:border-white/[0.05] shadow-xs hover:shadow-lg flex flex-col justify-between group focus:outline-none focus:ring-2 focus:ring-[#B56D4E]">
        <div>
          <div class="relative h-32 w-full overflow-hidden border-b border-[var(--sg-border)] bg-[var(--sg-card-art-bg)]">
            ${GAME_SVG_ART[g.id]}
            <div class="absolute top-2.5 left-2.5">
              <span class="px-2.5 py-0.5 rounded-full bg-[#FBF8F1]/90 dark:bg-[#161412]/90 backdrop-blur-md text-[10px] font-mono-tabular font-semibold text-[#6E675B] dark:text-[#A89F91] uppercase shadow-xs">
                ${g.tag}
              </span>
            </div>
            <div class="absolute top-2.5 right-2.5 flex items-center gap-1.5">
              ${deltaHtml}
              <span class="px-2.5 py-0.5 rounded-full bg-[#FBF8F1]/90 dark:bg-[#161412]/90 backdrop-blur-md text-[10px] font-mono-tabular font-bold text-[#302D28] dark:text-[#FBF8F1] shadow-xs">
                LVL ${rec.maxLevel || 1}
              </span>
            </div>
          </div>

          <div class="p-4 sm:p-5">
            <div class="flex items-center justify-between">
              <h3 class="text-base font-serif-editorial font-bold text-[#302D28] dark:text-[#FBF8F1] group-hover:text-[#B56D4E] transition">${g.name}</h3>
              <span class="text-xs font-mono-tabular text-[#5E6B50] dark:text-[#8EAA7B] font-semibold" title="Personal Best Session Score">Best: ${(rec.highScore || 0).toLocaleString()}</span>
            </div>
            <p class="text-xs text-[#6E675B] dark:text-[#A89F91] mt-1.5 leading-relaxed">${g.desc}</p>
          </div>
        </div>

        <div class="px-5 py-3 bg-[#EAE2D4]/50 dark:bg-[#181613]/60 border-t border-black/[0.03] dark:border-white/[0.04] flex items-center justify-between">
          <span class="text-[11px] font-mono-tabular text-[#6E675B] dark:text-[#A89F91]">${rec.sessionsCompleted || 0} sets • ${minsSpent}m practiced</span>
          <span class="px-3.5 py-1 rounded-full bg-[#B56D4E] text-[#FBF8F1] font-semibold text-xs uppercase flex items-center gap-1.5 shadow-xs hover:bg-[#965438] transition-all">
            <span>Train</span>
            <i class="fa-solid fa-arrow-right text-[10px]" aria-hidden="true"></i>
          </span>
        </div>
      </article>
    `;
  }).join('');
}

function showArenaExerciseLibrary() {
  appState.arenaDeckVisible = false;
  const libSection = document.getElementById('arena-exercise-library');
  const deckSection = document.getElementById('arena-interactive-deck');
  if (libSection) libSection.classList.remove('hidden');
  if (deckSection) deckSection.classList.add('hidden');
  renderLobbyGamesGrid();
}

/********************************************************************
 * TRAINING ARENA WORKFLOW & GAME CONTROLLERS
 ********************************************************************/
function launchGameFromLobby(gameId, isMockTransition = false) {
  if (!SG_GAMES[gameId]) return;
  stopCheetah60sBlitz();

  if (!isMockTransition) {
    appState.mockExamActive = false;
    appState.mockExamFinished = false;
    clearMockQuestionTimer();
    const banner = document.getElementById('arena-mock-banner');
    if (banner) {
      banner.classList.add('hidden');
      banner.classList.remove('flex');
    }
    const quickSwitcher = document.getElementById('arena-quick-switcher');
    if (quickSwitcher) {
      quickSwitcher.classList.remove('xl:hidden');
    }
  }

  appState.gameMode = gameId;
  const g = SG_GAMES[gameId];

  appState.arenaDeckVisible = true;
  switchMainView('arena');
  startOrResumePracticeSession(gameId, appState.mockExamActive ? 'mock' : 'practice');

  const libSection = document.getElementById('arena-exercise-library');
  const deckSection = document.getElementById('arena-interactive-deck');
  if (libSection) libSection.classList.add('hidden');
  if (deckSection) deckSection.classList.remove('hidden');
  initArenaCanvasInteraction();
  setTimeout(() => resizeArenaCanvas(), 20);

  document.getElementById('arena-mascot-thumb').innerHTML = GAME_SVG_ART[gameId];
  document.getElementById('arena-game-title').textContent = g.name;
  document.getElementById('arena-game-tag').textContent = g.tag;
  document.getElementById('arena-game-subtitle').textContent = g.desc;
  document.getElementById('stage-overlay-pill').textContent = g.instruction;

  Object.keys(SG_GAMES).forEach(k => {
    const qb = document.getElementById(`qbtn-${k}`);
    if (!qb) return;
    qb.className = k === gameId
      ? 'h-7 px-2.5 rounded border border-[#965438] text-[11px] font-semibold bg-[#B56D4E] text-[#FBF8F1] inline-flex items-center justify-center whitespace-nowrap'
      : 'h-7 px-2.5 rounded border border-transparent text-[11px] font-medium text-[#6E675B] hover:text-[#302D28] inline-flex items-center justify-center whitespace-nowrap';
  });

  document.getElementById('arena-deck-filter').classList.toggle('hidden', gameId !== 'filter');
  document.getElementById('arena-deck-knight').classList.toggle('hidden', gameId !== 'knight');
  document.getElementById('arena-deck-feedback').classList.toggle('hidden', gameId !== 'feedback');

  const hasLiveUserAudition = ['mirror', 'cheetah', 'filter'].includes(gameId);
  const userAudBtn = document.getElementById('ab-btn-user');
  if (userAudBtn) {
    userAudBtn.disabled = !hasLiveUserAudition;
    userAudBtn.classList.toggle('opacity-40', !hasLiveUserAudition);
    userAudBtn.classList.toggle('cursor-not-allowed', !hasLiveUserAudition);
    userAudBtn.classList.toggle('pointer-events-none', !hasLiveUserAudition);
    userAudBtn.title = hasLiveUserAudition
      ? 'Audition your currently selected EQ parameters'
      : 'Your EQ audition available in EQ Mirror, Cheetah, and Filter Expert';
  }

  document.getElementById('stage-bass-badge').classList.toggle('hidden', gameId !== 'bass');
  const cheetahBtn = document.getElementById('btn-start-cheetah');
  cheetahBtn.classList.toggle('hidden', gameId !== 'cheetah' || appState.mockExamActive);
  cheetahBtn.classList.toggle('flex', gameId === 'cheetah' && !appState.mockExamActive);
  document.getElementById('stage-cheetah-timer').classList.toggle('hidden', gameId !== 'cheetah');

  if (!isMockTransition) {
    restartCurrentArenaGame();
  } else {
    setupNextArenaRound();
  }

  if (!appState.isPlaying && sgSourceManager.sourceMode === 'studio') {
    startAudioPlayback();
  } else {
    applyCurrentArenaDspToEngine();
  }
}

function restartCurrentArenaGame() {
  const hadActiveBlitz = Boolean(appState.cheetahRunning && appState.activeSession && appState.activeSession.cheetahBlitzActive);
  stopCheetah60sBlitz();
  if (
    !appState.mockExamActive &&
    appState.activeSession &&
    appState.activeSession.questionsCount >= 1 &&
    appState.lives > 0 &&
    (appState.activeSession.questionsCount < appState.maxRounds || hadActiveBlitz)
  ) {
    endActivePracticeSession('restarted', false);
    startOrResumePracticeSession(appState.gameMode, 'practice');
  }
  const maxHp = typeof getMaxHeartsForLevel === 'function' ? getMaxHeartsForLevel(appState.level) : 4;
  appState.maxLives = maxHp;
  appState.lives = maxHp;
  appState.round = 1;
  appState.maxRounds = 10;
  appState.score = 0;
  updateArenaHUD();
  setupNextArenaRound();
}

function changeGameLevel(val) {
  markUserTrainingInteraction();
  appState.level = Math.max(1, Math.min(10, parseInt(val, 10) || 3));
  const maxHp = typeof getMaxHeartsForLevel === 'function' ? getMaxHeartsForLevel(appState.level) : 4;
  appState.maxLives = maxHp;
  appState.lives = maxHp;
  appState.round = 1;
  appState.score = 0;
  updateArenaHUD();
  setupNextArenaRound();
}

function changeAnalyserTap(tapVal) {
  sgAudioEngine.analyserTap = tapVal === 'pre' ? 'pre' : 'post';
}

function setupNextArenaRound() {
  appState.roundSubmitted = false;
  appState.roundSubmittingLock = false;
  appState.roundStartTimeMs = performance.now();
  markUserTrainingInteraction();

  const generated = generateQuestionTarget(
    appState.gameMode,
    appState.level,
    appState.mockExamActive ? appState.mockConfig : null
  );

  appState.targetFreq = generated.frequencyHz;
  appState.targetGain = generated.gainDb;
  appState.targetQ = generated.q;
  appState.targetFilterType = generated.filterType;
  appState.targetPan = generated.pan;
  appState.knightChoices = generated.knightChoices;
  appState.targetKnightIdx = generated.targetKnightIdx;

  // Set neutral initial user coordinates so they never leak target values
  if (appState.gameMode === 'bass') {
    appState.userFreq = 140;
  } else if (appState.gameMode === 'feedback') {
    appState.userFreq = 1000;
    renderIso20GraphicEQ();
  } else {
    appState.userFreq = 1000;
  }

  if (appState.gameMode === 'mirror') {
    appState.userGain = 5.5;
  } else if (appState.gameMode === 'cheetah') {
    appState.userGain = Math.abs(appState.targetGain);
  } else if (appState.gameMode === 'filter') {
    appState.userFilterType = 'lowpass';
    selectFilterType('lowpass', true);
  } else if (appState.gameMode === 'knight') {
    appState.userKnightIdx = 0;
    renderKnight4Cards();
  }

  const targetReadout = document.getElementById('arena-readout-target');
  targetReadout.textContent = 'Hidden';
  targetReadout.className = 'text-[#6E675B] font-semibold';

  document.getElementById('arena-readout-dsp').textContent =
    `±${Math.abs(appState.targetGain).toFixed(1)} dB • Q ${appState.targetQ.toFixed(1)}`;

  document.getElementById('txt-arena-submit').textContent =
    appState.gameMode === 'cheetah' ? 'Quick Match (Enter)' : 'Submit Answer (Enter)';
  document.getElementById('icon-arena-submit').className = 'fa-solid fa-check';

  setArenaListenState('target');
  updateUserCoordinateReadout();

  const g = SG_GAMES[appState.gameMode];
  const titleEl = document.getElementById('arena-feedback-title');
  titleEl.textContent = `${g.name}: Listen carefully and lock in your answer`;
  titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#302D28]';
  document.getElementById('arena-feedback-desc').textContent = g.desc;

  startMockQuestionTimerIfNeeded();
}

function applyCurrentArenaDspToEngine() {
  const inArena = appState.currentView === 'arena';
  sgAudioEngine.applyDspConfiguration({
    isPlaying: appState.isPlaying,
    isSweeping: inArena && Boolean(appState.isDraggingStage || appState._kbdSweepingActive),
    gameMode: appState.gameMode,
    listenState: inArena ? appState.listenState : 'original',
    bypassHeadroom: !inArena,
    targetFreq: appState.targetFreq,
    targetGain: appState.targetGain,
    targetQ: appState.targetQ,
    targetFilterType: appState.targetFilterType,
    targetPan: appState.targetPan,
    activeKnightCurve: appState.knightChoices[appState.targetKnightIdx] || KNIGHT_CURVES[0],
    userFreq: appState.userFreq,
    userGain: appState.userGain,
    userFilterType: appState.userFilterType,
    userPan: appState.userPan
  });
}

function handleArenaPrimaryAction() {
  markUserTrainingInteraction();
  if (appState.gameMode === 'cheetah' && !appState.cheetahRunning && !appState.mockExamActive) {
    startCheetah60sBlitz();
    return;
  }
  if (!appState.roundSubmitted) {
    evaluateArenaRound(false);
  } else {
    proceedAfterRoundReveal();
  }
}

function formatUserAndTargetSummary(gameMode) {
  if (gameMode === 'mirror') {
    return {
      userSummary: `${formatHz(appState.userFreq)} (${appState.userGain > 0 ? '+' : ''}${appState.userGain}dB)`,
      targetSummary: `${formatHz(appState.targetFreq)} (${appState.targetGain > 0 ? '+' : ''}${appState.targetGain}dB)`
    };
  }
  if (gameMode === 'filter') {
    return {
      userSummary: `${appState.userFilterType.toUpperCase()} @ ${formatHz(appState.userFreq)}`,
      targetSummary: `${appState.targetFilterType.toUpperCase()} @ ${formatHz(appState.targetFreq)}`
    };
  }
  if (gameMode === 'knight') {
    const letters = ['A', 'B', 'C', 'D'];
    return {
      userSummary: `Curve ${letters[appState.userKnightIdx] || 'A'}`,
      targetSummary: `Curve ${letters[appState.targetKnightIdx] || 'A'}`
    };
  }
  return {
    userSummary: formatHz(appState.userFreq),
    targetSummary: formatHz(appState.targetFreq)
  };
}

function evaluateArenaRound(isTimeout = false) {
  if (appState.roundSubmitted || appState.roundSubmittingLock) return; // Prevent double-submit race!
  appState.roundSubmittingLock = true;
  appState.roundSubmitted = true;
  appState.roundSubmittedAt = performance.now();
  try {
    clearMockQuestionTimer();
  reconcilePracticeSessionTime();

  const root = getActiveDataRoot();
  const gSpec = SG_GAMES[appState.gameMode];
  const todayKey = getLocalDateKey(0);
  const habitProfile = typeof computeHabitWeightingProfile === 'function'
    ? computeHabitWeightingProfile(root, todayKey)
    : { weight: 1.0 };

  const todayRec = ensureDailyRecordForDate(todayKey);
  const reactionSec = Math.max(0.1, (performance.now() - appState.roundStartTimeMs) / 1000);
  const scoreOutcome = scoreQuestionSubmission({
    gameMode: appState.gameMode,
    level: appState.level,
    habitWeight: habitProfile.weight,
    mode: appState.mockExamActive ? 'mock' : 'practice',
    isMockExam: Boolean(appState.mockExamActive),
    mockExamActive: Boolean(appState.mockExamActive),
    currentSpi: root.score.currentSpi || 1000,
    todayQuestions: todayRec.questionsAnswered || 0,
    target: {
      frequencyHz: appState.targetFreq,
      gainDb: appState.targetGain,
      q: appState.targetQ,
      filterType: appState.targetFilterType,
      pan: appState.targetPan,
      knightChoices: appState.knightChoices,
      targetKnightIdx: appState.targetKnightIdx
    },
    user: {
      frequencyHz: appState.userFreq,
      gainDb: appState.userGain,
      filterType: appState.userFilterType,
      pan: appState.userPan,
      knightIdx: appState.userKnightIdx
    },
    reactionSec: reactionSec,
    isTimeout: Boolean(isTimeout)
  });

  if (scoreOutcome.passed) {
    root.score.currentAnswerStreak = (root.score.currentAnswerStreak || 0) + 1;
    if (root.score.currentAnswerStreak > (root.score.bestAnswerStreak || 0)) {
      root.score.bestAnswerStreak = root.score.currentAnswerStreak;
    }
    sgAudioEngine.playUiCue('correct', appState.settings.uiSfxEnabled);
  } else if (scoreOutcome.isNearMiss) {
    // Scoring v5: Near-miss (45%-69%) does NOT deplete Heart Points!
    root.score.currentAnswerStreak = 0;
    sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);
  } else {
    root.score.currentAnswerStreak = 0;
    // Scoring v5: Only deduct heart points when answer is a severe miss/blunder or timeout
    if (scoreOutcome.deductHeart && appState.gameMode !== 'cheetah' && !appState.mockExamActive) {
      appState.lives = Math.max(0, appState.lives - 1);
    }
    sgAudioEngine.playUiCue('wrong', appState.settings.uiSfxEnabled);
  }

  appState.score += scoreOutcome.scorePoints;
  root.score.totalPoints = (root.score.totalPoints || 0) + scoreOutcome.scorePoints;
  root.score.currentSpi = Math.max(500, (root.score.currentSpi || 1000) + scoreOutcome.spiDelta);
  if (root.score.currentSpi > (root.score.peakSpi || 1000)) {
    root.score.peakSpi = root.score.currentSpi;
  }

  // Update 6-Axis Skill Profile proportionally (sharper precision builds faster; severe misses erode faster)
  const curAxisVal = Number(root.score.skillAxes[gSpec.spiAxis]) || 0;
  if (scoreOutcome.passed) {
    const step = scoreOutcome.accuracy >= 92 ? 5 : (scoreOutcome.accuracy >= 82 ? 3 : 1);
    root.score.skillAxes[gSpec.spiAxis] = Math.min(100, curAxisVal === 0 ? 55 + step : curAxisVal + step);
  } else if (curAxisVal > 0) {
    const drop = isTimeout || scoreOutcome.accuracy < 35 ? 3 : (scoreOutcome.isNearMiss ? 0 : 1);
    root.score.skillAxes[gSpec.spiAxis] = Math.max(10, curAxisVal - drop);
  }

  // Update Today's Daily Record
  todayRec.spiEnd = root.score.currentSpi;
  todayRec.spiDelta = todayRec.spiEnd - todayRec.spiStart;
  todayRec.questionsAnswered = (todayRec.questionsAnswered || 0) + 1;
  todayRec.accuracySum = (todayRec.accuracySum || 0) + scoreOutcome.accuracy;
  todayRec.scorePoints = (todayRec.scorePoints || 0) + scoreOutcome.scorePoints;

  // Update Per-Game Question & Accuracy Stats (note: session high score is updated at session end, not per cumulative exam score!)
  const gStat = root.gameStats[appState.gameMode];
  if (gStat) {
    gStat.questionsAnswered = (gStat.questionsAnswered || 0) + 1;
    gStat.totalAccuracySum = (gStat.totalAccuracySum || 0) + scoreOutcome.accuracy;
  }

  if (appState.activeSession) {
    appState.activeSession.questionsCount = (appState.activeSession.questionsCount || 0) + 1;
  }

  const summaries = formatUserAndTargetSummary(appState.gameMode);
  const questionEvent = {
    eventId: generateUuid(),
    sessionId: appState.activeSession ? appState.activeSession.sessionId : generateUuid(),
    timestamp: new Date().toISOString(),
    localDate: todayKey,
    gameId: appState.gameMode,
    gameName: gSpec.name,
    mode: appState.mockExamActive ? 'mock' : 'practice',
    difficulty: appState.level,
    target: {
      frequencyHz: appState.targetFreq,
      gainDb: appState.targetGain,
      q: appState.targetQ,
      filterType: appState.targetFilterType,
      pan: appState.targetPan,
      targetKnightIdx: appState.targetKnightIdx
    },
    response: {
      frequencyHz: appState.userFreq,
      gainDb: appState.userGain,
      filterType: appState.userFilterType,
      pan: appState.userPan,
      knightIdx: appState.userKnightIdx
    },
    userSummary: isTimeout ? 'Timeout' : summaries.userSummary,
    targetSummary: summaries.targetSummary,
    errors: scoreOutcome.errors,
    status: scoreOutcome.status,
    passed: scoreOutcome.passed,
    isNearMiss: Boolean(scoreOutcome.isNearMiss),
    deductHeart: Boolean(scoreOutcome.deductHeart),
    responseTimeMs: Math.round(reactionSec * 1000),
    accuracy: scoreOutcome.accuracy,
    scorePoints: scoreOutcome.scorePoints,
    spiDelta: scoreOutcome.spiDelta,
    habitWeightApplied: scoreOutcome.habitWeightApplied || 1.0,
    scoringVersion: 8
  };

  root.recentQuestionEvents.unshift(questionEvent);
  root.recentQuestionEvents = root.recentQuestionEvents.slice(0, 250);

  if (!appState.demoModeActive) {
    appState.pendingSync.questionEvents.push(questionEvent);
    saveStateToLocalCache();
  }

  if (appState.mockExamActive) {
    appState.mockQuestionResults.push({
      eventId: questionEvent.eventId,
      gameId: appState.gameMode,
      gameName: gSpec.name,
      status: scoreOutcome.status,
      passed: scoreOutcome.passed,
      accuracy: scoreOutcome.accuracy,
      scorePoints: scoreOutcome.scorePoints,
      spiDelta: scoreOutcome.spiDelta,
      targetFreq: appState.targetFreq,
      userFreq: appState.userFreq,
      userSummary: questionEvent.userSummary,
      targetSummary: questionEvent.targetSummary,
      reactionSec: Number(reactionSec.toFixed(2))
    });
  }

  if (appState.gameMode === 'knight') {
    highlightKnightCardsAfterSubmit();
  } else if (appState.gameMode === 'feedback') {
    renderIso20GraphicEQ();
  }

  const targetReadout = document.getElementById('arena-readout-target');
  targetReadout.textContent = summaries.targetSummary;
  targetReadout.className = scoreOutcome.passed
    ? 'text-[#5E6B50] font-bold'
    : (scoreOutcome.isNearMiss ? 'text-[#9E7B42] font-bold' : 'text-[#A8463B] font-bold');

  updateArenaHUD();
  updateGlobalHeaderTrackingUI();

  const titleEl = document.getElementById('arena-feedback-title');
  const descEl = document.getElementById('arena-feedback-desc');
  if (appState.lives <= 0 && !appState.mockExamActive && appState.gameMode !== 'cheetah') {
    const maxHp = appState.maxLives || (typeof getMaxHeartsForLevel === 'function' ? getMaxHeartsForLevel(appState.level) : 4);
    titleEl.textContent = `Heart Points Depleted (0/${maxHp} HP) • Level ${appState.level} Failed (${scoreOutcome.spiDelta} SPI)`;
    titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#A8463B]';
    descEl.textContent = `Out of Heart Points! Level ${appState.level} will restart from Round 1 (-5 SPI failure penalty). ${scoreOutcome.feedbackDetail}`;
  } else if (isTimeout) {
    titleEl.textContent = `Time Expired • 0 pts (${scoreOutcome.spiDelta} SPI)`;
    titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#A8463B]';
    descEl.textContent = scoreOutcome.feedbackDetail;
  } else if (scoreOutcome.accuracy >= 85) {
    titleEl.textContent = `High Precision! +${scoreOutcome.scorePoints} pts (${scoreOutcome.accuracy}% Accuracy • +${scoreOutcome.spiDelta} SPI)`;
    titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#5E6B50]';
    descEl.textContent = scoreOutcome.feedbackDetail;
  } else if (scoreOutcome.passed) {
    titleEl.textContent = `Target Matched! +${scoreOutcome.scorePoints} pts (${scoreOutcome.accuracy}% Accuracy • +${scoreOutcome.spiDelta} SPI)`;
    titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#5E6B50]';
    descEl.textContent = scoreOutcome.feedbackDetail;
  } else if (scoreOutcome.isNearMiss) {
    titleEl.textContent = `Close Estimate! +${scoreOutcome.scorePoints} pts (${scoreOutcome.accuracy}% Accuracy • 0 HP Lost • ${scoreOutcome.spiDelta >= 0 ? '+' : ''}${scoreOutcome.spiDelta} SPI)`;
    titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#9E7B42]';
    descEl.textContent = scoreOutcome.feedbackDetail;
  } else {
    titleEl.textContent = `Missed Target • ${scoreOutcome.accuracy}% Accuracy (${scoreOutcome.spiDelta} SPI)`;
    titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#A8463B]';
    descEl.textContent = scoreOutcome.feedbackDetail;
  }

  // Auto-advance during EQ Cheetah 60s Blitz
  if (appState.gameMode === 'cheetah' && appState.cheetahRunning && !appState.mockExamActive) {
    setTimeout(() => {
      if (appState.cheetahRunning) {
        appState.round++;
        updateArenaHUD();
        setupNextArenaRound();
      }
    }, 520);
    return;
  }

  if (appState.mockExamActive) {
    const isLastMockQ = appState.mockCursor >= appState.mockQueue.length - 1;
    document.getElementById('txt-arena-submit').textContent =
      isLastMockQ ? 'Finish Exam & View Report (Enter)' : 'Next Exam Question (Enter)';
    document.getElementById('icon-arena-submit').className = 'fa-solid fa-arrow-right';
    return;
  }

  const isStageOver = appState.lives <= 0 || appState.round >= appState.maxRounds;
  document.getElementById('txt-arena-submit').textContent = appState.lives <= 0
    ? `Restart Level ${appState.level} (Enter)`
    : (isStageOver ? 'Complete Session (Enter)' : 'Next Round (Enter)');
  document.getElementById('icon-arena-submit').className = 'fa-solid fa-arrow-right';
  } catch (err) {
    appState.roundSubmitted = false;
    throw err;
  } finally {
    appState.roundSubmittingLock = false;
  }
}

function recordCompletedGameSessionStats(gameId, sessionScore) {
  const root = getActiveDataRoot();
  const rec = root.gameStats[gameId];
  if (!rec) return;
  rec.sessionsCompleted = (rec.sessionsCompleted || 0) + 1;
  if (sessionScore > 0) {
    const prevScore = rec.lastScore || rec.highScore || sessionScore;
    rec.lastDelta = sessionScore - prevScore;
    rec.lastScore = sessionScore;
    if (sessionScore > (rec.highScore || 0)) {
      rec.highScore = sessionScore;
    }
  }
}

function proceedAfterRoundReveal() {
  markUserTrainingInteraction();

  // 1. Mock Exam Queue Progression
  if (appState.mockExamActive) {
    appState.mockCursor++;
    if (appState.mockCursor >= appState.mockQueue.length) {
      finishMockTestExam();
      return;
    }
    loadCurrentMockQueueItem();
    return;
  }

  // 2. Out of Heart Points -> Fail & Restart Current Level from Round 1 (-5 SPI Penalty)
  if (appState.lives <= 0) {
    const failedLevel = appState.level;
    const failedRound = appState.round;
    const gSpecFail = SG_GAMES[appState.gameMode] || { name: appState.gameMode };
    recordCompletedGameSessionStats(appState.gameMode, appState.score);
    const failPenalty = applyBehavioralSpiChange(-5, {
      type: 'level_failed',
      label: `Level ${failedLevel} Failed (${gSpecFail.name})`,
      detail: `Depleted Heart Points on Round ${failedRound}/${appState.maxRounds}; restarted Level ${failedLevel} from Round 1`,
      skipSyncQueue: true
    });
    endActivePracticeSession('out-of-lives', true);
    queueProgressSync('level-failed-restart');
    restartCurrentArenaGame();
    startOrResumePracticeSession(appState.gameMode, 'practice');

    const titleEl = document.getElementById('arena-feedback-title');
    const descEl = document.getElementById('arena-feedback-desc');
    if (titleEl) {
      titleEl.textContent = `Level ${failedLevel} Restarted (${failPenalty} SPI • ${appState.lives}/${appState.maxLives} HP Restored)`;
      titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#A8463B]';
    }
    if (descEl) {
      descEl.textContent = `Restarting Level ${failedLevel} from Round 1/10 after Heart Point exhaustion.`;
    }
    return;
  }

  // 3. Completed 10 Rounds -> Level Up, Mark Today's Circuit & Award Consistency Bonuses
  if (appState.round >= appState.maxRounds) {
    recordCompletedGameSessionStats(appState.gameMode, appState.score);
    endActivePracticeSession('completed-10-rounds', true);

    const root = getActiveDataRoot();
    if (appState.level < 10) {
      appState.level++;
      document.getElementById('arena-level-select').value = String(appState.level);
      if (appState.level > (root.gameStats[appState.gameMode].maxLevel || 1)) {
        root.gameStats[appState.gameMode].maxLevel = appState.level;
      }
    }

    const todayKey = getLocalDateKey(0);
    const circuitMap = getTodayCircuitCompletionMap();
    const wasCircuitComplete = ['peak', 'bass', 'feedback'].every(k => Boolean(circuitMap[k]));
    if (Object.prototype.hasOwnProperty.call(circuitMap, appState.gameMode)) {
      circuitMap[appState.gameMode] = true;
    }
    const isCircuitCompleteNow = ['peak', 'bass', 'feedback'].every(k => Boolean(circuitMap[k]));

    const habitProfile = typeof computeHabitWeightingProfile === 'function'
      ? computeHabitWeightingProfile(root, todayKey)
      : { weight: 1.0 };
    const setBonus = appState.score >= 4500 ? Math.round(6 * habitProfile.weight) : 2;
    const gSpecDone = SG_GAMES[appState.gameMode] || { name: appState.gameMode };
    applyBehavioralSpiChange(setBonus, {
      type: 'session_completed',
      label: `Completed 10-Round Set (${gSpecDone.name})`,
      detail: `Full-set completion bonus (${habitProfile.weight.toFixed(2)}x habit weight)`,
      skipSyncQueue: true
    });

    if (!wasCircuitComplete && isCircuitCompleteNow && !circuitMap.circuitBonusGranted) {
      circuitMap.circuitBonusGranted = true;
      applyBehavioralSpiChange(15, {
        type: 'daily_circuit',
        label: "Completed Today's 3-Game Circuit",
        detail: 'Peak Master + Bass Detective + Feedback Eliminator',
        behaviorId: `circuit-${todayKey}`,
        skipSyncQueue: true
      });
    }

    queueProgressSync('session-completed');
    sgAudioEngine.playUiCue('levelup', appState.settings.uiSfxEnabled);

    appState.round = 1;
    const nextMaxHp = typeof getMaxHeartsForLevel === 'function' ? getMaxHeartsForLevel(appState.level) : 4;
    appState.maxLives = nextMaxHp;
    appState.lives = nextMaxHp;
    appState.score = 0;
    startOrResumePracticeSession(appState.gameMode, 'practice');
    updateArenaHUD();
    setupNextArenaRound();

    const titleEl = document.getElementById('arena-feedback-title');
    titleEl.textContent = `Session Complete! +${setBonus} SPI Bonus • Advanced to Level ${appState.level}.`;
    titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#5E6B50]';
    return;
  }

  appState.round++;
  updateArenaHUD();
  setupNextArenaRound();
}

/********************************************************************
 * SPECIALIZED DECK CONTROLLERS (KNIGHT, FILTER, FEEDBACK, CHEETAH)
 ********************************************************************/
function renderKnight4Cards() {
  const grid = document.getElementById('knight-options-grid');
  if (!grid) return;
  const letters = ['A', 'B', 'C', 'D'];

  grid.innerHTML = appState.knightChoices.map((_, idx) => `
    <button type="button" onclick="selectKnightCard(${idx})" id="knight-opt-${idx}" class="p-2.5 rounded-lg border text-left transition-all flex flex-col gap-1.5 ${
      idx === appState.userKnightIdx
        ? 'bg-[#EAE2D4] border-[#B56D4E]'
        : 'bg-[#FBF8F1] border-[#D8CDBB] hover:border-[#302D28]'
    }">
      <div class="flex items-center justify-between">
        <span class="font-mono-tabular font-bold text-xs text-[#302D28]">Option ${letters[idx]}</span>
        <span class="text-[10px] font-mono-tabular text-[#6E675B]">Key ${idx + 1}</span>
      </div>
      <canvas id="knight-mini-canvas-${idx}" width="210" height="62" class="w-full h-14 bg-[#F4F0E7] rounded border border-[#D8CDBB]"></canvas>
    </button>
  `).join('');

  appState.knightChoices.forEach((curve, idx) => {
    drawMiniKnightCanvas(`knight-mini-canvas-${idx}`, curve);
  });
}

function selectKnightCard(idx) {
  if (appState.roundSubmitted) return;
  markUserTrainingInteraction();
  appState.userKnightIdx = idx;
  sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);
  const letters = ['A', 'B', 'C', 'D'];
  document.getElementById('arena-readout-user').textContent = `Option ${letters[idx]}`;

  for (let i = 0; i < 4; i++) {
    const btn = document.getElementById(`knight-opt-${i}`);
    if (!btn) continue;
    btn.className = i === idx
      ? 'p-2.5 rounded-lg border text-left transition-all flex flex-col gap-1.5 bg-[#EAE2D4] border-[#B56D4E]'
      : 'p-2.5 rounded-lg border text-left transition-all flex flex-col gap-1.5 bg-[#FBF8F1] border-[#D8CDBB] hover:border-[#302D28]';
  }
}

function highlightKnightCardsAfterSubmit() {
  for (let i = 0; i < 4; i++) {
    const btn = document.getElementById(`knight-opt-${i}`);
    if (!btn) continue;
    if (i === appState.targetKnightIdx) {
      btn.className = 'p-2.5 rounded-lg border-2 border-[#5E6B50] bg-[#E6ECE0] text-left flex flex-col gap-1.5';
    } else if (i === appState.userKnightIdx && appState.userKnightIdx !== appState.targetKnightIdx) {
      btn.className = 'p-2.5 rounded-lg border-2 border-[#A8463B] bg-[#F5E4E1] text-left flex flex-col gap-1.5';
    }
  }
}

function drawMiniKnightCanvas(id, curve) {
  const c = document.getElementById(id);
  if (!c || !curve) return;
  const ctx = getGpu2dContext(c, false);
  if (!ctx) return;
  const w = c.width, h = c.height;
  ctx.fillStyle = getThemeColor('--sg-surface', '#FBF8F1');
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = getThemeColor('--sg-border', '#D8CDBB');
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

  ctx.strokeStyle = getThemeColor('--sg-terracotta', '#B56D4E');
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const f = Math.pow(10, Math.log10(20) + (x / w) * (Math.log10(20000) - Math.log10(20)));
    const db = EarlisthenicAudioEngine.computeBiquadMagnitudeDb(f, curve.b1.type, curve.b1.freq, curve.b1.gain, curve.b1.q, 48000)
             + EarlisthenicAudioEngine.computeBiquadMagnitudeDb(f, curve.b2.type, curve.b2.freq, curve.b2.gain, curve.b2.q, 48000);
    const y = (h / 2) - (db / 18) * (h * 0.42);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function selectFilterType(fType, silent = false) {
  if (appState.roundSubmitted && !silent) return;
  appState.userFilterType = fType;
  if (!silent) {
    markUserTrainingInteraction();
    sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);
  }
  ['lowpass', 'highpass', 'bandpass', 'notch'].forEach(t => {
    const btn = document.getElementById(`fbtn-${t}`);
    if (!btn) return;
    btn.className = t === fType
      ? 'px-3 py-1.5 rounded-lg border border-[#B56D4E] bg-[#B56D4E] text-[#FBF8F1] text-xs font-semibold flex items-center justify-center gap-2 transition'
      : 'px-3 py-1.5 rounded-lg border border-[#D8CDBB] bg-[#FBF8F1] text-[#302D28] text-xs font-semibold flex items-center justify-center gap-2 transition';
  });
  updateUserCoordinateReadout();
  if (appState.listenState === 'user') applyCurrentArenaDspToEngine();
}

function renderIso20GraphicEQ() {
  const container = document.getElementById('iso-faders-container');
  if (!container) return;
  container.innerHTML = ISO_20_BANDS.map(hz => {
    const isSelected = appState.userFreq === hz;
    const isTargetReveal = appState.roundSubmitted && appState.targetFreq === hz;
    const lbl = hz >= 1000 ? (hz / 1000) + 'k' : hz;

    let cls = 'border-[#D8CDBB] bg-[#FBF8F1] text-[#302D28] hover:border-[#B56D4E]';
    if (isTargetReveal) cls = 'border-[#5E6B50] bg-[#E6ECE0] text-[#5E6B50] font-bold';
    else if (isSelected) cls = 'border-[#B56D4E] bg-[#EAE2D4] text-[#B56D4E] font-bold';

    return `
      <button type="button" onclick="selectIsoFeedbackBand(${hz})" class="flex flex-col items-center justify-between py-2 px-0.5 rounded-lg border transition-all ${cls}" aria-label="ISO Band ${lbl} Hz">
        <span class="text-[8px] font-mono-tabular opacity-75">${isSelected ? '-24dB' : '0dB'}</span>
        <div class="w-1.5 h-11 bg-[#EAE2D4] rounded-full relative my-1 overflow-hidden">
          <div class="w-full rounded-full transition-all ${isSelected ? 'h-full bg-[#A8463B]' : 'h-2.5 bg-[#526069]'}" style="margin-top: ${isSelected ? '26px' : '4px'}"></div>
        </div>
        <span class="text-[9px] font-mono-tabular font-semibold">${lbl}</span>
      </button>
    `;
  }).join('');
}

function selectIsoFeedbackBand(hz) {
  if (appState.roundSubmitted) return;
  markUserTrainingInteraction();
  appState.userFreq = hz;
  sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);
  document.getElementById('feedback-fader-status').textContent = `Selected Notch: ${formatHz(hz)}`;
  updateUserCoordinateReadout();
  applyCurrentArenaDspToEngine();
  renderIso20GraphicEQ();
}

function startCheetah60sBlitz() {
  stopCheetah60sBlitz();
  markUserTrainingInteraction();
  appState.cheetahRunning = true;
  if (appState.activeSession) {
    appState.activeSession.cheetahBlitzActive = true;
  }
  appState.cheetahSecLeft = 60.0;
  appState.lastTickSecond = 11;
  appState.score = 0;
  appState.round = 1;
  updateArenaHUD();
  if (!appState.isPlaying) startAudioPlayback();
  setupNextArenaRound();

  appState.cheetahInterval = setInterval(() => {
    appState.cheetahSecLeft = Math.max(0, appState.cheetahSecLeft - 0.1);
    const txtEl = document.getElementById('cheetah-countdown-txt');
    if (txtEl) txtEl.textContent = appState.cheetahSecLeft.toFixed(1);

    const wholeSec = Math.ceil(appState.cheetahSecLeft);
    if (wholeSec <= 10 && wholeSec > 0 && wholeSec < appState.lastTickSecond) {
      appState.lastTickSecond = wholeSec;
      sgAudioEngine.playUiCue('tick', appState.settings.uiSfxEnabled);
    }
    if (appState.cheetahSecLeft <= 0) {
      const blitzFinalScore = appState.score;
      const blitzRounds = appState.round;
      if (appState.activeSession) {
        appState.activeSession.cheetahBlitzActive = false;
      }
      stopCheetah60sBlitz();
      recordCompletedGameSessionStats('cheetah', blitzFinalScore);
      endActivePracticeSession('cheetah-60s-ended', true);
      if (blitzFinalScore > 0 && blitzRounds >= 5) {
        applyBehavioralSpiChange(5, {
          type: 'session_completed',
          label: `Completed 60s EQ Blitz (${blitzRounds} rounds)`,
          detail: 'Full 60-second blitz completion bonus',
          skipSyncQueue: true
        });
      }
      queueProgressSync('cheetah-finished');
      sgAudioEngine.playUiCue('levelup', appState.settings.uiSfxEnabled);

      // IMPORTANT: Do NOT mark Peak Master (`peak`) as completed when Cheetah ends!
      const titleEl = document.getElementById('arena-feedback-title');
      const descEl = document.getElementById('arena-feedback-desc');
      if (titleEl) {
        titleEl.textContent = `60s Blitz Complete! Final Score: ${blitzFinalScore.toLocaleString()} pts across ${blitzRounds} rounds.`;
        titleEl.className = 'font-serif-editorial font-bold text-sm sm:text-base text-[#5E6B50]';
      }
      if (descEl) {
        descEl.textContent = 'Click "Start 60s Blitz" to run another speed challenge or view your stats in Progress & Analytics.';
      }
    }
  }, 100);
}

function stopCheetah60sBlitz() {
  appState.cheetahRunning = false;
  if (appState.cheetahInterval) {
    clearInterval(appState.cheetahInterval);
    appState.cheetahInterval = null;
  }
}

/********************************************************************
 * ARENA CANVAS RENDERING & POINTER/KEYBOARD INTERACTION (GPU HiDPI)
 ********************************************************************/
let arenaCanvas = null;
let arenaCtx = null;
let arenaInteractionInitialized = false;

function ensureArenaCanvasInit() {
  if (!arenaCanvas && typeof document !== 'undefined') {
    arenaCanvas = document.getElementById('arena-main-canvas');
    if (arenaCanvas) {
      arenaCtx = getGpu2dContext(arenaCanvas, true);
    }
  }
  return Boolean(arenaCanvas && arenaCtx);
}

let arenaGridCacheCanvas = null;
let arenaGridCacheKey = '';
let arenaFftPeakHold = new Float32Array(0);
let fftByteBuffer = new Uint8Array(2048);

function invalidateArenaGridCache() {
  arenaGridCacheKey = '';
}

function resizeArenaCanvas() {
  ensureArenaCanvasInit();
  if (!arenaCanvas || !arenaCanvas.parentElement || !arenaCtx) return;
  const rect = arenaCanvas.parentElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const profile = detectGraphicsCapabilityProfile();
  if (typeof sgAudioEngine !== 'undefined' && sgAudioEngine.setFftSize) {
    sgAudioEngine.setFftSize(profile.fftSize);
  }
  const dpr = profile.dpr;
  arenaCanvas.width = Math.round(rect.width * dpr);
  arenaCanvas.height = Math.round(rect.height * dpr);
  arenaCanvas.style.width = rect.width + 'px';
  arenaCanvas.style.height = rect.height + 'px';
  arenaCanvas._logicalW = rect.width;
  arenaCanvas._logicalH = rect.height;
  arenaCanvas._dpr = dpr;
  arenaCanvas._cachedRect = arenaCanvas.getBoundingClientRect();
  arenaCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  invalidateArenaGridCache();
}

window.addEventListener('resize', () => {
  invalidateGraphicsCapabilityProfile();
  resizeArenaCanvas();
  drawGlobalWaveform();
  if (appState.currentView === 'dashboard' || appState.currentView === 'stats') {
    renderSpiAnalyticsDashboard({ chartsOnly: true });
  }
});

function getStageFreqBounds() {
  // Unified documented Bass Detective bounds: 50 Hz – 400 Hz
  return appState.gameMode === 'bass' ? { min: 50, max: 400 } : { min: 20, max: 20000 };
}

function freqToStageX(freq, width) {
  const b = getStageFreqBounds();
  const minL = Math.log10(b.min);
  const maxL = Math.log10(b.max);
  return ((Math.log10(Math.max(b.min, Math.min(b.max, freq))) - minL) / (maxL - minL)) * width;
}

function stageXToFreq(x, width) {
  const b = getStageFreqBounds();
  const minL = Math.log10(b.min);
  const maxL = Math.log10(b.max);
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
  return Math.pow(10, minL + ratio * (maxL - minL));
}

function dbToStageY(db, height) {
  return (height / 2) - (db / 18) * (height * 0.42);
}

function stageYToDb(y, height) {
  const db = ((height / 2 - y) / (height * 0.42)) * 18;
  return Math.max(-15, Math.min(15, Math.round(db * 2) / 2));
}

let _studioRafRunning = false;
let _lastPeakText = '';
let _lastPeakClass = '';

function ensureStudioAnimationLoopRunning() {
  if (_studioRafRunning || document.hidden) return;
  _studioRafRunning = true;
  requestAnimationFrame(renderStudioAnimationFrame);
}

function renderStudioAnimationFrame() {
  // Pause rAF loop completely while tab/window is hidden; visibilitychange restarts it
  if (document.hidden) {
    _studioRafRunning = false;
    return;
  }

  // Update transport waveform playhead & peak meter when playing
  if (appState.isPlaying && sgAudioEngine.audioCtx) {
    const buf = sgSourceManager.getActiveBuffer();
    if (buf) {
      const dur = buf.duration;
      const curSec = getCurrentPlaybackPositionSec(buf);
      updatePlayheadUI(curSec, dur);
    }

    if (typeof sgAudioEngine.scheduleLoopBoundaryFades === 'function') {
      sgAudioEngine.scheduleLoopBoundaryFades(8.0);
    }

    if (sgAudioEngine.postEqAnalyser && fftByteBuffer.length !== sgAudioEngine.postEqAnalyser.frequencyBinCount) {
      fftByteBuffer = new Uint8Array(sgAudioEngine.postEqAnalyser.frequencyBinCount);
    }
    const meter = sgAudioEngine.getSpectrumAndPeakData(
      appState.currentView === 'arena' ? fftByteBuffer : null
    );
    updateMixerPeakMeterUI(meter);
  }

  // Draw Arena canvas only when Arena view is active
  if (appState.currentView === 'arena') {
    ensureArenaCanvasInit();
    if (arenaCanvas && arenaCtx) {
      const profile = detectGraphicsCapabilityProfile();
      const dpr = arenaCanvas._dpr || profile.dpr;
      const w = arenaCanvas._logicalW || (arenaCanvas.width / dpr);
      const h = arenaCanvas._logicalH || (arenaCanvas.height / dpr);
      if (w && h) {
        arenaCtx.fillStyle = getThemeColor('--sg-surface', '#FBF8F1');
        arenaCtx.fillRect(0, 0, w, h);
        drawStandardSpectrumStage(w, h, dpr, profile);
      }
    }
  }

  requestAnimationFrame(renderStudioAnimationFrame);
}

function drawArenaStaticGrid(w, h, gameMode, dpr) {
  const markers = gameMode === 'bass'
    ? [50, 63, 80, 100, 125, 160, 200, 250, 315, 400]
    : [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const curTheme = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || 'auto';
  const isDarkSys = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = curTheme === 'dark' || (curTheme === 'auto' && isDarkSys);
  const cacheKey = `${Math.round(w)}x${Math.round(h)}@${dpr}:${gameMode}:${isDark ? 'dark' : 'light'}`;
  const canCacheOffscreen = typeof document !== 'undefined' && typeof arenaCtx.drawImage === 'function';
  if (canCacheOffscreen && arenaGridCacheCanvas && arenaGridCacheKey === cacheKey) {
    arenaCtx.drawImage(arenaGridCacheCanvas, 0, 0, w, h);
    return;
  }

  let targetCtx = arenaCtx;
  if (canCacheOffscreen) {
    try {
      if (!arenaGridCacheCanvas) arenaGridCacheCanvas = document.createElement('canvas');
      if (arenaGridCacheCanvas && typeof arenaGridCacheCanvas.getContext === 'function') {
        arenaGridCacheCanvas.width = Math.round(w * dpr);
        arenaGridCacheCanvas.height = Math.round(h * dpr);
        const offCtx = arenaGridCacheCanvas.getContext('2d');
        if (offCtx && typeof offCtx.setTransform === 'function') {
          offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          offCtx.fillStyle = getThemeColor('--sg-surface', '#FBF8F1');
          offCtx.fillRect(0, 0, w, h);
          targetCtx = offCtx;
        }
      }
    } catch (e) {
      targetCtx = arenaCtx;
    }
  }

  targetCtx.lineWidth = 1;
  targetCtx.font = '10px "JetBrains Mono", monospace';
  markers.forEach(m => {
    const x = freqToStageX(m, w);
    targetCtx.strokeStyle = m === 1000 ? getThemeColor('--sg-border-strong', '#BFB29C') : getThemeColor('--sg-border', '#EAE2D4');
    targetCtx.beginPath(); targetCtx.moveTo(x, 0); targetCtx.lineTo(x, h); targetCtx.stroke();
    targetCtx.fillStyle = getThemeColor('--sg-muted', '#6E675B');
    targetCtx.fillText(m >= 1000 ? (m / 1000) + 'k' : m + 'Hz', x + 4, h - 10);
  });

  [-12, -6, 0, 6, 12].forEach(db => {
    const y = dbToStageY(db, h);
    targetCtx.strokeStyle = db === 0 ? getThemeColor('--sg-border-strong', '#BFB29C') : getThemeColor('--sg-border', '#EAE2D4');
    targetCtx.beginPath(); targetCtx.moveTo(0, y); targetCtx.lineTo(w, y); targetCtx.stroke();
    targetCtx.fillStyle = getThemeColor('--sg-muted', '#6E675B');
    targetCtx.fillText((db > 0 ? '+' : '') + db + ' dB', 8, y - 4);
  });

  if (targetCtx !== arenaCtx) {
    arenaGridCacheKey = cacheKey;
    arenaCtx.drawImage(arenaGridCacheCanvas, 0, 0, w, h);
  }
}

let _arenaFreqLut = new Float32Array(0);
let _arenaFreqLutKey = '';
let _arenaUserCurveY = new Float32Array(0);
let _arenaUserCurveKey = '';
let _arenaTargetCurveY = new Float32Array(0);
let _arenaTargetCurveKey = '';

function getOrBuildArenaFreqLut(w, stepPx, gameMode) {
  const sampleCount = Math.floor(w / stepPx) + 1;
  const lutKey = `${Math.round(w)}:${stepPx}:${gameMode}`;
  if (_arenaFreqLutKey === lutKey && _arenaFreqLut.length === sampleCount) {
    return _arenaFreqLut;
  }
  const lut = new Float32Array(sampleCount);
  const b = getStageFreqBounds();
  const minL = Math.log10(b.min);
  const spanL = Math.log10(b.max) - minL;
  const invW = 1 / Math.max(1, w);
  for (let i = 0; i < sampleCount; i++) {
    const x = i * stepPx;
    const ratio = Math.max(0, Math.min(1, x * invW));
    lut[i] = Math.pow(10, minL + ratio * spanL);
  }
  _arenaFreqLut = lut;
  _arenaFreqLutKey = lutKey;
  return lut;
}

function drawStandardSpectrumStage(w, h, dpr, profile) {
  const cap = profile || detectGraphicsCapabilityProfile();
  const stepPx = cap.spectrumStepPx || 1;
  drawArenaStaticGrid(w, h, appState.gameMode, dpr || cap.dpr);

  // High-Resolution Log-Interpolated FFT Spectrum + Peak-Hold Trace using precomputed Freq LUT
  const sr = (sgAudioEngine.audioCtx && sgAudioEngine.audioCtx.sampleRate) || 48000;
  const freqLut = getOrBuildArenaFreqLut(w, stepPx, appState.gameMode);
  const sampleCount = freqLut.length;

  if (appState.isPlaying && fftByteBuffer.length > 0) {
    const bins = fftByteBuffer.length;
    const binScale = bins / (sr * 0.5);
    if (arenaFftPeakHold.length < sampleCount) {
      arenaFftPeakHold = new Float32Array(sampleCount);
    }

    arenaCtx.fillStyle = 'rgba(82, 96, 105, 0.14)';
    arenaCtx.strokeStyle = 'rgba(82, 96, 105, 0.55)';
    arenaCtx.lineWidth = 1.4;
    arenaCtx.beginPath();
    arenaCtx.moveTo(0, h);

    const hScale = h * 0.76;
    for (let i = 0; i < sampleCount; i++) {
      const f = freqLut[i];
      const exactBin = Math.min(bins - 1, Math.max(0, f * binScale));
      const b0 = exactBin | 0;
      const b1 = b0 + 1 < bins ? b0 + 1 : bins - 1;
      const frac = exactBin - b0;
      const norm = (fftByteBuffer[b0] * (1 - frac) + fftByteBuffer[b1] * frac) / 255.0;
      if (norm >= arenaFftPeakHold[i]) {
        arenaFftPeakHold[i] = norm;
      } else {
        arenaFftPeakHold[i] *= 0.986;
      }
      arenaCtx.lineTo(i * stepPx, h - norm * hScale);
    }
    arenaCtx.lineTo(w, h);
    arenaCtx.closePath();
    arenaCtx.fill();
    arenaCtx.stroke();

    // Subtle peak-hold trace
    arenaCtx.strokeStyle = 'rgba(181, 109, 78, 0.28)';
    arenaCtx.lineWidth = 1;
    arenaCtx.beginPath();
    for (let i = 0; i < sampleCount; i++) {
      const y = h - arenaFftPeakHold[i] * hScale;
      if (i === 0) arenaCtx.moveTo(0, y); else arenaCtx.lineTo(i * stepPx, y);
    }
    arenaCtx.stroke();
  }

  if (appState.gameMode === 'knight') return;

  // User Linear-Phase EQ Target Curve (cached Y coords eliminate per-frame trig recomputation)
  const uX = freqToStageX(appState.userFreq, w);
  let uGain = Math.abs(appState.targetGain);
  let uType = 'peaking';
  let uQ = appState.targetQ;

  if (appState.gameMode === 'cut') uGain = -Math.abs(appState.targetGain) - 1.5;
  else if (appState.gameMode === 'mirror') uGain = appState.userGain;
  else if (appState.gameMode === 'filter') {
    uType = appState.userFilterType;
    uGain = 0;
    uQ = uType === 'notch' ? 4.5 : (uType === 'bandpass' ? 2.2 : 0.707);
  } else if (appState.gameMode === 'feedback') {
    uType = 'notch';
    uGain = 0;
    uQ = 10.0;
  }

  const uCurveKey = `${sampleCount}:${Math.round(h)}:${sr}:${appState.gameMode}:${uType}:${appState.userFreq}:${uGain}:${uQ}`;
  if (_arenaUserCurveKey !== uCurveKey || _arenaUserCurveY.length !== sampleCount) {
    if (_arenaUserCurveY.length !== sampleCount) _arenaUserCurveY = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const db = EarlisthenicAudioEngine.computeBiquadMagnitudeDb(freqLut[i], uType, appState.userFreq, uGain, uQ, sr);
      _arenaUserCurveY[i] = dbToStageY(db, h);
    }
    _arenaUserCurveKey = uCurveKey;
  }

  arenaCtx.strokeStyle = '#B56D4E';
  arenaCtx.lineWidth = 2.4;
  arenaCtx.beginPath();
  for (let i = 0; i < sampleCount; i++) {
    const x = i * stepPx;
    const y = _arenaUserCurveY[i];
    if (i === 0) arenaCtx.moveTo(x, y); else arenaCtx.lineTo(x, y);
  }
  arenaCtx.stroke();

  const uY = dbToStageY(uType === 'peaking' ? uGain : 0, h);
  arenaCtx.fillStyle = '#B56D4E';
  arenaCtx.beginPath(); arenaCtx.arc(uX, uY, 7, 0, Math.PI * 2); arenaCtx.fill();

  // Target Answer Reveal Curve
  if (appState.roundSubmitted) {
    const tX = freqToStageX(appState.targetFreq, w);
    let tGain = Math.abs(appState.targetGain);
    let tType = 'peaking';
    let tQ = appState.targetQ;

    if (appState.gameMode === 'cut') tGain = -Math.abs(appState.targetGain) - 1.5;
    else if (appState.gameMode === 'mirror') tGain = appState.targetGain;
    else if (appState.gameMode === 'filter') {
      tType = appState.targetFilterType;
      tGain = 0;
      tQ = tType === 'notch' ? 4.5 : (tType === 'bandpass' ? 2.2 : 0.707);
    } else if (appState.gameMode === 'feedback') {
      tType = 'notch';
      tGain = 0;
      tQ = 10.0;
    }

    const tCurveKey = `${sampleCount}:${Math.round(h)}:${sr}:${appState.gameMode}:${tType}:${appState.targetFreq}:${tGain}:${tQ}`;
    if (_arenaTargetCurveKey !== tCurveKey || _arenaTargetCurveY.length !== sampleCount) {
      if (_arenaTargetCurveY.length !== sampleCount) _arenaTargetCurveY = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const db = EarlisthenicAudioEngine.computeBiquadMagnitudeDb(freqLut[i], tType, appState.targetFreq, tGain, tQ, sr);
        _arenaTargetCurveY[i] = dbToStageY(db, h);
      }
      _arenaTargetCurveKey = tCurveKey;
    }

    arenaCtx.fillStyle = 'rgba(94, 107, 80, 0.12)';
    arenaCtx.fillRect(Math.min(uX, tX), 0, Math.abs(tX - uX), h);

    arenaCtx.strokeStyle = '#5E6B50';
    arenaCtx.lineWidth = 2.4;
    arenaCtx.setLineDash([6, 4]);
    arenaCtx.beginPath();
    for (let i = 0; i < sampleCount; i++) {
      const x = i * stepPx;
      const y = _arenaTargetCurveY[i];
      if (i === 0) arenaCtx.moveTo(x, y); else arenaCtx.lineTo(x, y);
    }
    arenaCtx.stroke();
    arenaCtx.setLineDash([]);

    const tY = dbToStageY(tType === 'peaking' ? tGain : 0, h);
    arenaCtx.fillStyle = '#5E6B50';
    arenaCtx.beginPath(); arenaCtx.arc(tX, tY, 7, 0, Math.PI * 2); arenaCtx.fill();
  }
}

let _lastArenaReadoutText = '';
let _lastStageBandName = '';
let _lastStyledListenState = '';

function updateStageFromPointer(clientX, clientY) {
  if (appState.roundSubmitted || appState.gameMode === 'knight') return;
  markUserTrainingInteraction();
  const rect = (arenaCanvas._cachedRect && arenaCanvas._cachedRect.width > 0)
    ? arenaCanvas._cachedRect
    : arenaCanvas.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) return;

  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));

  const prevFreq = appState.userFreq;
  const prevGain = appState.userGain;
  const prevPan = appState.userPan;

  const rawHz = stageXToFreq(x, rect.width);
  if (appState.gameMode === 'feedback') {
      let bestBand = ISO_20_BANDS[0], minD = Infinity;
      for (let i = 0; i < ISO_20_BANDS.length; i++) {
        const b = ISO_20_BANDS[i];
        const d = Math.abs(Math.log2(rawHz / b));
        if (d < minD) { minD = d; bestBand = b; }
      }
      if (bestBand !== prevFreq) {
        appState.userFreq = bestBand;
        renderIso20GraphicEQ();
      }
    } else {
      appState.userFreq = Math.round(rawHz);
    }

    if (appState.gameMode === 'mirror') {
      appState.userGain = stageYToDb(y, rect.height);
    }

  const changed = appState.userFreq !== prevFreq || appState.userGain !== prevGain || appState.userPan !== prevPan;
  if (!changed && appState.listenState === _lastStyledListenState) {
    return;
  }

  updateUserCoordinateReadout();
  if (['mirror', 'cheetah'].includes(appState.gameMode) && appState.isDraggingStage) {
    if (appState.listenState !== 'user') {
      setArenaListenState('user');
    } else {
      applyCurrentArenaDspToEngine();
    }
  } else if (appState.listenState === 'user' || appState.gameMode === 'feedback') {
    applyCurrentArenaDspToEngine();
  }
}

// Unified Pointer Events on Arena Canvas
function initArenaCanvasInteraction() {
  if (arenaInteractionInitialized) return;
  if (!ensureArenaCanvasInit()) return;
  arenaInteractionInitialized = true;

  arenaCanvas.addEventListener('pointerdown', (e) => {
    arenaCanvas._cachedRect = arenaCanvas.getBoundingClientRect();
    appState.isDraggingStage = true;
    try { arenaCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    updateStageFromPointer(e.clientX, e.clientY);
  });
  arenaCanvas.addEventListener('pointermove', (e) => {
    if (appState.isDraggingStage) {
      updateStageFromPointer(e.clientX, e.clientY);
    }
  });
  const endStagePointer = (e) => {
    if (appState.isDraggingStage) {
      appState.isDraggingStage = false;
      try { arenaCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
      // Commit settled coordinates cleanly onto exact 8191-tap Linear-Phase FIR Convolver
      if (appState.listenState === 'user' || appState.gameMode === 'feedback') {
        applyCurrentArenaDspToEngine();
      }
    }
  };
  arenaCanvas.addEventListener('pointerup', endStagePointer);
  arenaCanvas.addEventListener('pointercancel', endStagePointer);
}

function toggleSignatureEqPill() {
  markUserTrainingInteraction();
  sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);
  setArenaListenState(appState.listenState === 'original' ? 'target' : 'original');
}

function setArenaListenState(newState) {
  const prevState = appState.listenState;
  appState.listenState = newState;

  if (_lastStyledListenState !== newState || prevState !== newState) {
    _lastStyledListenState = newState;
    const pillBtn = document.getElementById('btn-signature-eq-pill');
    const pillTxt = document.getElementById('txt-signature-eq-pill');

    if (newState === 'original') {
      pillBtn.className = 'btn-outline-washi h-8 w-[248px] shrink-0 px-3 rounded-lg font-semibold text-xs uppercase tracking-wider inline-flex items-center justify-between gap-2 whitespace-nowrap';
      pillTxt.textContent = 'Flat / Original Bypass';
    } else if (newState === 'target') {
      pillBtn.className = 'btn-terracotta h-8 w-[248px] shrink-0 px-3 rounded-lg font-semibold text-xs uppercase tracking-wider inline-flex items-center justify-between gap-2 whitespace-nowrap';
      pillTxt.textContent = 'Target EQ Active';
    } else {
      pillBtn.className = 'btn-moss h-8 w-[248px] shrink-0 px-3 rounded-lg font-semibold text-xs uppercase tracking-wider inline-flex items-center justify-between gap-2 whitespace-nowrap';
      pillTxt.textContent = 'Auditioning Your EQ';
    }

    const btnMap = {
      original: document.getElementById('ab-btn-flat'),
      target: document.getElementById('ab-btn-target'),
      user: document.getElementById('ab-btn-user')
    };
    Object.keys(btnMap).forEach(k => {
      const b = btnMap[k];
      if (!b) return;
      const isDisabled = Boolean(b.disabled);
      b.className = k === newState
        ? 'h-full w-full px-1.5 rounded border border-[#965438] bg-[#B56D4E] text-[#FBF8F1] inline-flex items-center justify-center whitespace-nowrap transition'
        : `h-full w-full px-1.5 rounded border border-transparent text-[#6E675B] hover:text-[#302D28] inline-flex items-center justify-center whitespace-nowrap transition${isDisabled ? ' opacity-40 cursor-not-allowed pointer-events-none' : ''}`;
    });
  }

  applyCurrentArenaDspToEngine();
}

function updateUserCoordinateReadout() {
  const el = document.getElementById('arena-readout-user');
  if (el) {
    let nextText;
    if (appState.gameMode === 'mirror') {
      nextText = `${formatHz(appState.userFreq)} (${appState.userGain > 0 ? '+' : ''}${appState.userGain} dB)`;
    } else if (appState.gameMode === 'filter') {
      nextText = `${appState.userFilterType.toUpperCase()} @ ${formatHz(appState.userFreq)}`;
    } else {
      nextText = formatHz(appState.userFreq);
    }
    if (nextText !== _lastArenaReadoutText) {
      _lastArenaReadoutText = nextText;
      el.textContent = nextText;
    }
  }
  const bandEl = document.getElementById('stage-band-label');
  if (bandEl) {
    const bandName = describeFreqBand(appState.userFreq);
    if (bandName !== _lastStageBandName) {
      _lastStageBandName = bandName;
      bandEl.innerHTML = `Acoustic Band: <span class="text-[#302D28] font-semibold">${bandName}</span>`;
    }
  }
}

function updateArenaHUD() {
  document.getElementById('arena-hud-level').textContent = `LVL ${appState.level}`;
  document.getElementById('arena-hud-round').textContent = String(appState.round);
  document.getElementById('arena-hud-max-rounds').textContent = String(appState.maxRounds);
  document.getElementById('arena-hud-score').textContent = appState.score.toLocaleString();

  const totalHp = appState.maxLives || (typeof getMaxHeartsForLevel === 'function' ? getMaxHeartsForLevel(appState.level) : 4);
  const livesKey = `${appState.lives}/${totalHp}`;
  const livesEl = document.getElementById('arena-hud-lives');
  if (livesEl && livesEl._lastHpKey !== livesKey) {
    livesEl._lastHpKey = livesKey;
    let heartsHtml = '';
    for (let i = 0; i < totalHp; i++) {
      heartsHtml += `<i class="fa-solid fa-heart ${i < appState.lives ? 'text-[#B56D4E]' : 'text-[#D8CDBB]'}" aria-hidden="true"></i> `;
    }
    livesEl.innerHTML = heartsHtml;
    livesEl.setAttribute('aria-label', `${appState.lives} of ${totalHp} heart points remaining`);
  }
  const hpTxtEl = document.getElementById('arena-hud-hp-txt');
  if (hpTxtEl && hpTxtEl.textContent !== livesKey) {
    hpTxtEl.textContent = livesKey;
  }
}

function updateDailyGoalMinutes(val) {
  const mins = Math.max(5, Math.min(180, parseInt(val, 10) || 15));
  appState.settings.dailyGoalMinutes = mins;
  getActiveDataRoot().settings.dailyGoalMinutes = mins;
  const pSelect = document.getElementById('profile-daily-goal-select');
  if (pSelect) pSelect.value = String(mins);
  const sSelect = document.getElementById('stats-daily-goal-select');
  if (sSelect) sSelect.value = String(mins);
  const dashMins = document.getElementById('dashboard-today-goal-mins');
  if (dashMins) dashMins.textContent = String(mins);
  updatePracticeClockDisplayOnly();
  updateGlobalHeaderTrackingUI();
  if (typeof renderSpiAnalyticsDashboard === 'function') renderSpiAnalyticsDashboard();
  queueProgressSync('daily-goal');
}

// -------------------------------------------------------------
// Studio Command Palette Controller (Cmd/Ctrl + K)
// -------------------------------------------------------------
let commandPaletteSelectedIndex = 0;
let commandPaletteFilteredItems = [];

const COMMAND_PALETTE_COMMANDS = [
  // Exercises
  { id: 'game-peak', category: 'Exercise', title: 'Peak Master', desc: 'Identify boost/cut EQ frequencies across spectrum', icon: 'fa-sliders', action: () => launchGameFromLobby('peak') },
  { id: 'game-eq-cut', category: 'Exercise', title: 'Kit Cut', desc: 'Identify resonant frequency cuts on drum elements', icon: 'fa-drum', action: () => launchGameFromLobby('eq_cut') },
  { id: 'game-bass', category: 'Exercise', title: 'Bass Detective', desc: 'Pinpoint low-end sub bass frequencies', icon: 'fa-wave-square', action: () => launchGameFromLobby('bass') },
  { id: 'game-mirror', category: 'Exercise', title: 'EQ Mirror', desc: 'Match complementary boost/cut filter curves', icon: 'fa-clone', action: () => launchGameFromLobby('mirror') },
  { id: 'game-knight', category: 'Exercise', title: 'EQ Knight', desc: 'Multiple-choice critical listening challenge', icon: 'fa-shield-halved', action: () => launchGameFromLobby('knight') },
  { id: 'game-filter', category: 'Exercise', title: 'Filter Expert', desc: 'Identify high-pass, low-pass, and band-pass slopes', icon: 'fa-filter', action: () => launchGameFromLobby('filter') },
  { id: 'game-cheetah', category: 'Exercise', title: 'EQ Cheetah', desc: 'Fast-paced 60-second speed blitz drill', icon: 'fa-bolt', action: () => launchGameFromLobby('cheetah') },
  { id: 'game-feedback', category: 'Exercise', title: 'Feedback Eliminator', desc: '20-band ISO live acoustic feedback notch elimination', icon: 'fa-microphone-slash', action: () => launchGameFromLobby('feedback') },

  // Views & Workspaces
  { id: 'view-lobby', category: 'Navigation', title: 'Go to Exercise Library (Dashboard)', desc: 'View 8 training disciplines and daily workout circuit', icon: 'fa-table-cells-large', action: () => switchMainView('lobby') },
  { id: 'view-arena', category: 'Navigation', title: 'Go to Training Arena', desc: 'Open interactive Web Audio DSP workspace', icon: 'fa-headphones', action: () => switchMainView('arena') },
  { id: 'view-mock', category: 'Navigation', title: 'Go to Mock Test Builder', desc: 'Configured 5-minute timed examination', icon: 'fa-stopwatch', action: () => switchMainView('mock') },
  { id: 'view-about', category: 'Navigation', title: 'Go to About Us & FAQ', desc: 'DSP architecture, FIR filter theory, and platform FAQ', icon: 'fa-circle-info', action: () => switchMainView('about') },

  // Audio Transport & Sources
  { id: 'audio-toggle', category: 'Audio', title: 'Toggle Audio Playback', desc: 'Play / Stop currently loaded audio stream (Space)', icon: 'fa-play', action: () => toggleAudioPlayback() },
  { id: 'audio-drums', category: 'Audio', title: 'Switch Source: Acoustic Drums Loop', desc: 'High-transient drum mix for EQ training', icon: 'fa-drum', action: () => selectStudioLoop('drums') },
  { id: 'audio-bass', category: 'Audio', title: 'Switch Source: Electric Bass Loop', desc: 'Rich low-end fundamental bass groove', icon: 'fa-guitar', action: () => selectStudioLoop('bass') },
  { id: 'audio-synth', category: 'Audio', title: 'Switch Source: Analog Synth Loop', desc: 'Broadband harmonic synthesizer progression', icon: 'fa-keyboard', action: () => selectStudioLoop('synth') },
  { id: 'audio-guitar', category: 'Audio', title: 'Switch Source: Clean Guitar Loop', desc: 'Mid-range acoustic/electric strumming pattern', icon: 'fa-music', action: () => selectStudioLoop('guitar') },
  { id: 'audio-mix', category: 'Audio', title: 'Switch Source: Studio Full Mix Loop', desc: 'Full-spectrum multi-instrument production mix', icon: 'fa-compact-disc', action: () => selectStudioLoop('mix') },
  { id: 'audio-free', category: 'Audio', title: 'Manage FREE AUDIO Library', desc: 'Lossless studio tracks streamed from Google Drive', icon: 'fa-cloud', action: () => openFreeAudioManagerModal() },

  // Actions & Preferences
  { id: 'pref-theme', category: 'Preferences', title: 'Toggle Visual Theme', desc: 'Switch between Studio Dark and Warm Paper Light', icon: 'fa-circle-half-stroke', action: () => toggleThemeClient() },
  { id: 'pref-sfx', category: 'Preferences', title: 'Toggle UI Sound Effects', desc: 'Enable/disable psychoacoustic tactile sound cues', icon: 'fa-volume-high', action: () => toggleUiSfx() },
  { id: 'action-sync', category: 'System', title: 'Sync with Google Drive Now', desc: 'Flush all pending question events to cloud storage', icon: 'fa-rotate', action: () => triggerManualSync() },
  { id: 'action-backup', category: 'System', title: 'Create Drive Backup Snapshot', desc: 'Create an immutable historical backup point on Drive', icon: 'fa-floppy-disk', action: () => createDriveSnapshotBackup('manual') },
  { id: 'action-profile', category: 'Account', title: 'Manage User Profile & Scope', desc: 'View current identity, device ID, and membership status', icon: 'fa-user-shield', action: () => openProfileModal() }
];

function openCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const input = document.getElementById('command-palette-input');
  if (input) {
    input.value = '';
    setTimeout(() => { try { input.focus(); } catch (e) {} }, 20);
  }
  commandPaletteSelectedIndex = 0;
  renderCommandPaletteResults('');
  if (typeof sgAudioEngine !== 'undefined') {
    sgAudioEngine.playUiCue('click', appState.settings.uiSfxEnabled);
  }
}

function closeCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  if (!modal) return;
  modal.classList.add('hidden');
}

function renderCommandPaletteResults(query) {
  const container = document.getElementById('command-palette-results');
  if (!container) return;
  const q = String(query || '').trim().toLowerCase();
  commandPaletteFilteredItems = COMMAND_PALETTE_COMMANDS.filter(cmd => {
    if (!q) return true;
    return cmd.title.toLowerCase().includes(q) ||
           cmd.desc.toLowerCase().includes(q) ||
           cmd.category.toLowerCase().includes(q);
  });

  if (commandPaletteFilteredItems.length === 0) {
    container.innerHTML = `
      <div class="px-4 py-8 text-center text-xs text-[#6E675B] dark:text-[#A89F91]">
        <i class="fa-solid fa-magnifying-glass text-lg mb-2 opacity-40 block" aria-hidden="true"></i>
        No matching studio commands found for "<span class="text-[#B56D51]">${escapeHtml(query)}</span>"
      </div>
    `;
    return;
  }

  if (commandPaletteSelectedIndex >= commandPaletteFilteredItems.length) {
    commandPaletteSelectedIndex = 0;
  }

  let html = '';
  let lastCategory = '';
  commandPaletteFilteredItems.forEach((cmd, idx) => {
    if (cmd.category !== lastCategory) {
      lastCategory = cmd.category;
      html += `
        <div class="px-3 pt-2 pb-1 text-[10px] font-mono-tabular font-bold uppercase tracking-wider text-[#6E675B] dark:text-[#8E8A83]">
          ${cmd.category}
        </div>
      `;
    }
    const isSelected = idx === commandPaletteSelectedIndex;
    html += `
      <div role="button" tabindex="0" onclick="executeCommandPaletteIndex(${idx})" onmouseenter="selectCommandPaletteIndex(${idx})"
           class="px-3 py-2 rounded-xl cursor-pointer flex items-center justify-between gap-3 transition-colors ${isSelected ? 'bg-[#B56D51] text-[#FBF8F1]' : 'hover:bg-[#EAE2D4]/50 dark:hover:bg-[#252C26] text-[#302D28] dark:text-[#EAE2D4]'}">
        <div class="flex items-center gap-2.5 min-w-0">
          <i class="fa-solid ${cmd.icon} w-4 text-center shrink-0 ${isSelected ? 'text-[#FBF8F1]' : 'text-[#B56D51]'}"></i>
          <div class="min-w-0 truncate">
            <div class="text-xs font-semibold truncate leading-tight">${escapeHtml(cmd.title)}</div>
            <div class="text-[10px] truncate ${isSelected ? 'text-[#FBF8F1]/80' : 'text-[#6E675B] dark:text-[#A6B0A3]'}">${escapeHtml(cmd.desc)}</div>
          </div>
        </div>
        <span class="text-[9px] font-mono-tabular px-1.5 py-0.5 rounded ${isSelected ? 'bg-black/20 text-[#FBF8F1]' : 'bg-black/5 dark:bg-white/5 text-[#6E675B] dark:text-[#A89F91]'} shrink-0">↵</span>
      </div>
    `;
  });
  container.innerHTML = html;
}

function selectCommandPaletteIndex(idx) {
  commandPaletteSelectedIndex = idx;
  const items = document.querySelectorAll('#command-palette-results [role="button"]');
  items.forEach((it, i) => {
    if (i === idx) {
      it.classList.add('bg-[#B56D51]', 'text-[#FBF8F1]');
      it.classList.remove('text-[#302D28]', 'dark:text-[#EAE2D4]');
    } else {
      it.classList.remove('bg-[#B56D51]', 'text-[#FBF8F1]');
      it.classList.add('text-[#302D28]', 'dark:text-[#EAE2D4]');
    }
  });
}

function executeCommandPaletteIndex(idx) {
  if (idx >= 0 && idx < commandPaletteFilteredItems.length) {
    const item = commandPaletteFilteredItems[idx];
    closeCommandPalette();
    if (typeof item.action === 'function') {
      item.action();
    }
  }
}

// Accessible Global Studio Hotkeys (Never hijack Tab or interfere with inputs/buttons!)
window.addEventListener('keydown', (e) => {
  // Global Cmd+K / Ctrl+K Command Palette trigger
  if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyK' || e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    const cpModal = document.getElementById('command-palette-modal');
    if (cpModal && !cpModal.classList.contains('hidden')) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
    return;
  }

  // Active Command Palette Modal Keyboard Navigation
  const cpModalActive = document.getElementById('command-palette-modal');
  if (cpModalActive && !cpModalActive.classList.contains('hidden')) {
    if (e.code === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
      return;
    }
    if (e.code === 'ArrowDown') {
      e.preventDefault();
      if (commandPaletteFilteredItems.length > 0) {
        commandPaletteSelectedIndex = (commandPaletteSelectedIndex + 1) % commandPaletteFilteredItems.length;
        renderCommandPaletteResults(document.getElementById('command-palette-input').value);
      }
      return;
    }
    if (e.code === 'ArrowUp') {
      e.preventDefault();
      if (commandPaletteFilteredItems.length > 0) {
        commandPaletteSelectedIndex = (commandPaletteSelectedIndex - 1 + commandPaletteFilteredItems.length) % commandPaletteFilteredItems.length;
        renderCommandPaletteResults(document.getElementById('command-palette-input').value);
      }
      return;
    }
    if (e.code === 'Enter') {
      e.preventDefault();
      executeCommandPaletteIndex(commandPaletteSelectedIndex);
      return;
    }
  }

  if (e.code === 'Escape') {
    const faModal = document.getElementById('free-audio-manager-modal');
    if (faModal && !faModal.classList.contains('hidden')) {
      e.preventDefault();
      closeFreeAudioManagerModal();
      return;
    }
    const profModal = document.getElementById('profile-manager-modal');
    if (profModal && !profModal.classList.contains('hidden')) {
      e.preventDefault();
      closeProfileModal();
      return;
    }
    const migModal = document.getElementById('migration-preview-modal');
    if (migModal && !migModal.classList.contains('hidden')) {
      e.preventDefault();
      closeMigrationPreviewModal();
      return;
    }
    const repModal = document.getElementById('mock-report-modal');
    if (repModal && !repModal.classList.contains('hidden') && typeof closeMockReportModal === 'function') {
      e.preventDefault();
      closeMockReportModal('mock');
      return;
    }
  }

  const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
  const isInteractiveControl = (
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    (e.target && e.target.isContentEditable)
  );
  if (isInteractiveControl) return;

  if (e.code === 'Space') {
    e.preventDefault();
    toggleAudioPlayback();
  } else if (e.code === 'KeyE') {
    // Only KeyE toggles EQ A/B; Tab is strictly preserved for keyboard focus navigation!
    e.preventDefault();
    toggleSignatureEqPill();
  } else if (e.code === 'Enter' && appState.currentView === 'arena') {
    e.preventDefault();
    if (e.repeat) return; // Prevent key repeat while holding Enter
    if (appState.roundSubmittedAt && (performance.now() - appState.roundSubmittedAt < 250)) {
      return; // Prevent accidental double-Enter skip of the reveal screen
    }
    handleArenaPrimaryAction();
  } else if (appState.currentView === 'arena' && appState.gameMode === 'knight' && ['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(e.code)) {
    selectKnightCard(parseInt(e.code.replace('Digit', ''), 10) - 1);
  } else if (appState.currentView === 'arena' && !appState.roundSubmitted && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
    e.preventDefault();
    markUserTrainingInteraction();
    const b = getStageFreqBounds();
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const dir = e.code === 'ArrowRight' ? 1 : -1;
      if (appState.gameMode === 'feedback') {
        const curIdx = Math.max(0, ISO_20_BANDS.indexOf(appState.userFreq));
        const nextIdx = Math.max(0, Math.min(ISO_20_BANDS.length - 1, curIdx + dir));
        selectIsoFeedbackBand(ISO_20_BANDS[nextIdx]);
      } else {
        const factor = Math.pow(2, dir * (1 / 12)); // 1 semitone step
        appState.userFreq = Math.round(Math.max(b.min, Math.min(b.max, appState.userFreq * factor)));
        updateUserCoordinateReadout();
        if (appState.listenState === 'user') {
          appState._kbdSweepingActive = true;
          applyCurrentArenaDspToEngine();
          if (appState._kbdSweepSettleTimer) clearTimeout(appState._kbdSweepSettleTimer);
          appState._kbdSweepSettleTimer = setTimeout(() => {
            appState._kbdSweepingActive = false;
            appState._kbdSweepSettleTimer = null;
            if (appState.listenState === 'user') applyCurrentArenaDspToEngine();
          }, 180);
        }
      }
    } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const dir = e.code === 'ArrowUp' ? 1 : -1;
      if (appState.gameMode === 'mirror') {
        appState.userGain = Math.max(-15, Math.min(15, appState.userGain + dir * 0.5));
        updateUserCoordinateReadout();
        if (appState.listenState === 'user') {
          appState._kbdSweepingActive = true;
          applyCurrentArenaDspToEngine();
          if (appState._kbdSweepSettleTimer) clearTimeout(appState._kbdSweepSettleTimer);
          appState._kbdSweepSettleTimer = setTimeout(() => {
            appState._kbdSweepingActive = false;
            appState._kbdSweepSettleTimer = null;
            if (appState.listenState === 'user') applyCurrentArenaDspToEngine();
          }, 180);
        }
      }
    }
  }
});

let earlisthenicBootstrapped = false;
const _studioResizeObservers = [];

function cleanupStudioResources() {
  if (typeof reconcilePracticeSessionTime === 'function') {
    try { reconcilePracticeSessionTime(); } catch (e) {}
  }
  if (typeof saveStateToLocalCache === 'function') {
    try { saveStateToLocalCache(); } catch (e) {}
  }
  if (_practiceClockIntervalId) {
    clearInterval(_practiceClockIntervalId);
    _practiceClockIntervalId = null;
  }
  if (appState._syncRetryTimer) {
    clearTimeout(appState._syncRetryTimer);
    appState._syncRetryTimer = null;
  }
  if (appState._syncDebounceTimer) {
    clearTimeout(appState._syncDebounceTimer);
    appState._syncDebounceTimer = null;
  }
  if (appState._kbdSweepSettleTimer) {
    clearTimeout(appState._kbdSweepSettleTimer);
    appState._kbdSweepSettleTimer = null;
  }
  while (_studioResizeObservers.length > 0) {
    const obs = _studioResizeObservers.pop();
    try { obs.disconnect(); } catch (e) {}
  }
}

window.addEventListener('beforeunload', cleanupStudioResources);

function bootstrapEarlisthenic() {
  if (earlisthenicBootstrapped) return;
  earlisthenicBootstrapped = true;

  try { applyThemeClient(getThemePreferenceClient()); } catch (e) { console.warn('Theme init warn:', e); }

  const initHp = typeof getMaxHeartsForLevel === 'function' ? getMaxHeartsForLevel(appState.level) : 4;
  appState.maxLives = initHp;
  appState.lives = initHp;

  try { initializePersistenceOnStartup(); } catch (e) { console.warn('Persistence init warn:', e); }

  try {
    const preloadedTracks = getPreloadedFreeAudioTracksClient();
    if (Array.isArray(preloadedTracks) && preloadedTracks.length > 0) {
      applyFreeAudioTracksList(preloadedTracks, false);
    }
  } catch (e) { console.warn('Preload tracks warn:', e); }

  try { renderStudioSourceSelectOptions(); } catch (e) { console.warn('Source options warn:', e); }
  try { initAudioFileInputHandler(); } catch (e) {}
  try { initArenaCanvasInteraction(); } catch (e) {}
  try { startUndergroundMaterialsLoader(); } catch (e) { console.warn('Underground loader warn:', e); }
  try { syncAudioFormatControlsUI(); } catch (e) { console.warn('Audio format warn:', e); }
  try { updateGlobalHeaderTrackingUI(); } catch (e) { console.warn('Header tracking warn:', e); }
  try { updateArenaHUD(); } catch (e) { console.warn('Arena HUD warn:', e); }
  try { checkAuthGatewayOnStartup(); } catch (e) { console.warn('Auth gateway warn:', e); }
  try { initGoogleIdentityServicesClient(); } catch (e) { console.warn('GSI client warn:', e); }
  try { initAboutAccordion(); } catch (e) { console.warn('About accordion warn:', e); }

  try {
    if (typeof ResizeObserver === 'function') {
      const wfBox = document.getElementById('waveform-loop-box');
      if (wfBox) {
        const wfObs = new ResizeObserver(() => drawGlobalWaveform());
        wfObs.observe(wfBox);
        _studioResizeObservers.push(wfObs);
      }
      if (arenaCanvas && arenaCanvas.parentElement) {
        const arenaObs = new ResizeObserver(() => resizeArenaCanvas());
        arenaObs.observe(arenaCanvas.parentElement);
        _studioResizeObservers.push(arenaObs);
      }
      const spiCanvas = document.getElementById('spi-trend-canvas');
      if (spiCanvas && spiCanvas.parentElement) {
        const chartObs = new ResizeObserver(() => {
          if (typeof redrawAnalyticsChartsOnly === 'function') {
            redrawAnalyticsChartsOnly();
          }
        });
        chartObs.observe(spiCanvas.parentElement);
        _studioResizeObservers.push(chartObs);
      }
    }
  } catch (e) { console.warn('ResizeObserver warn:', e); }

function broadcastEarlisthenicReady() {
  const payload = { type: 'earlisthenic_ready', version: '2.10.12' };
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(payload, '*');
    }
  } catch (e) {}
  try {
    if (window.top && window.top !== window && window.top !== window.parent) {
      window.top.postMessage(payload, '*');
    }
  } catch (e) {}
}

function hideAppBootSplash() {
  const splash = document.getElementById('app-boot-splash');
  if (splash) {
    splash.style.opacity = '0';
    splash.style.pointerEvents = 'none';
    setTimeout(() => {
      try {
        if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
      } catch (e) {}
    }, 320);
  }
}

  const onReadyFrame = () => {
    try { drawGlobalWaveform(); } catch (e) {}
    try { resizeArenaCanvas(); } catch (e) {}
    try { hideAppBootSplash(); } catch (e) {}
    try { broadcastEarlisthenicReady(); } catch (e) {}
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(onReadyFrame, 16));
  } else {
    setTimeout(onReadyFrame, 20);
  }
  try { ensureStudioAnimationLoopRunning(); } catch (e) { console.warn('Anim loop warn:', e); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapEarlisthenic);
} else {
  bootstrapEarlisthenic();
}

window.addEventListener('load', () => {
  bootstrapEarlisthenic();
  drawGlobalWaveform();
  resizeArenaCanvas();
  try { hideAppBootSplash(); } catch (e) {}
  try { broadcastEarlisthenicReady(); } catch (e) {}
});

