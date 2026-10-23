// Small animation helpers shared by the engine and the character packs.

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const rand = (a, b) => a + Math.random() * (b - a);

export const ease = {
  smooth: (x) => x * x * (3 - 2 * x),
  out: (x) => 1 - (1 - x) * (1 - x),
  in: (x) => x * x,
  back: (x) => 1 + 2.7 * (x - 1) ** 3 + 1.7 * (x - 1) ** 2,
};

// 0 before a, 1 after b, smooth in between
export const ramp01 = (t, a, b) => ease.smooth(clamp((t - a) / (b - a), 0, 1));

// height offset of a hop starting at t0 (css px, negative = up)
export const hopY = (t, t0, dur, h) => {
  const x = (t - t0) / dur;
  return x < 0 || x > 1 ? 0 : -4 * h * x * (1 - x);
};

// smooth pseudo-noise from a few incommensurate sines, roughly -1..1
export const wobble = (t, seed) => 0.55 * Math.sin(t * 1.0 + seed) + 0.3 * Math.sin(t * 2.31 + seed * 1.7)
  + 0.15 * Math.sin(t * 4.73 + seed * 2.9);
