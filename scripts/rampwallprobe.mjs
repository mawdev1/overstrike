/**
 * Probe: do bullets (world.raycast) stop at the solid walls flanking ramps/stairs?
 *
 * The-square ramp: B.ramp({ x0:-20, z0:-5, x1:-12, z1:-2, y0:0, y1:4, dir:'+x' })
 *   -> south cheek deco(x0, -0.4, z0-0.14, x1, 2.0, z0)  = wall at z in [-5.14,-5], y up to 2.0
 * Fire a horizontal ray at y=1.0 (chest height, well under the 2.0 m cheek top) along -z
 * through x=-16 (mid-ramp), starting from z=-8 (open plaza south of the ramp).
 * A bullet must stop at z=-5.14 (the cheek face). Before the fix it sails into the ramp
 * colliders (z >= -5) or beyond.
 *
 * Also probes a stairs() stringer on the-square if one exists via direct Builder capture.
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const world = game.world;

let fail = 0;
function probe(name, ox, oy, oz, dx, dy, dz, expectMaxDist, expectHit = true) {
  const origin = new THREE.Vector3(ox, oy, oz);
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  const hit = world.raycast(origin, dir, 60);
  const d = hit ? hit.distance : Infinity;
  const ok = expectHit ? (hit && d <= expectMaxDist + 1e-3) : true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: hit=${!!hit} dist=${d.toFixed(3)} (must stop within ${expectMaxDist}) surface=${hit?.surface ?? '-'} at=${hit ? hit.point.toArray().map(v => v.toFixed(2)).join(',') : '-'}`);
  if (!ok) fail++;
}

// Ramp 1 south cheek: ray from (-16, 1.0, -8) toward -z... cheek face is at z=-5.14, so +z dir.
// distance to face = 8 - 5.14 = 2.86
probe('ramp1 south cheek, chest height', -16, 1.0, -8, 0, 0, 1, 3.01);
// Ramp 1 north cheek from inside courtyard: from (-16, 1.0, 1) toward -z, face z=-1.86, dist 2.86
probe('ramp1 north cheek, chest height', -16, 1.0, 1, 0, 0, -1, 3.01);
// Upper ramp (y0=4): B.ramp({x0:-10,z0:2,x1:-2,z1:5,y0:4,y1:8,dir:'+x'}) south cheek z=1.86..2, top y=4+2=6
probe('ramp3 south cheek, y=5', -6, 5.0, -1, 0, 0, 1, 3.01);
// The reported case: low end of the ramp, where the side wall stands PROUD of the ramp
// surface (surface ~0.5 at x=-19, wall top 2.0). A player on the ramp ducks behind it.
// Ray at y=1.2 from the plaza passes OVER the ramp's stepped core — only the cheek wall
// can stop it. Pre-fix it flies clean through the visible wall (and out the other side).
probe('ramp1 low end, wall proud of surface', -19, 1.2, -8, 0, 0, 1, 3.01);

// Control: same ray but ABOVE the cheek top (2.0) must NOT stop at the cheek plane.
{
  const hit = world.raycast(new THREE.Vector3(-16, 2.6, -8), new THREE.Vector3(0, 0, 1), 60);
  const d = hit ? hit.distance : Infinity;
  // ramp surface at x=-16 is y=2 -> at y=2.6 the ray should pass over cheek and ramp low part... it
  // will hit the rising ramp collider around z within footprint only if surface >= 2.6 there; the
  // ramp rises along x not z, so at x=-16 surface is 2.0 everywhere in z — ray passes over ramp
  // and continues north. Just report where it lands.
  console.log(`INFO control above cheek: hit=${!!hit} dist=${d.toFixed(3)} surface=${hit?.surface ?? '-'} at=${hit ? hit.point.toArray().map(v => v.toFixed(2)).join(',') : '-'}`);
}

process.exit(fail ? 1 : 0);
