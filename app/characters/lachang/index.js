// The dachshund ("腊肠", lachang) character pack.

import { ACTIONS, pickIdleAction } from './actions.js';
import { LachangPet } from './behaviour.js';
import { pick, timeGreeting } from './lines.js';
import { PARAM_DEFAULTS, POSERS, SKINS, VARIANT_PARAMS } from './posers.js';

export default {
  Pet: LachangPet,
  posers: POSERS,
  skins: SKINS,
  paramDefaults: PARAM_DEFAULTS,
  variantParams: VARIANT_PARAMS,
  headBone: 'head',
  faceGroups: {},
  // one rig: standing and trotting are the same layers (the walk sprite is the idle art)
  rigFor: { idle: 'stand', walk: 'stand' },
  faceSets: { idle: 'idle', walk: 'idle' },
  // the art faces -x, so walking right mirrors it; a trot is quicker than her stroll
  walk: { speed: 75, stride: 0.19, faces: -1 },
  shadowWidth: { idle: 0.95, walk: 0.95, sit: 0.6, sleep: 1.05, lie: 1.15, beg: 0.5 },
  busyStates: [],
  pettable: ['idle', 'sit', 'lie', 'beg'],
  reactions: {
    poke: 'growl',
    thrown: ['shake', 'growl'],
    doubleClick: 'bark',
    petted: 'wag',
    click: ['tilt', 'wag', 'bark', 'wink', 'smirk', 'startled'],
    attention: 'bark',
    done: 'wag',
  },
  actions: ACTIONS,
  pickIdleAction,
  lines: { pick, timeGreeting },
};
