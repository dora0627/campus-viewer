// 量體造型:A(整棟拉高)加上規格裡的 cuts(騎樓、內凹、外凸)與退縮,仍然是幾段拉高的多邊形,不逐層建模。
// 樓層工具:著色器依每個像素的高度算出第幾樓(高亮、剖切、爆炸圖都只改 uniform),不多建幾何。
// 規格格式見 CLAUDE.md「立面規格」的 cuts;樓層高度跟 facade.js 畫貼圖的算法一致。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { drawFacade } from './facade.js';

const OUT = 0.06; // 貼圖面離牆面的距離(跟 texture.js 一樣)
const PPM_BY_LEVEL = { observed: 24, building: 16, adjacent: 16, neighbor: 8, osm: 8, default: 6 };

// 樓層高度:一樓 ground_h_m,其他層平均分到女兒牆以下(facade.js 也是這樣畫窗)
export function levelsOf(b) {
  const spec = b.faces.find((f) => f.spec && !f.spec.inferred_from)?.spec ?? b.faces.find((f) => f.spec)?.spec ?? {};
  const H = b.height_m, n = Math.max(1, spec.floors ?? b.floors ?? Math.round(H / 3.6));
  const g = spec.ground_h_m ?? spec.floor_h_m ?? 3.6, parapet = spec.parapet?.h_m ?? 0.9;
  const typ = n > 1 ? (H - parapet - g) / (n - 1) : H - parapet;
  return {
    H, n, g, typ,
    bottom: (f) => (f <= 1 ? 0 : g + (f - 2) * typ), // 第 f 樓(1 = 一樓)的地板高
    top: (f) => g + (f - 1) * typ,
    floorAt: (y) => (y < g ? 1 : Math.floor((y - g) / typ) + 2), // 超過 n 是女兒牆、屋頂
  };
}

const area2 = (ring) => ring.reduce((a, [x, z], i) => { const [x2, z2] = ring[(i + 1) % ring.length]; return a + x * z2 - x2 * z; }, 0);
// 一條邊:朝外法線 n、站在外面看的右手邊 R(立面貼圖、cuts 的 t 都是左 0 → 右 1)
export function edgeFrame(ring, i) {
  const p = ring[i], q = ring[(i + 1) % ring.length], dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz) || 1;
  const s = area2(ring) > 0 ? 1 : -1, n = [(s * dz) / len, (-s * dx) / len], R = [n[1], -n[0]], mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  return { len, n, R, mid, rotY: Math.atan2(n[0], n[1]), fwd: dx * R[0] + dz * R[1] > 0, at: (t) => [mid[0] + (t - 0.5) * len * R[0], mid[1] + (t - 0.5) * len * R[1]] };
}

// 每條邊往內退 d 公尺(轉角用兩邊法線的平均,斜接)
function insetRing(ring, d) {
  const N = ring.length, fr = ring.map((_, i) => edgeFrame(ring, i));
  return ring.map(([x, z], i) => {
    const a = fr[(i - 1 + N) % N].n, b = fr[i].n, k = d / (1 + a[0] * b[0] + a[1] * b[1]);
    return [x - (a[0] + b[0]) * k, z - (a[1] + b[1]) * k];
  });
}

