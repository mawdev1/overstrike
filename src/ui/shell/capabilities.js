const LABELS = Object.freeze({
  desktop: 'Desktop pointer input',
  webgl2: 'WebGL 2',
  'pointer-lock': 'Pointer lock',
  'websocket-binary': 'Binary WebSocket frames',
});

export function checkShellCapabilities(environment = globalThis) {
  const documentRef = environment.document;
  const failures = [];
  const observed = Object.create(null);
  const finePointer = environment.matchMedia?.('(any-pointer: fine)')?.matches;
  observed.desktop = finePointer === undefined ? null : Boolean(finePointer);
  if (finePointer === false) failures.push('desktop');

  // This preliminary gate is deliberately API-only. Creating a WebGL context
  // belongs to the lazily loaded match runtime, never the initial shell.
  observed.webgl2 = Boolean(documentRef && typeof environment.WebGL2RenderingContext === 'function');
  if (!observed.webgl2) failures.push('webgl2');

  const elementPrototype = environment.HTMLElement?.prototype;
  observed.pointerLock = Boolean(elementPrototype && 'requestPointerLock' in elementPrototype);
  if (!observed.pointerLock) failures.push('pointer-lock');

  observed.websocketBinary = typeof environment.WebSocket === 'function'
    && typeof environment.ArrayBuffer === 'function';
  if (!observed.websocketBinary) failures.push('websocket-binary');

  return Object.freeze({
    supported: failures.length === 0,
    failures: Object.freeze(failures),
    observed: Object.freeze(observed),
  });
}

export function capabilityLabel(key) {
  return LABELS[key] || key;
}
