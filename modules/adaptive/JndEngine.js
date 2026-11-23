/**
 * Earlisthenic — modules/adaptive/JndEngine.js
 * Adaptive Psychoacoustic Frequency Acuity & Just Noticeable Difference (JND) Engine.
 *
 * Implements Glicko-2 rating model across 10 standard octave bands (31.5 Hz to 16 kHz).
 * Measures individual auditory acuity, discovers weak frequency bands, and dynamically
 * generates personalized challenges targeting optimal learning zone (~72% success rate).
 */

const ISO_OCTAVE_BANDS = [
  { id: 'band_31', centerFreq: 31.5, minFreq: 20, maxFreq: 44, label: '31.5 Hz (Sub Bass)' },
  { id: 'band_63', centerFreq: 63, minFreq: 45, maxFreq: 88, label: '63 Hz (Low Bass)' },
  { id: 'band_125', centerFreq: 125, minFreq: 89, maxFreq: 176, label: '125 Hz (Upper Bass)' },
  { id: 'band_250', centerFreq: 250, minFreq: 177, maxFreq: 353, label: '250 Hz (Low Mids)' },
  { id: 'band_500', centerFreq: 500, minFreq: 354, maxFreq: 707, label: '500 Hz (Mids)' },
  { id: 'band_1k', centerFreq: 1000, minFreq: 708, maxFreq: 1414, label: '1 kHz (Upper Mids)' },
  { id: 'band_2k', centerFreq: 2000, minFreq: 1415, maxFreq: 2828, label: '2 kHz (Presence)' },
  { id: 'band_4k', centerFreq: 4000, minFreq: 2829, maxFreq: 5656, label: '4 kHz (High Presence)' },
  { id: 'band_8k', centerFreq: 8000, minFreq: 5657, maxFreq: 11313, label: '8 kHz (Brilliance)' },
  { id: 'band_16k', centerFreq: 16000, minFreq: 11314, maxFreq: 20000, label: '16 kHz (Air)' }
];

const GLICKO_SCALE = 173.7178;
const GLICKO_TAU = 0.5; // Volatility change constraint

class EarlisthenicJndEngine {
  constructor(initialData = null) {
    this.bands = {};
    this.initBands(initialData);
  }

  initBands(data) {
    const raw = (data && typeof data === 'object') ? data : {};
    for (let i = 0; i < ISO_OCTAVE_BANDS.length; i++) {
      const b = ISO_OCTAVE_BANDS[i];
      const saved = raw[b.id] || {};
      this.bands[b.id] = {
        id: b.id,
        centerFreq: b.centerFreq,
        minFreq: b.minFreq,
        maxFreq: b.maxFreq,
        label: b.label,
        rating: typeof saved.rating === 'number' ? saved.rating : 1500,
        rd: typeof saved.rd === 'number' ? saved.rd : 350,
        volatility: typeof saved.volatility === 'number' ? saved.volatility : 0.06,
        trials: typeof saved.trials === 'number' ? saved.trials : 0,
        correct: typeof saved.correct === 'number' ? saved.correct : 0,
        jndDb: typeof saved.jndDb === 'number' ? saved.jndDb : 6.0,
        jndOct: typeof saved.jndOct === 'number' ? saved.jndOct : 1.0,
        lastUpdatedIso: saved.lastUpdatedIso || new Date().toISOString()
      };
    }
  }

  getBandForFrequency(freq) {
    const f = Math.max(20, Math.min(20000, Number(freq) || 1000));
    for (let i = 0; i < ISO_OCTAVE_BANDS.length; i++) {
      const b = ISO_OCTAVE_BANDS[i];
      if (f >= b.minFreq && f <= b.maxFreq) {
        return this.bands[b.id];
      }
    }
    return this.bands['band_1k'];
  }