function shapeOf(ring) {
  const s = new THREE.Shape();
  ring.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)));
  return s;
}
const prism = (ring, y0, y1) => new THREE.ExtrudeGeometry(shapeOf(ring), { depth: y1 - y0, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0);

// 規格的 cuts → 每條邊的 { t0, t1, y0, y1, d }(d > 0 往內挖,< 0 往外凸)
function cutsOf(b, L) {
  const out = new Map();
  for (const f of b.faces) for (const c of f.spec?.cuts ?? []) {
    const [f0, f1] = c.floors ?? [1, 1];
    const cut = { ...c, t0: Math.min(c.t0, c.t1), t1: Math.max(c.t0, c.t1), y0: L.bottom(f0), y1: Math.min(L.top(f1), L.H), d: (c.type === 'bump' ? -1 : 1) * (c.depth_m ?? 1) };
    (out.get(f.edge) ?? out.set(f.edge, []).get(f.edge)).push(cut);
  }
  return out;
}

// 在 ya–yb 這一段高度,把有 cut 的邊在輪廓上挖一個凹口(或凸出一塊)
function notched(ring, cuts, ya, yb) {
  const out = [];
  ring.forEach((p, i) => {
    out.push(p);
    const cs = (cuts.get(i) ?? []).filter((c) => c.y0 <= ya + 1e-6 && c.y1 >= yb - 1e-6);
    if (!cs.length) return;
    const F = edgeFrame(ring, i);
    for (const c of cs.sort((a, b) => (F.fwd ? a.t0 - b.t0 : b.t0 - a.t0))) {
      const [ta, tb] = F.fwd ? [c.t0, c.t1] : [c.t1, c.t0], A = F.at(ta), B = F.at(tb), dn = [-F.n[0] * c.d, -F.n[1] * c.d];
      out.push(A, [A[0] + dn[0], A[1] + dn[1]], [B[0] + dn[0], B[1] + dn[1]], B);
    }
  });
  // 貼著轉角的 cut(t0 = 0 或 t1 = 1)會跟原本的頂點重疊,去掉重複的點,三角化才不會出錯
  return out.filter((p, i) => { const q = out[(i + 1) % out.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4; });
}

// 一片貼圖面的幾何(世界座標):貼圖的 u0–u1、高度 ya–yb 那一塊,放在牆線往內 d 公尺的位置
function pieceGeo(F, u0, u1, ya, yb, H, d) {
  const g = new THREE.PlaneGeometry((u1 - u0) * F.len, yb - ya), uv = g.attributes.uv, c = F.at((u0 + u1) / 2);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), (ya + uv.getY(i) * (yb - ya)) / H);
  return g.rotateY(F.rotY).translate(c[0] + F.n[0] * (OUT - d), (ya + yb) / 2, c[1] + F.n[1] * (OUT - d));
}

// 量體造型(只有幾何):依 cuts 與退縮分段拉高、騎樓柱;opts.cuts = false 時就是原本的 A
// opts.setback = { from_floor, inset_m }:那層以上整圈往內退
export function massShape(b, opts = {}) {
  const L = levelsOf(b), H = L.H, cuts = opts.cuts === false ? new Map() : cutsOf(b, L);
  const sb = opts.setback, ys = sb ? L.bottom(sb.from_floor) : Infinity, upper = sb ? insetRing(b.ring, sb.inset_m) : b.ring;
  const base = (y) => (y >= ys - 1e-6 ? upper : b.ring);
  // 高度分段:地面、屋頂、每個 cut 的上下緣、退縮那層
  const Y = [...new Set([0, H, ...[...cuts.values()].flat().flatMap((c) => [c.y0, c.y1]), ...(sb ? [ys] : [])].map((y) => +y.toFixed(3)))].filter((y) => y >= 0 && y <= H).sort((a, b) => a - b);
  const bands = [];
  for (let k = 0; k + 1 < Y.length; k++) bands.push(prism(notched(base(Y[k]), cuts, Y[k], Y[k + 1]), Y[k], Y[k + 1]).toNonIndexed());
  // 騎樓柱:沿原本的牆線,間距約一個窗組
  const columns = [];
  for (const f of b.faces) for (const c of (cuts.get(f.edge) ?? []).filter((c) => c.columns)) {
    const F = edgeFrame(b.ring, f.edge), bayW = F.len / Math.max(1, f.spec?.bays ?? 6), nb = Math.max(2, Math.round(((c.t1 - c.t0) * F.len) / bayW));
    const color = new THREE.Color(f.spec?.ground?.color ?? f.spec?.wall?.color ?? '#9a4632');
    for (let k = 0; k <= nb; k++) {
      const p = F.at(c.t0 + ((c.t1 - c.t0) * k) / nb);
      columns.push({ color, geo: new THREE.BoxGeometry(0.5, c.y1 - c.y0, 0.5).rotateY(F.rotY).translate(p[0] - F.n[0] * 0.3, (c.y0 + c.y1) / 2, p[1] - F.n[1] * 0.3) });
    }
  }
  return { b, L, cuts, Y, mass: bands.length > 1 ? mergeGeometries(bands) : bands[0], bands: bands.length, columns, topRing: upper, base, ringAt: (y) => notched(base(y), cuts, y, y), shaped: cuts.size > 0 || !!sb };
}

