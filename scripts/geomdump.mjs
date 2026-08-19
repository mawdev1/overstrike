// Dump every emitted collider with authoring provenance to scratch JSON.
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { World } from '../src/world/world.js';
import fs from 'node:fs';

const prov = new Map();   // box object -> provenance string
const origRaw = World.prototype.addBoxRaw;
const origBox = World.prototype.addBox;
function site() {
  const e = new Error();
  const lines = (e.stack || '').split('\n').slice(2);
  const frames = [];
  for (const l of lines) {
    const m = l.match(/(src\/world\/[a-zA-Z]+\.js):(\d+):(\d+)/);
    if (m) frames.push(`${m[1]}:${m[2]}`);
    if (frames.length >= 6) break;
  }
  return frames;
}
World.prototype.addBoxRaw = function (...a) { const b = origRaw.apply(this, a); prov.set(b, site()); return b; };
World.prototype.addBox = function (...a) { const b = origBox.apply(this, a); prov.set(b, site()); return b; };

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const w = game.world;
const out = w.boxes.map((b, i) => ({
  i,
  min: [b.min.x, b.min.y, b.min.z],
  max: [b.max.x, b.max.y, b.max.z],
  surface: b.surface,
  src: prov.get(b) || [],
}));
const dst = process.argv[2] || '/tmp/boxes.json';
fs.writeFileSync(dst, JSON.stringify(out));
console.log(`${out.length} colliders -> ${dst}`);
console.log('bounds', JSON.stringify(w.bounds));
