// Materials and palettes. No colour is written here: every colour comes from the block's material
// props or the course tokens, and each visual style derives its palette from them.
import * as THREE from 'three';
import { ROLE, ROLE_COUNT } from './geometry.js';

const NOISE = /* glsl */`
float clHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float clHash3(vec3 p){ return clHash(p.xy + p.z*17.13); }
float clNoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(clHash(i), clHash(i+vec2(1.0,0.0)), u.x), mix(clHash(i+vec2(0.0,1.0)), clHash(i+vec2(1.0,1.0)), u.x), u.y); }
float clFbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a*clNoise(p); p = p*2.03 + 1.7; a *= 0.5; } return v; }
`;

// ── Palettes ──
const c = (v) => new THREE.Color(v);
function hsl(col, ds, dl) { const h = {}; col.getHSL(h); return new THREE.Color().setHSL(h.h, Math.min(1, h.s * ds), Math.min(0.95, Math.max(0.03, h.l + dl))); }

// The palette of every role for a style, from the props (materials) and the tokens (identity).
export function palette(style, props, tokens) {
  const tk = (k, alt) => c(tokens[k] || tokens[alt] || tokens['color.text']);
  const paper = tk('color.paper', 'color.surface');
  const ink = tk('color.ink', 'color.text');
  const accent = tk('color.accent', 'color.primary');
  const ochre = tk('color.ochre', 'color.accent');
  const water = c(props.waterColor), grass = c(props.grassColor), earth = c(props.earthColor), stone = c(props.stoneColor);
  const gate = c(props.gateColor), hull = c(props.hullColor), cabin = c(props.cabinColor);
  const P = new Array(ROLE_COUNT);
  const set = (role, col) => { P[role] = col; };
  if (style === 'technical') {
    // A paper model: everything in tints of the paper, the water and the boat kept faintly coloured.
    const t = (col, k) => paper.clone().lerp(col, k);
    set(ROLE.grass, t(grass, 0.16)); set(ROLE.soil, t(earth, 0.2)); set(ROLE.clay, t(earth, 0.3)); set(ROLE.bed, t(ink, 0.1));
    set(ROLE.stone, t(stone, 0.1)); set(ROLE.coping, t(ink, 0.03)); set(ROLE.path, t(earth, 0.08));
    set(ROLE.gate, t(ink, 0.5)); set(ROLE.gateFrame, t(ink, 0.62)); set(ROLE.beamTip, paper.clone()); set(ROLE.metal, t(ink, 0.55));
    set(ROLE.hull, t(hull, 0.4)); set(ROLE.strake, t(ink, 0.45)); set(ROLE.cabin, t(cabin, 0.15)); set(ROLE.roof, t(ochre, 0.3));
    set(ROLE.window, t(water, 0.45)); set(ROLE.deck, t(earth, 0.15)); set(ROLE.tarp, t(grass, 0.25)); set(ROLE.chimney, t(ink, 0.6));
    set(ROLE.flag, accent.clone()); set(ROLE.hole, t(ink, 0.8)); set(ROLE.rope, t(ochre, 0.3)); set(ROLE.ink, ink.clone());
  } else {
    set(ROLE.grass, grass.clone()); set(ROLE.soil, earth.clone()); set(ROLE.clay, earth.clone().lerp(ochre, 0.45).lerp(paper, 0.18));
    set(ROLE.bed, earth.clone().multiplyScalar(0.62).lerp(water, 0.18)); set(ROLE.stone, stone.clone()); set(ROLE.coping, stone.clone().lerp(paper, 0.4));
    set(ROLE.path, earth.clone().lerp(paper, 0.55)); set(ROLE.gate, gate.clone()); set(ROLE.gateFrame, gate.clone().multiplyScalar(0.72));
    set(ROLE.beamTip, paper.clone().lerp(c(tokens['color.onPrimary'] || tokens['color.surface']), 0.6)); set(ROLE.metal, ink.clone().lerp(stone, 0.35));
    set(ROLE.hull, hull.clone()); set(ROLE.strake, ochre.clone()); set(ROLE.cabin, cabin.clone()); set(ROLE.roof, accent.clone().lerp(earth, 0.25));
    set(ROLE.window, water.clone().multiplyScalar(0.55)); set(ROLE.deck, earth.clone().lerp(ochre, 0.3).lerp(paper, 0.25));
    set(ROLE.tarp, grass.clone().lerp(ink, 0.25)); set(ROLE.chimney, ink.clone().lerp(gate, 0.4)); set(ROLE.flag, accent.clone());
    set(ROLE.hole, ink.clone().multiplyScalar(0.6)); set(ROLE.rope, ochre.clone().lerp(paper, 0.45)); set(ROLE.ink, ink.clone());
    if (style === 'playful') {
      // Brighter, more saturated, and a boat in the accent colour.
      for (let i = 0; i < ROLE_COUNT; i++) P[i] = hsl(P[i], 1.35, 0.05);
      P[ROLE.hull] = hsl(accent, 1.3, 0.04); P[ROLE.strake] = hsl(ochre, 1.4, 0.1); P[ROLE.cabin] = hsl(cabin, 1.1, 0.06);
      P[ROLE.gate] = hsl(water, 1.2, -0.12); P[ROLE.gateFrame] = hsl(water, 1.2, -0.22); P[ROLE.tarp] = hsl(water, 1.3, 0.05);
    }
  }
  // Colours are given in sRGB; three.js works in linear space.
  return P;
}

