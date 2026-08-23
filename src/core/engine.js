import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { clamp, damp } from './mathUtils.js';
import { ATMOSPHERE, makeCloudTexture } from './assets.js';
import { ScopeFX } from '../fx/scope.js';

// Scratch — the shadow cascade runs every frame and must not allocate (§1).
const _fwd = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lz = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

const SUN = ATMOSPHERE.sunDir;   // unit vector pointing at the sun

/**
 * THE final pass. Bloom compositing, ACES tone mapping, the sRGB transfer, vignette,
 * film grain, chromatic aberration, damage flash, a desaturating low-health pass, the
 * fade to black and the telescopic sight picture — all of it, in one fullscreen blit.
 *
 * ── WHY IT IS ALL IN HERE ─────────────────────────────────────────────────────
 * This used to be three separate full-resolution passes over the whole screen:
 * `UnrealBloomPass` additively blitting its mip chain back into the read buffer, then
 * `OutputPass` reading that, tone mapping it and writing an LDR copy, then this shader
 * reading THAT. Three full-res reads and three full-res writes of a 16-bit HDR buffer to
 * apply about forty ALU operations. Post at 1440p was 4 → 2 full-res passes short of
 * where it should be, and the bandwidth is what the tail of the frame-time distribution
 * is actually made of.
 *
 * Folding them together is exact, not an approximation, provided the operator order is
 * preserved: bloom adds in LINEAR (three's blend material is `premultipliedAlpha: true`,
 * so `AdditiveBlending` resolves to `glBlendFunc(ONE, ONE)` — a plain sum, not an
 * alpha-weighted one), then ACES, then the output transfer, and only then the
 * display-referred effects. The two functions that do the first half of that are three's
 * own — `ACESFilmicToneMapping` from the tone-mapping chunk included below, and
 * `linearToOutputTexel`, which `WebGLProgram` injects into every non-raw ShaderMaterial
 * and which resolves to `sRGBTransferOETF` here because this pass renders to the default
 * framebuffer and `renderer.outputColorSpace` is sRGB. That is character-for-character
 * what `OutputPass` did.
 *
 * `material.toneMapped` is set to FALSE on the pass (see `_buildComposer`). That does not
 * disable anything — it stops WebGLProgram from injecting the tone-mapping chunk a second
 * time, which would be a duplicate-definition compile error now that we include it
 * ourselves.
 *
 * ── CHROMATIC ABERRATION AND WHY IT COSTS THREE GRADES ────────────────────────
 * Aberration is a RESAMPLE: it reads the graded image at three different offsets. ACES is
 * a matrix operation, so the channels are coupled and you cannot grade once and split
 * afterwards without changing the result. Grading each of the three taps is what keeps
 * this pixel-identical to the old two-pass version. When aberration is off (post-fx
 * disabled) `ab` is a uniform-valued zero and the whole thing collapses to one tap.
 *
 * The scope block is guarded by `uScope`, a UNIFORM — every fragment in the frame takes
 * the same side of that branch, so with no scope up the whole thing is skipped
 * coherently and costs nothing measurable. See `src/fx/scope.js` for why the sight
 * picture is composited here rather than rendered picture-in-picture.
 */
