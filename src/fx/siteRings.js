import * as THREE from 'three';
import { homeSiteOfTeam, sitesFromManifest } from '../ui/bomb/local.js';

/**
 * OVERSTRIKE — bomb-site ground rings.
 *
 * The player-requested replacement for the projected DOM site markers: one flat,
 * emissive rectangle-ring per plant volume, lying ON the floor of the site box,
 * plus a knee-height edge-glow wall standing on the same box outline. The flat
 * band alone failed the "reads at 5m/20m/40m" criterion: at 20 m the eye grazes
 * the floor at ~4.6 degrees, so a 0.4 m band projects to under a pixel and the
 * site vanishes down every long approach (Civic Archive doorway). The wall gives
 * the site vertical presence that survives grazing angles without occluding
 * anything — additive, depthWrite off, fading to nothing by WALL_HEIGHT so it
 * stays a floor cue, not a curtain. Both parts pulse together in an OWNERSHIP
 * colour (bomb-rules §13.10): your home site in the friendly team hue, the
 * enemy's — your plant target — in the hostile accent.
 *
 * States: idle (slow soft pulse) vs bomb-planted-here (fast, brighter pulse).
 * Reduced motion (the `os-prefer-reduced-motion` root class the HUD honours)
 * freezes the pulse at its mean.
 *
 * Geometry is rebuilt only when the map manifest changes (reset() clears the
 * cache); per-frame work is three uniform writes per site, zero allocation.
 */

// bomb-rules §13.10: the rings speak OWNERSHIP, not site identity — "your site to
// defend" renders in the friendly team hue the minimap uses for teammates, "the enemy
// site to hit" in the hostile accent it uses for enemies. Ownership can change at the
// §2 side switch, so the colour is a per-frame uniform write, not baked geometry.
const OWN_SITE_COLOR = 0x58c9ff;    // minimap teammate hue — mine, defend it
const ENEMY_SITE_COLOR = 0xff4433;  // minimap hostile hue — theirs, hit it
const MARGIN = 1.0;        // metres of plane past the box edge for the band falloff
const LIFT = 0.04;         // metres above the site floor — no z-fighting, no step
const WALL_HEIGHT = 1.15;  // metres of edge glow — knee height, under every sightline
const IDLE_SPEED = 2.0;    // rad/s of the idle pulse
const URGENT_SPEED = 8.0;  // rad/s while the bomb is planted at this site
const IDLE_BOOST = 1.0;
const URGENT_BOOST = 1.9;

