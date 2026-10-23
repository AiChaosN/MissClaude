// The action library: short performances she plays on the standing rig.
//
// An action is { dur, pool, pose(t, c), cues: [[time, fn(c)], ...], next }:
//   pose  returns the targets for this instant (the rig eases toward them):
//         arm / armB    free-arm and book-arm variants (see ARM_VARIANTS in build_rig.py)
//         face          a whole-face patch (happy, angry, pout, smirk, awkward, teary, surprised)
//         eyes / mouth  partial patches (blink, half, wink, look_up / a i u e o); blush: bool
//         headTilt, headNod, lean, bookLift, armOut, armMotion, stretch, shake, wave, tap (rig)
//         gazeX, gazeY  where the irises point (-1..1), when the face is not a patch
//         dx, dy        body offset in units of k (her height / 200), dy < 0 is up
//         sx, sy, rot   squash, stretch and tilt of the whole figure
//   cues  fire once each, in order, when their time has passed; c.say(kind) speaks a
//         line from lines.js, c.fx.* emits effects placed around her head and feet
//   pool  weight when she picks an idle action by herself (0: only on request)
//   next  an action to chain into
//
// Everything here is pure data and arithmetic, so the core tests can import it.

import { ease } from '../../engine/anim.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
// 0 before a, 1 after b, smooth in between
const ramp = (t, a, b) => ease.smooth(clamp01((t - a) / (b - a)));
// 0 -> 1 between a and b, back to 0 between c and d
const pulse = (t, a, b, c, d) => ramp(t, a, b) * (1 - ramp(t, c, d));
// a jump starting at t0, lasting dur, peaking at h (k units); negative = up
const hop = (t, t0, dur, h) => {
  const x = (t - t0) / dur;
  return x < 0 || x > 1 ? 0 : -4 * h * x * (1 - x);
};
// landing squash after t0 (returns how much to squash, 0 when settled)
const land = (t, t0, amp) => {
  const x = t - t0;
  return x < 0 ? 0 : amp * Math.exp(-x * 10) * Math.cos(x * 26);
};
const osc = (t, hz, ph = 0) => Math.sin(t * 2 * Math.PI * hz + ph);
const during = (t, a, b) => t >= a && t < b;

