// Geometry of the diorama: a slice of canal cut clean at both ends, a lock chamber between two
// pairs of mitre gates, and a small barge. Units are metres. Every part is built from simple
// boxes and prisms carrying a "role" per vertex, so one material colours them all from a palette
// (and the style can change without rebuilding anything).
import * as THREE from 'three';

export const ROLE = {
  grass: 0, soil: 1, clay: 2, bed: 3, stone: 4, coping: 5, path: 6,
  gate: 7, gateFrame: 8, beamTip: 9, metal: 10,
  hull: 11, strake: 12, cabin: 13, roof: 14, window: 15, deck: 16, tarp: 17, chimney: 18, flag: 19,
  hole: 20, rope: 21, ink: 22
};
export const ROLE_COUNT = 23;

export function dims(rise) {
  const R = rise;
  const d = {
    R,
    depth: 1.6,           // water depth in both canals and the empty chamber
    free: 0.75,           // freeboard: bank top above the water
    CW: 5.0,              // channel width
    WALL: 0.9,            // chamber wall thickness
    zNear: 5.3,           // the slice is cut closer to the channel on the near side (it hides less)
    zFar: 6.5,
    X0: -15, X1: 15,      // ends of the slice
    xL: -6.5, xU: 6.5,    // hinge lines of the lower and upper gates
    tailX: -10,           // start of the masonry below the lower gates
    headX: 9.6,           // end of the masonry above the upper gates
    baseY: -3.1,          // bottom of the slice
    miter: 0.3,           // angle of a closed leaf off the square (rad)
    boatX: { lower: -10.9, chamber: 0.2, upper: 11.1 }
  };
  d.hw = d.CW / 2;
  d.wallZ = d.hw + d.WALL;
  d.zEdge = d.zFar;
  d.bedLow = -d.depth;
  d.bedUp = R - d.depth;
  d.gLow = d.free;
  d.gHigh = R + d.free;
  d.clayTop = d.bedLow - 0.55;
  d.leafLen = d.hw / Math.cos(d.miter);
  d.tipOffset = d.hw * Math.tan(d.miter);
  d.sillTop = d.bedUp;
  return d;
}