const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    /** UnrealBloomPass's composited mip chain, at half resolution. */
    tBloom: { value: null },
    /** 1 while the bloom pass is enabled — a uniform, so the tap is skipped entirely. */
    uBloom: { value: 1.0 },
    /** Read by the tone-mapping chunk. Mirrored from `renderer.toneMappingExposure`. */
    toneMappingExposure: { value: 1.0 },
    uTime: { value: 0 },
    uVignette: { value: 0.85 },
    uGrain: { value: 0.035 },
    uAberration: { value: 0.0016 },
    uDamage: { value: 0.0 },       // 0..1 red flash
    uLowHealth: { value: 0.0 },    // 0..1 desaturate + pulse
    uFade: { value: 0.0 },         // 0..1 fade to black
    uResolution: { value: new THREE.Vector2(1, 1) },
    // ── telescopic sight ──
    uScope: { value: 0.0 },                                  // 0..1 master guard
    uScopeGeom: { value: new THREE.Vector4(0.8, 0.005, 0, 0) }, // radius, edge, haze, muzzle flash
    uScopeShift: { value: new THREE.Vector2(0, 0) },         // eye-relief offset
    uScopeGlint: { value: new THREE.Vector3(0, 0, 0) },      // sun x, sun y, intensity
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    ${THREE.ShaderChunk.tonemapping_pars_fragment}

    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float uBloom;
    uniform float uTime, uVignette, uGrain, uAberration, uDamage, uLowHealth, uFade;
    uniform vec2 uResolution;
    uniform float uScope;
    uniform vec4 uScopeGeom;
    uniform vec2 uScopeShift;
    uniform vec3 uScopeGlint;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }

    /** Scene radiance: the beauty buffer plus bloom, still linear. */
    vec3 sceneHdr(vec2 p) {
      vec3 c = texture2D(tDiffuse, p).rgb;
      if (uBloom > 0.0) c += texture2D(tBloom, p).rgb;
      return c;
    }

    /** ...and what OutputPass used to make of it. */
    vec3 grade(vec3 hdr) {
      return linearToOutputTexel(vec4(ACESFilmicToneMapping(hdr), 1.0)).rgb;
    }

    vec3 gradeAt(vec2 p) { return grade(sceneHdr(p)); }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // Chromatic aberration grows toward the edges. Kept to roughly a pixel at the
      // extreme corners — anything stronger reads as a broken display, not a lens.
      float ab = uAberration * (1.0 + uDamage * 6.0 + uLowHealth * 2.0);
      vec3 col;
      if (ab > 0.0) {
        vec2 off = c * r2 * ab * 2.5;
        col = vec3(gradeAt(uv + off).r, gradeAt(uv).g, gradeAt(uv - off).b);
      } else {
        col = gradeAt(uv);
      }
      vec3 base = col;

      // Vignette.
      float vig = smoothstep(0.95, 0.18, r2 * uVignette * 2.2);
      col *= mix(1.0, vig, 0.85);

      // Low health: desaturate, darken edges, slow pulse.
      if (uLowHealth > 0.001) {
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        float pulse = 0.5 + 0.5 * sin(uTime * 4.2);
        float amt = uLowHealth;
        col = mix(col, vec3(lum) * vec3(1.15, 0.72, 0.72), amt * 0.55);
        float edge = smoothstep(0.02, 0.28, r2);
        col = mix(col, vec3(0.32, 0.02, 0.02), edge * amt * (0.35 + 0.25 * pulse));
      }

      // Damage flash.
      col = mix(col, vec3(0.62, 0.05, 0.04), uDamage * 0.55);

      // Film grain (animated, luminance-weighted so shadows stay clean).
      float g = hash(uv * uResolution + fract(uTime) * 431.7) - 0.5;
      float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
      col += g * uGrain * (0.35 + 0.65 * (1.0 - lum2));

      // ═══════════════════════════════════════════════ telescopic sight picture ══
      // Uniform branch: with no scope up not one fragment enters this block.
      if (uScope > 0.001) {
        float R    = uScopeGeom.x;    // aperture radius, screen half-heights
        float edge = uScopeGeom.y;    // aperture edge softness
        float haze = uScopeGeom.z;    // focus-in wash, 1 -> 0 as the sight settles
        float asp  = uResolution.x / max(uResolution.y, 1.0);

        // Half-height space: a circle here is a circle on screen at any aspect ratio,
        // and it is the SAME space the HUD sizes the reticle in.
        vec2 q  = c * vec2(asp, 1.0) * 2.0;
        vec2 qs = q - uScopeShift;                       // eye-relief shadow offset
        float d = length(qs);
        float dn = clamp(d / R, 0.0, 1.4);

        float mask = 1.0 - smoothstep(R - edge, R + edge, d);

        // Four bilinear taps on the diagonals: the out-of-focus periphery outside the
        // ocular, and the not-yet-focused wash as the sight comes up. One kernel, two
        // jobs — the scope never pays for a second blur. Averaged in LINEAR and graded
        // once, which is both cheaper and more correct than grading four taps.
        vec2 bo = vec2(1.0 / asp, 1.0) * 0.010;
        vec3 blur = grade(( sceneHdr(uv + bo)
                          + sceneHdr(uv - bo)
                          + sceneHdr(uv + vec2(bo.x, -bo.y))
                          + sceneHdr(uv - vec2(bo.x, -bo.y)) ) * 0.25);

        // ---- inside the glass ----
        // Lateral colour error: a real objective cannot bring R and B to the same focal
        // plane off-axis, and it grows with the cube of the distance from that axis.
        vec2 rad = qs / max(d, 1e-4);
        vec2 fo = rad * pow(dn, 3.5) * 0.0016 * vec2(1.0 / asp, 1.0);
        float fr = gradeAt(uv + fo).r;
        float fb = gradeAt(uv - fo).b;
        vec3 glass = col + vec3(fr - base.r, 0.0, fb - base.b);

        // Coated glass is faintly cool and loses light toward the tube wall; the last
        // few per cent of the radius fall away hard, which is the tube itself and the
        // difference between a lens and a hole cut in a card.
        glass *= vec3(0.968, 0.996, 1.040);
        glass *= 1.0 - 0.34 * pow(dn, 3.2) - 0.34 * smoothstep(0.90, 1.0, dn);
        // Focusing in.
        glass = mix(glass, blur * 1.06 + 0.014, haze);

        // Objective glint. A tight core plus a wide Mie-ish bloom, then a cool ghost
        // thrown to the opposite side of the optical axis by the second element.
        float gd = length(q - uScopeGlint.xy);
        float glint = uScopeGlint.z * (exp(-gd * gd * 1.15) * 0.34 + exp(-gd * 5.0) * 0.30);
        glass += vec3(1.0, 0.84, 0.58) * glint;
        float ghd = length(q + uScopeGlint.xy * 0.62);
        glass += vec3(0.42, 0.62, 1.0) * uScopeGlint.z * exp(-ghd * ghd * 5.0) * 0.14;

        // Muzzle flash, seen through the glass. The viewmodel's own flash card is not
        // drawn while the sight picture is up (ViewLayerPass bails) — it is authored for
        // a 70 deg hip camera and covers the whole ocular at the ADS FOV. What a shooter
        // actually gets at 6x is a short warm bounce low in the field, because the muzzle
        // sits well below the optical axis.
        float mf = uScopeGeom.w;
        if (mf > 0.0) {
          float fd = length(qs - vec2(0.0, -0.62));
          glass += vec3(1.0, 0.73, 0.44) * mf * (exp(-fd * fd * 0.85) * 0.30 + 0.05);
        }

        // ---- outside the glass: the scope body ----
        // Not raw world and not flat black: a barely-lit smear of what the periphery is
        // doing, killed off over a few centimetres of tube.
        vec3 body = blur * 0.115 * (1.0 - smoothstep(R, R + 0.16, d));
        // Light catching the bevelled lip of the ocular — the crisp edge of the sight.
        // Held back until the sight has essentially settled: at half strength, over a
        // bright scene, a lit ring on a still-soft aperture reads as a soap bubble
        // floating in front of the player rather than as the rim of an optic.
        float lip = smoothstep(R + 0.020, R + 0.001, d) * smoothstep(R - 0.010, R + 0.001, d);
        body += vec3(0.46, 0.52, 0.62) * lip * 0.34 * smoothstep(0.55, 0.95, uScope);
        // The tube is 2 % of full brightness, which is where an 8-bit backbuffer starts
        // showing its steps. Reuse the grain hash to dither it flat.
        body += g * 0.010;

        vec3 scoped = mix(body, glass, mask);
        col = mix(col, scoped, uScope);
      }

      col *= (1.0 - uFade);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * Screen-space ambient occlusion from the depth buffer alone.
 *
 * three ships `SSAOPass`/`GTAOPass`, and both re-render the entire scene with an
 * override material to get view normals. That would roughly double the draw calls and
 * blow the §11 budget on its own. This pass instead reconstructs view position and
 * normal from the depth texture the main render already wrote, so it costs exactly one
 * fullscreen quad and zero extra draw calls.
 *
 * It runs before bloom so that occluded creases do not glow, and it is what actually
 * grounds objects: a crate is only standing on the floor if the floor darkens where
 * they meet. A shadow map at any resolution cannot do that at the contact scale.
 */
const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
`;

const AO_FRAG = /* glsl */`
  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  uniform vec2 uProjScale, uResolution, uFade;
  uniform float uRadius, uIntensity, uBias;
  varying vec2 vUv;

  #define AO_SAMPLES 12
  const float GOLDEN = 2.39996323;
  const float SKY = 0.99995;

  float depthAt(vec2 uv) { return texture2D(tDepth, uv).x; }

  vec3 viewPos(vec2 uv, float d) {
    vec4 c = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return c.xyz / c.w;
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    float d = depthAt(vUv);
    // Sky. Occluding it would draw a dark halo around every roofline.
    if (d >= SKY) { gl_FragColor = vec4(1.0); return; }

    vec3 P = viewPos(vUv, d);
    vec2 px = 1.0 / uResolution;

    // Normal from depth. Taking the CLOSER of the two neighbours on each axis keeps
    // silhouettes sharp; a plain central difference smears the normal across every
    // depth discontinuity and rings each object with a dark outline.
    vec3 pr = viewPos(vUv + vec2(px.x, 0.0), depthAt(vUv + vec2(px.x, 0.0)));
    vec3 pl = viewPos(vUv - vec2(px.x, 0.0), depthAt(vUv - vec2(px.x, 0.0)));
    vec3 pu = viewPos(vUv + vec2(0.0, px.y), depthAt(vUv + vec2(0.0, px.y)));
    vec3 pd = viewPos(vUv - vec2(0.0, px.y), depthAt(vUv - vec2(0.0, px.y)));
    vec3 ddx = abs(pr.z - P.z) < abs(pl.z - P.z) ? (pr - P) : (P - pl);
    vec3 ddy = abs(pu.z - P.z) < abs(pd.z - P.z) ? (pu - P) : (P - pd);
    vec3 N = normalize(cross(ddx, ddy));
    if (dot(N, P) > 0.0) N = -N;

    // World-space radius projected to screen space, clamped so a wall two centimetres
    // from the muzzle does not turn the kernel into a full-screen blur.
    vec2 rUV = clamp(uRadius * uProjScale / max(-P.z, 0.08) * 0.5, px * 1.5, vec2(0.06));

    float rot = hash12(gl_FragCoord.xy) * 6.2831853;
    float occ = 0.0;
    for (int i = 0; i < AO_SAMPLES; i++) {
      float fi = float(i) + 0.5;
      float a = rot + fi * GOLDEN;
      vec2 suv = vUv + vec2(cos(a), sin(a)) * sqrt(fi / float(AO_SAMPLES)) * rUV;
      float sd = depthAt(suv);
      vec3 v = viewPos(suv, sd) - P;
      float len = max(length(v), 1e-4);
      // Range check: a sample far in front of this surface belongs to another object,
      // not to an occluder, and must not bleed its silhouette onto this one.
      float range = clamp(uRadius / len, 0.0, 1.0);
      occ += max(0.0, dot(N, v / len) - uBias) * range * range * step(sd, SKY);
    }

    float ao = 1.0 - clamp(occ / float(AO_SAMPLES) * uIntensity, 0.0, 1.0);
    // Fade with distance — a fixed tap count is badly undersampled at range, so past
    // ~30 m it buys noise rather than occlusion.
    ao = mix(1.0, ao, 1.0 - smoothstep(uFade.x, uFade.y, -P.z));
    gl_FragColor = vec4(ao, ao, ao, 1.0);
  }
