// Behaviour, physics and drawing for the pet.
//
// Coordinates: `foot` is the pet's ground point in screen DIP, laid out as the idle
// sprite (its boots on the ground). The window is always placed so that point sits
// at layout.footX/footY inside it. Sprites are drawn in their own pixel space and
// scaled by `s` (css px per sprite px); dangling poses hang from the head point.
//
// Module boundary: everything coming in arrives through command(); everything the
// outside world may care about leaves through emit() (see docs/API.md).

import { ACTIONS, ease, pickIdleAction } from './actions.js';
import { affine } from './gl.js';
import { pick, timeGreeting } from './lines.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FACE_SET = {
  idle: 'idle', wave_a: 'idle', wave_b: 'idle', think: 'idle', sit_read: 'sit', walk: 'walk', work: 'desk',
};
// standing poses that the layered rig draws, and which arm it shows for each
const RIG_ARM = { idle: 'down', wave_a: 'wave', wave_b: 'wave', think: 'chin' };
const EXPRESSIONS = ['happy', 'surprised', 'pout', 'angry', 'smirk', 'awkward', 'teary', 'wink', 'blush'];
const WORK_STATES = ['work_in', 'work', 'work_out'];
const BUSY = ['drag', 'fall', ...WORK_STATES]; // states that ignore idle decisions and most reactions
const GRAVITY = 2600;     // DIP/s^2 at medium size
const WALK_SPEED = 56;    // DIP/s at medium size
const WALK_STRIDE = 0.14; // step length / her height (see poseWalk in rig.js)
const BLINK = { half: 0.05, closed: 0.14, end: 0.19 };
const SPEECH_QUEUE_MAX = 5;
const XFADE = 0.1; // seconds to dissolve between two different sprites/rigs

// Mouth shape for a character: Latin vowels as written, consonants half open, CJK
// a stable pseudo-random vowel per character (weighted toward open shapes),
// punctuation and spaces closed.
function vowelOf(ch) {
  if (!ch || /[\s\p{P}\p{S}]/u.test(ch)) return null;
  const c = ch.toLowerCase();
  if ('aiueo'.includes(c)) return c;
  if (c === 'y') return 'i';
  if (/[a-z]/.test(c)) return 'e';
  if (/[0-9]/.test(c)) return 'i';
  return 'aaieeoou'[ch.codePointAt(0) % 8];
}

export class Pet {
  constructor({ host, renderer, fx, bubble, sprites, faces, rigs, light, shadow, init }) {
    this.host = host;
    this.light = light || null; // the line of light texture (fx.js makeLightLine)
    this.shadow = shadow || null; // the contact shadow texture (fx.js makeShadow)
    this.slitView = null;
    this.curDraw = null; // what this frame draws (trackDraw), for render and cross-fades
    this.xfade = null;
    this.hideTimer = null;
    this.rigs = rigs || {};
    this.rig = this.rigs.stand || null; // the standing rig: idle acts, hops
    this.walkPhase = 0;
    this.drift = { x: 0, y: 0, next: 0 }; // where idle eyes wander
    this.choreo = null; // the action being played (state 'act')
    this.propsView = null; // the desk and stool while they move on their own (work_in/work_out)
    this.workPhase = null;
    this.workUntil = 0;
    this.afterWork = null;
    this.pageFlip = -1e9;
    this.r = renderer;
    this.fx = fx;
    this.bubble = bubble;
    this.sprites = sprites;
    this.faces = faces;
    this.settings = init.settings;
    this.displays = init.displays;
    this.setLayout(init.layout);
    this.foot = { ...init.foot };
    this.vel = { x: 0, y: 0 };
    this.t = 0;
    this.state = 'idle';
    this.cursor = null;
    this.press = null;
    this.ignore = true;
    this.blink = { next: rand(1.5, 3), phase: -1 };
    this.look = 0;
    this.glance = null;
    this.expr = null;
    this.exprUntil = 0;
    this.talk = { until: 0, open: false, next: 0, shape: 'a' };
    this.speech = null;
    this.speechQueue = [];
    this.clicks = [];
    this.clickTimer = null;
    this.poutUntil = 0;
    this.petting = { acc: 0, last: 0, cooldown: 0, prevX: null };
    this.lastChat = -1e9;
    this.lastGreeting = null;
    this.hopAt = -1e9;
    this.working = false;
    this.lastWorkLine = -1e9;
    this.theta = 0;
    this.omega = 0;
    this.lastSent = null;
    this.reground();
    this.setState('wave');
    this.say(timeGreeting() || pick('hello'));
  }

  emit(type, data = {}) {
    this.host.emit(type, data);
  }

  // ---------------- layout / geometry ----------------

  setLayout(l) {
    const idle = this.sprites.idle;
    this.layout = l;
    this.s = l.petHeight / idle.h;
    this.k = l.petHeight / 200;
    this.winFoot = { x: l.footX, y: l.footY };
    this.winHead = {
      x: l.footX + (idle.head[0] - idle.foot[0]) * this.s,
      y: l.footY + (idle.head[1] - idle.foot[1]) * this.s,
    };
    this.hairTop = l.footY - idle.foot[1] * this.s;
    const drag = this.sprites.drag;
    // how far the dangling sprite's boots reach below the idle boots
    this.dragDrop = ((drag.foot[1] - drag.head[1]) - (idle.foot[1] - idle.head[1])) * this.s;
  }

  windowPos() {
    return { x: this.foot.x - this.winFoot.x, y: this.foot.y - this.winFoot.y };
  }

  headScreen() {
    const w = this.windowPos();
    return { x: w.x + this.winHead.x, y: w.y + this.winHead.y };
  }

  area() {
    const { x, y } = this.foot;
    let best = null;
    let bestD = Infinity;
    for (const d of this.displays) {
      const b = d.bounds;
      const dx = x < b.x ? b.x - x : x > b.x + b.width ? x - (b.x + b.width) : 0;
      const dy = y < b.y ? b.y - y : y > b.y + b.height ? y - (b.y + b.height) : 0;
      if (dx + dy < bestD) { bestD = dx + dy; best = d.workArea; }
    }
    return best || { x: 0, y: 0, width: 1920, height: 1080 };
  }

  groundY() {
    const a = this.area();
    return a.y + a.height;
  }

  xBounds() {
    const a = this.area();
    const m = 0.3 * this.layout.petHeight;
    return [a.x + m, a.x + a.width - m];
  }

  // keep the pet on some screen after displays change
  reground() {
    const onSome = this.displays.some(({ bounds: b }) =>
      this.foot.x >= b.x && this.foot.x <= b.x + b.width && this.foot.y >= b.y - 50 && this.foot.y <= b.y + b.height + 2);
    if (!onSome) {
      const prim = (this.displays.find((d) => d.primary) || this.displays[0] || {}).workArea;
      if (prim) this.foot = { x: prim.x + prim.width * 0.85, y: prim.y + prim.height };
    }
    if (!['drag', 'fall'].includes(this.state)) {
      const [x0, x1] = this.xBounds();
      this.foot.x = clamp(this.foot.x, x0, x1);
      this.foot.y = this.groundY();
    }
  }

  // ---------------- state machine ----------------

  setState(name, opts = {}) {
    const from = this.state;
    this.state = name;
    this.since = this.t;
    this.st = opts;
    const enter = this[`enter_${name}`];
    if (enter) enter.call(this, opts);
    if (from !== name) this.emit('state', { from, to: name });
  }

  get age() {
    return this.t - this.since;
  }

  update(dt) {
    this.t += dt;
    this.view = this.baseView('idle');
    this[`update_${this.state}`](dt);
    this.updateFace(dt);
    this.updateBubble();
    this.fx.update(dt);
    this.computeModel();
    if (this.rigOn) this.updateRig(dt);
    if (this.propsView) this.updateProps(dt);
    this.trackDraw();
    this.syncWindow();
  }