// 一面的貼圖 mesh:沒有 cut、沒有退縮就是一整片(跟原本一樣);有的話切成幾塊,合成一個 mesh
export function faceMesh(S, edge, material) {
  const cs = S.cuts.get(edge) ?? [], U = [...new Set([0, 1, ...cs.flatMap((c) => [c.t0, c.t1])])].sort((a, b) => a - b), geos = [];
  for (let a = 0; a + 1 < U.length; a++) for (let k = 0; k + 1 < S.Y.length; k++) {
    const um = (U[a] + U[a + 1]) / 2, ym = (S.Y[k] + S.Y[k + 1]) / 2, c = cs.find((c) => c.t0 <= um && um <= c.t1 && c.y0 <= ym && ym <= c.y1);
    geos.push(pieceGeo(edgeFrame(S.base(S.Y[k]), edge), U[a], U[a + 1], S.Y[k], S.Y[k + 1], S.L.H, c?.d ?? 0));
  }
  const m = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], material);
  m.userData.pieces = geos.length;
  return m;
}

// 一棟全部(測試頁用):量體、騎樓柱、每條邊的貼圖面
export function buildShaped(b, opts = {}) {
  const t0 = performance.now(), S = massShape(b, opts), main = b.faces.find((f) => f.spec && !f.spec.inferred_from)?.spec;
  const plain = [new THREE.Mesh(S.mass, new THREE.MeshStandardMaterial({ color: main?.wall?.color ?? 0xdedad2, roughness: 0.85 }))], textured = [];
  for (const c of S.columns) plain.push(new THREE.Mesh(c.geo, new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.9 })));
  // 貼圖:每條邊一張(有實拍規格用實拍的,其他用推定的)
  const specOf = new Map((b.facades ?? []).map((e) => [e.edge, e]));
  for (const f of b.faces) if (f.spec) specOf.set(f.edge, { spec: f.spec, level: f.spec.inferred_from ? 'building' : 'observed' });
  let pieces = 0;
  for (let i = 0; i < b.ring.length; i++) {
    const e = specOf.get(i), len = edgeFrame(b.ring, i).len;
    if (!e?.spec || len < 0.5) continue;
    const tex = new THREE.CanvasTexture(drawFacade(e.spec, len, S.L.H, PPM_BY_LEVEL[e.level] ?? 8).canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = faceMesh(S, i, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    pieces += m.userData.pieces;
    textured.push(m);
  }
  return { L: S.L, plain, textured, topRing: S.topRing, ringAt: S.ringAt, bands: S.bands, pieces, ms: performance.now() - t0 };
}

// ── 樓層工具 ──
export function floorUniforms(L) {
  return { uG: { value: L.g }, uT: { value: L.typ }, uN: { value: L.n }, uPick: { value: 0 }, uHover: { value: 0 }, uCut: { value: 1e5 }, uLo: { value: -1e5 }, uHi: { value: 1e5 }, uTint: { value: new THREE.Color(0xffa31a) } };
}
// 在現有材質(貼圖照用)加上:依物件座標的高度算樓層 → 選到的那層上色;高於 uCut、不在 uLo–uHi 的像素不畫
export function patchFloors(mat, u) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vFY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFY = transformed.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFY;\nuniform float uG, uT, uN, uPick, uHover, uCut, uLo, uHi;\nuniform vec3 uTint;')
      .replace('void main() {', 'void main() {\n  if (vFY > uCut || vFY < uLo || vFY >= uHi) discard;')
      .replace('#include <dithering_fragment>', `float fl = vFY < uG ? 1.0 : floor((vFY - uG) / uT) + 2.0;
  if (fl <= uN) {
    if (abs(fl - uPick) < 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, uTint, 0.5);
    else if (abs(fl - uHover) < 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, uTint, 0.22);
  }
  #include <dithering_fragment>`);
  };
  mat.customProgramCacheKey = () => 'floors';
  mat.needsUpdate = true;
}

// 樓板蓋子(剖切、爆炸圖時蓋住切口):照那個高度的輪廓,畫成淺色樓板加格線
let slabTex = null;
export function slabMaterial() {
  if (!slabTex) {
    const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), c = cv.getContext('2d');
    c.fillStyle = '#e9e4da'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#c9c2b4'; c.fillRect(0, 0, 64, 2); c.fillRect(0, 0, 2, 64);
    slabTex = new THREE.CanvasTexture(cv);
    slabTex.wrapS = slabTex.wrapT = THREE.RepeatWrapping;
    slabTex.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.MeshStandardMaterial({ map: slabTex, roughness: 0.95, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
}
export function slabGeometry(ring, y) {
  const g = new THREE.ShapeGeometry(shapeOf(ring)).rotateX(-Math.PI / 2).translate(0, y, 0), pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 4, pos.getZ(i) / 4); // 每 4 m 一格
  return g;
}