`;

/**
 * Upsample the half-res AO and multiply it into the beauty buffer.
 *
 * Four bilinear taps on the diagonals do double duty: they scale the buffer back up and
 * they average out the per-pixel rotation noise of the sampling kernel, which is the
 * usual reason a cheap SSAO looks like dirty film rather than shading.
 */
const AO_COMBINE_FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform sampler2D tAO;
  uniform vec2 uTexel;
  uniform vec3 uAoColor;
  varying vec2 vUv;
  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    float ao = ( texture2D(tAO, vUv + uTexel * vec2( 0.5,  0.5)).r
               + texture2D(tAO, vUv + uTexel * vec2(-0.5,  0.5)).r
               + texture2D(tAO, vUv + uTexel * vec2( 0.5, -0.5)).r
               + texture2D(tAO, vUv + uTexel * vec2(-0.5, -0.5)).r ) * 0.25;
    gl_FragColor = vec4(base.rgb * mix(uAoColor, vec3(1.0), ao), base.a);
  }
`;

/**
 * Half-resolution SSAO. The AO term itself is a low-frequency signal, so computing it
 * at quarter the pixel count costs almost nothing visually and roughly quarters the
 * fill cost of the single most expensive pass in the chain — which matters, because the
 * §11 target is an integrated GPU and the simulation already claims ~18% of the frame.
 */
class DepthAOPass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;
    this.aoMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        uProjInv: { value: new THREE.Matrix4() },
        uProjScale: { value: new THREE.Vector2(1, 1) },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: 0.8 },
        uIntensity: { value: 1.15 },
        uBias: { value: 0.05 },
        uFade: { value: new THREE.Vector2(24, 48) },
      },
      vertexShader: FS_VERT,
      fragmentShader: AO_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.combineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tAO: { value: null },
        uTexel: { value: new THREE.Vector2() },
        // Occlusion is the absence of *sky* light, so the shadow it leaves is cool,
        // not neutral grey. Neutral AO always reads as dirt smeared on the lens.
        uAoColor: { value: new THREE.Color(0.34, 0.38, 0.47) },
      },
      vertexShader: FS_VERT,
      fragmentShader: AO_COMBINE_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
    this.aoTarget.texture.minFilter = THREE.LinearFilter;
    this.aoTarget.texture.magFilter = THREE.LinearFilter;
    this._quad = new FullScreenQuad(this.aoMaterial);
  }

  setSize(w, h) {
    const hw = Math.max(1, Math.floor(w * 0.5));
    const hh = Math.max(1, Math.floor(h * 0.5));
    this.aoTarget.setSize(hw, hh);
    this.aoMaterial.uniforms.uResolution.value.set(hw, hh);
    this.combineMaterial.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  }

  /** Called once per frame by the engine with the live camera projection. */
  setCamera(camera) {
    const e = camera.projectionMatrix.elements;
    this.aoMaterial.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
    this.aoMaterial.uniforms.uProjScale.value.set(e[0], e[5]);
  }

  render(renderer, writeBuffer, readBuffer) {
    const depth = readBuffer.depthTexture;
    // Nothing to read from — stay out of the way rather than corrupting the chain.
    //
    // This must never happen now that BOTH composer targets carry their own depth
    // texture (see `_buildComposer`), and it is worth a loud warning if it does: when
    // this pass bails it also declines its swap, so the composer's buffer parity stops
    // alternating. That is self-latching — one bad frame and the parity is stuck on the
    // side this pass cannot read, so AO stays off for the rest of the session rather
    // than glitching for a frame. It is exactly how AO silently rendered on frame 1
    // and never again.
    if (!depth) {
      if (!this._warnedNoDepth) {
        this._warnedNoDepth = true;
        console.warn('[DepthAOPass] read buffer has no depth texture — AO disabled');
      }
      this.needsSwap = false;
      return;
    }
    this.needsSwap = true;

    this.aoMaterial.uniforms.tDepth.value = depth;
    this._quad.material = this.aoMaterial;
    renderer.setRenderTarget(this.aoTarget);
    renderer.clear();
    this._quad.render(renderer);

    this.combineMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.combineMaterial.uniforms.tAO.value = this.aoTarget.texture;
    this._quad.material = this.combineMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this._quad.render(renderer);
  }

  dispose() {
    this.aoTarget.dispose();
    this.aoMaterial.dispose();
    this.combineMaterial.dispose();
    this._quad.dispose();
  }
}

/**
 * Draws the viewmodel scene into the composer chain instead of straight to the screen.
 *
 * The depth buffer is cleared first so the weapon can never clip into a wall (the whole
 * reason it lives in its own scene), but because it now lands *before* bloom and the
 * composite, a muzzle flash actually glows and the gun sits under the same grain,
 * vignette, damage flash and fade as the world instead of floating above them.
 */
class ViewLayerPass extends Pass {
  constructor(engine, scene, camera) {
    super();
    this.engine = engine;
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;   // paint on top of what is already in the read buffer
  }

  render(renderer, writeBuffer, readBuffer) {
    // Once the sight picture has taken over, this scene has nothing legitimate left in
    // it. `viewmodel.js` hides the gun at the same 0.5 threshold, and the only remaining
    // occupants are FX muzzle-flash cards, which are sized in metres for the 70 deg hip
    // view camera. Drawn through the 30 deg ADS view camera they are ~2.6x bigger on
    // screen, they now land BEFORE bloom (they were authored when this scene was drawn
    // after the composer, and are still "hotter to compensate"), and the result is that
    // every shot whites out the entire ocular. You cannot see your own muzzle flash
    // through a 6x telescope: the composite draws its own instead (uScopeGeom.w).
    if ((this.engine?.scope?.amount ?? 0) > 0.5) return;

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }
}

/**
 * `UnrealBloomPass` minus its final full-resolution additive blit.
 *
 * Stock, the pass ends by drawing a fullscreen quad that adds `renderTargetsHorizontal[0]`
 * back over the read buffer. That is a whole extra full-res pass — every pixel of an HDR
 * buffer read, blended and written — to apply an addition the composite is about to do
 * anyway. `bloomTexture` hands that target to `CompositeShader` as `tBloom` instead and
 * the composite folds it into the same tap it already makes.
 *
 * `render()` is three's own body with the last step removed, which unavoidably pins this
 * to three's internals (`_fsQuad`, `nMips`, `separableBlurMaterials`, …). It is pinned to
 * 0.185. If a future three renames one of those it fails loudly at boot, not silently.
 */
class BloomPass extends UnrealBloomPass {
  /** The composited mip chain, at half resolution. Linear HDR, pre-tonemap. */
  get bloomTexture() { return this.renderTargetsHorizontal[0].texture; }

  render(renderer, writeBuffer, readBuffer) {
    renderer.getClearColor(this._oldClearColor);
    this._oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);

