// Claude's own behaviour on top of the engine: what she does when idle (reads a book,
// thinks, dozes off), how she greets, reacts to clicks and strokes, the work routine
// at the desk, and how her states map onto her rigs' parameters and face patches.

import { affine } from '../../engine/gl.js';
import { clamp, ease, hopY, ramp01, rand } from '../../engine/anim.js';
import { Pet } from '../../engine/pet.js';

// standing poses that the layered rig draws, and which arm it shows for each
const RIG_ARM = { idle: 'down', wave_a: 'wave', wave_b: 'wave', think: 'chin' };
const WORK_STATES = ['work_in', 'work', 'work_out'];

export class ClaudePet extends Pet {
  constructor(opts) {
    super(opts);
    this.workPhase = null;
    this.workUntil = 0;
    this.afterWork = null;
    this.pageFlip = -1e9;
    this.lastWorkLine = -1e9;
  }

  greet() {
    this.setState('wave');
    super.greet();
  }

  // the thinking pose looks up and away
  gazeTarget() {
    if (!this.glance && this.view.sprite === 'think') return [0.55, -0.85];
    return super.gazeTarget();
  }

  // ---------------- rigs ----------------

  rigParams(kind, rig) {
    if (kind === 'work') {
      const ph = this.workPhase ? this.workPhase.kind : 'write';
      // eyes on the paper (down and to the right), up and away while thinking, and a
      // glance at the cursor when it comes close
      const [gazeX, gazeY] = (ph !== 'think' && this.cursorGaze(300)) || (ph === 'think' ? [0.45, -0.85] : [0.75, 0.55]);
      return {
        armW: ph === 'think' ? 'think' : 'write', write: ph === 'write' ? 1 : 0, tap: ph === 'think' ? 1 : 0,
        headTilt: ph === 'think' ? -5 : ph === 'happy' ? 5 : 0, headNod: ph === 'write' ? 2 : 0,
        lean: ph === 'happy' ? -1 : 0, gazeX, gazeY,
      };
    }
    if (kind === 'walk') return { phase: this.walkPhase, stride: 1 };
    if (kind === 'sit') {
      // reading: the eyes run along the line in step with the head (poseSit), look up
      // at a cursor that comes close
      const line = (rig.time % 4.6) / 4.6;
      const scan = line < 0.9 ? -0.6 + (1.2 * line) / 0.9 : 0.6 - (1.2 * (line - 0.9)) / 0.1;
      const [gazeX, gazeY] = this.cursorGaze(420) || [scan, 0.55];
      return { sleep: this.state === 'sleep' ? 1 : 0, gazeX, gazeY };
    }
    if (kind === 'drag') return { flail: this.state === 'fall' ? 1.3 : 1 };
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
      return p;
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
    return p;
  }

  // ---------------- faces ----------------

  specialFaces(set, F) {
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
    return null;
  }

  eyesUp() {
    return this.view.sprite === 'think';
  }

  // ---------------- idle life ----------------