  /**
   * Records a user answer and updates Glicko-2 rating and JND thresholds for the target band.
   * @param {number} targetFreq - Actual frequency of exercise
   * @param {number} userFreq - Frequency selected by user
   * @param {number} targetGain - Actual gain in dB
   * @param {number} userGain - Gain selected by user
   * @param {boolean} isCorrect - Whether user achieved a passing score
   * @param {number} [nearMissScore=0] - Fractional score between 0.0 and 1.0
   */
  recordTrial(targetFreq, userFreq, targetGain, userGain, isCorrect, nearMissScore = 0) {
    const band = this.getBandForFrequency(targetFreq);
    if (!band) return null;

    band.trials++;
    if (isCorrect) band.correct++;

    // Calculate score outcome: 1.0 = perfect, 0.5 = near miss, 0.0 = miss
    let outcome = 0.0;
    if (isCorrect) outcome = 1.0;
    else if (nearMissScore > 0) outcome = Math.min(0.85, Math.max(0.2, nearMissScore));

    // Convert to Glicko-2 scale
    const mu = (band.rating - 1500) / GLICKO_SCALE;
    const phi = band.rd / GLICKO_SCALE;
    const sigma = band.volatility;

    // Opponent model: problem difficulty corresponds to level ~1500 + (12 - JND)*50
    const oppMu = 0.0;
    const oppPhi = 1.0;

    const g = 1.0 / Math.sqrt(1.0 + (3.0 * oppPhi * oppPhi) / (Math.PI * Math.PI));
    const E = 1.0 / (1.0 + Math.exp(-g * (mu - oppMu)));
    const v = 1.0 / (g * g * E * (1.0 - E));
    const delta = v * g * (outcome - E);

    // Update volatility
    const a = Math.log(sigma * sigma);
    let A = a;
    let B;
    if (delta * delta > phi * phi + v) {
      B = Math.log(delta * delta - phi * phi - v);
    } else {
      let k = 1;
      while (this._f(a - k * GLICKO_TAU, delta, phi, v, a) < 0) k++;
      B = a - k * GLICKO_TAU;
    }

    let fA = this._f(A, delta, phi, v, a);
    let fB = this._f(B, delta, phi, v, a);
    while (Math.abs(B - A) > 0.000001) {
      const C = A + (A - B) * fA / (fB - fA);
      const fC = this._f(C, delta, phi, v, a);
      if (fC * fB < 0) {
        A = B; fA = fB;
      } else {
        fA = fA / 2.0;
      }
      B = C; fB = fC;
    }
    const newSigma = Math.exp(A / 2.0);

    // Update rating & RD
    const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
    const newPhi = 1.0 / Math.sqrt(1.0 / (phiStar * phiStar) + 1.0 / v);
    const newMu = mu + newPhi * newPhi * g * (outcome - E);

    // Convert back to standard scale
    band.rating = Math.max(400, Math.min(2800, Math.round(1500 + newMu * GLICKO_SCALE)));
    band.rd = Math.max(30, Math.min(350, Math.round(newPhi * GLICKO_SCALE)));
    band.volatility = Number(newSigma.toFixed(4));

    // Dynamic JND adjustment
    // High rating (e.g. 2200) => tight JND (down to 0.75 dB, 1/6 octave)
    // Low rating (e.g. 1000) => wider JND (up to 8.0 dB, 1.5 octave)
    const normalizedRating = Math.max(600, Math.min(2600, band.rating));
    band.jndDb = Number((Math.max(0.5, Math.min(10.0, 10.0 - (normalizedRating - 600) / 2000 * 9.5))).toFixed(2));
    band.jndOct = Number((Math.max(0.125, Math.min(1.5, 1.5 - (normalizedRating - 600) / 2000 * 1.375))).toFixed(3));
    band.lastUpdatedIso = new Date().toISOString();

    return band;
  }

  _f(x, delta, phi, v, a) {
    const ex = Math.exp(x);
    const num1 = ex * (delta * delta - phi * phi - v - ex);
    const den1 = 2.0 * Math.pow(phi * phi + v + ex, 2);
    const p2 = (x - a) / (GLICKO_TAU * GLICKO_TAU);
    return (num1 / den1) - p2;
  }

  /**
   * Generates an adaptive challenge targeting the user's auditory weak spot.
   * With 60% probability picks the band with lowest rating/highest uncertainty.
   * @param {string} gameId
   * @param {number} level - Fallback baseline level (1-10)
   * @returns {{ targetFreq: number, targetGain: number, targetQ: number, bandId: string }}
   */
  generateAdaptiveChallenge(gameId, level = 3) {
    const bandList = Object.values(this.bands);

    // Sort by rating ascending (weakest band first)
    const sorted = bandList.slice().sort((a, b) => {
      // Balance lowest rating with highest uncertainty
      const priorityA = a.rating - (a.rd * 0.4);
      const priorityB = b.rating - (b.rd * 0.4);
      return priorityA - priorityB;
    });

    // 60% probability to pick one of the bottom 3 weak bands
    let chosenBand;
    if (Math.random() < 0.60 && sorted.length >= 3) {
      const idx = Math.floor(Math.random() * 3);
      chosenBand = sorted[idx];
    } else {
      chosenBand = sorted[Math.floor(Math.random() * sorted.length)];
    }

    // Pick random frequency within octave band
    const logMin = Math.log10(chosenBand.minFreq);
    const logMax = Math.log10(chosenBand.maxFreq);
    const targetFreq = Math.round(Math.pow(10, logMin + Math.random() * (logMax - logMin)));

    // Target Gain calibrated to user JND + small difficulty offset
    const isBoost = Math.random() >= 0.5;
    const baseGain = Math.max(1.5, chosenBand.jndDb * (1.1 - (level * 0.04)));
    const targetGain = Number((isBoost ? baseGain : -baseGain).toFixed(1));

    // Target Q based on JND octave bandwidth: Q ~= 1 / (2 * sinh(ln(2)/2 * bandwidth))
    const bw = chosenBand.jndOct;
    const targetQ = Number((Math.max(0.5, Math.min(10.0, 1.414 / bw))).toFixed(2));

    return {
      targetFreq,
      targetGain,
      targetQ,
      bandId: chosenBand.id,
      bandLabel: chosenBand.label,
      bandRating: chosenBand.rating
    };
  }

  exportData() {
    return JSON.parse(JSON.stringify(this.bands));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EarlisthenicJndEngine, ISO_OCTAVE_BANDS };
}