  // What this frame draws, and whether it differs from the last frame: a different
  // sprite or rig starts a dissolve of the old drawing over the new one. Kept here, in
  // the simulation, so a renderer that skips frames sees the same transitions.
  trackDraw() {
    const v = this.view;
    const cur = {
      key: v.sprite + (this.rigOn ? `:${this.activeRig.kind}` : ''), rigOn: this.rigOn, rig: this.activeRig,
      model: this.model, sp: this.modelSprite, view: v, faces: this.faceList(), foot: { ...this.foot },
    };
    const prev = this.curDraw;
    if (prev && prev.key !== cur.key && !(prev.rigOn && cur.rigOn && prev.rig === cur.rig)) {
      this.xfade = { ...prev, t0: this.t };
    }
    if (this.xfade && this.t - this.xfade.t0 >= XFADE) this.xfade = null;
    this.curDraw = cur;
  }

  // gaze toward the cursor when it is within `radius` (k px) of her head, else null
  cursorGaze(radius) {
    if (!this.cursor) return null;
    const h = this.headScreen();
    const dx = this.cursor.x - h.x;
    const dy = this.cursor.y - h.y;
    if (Math.hypot(dx, dy) > radius * this.k) return null;
    return [clamp(dx / (350 * this.k), -1, 1) * 0.9, clamp(dy / (300 * this.k), -1, 1) * 0.75];
  }

  // where the irises point, -1..1 on each axis
  gazeTarget() {
    if (this.glance) return [this.glance.dir * 0.85, 0];
    if (this.view.sprite === 'think') return [0.55, -0.85];
    if (this.cursor) {
      const h = this.headScreen();
      const dx = this.cursor.x - h.x;
      const dy = this.cursor.y - h.y;
      if (Math.hypot(dx, dy) < 900 * this.k) {
        return [clamp(dx / (350 * this.k), -1, 1) * 0.9, clamp(dy / (300 * this.k), -1, 1) * 0.75];
      }
    }
    if (this.t > this.drift.next) { // nothing to look at: the eyes wander now and then
      this.drift = { x: rand(-0.45, 0.45), y: rand(-0.25, 0.3), next: this.t + rand(1.2, 3.5) };
    }
    return [this.drift.x, this.drift.y];
  }

  // sprite px -> window css px for the current view
  computeModel() {
    const v = this.view;
    const sp = this.sprites[v.sprite];
    this.activeRig = (RIG_ARM[v.sprite] && this.rigs.stand) || (v.sprite === 'walk' && this.rigs.walk)
      || (v.sprite === 'sit_read' && this.rigs.sit) || (v.sprite === 'drag' && this.rigs.drag)
      || (v.sprite === 'work' && this.rigs.work) || null;
    this.rigOn = Boolean(this.activeRig);
    if (this.activeRig && this.activeRig !== this.propsRig) this.activeRig.showMode = 'all';
    const anchor = v.anchor === 'head' ? sp.head : sp.foot;
    const pivot = v.anchor === 'head' ? this.winHead : this.winFoot;
    const bx = this.rigOn ? 1 : v.bx;
    const by = this.rigOn ? 1 : v.by;
    let m = affine.translate(pivot.x + v.dx, pivot.y + v.dy);
    m = affine.mul(m, affine.rotate(v.rot));
    m = affine.mul(m, affine.scale(this.s * v.sx * bx * (v.mirror ? -1 : 1), this.s * v.sy * by));
    m = affine.mul(m, affine.translate(-anchor[0], -anchor[1]));
    this.model = m;
    this.modelSprite = sp;
  }

  // what the layered rig should be doing, from state, expression and idle acts
  updateRig(dt) {
    const w = this.windowPos();
    const screen = affine.mul(affine.translate(w.x, w.y), this.model);
    const kind = this.activeRig.kind;
    if (kind === 'work') {
      const ph = this.workPhase ? this.workPhase.kind : 'write';
      // eyes on the paper (down and to the right), up and away while thinking, and a
      // glance at the cursor when it comes close
      const [gazeX, gazeY] = (ph !== 'think' && this.cursorGaze(300)) || (ph === 'think' ? [0.45, -0.85] : [0.75, 0.55]);
      this.activeRig.set({
        armW: ph === 'think' ? 'think' : 'write', write: ph === 'write' ? 1 : 0, tap: ph === 'think' ? 1 : 0,
        headTilt: ph === 'think' ? -5 : ph === 'happy' ? 5 : 0, headNod: ph === 'write' ? 2 : 0,
        lean: ph === 'happy' ? -1 : 0, gazeX, gazeY,
      });
      this.activeRig.update(dt, screen);
      return;
    }
    if (kind !== 'stand') {
      if (kind === 'walk') this.activeRig.set({ phase: this.walkPhase, stride: 1 });
      if (kind === 'sit') {
        // reading: the eyes run along the line in step with the head (poseSit), look up
        // at a cursor that comes close
        const line = (this.activeRig.time % 4.6) / 4.6;
        const scan = line < 0.9 ? -0.6 + (1.2 * line) / 0.9 : 0.6 - (1.2 * (line - 0.9)) / 0.1;
        const [gazeX, gazeY] = this.cursorGaze(420) || [scan, 0.55];
        this.activeRig.set({ sleep: this.state === 'sleep' ? 1 : 0, gazeX, gazeY });
      }
      if (kind === 'drag') this.activeRig.set({ flail: this.state === 'fall' ? 1.3 : 1 });
      this.activeRig.update(dt, screen);
      return;
    }
    if (this.state === 'act' && this.choreo) {
      const P = this.choreo.pose;
      const p = {
        arm: P.arm || 'down', armB: P.armB || 'book', wave: P.wave || 0, tap: P.tap || 0,
        headTilt: P.headTilt || 0, headNod: P.headNod || 0, lean: P.lean || 0, bookLift: P.bookLift || 0,
        armOut: P.armOut || 0, breath: P.breath ?? 1, armMotion: P.armMotion || 0, stretch: P.stretch || 0,
        shake: P.shake || 0,
      };
      if (this.talk.open) p.headNod += 1.2;
      [p.gazeX, p.gazeY] = P.gazeX !== undefined ? [P.gazeX, P.gazeY || 0] : this.gazeTarget();
      this.rig.set(p);
      this.rig.update(dt, screen);
      return;
    }
    const arm = RIG_ARM[this.view.sprite];
    const expr = this.expr && this.t < this.exprUntil ? this.expr : null;
    const look = this.glance ? this.glance.dir : this.look;
    const p = {
      arm, armB: 'book', wave: arm === 'wave' ? 1 : 0, tap: arm === 'chin' ? 1 : 0,
      headTilt: 2.5 * look, headNod: 0, lean: 0, bookLift: 0, armOut: 0, breath: 1,
      armMotion: 0, stretch: 0, shake: 0,
    };
    if (arm === 'wave') p.headTilt = 5;
    if (arm === 'chin') p.headTilt = -6;
    if (expr === 'happy') {
      p.headTilt = 6;
      p.armOut = 4;
    } else if (expr === 'pout') {
      p.headTilt = -5;
      p.lean = -1.5;
    } else if (expr === 'surprised') {
      p.headNod = -3;
      p.lean = 1.5;
      p.armOut = 6;
    }
    if (this.talk.open) p.headNod += 1.6;
    [p.gazeX, p.gazeY] = this.gazeTarget();
    this.rig.set(p);
    this.rig.update(dt, screen);
  }

  baseView(sprite, breath = 1, period = 3.4) {
    const b = Math.sin((this.t * 2 * Math.PI) / period);
    // sx/sy: squash and stretch; bx/by: breathing (the rig breathes by itself)
    return {
      sprite, anchor: 'foot', mirror: false, rot: 0, dx: 0, dy: 0, sx: 1, sy: 1,
      bx: 1 - 0.004 * breath * b, by: 1 + 0.010 * breath * b, sway: 1, swayBias: 0,
    };
  }

  enter_idle() {
    this.nextDecision = this.t + rand(3, 7);
  }