export const ACTIONS = {
  // 生气: hands on hips, stamps her feet, then turns away pouting
  angry: {
    dur: 4.2, pool: 0,
    pose: (t) => {
      const turned = pulse(t, 1.6, 1.9, 3.5, 3.8);
      const sq = land(t, 0.47, 0.07) + land(t, 0.84, 0.07);
      return {
        arm: 'hip', armB: 'bhip', face: t < 1.6 ? 'angry' : 'pout', blush: t >= 1.6,
        headTilt: -3 - 12 * turned, headNod: -1.5, lean: -2 + 1.5 * turned,
        shake: t < 1.4 ? 0.35 : 0,
        dy: hop(t, 0.25, 0.22, 7) + hop(t, 0.62, 0.22, 7), sy: 1 - sq, sx: 1 + 0.6 * sq,
      };
    },
    cues: [
      [0.1, (c) => c.say('angry')], [0.3, (c) => c.fx.vein()], [0.47, (c) => c.fx.dust()],
      [0.84, (c) => c.fx.dust()], [1.1, (c) => c.fx.steam()], [1.7, (c) => c.say('pout')],
      [2.3, (c) => c.fx.vein()], [3.6, (c) => c.fx.mark('…')],
    ],
  },

  // 尴尬: scratches her cheek, looks away with a stiff smile, a sweat drop slides down
  awkward: {
    dur: 3.6, pool: 0,
    pose: (t) => ({
      arm: 'scratch', armMotion: 1, face: 'awkward', blush: true,
      headTilt: 5 + 1.5 * osc(t, 0.7), lean: 0.8 * osc(t, 0.5),
    }),
    cues: [[0.2, (c) => c.say('awkward')], [0.4, (c) => c.fx.sweat()], [2.0, (c) => c.fx.sweat()]],
  },

  // 坏笑: hand over her mouth, sly grin, giggling shoulders, ends with a wink
  smirk: {
    dur: 3.4, pool: 0.8,
    pose: (t) => ({
      arm: 'mouth', armMotion: 0.7, face: t < 2.6 ? 'smirk' : null, eyes: t >= 2.6 ? 'wink' : null,
      shake: during(t, 0.4, 2.6) ? 0.5 : 0, headTilt: -6, lean: 1,
    }),
    cues: [[0.15, (c) => c.fx.stars(1)], [0.2, (c) => c.say('smirk')], [2.65, (c) => c.fx.stars(2)]],
  },

  // 害羞: hides behind the book, peeks out at you, hides again
  shy: {
    dur: 3.8, pool: 0,
    pose: (t) => {
      const peek = pulse(t, 1.6, 1.9, 2.6, 2.9);
      return {
        armB: 'bup', armMotion: 0.5, blush: true, headTilt: 7 - 4 * peek, headNod: 2 - 2 * peek,
        gazeX: -0.8 + 1.1 * peek, gazeY: 0.4 - 0.4 * peek,
      };
    },
    cues: [[0.3, (c) => c.say('shy')], [1.0, (c) => c.fx.hearts(2)], [2.4, (c) => c.fx.hearts(2)]],
  },

  // 委屈: hugs her book, teary, head down, a little sniffle
  sad: {
    dur: 4.0, pool: 0,
    pose: (t) => ({
      armB: 'bhug', face: 'teary', headNod: 4, headTilt: -5, lean: 1.5, breath: 1.5,
      shake: during(t, 1.5, 2.1) ? 0.4 : 0,
    }),
    cues: [[0.3, (c) => c.say('sad')], [0.4, (c) => c.fx.gloom()]],
  },

  // 灵光一闪: ponders, a bulb lights up, she jumps and points at the answer
  idea: {
    dur: 4.0, pool: 1.5,
    pose: (t) => {
      if (t < 1.4) return { arm: 'chin', tap: 1, headTilt: -6, gazeX: 0.45, gazeY: -0.85 };
      return {
        arm: 'point', armMotion: t > 1.8 ? 1 : 0, face: t < 1.8 ? 'surprised' : 'happy', headTilt: 4,
        dy: hop(t, 1.4, 0.35, 12), sy: 1 - land(t, 1.75, 0.06),
      };
    },
    cues: [
      [0.1, (c) => c.say('think')], [1.4, (c) => c.fx.bulb()], [1.45, (c) => c.fx.mark('!')],
      [1.55, (c) => c.say('idea')],
    ],
  },

  // 加油: pumps her fist, little jumps
  cheer_on: {
    dur: 3.2, pool: 0.5,
    pose: (t) => ({
      arm: 'fist', armMotion: 1, face: t > 0.2 ? 'happy' : null, lean: 1,
      dy: hop(t, 0.3, 0.3, 8) + hop(t, 1.1, 0.3, 8) + hop(t, 1.9, 0.3, 8),
      sy: 1 - land(t, 0.6, 0.05) - land(t, 1.4, 0.05) - land(t, 2.2, 0.05),
    }),
    cues: [
      [0.1, (c) => c.say('cheer')], [0.3, (c) => c.fx.sparkles(3)], [1.1, (c) => c.fx.sparkles(3)],
      [1.9, (c) => c.fx.sparkles(3)],
    ],
  },

  // 举手: hand up waving, bouncing on her toes
  raise_hand: {
    dur: 3.0, pool: 0.5,
    pose: (t) => ({
      arm: 'up', armMotion: 1, face: t > 0.2 ? 'happy' : null, headTilt: 4,
      dy: -3 * Math.abs(osc(t, 2.2)),
    }),
    cues: [[0.15, (c) => c.fx.mark('!')], [0.2, (c) => c.say('raise')]],
  },

  // 伸懒腰: stretches up with a tremble, yawns behind her hand, then perks up
  stretch: {
    dur: 4.6, pool: 3,
    pose: (t) => {
      if (t < 1.8) {
        return {
          arm: 'up', stretch: ramp(t, 0.2, 1.2), eyes: t > 0.3 ? 'blink' : null, shake: t > 0.5 ? 0.25 : 0,
          lean: -2 * ramp(t, 0.2, 1.2),
        };
      }
      if (t < 3.0) return { arm: 'mouth', stretch: 0.3, eyes: 'blink', mouth: 'a', headNod: -3 };
      return { face: t < 4.0 ? 'happy' : null };
    },
    cues: [[0.3, (c) => c.say('stretch')], [1.9, (c) => c.say('yawn')], [3.3, (c) => c.fx.sparkles(4)],
      [3.3, (c) => c.say('refresh')]],
  },

  // 你看那边: points to the upper right, surprised, then excited
  point: {
    dur: 3.0, pool: 0,
    pose: (t) => ({
      arm: 'point', armMotion: 0.6, face: t < 0.8 ? 'surprised' : null, headTilt: 6,
      gazeX: 0.9, gazeY: -0.6,
    }),
    cues: [[0.1, (c) => c.fx.mark('!')], [0.2, (c) => c.say('point')]],
  },

  // 偷笑: giggles behind her hand
  giggle: {
    dur: 2.8, pool: 1,
    pose: () => ({ arm: 'mouth', armMotion: 1, face: 'happy', blush: true, shake: 0.8, headTilt: -4 }),
    cues: [[0.15, (c) => c.say('giggle')]],
  },

  // wink: a fist, a wink, a star
  wink: {
    dur: 2.4, pool: 0.7,
    pose: (t) => ({
      arm: 'fist', eyes: 'wink', headTilt: 7, dy: hop(t, 0.1, 0.25, 6), sy: 1 - land(t, 0.35, 0.05),
    }),
    cues: [[0.2, (c) => c.say('wink')], [0.25, (c) => c.fx.stars(3)]],
  },

  // 跳舞: sways on the beat, arms up and down, music notes
  dance: {
    dur: 6.4, pool: 1.5,
    pose: (t) => {
      const b = t * 2.2; // beats
      const big = Math.floor(b) % 4 === 3;
      return {
        arm: Math.floor(b / 2) % 2 ? 'up' : 'fist', armMotion: 1, face: 'happy',
        lean: 6 * Math.sin(Math.PI * b), headTilt: 6 * Math.sin(Math.PI * b + 0.4),
        dy: -(big ? 9 : 4) * Math.abs(Math.sin(Math.PI * b)),
      };
    },
    cues: [
      [0.2, (c) => c.say('dance')], [3.0, (c) => c.say('dance2')],
      ...Array.from({ length: 13 }, (_, i) => [i / 2.2 + 0.05, (c) => c.fx.notes(1)]),
    ],
  },

  // 得意: hands on hips, chin up, smug
  proud: {
    dur: 3.4, pool: 1,
    pose: () => ({ arm: 'hip', armB: 'bhip', face: 'smirk', headNod: -4, headTilt: -5, lean: -2 }),
    cues: [[0.2, (c) => c.say('proud')], [0.3, (c) => c.fx.sparkles(4)], [1.2, (c) => c.fx.sparkles(3)]],
  },

  // 吓一跳: jumps high, then laughs it off with a scratch and a sweat drop
  startled: {
    dur: 3.4, pool: 0,
    pose: (t) => {
      const up = hop(t, 0, 0.45, 26);
      if (t < 0.9) {
        return { arm: 'up', face: 'surprised', dy: up, sy: 1 + (t < 0.45 ? 0.04 : 0) - land(t, 0.45, 0.09) };
      }
      return { arm: 'scratch', armMotion: 1, face: 'awkward', headTilt: 4 };
    },
    cues: [
      [0.03, (c) => c.fx.mark('!')], [0.05, (c) => c.say('startled')], [0.45, (c) => c.fx.dust()],
      [1.0, (c) => c.fx.sweat()], [1.0, (c) => c.say('startled2')],
    ],
  },

  // 无聊: head propped on her hand, half-lidded, sighs
  bored: {
    dur: 4.0, pool: 2,
    pose: (t) => ({
      arm: 'chin', eyes: 'half', headTilt: 9, headNod: 2, lean: 1.5 + osc(t, 0.3),
    }),
    cues: [[0.4, (c) => c.say('bored')], [0.5, (c) => c.fx.mark('…')]],
  },

  // 疑惑: big head tilt, scratches, question marks
  confused: {
    dur: 3.0, pool: 1,
    pose: (t) => ({
      arm: 'scratch', armMotion: 0.6, headTilt: 11 * ramp(t, 0, 0.3), gazeX: -0.4, gazeY: -0.6,
    }),
    cues: [[0.2, (c) => c.fx.mark('?')], [0.25, (c) => c.say('confused')], [1.2, (c) => c.fx.mark('?')]],
  },

  // 阿嚏: builds up, sneezes (petals everywhere), rubs her nose, embarrassed
  sneeze: {
    dur: 3.4, pool: 0.7,
    pose: (t) => {
      if (t < 1.1) {
        return { eyes: 'half', mouth: t > 0.5 ? 'a' : null, headNod: -3 * ramp(t, 0, 1.0), lean: -2 * ramp(t, 0, 1.0) };
      }
      if (t < 1.6) {
        return {
          eyes: 'blink', mouth: 'i', lean: 5, headNod: 5, shake: 1, dy: hop(t, 1.1, 0.25, 6),
          sy: 1 - land(t, 1.35, 0.06),
        };
      }
      return { arm: 'mouth', armMotion: 0.6, face: 'awkward', blush: true };
    },
    cues: [[0.2, (c) => c.say('sneeze1')], [1.12, (c) => c.say('sneeze2')], [1.15, (c) => c.fx.burst(8)],
      [1.8, (c) => c.say('sneeze3')]],
  },

  // 东张西望: looks left, looks right, wonders
  look_around: {
    dur: 3.4, pool: 3,
    pose: (t) => {
      const left = pulse(t, 0.3, 0.6, 1.1, 1.4);
      const right = pulse(t, 1.4, 1.7, 2.2, 2.5);
      return { headTilt: -6 * left + 6 * right, gazeX: -0.95 * left + 0.95 * right, gazeY: 0 };
    },
    cues: [[2.6, (c) => c.fx.mark('?')]],
  },

  // 偷看书: lifts the book to peek at it
  peek: {
    dur: 2.6, pool: 2,
    pose: () => ({ bookLift: 12, headTilt: -5, gazeX: -0.7, gazeY: 0.55 }),
    cues: [],
  },

  // 哼歌: sways and hums with eyes closed
  hum: {
    dur: 4.5, pool: 3,
    pose: (t) => ({
      face: 'happy', lean: 2.4 * osc(t, 0.75), headTilt: 4 * osc(t, 0.75, 0.6),
    }),
    cues: [
      [0.1, (c) => c.say('hum')],
      ...[0.3, 1.0, 1.7, 2.4, 3.1, 3.8].map((x) => [x, (c) => c.fx.notes(1)]),
    ],
  },
};

