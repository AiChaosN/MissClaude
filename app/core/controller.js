'use strict';
// The pet as a module: inputs (say / act / expression / signal / Claude Code hook)
// become commands for the renderer; interactions and state changes reported by the
// renderer become numbered output events for subscribers (SSE, webhooks, in-process).
// Transport-free on purpose: the HTTP server and the menus are thin adapters on top.

const { EventEmitter } = require('node:events');
const { RuleEngine, OPS, renderTemplate } = require('./rules');

const API_VERSION = 1;
const PRIORITIES = ['normal', 'high'];
const EVENTS = {
  ready: 'renderer loaded',
  click: 'single click on her',
  double_click: 'double click on her',
  pet: 'head stroked back and forth',
  poke: 'clicked 5 times within 4 s',
  drag_start: 'picked up with the mouse',
  drop: 'released after dragging (x, y, vx, vy)',
  land: 'landed after a fall (impact)',
  wake: 'woke up',
  state: 'behaviour state changed (from, to)',
  action: 'an action from the library started playing (name)',
  work: 'the work routine started or ended (phase: start | end)',
  speech: 'speech bubble shown (text, source)',
  speech_end: 'speech bubble hidden (text, interrupted)',
  signal: 'a signal was pushed (name, value)',
  rule_fired: 'a rule matched (rule, signal, say)',
  menu: 'context/tray menu item chosen (item)',
  claude_code: 'a Claude Code hook event arrived (event)',
  perform: 'a composed performance started or ended (name, phase: start | end)',
};
const MAX_STEPS = 24;
const MAX_PERFORM_SECONDS = 90;
const MAX_TEXT = 300;
const HISTORY = 200;

class InputError extends Error {}

class PetController extends EventEmitter {
  // character: the pack's character.json - what the pet can do (actions: the pack's
  // own states plus the engine's; library: its timed performances; expressions)
  constructor({ send, rules = [], character = null }) {
    super();
    this.setMaxListeners(100);
    this.send = send;
    const ch = character || require('../characters/claude/character.json');
    this.character = ch.name;
    this.actions = [...ch.actions, ...ch.library];
    this.expressions = [...ch.expressions, 'neutral'];
    this.engine = new RuleEngine(rules);
    this.seq = 0;
    this.history = [];
    this.pet = { state: null, speaking: null, ready: false };
    this.timers = new Set();
    this.clockTimer = null;
  }

