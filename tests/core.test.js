'use strict';
// node --test tests/   (no Electron needed: the module core is transport-free)

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { RuleEngine, renderTemplate } = require('../app/core/rules');
const { PetController } = require('../app/core/controller');
const { createApiServer } = require('../app/core/server');
const defaultRules = require('../app/core/default-rules.json');

test('level rule fires, then respects its cooldown', () => {
  const e = new RuleEngine([{ id: 'hi', signal: 'u', when: [{ path: 'p', op: '>=', value: 80 }], say: '{p}%', cooldown: 60 }]);
  assert.deepEqual(e.push('u', { p: 79 }, 0).map((f) => f.rule), []);
  assert.equal(e.push('u', { p: 85 }, 1000)[0].say, '85%');
  assert.equal(e.push('u', { p: 90 }, 30000).length, 0);       // within cooldown
  assert.equal(e.push('u', { p: 90 }, 62000).length, 1);       // cooldown over
});

test('edge rules need a previous value and fire once per crossing', () => {
  const e = new RuleEngine([{ id: 'up', signal: 'u', when: [{ path: 'p', op: 'crosses_above', value: 50 }], say: 'x' }]);
  assert.equal(e.push('u', { p: 70 }).length, 0);  // first sample: no crossing yet
  assert.equal(e.push('u', { p: 40 }).length, 0);
  assert.equal(e.push('u', { p: 55 }).length, 1);
  assert.equal(e.push('u', { p: 60 }).length, 0);
});

test('templates read nested paths and format numbers', () => {
  assert.equal(renderTemplate('{a.b}% / {c} / {missing}', { a: { b: 83.25 }, c: 'ok' }), '83.3% / ok / ?');
  assert.equal(renderTemplate('{}', 7), '7');
});

test('invalid rules are rejected with a useful message', () => {
  assert.throws(() => new RuleEngine([{ id: 'x', signal: 's', when: [{ op: '~=' }], say: 'a' }]), /unknown op/);
  assert.throws(() => new RuleEngine([{ id: 'x', signal: 's' }]), /needs "say"/);
  assert.throws(() => new RuleEngine([{ id: 'x', signal: 's', say: 'a' }, { id: 'x', signal: 's', say: 'b' }]), /duplicate/);
  assert.doesNotThrow(() => new RuleEngine(defaultRules));
});

test('default usage rules: 83% says something, the 95% rule takes over', () => {
  const e = new RuleEngine(defaultRules);
  assert.deepEqual(e.push('claude.usage', { percent: 83 }, 0).map((f) => f.rule), ['usage-high']);
  assert.deepEqual(e.push('claude.usage', { percent: 96 }, 1000).map((f) => f.rule), ['usage-critical']);
  assert.deepEqual(e.push('claude.usage', { percent: 3 }, 2000).map((f) => f.rule), ['usage-reset']);
});

test('each character pack lists every action of its library', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'app', 'characters');
  const packs = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'character.json')));
  assert.ok(packs.includes('claude'));
  for (const name of packs) {
    const info = require(path.join(dir, name, 'character.json'));
    const { ACTION_NAMES, validateActions } = await import(`../app/characters/${name}/actions.js`);
    assert.equal(info.name, name);
    assert.deepEqual([...info.library].sort(), [...ACTION_NAMES].sort(), `${name}: library list`);
    assert.deepEqual(validateActions(), [], `${name}: actions`);
    for (const key of ['window', 'sizes', 'menu', 'actions', 'expressions']) assert.ok(info[key], `${name}: ${key}`);
  }
});

test('controller turns a signal into renderer commands and output events', () => {
  const sent = [];
  const c = new PetController({ send: (cmd) => sent.push(cmd), rules: defaultRules });
  const seen = [];
  const off = c.subscribe((ev) => seen.push(ev.type));
  const r = c.signal('claude.usage', { percent: 88 });
  assert.deepEqual(r.fired, ['usage-high']);
  assert.deepEqual(sent.map((s) => s.type), ['act', 'say']);
  assert.equal(sent[0].action, 'awkward');
  assert.equal(sent[1].text, '额度已经用了 88%，悠着点哦～');
  assert.equal(sent[1].source, 'rule');
  assert.deepEqual(seen, ['signal', 'rule_fired']);
  off();
  c.fromRenderer('click', { state: 'idle' });
  assert.deepEqual(seen, ['signal', 'rule_fired']); // unsubscribed
  assert.equal(c.eventsSince(0).length, 3);
  assert.throws(() => c.act({ action: 'fly' }), /unknown action/);
  assert.throws(() => c.say({ text: '' }), /non-empty/);
});