    // 1 — extract the bright areas.
    this.highPassUniforms['tDiffuse'].value = readBuffer.texture;
    this.highPassUniforms['luminosityThreshold'].value = this.threshold;
    this._fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this._fsQuad.render(renderer);

    // 2 — blur every mip progressively.
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      this._fsQuad.material = m;
      m.uniforms['colorTexture'].value = input.texture;
      m.uniforms['direction'].value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this._fsQuad.render(renderer);

      m.uniforms['colorTexture'].value = this.renderTargetsHorizontal[i].texture;
      m.uniforms['direction'].value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this._fsQuad.render(renderer);

      input = this.renderTargetsVertical[i];
    }

    // 3 — weight the mips together. The composite pass takes it from here.
    this._fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms['bloomStrength'].value = this.strength;
    this.compositeMaterial.uniforms['bloomRadius'].value = this.radius;
    this.compositeMaterial.uniforms['bloomTintColors'].value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this._fsQuad.render(renderer);

    renderer.setClearColor(this._oldClearColor, this._oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

/**
 * Half-float HDR without the alpha channel: 11/11/10 bits instead of 16/16/16/16.
 *
 * Nothing in this chain ever reads destination alpha — the composite writes
 * `vec4(col, 1.0)`, bloom's every shader takes `.rgb`, and the AO combine passes the
 * source alpha straight through — so four of the eight bytes per pixel were being read
 * and written on every full-resolution pass for nothing. On a fill-bound chain that is
 * the cheapest possible win.
 *
 * `format` HAS to be RGBFormat. three allocates render-target textures with `texImage2D`
 * rather than `texStorage2D`, and ES3 only accepts R11F_G11F_B10F paired with a GL_RGB
 * upload format — RGBA is an INVALID_OPERATION and an incomplete framebuffer, i.e. a
 * black screen.
 */
function asRGB11F(texture) {
  texture.format = THREE.RGBFormat;
  texture.type = THREE.HalfFloatType;
  texture.internalFormat = 'R11F_G11F_B10F';
  return texture;
}

/**
 * Every three.js resource a renderer has registered a `dispose` listener on, held weakly.
 *
 * three's renderer sub-modules (`WebGLTextures`, `WebGLGeometries`, `WebGLMaterials`,
 * `WebGLShadowMap`, …) each attach a `dispose` listener the first time they upload a
 * resource, and only ever detach it when THAT resource is disposed. The listener is a
 * closure over the sub-module's scope, which reaches `renderer.info` — and through it the
 * renderer's whole `programs` array. So any resource that OUTLIVES a renderer pins that
 * renderer's entire program cache: the `WebGLProgram`s, their `WebGLUniforms` trees, and
 * the GLSL source strings, forever.
 *
 * The resources that do this cannot be enumerated by walking our own scene graph or the
 * `assets` library, which is what this file used to try. A heap snapshot taken after six
 * match round trips found exactly two objects accumulating one listener per entry, and
 * neither is reachable that way:
 *   · three's OWN module-level `DFG_LUT` DataTexture (three.module.js, `let lut = null`),
 *     private to the library and unreachable from any public API;
 *   · the sky texture cached in `fx/mapSkin.js`'s `_skyCache`, which is deliberately
 *     shared across matches and lives on `scene.background`, where `traverse()` never
 *     looks.
 * Between them they retained 30 `WebGLProgram`s, ~38 `WebGLTexture`s, 2288 `SingleUniform`s
 * and 2372 `WebGLUniformLocation`s PER MATCH ENTRY.
 *
 * Recording is therefore done at the only place that is complete — the registration itself.
 * The hook is additive (it records and delegates, it changes no behaviour), installed once,
 * and holds nothing strongly.
 */
const _disposeListenerHosts = [];
let _disposeHookInstalled = false;
function _installDisposeListenerHook() {
  if (_disposeHookInstalled) return;
  _disposeHookInstalled = true;
  const proto = THREE.EventDispatcher?.prototype;
  if (!proto || typeof proto.addEventListener !== 'function') return;
  const original = proto.addEventListener;
  proto.addEventListener = function recordedAddEventListener(type, listener) {
    if (type === 'dispose') _disposeListenerHosts.push(new WeakRef(this));
    return original.call(this, type, listener);
  };
}

export class Engine {
  constructor(game, canvas) {
    this.game = game;
    this.canvas = canvas;
    const s = game.settings;

    // Before the renderer exists, so its very first upload is recorded.
    _installDisposeListenerHook();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // handled by render scale + post; MSAA is costly with a composer
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    // three.js validates every program on first use — getProgramInfoLog + getShaderInfoLog +
    // getProgramParameter(LINK_STATUS) — and each of those is a SYNCHRONOUS driver flush.
    // Profiling attributes 121-163 ms of self time to getProgramInfoLog alone during boot,
    // the single largest JS/native entry, and the 53 programs are re-linked on EVERY match
    // entry rather than amortised across a session. The driver itself is not the cost:
    // compileShader and linkProgram together measure under 1 ms.
    //
    // Kept ON in dev, where a shader that fails to compile should say so loudly.
    this.renderer.debug.checkShaderErrors = Boolean(import.meta.env?.DEV);
    this.renderer.setClearColor(0x0a0d12, 1);

    /**
     * Say WHICH GPU this is, once, at boot.
     *
     * A player reported 19 FPS on a scene of 88 draw calls and 26k triangles — numbers any
     * discrete or integrated GPU of the last decade renders in single-digit milliseconds.
     * That gap is the signature of a software rasteriser (SwiftShader/llvmpipe), which a
     * browser silently falls back to when hardware acceleration is off, blocklisted, or
     * unavailable to the process. Nothing in this client reported it, so the difference
     * between "the game is slow" and "this browser is not using the graphics card" was
     * invisible from a console log — and every fix aimed at the former was wasted.
     */
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      this.gpuInfo = { gpu: String(gpu || 'unknown'), vendor: String(vendor || 'unknown') };
      const soft = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(this.gpuInfo.gpu);
      this.softwareRenderer = soft;
      if (soft) {
        console.warn(`[engine] SOFTWARE RENDERING — "${this.gpuInfo.gpu}". The GPU is not being `
          + 'used, so frame rate will be a fraction of what this hardware can do. Enable hardware '
          + 'acceleration in the browser settings (brave://settings/system, chrome://settings/system) '
          + 'and check brave://gpu / chrome://gpu.');
      } else {
        console.info(`[engine] GPU: ${this.gpuInfo.gpu} (${this.gpuInfo.vendor})`);
      }
    } catch { /* diagnostics must never break boot */ }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Slightly under 1.0: ACES rolls highlights off gracefully, but a sunlit exterior
    // still clips to white if the exposure is left hot.
    this.renderer.toneMappingExposure = 0.86;
    this.renderer.shadowMap.enabled = s.get('shadows');
    // PCFSoftShadowMap is deprecated in three 0.185 and silently downgrades to PCF.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0d12);

    // near/far are as tight as the content allows, because the AO pass reconstructs view
    // position straight out of this depth buffer and a 0.05 → 900 range is an 18,000:1
    // ratio that spends almost the whole 24-bit range on the first metre. The world is
    // 86 × 86 m and the sky dome is a 250 m sphere parked on the camera, so nothing can
    // be beyond 400. The near plane is the tighter judgement: 0.36 m of capsule radius
    // keeps walls away, but a crouched player has only 0.15 m of head clearance, so 0.10
    // rather than the 0.12 the ratio would prefer. The viewmodel is drawn by its own
    // camera (near 0.01) and is unaffected by either.
    this.camera = new THREE.PerspectiveCamera(s.get('fov'), 1, 0.10, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    /** Separate scene rendered on top so the viewmodel never clips into walls. */
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 12);
    this.viewCamera.rotation.order = 'YXZ';
    this.viewScene.add(this.viewCamera);

    this._buildEnvironment();
    this._buildLighting();
    this._buildSky();
    this._buildComposer();

    /**
     * Telescopic sight picture. Holds no GPU resources of its own — it writes into the
     * composite pass's uniforms, re-read every frame, so a context-loss rebuild that
     * replaces the whole composer needs no special handling here.
     */
    this.scope = new ScopeFX(game, this);

    this.stats = { fps: 0, frameMs: 0, wallMs: 0, bufferMPix: 0, drawCalls: 0, triangles: 0, programs: 0 };
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._lastFrameStart = 0;

    this.damageFlash = 0;
    this.fade = 0;
    this.fadeTarget = 0;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    s.onChange((k, v) => this._onSetting(k, v));
    this._onResize();

    // A lost context is not exotic: a driver reset, a GPU hang, or a laptop switching
    // between its integrated and discrete GPU all take it away. Without a handler the
    // canvas silently freezes on the last frame while the simulation carries on, which
    // reads to the player as the game hanging.
    this._contextLost = false;
    this._onContextLost = (e) => {
      // Mandatory: skip preventDefault and the browser will never fire a restore.
      e.preventDefault();
      this._contextLost = true;
      this.game.bus?.emit('contextLost', {});
      console.warn('[engine] WebGL context lost');
    };
    this._onContextRestored = () => {
      this._contextLost = false;
      this._rebuildGpuResources();
      this.game.bus?.emit('contextRestored', {});
      console.warn('[engine] WebGL context restored');
    };
    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
  }

  /**
   * Everything that lives only on the GPU has to be made again after a restore. Textures
   * and geometry three re-uploads on demand; these two do not, because both are baked
   * once by rendering INTO them — the PMREM probe (every metal surface goes black
   * without it) and the composer's render targets.
   */
  _rebuildGpuResources() {
    this.scene.remove(this.sky);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.cloudTex?.dispose();
    this.envMap?.dispose();
    this.composer?.dispose();
    this.aoPass?.dispose();

    this._buildEnvironment();
    this._buildSky();
    this._buildComposer();
    // The composer's uniforms are a fresh clone now; the scope re-resolves them on its
    // next write, but its transient state must not survive the black frame.
    this.scope?.reset();
    this._onResize();
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /**
   * A metallic PBR surface gets essentially all of its colour from what it reflects.
   * With no environment map, `metalness: 0.9` renders pure black no matter how many
   * lights are in the scene — which is exactly what every gun and every metal panel
   * was doing. One small prefiltered probe fixes the whole material library.
   */
  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const room = new RoomEnvironment();
    this.envMap = pmrem.fromScene(room, 0.04).texture;
    room.dispose?.();
    pmrem.dispose();

    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.38;   // sunlight does the heavy lifting
    this.viewScene.environment = this.envMap;
    this.viewScene.environmentIntensity = 0.85; // the viewmodel has no sky above it
  }

  _buildLighting() {
    // Lighting is deliberately key-dominant. Piling on ambient makes a scene *bright*
    // but flat — contrast between a warm sun and a cool sky is what gives geometry
    // form, and it is the main thing separating a hobby render from a shipped one.
    // The PMREM probe (see _buildEnvironment) supplies most of the indirect light, so
    // the hemisphere and ambient terms here stay low on purpose.
    this.hemi = new THREE.HemisphereLight(0x9dc0e8, 0x3a3026, 0.34);
    this.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0x2c3646, 0.16);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(ATMOSPHERE.sunColor.getHex(), 2.9);
    this.sun.position.copy(SUN).multiplyScalar(120);
    this.sun.castShadow = true;
    this.sun.shadow.camera.near = 1;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this._shadowExt = 30;
    this._shadowDist = 120;

    // A cool, low-intensity bounce from the opposite side so shadowed faces keep
    // some form without washing out the key.
    this.fill = new THREE.DirectionalLight(0x7ea2d8, 0.30);
    this.fill.position.set(-SUN.x * 40, 24, -SUN.z * 40);
    this.scene.add(this.fill);

    // Viewmodel gets its own rig — it must read the same regardless of world lighting.
    const vmKey = new THREE.DirectionalLight(0xfff0da, 2.1);
    vmKey.position.set(0.6, 1.2, 0.9);
    this.viewScene.add(vmKey);
    const vmFill = new THREE.DirectionalLight(0x7fa4d6, 0.85);
    vmFill.position.set(-1.1, -0.3, -0.6);
    this.viewScene.add(vmFill);
    this.viewScene.add(new THREE.AmbientLight(0x9fb2cc, 0.55));
    this.viewMuzzleLight = new THREE.PointLight(0xffca7a, 0, 6, 2);
    this.viewMuzzleLight.position.set(0.25, -0.2, -1.2);
    this.viewScene.add(this.viewMuzzleLight);
  }

  /**
   * The sky is half the lighting and most of the mood, and a three-stop vertical ramp
   * is not a sky — it is a backdrop. This one is built from the pieces that actually
   * read: a horizon that compresses (real sky brightness falls off as a power of
   * altitude, it is not linear), a hot sun disc small enough to be a disc and bright
   * enough for the bloom pass to bloom, a wide Mie glow around it, layered cloud from
   * the same value noise the textures use, and a haze band at the horizon in exactly
   * the fog colour so distant geometry dissolves into the sky instead of stopping at it.
   */
  _buildSky() {
    this.cloudTex = makeCloudTexture();
    const geo = new THREE.SphereGeometry(250, 40, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      // See the renderOrder note below: the dome is depth-TESTED but never depth-WRITES,
      // so it fills only the pixels the world did not claim and leaves the depth buffer
      // exactly as the AO pass expects to find it (sky = far plane).
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      uniforms: {
        uZenith: { value: ATMOSPHERE.skyZenith },
        uMid: { value: ATMOSPHERE.skyMid },
        uHorizon: { value: ATMOSPHERE.skyHorizon },
        uGround: { value: ATMOSPHERE.skyGround },
        uHaze: { value: ATMOSPHERE.fog },
        uSunDir: { value: SUN },
        uSunColor: { value: ATMOSPHERE.sunColor },
        uCloudLit: { value: ATMOSPHERE.cloudLit },
        uCloudDark: { value: ATMOSPHERE.cloudDark },
        uCloud: { value: this.cloudTex },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uZenith, uMid, uHorizon, uGround, uHaze, uSunColor, uCloudLit, uCloudDark;
        uniform vec3 uSunDir;
        uniform sampler2D uCloud;
        varying vec3 vDir;

        float hash21(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.y;
          float sd = max(dot(dir, uSunDir), 0.0);

          // Vertical ramp. pow() on the altitude compresses the gradient into the
          // bottom of the sky, which is where a real one does almost all of its work.
          float t = pow(clamp(h, 0.0, 1.0), 0.45);
          vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.42, t));
          col = mix(col, uZenith, smoothstep(0.34, 1.0, t));

          // Warm the sky toward the sun near the horizon (forward Mie scattering).
          col = mix(col, mix(col, uSunColor, 0.55), pow(sd, 3.0) * (1.0 - t * 0.7));
          col += uSunColor * pow(sd, 9.0) * 0.35;

          // Cloud deck: the view direction projected onto a flat layer overhead, so the
          // cells stretch and converge toward the horizon the way real cloud does.
          float deck = smoothstep(0.015, 0.22, h);
          if (deck > 0.0) {
            vec2 cp = dir.xz / max(h, 0.055) * 0.075;
            float n = texture2D(uCloud, cp).r;
            float detail = texture2D(uCloud, cp * 2.7 + 0.31).r;
            float cover = smoothstep(0.50, 0.86, n * 0.7 + detail * 0.3) * deck;
            // Sunward edges catch the light; the bulk stays a cool grey.
            vec3 cloud = mix(uCloudDark, uCloudLit, smoothstep(0.40, 0.92, n) * 0.7 + pow(sd, 2.0) * 0.5);
            col = mix(col, cloud, cover * 0.8);
          }

          // Sun disc, then a tight corona. The disc is pushed well above 1.0 so the
          // bloom pass has something genuinely hot to work with.
          col += uSunColor * smoothstep(0.99965, 0.99991, sd) * 11.0;
          col += uSunColor * pow(sd, 700.0) * 1.6;

          // Horizon haze in the fog colour — the seam where the world meets the sky.
          col = mix(col, uHaze, smoothstep(0.11, -0.01, h) * 0.9);
          col = mix(uGround, col, smoothstep(-0.16, -0.02, h));

          // Break 8-bit banding in the smooth gradient.
          col += (hash21(dir.xy * 811.0) - 0.5) * 0.004;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    /**
     * Draw the sky LAST among the opaques, not first.
     *
     * three sorts the opaque list by `renderOrder` before anything else, so at -1000 with
     * `depthTest: false` this dome shaded every single pixel on the screen and the world
     * was then painted over the top of it — typically overwriting 60-90 % of it. That is
     * not a cheap shader to throw away: two cloud texture taps, a `pow(sd, 700.0)`, four
     * smoothsteps, a hash and half a dozen mixes, at full resolution, for nothing.
     *
     * Depth-tested and last, it shades only the pixels the world left behind. Nothing can
     * intersect it: the dome is recentred on the camera every frame (see `update`) at a
     * 250 m radius and the whole play space is 86 m across.
     */
    this.sky.renderOrder = 1000;
    this.scene.add(this.sky);

    // Aerial perspective: distant geometry drifts toward the sky's horizon colour.
    // The surface shaders tint this warm when you look into the sun (see assets.js) so
    // the haze belongs to the same atmosphere the sky dome is made of.
    this.scene.fog = new THREE.FogExp2(ATMOSPHERE.fog.getHex(), ATMOSPHERE.fogDensity);
  }

  /** A 24-bit depth texture the AO pass can sample. See `_buildComposer`. */
  _makeDepthTexture(w, h) {
    const d = new THREE.DepthTexture(w, h);
    d.format = THREE.DepthFormat;
    d.type = THREE.UnsignedIntType;
    return d;
  }

  /**
   * Resize the composer's depth textures alongside its colour targets.
   *
   * `RenderTarget.setSize()` walks `this.textures` — the colour attachments — and does
   * NOT touch `depthTexture`. Without this the depth texture keeps its original
   * dimensions after any window resize while the colour buffers change underneath it,
   * so the AO pass samples a mismatched buffer for the rest of the session.
   */
  _resizeComposerDepth(w, h) {
    const c = this.composer;
    if (!c) return;
    for (const rt of [c.renderTarget1, c.renderTarget2]) {
      const d = rt?.depthTexture;
      if (!d) continue;
      if (d.image.width === w && d.image.height === h) continue;
      d.image.width = w;
      d.image.height = h;
      d.dispose();          // force reallocation at the new size on next bind
    }
  }

  _buildComposer() {
    const size = this._targetSize();
    const rt = new THREE.WebGLRenderTarget(size.w, size.h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBFormat,
      samples: 0,
      depthBuffer: true,
    });
    asRGB11F(rt.texture);
    // EffectComposer clones this for renderTarget2, and Texture.copy carries
    // format/type/internalFormat, so both targets come out packed.
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.setSize(size.w, size.h);

    // A real depth texture rather than a renderbuffer, so the AO pass can read the
    // depth the main render already produced instead of re-rendering the scene.
    //
    // BOTH targets get one, and they must be two SEPARATE DepthTexture instances.
    //
    // The old code attached one to renderTarget2 alone, reasoning that RenderPass always
    // draws into the composer's read buffer and that this is renderTarget2. That is true
    // only on the first frame. `EffectComposer.render()` never resets `readBuffer` /
    // `writeBuffer` between frames, and the chain at the time ran an ODD number of
    // swapping passes (AO, OutputPass, composite), so the two buffers traded places every
    // frame. On frame 2 RenderPass wrote into renderTarget1, the AO pass found no depth
    // texture, bailed — and because bailing also skips its swap, the parity stopped
    // alternating and stuck there. AO rendered on exactly one frame per session and was
    // silently off forever after. Giving both targets depth removes the failure case
    // entirely.
    //
    // Deleting OutputPass leaves an EVEN number of swaps (AO, composite), so the parity
    // no longer alternates at all — but this stays, because "the pass chain happens to
    // have even parity today" is not something the AO pass should be depending on.
    //
    // Separate instances, not a shared one: a cloned texture shares its `Source` and so
    // its GL texture object, which would leave the AO pass sampling the exact depth
    // attachment of the framebuffer it is drawing into — undefined behaviour in WebGL,
    // and a hard hang under a software rasteriser.
    this.composer.renderTarget1.depthTexture = this._makeDepthTexture(size.w, size.h);
    this.composer.renderTarget2.depthTexture = this._makeDepthTexture(size.w, size.h);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.aoPass = new DepthAOPass();
    this.composer.addPass(this.aoPass);

    // Viewmodel goes in here, after AO (its depth belongs to a different camera) but
    // before bloom, so muzzle flashes actually glow.
    this.viewPass = new ViewLayerPass(this, this.viewScene, this.viewCamera);
    this.composer.addPass(this.viewPass);

    this.bloomPass = new BloomPass(new THREE.Vector2(size.w, size.h), 0.78, 0.52, 1.05);
    for (const t of [
      this.bloomPass.renderTargetBright,
      ...this.bloomPass.renderTargetsHorizontal,
      ...this.bloomPass.renderTargetsVertical,
    ]) asRGB11F(t.texture);
    this.composer.addPass(this.bloomPass);

    // No OutputPass: tone mapping and the sRGB transfer live in the composite now, so
    // the whole tail of the chain is ONE full-resolution blit instead of three.
    this.compositePass = new ShaderPass(CompositeShader);
    this.compositePass.renderToScreen = true;
    // Stops WebGLProgram injecting `tonemapping_pars_fragment` on top of the copy the
    // shader includes itself. Nothing is disabled by this — see CompositeShader.
    this.compositePass.material.toneMapped = false;
    this.compositePass.uniforms.tBloom.value = this.bloomPass.bloomTexture;
    this.compositePass.uniforms.toneMappingExposure.value = this.renderer.toneMappingExposure;
    this.composer.addPass(this.compositePass);

    this._applyPostSettings();
  }

  _applyPostSettings() {
    const s = this.game.settings;
    const on = s.get('postFx');
    this.bloomPass.enabled = on;
    // AO is the single biggest per-pixel cost in the chain, so it rides the same
    // switch as the rest of post — but unlike bloom it is a lighting cue, not a
    // flourish, so it stays on at every quality level that keeps post at all.
    this.aoPass.enabled = on;
    this.compositePass.enabled = true; // always on — it also owns fade-to-black
    const u = this.compositePass.uniforms;
    u.uGrain.value = on ? 0.035 * Math.max(0, Math.min(1, Number(s.get('filmGrain')) || 0)) : 0.0;
    u.uVignette.value = s.get('vignette') ? 0.85 : 0.0;
    u.uAberration.value = on ? 0.0016 : 0.0;
    // With bloom off its target still holds whatever it last wrote, so the composite has
    // to be told not to sample it rather than left to add a stale frame forever.
    u.uBloom.value = on ? 1.0 : 0.0;
  }

  _onSetting(k, v) {
    const s = this.game.settings;
    if (k === 'fov' || k === '*') this.setFov(s.get('fov'));
    if (k === 'shadows' || k === 'shadowQuality' || k === '*') {
      this.renderer.shadowMap.enabled = s.get('shadows') && s.get('shadowQuality') !== 'off';
      this._applyShadowQuality();
      this.scene.traverse((o) => { if (o.isMesh) o.material && (o.material.needsUpdate = true); });
    }
    if (k === 'postFx' || k === 'filmGrain' || k === 'vignette' || k === '*') this._applyPostSettings();
    if (k === 'renderScale' || k === '*') this._onResize();
  }

  setFov(deg) {
    this.baseFov = deg;
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  /** Called by the player camera each frame — ADS narrows the world FOV only. */
  setRenderFov(deg) {
    if (Math.abs(this.camera.fov - deg) < 0.01) return;
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  _targetSize() {
    let scale = clamp(this.game.settings.get('renderScale'), 0.4, 1.0);
    // A software rasteriser costs roughly per-pixel what a GPU costs per-triangle, so the
    // one lever that actually helps is fewer pixels. Half scale is a quarter of the work.
    // Deliberately not written back to settings: this is a floor for a machine that is not
    // using its graphics card, not a preference the player chose, and it must evaporate the
    // moment hardware acceleration comes back.
    if (this.softwareRenderer) scale = Math.min(scale, 0.5);
    const dpr = this.softwareRenderer ? 1 : Math.min(window.devicePixelRatio || 1, 2);

    let w = Math.max(320, Math.floor(window.innerWidth * dpr * scale));
    let h = Math.max(240, Math.floor(window.innerHeight * dpr * scale));

    // CAP THE BUFFER, NOT THE PIXEL RATIO.
    //
    // This renderer is fill-bound, not geometry-bound: measured on an M4 via ANGLE/Metal it
    // costs a flat ~1.5 ms per megapixel and does not care about draw calls at all (98 calls
    // and 27k triangles cost the same at every resolution; shadow RECEIVING is ~48% of it,
    // then bloom, then AO). Clamping dpr at 2 therefore controls the wrong variable — on a
    // Retina laptop it still yields a 5.9 MPix buffer (~8.9 ms/frame, already over a 120 Hz
    // budget) and on an external 5K it reaches 14.75 MPix (~24 ms, i.e. 42 fps) on hardware
    // that renders this scene 270 fps at 2.4 MPix.
    //
    // So the ceiling is expressed in the unit that actually costs: pixels. 2.5 MPix is ~3.7 ms
    // on that machine, leaving real headroom on a 60 Hz panel for the rest of the frame.
    // `renderScale` above 1 is not reachable, so a player who wants more can still lower it,
    // and anyone who wants MORE pixels than this can raise MAX_PIXELS knowingly.
    const MAX_PIXELS = 2.5e6;
    const pixels = w * h;
    if (pixels > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / pixels);
      w = Math.max(320, Math.floor(w * k));
      h = Math.max(240, Math.floor(h * k));
    }
    return { w, h, cssW: window.innerWidth, cssH: window.innerHeight };
  }

  _onResize() {
    // The one place the canvas changes size, so it is the one place that may invalidate
    // anything cached off it (see WeaponSystem._spreadToPixels).
    if (this.game?.weapons) this.game.weapons._cachedCanvasH = 0;
    const { w, h, cssW, cssH } = this._targetSize();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    const aspect = cssW / cssH;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();

    // setSize already forwards to every pass, bloom included — no second call needed.
    this.composer?.setSize(w, h);
    this._resizeComposerDepth(w, h);
    if (this.compositePass) this.compositePass.uniforms.uResolution.value.set(w, h);
    this.game.bus?.emit('resize', { w: cssW, h: cssH });
  }

  /**
   * Register the playable bounds and arm the shadow cascade.
   *
   * The old implementation stretched one 2048² map over the whole 86 × 86 m map, which
   * works out at ~4.8 cm per texel — coarser than a hand, so nothing ever made crisp
   * contact with anything. Instead of one frustum for the map, this keeps a single
   * tight cascade parked around the *camera* and drags it along as the player moves
   * (see `_updateShadowCascade`), roughly doubling texel density for free.
   */
  fitShadowCamera(bounds) {
    this._worldBounds = bounds;
    this._applyShadowQuality();
    this._updateShadowCascade();
  }

  /**
   * `shadowQuality` now changes what you can actually see rather than just the texture
   * allocation: the cascade shrinks with the map so texel density stays roughly
   * constant, trading shadow *distance* for shadow *crispness* at the low setting.
   */
  _applyShadowQuality() {
    const q = this.game.settings.get('shadowQuality');
    const dim = q === 'low' ? 1024 : 2048;
    const ext = q === 'low' ? 20 : 30;
    this._shadowExt = ext;
    this._shadowDist = ext * 1.5 + 70;

    if (this.sun.shadow.mapSize.x !== dim) {
      this.sun.shadow.mapSize.set(dim, dim);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }

    const cam = this.sun.shadow.camera;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.near = 1;
    cam.far = this._shadowDist + ext * 2.4 + 40;
    cam.updateProjectionMatrix();

    // Both biases are derived from the texel footprint rather than hand-picked, so
    // changing the cascade size or the map resolution can never reintroduce acne or
    // peter-panning. normalBias pushes the sample along the surface normal by a little
    // over one texel — enough to clear the staircase a depth map makes of a slope,
    // small enough that a crate still touches its own shadow.
    const texel = (2 * ext) / dim;
    this.sun.shadow.bias = -texel * 0.0016;
    this.sun.shadow.normalBias = texel * 1.15;
  }

  /**
   * Slide the cascade to sit around the player, snapped to whole shadow texels.
   *
   * The snap is not optional: without it the projection shifts by a fraction of a texel
   * every frame and every shadow edge in the scene crawls and sparkles as you walk.
   * Snapping happens in the light's own basis, which is the space the map is rasterised
   * in — snapping in world space does nothing.
   */
  _updateShadowCascade() {
    const ext = this._shadowExt;
    const cam = this.camera;

    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1); else _fwd.normalize();

    // Bias the cascade forward of the camera: nothing behind you needs a shadow, so
    // spending half the map there is half the resolution thrown away.
    _focus.copy(cam.position).addScaledVector(_fwd, ext * 0.42);
    _focus.y = cam.position.y - 1.2;
    const b = this._worldBounds;
    if (b) {
      _focus.x = clamp(_focus.x, b.min.x, b.max.x);
      _focus.z = clamp(_focus.z, b.min.z, b.max.z);
      _focus.y = clamp(_focus.y, b.min.y, b.max.y);
    }

    // Light basis, matching how three builds the shadow camera (lookAt with +Y up).
    _lz.copy(SUN);
    _lx.copy(_worldUp).cross(_lz).normalize();
    _ly.copy(_lz).cross(_lx);
    const texel = (2 * ext) / this.sun.shadow.mapSize.x;
    const sx = Math.round(_focus.dot(_lx) / texel) * texel;
    const sy = Math.round(_focus.dot(_ly) / texel) * texel;
    const sz = _focus.dot(_lz);
    _focus.copy(_lx).multiplyScalar(sx).addScaledVector(_ly, sy).addScaledVector(_lz, sz);

    this.sun.target.position.copy(_focus);
    this.sun.target.updateMatrixWorld();
    this.sun.position.copy(_focus).addScaledVector(SUN, this._shadowDist);
    this.sun.updateMatrixWorld();
  }

  flashDamage(amount = 1) {
    this.damageFlash = Math.min(1, this.damageFlash + amount);
  }

  setFade(target, instant = false) {
    this.fadeTarget = target;
    if (instant) this.fade = target;
  }

  update(dt) {
    // Effects that live purely in the composite pass.
    this.damageFlash = damp(this.damageFlash, 0, 5.5, dt);
    this.fade = damp(this.fade, this.fadeTarget, 6, dt);
    const u = this.compositePass.uniforms;
    // The composite owns tone mapping now; the renderer's own tone-mapping state no
    // longer touches the beauty buffer, so this is where the exposure has to arrive.
    u.toneMappingExposure.value = this.renderer.toneMappingExposure;
    u.uTime.value = performance.now() / 1000;
    u.uDamage.value = this.damageFlash;
    u.uFade.value = this.fade;
    const p = this.game.player;
    u.uLowHealth.value = p && p.alive
      ? clamp(1 - p.health / (p.maxHealth * 0.45), 0, 1)
      : 0;

    // Keep the sky centred on the camera so it never parallaxes.
    this.sky.position.copy(this.camera.position);
    this.viewMuzzleLight.intensity = damp(this.viewMuzzleLight.intensity, 0, 26, dt);

    // Runs last of everything visual: the player camera has already composed this
    // frame's transform, so the sight picture is never a frame behind the view.
    this.scope.update(dt);

    if (this.renderer.shadowMap.enabled) this._updateShadowCascade();
  }

  render(dt) {
    // Issuing GL work against a dead context is at best wasted and at worst a hard
    // error every frame; sit still until the browser hands it back.
    if (this._contextLost) return;

    const t0 = performance.now();
    this.renderer.info.reset();

    if (this.aoPass.enabled) this.aoPass.setCamera(this.camera);

    // The viewmodel is drawn inside the chain now (see ViewLayerPass), so this single
    // call produces the whole frame.
    this.composer.render(dt);

    const info = this.renderer.info;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;

    const ms = performance.now() - t0;
    this.stats.frameMs = this.stats.frameMs * 0.9 + ms * 0.1;
    // `frameMs` is CPU INSIDE this call only — it contains no GPU or present time, so on a
    // fill-bound frame it reads ~1.5 ms while the frame actually takes 50. That is the one
    // stat that looks healthy precisely when the frame is many times over budget, and it
    // sent this investigation down the wrong path for several rounds. `wallMs` is the real
    // wall time between frames, and `bufferMPix` is the number that drives the cost.
    const wall = t0 - (this._lastFrameStart || t0);
    this._lastFrameStart = t0;
    if (wall > 0 && wall < 1000) this.stats.wallMs = (this.stats.wallMs || wall) * 0.9 + wall * 0.1;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.stats.bufferMPix = (size.x * size.y) / 1e6;
    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.25) {
      this.stats.fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }
  }

  /**
   * Let go of the renderer's grip on every SHARED three.js resource.
   *
   * three registers a `dispose` listener on each material, texture and geometry the first
   * time it renders one (`onMaterialDispose` / `onTextureDispose` / `onGeometryDispose`),
   * and only ever removes it when THAT resource is disposed. Most of ours never are: the
   * `assets` library latches on `ready` and is shared by every match. So each retired
   * renderer stayed reachable from a shared resource's listener array for the life of the
   * page.
   *
   * The list to clear is `_disposeListenerHosts` — see the comment on it for why it is
   * recorded at registration time rather than derived by walking the scene graph and the
   * `assets` library, which is what this method used to do and which missed both of the
   * two resources a heap snapshot actually caught leaking.
   */
  _releaseSharedResourceListeners() {
    for (const ref of _disposeListenerHosts) {
      const listeners = ref.deref()?._listeners;
      if (listeners && listeners.dispose) listeners.dispose.length = 0;
    }
    // The registry describes ONE renderer's registrations and this is the end of that
    // renderer; the next one re-registers on its own first use, which is what makes the
    // blanket clear safe (nothing in this codebase listens for `dispose` itself, and the
    // client owns exactly one renderer at a time — the shell refuses a second `enter`
    // while a Game exists).
    _disposeListenerHosts.length = 0;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this.scope?.dispose();
    this.composer?.dispose();
    this.aoPass?.dispose();
    this.cloudTex?.dispose();
    this.envMap?.dispose();
    // After the engine's own resources have been disposed normally, and before the renderer
    // goes: everything still shared with the next match stops pointing back at this one.
    try { this._releaseSharedResourceListeners(); } catch { /* a partial boot has no scene */ }
    this.renderer.dispose();
    /**
     * `renderer.dispose()` does NOT release the GL context, and on this client that is the
     * difference between a session and a crash.
     *
     * The page used to have ONE canvas for its whole life, so every match entry built a
     * renderer on the SAME context, and each one uploaded the scene over again.
     * Most of what a renderer uploads is owned by module-level singletons that are meant
     * to outlive a match — `assets` latches on `ready`, the viewmodel and decal atlases are
     * cached forever — so nothing disposes those textures or materials, and three only ever
     * deletes a GL texture/program in response to a `dispose` on the object that owns it.
     * The result, measured over ten entry/exit round trips (scripts/perfprofile.mjs
     * --cycles=10): +47 GL textures and +30 GL programs left resident PER ENTRY on one
     * live context, unbounded. That is GPU memory the driver keeps until the tab dies,
     * which is "super lagging when I joined, then crashed" on the owner's second session.
     *
     * Force-losing the context is the only API three exposes that releases GL objects it
     * did not personally allocate, and it releases ALL of them — it cannot be defeated by
     * some future subsystem forgetting a `dispose()`. The listeners above are removed
     * first on purpose: this loss is deliberate, so neither the rebuild handler nor the
     * shell's `client.webgl_context_lost` telemetry should ever see it. A lost context is
     * permanent for that canvas, so the shell hands each entry a fresh one — see
     * `recycleCanvas` in ui/shell/gameRuntime.js. Nothing may render through this engine
     * after `dispose()`, which is already true: the loop is stopped first.
     *
     * ── why this is conditional, and not simply always done ──────────────────────────
     * Losing the context is only safe when SOMEONE RETIRES THE CANVAS WITH IT. A lost
     * context is permanent for its element, so on a host that reuses one canvas for the
     * whole page — which is what this repository shipped until the recycler landed — an
     * unconditional loss here means the second match boots onto a dead context and never
     * becomes playable. That is worse than the leak it fixes, and it is not hypothetical:
     * it is exactly what happened when this file was applied on its own.
     *
     * So the recycler ASKS for the loss, by marking the element it is about to throw away
     * (`data-retired`, set in `recycleCanvas` in ui/shell/gameRuntime.js immediately before
     * this dispose). No marker means no recycler — a probe script, a test harness, or this
     * file landed ahead of its other half — and the engine then behaves exactly as it did
     * before: the context survives its renderer, and the caller can build another on it.
     *
     * The two halves live in different lanes and therefore land as separate commits; the
     * handshake is what makes EITHER order, and a revert of either one, a working game.
     */
    if (this.canvas?.dataset?.retired === 'true') {
      try { this.renderer.forceContextLoss(); } catch { /* context already gone */ }
    }
    this._disposed = true;
  }
}
