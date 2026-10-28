// 打包(WORKFLOW 第 8 步):每棟的牆面、屋面貼圖排進一張貼圖集,合成 1 個貼圖模型;
// 量體、女兒牆、屋突、樓梯塔等沒有貼圖的構件用頂點顏色合成 1 個模型 → 每棟 2 個 draw call。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX_ATLAS = 4096, PAD = 2; // WebGL 一般支援到 4096(手機也多半可以)
const STEP = 64; // 貼圖集邊長以 64 px 為單位(不進位到 2 的次方:WebGL2 支援任意尺寸,進位會浪費很多記憶體)
const ceilStep = (v) => Math.max(128, Math.ceil(v / STEP) * STEP);

// 架子式排列(依高度由高到低一排一排放)到寬 W、最高 Hmax 的長方形;回傳實際用到的高度,放不下回傳 null
function shelfPack(items, W, Hmax) {
  let x = PAD, y = PAD, rowH = 0;
  for (const it of items) {
    if (it.w + 2 * PAD > W) return null;
    if (x + it.w + PAD > W) { x = PAD; y += rowH + PAD; rowH = 0; }
    if (y + it.h + PAD > Hmax) return null;
    it.x = x; it.y = y;
    x += it.w + PAD; rowH = Math.max(rowH, it.h);
  }
  return y + rowH + PAD;
}

function prep(mesh) {
  mesh.updateWorldMatrix(true, false);
  let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  if (g.index) g = g.toNonIndexed();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  g.clearGroups();
  return g;
}

// textured:有貼圖的 mesh(牆面平面、屋面);plain:沒有貼圖的 mesh(依各自材質顏色寫成頂點顏色)
export function packBuilding(textured, plain, maxAtlas = MAX_ATLAS, scale0 = 1) {
  const t0 = performance.now();
  // 同一張貼圖切成好幾塊貼(挖空、退縮的牆)時,貼圖集裡只放一次
  const byImg = new Map();
  for (const mesh of textured) {
    const map = mesh.material.map, img = map.image;
    if (!byImg.has(img)) byImg.set(img, { img, meshes: [], w0: img.width, h0: img.height });
    byImg.get(img).meshes.push({ mesh, rep: map.repeat.clone(), off: map.offset.clone() });
  }
  const items = [...byImg.values()];
  // 長方形貼圖集:寬 = max(最長的一條, √面積),高度排到哪切到哪(牆面貼圖又長又扁,塞進正方形會浪費很多);
  // 都以 64 px 為單位;超過上限就把每張等比縮小
  const area = items.reduce((a, it) => a + it.w0 * it.h0, 0);
  let s = scale0, W = 0, H = 0;
  for (let tries = 0; tries < 80; tries++) {
    for (const it of items) { it.w = Math.max(4, Math.floor(it.w0 * s)); it.h = Math.max(4, Math.floor(it.h0 * s)); }
    // 從「最長的一條」到上限,每 64 px 試一種寬度,挑排完總面積最小的
    const sorted = [...items].sort((a, b) => b.h - a.h), wMin = ceilStep(Math.max(...items.map((it) => it.w + 2 * PAD)));
    let best = null;
    for (let w = wMin; w <= maxAtlas; w += STEP) {
      const used = shelfPack(sorted, w, maxAtlas);
      if (used && (!best || w * ceilStep(used) < best.w * best.h)) best = { w, h: ceilStep(used) };
      if (used && ceilStep(used) <= STEP * 2) break; // 已經只剩一兩排,再寬只會更浪費
    }
    if (best) { W = best.w; H = best.h; shelfPack(sorted, W, maxAtlas); break; } // 用最好的寬度重排一次,寫回位置
    s *= 0.94;
  }
  const A = Math.max(W, H); // 回報用(較長邊)
  const atlas = Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = atlas.getContext('2d');
  ctx.fillStyle = '#888';
  ctx.fillRect(0, 0, W, H);
  const geos = [];
  for (const it of items) {
    ctx.drawImage(it.img, it.x, it.y, it.w, it.h);
    for (const { mesh, rep, off } of it.meshes) {
      const g = prep(mesh), uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) { // 原本的 uv(含貼圖的 repeat / offset)→ 貼圖集裡的位置
        const u = THREE.MathUtils.clamp(uv.getX(i) * rep.x + off.x, 0, 1), v = THREE.MathUtils.clamp(uv.getY(i) * rep.y + off.y, 0, 1);
        uv.setXY(i, (it.x + u * it.w) / W, 1 - (it.y + (1 - v) * it.h) / H);
      }
      geos.push(g);
    }
  }
  const tex = new THREE.CanvasTexture(atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const group = new THREE.Group();
  let tris = 0;
  if (geos.length) {
    const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })); // 貼圖(牆面、屋面)永遠畫在量體表面之前
    m.receiveShadow = true;
    m.name = 'textured';
    group.add(m);
    tris += m.geometry.attributes.position.count / 3;
  }
  const pg = plain.map((mesh) => {
    const g = prep(mesh);
    g.deleteAttribute('uv');
    const c = (mesh.material.color ?? new THREE.Color(0xcccccc)).clone(), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  if (pg.length) {
    const m = new THREE.Mesh(mergeGeometries(pg), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, side: THREE.DoubleSide }));
    m.castShadow = m.receiveShadow = true;
    m.name = 'plain';
    group.add(m);
    tris += m.geometry.attributes.position.count / 3;
  }
  const used = items.reduce((a, it) => a + it.w * it.h, 0);
  return { group, atlas: `${W}×${H}`, scale: s, bytes: Math.round(W * H * 4 * 4 / 3), tris, ms: performance.now() - t0, inputs: textured.length + plain.length, fill: +(used / (W * H)).toFixed(2) };
}