// Colours the scene uses besides the roles (water, inks, pigments of the wash and the reveal).
export function sceneColours(style, props, tokens) {
  const tk = (k, alt) => c(tokens[k] || tokens[alt] || tokens['color.text']);
  const paper = tk('color.paper', 'color.surface');
  const ink = tk('color.ink', 'color.text');
  const sage = tk('color.sage', 'color.primary');
  const ochre = tk('color.ochre', 'color.accent');
  let water = c(props.waterColor);
  if (style === 'playful') water = hsl(water, 1.4, 0.06);
  if (style === 'technical') water = hsl(water, 1.1, 0.02);
  return {
    paper, ink, sage, ochre, water,
    waterLight: water.clone().lerp(paper, 0.55),
    waterDeep: water.clone().lerp(ink, 0.45),
    foam: paper.clone().lerp(c(tokens['color.onPrimary'] || tokens['color.surface']), 0.5),
    accent: tk('color.accent', 'color.primary'),
    grass: c(props.grassColor),
    earth: c(props.earthColor)
  };
}

// ── The diorama material: vertex colours by role, with the details each style draws ──
export function dioramaMaterial() {
  const uniforms = {
    uGrain: { value: 1 }, uJoint: { value: 0.18 }, uHatch: { value: 0 }, uInk: { value: new THREE.Color() },
    uCutZ: { value: 99 }, uEdgeZ: { value: new THREE.Vector2(5.3, 6.5) }, uEdgeX: { value: 15 }, uLift: { value: 0 }
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRole;\nvarying float vRole;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvRole = aRole;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vRole; varying vec3 vWPos; varying vec3 vWNormal;
uniform float uGrain, uJoint, uHatch, uCutZ, uEdgeX, uLift; uniform vec2 uEdgeZ; uniform vec3 uInk;
${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  float role = floor(vRole + 0.5);
  vec3 P = vWPos; vec3 N = normalize(vWNormal);
  bool side = abs(N.y) < 0.5;
  float along = abs(N.x) > 0.5 ? P.z : P.x;
  // Paper grain and soft watercolour mottling.
  float grain = clHash3(floor(P * 26.0)) - 0.5;
  float mott = clFbm(vec2(along * 0.45 + P.y * 0.3, (side ? P.y : (abs(N.x) > 0.5 ? P.x : P.z)) * 0.45)) - 0.5;
  diffuseColor.rgb *= 1.0 + uGrain * (grain * 0.07 + mott * 0.16);
  if (role == 4.0) {
    // Masonry courses with staggered joints.
    float y = P.y / 0.42; float row = floor(y);
    float bx = along / 0.95 + mod(row, 2.0) * 0.5;
    float joint = side ? max(step(fract(y), 0.075), step(fract(bx), 0.04)) : 0.0;
    diffuseColor.rgb *= (1.0 - uJoint * joint) * (0.94 + 0.12 * clHash(vec2(row, floor(bx))));
  } else if (role == 5.0) {
    float j = step(fract((abs(N.x) > 0.5 ? P.z : P.x) / 1.25), 0.025);
    diffuseColor.rgb *= 1.0 - uJoint * j;
  } else if (role == 7.0) {
    diffuseColor.rgb *= 1.0 - 0.6 * uJoint * step(fract(P.y / 0.3), 0.07);
  } else if (role == 0.0) {
    diffuseColor.rgb *= 0.93 + 0.14 * clFbm(P.xz * 0.6);
  } else if (role == 6.0) {
    diffuseColor.rgb *= 0.95 + 0.1 * step(0.86, clHash3(floor(P * 12.0)));
  }
  // Cut faces of the slice: soil layers hatched like a section drawing (technical style).
  bool cutZ = abs(N.z) > 0.9 && (abs(P.z - uEdgeZ.x) < 0.03 || abs(P.z + uEdgeZ.y) < 0.03 || abs(P.z - uCutZ) < 0.03);
  bool cutX = abs(N.x) > 0.9 && abs(abs(P.x) - uEdgeX) < 0.03;
  if ((cutZ || cutX) && role < 5.0) {
    float u = cutZ ? P.x : P.z;
    float hatch = step(fract((u + P.y) * 2.2), 0.14);
    diffuseColor.rgb = mix(diffuseColor.rgb, uInk, uHatch * hatch * 0.32);
    // Soil layers drawn like an illustration: wavy strata, a few pebbles, darker with depth.
    if (role == 1.0 || role == 2.0) {
      float sy = P.y + 0.12 * sin(u * 0.9) + 0.06 * sin(u * 2.3 + 1.0);
      float band = abs(fract(sy / 0.7) - 0.5);
      diffuseColor.rgb *= 1.0 - uGrain * 0.07 * (1.0 - smoothstep(0.0, 0.05, band - 0.43));
      float peb = step(0.965, clHash(floor(vec2(u, P.y) * 6.0)));
      diffuseColor.rgb *= 1.0 - uGrain * 0.12 * peb;
      diffuseColor.rgb *= 0.9 + 0.1 * smoothstep(-3.0, 1.0, P.y);
    }
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), uLift);
}`);
  };
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'cl-diorama';
  return mat;
}

// ── Water: a soft surface with drifting streaks, currents and foam where the paddles run ──
export function waterMaterial() {
  const uniforms = {
    uTime: { value: 0 }, uExpr: { value: 1 },
    uLight: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() }, uFoamCol: { value: new THREE.Color() },
    uFoam: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    // How far the streaks have drifted along x in the lower reach, the chamber and the upper reach:
    // integrated over time by the object, so a change of current changes their speed, never their place.
    uPhase: { value: new THREE.Vector3() },
    uSplit: { value: new THREE.Vector2(-6.5, 6.5) },
    uRim: { value: 0.35 }
  };
  const mat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.86, roughness: 0.18, metalness: 0, depthWrite: false });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTop;\nattribute float aDepth;\nvarying float vTop;\nvarying float vDepth;\nvarying vec3 vWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvTop = aTop; vDepth = aDepth;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vTop; varying float vDepth; varying vec3 vWPos;
uniform float uTime, uExpr, uRim; uniform vec3 uLight, uDeep, uFoamCol, uPhase; uniform vec4 uFoam[4]; uniform vec2 uSplit;
${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 q = vWPos.xz;
  float phase = vWPos.x < uSplit.x ? uPhase.x : (vWPos.x > uSplit.y ? uPhase.z : uPhase.y);
  if (vTop > 0.5) {
    vec2 drift = vec2(phase, uTime * 0.03);
    float n = clFbm(q * 0.5 - drift);
    float streak = smoothstep(0.58, 0.78, clFbm(vec2(q.x * 0.22, q.y * 1.4) - drift * vec2(1.0, 0.3)));
    diffuseColor.rgb = mix(diffuseColor.rgb, uLight, clamp(0.18 + 0.3 * n + 0.42 * streak * uExpr, 0.0, 1.0));
    float foam = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 f = uFoam[i];
      if (f.z > 0.001) {
        float d = distance(q, f.xy) / max(f.w, 0.01);
        float churn = 0.55 + 0.45 * clFbm(q * 3.2 + vec2(uTime * 1.7, -uTime * 1.3));
        foam += f.z * smoothstep(1.0, 0.15, d) * churn;
      }
    }
    foam = clamp(foam, 0.0, 0.92);
    diffuseColor.rgb = mix(diffuseColor.rgb, uFoamCol, foam);
    diffuseColor.a = mix(diffuseColor.a, 1.0, foam * 0.7);
  } else {
    diffuseColor.rgb = mix(mix(diffuseColor.rgb, uLight, 0.3), uDeep, smoothstep(0.0, 1.0, vDepth) * 0.8);
    diffuseColor.rgb = mix(diffuseColor.rgb, uLight, (1.0 - smoothstep(0.0, 0.06, vDepth)) * uRim);
    diffuseColor.a = mix(0.78, 0.94, vDepth);
  }
}`);
  };
  mat.userData.uniforms = uniforms;
  mat.customProgramCacheKey = () => 'cl-water';
  return mat;
}

