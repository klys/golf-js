(function (NG) {
  'use strict';

  const { lerp, smoothstep, seededRandom } = NG.MathUtil;

  class ValueNoise1D {
    constructor(seed = 1) {
      this.seed = seed >>> 0;
      this.cache = new Map();
    }

    lattice(i) {
      if (!this.cache.has(i)) {
        const rand = seededRandom((this.seed ^ Math.imul(i, 374761393)) >>> 0);
        this.cache.set(i, rand() * 2 - 1);
      }
      return this.cache.get(i);
    }

    sample(x) {
      const i0 = Math.floor(x);
      const i1 = i0 + 1;
      const t = smoothstep(x - i0);
      return lerp(this.lattice(i0), this.lattice(i1), t);
    }

    fbm(x, octaves = 5, lacunarity = 2, gain = 0.5) {
      let amplitude = 1;
      let frequency = 1;
      let sum = 0;
      let norm = 0;
      for (let i = 0; i < octaves; i += 1) {
        sum += this.sample(x * frequency) * amplitude;
        norm += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
      }
      return sum / (norm || 1);
    }

    ridged(x, octaves = 4, lacunarity = 2.05, gain = 0.52) {
      let amplitude = 1;
      let frequency = 1;
      let sum = 0;
      let norm = 0;
      for (let i = 0; i < octaves; i += 1) {
        const n = 1 - Math.abs(this.sample(x * frequency));
        sum += (n * n * 2 - 1) * amplitude;
        norm += amplitude;
        amplitude *= gain;
        frequency *= lacunarity;
      }
      return sum / (norm || 1);
    }
  }

  NG.ValueNoise1D = ValueNoise1D;
}(window.NoiseGolf = window.NoiseGolf || {}));