  update_idle() {
    this.foot.y = this.groundY();
    const h = this.t - this.hopAt;
    if (h < 0.35) this.view.dy = -Math.sin((Math.PI * h) / 0.35) * 10 * this.k;
    if (this.working && this.rigs.work) {
      this.setState('work_in');
      return;
    }
    if (this.t < this.nextDecision) return;
    if (this.working) {
      this.setState('sit', { dur: 600 });
      return;
    }
    this.decide();
  }

  decide() {
    this.nextDecision = this.t + rand(4, 10);
    const r = Math.random();
    if (this.settings.wander && r < 0.36) {
      this.walkTo(this.randomTarget());
      return;
    }
    if (r < 0.44) return this.setState('sit', {});
    if (r < 0.5) {
      this.setState('think', { dur: rand(2.5, 4) });
      if (Math.random() < 0.5) this.say(pick('think'));
      return;
    }
    if (r < 0.8 && this.rig) {
      this.playAction(pickIdleAction());
      return;
    }
    if (r < 0.88) {
      this.glance = { dir: Math.random() < 0.5 ? -1 : 1, until: this.t + rand(1.2, 2.2) };
      return;
    }
    this.chatter();
  }

  // ---- actions: timed performances from actions.js ----

  playAction(name, { then = null } = {}) {
    if (!ACTIONS[name] || !this.rig || BUSY.includes(this.state)) return false;
    this.setState('act', { name, then });
    return true;
  }

  enter_act({ name, then }) {
    this.choreo = { name, def: ACTIONS[name], t: 0, cue: 0, pose: {}, then };
    this.expr = null;
    this.emit('action', { name });
  }

  // what cues and poses get to work with: speech and effects placed around her
  actCtx() {
    const h = this.winHead;
    const f = this.winFoot;
    const k = this.k;
    const fx = this.fx;
    return {
      k,
      say: (kind) => this.say(pick(kind) || kind),
      fx: {
        vein: () => fx.vein(h.x + 42 * k, h.y - 46 * k, k),
        sweat: () => fx.sweat(h.x + 48 * k, h.y - 12 * k, k),
        mark: (text) => fx.mark(h.x + 40 * k, h.y - 78 * k, k, text),
        notes: (n) => fx.notes(h.x + rand(-40, 40) * k, h.y - 70 * k, k, n),
        steam: () => {
          fx.steam(h.x - 46 * k, h.y - 50 * k, k, -1);
          fx.steam(h.x + 46 * k, h.y - 50 * k, k, 1);
        },
        bulb: () => fx.bulb(h.x + 6 * k, h.y - 92 * k, k),
        gloom: () => fx.gloom(h.x - 30 * k, h.y - 70 * k, k),
        dust: () => fx.dust(f.x, f.y - 4 * k, k),
        stars: (n) => fx.stars(h.x + 26 * k, h.y - 4 * k, k, n),
        hearts: (n) => fx.hearts(h.x, h.y - 40 * k, k, n),
        sparkles: (n) => fx.sparkles(h.x, h.y - 10 * k, k, n),
        burst: (n) => fx.burst(h.x, h.y - 10 * k, k, n),
      },
    };
  }

  update_act(dt) {
    const c = this.choreo;
    if (!c) return this.setState('idle');
    c.t += dt;
    const ctx = this.actCtx();
    while (c.cue < c.def.cues.length && c.def.cues[c.cue][0] <= c.t) {
      c.def.cues[c.cue][1](ctx);
      c.cue += 1;
    }
    const P = c.def.pose(Math.min(c.t, c.def.dur), ctx) || {};
    c.pose = P;
    this.foot.y = this.groundY();
    const v = this.baseView(P.sprite || 'idle');
    v.dx = (P.dx || 0) * this.k;
    v.dy = (P.dy || 0) * this.k;
    v.rot = P.rot || 0;
    v.sx = P.sx ?? 1;
    v.sy = P.sy ?? 1;
    this.view = v;
    if (c.t >= c.def.dur) {
      const next = c.then || c.def.next;
      this.choreo = null;
      if (next && ACTIONS[next]) this.setState('act', { name: next });
      else this.setState('idle');
    }
  }

  // ---- work: a desk and a stool open out of a line of light, she sits down and writes ----

  // seconds: how long to keep writing once seated (Claude Code keeps her there while
  // `working` is set instead)
  startWork(seconds = 0) {
    if (!this.rigs.work || ['drag', 'fall'].includes(this.state)) return;
    if (this.state === 'work') {
      this.workUntil = Math.max(this.workUntil, this.t + seconds);
      return;
    }
    this.workFor = Math.max(this.workFor || 0, seconds);
    if (!WORK_STATES.includes(this.state)) this.setState('work_in');
  }

  endWork() {
    this.workUntil = 0;
    this.workFor = 0;
    this.working = false;
  }

  // where things go during the routine, in window css px (computed once per routine)
  workGeometry() {
    const rig = this.rigs.work;
    const sp = this.sprites.work;
    const idle = this.sprites.idle;
    const h = this.layout.petHeight;
    const toX = (x) => this.winFoot.x + (x - sp.foot[0]) * this.s;
    const toY = (y) => this.winFoot.y + (y - sp.foot[1]) * this.s;
    const props = rig.layers.filter((l) => l.propView);
    const desk = rig.layers.find((l) => l.name === 'desk_whole');
    const x0 = Math.min(...props.map((l) => toX(l.x)));
    const x1 = Math.max(...props.map((l) => toX(l.x + l.w)));
    // the line of light appears in the middle of the desk and opens over all the furniture
    const cx = toX(desk.x + desk.w / 2);
    return {
      h, cx, half: Math.max(cx - x0, x1 - cx) + 4,
      top: Math.min(...props.map((l) => toY(l.y))) - 6, bottom: this.winFoot.y + 2,
      // she steps aside to the left to make room, only as far as her window allows
      // (sprite px 4 is where the trimmed idle sprite's hair begins; the margin leaves
      // room for the hair tips swinging out when she lands)
      standDx: -(this.winFoot.x + (4 - idle.foot[0]) * this.s) + 18 * this.k,
    };
  }

  // the furniture on its own: drawn only between x0 and x1, faded by opacity
  setProps(x0, x1, opacity) {
    if (!this.propsView) {
      this.propsRig = this.rigs.work;
      this.propsRig.showMode = 'props';
      this.propsView = {};
    }
    Object.assign(this.propsView, { x0, x1, opacity });
  }

  clearProps() {
    if (this.propsRig) this.propsRig.showMode = 'all';
    this.propsView = null;
    this.propsRig = null;
  }

  // the furniture is drawn with the work sprite's model, anchored like her when seated
  updateProps(dt) {
    const sp = this.sprites.work;
    let m = affine.translate(this.winFoot.x, this.winFoot.y);
    m = affine.mul(m, affine.scale(this.s, this.s));
    m = affine.mul(m, affine.translate(-sp.foot[0], -sp.foot[1]));
    this.propsView.model = m;
    const w = this.windowPos();
    this.propsRig.update(dt, affine.mul(affine.translate(w.x, w.y), m));
  }

  // The light line: grows from its middle (grow 0..1), then splits into two edges that
  // sweep apart (spread 0..1, opening) or together (closing). Returns the window
  // between the edges, where the furniture is visible.
  slit(g, grow, spread, alpha) {
    const half = g.half * spread;
    this.slitView = alpha > 0.01 && grow > 0.01 ? { x: g.cx, top: g.top, bottom: g.bottom, grow, half, alpha } : null;
    return [g.cx - half, g.cx + half];
  }

