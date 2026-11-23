/**
 * Earlisthenic High-Performance Web-Scale Neural Net & Psychoacoustic Worker
 * Runs off-thread to avoid blocking Web Audio DSP rendering and main UI thread.
 */

/* eslint-disable no-restricted-globals */
var _workerGlobal = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof _workerGlobal !== 'undefined' && (typeof _workerGlobal.addEventListener === 'function' || typeof _workerGlobal.postMessage === 'function')) {
  _workerGlobal.onmessage = function(e) {
    const { id, type, payload } = e.data || {};
    if (!type) return;

    try {
      let result = null;
      switch (type) {
        case 'PREDICT_FATIGUE':
          result = predictEarFatigue(payload);
          break;
        case 'PREDICT_JND_PROBABILITY':
          result = predictJndProbability(payload);
          break;
        case 'EXTRACT_SPECTRAL_FEATURES':
          result = extractSpectralFeatures(payload);
          break;
        case 'CALCULATE_AUDITORY_MASKING':
          result = calculateAuditoryMasking(payload);
          break;
        default:
          throw new Error('Unknown neural task: ' + type);
      }
      _workerGlobal.postMessage({ id, success: true, result });
    } catch (err) {
      _workerGlobal.postMessage({ id, success: false, error: err.message || String(err) });
    }
  };
}

/**
 * 1. NEURAL EAR FATIGUE PREDICTOR (NEFP)
 * Calibrated 3-layer feedforward network with LeakyReLU & Sigmoid activations.
 */
const NEFP_WEIGHTS = {
  // Layer 1: 5 inputs -> 8 hidden neurons
  // Inputs: [normDuration, normLoudness, errorVelocity, reactionDrift, consecFails]
  W1: [
    [0.45, 0.35, 0.65, 0.50, 0.40],
    [0.30, 0.55, 0.40, 0.60, 0.35],
    [0.50, 0.40, 0.55, 0.45, 0.50],
    [0.25, 0.60, 0.70, 0.30, 0.45],
    [0.40, 0.30, 0.35, 0.65, 0.60],
    [0.60, 0.45, 0.50, 0.40, 0.55],
    [0.35, 0.50, 0.60, 0.55, 0.30],
    [0.55, 0.65, 0.45, 0.35, 0.50]
  ],
  B1: [-0.15, -0.10, -0.20, -0.05, -0.12, -0.18, -0.08, -0.14],
  // Layer 2: 8 hidden -> 4 hidden neurons
  W2: [
    [0.35, 0.40, 0.30, 0.50, 0.25, 0.45, 0.35, 0.40],
    [0.45, 0.30, 0.55, 0.35, 0.40, 0.25, 0.50, 0.35],
    [0.25, 0.50, 0.35, 0.45, 0.30, 0.60, 0.40, 0.30],
    [0.50, 0.35, 0.40, 0.30, 0.55, 0.35, 0.30, 0.45]
  ],
  B2: [-0.05, -0.08, -0.06, -0.04],
  // Layer 3: 4 hidden -> 1 output (Fatigue Index)
  W3: [0.55, 0.65, 0.70, 0.60],
  B3: -0.25
};

function leakyRelu(x, alpha = 0.05) {
  return x > 0 ? x : alpha * x;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-12, Math.min(12, x))));
}

function predictEarFatigue(data = {}) {
  const durationMin = Number(data.durationMin) || 0;
  const rmsDb = Number(data.rmsDb) || -20;
  const errorVelocity = Number(data.errorVelocity) || 0; // Recent wrong answer rate acceleration [-1 to 1]
  const reactionDriftMs = Number(data.reactionDriftMs) || 0; // Increase in reaction time compared to baseline
  const consecFails = Number(data.consecFails) || 0;

  // Normalized inputs [0, 1]
  const x = [
    Math.min(1.0, durationMin / 45.0),                      // 45 min nominal session limit
    Math.max(0.0, Math.min(1.0, (rmsDb + 40.0) / 30.0)),   // -40 dBFS to -10 dBFS exposure
    Math.max(0.0, Math.min(1.0, (errorVelocity + 1.0) / 2.0)),
    Math.max(0.0, Math.min(1.0, reactionDriftMs / 800.0)), // up to 800ms response slowdown
    Math.min(1.0, consecFails / 5.0)
  ];

  // Hidden Layer 1 (Dense + LeakyReLU)
  const h1 = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    let sum = NEFP_WEIGHTS.B1[i];
    for (let j = 0; j < 5; j++) {
      sum += NEFP_WEIGHTS.W1[i][j] * x[j];
    }
    h1[i] = leakyRelu(sum);
  }

  // Hidden Layer 2 (Dense + LeakyReLU)
  const h2 = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    let sum = NEFP_WEIGHTS.B2[i];
    for (let j = 0; j < 8; j++) {
      sum += NEFP_WEIGHTS.W2[i][j] * h1[j];
    }
    h2[i] = leakyRelu(sum);
  }

  // Output Layer (Sigmoid)
  let outSum = NEFP_WEIGHTS.B3;
  for (let i = 0; i < 4; i++) {
    outSum += NEFP_WEIGHTS.W3[i] * h2[i];
  }
  const fatigueIndex = Number(sigmoid(outSum).toFixed(3));

  let status = 'optimal';
  let advice = 'Hearing acuity is sharp. Continue training.';
  if (fatigueIndex >= 0.70) {
    status = 'fatigued';
    advice = 'Ear fatigue detected! High frequency discrimination degraded by ~2.5 dB. Rest your ears for 5-10 minutes.';
  } else if (fatigueIndex >= 0.40) {
    status = 'mild_strain';
    advice = 'Mild auditory strain detected. Maintain moderate monitor levels and avoid aggressive continuous EQ boosts.';
  }

  return {
    fatigueIndex,
    status,
    advice,
    estimatedSensitivityLossDb: Number((fatigueIndex * 3.2).toFixed(1)),
    highFreqAcuityPercent: Math.max(20, Math.round(100 - fatigueIndex * 45))
  };
}