// ── Terrain: a list of boxes (kept for the cross-section caps) ──
export function terrainBoxes(d) {
  const B = [];
  const box = (x0, x1, y0, y1, z0, z1, role) => { if (x1 > x0 && y1 > y0 && z1 > z0) B.push({ x0, x1, y0, y1, z0, z1, role }); };
  const EDGE = 1e6;   // "to the edge of the slice", near or far
  const both = (x0, x1, y0, y1, za, zb, role) => {
    box(x0, x1, y0, y1, za, zb === EDGE ? d.zNear : zb, role);
    box(x0, x1, y0, y1, zb === EDGE ? -d.zFar : -zb, -za, role);
  };
  const { X0, X1, xL, xU, tailX, headX, baseY, hw, wallZ, bedLow, bedUp, gLow, gHigh, clayTop } = d;
  const zEdge = EDGE, zN = d.zNear, zF = d.zFar;
  const grassT = 0.16, curb = 0.45, path = 1.5;
  const sillEnd = xU + 1.3;

  // Under the channel: clay, earth, then the silt of the bed.
  box(X0, xU - 0.3, baseY, clayTop, -hw, hw, ROLE.clay);
  box(X0, xU - 0.3, clayTop, bedLow - 0.14, -hw, hw, ROLE.soil);
  box(X0, xU - 0.3, bedLow - 0.14, bedLow, -hw, hw, ROLE.bed);
  // The upper sill: the masonry step the upper gates stand on.
  box(xU - 0.3, sillEnd, baseY, clayTop, -hw, hw, ROLE.clay);
  box(xU - 0.3, sillEnd, clayTop, bedUp, -hw, hw, ROLE.stone);
  box(sillEnd, X1, baseY, clayTop, -hw, hw, ROLE.clay);
  box(sillEnd, X1, clayTop, bedUp - 0.14, -hw, hw, ROLE.soil);
  box(sillEnd, X1, bedUp - 0.14, bedUp, -hw, hw, ROLE.bed);

  // Lower canal: low banks with a stone edge; the towpath runs along the near bank.
  both(X0, tailX, baseY, clayTop, hw, zEdge, ROLE.clay);
  both(X0, tailX, clayTop, gLow + 0.05, hw, hw + curb, ROLE.stone);
  both(X0, tailX, clayTop, gLow - grassT, hw + curb, zEdge, ROLE.soil);
  box(X0, tailX, gLow - grassT, gLow, hw + curb, hw + curb + path, ROLE.path);
  box(X0, tailX, gLow - grassT, gLow, hw + curb + path, zN, ROLE.grass);
  box(X0, tailX, gLow - grassT, gLow, -zF, -hw - curb, ROLE.grass);

  // The lock: masonry walls from below the lower gates to above the upper ones, coping on top,
  // and the higher ground behind them.
  both(tailX, headX, baseY, clayTop, hw, zEdge, ROLE.clay);
  both(tailX, headX, clayTop, gHigh - 0.14, hw, wallZ, ROLE.stone);
  both(tailX - 0.06, headX, gHigh - 0.14, gHigh + 0.05, hw - 0.1, wallZ + 0.12, ROLE.coping);
  // The step in the land: a retaining wall faces the lower canal.
  both(tailX, tailX + 0.7, clayTop, gHigh - 0.02, wallZ, zEdge, ROLE.stone);
  both(tailX + 0.7, headX, clayTop, gHigh - grassT, wallZ, zEdge, ROLE.soil);
  both(tailX + 0.7, headX, gHigh - grassT, gHigh, wallZ + 0.12, zEdge, ROLE.grass);
  // Steps down to the towpath, against the retaining wall.
  const steps = 7;
  for (let i = 0; i < steps; i++) {
    const top = gLow + ((gHigh - gLow) * (steps - i)) / steps;
    box(tailX - 0.42 * (i + 1), tailX - 0.42 * i, gLow - 0.1, top, zN - 1.1, zN - 0.15, ROLE.coping);
  }

  // Upper canal: high banks with a stone edge, towpath on the near side.
  both(headX, X1, baseY, clayTop, hw, zEdge, ROLE.clay);
  both(headX, X1, clayTop, gHigh + 0.05, hw, hw + curb, ROLE.stone);
  both(headX, X1, clayTop, gHigh - grassT, hw + curb, zEdge, ROLE.soil);
  box(headX, X1, gHigh - grassT, gHigh, hw + curb, hw + curb + path, ROLE.path);
  box(headX, X1, gHigh - grassT, gHigh, hw + curb + path, zN, ROLE.grass);
  box(headX, X1, gHigh - grassT, gHigh, -zF, -hw - curb, ROLE.grass);
  // A bollard on each side of the upper canal, and two by the chamber.
  for (const [x, z] of [[12.4, hw + 0.8], [-3.2, wallZ + 0.45], [3.6, -(wallZ + 0.45)], [-12.6, -(hw + 0.8)]]) {
    const y = x < tailX ? gLow : gHigh;
    box(x - 0.16, x + 0.16, y, y + 0.5, z - 0.16, z + 0.16, ROLE.metal);
  }
  return B;
}

