'use strict';
// HTTP adapter for PetController: JSON over 127.0.0.1 (see docs/API.md).
//
// Requests carrying an Origin header are refused: every browser sends one on
// cross-site requests, so a web page cannot drive the pet, while curl, Python and
// the Claude Code hook (which never send Origin) can.

const http = require('node:http');
const { InputError } = require('./controller');

const MAX_BODY = 64 * 1024;

function reply(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new InputError('request body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new InputError('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function typesParam(url) {
  const t = url.searchParams.get('types');
  return t ? t.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

function streamEvents(controller, req, res, url) {
  const types = typesParam(url);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const write = (ev) => res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.write(': connected\n\n');
  // resume after a reconnect: replay what was missed (bounded by the history size).
  // Without Last-Event-ID / ?since= a subscriber only sees events from now on.
  const resume = req.headers['last-event-id'] ?? url.searchParams.get('since');
  if (resume !== null && resume !== undefined && Number.isFinite(Number(resume))) {
    controller.eventsSince(Number(resume), types).forEach(write);
  }
  const unsubscribe = controller.subscribe(write, types);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function createApiServer(controller, {
  port, host = '127.0.0.1', extraState = () => ({}), onRulesChanged, capture, restart,
}) {
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin) return reply(res, 403, { error: 'requests from web pages are not accepted' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    try {
      switch (route) {
        case 'GET /v1/health':
          return reply(res, 200, { ok: true, api: controller.capabilities().api, ready: controller.pet.ready });
        case 'GET /v1/capabilities':
          return reply(res, 200, controller.capabilities());
        case 'GET /v1/state':
          return reply(res, 200, controller.state(extraState()));
        case 'POST /v1/say':
          return reply(res, 200, controller.say(await readJson(req)));
        case 'POST /v1/act':
          return reply(res, 200, controller.act(await readJson(req)));
        case 'POST /v1/expression':
          return reply(res, 200, controller.expression(await readJson(req)));
        case 'POST /v1/perform':
          return reply(res, 200, controller.perform(await readJson(req)));
        case 'POST /v1/signal': {
          const body = await readJson(req);
          // {name, value} or a batch {signals: {name: value, ...}}
          if (body.signals && typeof body.signals === 'object') {
            const fired = [];
            for (const [name, value] of Object.entries(body.signals)) {
              fired.push(...controller.signal(name, value).fired);
            }
            return reply(res, 200, { ok: true, fired });
          }
          return reply(res, 200, controller.signal(body.name, body.value));
        }
        case 'GET /v1/rules':
          return reply(res, 200, { rules: controller.rules() });
        case 'PUT /v1/rules': {
          const body = await readJson(req);
          const result = controller.setRules(Array.isArray(body) ? body : body.rules);
          if (onRulesChanged) onRulesChanged(controller.rules());
          return reply(res, 200, result);
        }
        case 'POST /v1/rules/reset':
          return reply(res, 200, controller.resetRules());
        case 'GET /v1/events':
          return streamEvents(controller, req, res, url);
        case 'GET /v1/events/recent': {
          const since = Number(url.searchParams.get('since') || 0);
          return reply(res, 200, { events: controller.eventsSince(since, typesParam(url)) });
        }
        case 'POST /v1/hooks/claude-code':
          return reply(res, 200, controller.claudeCode(await readJson(req)));
        case 'POST /v1/admin/restart':
          // relaunch in whatever desktop session the pet runs in (used after an update)
          if (!restart) return reply(res, 404, { error: 'not available' });
          reply(res, 202, { ok: true, restarting: true });
          setTimeout(restart, 200);
          return undefined;
        case 'POST /v1/debug/capture':
          if (!capture) return reply(res, 404, { error: 'not available' });
          return reply(res, 200, await capture());
        default:
          return reply(res, 404, { error: `no route ${route}` });
      }
    } catch (err) {
      if (err instanceof InputError) return reply(res, 400, { error: err.message });
      console.error('api error:', err);
      return reply(res, 500, { error: 'internal error' });
    }
  });
  // a pet that was just restarted may still hold the port for a moment: retry briefly
  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts < 10) {
      attempts += 1;
      setTimeout(() => server.listen(port, host), 500);
      return;
    }
    server.emit('fatal', err);
  });
  server.listen(port, host);
  return server;
}

module.exports = { createApiServer };