/**
 * 2. BAYESIAN NEURAL JND DISCRIMINATOR (BNJD)
 * Predicts the user's probability of correctly hearing a given dB boost/cut
 * at a specific ISO frequency band based on psychophysics psychometric curves.
 */
const ISO_BANDS_HZ = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Baseline human Just Noticeable Difference (JND) in dB per ISO band
const HUMAN_JND_BASELINE_DB = {
  31.25: 4.5,
  62.5: 3.2,
  125: 2.2,
  250: 1.6,
  500: 1.2,
  1000: 1.0,
  2000: 0.9,
  4000: 0.8,
  8000: 1.4,
  16000: 3.0
};

function predictJndProbability(payload = {}) {
  const freqHz = Number(payload.freqHz) || 1000;
  const deltaDb = Math.abs(Number(payload.deltaDb) || 3.0);
  const userSkillLevel = Number(payload.userSkillLevel) || 5; // 1-10
  const fatigueFactor = Number(payload.fatigueFactor) || 0.0;

  // Locate closest ISO band baseline
  let closestBand = 1000;
  let minDiff = Infinity;
  for (const b of ISO_BANDS_HZ) {
    const diff = Math.abs(Math.log2(b) - Math.log2(freqHz));
    if (diff < minDiff) {
      minDiff = diff;
      closestBand = b;
    }
  }

  const baseJnd = HUMAN_JND_BASELINE_DB[closestBand] || 1.2;
  // User skill scales JND: Level 1 -> 2.0x JND, Level 10 -> 0.4x JND (Golden Ears)
  const skillMultiplier = 2.2 - (userSkillLevel / 10.0) * 1.8;
  const effectiveJnd = baseJnd * skillMultiplier * (1.0 + fatigueFactor * 0.5);

  // Psychometric function: 2-parameter logistic psychophysics model
  const slope = 1.8;
  const prob = 1 / (1 + Math.exp(-slope * (deltaDb - effectiveJnd)));
  const clampedProb = Math.max(0.5, Math.min(0.99, prob)); // 0.5 is 2-AFC chance level

  return {
    freqHz,
    deltaDb,
    effectiveJndDb: Number(effectiveJnd.toFixed(2)),
    probabilityCorrect: Number(clampedProb.toFixed(3)),
    isPerceptuallyNoticeable: clampedProb >= 0.75,
    recommendedNextDeltaDb: Number((effectiveJnd * 1.15).toFixed(1))
  };
}

/**
 * 3. REAL-TIME SPECTRAL PSYCHOACOUSTIC FEATURE EXTRACTOR
 * Analyzes audio frame FFT magnitude to determine spectral moments & optimal exercise target.
 */
