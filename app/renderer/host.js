// The pet talks to its surroundings only through a host object. Inside Electron
// that is the preload bridge; in a plain browser (index.html?preview) a stub host
// fakes one screen so the renderer can be developed and screenshotted headless.

export function createHost() {
  if (window.petHost) return window.petHost;
  return previewHost();
}

function previewHost() {
  const params = new URLSearchParams(location.search);
  const petHeight = Number(params.get('size')) || 200;
  const commandHandlers = [];
  const events = [];
  const host = {
    preview: true,
    events,
    async init() {
      const width = Math.round(petHeight * 1.8);
      const height = Math.round(petHeight * 1.75);
      const footX = width / 2;
      const footY = height - Math.round(petHeight * 0.16);
      const screen = { x: 0, y: 0, width: 1920, height: 1080 };
      return {
        layout: { petHeight, width, height, footX, footY },
        foot: { x: 960, y: 1040 },
        displays: [{ id: 1, primary: true, bounds: screen, workArea: { ...screen, height: 1040 } }],
        settings: { quiet: false, wander: params.get('wander') !== '0', size: 'medium' },
      };
    },
    async cursor() { return null; },
    moveTo() {},
    rest() {},
    setIgnoreMouse() {},
    showMenu() {},
    emit(type, data) { events.push({ type, data }); },
    onCommand(fn) { commandHandlers.push(fn); },
  };
  // tests drive the pet with window.petCommand({...})
  window.petCommand = (cmd) => commandHandlers.forEach((fn) => fn(cmd));
  return host;
}
