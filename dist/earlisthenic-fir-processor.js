/**
 * Earlisthenic — earlisthenic-fir-processor.js
 * High-Performance Real-Time Linear-Phase AudioWorkletProcessor.
 * Executes on the dedicated audio rendering thread for zero-glitch, zero-latency DSP.
 */

class EarlisthenicFirProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.taps = null;
    this.bufferL = new Float32Array(16384);
    this.bufferR = new Float32Array(16384);
    this.writeIndex = 0;
    this.bypass = true;
    this.gain = 1.0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'SET_COEFFICIENTS') {
        this.taps = (data.coefficients && data.coefficients.length > 0) ? new Float32Array(data.coefficients) : null;
        this.bypass = !this.taps || this.taps.length === 0;
      } else if (data.type === 'SET_BYPASS') {
        this.bypass = !!data.bypass;
      } else if (data.type === 'SET_GAIN') {
        this.gain = typeof data.gain === 'number' ? data.gain : 1.0;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const blockSize = inL.length;

    if (this.bypass || !this.taps || this.taps.length === 0) {
      for (let i = 0; i < blockSize; i++) {
        outL[i] = inL[i] * this.gain;
        outR[i] = inR[i] * this.gain;
      }
      return true;
    }

    const taps = this.taps;
    const numTaps = taps.length;
    const bufLen = this.bufferL.length;
    const bufMask = bufLen - 1;

    for (let i = 0; i < blockSize; i++) {
      this.bufferL[this.writeIndex] = inL[i];
      this.bufferR[this.writeIndex] = inR[i];

      let sumL = 0.0;
      let sumR = 0.0;

      for (let t = 0; t < numTaps; t++) {
        const readIdx = (this.writeIndex - t + bufLen) & bufMask;
        const c = taps[t];
        sumL += this.bufferL[readIdx] * c;
        sumR += this.bufferR[readIdx] * c;
      }

      outL[i] = sumL * this.gain;
      outR[i] = sumR * this.gain;
      this.writeIndex = (this.writeIndex + 1) & bufMask;
    }

    return true;
  }
}

registerProcessor('earlisthenic-fir-processor', EarlisthenicFirProcessor);