  // the light edges, over the furniture but under her
  drawSlit(sl) {
    const L = this.light;
    const height = (sl.bottom - sl.top) * sl.grow;
    const cy = (sl.top + sl.bottom) / 2;
    const sx = 0.55 * this.k * (1 + 0.15 * Math.sin(this.t * 14));
    const sy = height / L.h;
    const edges = sl.half < 1.5 ? [sl.x] : [sl.x - sl.half, sl.x + sl.half];
    for (const x of edges) {
      let m = affine.translate(x - (L.w / 2) * sx, cy - height / 2);
      m = affine.mul(m, affine.scale(sx, sy));
      this.r.draw(L.tex, m, { rect: [0, 0, L.w, L.h], spriteW: L.w, spriteH: L.h, opacity: sl.alpha });
    }
  }

  enter_work_in() {
    this.wg = this.workGeometry();
    this.clearProps();
    this.say(pick('workStart'));
    this.dustAt = {};
    this.emit('work', { phase: 'start' });
  }

  update_work_in() {
    const t = this.age;
    const g = this.wg;
    this.foot.y = this.groundY();
    // a line of light (0.5-0.85) opens (0.85-1.65) and the furniture fades in between
    const grow = ramp01(t, 0.5, 0.85);
    const spread = ease.out(clamp((t - 0.85) / 0.8, 0, 1));
    const [x0, x1] = this.slit(g, grow, spread, grow * (1 - ramp01(t, 1.6, 1.95)));
    if (t < 2.15) this.setProps(x0, x1, t < 0.85 ? 0 : 0.25 + 0.75 * spread);
    if (t > 1.65 && !this.dustAt.shine) {
      this.dustAt.shine = true;
      this.fx.sparkles(g.cx, (g.top + g.bottom) / 2, this.k, 6, 60);
    }
    if (t < 0.45) { // hops aside to make room
      this.view = {
        ...this.baseView('idle'), dx: g.standDx * ease.out(t / 0.45), dy: hopY(t, 0, 0.45, 0.1 * g.h),
      };
    } else if (t < 1.9) { // watches it appear
      const sq = 0.05 * Math.exp(-(t - 0.45) * 10) * Math.cos((t - 0.45) * 26);
      this.view = { ...this.baseView('idle'), dx: g.standDx, sy: 1 - sq };
      this.glance = { dir: 1, until: this.t + 0.2 };
      if (!this.dustAt.aside) {
        this.dustAt.aside = true;
        this.fx.dust(this.winFoot.x + g.standDx, this.winFoot.y, this.k, 5);
      }
    } else if (t < 2.15) { // hops up onto the stool
      if (!this.dustAt.hop) {
        this.dustAt.hop = true;
        this.say(pick('workPop'));
      }
      this.view = {
        ...this.baseView('idle'), dx: g.standDx * (1 - (t - 1.9) / 0.5), dy: hopY(t, 1.9, 0.5, 0.2 * g.h),
      };
    } else { // seated (the switch is hidden at the top of the hop)
      if (this.propsView) {
        this.clearProps();
        this.fx.sparkles(this.winHead.x, this.winHead.y + 20 * this.k, this.k, 4);
      }
      const x = Math.min(1, (t - 1.9) / 0.5);
      const sq = t > 2.4 ? 0.06 * Math.exp(-(t - 2.4) * 9) * Math.cos((t - 2.4) * 24) : 0;
      this.view = { ...this.baseView('work'), dx: g.standDx * (1 - x), dy: hopY(t, 1.9, 0.5, 0.2 * g.h), sy: 1 - sq };
    }
    if (t >= 2.75) {
      this.slitView = null;
      this.setState('work');
    }
  }

  puffOnce(key, when, x, y) {
    if (when && !this.dustAt[key]) {
      this.dustAt[key] = true;
      this.fx.dust(x, y - 4 * this.k, this.k, 8);
    }
  }

  enter_work() {
    this.workUntil = Math.max(this.workUntil, this.t + (this.workFor || 0));
    this.workFor = 0;
    this.workPhase = { kind: 'write', until: this.t + rand(4, 8) };
    this.nextWorkLine = this.t + rand(8, 20);
  }

  update_work() {
    this.foot.y = this.groundY();
    this.view = this.baseView('work');
    const ph = this.workPhase;
    if (this.t > ph.until) {
      const r = Math.random();
      if (ph.kind === 'write' && r < 0.5) {
        this.workPhase = { kind: 'think', until: this.t + rand(2.5, 4) };
        if (Math.random() < 0.4) this.say(pick('workThink'));
      } else if (ph.kind === 'write' && r < 0.7) {
        this.workPhase = { kind: 'happy', until: this.t + 1.4 };
        this.fx.sparkles(this.winHead.x, this.winHead.y, this.k, 3);
        if (Math.random() < 0.5) this.say(pick('workHappy'));
      } else {
        this.workPhase = { kind: 'write', until: this.t + rand(5, 10) };
      }
    }
    if (this.t > this.nextWorkLine) {
      this.nextWorkLine = this.t + rand(15, 30);
      if (this.workPhase.kind === 'write' && Math.random() < 0.4) this.say(pick('workWrite'));
    }
    if (!this.working && this.t > this.workUntil) this.setState('work_out');
  }

  enter_work_out() {
    this.wg = this.workGeometry();
    this.workPhase = { kind: 'happy', until: Infinity };
    this.say(pick('workDone'));
    this.fx.sparkles(this.winHead.x, this.winHead.y, this.k, 5);
    this.dustAt = {};
    this.emit('work', { phase: 'end' });
  }

  update_work_out() {
    const t = this.age;
    const g = this.wg;
    this.foot.y = this.groundY();
    if (t < 0.9) {
      this.view = this.baseView('work');
    } else if (t < 1.15) { // hops off the stool (top of the hop: swap to standing)
      this.view = { ...this.baseView('work'), dx: g.standDx * (t - 0.9) / 0.5, dy: hopY(t, 0.9, 0.5, 0.2 * g.h) };
    } else {
      // the edges of light appear at both ends (1.5-1.7), sweep together (1.7-2.5) with
      // the furniture fading out between them, and the line shrinks away (2.5-2.8)
      const spread = 1 - ease.in(clamp((t - 1.7) / 0.8, 0, 1));
      const grow = 1 - ramp01(t, 2.5, 2.8);
      const [x0, x1] = this.slit(g, grow, spread, ramp01(t, 1.5, 1.7) * grow);
      if (t < 2.5) {
        this.setProps(x0, x1, 0.25 + 0.75 * spread);
      } else if (this.propsView) {
        this.clearProps();
        this.fx.sparkles(g.cx, (g.top + g.bottom) / 2, this.k, 6, 30);
      }
      if (t < 1.4) {
        this.view = { ...this.baseView('idle'), dx: g.standDx * Math.min(1, (t - 0.9) / 0.5), dy: hopY(t, 0.9, 0.5, 0.2 * g.h) };
      } else if (t < 2.8) { // watches the furniture go
        this.view = { ...this.baseView('idle'), dx: g.standDx };
        this.glance = { dir: 1, until: this.t + 0.2 };
        if (!this.dustAt.land) {
          this.dustAt.land = true;
          this.fx.dust(this.winFoot.x + g.standDx, this.winFoot.y, this.k, 6);
          this.setExpression('happy', 1.5);
        }
      } else { // hops back to her spot, the way she hopped aside (the walking sprite's
        // trailing hair would reach past the window's edge here)
        const x = ease.out(Math.min(1, (t - 2.8) / 0.45));
        const sq = t > 3.25 ? 0.05 * Math.exp(-(t - 3.25) * 10) * Math.cos((t - 3.25) * 26) : 0;
        this.view = { ...this.baseView('idle'), dx: g.standDx * (1 - x), dy: hopY(t, 2.8, 0.45, 0.1 * g.h), sy: 1 - sq };
        if (t > 3.25 && !this.dustAt.home) {
          this.dustAt.home = true;
          this.fx.dust(this.winFoot.x, this.winFoot.y, this.k, 5);
        }
      }
    }
    if (t >= 3.6) {
      this.slitView = null;
      this.clearProps();
      const next = this.afterWork;
      this.afterWork = null;
      this.workPhase = null;
      if (next && this.playAction(next)) return;
      this.setState('idle');
    }
  }