// cues are written in whatever order reads best; play them in time order
for (const a of Object.values(ACTIONS)) a.cues.sort((x, y) => x[0] - y[0]);

export const ACTION_NAMES = Object.keys(ACTIONS);

// a random idle action, weighted by `pool`
export function pickIdleAction(rand = Math.random) {
  const entries = Object.entries(ACTIONS).filter(([, a]) => a.pool > 0);
  const total = entries.reduce((s, [, a]) => s + a.pool, 0);
  let r = rand() * total;
  for (const [name, a] of entries) {
    r -= a.pool;
    if (r <= 0) return name;
  }
  return entries[entries.length - 1][0];
}

// sanity checks used by the tests: cues sorted, poses return objects
export function validateActions() {
  const problems = [];
  for (const [name, a] of Object.entries(ACTIONS)) {
    if (!(a.dur > 0)) problems.push(`${name}: dur`);
    const times = a.cues.map(([t]) => t);
    if (times.some((x, i) => i && x < times[i - 1])) problems.push(`${name}: cues out of order`);
    if (times.some((x) => x > a.dur)) problems.push(`${name}: cue after the end`);
    for (let t = 0; t <= a.dur; t += 0.05) {
      const p = a.pose(t, {});
      if (!p || typeof p !== 'object') {
        problems.push(`${name}: pose at ${t.toFixed(2)}`);
        break;
      }
    }
  }
  return problems;
}
