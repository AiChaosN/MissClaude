// Renderer entry: load the sprite set, build the pet, wire input and run the loop.

import { Effects, makeLightLine, makeShadow } from './fx.js';
import { Renderer, Renderer2D, alphaMask, loadImage } from './gl.js';
import { createHost } from './host.js';
import { Pet } from './pet.js';
import { Rig } from './rig.js';

const FRAME = 1 / 60;
const RESTORE_GRACE_MS = 1500;

// Images stay referenced so textures can be rebuilt for another renderer.
async function loadAssets() {
  const manifest = await (await fetch('assets/manifest.json')).json();
  const swayImg = {};
  const sprites = {};
  await Promise.all(Object.entries(manifest.sprites).map(async ([name, m]) => {
    swayImg[m.sway] ??= loadImage(`assets/${m.sway}`);
    const img = await loadImage(`assets/${m.file}`);
    sprites[name] = { ...m, img, swayImg: await swayImg[m.sway], mask: alphaMask(img) };
  }));
  const faces = {};
  for (const [set, patches] of Object.entries(manifest.faces)) {
    faces[set] = {};
    await Promise.all(Object.entries(patches).map(async ([name, p]) => {
      const img = await loadImage(`assets/${p.file}`);
      faces[set][name] = { ...p, img, w: img.width, h: img.height, bone: p.group === 'book' ? 'chest' : 'head' };
    }));
  }
  const rigs = {};
  for (const [name, file] of Object.entries(manifest.rigs || {})) {
    const def = await (await fetch(`assets/${file}`)).json();
    const images = {};
    const files = [...def.layers.map((l) => [l.name, l.file]), ...Object.entries(def.masks || {}).map(([n, m]) => [n, m.file])];
    await Promise.all(files.map(async ([n, file]) => { images[n] = await loadImage(`assets/${file}`); }));
    rigs[name] = { def, images, textures: {} };
  }
  return { sprites, faces, rigs };
}

function bindTextures(renderer, sprites, faces, rigAssets, light, shadow) {
  light.tex = renderer.texture(light.canvas, { mipmap: false });
  shadow.tex = renderer.texture(shadow.canvas, { mipmap: false });
  const sway = new Map();
  for (const s of Object.values(sprites)) {
    s.tex = renderer.texture(s.img);
    if (renderer.kind === 'webgl') {
      if (!sway.has(s.swayImg)) sway.set(s.swayImg, renderer.texture(s.swayImg, { mipmap: false }));
      s.swayTex = sway.get(s.swayImg);
    } else {
      s.swayTex = null;
    }
  }
  for (const set of Object.values(faces)) {
    for (const f of Object.values(set)) f.tex = renderer.texture(f.img);
  }
  for (const r of Object.values(rigAssets)) {
    for (const [name, img] of Object.entries(r.images)) r.textures[name] = renderer.texture(img);
  }
}

async function boot() {
  const host = createHost();
  const init = await host.init();
  const glCanvas = document.getElementById('gl');
  const canvas2d = document.getElementById('sprite2d');
  const fx = new Effects(document.getElementById('fx'));
  const { sprites, faces, rigs: rigAssets } = await loadAssets();
  const light = makeLightLine();
  const shadow = makeShadow();

  const use2d = () => {
    glCanvas.hidden = true;
    canvas2d.hidden = false;
    return new Renderer2D(canvas2d);
  };
  let renderer;
  try {
    if (new URLSearchParams(location.search).get('renderer') === '2d') throw new Error('2D forced by URL');
    renderer = new Renderer(glCanvas);
  } catch (err) {
    console.warn(`WebGL unavailable (${err.message}); drawing with canvas 2D`);
    renderer = use2d();
  }
  bindTextures(renderer, sprites, faces, rigAssets, light, shadow);
  const rigs = Object.fromEntries(Object.entries(rigAssets).map(([n, r]) => [n, new Rig(r.def, r.textures)]));
  const rebindRigs = () => Object.entries(rigs).forEach(([n, r]) => r.rebind(rigAssets[n].textures));

  const bubble = { el: document.getElementById('bubble'), text: document.getElementById('bubble-text') };
  const pet = new Pet({ host, renderer, fx, bubble, sprites, faces, rigs, light, shadow, init });
  window.pet = pet; // handy from devtools and headless tests

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    pet.r.resize(window.innerWidth, window.innerHeight, dpr);
    fx.resize(window.innerWidth, window.innerHeight, dpr);
  };
  resize();
  window.addEventListener('resize', resize);

  // A lost WebGL context (GPU process crash, driver reset) gets a moment to come
  // back; if it does not, the pet keeps going on the 2D renderer.
  let lostTimer = null;
  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lostTimer = setTimeout(() => {
      console.warn('WebGL context did not come back; switching to canvas 2D');
      pet.r = use2d();
      bindTextures(pet.r, sprites, faces, rigAssets, light, shadow);
      rebindRigs();
      resize();
    }, RESTORE_GRACE_MS);
  });
  glCanvas.addEventListener('webglcontextrestored', () => {
    if (pet.r.kind !== 'webgl') return;
    clearTimeout(lostTimer);
    pet.r = new Renderer(glCanvas);
    bindTextures(pet.r, sprites, faces, rigAssets, light, shadow);
    rebindRigs();
    resize();
  });

  host.onCommand((cmd) => pet.command(cmd));

  // mousemove also arrives while the window ignores the mouse (forwarded), which is
  // how we notice the cursor entering the pet and turn click-through off
  window.addEventListener('mousemove', (e) => pet.onMouseMove(e));
  window.addEventListener('mouseleave', () => { if (!pet.press) pet.setIgnore(true); });
  const input = document.getElementById('fx');
  input.addEventListener('pointerdown', (e) => {
    if (pet.onPointerDown(e)) input.setPointerCapture(e.pointerId);
  });
  input.addEventListener('pointermove', (e) => pet.onPointerMove(e));
  input.addEventListener('pointerup', (e) => {
    if (input.hasPointerCapture(e.pointerId)) input.releasePointerCapture(e.pointerId);
    pet.onPointerUp(e);
  });
  input.addEventListener('pointercancel', () => pet.onPointerUp());
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (pet.hitAt(e.clientX, e.clientY)) host.showMenu();
  });

  // the window moves under a still cursor, so also poll the global cursor to keep
  // click-through and eye tracking right
  setInterval(async () => {
    const c = await host.cursor();
    if (!c || pet.press) return;
    pet.cursor = c;
    pet.updateLook();
    const w = pet.windowPos();
    pet.setIgnore(!pet.hitAt(c.x - w.x, c.y - w.y));
  }, 120);

  // ?manual (preview only): no clock; tests advance time with window.step(frames, dt)
  if (host.preview && new URLSearchParams(location.search).has('manual')) {
    window.step = (frames = 1, dt = FRAME) => {
      for (let i = 0; i < frames; i++) pet.update(dt);
      pet.render();
    };
    host.emit('ready', { renderer: renderer.kind, rigs: Object.keys(rigs), manual: true });
    return;
  }

  let last = performance.now();
  let acc = 0;
  const frame = (now) => {
    acc += Math.min(0.1, (now - last) / 1000);
    last = now;
    // fixed 60 Hz steps; high-refresh displays just skip frames
    if (acc >= FRAME) {
      const dt = Math.min(acc, 0.05);
      acc = 0;
      pet.update(dt);
      pet.render();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  host.emit('ready', {
    renderer: renderer.kind, rigs: Object.keys(rigs), sprites: Object.keys(sprites), faces: Object.keys(faces),
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.dataset.error = String(err && err.message ? err.message : err);
});