  // Claude Code is busy: go and work (or at least sit down with the book)
  interruptIdle() {
    if (this.working && this.rigs.work) {
      this.setState('work_in');
      return true;
    }
    if (this.working && this.t >= this.nextDecision) {
      this.setState('sit', { dur: 600 });
      return true;
    }
    return false;
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
      if (Math.random() < 0.5) this.say(this.pick('think'));
      return;
    }
    if (r < 0.8 && this.rig) {
      this.playAction(this.ch.pickIdleAction());
      return;
    }
    if (r < 0.88) {
      this.glance = { dir: Math.random() < 0.5 ? -1 : 1, until: this.t + rand(1.2, 2.2) };
      return;
    }
    this.chatter();
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
        this.say(this.pick('ccWork'));
      } else if (!this.working && Math.random() < 0.3) {
        this.say(this.pick('read'));
      }
    }
    if (this.working || this.t < this.sitUntil) return;
    if (Math.random() < 0.45) {
      if (Math.random() < 0.5) this.say(this.pick('sleepy'));
      this.setState('sleep');
    } else {
      this.standUp();
    }
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

  enter_work_in() {
    this.wg = this.workGeometry();
    this.clearProps();
    this.say(this.pick('workStart'));
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
    if (t < 2.15) this.setProps('work', x0, x1, t < 0.85 ? 0 : 0.25 + 0.75 * spread);
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
        this.say(this.pick('workPop'));
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
        if (Math.random() < 0.4) this.say(this.pick('workThink'));
      } else if (ph.kind === 'write' && r < 0.7) {
        this.workPhase = { kind: 'happy', until: this.t + 1.4 };
        this.fx.sparkles(this.winHead.x, this.winHead.y, this.k, 3);
        if (Math.random() < 0.5) this.say(this.pick('workHappy'));
      } else {
        this.workPhase = { kind: 'write', until: this.t + rand(5, 10) };
      }
    }
    if (this.t > this.nextWorkLine) {
      this.nextWorkLine = this.t + rand(15, 30);
      if (this.workPhase.kind === 'write' && Math.random() < 0.4) this.say(this.pick('workWrite'));
    }
    if (!this.working && this.t > this.workUntil) this.setState('work_out');
  }

  enter_work_out() {
    this.wg = this.workGeometry();
    this.workPhase = { kind: 'happy', until: Infinity };
    this.say(this.pick('workDone'));
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
        this.setProps('work', x0, x1, 0.25 + 0.75 * spread);
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

  // picked up mid-work: the furniture vanishes
  startDrag() {
    if (WORK_STATES.includes(this.state)) {
      this.slitView = null;
      if (this.propsView || this.state === 'work') this.fx.sparkles(this.winFoot.x, this.winFoot.y - 60 * this.k, this.k, 8);
      this.clearProps();
      this.workPhase = null;
    }
    super.startDrag();
  }

  // ---------------- reactions ----------------

  onDoubleClick() {
    if (WORK_STATES.includes(this.state)) return;
    if (Math.random() < 0.5 && this.playAction('raise_hand')) return;
    this.setState('wave');
    this.say(this.pick('hello'));
  }

  reactClick() {
    if (['drag', 'fall', 'cheer', 'work_in', 'work_out'].includes(this.state)) return;
    const h = this.winHead;
    if (this.state === 'work') {
      this.workPhase = { kind: 'happy', until: this.t + 1.4 };
      this.fx.hearts(h.x, h.y - 30 * this.k, this.k, 2);
      this.say(this.pick('workClick'));
      return;
    }
    if (this.state === 'act') return; // let her finish what she is doing
    if (this.state !== 'sit' && Math.random() < 0.4 && this.rig) {
      const pool = this.ch.reactions.click;
      if (this.playAction(pool[Math.floor(Math.random() * pool.length)])) return;
    }
    if (this.state === 'sit') {
      this.fx.hearts(h.x, h.y - 30 * this.k, this.k, 2);
      this.say(this.working ? this.pick('ccWork') : this.pick('read'));
      return;
    }
    if (Math.random() < 0.2) {
      this.setState('cheer');
      this.say(this.pick('click'));
      return;
    }
    if (this.state !== 'idle') this.setState('idle');
    this.setExpression('happy', 1.6);
    this.hopAt = this.t;
    if (this.rig) this.rig.kick(1.6);
    this.fx.burst(h.x, h.y - 20 * this.k, this.k, 8);
    this.say(this.pick('click'));
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
    this.say(this.pick('pet'));
  }

  // ---------------- inputs ----------------

  act(action, opts = {}) {
    if (['drag', 'fall'].includes(this.state)) return;
    if (WORK_STATES.includes(this.state) && !['work', 'work_end', 'chatter'].includes(action)) {
      if (action === 'idle') this.endWork();
      return;
    }
    switch (action) {
      case 'wave': this.setState('wave', { dur: opts.duration }); break;
      case 'cheer': this.setState('cheer'); break;
      case 'think': this.setState('think', { dur: opts.duration || 3 }); break;
      case 'sit': this.setState('sit', { dur: opts.duration || rand(40, 90) }); break;
      case 'sleep': this.setState('sleep', { dur: opts.duration }); break;
      case 'work': this.startWork(opts.duration || 60); break;
      case 'work_end': this.endWork(); break;
      default: super.act(action, opts); break;
    }
  }

  // Claude Code hook events (see integrations/claude-code)
  onClaudeCode(event, text) {
    if (['drag', 'fall'].includes(this.state)) return;
    const say = (line, priority = 'normal') => this.say(line, { source: 'claude_code', priority });
    switch (event) {
      case 'SessionStart':
        this.setState('wave');
        say(this.pick('ccStart'));
        break;
      case 'UserPromptSubmit':
        this.working = true;
        say(this.pick('ccPrompt'));
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
        say(text && Array.from(text).length <= 24 ? text : this.pick('ccAttention'), 'high');
        if (this.state === 'work') this.workPhase = { kind: 'happy', until: this.t + 2 };
        else if (!this.playAction('raise_hand')) this.setState('wave');
        break;
      case 'Stop':
        this.working = false;
        this.workUntil = 0;
        say(this.pick('ccDone'), 'high');
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
}

// keep the unused-import linters honest: affine is handy for subclasses placing things
export { affine };
