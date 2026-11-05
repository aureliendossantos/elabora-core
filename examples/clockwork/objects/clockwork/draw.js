// Flat colours with ink outlines, in three.js: every part is a flat shape extruded along z (the
// axis of the clock), drawn with unlit colours (a face colour and a darker side), and outlined by
// ribbons of ink on its front and back edges plus a thin hull behind its sides, so that its
// silhouette keeps an outline at any angle. The width of the ink is set in screen pixels (uniform
// `half`, in world units, updated each frame from the camera), so outlines stay even when the
// camera moves in or out.
import * as THREE from 'three';

const INK_VERTEX = `
attribute vec2 aOff;
attribute float aLift;
uniform float uHalf;
void main() {
  vec3 p = position + vec3(aOff * uHalf, aLift * uHalf);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const INK_FRAGMENT = `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #include <colorspace_fragment>
}`;

/** One ink material; `half` is the shared uniform of the ink's half-width. */
export function inkMaterial(half, color, side = THREE.DoubleSide) {
  return new THREE.ShaderMaterial({
    uniforms: { uHalf: half, uColor: { value: new THREE.Color(color) }, uOpacity: { value: 1 } },
    vertexShader: INK_VERTEX,
    fragmentShader: INK_FRAGMENT,
    side,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  });
}

// Normals of a closed contour, pointing out of the material when the contour runs
// counterclockwise around it (outer edge) or clockwise (a hole), scaled for mitred corners.
function contourNormals(pts) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[(i - 1 + n) % n], [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    let ax = y1 - y0, ay = -(x1 - x0);
    let bx = y2 - y1, by = -(x2 - x1);
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    ax /= la; ay /= la; bx /= lb; by /= lb;
    let mx = ax + bx, my = ay + by;
    const lm = Math.hypot(mx, my) || 1;
    mx /= lm; my /= lm;
    const cos = Math.max(0.5, mx * ax + my * ay);
    out[i] = [mx / cos, my / cos];
  }
  return out;
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

const orient = (pts, ccw) => ((signedArea(pts) > 0) === ccw ? pts : [...pts].reverse());

/** A ribbon of ink along each contour, centred on it, at height z. */
function ribbonGeometry(contours, z) {
  const pos = [], off = [], lift = [], index = [];
  for (const pts of contours) {
    const normals = contourNormals(pts);
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i], [nx, ny] = normals[i];
      pos.push(x, y, z, x, y, z);
      off.push(nx, ny, -nx, -ny);
      lift.push(0, 0);
    }
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = base + i * 2, b = base + ((i + 1) % n) * 2;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return inkGeometry(pos, off, lift, index);
}

/** The hull: the side walls of each contour pushed out of the material by the ink's width. */
function hullGeometry(contours, z0, z1, widen) {
  const pos = [], off = [], lift = [], index = [];
  for (const pts of contours) {
    const normals = contourNormals(pts);
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i], [nx, ny] = normals[i];
      pos.push(x, y, z0, x, y, z1);
      off.push(nx * widen, ny * widen, nx * widen, ny * widen);
      lift.push(-1, 1);
    }
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = base + i * 2, b = base + ((i + 1) % n) * 2;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return inkGeometry(pos, off, lift, index);
}

function inkGeometry(pos, off, lift, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 2));
  g.setAttribute('aLift', new THREE.Float32BufferAttribute(lift, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  // The ribbons reach out by the ink's width, which the bounding sphere cannot know.
  if (g.boundingSphere) g.boundingSphere.radius += 2;
  return g;
}

/**
 * Geometries of one extruded part: its body (caps then sides, two material groups), its ink
 * ribbons and its hull. outer: counterclockwise points; holes: lists of points.
 */
export function partGeometries(outer, holes, z0, z1) {
  const o = orient(outer, true);
  const hs = holes.map((h) => orient(h, false));
  const shape = new THREE.Shape(o.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of hs) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  const body = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1, steps: 1 });
  body.translate(0, 0, z0);
  const contours = [o, ...hs];
  const eps = Math.min(0.03, (z1 - z0) * 0.1);
  return {
    body,
    front: ribbonGeometry(contours, z1 + eps),
    back: ribbonGeometry(contours, z0 - eps),
    hull: hullGeometry(contours, z0, z1, 1.15)
  };
}

/** Darker shade of a colour, for the sides of a part. */
export function shade(color, k = 0.8) {
  const c = new THREE.Color(color);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), hsl.l * k);
  return c;
}

/**
 * A part: a group holding the body and its ink, with one opacity for all of it. Geometries can
 * be swapped (a gear that changes size) without changing the materials.
 */
export class Part {
  constructor({ half, color, ink, sideShade = 0.8, renderOrder = 0, name }) {
    this.group = new THREE.Group();
    this.group.name = name || '';
    this.face = new THREE.MeshBasicMaterial({ color, transparent: true });
    this.side = new THREE.MeshBasicMaterial({ color: shade(color, sideShade), transparent: true });
    this.inkFront = inkMaterial(half, ink);
    this.inkHull = inkMaterial(half, ink, THREE.BackSide);
    this.inkHull.polygonOffset = false;
    this.materials = [this.face, this.side, this.inkFront, this.inkHull];
    this.body = new THREE.Mesh(undefined, [this.face, this.side]);
    this.front = new THREE.Mesh(undefined, this.inkFront);
    this.back = new THREE.Mesh(undefined, this.inkFront);
    this.hull = new THREE.Mesh(undefined, this.inkHull);
    for (const m of [this.body, this.front, this.back, this.hull]) { m.renderOrder = renderOrder; this.group.add(m); }
    this.body.userData.part = this;
    this.sideShade = sideShade;
    this.opacity = 1;
  }
  setGeometry(g) {
    this.body.geometry = g.body;
    this.front.geometry = g.front;
    this.back.geometry = g.back;
    this.hull.geometry = g.hull;
  }
  setColor(color) {
    this.face.color.set(color);
    this.side.color.copy(shade(color, this.sideShade));
  }
  setInk(color) {
    this.inkFront.uniforms.uColor.value.set(color);
    this.inkHull.uniforms.uColor.value.set(color);
  }
  setOpacity(a) {
    this.opacity = a;
    this.face.opacity = a;
    this.side.opacity = a;
    this.inkFront.uniforms.uOpacity.value = a;
    this.inkHull.uniforms.uOpacity.value = a;
    this.group.visible = a > 0.004;
    // A part fading out lets what is behind it show without writing depth over it.
    const solid = a > 0.98;
    for (const m of [this.face, this.side, this.inkFront, this.inkHull]) m.depthWrite = solid;
  }
  dispose() {
    for (const m of this.materials) m.dispose();
  }
}

/** Ink ribbons along open or closed polylines (arrows, dashes), at height z, as one geometry. */
export function strokeGeometry(lines, z) {
  const pos = [], off = [], lift = [], index = [];
  for (const { points, closed } of lines) {
    const n = points.length;
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      let tx = next[0] - prev[0], ty = next[1] - prev[1];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
      pos.push(p[0], p[1], z, p[0], p[1], z);
      off.push(ty, -tx, -ty, tx);
      lift.push(0, 0);
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = base + i * 2, b = base + ((i + 1) % n) * 2;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return inkGeometry(pos, off, lift, index);
}

/** Flat triangles (arrow heads), at height z. */
export function flatGeometry(triangles, z) {
  const pos = [];
  for (const t of triangles) for (const [x, y] of t) pos.push(x, y, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