// ── Merging ──
// Geometry accumulator with position, normal and role attributes (non-indexed triangles).
export class Acc {
  constructor() { this.p = []; this.n = []; this.r = []; this.u = []; }
  tri(a, b, c, n, role, uv) {
    this.p.push(...a, ...b, ...c); this.n.push(...n, ...n, ...n); this.r.push(role, role, role);
    if (uv) this.u.push(...uv); else this.u.push(0, 0, 0, 0, 0, 0);
  }
  quad(a, b, c, d, n, role) { this.tri(a, b, c, n, role, [0, 0, 1, 0, 1, 1]); this.tri(a, c, d, n, role, [0, 0, 1, 1, 0, 1]); }
  box(x0, x1, y0, y1, z0, z1, role, skip = '') {
    if (!skip.includes('+x')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], role);
    if (!skip.includes('-x')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], role);
    if (!skip.includes('+y')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], role);
    if (!skip.includes('-y')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], role);
    if (!skip.includes('+z')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], role);
    if (!skip.includes('-z')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], role);
  }
  // Append a three.js geometry (any), transformed by matrix m, with one role (or one per group).
  geometry(geo, role, m) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (m) g.applyMatrix4(m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    const roles = new Array(P.length / 3).fill(typeof role === 'number' ? role : 0);
    if (typeof role === 'object') for (const grp of g.groups) for (let i = grp.start; i < grp.start + grp.count; i++) roles[i] = role[grp.materialIndex] ?? role[0];
    for (let i = 0; i < P.length; i++) { this.p.push(P[i]); this.n.push(N[i]); }
    for (let i = 0; i < roles.length; i++) { this.r.push(roles[i]); this.u.push(0, 0); }
    if (g !== geo) g.dispose();
    geo.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aRole', new THREE.Float32BufferAttribute(this.r, 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(this.p.length), 3));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

export function terrainGeometry(boxes) {
  const acc = new Acc();
  for (const b of boxes) acc.box(b.x0, b.x1, b.y0, b.y1, b.z0, b.z1, b.role);
  return acc.build();
}

// Cross-section of the terrain at depth z (faces looking at +z), for the cut-away view.
export function terrainCap(boxes, z) {
  const acc = new Acc();
  for (const b of boxes) if (b.z0 < z && b.z1 > z) acc.quad([b.x0, b.y0, z], [b.x1, b.y0, z], [b.x1, b.y1, z], [b.x0, b.y1, z], [0, 0, 1], b.role);
  return acc;
}

// Colour every vertex from the palette by its role.
export function paint(geo, palette) {
  const roles = geo.attributes.aRole.array;
  const col = geo.attributes.color;
  for (let i = 0; i < roles.length; i++) { const c = palette[roles[i]] || palette[0]; col.array[i * 3] = c.r; col.array[i * 3 + 1] = c.g; col.array[i * 3 + 2] = c.b; }
  col.needsUpdate = true;
}

// ── Water bodies: prisms on footprints that follow the mitre of the gates ──
// Footprints are polygons in (x, z), anticlockwise seen from above.
export function waterFootprints(d) {
  const { X0, X1, xL, xU, hw, tipOffset: t } = d;
  return {
    lower: [[X0, hw], [X0, -hw], [xL, -hw], [xL + t, 0], [xL, hw]],
    chamber: [[xL, hw], [xL + t, 0], [xL, -hw], [xU, -hw], [xU + t, 0], [xU, hw]],
    upper: [[xU, hw], [xU + t, 0], [xU, -hw], [X1, -hw], [X1, hw]]
  };
}
// Unit-height prism (y from 0 to 1): the mesh is scaled to the depth of its water.
// aTop = 1 on the surface; aDepth = 0 at the top edge of a side, 1 at its bottom.
export function waterPrism(poly) {
  const P = [], N = [], T = [], D = [];
  const push = (x, y, z, n, top, depth) => { P.push(x, y, z); N.push(...n); T.push(top); D.push(depth); };
  const shape = poly.map(([x, z]) => new THREE.Vector2(x, -z));
  const tris = THREE.ShapeUtils.triangulateShape(shape, []);
  for (const [a, b, c] of tris) {
    // Facing up means anticlockwise in (x, -z).
    const ccw = (shape[b].x - shape[a].x) * (shape[c].y - shape[a].y) - (shape[b].y - shape[a].y) * (shape[c].x - shape[a].x) > 0;
    for (const i of ccw ? [a, b, c] : [a, c, b]) push(poly[i][0], 1, poly[i][1], [0, 1, 0], 1, 0);
  }
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
    let n = [dz / len, 0, -dx / len];
    const mx = (x0 + x1) / 2 + n[0] * 0.01, mz = (z0 + z1) / 2 + n[2] * 0.01;
    if (pointIn(poly, mx, mz)) n = [-n[0], 0, -n[2]];
    const a = [x0, 0, z0], b = [x1, 0, z1], c = [x1, 1, z1], e = [x0, 1, z0];
    // (a, b, c) faces (-dz, 0, dx): flip the winding when that is not outwards.
    const flip = -n[0] * dz + n[2] * dx < 0;
    const quad = [[a, 1], [b, 1], [c, 0], [a, 1], [c, 0], [e, 0]];
    const order = flip ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
    for (const k of order) { const [v, dep] = quad[k]; push(v[0], v[1], v[2], n, 0, dep); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(T, 1));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(D, 1));
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}
function pointIn(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// The x extent of a footprint at depth z (for the water's cross-section).
export function footprintSpan(poly, z) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    if ((z0 - z) * (z1 - z) > 0) continue;
    if (z0 === z1) { lo = Math.min(lo, x0, x1); hi = Math.max(hi, x0, x1); continue; }
    const x = x0 + ((x1 - x0) * (z - z0)) / (z1 - z0);
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  return lo < hi ? [lo, hi] : null;
}
// The outline of a footprint, at y = 0 (a line loop scaled with the water).
export function footprintOutline(poly) {
  const P = [];
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    P.push(x0, 0, z0, x1, 0, z1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  return g;
}

// ── A gate leaf, in its own frame: x along the leaf from the hinge, y up, z its thickness ──
// side: 'lower' (tall leaf, from the chamber floor) or 'upper' (short leaf, on the sill).
export function leafGeometry(d, side) {
  const acc = new Acc();
  const L = d.leafLen + 0.08, T = 0.32;
  const y0 = side === 'lower' ? d.bedLow : d.sillTop;
  const y1 = d.gHigh + 0.12;
  acc.box(0.18, L - 0.16, y0, y1, -T / 2, T / 2, ROLE.gate);
  acc.box(-0.05, 0.22, y0, y1 + 0.18, -T / 2 - 0.03, T / 2 + 0.03, ROLE.gateFrame);      // heel post
  acc.box(L - 0.2, L + 0.02, y0, y1 + 0.06, -T / 2 - 0.02, T / 2 + 0.02, ROLE.gateFrame); // mitre post
  // Rails across the leaf.
  for (let y = y0 + 0.9; y < y1 - 0.4; y += 1.25) acc.box(0.2, L - 0.18, y, y + 0.14, -T / 2 - 0.035, T / 2 + 0.035, ROLE.gateFrame);
  acc.box(0.2, L - 0.18, y1 - 0.14, y1, -T / 2 - 0.04, T / 2 + 0.04, ROLE.gateFrame);
  // Balance beam over the bank, painted white at its end, and a walkway on top of the leaf.
  const bw = 0.3, by = y1 + 0.18;
  acc.box(-2.95, 0.1, by - 0.02, by + bw, -bw / 2, bw / 2, ROLE.gate);
  acc.box(-2.97, -2.3, by - 0.03, by + bw + 0.01, -bw / 2 - 0.01, bw / 2 + 0.01, ROLE.beamTip);
  acc.box(0.1, L - 0.05, y1, y1 + 0.06, -T / 2 - 0.18, T / 2 + 0.02, ROLE.coping);
  // Paddle gear: a post near the mitre end, on the walkway.
  const px = L - 0.75;
  acc.box(px - 0.12, px + 0.12, y1 + 0.06, y1 + 0.62, -0.12, 0.12, ROLE.metal);
  acc.box(px - 0.2, px + 0.2, y1 + 0.5, y1 + 0.72, -0.18, 0.18, ROLE.metal);
  // The paddle opening, low in the leaf, as a dark recess on both faces.
  const oy = y0 + 0.45;
  for (const s of [-1, 1]) acc.box(px - 0.4, px + 0.4, oy, oy + 0.55, s > 0 ? T / 2 : -T / 2 - 0.004, s > 0 ? T / 2 + 0.004 : -T / 2, ROLE.hole);
  return { geo: acc.build(), paddleX: px, openingY: oy, top: y1 };
}
// The paddle board that slides over the opening, and the rack that rises with it (leaf frame).
export function paddleGeometry(px, oy, top) {
  const board = new Acc();
  board.box(px - 0.46, px + 0.46, oy - 0.05, oy + 0.6, -0.2, -0.165, ROLE.gateFrame);
  board.box(px - 0.46, px + 0.46, oy - 0.05, oy + 0.6, 0.165, 0.2, ROLE.gateFrame);
  const rack = new Acc();
  rack.box(px - 0.04, px + 0.04, top + 0.3, top + 1.0, -0.04, 0.04, ROLE.metal);
  rack.box(px - 0.09, px + 0.09, top + 0.96, top + 1.06, -0.09, 0.09, ROLE.beamTip);
  return { board: board.build(), rack: rack.build() };
}

// ── The barge: bow towards +x, waterline at y = 0 ──
export function boatGeometry() {
  const acc = new Acc();
  const draft = 0.5, freeboard = 0.55;
  const hull = new THREE.Shape();
  hull.moveTo(-2.95, -1.0);
  hull.lineTo(1.7, -1.0);
  hull.quadraticCurveTo(2.85, -0.85, 3.25, 0);
  hull.quadraticCurveTo(2.85, 0.85, 1.7, 1.0);
  hull.lineTo(-2.95, 1.0);
  hull.quadraticCurveTo(-3.35, 1.0, -3.35, 0);
  hull.quadraticCurveTo(-3.35, -1.0, -2.95, -1.0);
  const m = new THREE.Matrix4();
  const hullGeo = new THREE.ExtrudeGeometry(hull, { depth: draft + freeboard, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1, curveSegments: 10 });
  acc.geometry(hullGeo, { 0: ROLE.deck, 1: ROLE.hull }, m.makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0, -draft, 0)));
  // Rubbing strake: a band around the hull just under the deck.
  const strake = new THREE.ExtrudeGeometry(hull, { depth: 0.13, bevelEnabled: false, curveSegments: 10 });
  const ms = new THREE.Matrix4().makeRotationX(-Math.PI / 2).premultiply(new THREE.Matrix4().makeScale(1.025, 1, 1.06)).premultiply(new THREE.Matrix4().makeTranslation(0, freeboard - 0.2, 0));
  acc.geometry(strake, ROLE.strake, ms);
  const deckY = freeboard + 0.05;
  // Hold cover: a long rounded tarp over the cargo.
  const tarp = new THREE.CylinderGeometry(0.72, 0.72, 2.9, 14, 1, false, 0, Math.PI);
  // The half cylinder lies on +x around y: turned a quarter about z, it lies along x, rounded up.
  acc.geometry(tarp, ROLE.tarp, new THREE.Matrix4().makeRotationZ(Math.PI / 2).premultiply(new THREE.Matrix4().makeTranslation(0.75, deckY - 0.05, 0)));
  acc.box(-0.72, 2.22, deckY - 0.02, deckY + 0.16, -0.78, 0.78, ROLE.strake, '-y');
  // Wheelhouse at the stern.
  const cx0 = -2.85, cx1 = -1.15, cy0 = deckY, cy1 = deckY + 1.05;
  acc.box(cx0, cx1, cy0, cy1, -0.78, 0.78, ROLE.cabin, '-y');
  acc.box(cx0 - 0.12, cx1 + 0.12, cy1, cy1 + 0.1, -0.88, 0.88, ROLE.roof);
  for (const z of [-0.79, 0.79]) {
    const s = Math.sign(z);
    for (const x of [cx0 + 0.25, cx0 + 0.95]) acc.box(x, x + 0.5, cy0 + 0.48, cy0 + 0.82, s > 0 ? 0.78 : -0.795, s > 0 ? 0.795 : -0.78, ROLE.window);
  }
  acc.box(cx1, cx1 + 0.012, cy0 + 0.5, cy0 + 0.84, -0.55, 0.55, ROLE.window);
  // Chimney, tiller, fenders, a lifebuoy.
  acc.geometry(new THREE.CylinderGeometry(0.09, 0.1, 0.5, 10), ROLE.chimney, new THREE.Matrix4().makeTranslation(cx1 - 0.35, cy1 + 0.33, -0.4));
  acc.geometry(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 10), ROLE.strake, new THREE.Matrix4().makeTranslation(cx1 - 0.35, cy1 + 0.6, -0.4));
  acc.box(-3.55, -3.3, deckY + 0.1, deckY + 0.2, -0.05, 0.05, ROLE.gateFrame);
  acc.box(-3.35, -3.25, deckY - 0.15, deckY + 0.2, -0.05, 0.05, ROLE.gateFrame);
  for (const z of [-1.04, 1.04]) for (const x of [-1.9, -0.2, 1.5]) acc.geometry(new THREE.CylinderGeometry(0.11, 0.11, 0.42, 8), ROLE.rope, new THREE.Matrix4().makeTranslation(x, freeboard - 0.45, z));
  acc.geometry(new THREE.TorusGeometry(0.26, 0.07, 6, 14), ROLE.flag, new THREE.Matrix4().makeTranslation(-2.0, cy0 + 0.55, 0.83));
  // Flag pole at the stern (the flag itself is its own mesh).
  acc.box(-3.12, -3.06, deckY, deckY + 1.55, -0.03, 0.03, ROLE.gateFrame);
  return { geo: acc.build(), deckY, poleTop: deckY + 1.55, poleX: -3.09 };
}
export function flagGeometry() {
  const g = new THREE.PlaneGeometry(0.62, 0.38, 6, 1);
  g.translate(0.31, -0.19, 0);
  const n = g.attributes.position.count;
  g.setAttribute('aRole', new THREE.Float32BufferAttribute(new Array(n).fill(ROLE.flag), 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  g.userData.rest = Float32Array.from(g.attributes.position.array);
  return g;
}
