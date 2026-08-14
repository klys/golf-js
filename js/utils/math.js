(function (NG) {
  'use strict';

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, v) => (v - a) / (b - a || 1);
  const smoothstep = (t) => {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  };
  const smootherstep = (t) => {
    const x = clamp(t, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
  };
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const magnitude = (v) => Math.hypot(v.x, v.y);
  const normalize = (v) => {
    const m = magnitude(v) || 1;
    return { x: v.x / m, y: v.y / m };
  };
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const seededRandom = (seed) => {
    let state = seed >>> 0;
    return () => {
      state += 0x6D2B79F5;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const hashString = (text) => {
    let hash = 2166136261;
    const value = String(text);
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };
  const pick = (random, array) => array[Math.min(array.length - 1, Math.floor(random() * array.length))];
  const randomRange = (random, min, max) => min + (max - min) * random();
  const expSmoothing = (current, target, responsiveness, dt) => {
    const t = 1 - Math.exp(-Math.max(0, responsiveness) * Math.max(0, dt));
    return lerp(current, target, t);
  };
  const formatScore = (score) => score === 0 ? 'E' : score > 0 ? `+${score}` : `${score}`;

  NG.MathUtil = Object.freeze({
    clamp, lerp, invLerp, smoothstep, smootherstep, distance, magnitude, normalize, dot,
    seededRandom, hashString, pick, randomRange, expSmoothing, formatScore,
  });
}(window.NoiseGolf = window.NoiseGolf || {}));