  randomTarget() {
    const [x0, x1] = this.xBounds();
    let target = rand(x0, x1);
    if (Math.abs(target - this.foot.x) < 120 * this.k) {
      target = this.foot.x + (Math.random() < 0.5 ? -1 : 1) * rand(160, 420) * this.k;
    }
    return clamp(target, x0, x1);
  }

  walkTo(x) {
    const [x0, x1] = this.xBounds();
    const target = clamp(x, x0, x1);
    if (Math.abs(target - this.foot.x) > 4) this.setState('walk', { target });
  }

  chatter(force = false) {
    if (!force && this.t - this.lastChat < 40) return;
    const greeting = timeGreeting();
    let line = pick('chatter');
    if (greeting && greeting !== this.lastGreeting) {
      line = greeting;
      this.lastGreeting = greeting;
    }
    this.say(line, { source: force ? 'menu' : 'self' });
  }

  enter_walk({ target }) {
    this.dir = Math.sign(target - this.foot.x) || 1;
  }

  update_walk(dt) {
    const step = WALK_SPEED * this.k * dt;
    const [x0, x1] = this.xBounds();
    const target = clamp(this.st.target, x0, x1);
    this.foot.y = this.groundY();
    if (Math.abs(target - this.foot.x) <= step) {
      this.foot.x = target;
      this.host.rest();
      this.setState('idle');
      return;
    }
    this.foot.x += this.dir * step;
    // one step (half a cycle) per stride length walked
    this.walkPhase += (step / (WALK_STRIDE * this.layout.petHeight)) * Math.PI;
    const ph = this.age * Math.PI * 2.2;
    const rigged = Boolean(this.rigs.walk);
    Object.assign(this.view, {
      sprite: 'walk', mirror: this.dir < 0, sx: 1, sy: 1, bx: 1, by: 1,
      dy: rigged ? 0 : -Math.abs(Math.sin(ph)) * 4 * this.k,
      rot: rigged ? 0 : Math.sin(ph) * 0.025,
      sway: 1.6, swayBias: -5,
    });
  }

  enter_sit({ dur }) {
    this.sitUntil = this.t + (dur || rand(25, 70));
    this.nextRead = this.t + rand(10, 20);
    this.nextFlip = this.t + rand(4, 9);
  }

  update_sit() {
    this.foot.y = this.groundY();
    this.view = this.baseView('sit_read', 0.7);
    if (this.t > this.nextFlip) { // turn a page now and then
      this.pageFlip = this.t;
      this.nextFlip = this.t + rand(9, 20);
    }
    const a = this.age;
    if (a < 0.3) this.view.sy *= 1 - 0.06 * Math.cos((a / 0.3) * Math.PI * 0.5); // settle down
    if (this.t > this.nextRead) {
      this.nextRead = this.t + rand(15, 30);
      if (this.working && this.t - this.lastWorkLine > 25) {
        this.lastWorkLine = this.t;
        this.say(pick('ccWork'));
      } else if (!this.working && Math.random() < 0.3) {
        this.say(pick('read'));
      }
    }
    if (this.working || this.t < this.sitUntil) return;
    if (Math.random() < 0.45) {
      if (Math.random() < 0.5) this.say(pick('sleepy'));
      this.setState('sleep');
    } else {
      this.standUp();
    }
  }

  standUp() {
    this.setState('land', { impact: 350 * this.k });
  }

  enter_sleep({ dur }) {
    this.sleepUntil = this.t + (dur || rand(60, 180));
    this.nextZ = this.t + 1.2;
  }

  update_sleep() {
    this.foot.y = this.groundY();
    this.view = this.baseView('sit_read', 1.3, 4.6);
    this.view.rot = Math.sin(this.t * 0.8) * 0.012;
    if (this.t > this.nextZ) {
      this.nextZ = this.t + 1.5;
      const h = this.winHead;
      this.fx.zzz(h.x + 30 * this.k, h.y - 40 * this.k, this.k);
    }
    if (this.t > this.sleepUntil) this.wake();
  }

  wake() {
    this.standUp();
    this.setExpression('surprised', 1.2);
    this.say(pick('wake'));
    this.emit('wake');
  }

  enter_think({ dur }) {
    this.thinkUntil = this.t + (dur || 3);
  }

  update_think() {
    this.foot.y = this.groundY();
    this.view = this.baseView('think');
    if (this.t > this.thinkUntil) this.setState('idle');
  }

  enter_wave({ dur }) {
    this.waveFor = dur || 1.9;
    this.setExpression('happy', this.waveFor);
  }

  update_wave() {
    this.foot.y = this.groundY();
    this.view = this.baseView(Math.floor(this.age / 0.2) % 2 ? 'wave_b' : 'wave_a');
    if (this.age > this.waveFor) this.setState('idle');
  }

  enter_cheer() {
    const h = this.winHead;
    this.fx.sparkles(h.x, h.y, this.k, 6);
  }

  update_cheer() {
    const D = 0.8;
    const p = clamp(this.age / D, 0, 1);
    this.foot.y = this.groundY();
    this.view = this.baseView('cheer', 0);
    this.view.dy = -Math.sin(Math.PI * p) * 0.24 * this.layout.petHeight;
    if (p < 0.12 || p > 0.88) this.view.sy = 0.95;
    if (this.age > D) this.setState('land', { impact: 600 * this.k });
  }

  // ---- dragging, falling, landing ----

  startDrag() {
    if (WORK_STATES.includes(this.state)) { // picked up mid-work: the furniture vanishes
      this.slitView = null;
      if (this.propsView || this.state === 'work') this.fx.sparkles(this.winFoot.x, this.winFoot.y - 60 * this.k, this.k, 8);
      this.clearProps();
      this.workPhase = null;
    }
    this.choreo = null;
    this.grab = { x: this.foot.x - this.cursor.x, y: this.foot.y - this.cursor.y };
    this.dragV = { x: 0, y: 0 };
    this.prevVx = 0;
    this.theta = 0;
    this.omega = 0;
    this.expr = null;
    this.setState('drag');
    this.emit('drag_start', { x: this.foot.x, y: this.foot.y });
    if (Math.random() < 0.4) this.say(pick('drag'));
  }

  update_drag(dt) {
    const c = this.cursor;
    const target = { x: c.x + this.grab.x, y: c.y + this.grab.y };
    const blend = Math.min(1, dt * 12);
    this.dragV.x += ((target.x - this.foot.x) / dt - this.dragV.x) * blend;
    this.dragV.y += ((target.y - this.foot.y) / dt - this.dragV.y) * blend;
    const ax = clamp((this.dragV.x - this.prevVx) / dt, -30000, 30000);
    this.prevVx = this.dragV.x;
    this.foot = target;
    this.swing(dt, ax);
    this.hangView();
  }

  // pendulum hanging from the head: gravity restores, pivot acceleration kicks
  swing(dt, ax) {
    const L = 0.45 * this.layout.petHeight;
    const acc = -(1800 / L) * Math.sin(this.theta) + (ax / L) * Math.cos(this.theta) * 0.8 - 3.5 * this.omega;
    this.omega += acc * dt;
    this.theta = clamp(this.theta + this.omega * dt, -0.75, 0.75);
  }

  hangView() {
    Object.assign(this.view, {
      sprite: 'drag', anchor: 'head', rot: this.theta, sx: 1, sy: 1, bx: 1, by: 1,
      sway: 1 + Math.min(3, Math.abs(this.omega) * 1.2), swayBias: this.theta * 8,
    });
  }

  release() {
    this.vel = { x: clamp(this.dragV.x, -1600, 1600) * 0.6, y: clamp(this.dragV.y, -1600, 1600) * 0.6 };
    this.emit('drop', { x: this.foot.x, y: this.foot.y, vx: this.vel.x, vy: this.vel.y });
    this.setState('fall');
  }

