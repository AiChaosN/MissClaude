'use strict';
// HTTP adapter for PetController: JSON over 127.0.0.1 (see docs/API.md).
//
// Requests carrying an Origin header are refused: every browser sends one on
// cross-site requests, so a web page cannot drive the pet, while curl, Python and
// the Claude Code hook (which never send Origin) can.
//
// Other machines: with `host` set to a LAN address (or 0.0.0.0) a `token` is
// required, and every request that does not come from this machine must carry
// `Authorization: Bearer <token>`. Local callers (hooks, the menu) keep working
// without it. The admin and debug routes stay local-only whatever the token.

const crypto = require('node:crypto');
const http = require('node:http');
const { InputError } = require('./controller');

const MAX_BODY = 64 * 1024;

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function tokenMatches(header, token) {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

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

// token: required from non-local clients; trustLocal: loopback connections skip it
// (tests set it to false to exercise the token path from this machine)
function createApiServer(controller, {
  port, host = '127.0.0.1', token = '', trustLocal = true, extraState = () => ({}), onRulesChanged, capture, restart,
}) {
  if (!isLoopback(host) && host !== 'localhost' && !token) {
    throw new Error('refusing to listen on a non-local address without a token');
  }
  // A response sent before the request body was read makes Node drop the connection
  // afterwards, and a keep-alive client is then reset on its next request: routes
  // that never read their body (and refusals) drain it first.
  const drain = (req) => new Promise((resolve) => {
    if (req.complete) return resolve();
    req.resume();
    req.once('end', resolve);
    req.once('error', resolve);
    req.once('close', resolve);
  });
  const refuse = async (req, res, code, error) => {
    await drain(req);
    res.setHeader('Connection', 'close');
    return reply(res, code, { error });
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin) return refuse(req, res, 403, 'requests from web pages are not accepted');
    const local = trustLocal && isLoopback(req.socket.remoteAddress);
    if (!local && (!token || !tokenMatches(req.headers.authorization, token))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return refuse(req, res, 401, token ? 'bad or missing token' : 'remote access is off');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    if (!local && /^\/v1\/(admin|debug)\//.test(url.pathname)) {
      return refuse(req, res, 403, 'only from this machine');
    }
    if (!/^(POST|PUT) \/v1\/(say|act|expression|perform|signal|rules|hooks\/claude-code)$/.test(route)
        && route !== 'GET /v1/events') await drain(req);
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

module.exports = { createApiServer, isLoopback };