const RING_VERT = /* glsl */`
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// three's fragment prefix already declares the tonemapping / colorspace helpers.
const RING_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec2 uHalf;       // site box half-extents (m)
  uniform float uTime;
  uniform float uPulseSpeed;
  uniform float uBoost;
  uniform float uMotion;    // 0 = reduced motion (pulse frozen at its mean)

  varying vec2 vP;

  float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  void main() {
    float sd = sdBox(vP, uHalf);
    // Bright band hugging the box edge, soft on both sides.
    float band = 1.0 - smoothstep(0.0, 0.34, abs(sd - 0.08));
    // Faint interior wash so the whole plant zone reads as an area, not a fence.
    float fill = (1.0 - smoothstep(-0.7, 0.05, sd)) * 0.12;
    float pulse = 0.74 + 0.26 * sin(uTime * uPulseSpeed) * uMotion;
    float a = (band * 0.8 + fill) * pulse * uBoost;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (1.1 + 0.9 * band), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const WALL_VERT = /* glsl */`
  uniform float uHeight;
  varying float vH;
  void main() {
    vH = clamp(position.y / uHeight, 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Edge-on the quads stack (near + far face of the box both in the pixel), which is
// exactly what makes the site legible from a 20 m grazing sightline; face-on each
// individual layer stays a faint wash the player shoots and walks through.
const WALL_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uPulseSpeed;
  uniform float uBoost;
  uniform float uMotion;
  varying float vH;

  void main() {
    float fade = pow(1.0 - vH, 2.4);
    float pulse = 0.74 + 0.26 * sin(uTime * uPulseSpeed) * uMotion;
    float a = fade * 0.34 * pulse * uBoost;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (1.15 + 0.65 * fade), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Four vertical quads standing on the site box outline (local origin = box centre floor). */
function wallGeometry(hw, hd, height) {
  const quads = [
    // [x0, z0, x1, z1] — outward winding is irrelevant: the material is DoubleSide.
    [-hw, -hd, hw, -hd],
    [hw, -hd, hw, hd],
    [hw, hd, -hw, hd],
    [-hw, hd, -hw, -hd],
  ];
  const positions = new Float32Array(quads.length * 6 * 3);
  let o = 0;
  const push = (x, y, z) => { positions[o++] = x; positions[o++] = y; positions[o++] = z; };
  for (const [x0, z0, x1, z1] of quads) {
    push(x0, 0, z0); push(x1, 0, z1); push(x1, height, z1);
    push(x0, 0, z0); push(x1, height, z1); push(x0, height, z0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geo;
}

export class SiteRings {
  constructor(game) {
    this.game = game;
    this.scene = null;
    this.group = null;
    /** @type {THREE.Mesh[]} */
    this.meshes = [];
    this.time = 0;
    this._manifest = null;
  }

  init(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    scene.add(this.group);
  }

  /** Called from FX.reset() (startMatch): drop the cache so a map swap rebuilds. */
  reset() {
    this.time = 0;
    this._manifest = null;
    if (this.group) this.group.visible = false;
    this._ensureBuilt();
  }

  _ensureBuilt() {
    if (!this.group) return;
    const manifest = this.game.world?.manifest || null;
    if (manifest === this._manifest) return;
    this._clearMeshes();
    this._manifest = manifest;
    if (!manifest) return;
    for (const site of sitesFromManifest(manifest)) {
      const hw = (site.box.max.x - site.box.min.x) / 2;
      const hd = (site.box.max.z - site.box.min.z) / 2;
      if (!(hw > 0) || !(hd > 0)) continue;
      const geo = new THREE.PlaneGeometry((hw + MARGIN) * 2, (hd + MARGIN) * 2);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          // Recoloured every update() by ownership; white only until the first frame.
          uColor: { value: new THREE.Color(0xffffff) },
          uHalf: { value: new THREE.Vector2(hw, hd) },
          uTime: { value: 0 },
          uPulseSpeed: { value: IDLE_SPEED },
          uBoost: { value: IDLE_BOOST },
          uMotion: { value: 1 },
        },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(site.center.x, site.box.min.y + LIFT, site.center.z);
      mesh.renderOrder = 11;
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.site = site.site;
      this.group.add(mesh);
      this.meshes.push(mesh);

      // The distance component: same colour, same pulse, standing on the same outline.
      const wallMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xffffff) },
          uHeight: { value: WALL_HEIGHT },
          uTime: { value: 0 },
          uPulseSpeed: { value: IDLE_SPEED },
          uBoost: { value: IDLE_BOOST },
          uMotion: { value: 1 },
        },
        vertexShader: WALL_VERT,
        fragmentShader: WALL_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
      const wall = new THREE.Mesh(wallGeometry(hw, hd, WALL_HEIGHT), wallMat);
      wall.position.set(site.center.x, site.box.min.y + LIFT, site.center.z);
      wall.renderOrder = 11;
      wall.frustumCulled = true;
      wall.castShadow = false;
      wall.receiveShadow = false;
      wall.matrixAutoUpdate = false;
      wall.updateMatrix();
      wall.userData.site = site.site;
      this.group.add(wall);
      this.meshes.push(wall);
    }
  }

  update(dt) {
    if (!this.group) return;
    const g = this.game;
    const match = g.match;
    const bombMode = match?.modeId === 'bomb';
    if (bombMode) this._ensureBuilt();
    const visible = bombMode && this.meshes.length > 0
      && (g.state === 'playing' || g.state === 'paused');
    if (this.group.visible !== visible) this.group.visible = visible;
    if (!visible) return;

    this.time += dt;
    const bomb = match.bomb;
    const plantedSite = bomb?.state === 'planted' ? bomb.siteId : null;
    const motion = globalThis.document?.documentElement?.classList
      ?.contains('os-prefer-reduced-motion') ? 0 : 1;
    // §13.1/§13.10 ownership: prefer the referee's own assignment (honours a manifest
    // homeSites override), else derive from site order + sideSwitched — the same facts
    // a networked client has. Falls back to team 0 when there is no local player.
    const team = g.player?.team === 1 ? 1 : 0;
    const homeSite = match.homeSites?.[team]
      ?? homeSiteOfTeam(team, match.sideSwitched === true);
    for (let i = 0; i < this.meshes.length; i++) {
      const u = this.meshes[i].material.uniforms;
      const site = this.meshes[i].userData.site;
      const urgent = site === plantedSite;
      u.uColor.value.setHex(site === homeSite ? OWN_SITE_COLOR : ENEMY_SITE_COLOR);
      u.uTime.value = this.time;
      u.uPulseSpeed.value = urgent ? URGENT_SPEED : IDLE_SPEED;
      u.uBoost.value = urgent ? URGENT_BOOST : IDLE_BOOST;
      u.uMotion.value = motion;
    }
  }

  _clearMeshes() {
    for (const mesh of this.meshes) {
      this.group?.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.meshes.length = 0;
  }

  dispose() {
    this._clearMeshes();
    if (this.group) this.scene?.remove(this.group);
    this.group = null;
    this.scene = null;
    this._manifest = null;
  }
}