test('rules: a list of lines picks one at random; steps run as a timed performance', async () => {
  const sent = [];
  const c = new PetController({ send: (cmd) => sent.push(cmd), rules: [
    { id: 'lines', signal: 'mood', say: ['a {v}', 'b {v}'] },
    { id: 'show', signal: 'go', steps: [{ at: 0, action: 'wave' }, { at: 0.05, say: 'hi {n}', expression: 'happy' }] },
  ] });
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    c.signal('mood', { v: i });
    seen.add(sent.pop().text[0]);
  }
  assert.deepEqual([...seen].sort(), ['a', 'b']);
  const events = [];
  c.subscribe((ev) => events.push(ev), ['perform']);
  c.signal('go', { n: 7 });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(sent.map((s) => s.type), ['act', 'expression', 'say']);
  assert.equal(sent[2].text, 'hi 7');
  assert.deepEqual(events.map((e) => e.data.phase), ['start', 'end']);
  c.stopClock();
});

test('the clock signal drives time-of-day rules', () => {
  const sent = [];
  const c = new PetController({ send: (cmd) => sent.push(cmd), rules: [
    { id: 'alarm', signal: 'clock', when: [{ path: 'time', op: '==', value: '07:30' }], say: '起床！', cooldown: 3600 },
  ] });
  assert.deepEqual(c.signal('clock', { time: '07:29', hour: 7, minute: 29 }).fired, []);
  assert.deepEqual(c.signal('clock', { time: '07:30', hour: 7, minute: 30 }).fired, ['alarm']);
  assert.deepEqual(c.signal('clock', { time: '07:30', hour: 7, minute: 30 }).fired, []); // cooldown
  // startClock pushes a first tick immediately, shaped like the documented signal
  c.startClock();
  const clock = c.state().signals.clock;
  assert.match(clock.time, /^\d\d:\d\d$/);
  assert.match(clock.date, /^\d{4}-\d\d-\d\d$/);
  assert.ok(clock.weekday >= 0 && clock.weekday <= 6);
  c.stopClock();
});

test('perform validates its steps', () => {
  const c = new PetController({ send: () => {} });
  assert.throws(() => c.perform({ steps: [] }), /non-empty/);
  assert.throws(() => c.perform({ steps: [{ at: 0, action: 'fly' }] }), /unknown action/);
  assert.throws(() => c.perform({ steps: [{ at: 999, say: 'x' }] }), /0\.\.90/);
  const r = c.perform({ name: 'demo', steps: [{ at: 1, say: 'b' }, { at: 0, action: 'wave' }] });
  assert.deepEqual([r.steps, r.seconds], [2, 1]);
  c.stopClock();
});

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ port, method, path, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('HTTP API: inputs, validation, origin guard and the SSE event stream', async () => {
  const sent = [];
  const c = new PetController({ send: (cmd) => sent.push(cmd), rules: defaultRules });
  const server = createApiServer(c, { port: 0 });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  try {
    assert.equal((await request(port, 'GET', '/v1/health')).body.ok, true);
    assert.ok((await request(port, 'GET', '/v1/capabilities')).body.actions.includes('wave'));

    assert.equal((await request(port, 'POST', '/v1/say', { text: '你好', expression: 'happy' })).status, 200);
    assert.equal(sent.at(-1).type, 'say');
    assert.equal((await request(port, 'POST', '/v1/act', { action: 'nope' })).status, 400);
    assert.equal((await request(port, 'POST', '/v1/say', { text: 'x' }, { Origin: 'https://evil.example' })).status, 403);

    c.fromRenderer('click', { state: 'idle' }); // happened before anyone subscribed
    // SSE: subscribe, then push a batch of signals and expect the rule to show up
    const events = [];
    const sse = http.get({ port, path: '/v1/events?types=rule_fired,click' });
    const gotRule = new Promise((resolve) => {
      sse.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          for (const block of chunk.split('\n\n')) {
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
          if (events.some((e) => e.type === 'rule_fired')) resolve();
        });
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    const fired = await request(port, 'POST', '/v1/signal', { signals: { 'claude.usage': { percent: 97 } } });
    assert.deepEqual(fired.body.fired, ['usage-critical']);
    await gotRule;
    sse.destroy();
    assert.equal(events[0].data.rule, 'usage-critical');
    assert.equal(events.length, 1, 'no replay of history without Last-Event-ID');
    assert.ok(!events.some((e) => e.type === 'signal'), 'type filter applies');

    const bad = await request(port, 'PUT', '/v1/rules', [{ id: 'a', signal: 's', when: [{ op: 'bogus' }], say: 'x' }]);
    assert.equal(bad.status, 400);
    const state = await request(port, 'GET', '/v1/state');
    assert.equal(state.body.signals['claude.usage'].percent, 97);

    assert.equal((await request(port, 'POST', '/v1/perform', { steps: [{ at: 0, action: 'wave' }] })).status, 200);
    assert.equal((await request(port, 'POST', '/v1/perform', { steps: [{ at: 0 }] })).status, 400);
    assert.equal((await request(port, 'POST', '/v1/hooks/claude-code', { hook_event_name: 'Stop' })).status, 200);
    assert.deepEqual(sent.at(-1), { type: 'claude_code', event: 'Stop', text: '' });
  } finally {
    server.close();
    c.stopClock();
  }
});