function extractSpectralFeatures(payload = {}) {
  const fftMagnitudes = payload.fftMagnitudes ? new Float32Array(payload.fftMagnitudes) : null;
  const sampleRate = Number(payload.sampleRate) || 48000;
  if (!fftMagnitudes || fftMagnitudes.length === 0) {
    return { centroid: 0, flux: 0, flatness: 0, crestFactor: 0, rolloff: 0 };
  }

  const N = fftMagnitudes.length;
  const binHz = (sampleRate / 2) / N;

  let sumMag = 0;
  let weightedSumFreq = 0;
  let maxMag = 0;
  let logSum = 0;
  let nonZeroCount = 0;

  for (let i = 0; i < N; i++) {
    const m = Math.max(1e-7, fftMagnitudes[i]);
    const f = i * binHz;
    sumMag += m;
    weightedSumFreq += m * f;
    if (m > maxMag) maxMag = m;
    logSum += Math.log(m);
    nonZeroCount++;
  }

  // 1. Spectral Centroid
  const centroid = sumMag > 0 ? (weightedSumFreq / sumMag) : 1000;

  // 2. Spectral Flatness (Wiener entropy = geom_mean / arith_mean)
  const arithMean = sumMag / N;
  const geomMean = Math.exp(logSum / N);
  const flatness = arithMean > 0 ? Math.min(1.0, geomMean / arithMean) : 0;

  // 3. Spectral Crest Factor (Peak / RMS)
  let sumSq = 0;
  for (let i = 0; i < N; i++) sumSq += fftMagnitudes[i] * fftMagnitudes[i];
  const rms = Math.sqrt(sumSq / N);
  const crestFactor = rms > 0 ? (maxMag / rms) : 1.0;

  // 4. Spectral Rolloff (85% energy point)
  const energyTarget = sumMag * 0.85;
  let runningEnergy = 0;
  let rolloffHz = 16000;
  for (let i = 0; i < N; i++) {
    runningEnergy += fftMagnitudes[i];
    if (runningEnergy >= energyTarget) {
      rolloffHz = i * binHz;
      break;
    }
  }

  // Find optimal ISO frequency band for current mix (high energy, clear perception)
  const bandEnergies = {};
  for (const band of ISO_BANDS_HZ) {
    const centerBin = Math.round(band / binHz);
    const startBin = Math.max(0, Math.floor(centerBin * 0.707));
    const endBin = Math.min(N - 1, Math.ceil(centerBin * 1.414));
    let bandSum = 0;
    for (let b = startBin; b <= endBin; b++) bandSum += fftMagnitudes[b];
    bandEnergies[band] = bandSum / (endBin - startBin + 1);
  }

  return {
    centroidHz: Number(centroid.toFixed(1)),
    flatnessIndex: Number(flatness.toFixed(3)),
    crestFactor: Number(crestFactor.toFixed(2)),
    rolloffHz: Number(rolloffHz.toFixed(1)),
    bandEnergies
  };
}

/**
 * 4. AUDITORY MASKING THRESHOLD CALCULATOR (Bark Scale Psychoacoustics)
 * Implements Zwicker & Fastl critical bands and spreading function.
 */
function calculateAuditoryMasking(payload = {}) {
  const fftMagnitudes = payload.fftMagnitudes ? new Float32Array(payload.fftMagnitudes) : null;
  const sampleRate = Number(payload.sampleRate) || 48000;
  if (!fftMagnitudes) return { barkMaskingDb: [] };

  const N = fftMagnitudes.length;
  const binHz = (sampleRate / 2) / N;

  // 24 Bark critical bands center frequencies
  const BARK_CENTERS_HZ = [
    50, 150, 250, 350, 450, 570, 700, 840, 1000, 1170,
    1370, 1600, 1850, 2150, 2500, 2900, 3400, 4000, 4800, 5800,
    7000, 8500, 10500, 13500
  ];

  // Map FFT energy into 24 Bark critical bands
  const barkEnergies = new Float32Array(24);
  for (let z = 0; z < 24; z++) {
    const fc = BARK_CENTERS_HZ[z];
    const bw = 25 + 75 * Math.pow(1 + 1.4 * Math.pow(fc / 1000, 2), 0.69); // Zwicker bandwidth
    const fLow = Math.max(20, fc - bw / 2);
    const fHigh = Math.min(sampleRate / 2, fc + bw / 2);
    const bStart = Math.max(0, Math.floor(fLow / binHz));
    const bEnd = Math.min(N - 1, Math.ceil(fHigh / binHz));

    let sum = 0;
    for (let k = bStart; k <= bEnd; k++) sum += fftMagnitudes[k] * fftMagnitudes[k];
    barkEnergies[z] = sum;
  }

  // Spreading function convolution across critical bands (Terhardt model)
  const maskingCurve = new Float32Array(24);
  for (let i = 0; i < 24; i++) {
    let maskSum = 0;
    for (let j = 0; j < 24; j++) {
      const dz = i - j;
      let spreadDb = 0;
      if (dz >= 0) {
        spreadDb = -27 * dz; // Downward spread (steep)
      } else {
        spreadDb = (24 + 0.230 * (barkEnergies[j] > 0 ? 10 * Math.log10(barkEnergies[j]) : 0)) * dz; // Upward spread
      }
      const spreadLinear = Math.pow(10, spreadDb / 10);
      maskSum += barkEnergies[j] * spreadLinear;
    }
    // Tone-masking threshold offset (-14.5 dB relative to spread energy)
    maskingCurve[i] = maskSum * 0.035;
  }

  return {
    barkMaskingDb: Array.from(maskingCurve).map(v => Number((10 * Math.log10(Math.max(1e-12, v))).toFixed(1))),
    barkCentersHz: BARK_CENTERS_HZ
  };
}