  // The clock: a "clock" signal once a minute (and once at start), so rules can fire at
  // a time of day - an alarm is just a rule on {time: "07:30"}.
  startClock() {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      this.signal('clock', {
        time: `${hh}:${mm}`, hour: d.getHours(), minute: d.getMinutes(), weekday: d.getDay(),
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      }, { quiet: true });
      // next tick just after the next minute boundary
      this.clockTimer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    };
    tick();
  }

  stopClock() {
    clearTimeout(this.clockTimer);
    this.clockTimer = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ---------- inputs ----------

  say({ text, duration, expression, priority = 'normal' } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new InputError('"text" must be a non-empty string');
    if (Array.from(text).length > MAX_TEXT) throw new InputError(`"text" is limited to ${MAX_TEXT} characters`);
    if (expression !== undefined && !this.expressions.includes(expression)) {
      throw new InputError(`unknown expression "${expression}" (use ${this.expressions.join(', ')})`);
    }
    if (!PRIORITIES.includes(priority)) throw new InputError(`priority must be one of ${PRIORITIES.join(', ')}`);
    this.send({ type: 'say', text, duration: num(duration), expression, priority, source: 'api' });
    return { ok: true };
  }

  act({ action, duration, x, dx } = {}) {
    if (!this.actions.includes(action)) throw new InputError(`unknown action "${action}" (use ${this.actions.join(', ')})`);
    this.send({ type: 'act', action, duration: num(duration), x: num(x), dx: num(dx) });
    return { ok: true };
  }

  expression({ name, duration } = {}) {
    if (!this.expressions.includes(name)) throw new InputError(`unknown expression "${name}" (use ${this.expressions.join(', ')})`);
    this.send({ type: 'expression', name, duration: num(duration) });
    return { ok: true };
  }

  // Push data in. Rules decide whether she reacts; the value is kept for /state.
  // quiet: no "signal" event (the clock would flood the stream).
  signal(name, value, { quiet = false } = {}) {
    if (typeof name !== 'string' || !name) throw new InputError('"name" must be a non-empty string');
    if (value === undefined) throw new InputError('"value" is required');
    const fired = this.engine.push(name, value);
    if (!quiet) this.publish('signal', { name, value });
    for (const f of fired) {
      if (f.steps) {
        this.runSteps(f.steps, { name: f.rule, source: 'rule', value });
      } else {
        if (f.expression) this.send({ type: 'expression', name: f.expression, duration: f.duration || 3 });
        if (f.action) this.send({ type: 'act', action: f.action, duration: f.duration });
        if (f.say) this.send({ type: 'say', text: f.say, priority: f.priority, duration: f.duration, source: 'rule' });
      }
      this.publish('rule_fired', { rule: f.rule, signal: name, say: f.say });
    }
    return { ok: true, fired: fired.map((f) => f.rule) };
  }

  // A performance composed from the outside: timed steps of say / action / expression.
  // Products add new behaviour this way without touching the renderer.
  perform({ name = 'perform', steps } = {}) {
    const checked = this.checkSteps(steps);
    this.runSteps(checked, { name: String(name).slice(0, 60), source: 'api' });
    return { ok: true, steps: checked.length, seconds: checked.length ? checked[checked.length - 1].at : 0 };
  }

  checkSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) throw new InputError('"steps" must be a non-empty list');
    if (steps.length > MAX_STEPS) throw new InputError(`at most ${MAX_STEPS} steps`);
    const out = steps.map((s, i) => {
      if (!s || typeof s !== 'object') throw new InputError(`step ${i}: must be an object`);
      const at = num(s.at) ?? 0;
      if (at < 0 || at > MAX_PERFORM_SECONDS) throw new InputError(`step ${i}: "at" must be 0..${MAX_PERFORM_SECONDS} seconds`);
      if (s.action !== undefined && !this.actions.includes(s.action)) throw new InputError(`step ${i}: unknown action "${s.action}"`);
      if (s.expression !== undefined && !this.expressions.includes(s.expression)) throw new InputError(`step ${i}: unknown expression "${s.expression}"`);
      if (s.say !== undefined && (typeof s.say !== 'string' || Array.from(s.say).length > MAX_TEXT)) {
        throw new InputError(`step ${i}: "say" must be a string of at most ${MAX_TEXT} characters`);
      }
      if (s.say === undefined && s.action === undefined && s.expression === undefined) {
        throw new InputError(`step ${i}: needs "say", "action" or "expression"`);
      }
      return { at, say: s.say, action: s.action, expression: s.expression, duration: num(s.duration), priority: s.priority === 'high' ? 'high' : 'normal' };
    });
    return out.sort((a, b) => a.at - b.at);
  }

  runSteps(steps, { name, source, value }) {
    this.publish('perform', { name, phase: 'start', steps: steps.length });
    const last = steps.length ? steps[steps.length - 1].at : 0;
    for (const s of steps) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (s.expression) this.send({ type: 'expression', name: s.expression, duration: s.duration || 3 });
        if (s.action) this.send({ type: 'act', action: s.action, duration: s.duration });
        if (s.say) {
          const text = value !== undefined ? renderTemplate(s.say, value) : s.say;
          this.send({ type: 'say', text, priority: s.priority, duration: s.duration, source });
        }
      }, s.at * 1000);
      this.timers.add(timer);
    }
    const done = setTimeout(() => {
      this.timers.delete(done);
      this.publish('perform', { name, phase: 'end' });
    }, last * 1000 + 50);
    this.timers.add(done);
  }

  // Claude Code hook payload (the JSON a hook command receives on stdin). `text` is
  // what the hook script attaches: Claude's last reply on Stop, which the pet speaks
  // in brief; `message` is a Notification's text.
  claudeCode(payload = {}) {
    const event = String(payload.hook_event_name || '');
    if (!event) throw new InputError('payload has no hook_event_name');
    const text = event === 'Stop' || event === 'SubagentStop' ? briefReply(payload.text) : String(payload.message || '');
    this.send({ type: 'claude_code', event, text: text.slice(0, MAX_TEXT) });
    this.publish('claude_code', { event, ...(text ? { text } : {}) });
    return { ok: true };
  }

  setRules(rules) {
    try {
      this.engine.setRules(rules);
    } catch (err) {
      throw new InputError(err.message);
    }
    return { ok: true, count: this.engine.rules.length };
  }

  rules() {
    return this.engine.rules;
  }

  resetRules() {
    this.engine.reset();
    return { ok: true };
  }

  // ---------- outputs ----------

  publish(type, data = {}) {
    const ev = { id: ++this.seq, type, ts: new Date().toISOString(), data };
    this.history.push(ev);
    if (this.history.length > HISTORY) this.history.shift();
    this.emit('event', ev);
    return ev;
  }

  // fn(event) for every new event; returns an unsubscribe function
  subscribe(fn, types = null) {
    const handler = (ev) => { if (!types || types.includes(ev.type)) fn(ev); };
    this.on('event', handler);
    return () => this.off('event', handler);
  }

  eventsSince(id, types = null) {
    return this.history.filter((ev) => ev.id > id && (!types || types.includes(ev.type)));
  }

  // events reported by the renderer
  fromRenderer(type, data = {}) {
    if (!(type in EVENTS)) return;
    if (type === 'ready') this.pet.ready = true;
    if (type === 'state') this.pet.state = data.to;
    if (type === 'speech') this.pet.speaking = data.text;
    if (type === 'speech_end' && this.pet.speaking === data.text) this.pet.speaking = null;
    this.publish(type, data);
  }

  state(extra = {}) {
    return { ...this.pet, ...extra, signals: this.engine.signals() };
  }

  capabilities() {
    return {
      api: API_VERSION,
      character: this.character,
      actions: this.actions,
      expressions: this.expressions,
      priorities: PRIORITIES,
      events: EVENTS,
      rule_ops: OPS,
      signals: { clock: 'once a minute: {time "HH:MM", hour, minute, weekday 0-6 (Sunday 0), date "YYYY-MM-DD"}' },
      limits: { text: MAX_TEXT, history: HISTORY, steps: MAX_STEPS, performSeconds: MAX_PERFORM_SECONDS },
    };
  }
}

// A reply of any length as one bubble line: no markdown furniture, the first
// sentence or so, cut at BRIEF_CHARS with an ellipsis.
const BRIEF_CHARS = 72;
function briefReply(text) {
  let s = String(text || '');
  if (!s.trim()) return '';
  s = s.replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/gm, '') // headings, bullets, quotes
    .replace(/\*\*([^*]*)\*\*|__([^_]*)__/g, '$1$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  // the first real paragraph (a bare heading does not count), then its first
  // sentence or two if that is still long
  const paras = s.split(/\n\s*\n/).map((x) => x.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  s = paras.find((x) => Array.from(x).length >= 8) || paras.sort((a, b) => b.length - a.length)[0] || '';
  const chars = Array.from(s);
  if (chars.length <= BRIEF_CHARS) return s;
  const head = chars.slice(0, BRIEF_CHARS).join('');
  const cut = Math.max(...['。', '！', '？', '. ', '! ', '? ', '；', ';'].map((p) => head.lastIndexOf(p)));
  return (cut >= 16 ? head.slice(0, cut + 1).trim() : head.trim()) + '…';
}

function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new InputError(`expected a number, got "${v}"`);
  return n;
}

module.exports = { PetController, InputError, API_VERSION, EVENTS, briefReply };