// ── Jets of water through the paddles: a tube with streaks running along it ──
export function jetMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uWater: { value: new THREE.Color() }, uAlpha: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aT; attribute float aA; varying float vT; varying float vA;
      #include <clipping_planes_pars_vertex>
      void main(){ vT = aT; vA = aA; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uAlpha; uniform vec3 uColor, uWater; varying float vT; varying float vA;
      #include <clipping_planes_pars_fragment>
      void main(){
        #include <clipping_planes_fragment>
        float s = fract(vT * 5.0 - uTime * 2.4 + sin(vA * 6.2832) * 0.18);
        float streak = smoothstep(0.0, 0.25, s) * (1.0 - smoothstep(0.45, 0.9, s));
        float ends = smoothstep(0.0, 0.08, vT) * (1.0 - smoothstep(0.85, 1.0, vT));
        vec3 col = mix(uWater, uColor, 0.45 + 0.55 * streak);
        gl_FragColor = vec4(col, uAlpha * ends * (0.55 + 0.45 * streak));
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, clipping: true
  });
}

// ── The entrance: the scene bleeds onto the paper like a watercolour wash ──
// Pigment blooms where the diorama stands, then the scene shows through from the middle out,
// behind a darker front. The scene is drawn into a texture for the length of the entrance, so the
// pigment only goes on the diorama itself (its alpha), never over the rest of the frame.
const QUAD_VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
export function revealMaterial() {
  const uniforms = {
    tScene: { value: null }, uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) }, uRadius: { value: 8 },
    uT: { value: 0 }, uSeed: { value: new THREE.Vector2(3.1, 7.7) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uExtent: { value: new THREE.Vector2(0.4, 0.4) },
    uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() }
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tScene; uniform vec2 uTexel; uniform float uRadius; uniform float uT; uniform vec2 uSeed; uniform vec2 uCenter; uniform vec2 uExtent;
      uniform vec3 uA, uB, uC;
      varying vec2 vUv;
      ${NOISE}
      // Slow to start, slow to settle.
      float ease(float t){ t = clamp(t, 0.0, 1.0); return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
      void main(){
        vec4 s = texture2D(tScene, vUv);                       // premultiplied, linear
        // Where the diorama stands (not its pool or its shadow), its edge softened by a few pixels
        // as pigment bleeds on wet paper.
        float near = s.a;
        for (int i = 0; i < 8; i++) {
          float ang = float(i) * 0.785398;
          near = max(near, texture2D(tScene, vUv + vec2(cos(ang), sin(ang)) * uRadius * uTexel).a * 0.8);
        }
        float solid = smoothstep(0.3, 0.85, mix(s.a, near, 0.6));
        // q: the frame in units of the diorama's half size on screen, centred on it.
        vec2 q = (vUv - uCenter) / max(uExtent, vec2(0.05));
        float f = clFbm(q * 1.5 + uSeed) * 0.6 + (1.0 - length(q) * 0.82) * 0.75;
        // The diorama shows through over most of the entrance; its pool and shadow settle last.
        float th = mix(1.3, -0.25, ease(uT));
        float shown = max(smoothstep(th - 0.08, th + 0.16, f), smoothstep(0.72, 1.0, uT));
        // Pigment blooms first, then fades as the scene shows through.
        float bf = clFbm(q * 1.2 + uSeed.yx) * 0.55 + (1.0 - length(q) * 0.95) * 0.7;
        float b0 = mix(1.2, -0.2, ease(uT * 1.7));
        float bloom = smoothstep(b0, b0 + 0.18, bf);
        float bloomRim = smoothstep(b0 - 0.04, b0 + 0.02, bf) - smoothstep(b0 + 0.02, b0 + 0.09, bf);
        float fade = 1.0 - smoothstep(0.4, 0.95, uT);
        float rim = (smoothstep(th - 0.08, th - 0.01, f) - smoothstep(th - 0.01, th + 0.07, f)) * (1.0 - smoothstep(0.7, 1.0, uT));
        vec3 pig = mix(mix(uA, uB, clFbm(q * 1.8)), uC, smoothstep(0.55, 0.8, clFbm(q * 1.1 + 4.0)));
        float a = solid * clamp((bloom * 0.24 + bloomRim * 0.18) * fade * (1.0 - shown) + rim * 0.2, 0.0, 1.0);
        vec4 o = s * shown;
        o = vec4(pig * a, a) + o * (1.0 - a);
        gl_FragColor = vec4(o.a > 0.0001 ? o.rgb / o.a : vec3(0.0), o.a);
        #include <colorspace_fragment>
        gl_FragColor.rgb *= gl_FragColor.a;
      }`,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending
  });
  return { material: mat, uniforms };
}

// ── A watercolour pool under the diorama, painted once on a canvas (or a fine grid, technical) ──
export function paintWash(canvas, style, colours, random) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  const rgba = (col, a) => { const s = col.getStyle(); return s.replace('rgb(', 'rgba(').replace(')', `,${a})`); };
  // Soft contact shadow where the slice stands.
  g.save();
  g.filter = 'blur(14px)';
  g.fillStyle = rgba(colours.ink, style === 'technical' ? 0.1 : 0.14);
  g.fillRect(W * 0.18, H * 0.27, W * 0.64, H * 0.46);
  g.restore();
  if (style === 'technical') {
    g.strokeStyle = rgba(colours.ink, 0.08); g.lineWidth = 1;
    for (let i = 0; i <= W; i += 16) { g.beginPath(); g.moveTo(i + 0.5, 0); g.lineTo(i + 0.5, H); g.stroke(); g.beginPath(); g.moveTo(0, i + 0.5); g.lineTo(W, i + 0.5); g.stroke(); }
    const fade = g.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.5);
    fade.addColorStop(0, rgba(colours.ink, 0)); fade.addColorStop(1, rgba(colours.ink, 1));
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = fade; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
    return;
  }
  const blobs = style === 'playful'
    ? [[colours.grass, 0.2], [colours.water, 0.16], [colours.sage, 0.18], [colours.ochre, 0.1]]
    : [[colours.sage, 0.16], [colours.water, 0.1], [colours.grass, 0.12], [colours.ochre, 0.08], [colours.sage, 0.1]];
  for (const [col, alpha] of blobs) {
    const cx = W * (0.38 + random() * 0.24), cy = H * (0.4 + random() * 0.2);
    const rx = W * (0.3 + random() * 0.14), ry = H * (0.24 + random() * 0.12);
    const ph = [random() * 6.28, random() * 6.28, random() * 6.28];
    g.beginPath();
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const k = 1 + 0.12 * Math.sin(a * 3 + ph[0]) + 0.07 * Math.sin(a * 5 + ph[1]) + 0.04 * Math.sin(a * 9 + ph[2]);
      const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.fillStyle = rgba(col, alpha); g.fill();
    g.strokeStyle = rgba(col, alpha * 0.9); g.lineWidth = 3; g.stroke();
  }
  // Pigment granulation.
  for (let i = 0; i < 2600; i++) {
    const a = random() * Math.PI * 2, r = Math.sqrt(random()) * 0.42;
    g.fillStyle = rgba(random() < 0.5 ? colours.sage : colours.earth, 0.06 + random() * 0.06);
    g.fillRect(W / 2 + Math.cos(a) * r * W, H / 2 + Math.sin(a) * r * H * 0.8, 1.6, 1.6);
  }
}

// A round soft sprite for spray droplets (an alpha mask: its colour comes from the material).
export function dotTexture(colour) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  const s = colour.getStyle().replace('rgb(', 'rgba(');
  gr.addColorStop(0, s.replace(')', ',1)')); gr.addColorStop(0.5, s.replace(')', ',0.75)')); gr.addColorStop(1, s.replace(')', ',0)'));
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(cv);
  return t;
}