  update_fall(dt) {
    this.vel.y += GRAVITY * this.k * dt;
    this.foot.x += this.vel.x * dt;
    this.foot.y += this.vel.y * dt;
    const [x0, x1] = this.xBounds();
    if (this.foot.x < x0) { this.foot.x = x0; this.vel.x = Math.abs(this.vel.x) * 0.45; }
    if (this.foot.x > x1) { this.foot.x = x1; this.vel.x = -Math.abs(this.vel.x) * 0.45; }
    this.swing(dt, -this.vel.x * 2);
    this.hangView();
    const ground = this.groundY();
    if (this.foot.y + this.dragDrop >= ground) {
      this.foot.y = ground;
      this.setState('land', { impact: Math.max(0, this.vel.y), fell: true });
    }
  }

  enter_land({ impact = 0, fell = false }) {
    this.impact = impact;
    if (this.rig) this.rig.kick(clamp(impact / 600, 0.3, 3));
    if (fell) this.emit('land', { x: this.foot.x, y: this.foot.y, impact: Math.round(impact) });
    if (impact > 900 * this.k) {
      this.setExpression('surprised', 0.9);
      this.fx.burst(this.winFoot.x, this.winFoot.y - 6, this.k, 6);
      if (Math.random() < 0.5) this.say(pick('land'));
    }
    // thrown hard: after landing she is not amused
    this.afterLand = impact > 1700 * this.k ? (Math.random() < 0.5 ? 'awkward' : 'angry') : null;
  }

  update_land() {
    this.foot.y = this.groundY();
    const a = this.age;
    const amp = clamp(this.impact / (2600 * this.k), 0.04, 0.15);
    const sq = amp * Math.exp(-a * 9) * Math.cos(a * 24);
    this.view = this.baseView('idle', 0);
    this.view.sy = 1 - sq;
    this.view.sx = 1 + sq * 0.6;
    if (a > 0.45) {
      this.host.rest();
      const next = this.afterLand;
      this.afterLand = null;
      if (!(next && this.playAction(next))) this.setState('idle');
    }
  }

  // ---------------- face ----------------

  setExpression(name, seconds = 2) {
    if (name === 'neutral' || !name) {
      this.expr = null;
      return;
    }
    if (!EXPRESSIONS.includes(name)) return;
    this.expr = name;
    this.exprUntil = this.t + seconds;
  }

  updateFace(dt) {
    if (this.blink.phase >= 0) {
      this.blink.phase += dt;
      if (this.blink.phase > BLINK.end) {
        this.blink.phase = -1;
        this.blink.next = this.t + (Math.random() < 0.15 ? 0.2 : rand(2.2, 5.5));
      }
    } else if (this.t >= this.blink.next) {
      this.blink.phase = 0;
    }
    if (this.t < this.talk.until) {
      // about one syllable every 0.12 s, shaped by the character being typed
      if (this.t >= this.talk.next) {
        this.talk.open = !this.talk.open;
        if (this.talk.open) {
          const sp = this.speech;
          this.talk.shape = sp ? vowelOf(sp.chars[Math.max(0, sp.shown - 1)]) : 'a';
          if (!this.talk.shape) this.talk.open = false;
        }
        this.talk.next = this.t + (this.talk.open ? rand(0.08, 0.12) : rand(0.03, 0.06));
      }
    } else {
      this.talk.open = false;
    }
    if (this.glance && this.t > this.glance.until) this.glance = null;
  }

  updateLook() {
    if (!this.cursor) return;
    const head = this.headScreen();
    const dx = this.cursor.x - head.x;
    const dy = this.cursor.y - head.y;
    if (Math.hypot(dx, dy) > 650 * this.k) {
      this.look = 0;
    } else if (this.look === 0) {
      if (Math.abs(dx) > 90 * this.k) this.look = Math.sign(dx);
    } else if (Math.abs(dx) < 50 * this.k) {
      this.look = 0;
    } else {
      this.look = Math.sign(dx);
    }
  }

  blinkStage() {
    const p = this.blink.phase;
    if (p < 0) return null;
    return p < BLINK.half || p >= BLINK.closed ? 'half' : 'blink';
  }

  faceList() {
    const set = FACE_SET[this.view.sprite];
    const F = set && this.faces[set];
    if (!F) return [];
    if (set === 'walk') return this.blinkStage() && F.blink ? [F.blink] : [];
    if (set === 'desk') {
      const ph = this.workPhase ? this.workPhase.kind : 'write';
      if ((ph === 'think' || ph === 'happy') && F[ph]) return [F[ph]];
      return this.blinkStage() === 'blink' && F.blink ? [F.blink] : [];
    }
    if (set === 'sit') {
      if (this.state === 'sleep') return F.sleep ? [F.sleep] : [];
      const out = this.blinkStage() === 'blink' && F.blink ? [F.blink] : [];
      const flip = this.t - this.pageFlip;
      if (flip < 0.3 && F.page1) out.push(F.page1);
      else if (flip < 0.65 && F.page2) out.push(F.page2);
      return out;
    }
    if (this.state === 'act' && this.choreo) return this.actFaces(F);
    const ex = this.expr && this.t < this.exprUntil ? this.expr : null;
    if (ex && ex !== 'wink' && ex !== 'blush' && F[ex]) return [F[ex]];
    const out = [];
    const look = this.glance ? this.glance.dir : this.look;
    const eyesUp = this.view.sprite === 'think';
    // with moving irises (layered rig on WebGL) the baked look-* patches are not needed
    const irisGaze = this.rigOn && this.activeRig.hasIrises && this.r.kind === 'webgl';
    const eyes = (ex === 'wink' && 'wink') || this.blinkStage() || (irisGaze ? null : eyesUp ? 'look_up'
      : look < 0 ? 'look_left' : look > 0 ? 'look_right' : null);
    if (eyes && F[eyes]) out.push(F[eyes]);
    if (this.talk.open) {
      const mouth = F[`mouth_${this.talk.shape}`] || F.talk;
      if (mouth) out.push(mouth);
    }
    if (ex === 'blush' && F.blush) out.push(F.blush);
    return out;
  }

  // faces while an action plays: a whole-face patch, or eyes/mouth patches (blinking
  // and talking as usual unless the action holds them), and an optional blush
  actFaces(F) {
    const P = this.choreo.pose;
    const out = [];
    if (P.face && F[P.face]) {
      out.push(F[P.face]);
    } else {
      const eyes = P.eyes || this.blinkStage();
      if (eyes && F[eyes]) out.push(F[eyes]);
      const mouth = P.mouth || (this.talk.open ? this.talk.shape : null);
      if (mouth && F[`mouth_${mouth}`]) out.push(F[`mouth_${mouth}`]);
    }
    if (P.blush && F.blush) out.push(F.blush);
    return out;
  }

  // ---------------- speech ----------------
  //
  // source: 'self' (her own chatter and reactions), 'menu', 'api', 'rule', 'claude_code'.
  // Quiet mode mutes 'self' only. Anything that is not 'self' queues behind other
  // external speech instead of cutting it off, unless priority is 'high'.

  say(text, { source = 'self', priority = 'normal', duration = null } = {}) {
    text = String(text || '').trim();
    if (!text) return;
    if (source === 'self' && this.settings.quiet) return;
    const item = { text, source, priority, duration };
    const cur = this.speech;
    if (cur && cur.source !== 'self' && priority !== 'high') {
      if (source === 'self') return; // never interrupt external speech with chatter
      if (this.speechQueue.length < SPEECH_QUEUE_MAX) this.speechQueue.push(item);
      return;
    }
    this.showSpeech(item);
  }

  showSpeech({ text, source, duration }) {
    if (this.speech) this.emit('speech_end', { text: this.speech.text, interrupted: true });
    this.lastChat = this.t;
    const chars = Array.from(text);
    this.speech = { text, source, chars, shown: 0, next: this.t, hideAt: Infinity, duration };
    clearTimeout(this.hideTimer);
    this.bubble.text.textContent = '';
    this.bubble.el.hidden = false;
    this.bubble.el.classList.remove('pop', 'out');
    void this.bubble.el.offsetWidth; // restart the pop-in animation
    this.bubble.el.classList.add('pop');
    this.talk.until = this.t + chars.length * 0.05;
    this.emit('speech', { text, source });
  }

  updateBubble() {
    const sp = this.speech;
    if (!sp) return;
    let changed = false;
    while (sp.shown < sp.chars.length && this.t >= sp.next) {
      sp.shown += 1;
      sp.next += 0.05;
      changed = true;
    }
    if (changed) this.bubble.text.textContent = sp.chars.slice(0, sp.shown).join('');
    if (sp.shown >= sp.chars.length && sp.hideAt === Infinity) {
      sp.hideAt = this.t + (sp.duration ?? Math.max(2.4, sp.chars.length * 0.11));
    }
    if (this.t > sp.hideAt) {
      this.speech = null;
      const el = this.bubble.el;
      el.classList.add('out');
      this.hideTimer = setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 180);
      this.emit('speech_end', { text: sp.text, interrupted: false });
      const next = this.speechQueue.shift();
      if (next) this.showSpeech(next);
      return;
    }
    // over her head, wherever it is right now (stepping aside, hopping, hanging)
    const el = this.bubble.el;
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    const W = this.layout.width;
    const sp2 = this.modelSprite;
    const [hx] = this.model ? affine.apply(this.model, sp2.head[0], sp2.head[1]) : [this.winHead.x];
    const top = this.model ? Math.min(...[[0, 0], [sp2.w, 0]].map(([x, y]) => affine.apply(this.model, x, y)[1])) : this.hairTop;
    const left = clamp(hx - bw / 2, 4, W - bw - 4);
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(2, top - bh - 2)}px`;
    el.style.setProperty('--tail', `${clamp(hx - left, 16, bw - 16)}px`);
  }

  // ---------------- input ----------------

  hitAt(wx, wy) {
    if (!this.model) return false;
    const [x, y] = affine.apply(affine.invert(this.model), wx, wy);
    return this.modelSprite.mask.at(x, y) > 70;
  }

  setIgnore(ignore) {
    if (ignore !== this.ignore) {
      this.ignore = ignore;
      this.host.setIgnoreMouse(ignore);
    }
  }

  onMouseMove(e) {
    const hit = this.hitAt(e.clientX, e.clientY);
    if (!this.press) {
      this.setIgnore(!hit);
      this.cursor = { x: e.screenX, y: e.screenY };
    }
    // stroking the head back and forth = petting
    const p = this.petting;
    const nearHead = Math.hypot(e.clientX - this.winHead.x, e.clientY - this.winHead.y) < 0.3 * this.layout.petHeight;
    if (hit && nearHead && !this.press && p.prevX !== null) {
      if (this.t - p.last > 0.6) p.acc = 0;
      p.acc += Math.abs(e.clientX - p.prevX);
      p.last = this.t;
      if (p.acc > 260 * this.k && this.t > p.cooldown && ['idle', 'sit', 'think', 'work'].includes(this.state)) {
        p.acc = 0;
        p.cooldown = this.t + 3;
        this.onPetted();
      }
    }
    p.prevX = e.clientX;
  }

  onPointerDown(e) {
    if (e.button !== 0 || !this.hitAt(e.clientX, e.clientY)) return false;
    this.press = { x: e.screenX, y: e.screenY, dragging: false };
    this.cursor = { x: e.screenX, y: e.screenY };
    this.setIgnore(false);
    return true;
  }

  onPointerMove(e) {
    if (!this.press) return;
    this.cursor = { x: e.screenX, y: e.screenY };
    if (!this.press.dragging && Math.hypot(e.screenX - this.press.x, e.screenY - this.press.y) > 5) {
      this.press.dragging = true;
      if (this.state === 'sleep') this.say(pick('wake'));
      this.startDrag();
    }
  }

  onPointerUp() {
    const p = this.press;
    this.press = null;
    if (!p) return;
    if (p.dragging) this.release();
    else this.onClick();
  }

  onClick() {
    const now = this.t;
    this.clicks = this.clicks.filter((c) => now - c < 4);
    this.clicks.push(now);
    if (this.state === 'sleep') {
      this.emit('click', { state: 'sleep' });
      this.wake();
      return;
    }
    if (now < this.poutUntil) { // poking a sulking pet just keeps her sulking
      this.cancelClick();
      this.setExpression('pout', 2.6);
      this.poutUntil = now + 2.6;
      return;
    }
    if (this.clicks.length >= 5) {
      this.clicks = [];
      this.cancelClick();
      this.emit('poke', { count: 5 });
      this.pout();
      return;
    }
    if (this.clickTimer) {
      this.cancelClick();
      this.emit('double_click', { state: this.state });
      if (WORK_STATES.includes(this.state)) return;
      if (Math.random() < 0.5 && this.playAction('raise_hand')) return;
      this.setState('wave');
      this.say(pick('hello'));
      return;
    }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.emit('click', { state: this.state });
      this.reactClick();
    }, 240);
  }

  cancelClick() {
    clearTimeout(this.clickTimer);
    this.clickTimer = null;
  }

  reactClick() {
    if (['drag', 'fall', 'cheer', 'work_in', 'work_out'].includes(this.state)) return;
    const h = this.winHead;
    if (this.state === 'work') {
      this.workPhase = { kind: 'happy', until: this.t + 1.4 };
      this.fx.hearts(h.x, h.y - 30 * this.k, this.k, 2);
      this.say(pick('workClick'));
      return;
    }
    if (this.state === 'act') return; // let her finish what she is doing
    if (this.state !== 'sit' && Math.random() < 0.4 && this.rig) {
      const pool = ['giggle', 'wink', 'confused', 'startled', 'smirk', 'point', 'proud'];
      if (this.playAction(pool[Math.floor(Math.random() * pool.length)])) return;
    }
    if (this.state === 'sit') {
      this.fx.hearts(h.x, h.y - 30 * this.k, this.k, 2);
      this.say(this.working ? pick('ccWork') : pick('read'));
      return;
    }
    if (Math.random() < 0.2) {
      this.setState('cheer');
      this.say(pick('click'));
      return;
    }
    if (this.state !== 'idle') this.setState('idle');
    this.setExpression('happy', 1.6);
    this.hopAt = this.t;
    if (this.rig) this.rig.kick(1.6);
    this.fx.burst(h.x, h.y - 20 * this.k, this.k, 8);
    this.say(pick('click'));
  }

  pout() {
    this.poutUntil = this.t + 4.2;
    if (this.playAction('angry')) return;
    if (this.state !== 'idle') this.setState('idle');
    this.setExpression('pout', 2.6);
    this.say(pick('poke'));
  }

  onPetted() {
    const h = this.winHead;
    if (this.rig) this.rig.kick(0.6);
    this.emit('pet', { state: this.state });
    if (this.state === 'idle' && Math.random() < 0.45 && this.playAction('shy')) return;
    this.fx.hearts(h.x, h.y - 40 * this.k, this.k, 3);
    if (this.state !== 'sit') {
      if (this.state !== 'idle') this.setState('idle');
      this.setExpression('happy', 2);
    }
    this.say(pick('pet'));
  }

  // ---------------- inputs ----------------

  act(action, opts = {}) {
    if (['drag', 'fall'].includes(this.state)) return;
    if (WORK_STATES.includes(this.state) && !['work', 'work_end', 'chatter'].includes(action)) {
      if (action === 'idle') this.endWork();
      return;
    }
    switch (action) {
      case 'idle': this.setState('idle'); break;
      case 'wave': this.setState('wave', { dur: opts.duration }); break;
      case 'cheer': this.setState('cheer'); break;
      case 'think': this.setState('think', { dur: opts.duration || 3 }); break;
      case 'sit': this.setState('sit', { dur: opts.duration || rand(40, 90) }); break;
      case 'sleep': this.setState('sleep', { dur: opts.duration }); break;
      case 'wake': if (this.state === 'sleep') this.wake(); break;
      case 'walk':
        if (Number.isFinite(opts.x)) this.walkTo(opts.x);
        else if (Number.isFinite(opts.dx)) this.walkTo(this.foot.x + opts.dx);
        else this.walkTo(this.randomTarget());
        break;
      case 'chatter': this.chatter(true); break;
      case 'work': this.startWork(opts.duration || 60); break;
      case 'work_end': this.endWork(); break;
      default:
        if (ACTIONS[action]) {
          if (WORK_STATES.includes(this.state) || this.state === 'act') this.choreo = null;
          if (this.state === 'work') return; // seated: finish working first
          this.setState('act', { name: action });
        }
        break;
    }
  }

  command(cmd) {
    switch (cmd.type) {
      case 'say':
        if (cmd.expression) this.setExpression(cmd.expression, cmd.duration || 2.5);
        this.say(cmd.text, { source: cmd.source || 'api', priority: cmd.priority, duration: cmd.duration });
        break;
      case 'act': this.act(cmd.action, cmd); break;
      case 'expression': this.setExpression(cmd.name, cmd.duration || 2.5); break;
      case 'settings': this.settings = cmd.settings; break;
      case 'layout': this.setLayout(cmd.layout); break;
      case 'displays': this.displays = cmd.displays; this.reground(); break;
      case 'home': this.foot = { ...cmd.foot }; this.setState('land', { impact: 0 }); break;
      case 'claude_code': this.onClaudeCode(cmd.event, cmd.text); break;
      default: break;
    }
  }

  // Claude Code hook events (see integrations/claude-code)
  onClaudeCode(event, text) {
    if (['drag', 'fall'].includes(this.state)) return;
    const say = (line, priority = 'normal') => this.say(line, { source: 'claude_code', priority });
    switch (event) {
      case 'SessionStart':
        this.setState('wave');
        say(pick('ccStart'));
        break;
      case 'UserPromptSubmit':
        this.working = true;
        say(pick('ccPrompt'));
        if (this.rigs.work) this.startWork(0);
        else this.setState('think', { dur: 2.5 });
        break;
      case 'PreToolUse':
      case 'PostToolUse':
        this.working = true;
        if (this.rigs.work) this.startWork(0);
        else if (!['sit', 'think', 'wave'].includes(this.state)) this.setState('sit', { dur: 600 });
        break;
      case 'Notification':
        say(text && Array.from(text).length <= 24 ? text : pick('ccAttention'), 'high');
        if (this.state === 'work') this.workPhase = { kind: 'happy', until: this.t + 2 };
        else if (!this.playAction('raise_hand')) this.setState('wave');
        break;
      case 'Stop':
        this.working = false;
        this.workUntil = 0;
        say(pick('ccDone'), 'high');
        if (WORK_STATES.includes(this.state)) this.afterWork = 'cheer_on';
        else if (!this.playAction('cheer_on')) this.setState('cheer');
        break;
      case 'SubagentStop':
        this.fx.sparkles(this.winHead.x, this.winHead.y, this.k, 3);
        break;
      default:
        break;
    }
  }

  // ---------------- output ----------------

  snapshot() {
    return {
      state: this.state,
      action: this.choreo ? this.choreo.name : null,
      expression: this.expr && this.t < this.exprUntil ? this.expr : null,
      speaking: this.speech ? this.speech.text : null,
      working: this.working,
      foot: { x: Math.round(this.foot.x), y: Math.round(this.foot.y) },
    };
  }

  syncWindow() {
    const f = this.foot;
    const last = this.lastSent;
    if (!last || Math.abs(last.x - f.x) >= 0.5 || Math.abs(last.y - f.y) >= 0.5) {
      this.host.moveTo(f.x, f.y);
      this.lastSent = { ...f };
    }
  }

  // the contact shadow for the current pose: {x, y, w, h, opacity} in window css px
  shadowParams() {
    const h = this.layout.petHeight;
    const v = this.view;
    if (['drag', 'fall'].includes(this.state)) return null;
    const sprite = v.sprite;
    let w = 0.5 * h;
    let o = 1;
    if (sprite === 'sit_read') w = 0.78 * h;
    else if (sprite === 'work') w = 1.1 * h;
    else if (sprite === 'walk') w = 0.55 * h;
    const lift = clamp(-(v.dy || 0) / (0.25 * h), 0, 1); // hops: the shadow shrinks and fades
    w *= 1 - 0.35 * lift;
    o *= 1 - 0.55 * lift;
    return { x: this.winFoot.x + (v.dx || 0), y: this.winFoot.y + 0.01 * h, w, h: 0.11 * w, opacity: o };
  }

  drawShadowAt(sh) {
    const S = this.shadow;
    if (!S || !S.tex || !sh || sh.opacity <= 0.01) return;
    let m = affine.translate(sh.x - sh.w / 2, sh.y - sh.h / 2);
    m = affine.mul(m, affine.scale(sh.w / S.w, sh.h / S.h));
    this.r.draw(S.tex, m, { rect: [0, 0, S.w, S.h], spriteW: S.w, spriteH: S.h, opacity: sh.opacity });
  }

  // one drawing of her: a rig or a whole sprite with its face patches
  drawCharacter(d, opacity = 1, ox = 0, oy = 0) {
    const m = ox || oy ? affine.mul(affine.translate(ox, oy), d.model) : d.model;
    if (d.rigOn) {
      const rig = d.rig;
      const mode = rig.showMode;
      if (opacity < 1) rig.showMode = 'char'; // a fading copy never brings the furniture along
      rig.draw(this.r, m, d.faces, opacity);
      rig.showMode = mode;
      return;
    }
    const { view: v, sp } = d;
    const swayPx = 6 * v.sway * sp.swayAmp;
    this.r.draw(sp.tex, m, {
      rect: [0, 0, sp.w, sp.h], spriteW: sp.w, spriteH: sp.h, sway: sp.swayTex, time: this.t,
      swayAmp: [swayPx / sp.w, (0.35 * swayPx) / sp.h], swayBias: v.swayBias / sp.w, opacity,
    });
    for (const f of d.faces) {
      this.r.draw(f.tex, m, { rect: [f.x, f.y, f.w, f.h], spriteW: sp.w, spriteH: sp.h, opacity });
    }
  }

  render() {
    const cur = this.curDraw;
    if (!cur) return;
    this.r.clear();
    this.drawShadowAt(this.shadowParams());
    if (this.propsView && this.propsView.model && this.propsView.opacity > 0.001) {
      const o = this.propsView.opacity;
      this.r.clipX(this.propsView.x0, this.propsView.x1);
      this.drawShadowAt({ x: this.winFoot.x, y: this.winFoot.y + 0.01 * this.layout.petHeight,
        w: 1.1 * this.layout.petHeight, h: 0.12 * this.layout.petHeight, opacity: o });
      this.propsRig.draw(this.r, this.propsView.model, [], o);
      this.r.clipX();
    }
    if (this.slitView && this.light && this.light.tex) this.drawSlit(this.slitView);
    this.drawCharacter(cur);
    if (this.xfade) {
      // the window moved with her feet since then: keep the old drawing where it was
      const x = this.xfade;
      const p = clamp((this.t - x.t0) / XFADE, 0, 1);
      this.drawCharacter(x, 1 - ease.smooth(p), x.foot.x - this.foot.x, x.foot.y - this.foot.y);
    }
    this.fx.draw();
  }
}

const ramp01 = (t, a, b) => ease.smooth(clamp((t - a) / (b - a), 0, 1));
// height offset of a hop starting at t0 (css px, negative = up)
const hopY = (t, t0, dur, h) => {
  const x = (t - t0) / dur;
  return x < 0 || x > 1 ? 0 : -4 * h * x * (1 - x);
};
