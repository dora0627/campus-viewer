// 立面貼圖階段:① 依 spec.json 用 facade.js 畫貼圖、貼到白模(量畫圖時間、貼圖大小,規格的 token 從 tokens.json 來)
// ② 比對:相機放到代表截圖的位置、朝向、視角,左截圖右模型並排,自動算分數(顏色、樓層線節奏、窗列節奏)。
// 網址參數:?run=all 自動跑完;&pace=毫秒(每一面之間的停頓,只影響畫面)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { addNav } from './nav.js';
import { drawFacade } from './facade.js';
import { buildRoof } from './roof.js';
import { packBuilding } from './pack.js';
import { buildSite } from './site.js';
import { massShape, faceMesh, linkGeometry } from './shape.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PACE = +(params.get('pace') ?? 700), HOLD = +(params.get('hold') ?? 2600);
// 自動對位(實驗):在 ±4 m、±24° 找結構最吻合的相機。實測會「湊分數」(邊線碰巧重疊時分數變高、畫面反而更不像),所以預設不用;?align=1 才開
const ALIGN = params.get('align') === '1';
const EYE_M = 2.5;

const data = await (await fetch('data.json', { cache: 'no-cache' })).json(); // 資料常重新匯出,不用快取
const tokens = await fetch('tokens.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
$('credit').textContent = data.ground.credit;
const specCost = tokens?.by_task?.['facade-spec']; // 每面規格的平均費用

// ── 場景 ──
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x5a5048, 1.5));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.position.set(-160, 260, 220);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, far: 1000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun);

const g = data.ground;
const tex = g.image ? new THREE.TextureLoader().load(g.image) : null; // 公開版沒有正射底圖(授權未確認),用中性地面
if (tex) tex.colorSpace = THREE.SRGBColorSpace;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(g.x1 - g.x0, g.z1 - g.z0), new THREE.MeshStandardMaterial({ map: tex, roughness: 1, color: tex ? 0xb0b0b0 : 0x8f9a84 }));
ground.rotation.x = -Math.PI / 2;
ground.position.set((g.x0 + g.x1) / 2, 0, (g.z0 + g.z1) / 2);
ground.receiveShadow = true;
scene.add(ground);

// 白模(A 整體拉高)
const clay = new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.85 });
function shapeOf(ring) {
  const s = new THREE.Shape();
  ring.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)));
  return s;
}
const massBy = new Map(), extrasBy = new Map(), shapeBy = new Map(); // 每棟的量體、構件(打包時用)、造型(shape.js)
for (const b of data.buildings) {
  // 規格有 cuts(騎樓、內凹、外凸)的用 shape.js 分段拉高;其他照原本整棟拉高
  const S = massShape(b);
  shapeBy.set(b.id, S);
  const m = new THREE.Mesh(S.shaped ? S.mass : new THREE.ExtrudeGeometry(shapeOf(b.ring), { depth: b.height_m, bevelEnabled: false }).rotateX(-Math.PI / 2), clay);
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  massBy.set(b.id, m);
  for (const c of S.columns) { // 騎樓柱
    const col = new THREE.Mesh(c.geo, new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.9 }));
    col.castShadow = true;
    scene.add(col);
    (extrasBy.get(b.id) ?? extrasBy.set(b.id, []).get(b.id)).push(col);
  }
}
const withSpec = data.buildings.filter((b) => b.faces.some((f) => f.spec));
const focus = new THREE.Vector3();
for (const b of withSpec) for (const [x, z] of b.ring) focus.add(new THREE.Vector3(x, 0, z).multiplyScalar(1 / b.ring.length / withSpec.length));
controls.target.copy(focus);
camera.position.set(focus.x - 70, 70, focus.z + 95);
const nav = addNav({ camera, controls, renderer, scene, buildings: data.buildings });

// 一面的位置:牆線中點、朝外法線、長度;平面的 +x 正好是「站在外面看的右手邊」,所以貼圖左→右不用翻
function faceFrame(b, f) {
  const p = b.ring[f.edge], q = b.ring[(f.edge + 1) % b.ring.length];
  const r = (f.normal_deg * Math.PI) / 180, n = [Math.sin(r), -Math.cos(r)];
  return { mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], n, len: Math.hypot(q[0] - p[0], q[1] - p[1]), rotY: Math.atan2(n[0], n[1]) };
}

// 外掛樓梯塔:每層一片朝外的半圓平台 + 欄板
function stairTower(b, f, e, frame, fh) {
  const grp = new THREE.Group(), w = ((e.t1 ?? 0.6) - (e.t0 ?? 0.4)) * frame.len, rad = Math.max(1.2, w / 2);
  const slabM = new THREE.MeshStandardMaterial({ color: 0x9c9c98, roughness: 0.9 }), wallM = new THREE.MeshStandardMaterial({ color: 0x8e8e8a, roughness: 0.9, side: THREE.DoubleSide });
  for (let k = 1; k < (b.floors ?? 1); k++) {
    const y = k * fh;
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 0.25, 24, 1, false, -Math.PI / 2, Math.PI), slabM);
    slab.position.set(0, y, 0);
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, 1.0, 24, 1, true, -Math.PI / 2, Math.PI), wallM);
    rail.position.set(0, y + 0.6, 0);
    grp.add(slab, rail);
  }
  const tc = ((e.t0 ?? 0.4) + (e.t1 ?? 0.6)) / 2 - 0.5; // 沿牆位置(左 0 → 右 1,中心為 0)
  grp.rotation.y = frame.rotY;
  grp.position.set(frame.mid[0] + Math.cos(frame.rotY) * tc * frame.len + frame.n[0] * 0.1, 0, frame.mid[1] - Math.sin(frame.rotY) * tc * frame.len + frame.n[1] * 0.1);
  grp.traverse((o) => o.isMesh && (o.castShadow = true));
  return grp;
}

// 連接構件(links.json):兩面之間最近兩點拉一座橋(shape.js,高度用兩棟那一層的實際高度)
const byIdT = new Map(data.buildings.map((b) => [b.id, b]));
function linkMesh(link) {
  const L = linkGeometry(link, byIdT);
  if (!L) return null;
  const m = new THREE.Mesh(L.geo, new THREE.MeshStandardMaterial({ color: 0xa4503a, roughness: 0.85 }));
  m.castShadow = true;
  return m;
}

// ── ① 貼立面 ──
const faceMeshes = new Map(), rows = [], planes = [], roofs = new Map();
const roofCost = tokens?.by_task?.['roof-spec']?.cost_usd ?? null; // 每棟屋頂規格的平均費用
// 來源等級(tools/resolve_specs.py):顏色給「顯示來源」用;推定、預設的牆用較低解析度畫
const LEVELS = { observed: ['① 實拍', 0x2e9d5b], building: ['② 同棟推定', 0x3d7be0], adjacent: ['③ 相鄰', 0x55b8e6], neighbor: ['④ 鄰近建築', 0xf0a03c], osm: ['⑤ OSM', 0xc66bd6], default: ['⑥ 預設', 0x8c8f96] };
const PPM_BY_LEVEL = { observed: 24, building: 16, adjacent: 16, neighbor: 8, osm: 8, default: 6 }; // 預設的牆最多、最不重要,解析度最低

// 其他牆面:沒有實拍規格的邊(短邊、還沒拍的建築)依規則推定後一次貼上
async function fillRest() {
  const t0 = performance.now();
  flyTo(new THREE.Vector3(focus.x - 260, 300, focus.z + 330), new THREE.Vector3(focus.x + 120, 0, focus.z - 60), 1200);
  for (const [i, b] of data.buildings.entries()) {
    const done = new Set(b.faces.filter((f) => f.spec).map((f) => f.edge));
    for (const e of b.facades ?? []) {
      if (done.has(e.edge) || e.length_m < 0.5) continue;
      const frame = faceFrame(b, e);
      const { canvas, ms, bytes } = drawFacade(e.spec, frame.len, b.height_m, PPM_BY_LEVEL[e.level] ?? 8);
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      const mesh = faceMesh(shapeBy.get(b.id), e.edge, new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 })); // 有 cut 的邊切成幾塊
      scene.add(mesh);
      planes.push({ mesh, b: b.id, level: e.level, len: frame.len, bytes, ms });
    }
    if (!roofs.has(b.id)) { const r = buildRoof(b, b.roof); scene.add(r.group); roofs.set(b.id, { level: b.roof ? 'observed' : 'default', ...r }); }
    $('now').innerHTML = `<div class="kv"><span class="step">① 其他牆面</span> 依規則推定(第 ${i + 1} / ${data.buildings.length} 棟)</div><div class="name">${b.name}</div>
      <div class="kv">${(b.facades ?? []).map((e) => LEVELS[e.level]?.[0]).filter((v, k, a) => a.indexOf(v) === k).join('、')}</div>`;
    await sleep(Math.min(120, PACE / 5));
  }
  window.__rest = { ms: performance.now() - t0 };
  renderSum();
}

// ④ 場地(B5 預設):道路依種類給寬度與鋪面、區域上色、樹列種樹
let siteGroup = null;
async function addSite() {
  if (siteGroup || !data.site?.segments?.length) return;
  const { group, stats } = buildSite(data.site);
  siteGroup = group;
  scene.add(group);
  window.__site = stats;
  $('now').innerHTML = `<div class="kv"><span class="step">④ 場地</span>(B5:道路種類的預設寬度與鋪面,還沒有道路規格)</div>
    <div class="name">道路 ${stats.segments} 段・${(stats.length / 1000).toFixed(1)} km</div>
    <div class="kv">區域 ${stats.areas} 塊・樹 ${stats.trees} 棵・${stats.calls} 個 draw call・${stats.ms.toFixed(0)} ms・0 token</div>`;
  flyTo(new THREE.Vector3(focus.x - 120, 140, focus.z + 160), new THREE.Vector3(focus.x + 40, 0, focus.z - 20), 1200);
  await sleep(2500);
}
// 底圖:正射影像(只供內部參考,見 LICENSES.md)↔ 中性地面(對外發布用)
const groundMap = ground.material.map;
$('groundBtn').hidden = !groundMap;
function toggleGround(ortho = !ground.material.map) {
  if (!groundMap) return;
  ground.material.map = ortho ? groundMap : null;
  ground.material.color.set(ortho ? 0xb0b0b0 : 0x8f9a84);
  ground.material.needsUpdate = true;
  $('groundBtn').textContent = ortho ? '底圖:正射' : '底圖:中性';
}

let showSrc = false;
function toggleSource(on = !showSrc) {
  showSrc = on;
  for (const p of planes) {
    p.mesh.userData.mat ??= p.mesh.material;
    p.mesh.material = on ? (LEVEL_MATS[p.level] ??= new THREE.MeshBasicMaterial({ color: LEVELS[p.level]?.[1] ?? 0x888888 })) : p.mesh.userData.mat;
  }
  $('srcBtn').textContent = on ? '顯示貼圖' : '顯示來源';
  renderSum();
}
const LEVEL_MATS = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function texturize() {
  $('faces').hidden = false;
  let total = { ms: 0, bytes: 0, cost: 0 };
  for (const b of withSpec) {
    for (const f of b.faces) {
      if (!f.spec || faceMeshes.has(`${b.id}/${f.id}`)) continue;
      const frame = faceFrame(b, f);
      const { canvas, ms, bytes } = drawFacade(f.spec, frame.len, b.height_m);
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      const mesh = faceMesh(shapeBy.get(b.id), f.edge, new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 })); // 有 cut 的面切成幾塊
      mesh.receiveShadow = true;
      mesh.userData.face = `${b.id}/${f.id}`;
      scene.add(mesh);
      faceMeshes.set(`${b.id}/${f.id}`, mesh);
      planes.push({ mesh, b: b.id, level: f.spec.inferred_from ? 'building' : 'observed', len: frame.len, bytes, ms });
      for (const e of f.spec.extras ?? []) if (e.type === 'stair-tower') { const st = stairTower(b, f, e, frame, b.height_m / b.floors); scene.add(st); (extrasBy.get(b.id) ?? extrasBy.set(b.id, []).get(b.id)).push(st); }
      const cost = specCost?.cost_usd ?? null;
      total.ms += ms; total.bytes += bytes; total.cost += cost ?? 0;
      const row = { key: `${b.id}/${f.id}`, b, f, ms, bytes, cost, score: null };
      rows.push(row);
      renderRows();
      $('now').innerHTML = `<div class="kv"><span class="step">① 貼立面</span> ${rows.length} 面</div><div class="name">${b.name} ${f.id}</div>
        <div class="kv">${f.spec.style}・${f.spec.floors} 層 × ${f.spec.bays} 組 × ${f.spec.window?.per_bay ?? 1} 扇・信心 ${f.spec.confidence ?? '-'}${f.spec.inferred_from ? `・推定自 ${f.spec.inferred_from}` : ''}</div>
        <div class="kv">畫圖 ${ms.toFixed(1)} ms・貼圖 ${canvas.width}×${canvas.height}(${(bytes / 1024 / 1024).toFixed(2)} MB)${cost != null ? `・規格約 $${cost.toFixed(3)}` : ''}</div>`;
      // 鏡頭轉到這一面前方
      const tgt = new THREE.Vector3(frame.mid[0], b.height_m * 0.45, frame.mid[1]);
      flyTo(tgt.clone().add(new THREE.Vector3(frame.n[0] * (frame.len + 25), b.height_m * 0.6 + 8, frame.n[1] * (frame.len + 25))), tgt);
      await sleep(PACE);
    }
  }
  for (const l of data.links) { const m = linkMesh(l); if (m) scene.add(m); }
  // 屋頂(有 roof.json 的):依規格畫,鏡頭拉高看俯視
  for (const b of withSpec) {
    if (roofs.has(b.id)) continue;
    const r = buildRoof(b, b.roof);
    scene.add(r.group);
    roofs.set(b.id, { level: b.roof ? 'observed' : 'default', ...r });
    const c = b.ring.reduce((a, p) => [a[0] + p[0] / b.ring.length, a[1] + p[1] / b.ring.length], [0, 0]);
    flyTo(new THREE.Vector3(c[0] - 25, b.height_m + 55, c[1] + 35), new THREE.Vector3(c[0], b.height_m, c[1]), 700);
    $('now').innerHTML = `<div class="kv"><span class="step">① 屋頂</span>(俯視截圖 → AI 規格 → 程式畫)</div><div class="name">${b.name}</div>
      <div class="kv">${b.roof ? `${b.roof.roof?.shape}・${b.roof.roof?.material}・構造 ${r.parts} 個・信心 ${b.roof.confidence ?? '-'}` : '沒有屋頂規格,用預設'}・畫圖 ${r.ms.toFixed(1)} ms${roofCost ? `・規格約 $${roofCost.toFixed(2)}` : ''}</div>`;
    await sleep(PACE * 2);
  }
  window.__tex = total;
  renderSum();
}

function renderRows() {
  $('faces').querySelector('tbody').innerHTML = rows.map((r) => `<tr><td>${r.b.name.slice(0, 4)} ${r.f.id.split('-')[0]}${r.f.spec.inferred_from ? '*' : ''}</td><td>${r.f.spec.style.replace('brick-', '磚').replace('concrete-grid', '清水模格柵').replace('window-grid', '窗格').replace('blank', '端牆').replace('stair-tower', '樓梯塔')}</td>
    <td>${r.f.spec.floors}×${r.f.spec.bays}</td><td>${r.cost != null ? r.cost.toFixed(3) : '-'}</td><td>${r.ms.toFixed(1)}ms</td><td>${(r.bytes / 1048576).toFixed(1)}MB</td><td>${r.score != null ? r.score.toFixed(0) : '-'}</td></tr>`).join('');
}
function renderSum() {
  const t = window.__tex, sc = rows.filter((r) => r.score != null);
  // 各來源的牆長、貼圖記憶體
  const by = {};
  for (const p of planes) { const o = (by[p.level] ??= { len: 0, bytes: 0, n: 0 }); o.len += p.len; o.bytes += p.bytes; o.n++; }
  const totalLen = Object.values(by).reduce((a, o) => a + o.len, 0), totalBytes = Object.values(by).reduce((a, o) => a + o.bytes, 0);
  const roofObs = [...roofs.values()].filter((r) => r.level === 'observed').length, roofDef = roofs.size - roofObs;
  $('legend').hidden = !planes.length;
  $('legend').innerHTML = planes.length ? `<div class="kv">牆面來源(依長度;共 ${planes.length} 片、貼圖 ${(totalBytes / 1048576).toFixed(0)} MB):</div>` + Object.keys(LEVELS).filter((k) => by[k]).map((k) =>
    `<div><span style="background:#${LEVELS[k][1].toString(16).padStart(6, '0')}"></span>${LEVELS[k][0]} ${by[k].len.toFixed(0)} m(${(by[k].len / totalLen * 100).toFixed(1)}%)</div>`).join('')
    + (roofs.size ? `<div class="kv" style="margin-top:4px">屋頂:依截圖規格 ${roofObs} 棟、預設 ${roofDef} 棟</div>` : '') : '';
  $('sum').innerHTML = [
    t ? `立面 <b>${rows.length}</b> 面:規格 <b>$${t.cost.toFixed(2)}</b>(AI)・畫圖 <b>${t.ms.toFixed(0)} ms</b>・貼圖 <b>${(t.bytes / 1048576).toFixed(1)} MB</b>` : '',
    tokens?.per_image ? `看圖描述(上一階段):每張 $${tokens.per_image.cost_usd.toFixed(2)}` : '',
    sc.length ? `比對平均分數 <b>${(sc.reduce((a, r) => a + r.score, 0) / sc.length).toFixed(0)}</b> / 100(顏色、結構各佔一半);只有白模時 ${(sc.reduce((a, r) => a + (r.baseline ?? 0), 0) / sc.length).toFixed(0)}` : '',
    '相機:用街景記錄的位置與朝向(使用者上傳的全景有誤差,會讓分數偏低)',
    '* 推定的面(沒有截圖)',
  ].filter(Boolean).join('<br>');
}

let fly = null;
function flyTo(pos, target, ms = 600) {
  fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, s: performance.now(), ms };
}

// ── ② 比對 ──
const local = (lon, lat) => {
  const o = data.origin;
  return [(lon - o.lon) * Math.cos((o.lat * Math.PI) / 180) * 111320, -(lat - o.lat) * 110540];
};
function poseCamera(cam, view, aspect) {
  const [x, z] = local(view.lon, view.lat), h = (view.heading * Math.PI) / 180, p = ((view.pitch ?? 0) * Math.PI) / 180;
  cam.fov = view.fov ?? 75; // 街景網址的 y 是垂直視角(已用實拍校正)
  cam.aspect = aspect;
  cam.near = 0.5;
  cam.updateProjectionMatrix();
  cam.position.set(x, EYE_M, z);
  cam.lookAt(x + Math.sin(h) * Math.cos(p), EYE_M + Math.sin(p), z - Math.cos(h) * Math.cos(p));
}
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
const cmpCam = new THREE.PerspectiveCamera();
let cmpState = null;

// 截圖上 Google 介面的區域(左上資訊卡與搜尋列、左下小地圖、右側按鈕、底部列)不算分
function uiMask(x, y, W, H) {
  return (x < 0.24 * W && y < 0.3 * H) || (x < 0.24 * W && y > 0.76 * H) || x > 0.9 * W || y > 0.94 * H;
}
function lab([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [f(r), f(g), f(b)], X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
}
// 結構相似度:兩張圖的邊緣強度縮成 1/4、模糊後,在遮罩內算相關係數(窗格、樓板線、輪廓對得越準越高;容許幾個像素的對位誤差)
function structure(Ls, Lr, M, W, H) {
  const k = 4, w = Math.floor(W / k), h = Math.floor(H / k);
  const grad = (L) => {
    const g = new Float32Array(w * h), c = new Float32Array(w * h);
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      if (!M[i]) continue;
      const j = Math.min(h - 1, (y / k) | 0) * w + Math.min(w - 1, (x / k) | 0);
      g[j] += Math.abs(L[i + 1] - L[i]) + Math.abs(L[i + W] - L[i]); c[j]++;
    }
    const b = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { // 3×3 模糊
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = (y + dy) * w + x + dx; if (c[j]) { s += g[j] / c[j]; n++; } }
      b[y * w + x] = n ? s / n : NaN;
    }
    return b;
  };
  const a = grad(Ls), b = grad(Lr);
  let sa = 0, sb = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (!isNaN(a[i]) && !isNaN(b[i])) { sa += a[i]; sb += b[i]; n++; }
  if (n < 30) return 0;
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) if (!isNaN(a[i]) && !isNaN(b[i])) { const p = a[i] - ma, q = b[i] - mb; cov += p * q; va += p * p; vb += q * q; }
  return va && vb ? cov / Math.sqrt(va * vb) : 0;
}

// (舊)沿 y(或 x)方向的邊緣強度剖面 → 週期;斜拍透視下不穩,已不列入分數
function period(L, M, W, H, axis) {
  const n = axis === 'y' ? H : W, prof = new Float64Array(n), cnt = new Float64Array(n);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const i = y * W + x;
    if (!M[i]) continue;
    const d = axis === 'y' ? Math.abs(L[i + W] - L[i]) : Math.abs(L[i + 1] - L[i]);
    const k = axis === 'y' ? y : x;
    prof[k] += d; cnt[k]++;
  }
  const idx = [...prof.keys()].filter((k) => cnt[k] > 3), raw = idx.map((k) => prof[k] / cnt[k]);
  if (raw.length < 24) return null;
  const vals = raw.map((_, i) => (raw[Math.max(0, i - 1)] + raw[i] + raw[Math.min(raw.length - 1, i + 1)]) / 3); // 平滑,去掉單像素雜訊
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length, v = vals.map((x) => x - mean), e0 = v.reduce((a, x) => a + x * x, 0) || 1;
  const ac = (lag) => { let s = 0; for (let i = 0; i + lag < v.length; i++) s += v[i] * v[i + lag]; return s / e0; };
  // 自相關先降到 0 以下,之後第一個夠明顯的峰值才是週期(最小的幾個 lag 只是雜訊或線條本身的寬度)
  let lag = 2;
  while (lag < v.length / 2 && ac(lag) > 0) lag++;
  let best = null;
  for (; lag < v.length / 2; lag++) {
    const r = ac(lag);
    if (r > 0.1 && r >= ac(lag - 1) && r >= ac(lag + 1)) { best = lag; break; }
  }
  return best;
}
function scoreImages(shot, rend, mask, W, H) {
  const M = new Uint8Array(W * H), Ls = new Float32Array(W * H), Lr = new Float32Array(W * H);
  let n = 0, cs = [0, 0, 0], cr = [0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = i * 4;
    if (mask[j] < 128 || uiMask(x, y, W, H)) continue;
    M[i] = 1; n++;
    const a = lab([shot[j], shot[j + 1], shot[j + 2]]), b = lab([rend[j], rend[j + 1], rend[j + 2]]);
    for (let k = 0; k < 3; k++) { cs[k] += a[k]; cr[k] += b[k]; }
    Ls[i] = a[0]; Lr[i] = b[0];
  }
  if (n < 400) return null;
  const dE = Math.hypot(...cs.map((v, k) => v / n - cr[k] / n));
  // 結構只比牆面內部:遮罩往內縮 8 px,去掉建築外輪廓(那條邊白模也有,會讓分數分不出有沒有貼圖)
  const ER = 8, inner = new Uint8Array(W * H);
  for (let y = ER; y < H - ER; y++) for (let x = ER; x < W - ER; x++) {
    const i = y * W + x;
    if (M[i] && M[i - ER] && M[i + ER] && M[i - ER * W] && M[i + ER * W] && M[i - ER - ER * W] && M[i + ER + ER * W] && M[i + ER - ER * W] && M[i - ER + ER * W]) inner[i] = 1;
  }
  const struct = structure(Ls, Lr, inner, W, H);
  const colorS = Math.max(0, 1 - dE / 50), structS = Math.max(0, Math.min(1, struct / 0.5)); // 相關 0.5 以上算滿分
  return { dE, structure: struct, pixels: n, colorScore: colorS * 100, structScore: structS * 100, score: 50 * colorS + 50 * structS };
}

const RW = 480;
// 在某個相機視角下渲染:貼圖後的畫面、這一面的遮罩、只有白模的畫面
function renderAt(row, view, aspect, RH, withClay) {
  poseCamera(cmpCam, view, aspect);
  const rt = new THREE.WebGLRenderTarget(RW, RH, { colorSpace: THREE.SRGBColorSpace });
  const grab = () => { renderer.setRenderTarget(rt); renderer.render(scene, cmpCam); const px = new Uint8Array(RW * RH * 4); renderer.readRenderTargetPixels(rt, 0, 0, RW, RH, px); renderer.setRenderTarget(null); return flipY(px, RW, RH); };
  const rend = grab();
  // 遮罩:只有這一面是白、其他都黑(被別的東西擋住的部分自然不算)
  const saved = [], fm = faceMeshes.get(row.key);
  scene.traverse((o) => { if (o.isMesh) { saved.push([o, o.material]); o.material = o === fm ? MASK_W : MASK_B; } });
  const bg = scene.background; scene.background = new THREE.Color(0);
  const mask = grab();
  for (const [o, m] of saved) o.material = m;
  scene.background = bg;
  let clayRend = null;
  if (withClay) { const keep = fm.material; fm.material = clay; clayRend = grab(); fm.material = keep; } // 對照組:這一面換回白模
  rt.dispose();
  return { rend, mask, clayRend };
}
const MASK_W = new THREE.MeshBasicMaterial({ color: 0xffffff }), MASK_B = new THREE.MeshBasicMaterial({ color: 0x000000 });
function shifted(view, dx, dz, dh) {
  const lat = view.lat - dz / 110540, lon = view.lon + dx / (Math.cos((view.lat * Math.PI) / 180) * 111320);
  return { ...view, lat, lon, heading: (view.heading + dh + 360) % 360 };
}

async function measure(row, cap, img) {
  const aspect = img.naturalWidth / img.naturalHeight, RH = Math.round(RW / aspect);
  const c2 = Object.assign(document.createElement('canvas'), { width: RW, height: RH }), x2 = c2.getContext('2d');
  x2.drawImage(img, 0, 0, RW, RH);
  const shot = x2.getImageData(0, 0, RW, RH).data;
  const evalAt = (v) => { const r = renderAt(row, v, aspect, RH, false); return scoreImages(shot, r.rend, r.mask, RW, RH); };
  // 原始(記錄的)位置
  const raw = evalAt(cap.view);
  // 自動對位:街景記錄的位置與朝向有誤差(使用者上傳的全景尤其明顯),在 ±4 m、±24° 內找結構最吻合的相機
  let best = { s: raw, v: cap.view, dx: 0, dz: 0, dh: 0 };
  if (ALIGN) for (const [dx, dz] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) {
    for (let dh = -24; dh <= 24; dh += 6) {
      const v = shifted(cap.view, dx, dz, dh), sc = evalAt(v);
      if (sc && (!best.s || sc.structScore > best.s.structScore + 0.5)) best = { s: sc, v, dx, dz, dh };
    }
  }
  if (ALIGN) for (const dh of [-3, 3]) { // 朝向再細調
    const v = shifted(cap.view, best.dx, best.dz, best.dh + dh), sc = evalAt(v);
    if (sc && sc.structScore > best.s.structScore + 0.5) best = { s: sc, v, dx: best.dx, dz: best.dz, dh: best.dh + dh };
  }
  // 校正後的位置:貼圖版與白模對照組用同一個相機
  const fin = renderAt(row, best.v, aspect, RH, true);
  const s = scoreImages(shot, fin.rend, fin.mask, RW, RH), base = scoreImages(shot, fin.clayRend, fin.mask, RW, RH);
  return s && { ...s, raw: raw?.score ?? null, baseline: base?.score ?? null, view: best.v, align: { dx: best.dx, dz: best.dz, dh: best.dh } };
}
function flipY(px, W, H) {
  const out = new Uint8Array(px.length), row = W * 4;
  for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  return out;
}

async function compare() {
  $('cmp').style.display = 'block';
  const results = [];
  for (const row of rows) {
    const pickId = row.f.cmp ?? row.f.spec.rep, cap = row.f.captures.find((c) => c.id === pickId) ?? row.f.captures[0]; // 比對用橫向、覆蓋最好的那張
    if (!cap || row.f.spec.inferred_from) continue;
    const img = await loadImg(cap.png).catch(() => null); // 截圖不隨交接資料夾提供(Google 條款),沒有就跳過這一面
    if (!img) continue;
    const aspect = img.naturalWidth / img.naturalHeight;
    // 版面:HUD 右邊的空間分左右兩半
    const x0 = 420, availW = innerWidth - x0 - 20, w = Math.floor(availW / 2) - 8, h = Math.round(w / aspect), y = Math.round((innerHeight - h) / 2);
    Object.assign($('shot').style, { left: `${x0}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    $('shot').src = img.src;
    Object.assign($('capL').style, { left: `${x0}px`, top: `${y - 30}px` });
    Object.assign($('capR').style, { left: `${x0 + w + 16}px`, top: `${y - 30}px` });
    Object.assign($('veil').style, { left: `${x0 + w + 16}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    cmpState = { cap, aspect, rect: { x: x0 + w + 16, y, w, h } };
    const s = await measure(row, cap, img);
    if (s?.view) cmpState = { ...cmpState, cap: { ...cap, view: s.view } }; // 並排畫面用校正後的相機
    row.score = s?.score ?? null;
    row.baseline = s?.baseline ?? null;
    results.push({ face: row.key, capture: cap.id, ...s });
    renderRows();
    renderSum();
    window.__cmpStep = results.length;
    $('now').innerHTML = `<div class="kv"><span class="step">② 比對</span> ${results.length} 面</div><div class="name">${row.b.name} ${row.f.id}</div>
      <div class="kv">截圖 ${cap.id}・分數 <b>${s ? s.score.toFixed(0) : '-'}</b>${s?.baseline != null ? `(只有白模 ${s.baseline.toFixed(0)})` : ''}</div>
      <div class="kv">${ALIGN && s?.align ? `自動對位:朝向 ${s.align.dh >= 0 ? '+' : ''}${s.align.dh}°、位置偏移 ${Math.hypot(s.align.dx, s.align.dz).toFixed(0)} m(對位前 ${s.raw != null ? s.raw.toFixed(0) : '-'} 分)` : ''}</div>
      <div class="kv">${s ? `顏色 ${s.colorScore.toFixed(0)} 分(ΔE ${s.dE.toFixed(1)})・結構 ${s.structScore.toFixed(0)} 分(相關 ${s.structure.toFixed(2)})` : '可比對的像素太少(大多被擋住或在畫面外)'}</div>`;
    await sleep(HOLD);
  }
  cmpState = null;
  $('cmp').style.display = 'none';
  window.__cmp = results;
  return results;
}

// ── ③ 打包 + 8.5 效能檢查 ──
const CHECK = { callsPerBuilding: 2, textureMB: 64, fps: 30, diff: 6 }; // 門檻(暫定)
function countCalls() {
  const sh = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false; // 只算主畫面的繪製次數(陰影另外畫)
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.render(scene, camera);
  const calls = renderer.info.render.calls, tris = renderer.info.render.triangles;
  renderer.shadowMap.enabled = sh;
  return { calls, tris };
}
async function measureFps(ms = 2000) {
  let n = 0;
  const t0 = performance.now();
  await new Promise((done) => { const tick = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(tick) : done(); }; requestAnimationFrame(tick); });
  return n / ((performance.now() - t0) / 1000);
}
// 固定幾個視角渲染成像素,打包前後比對(畫面差異 = 平均每個顏色通道差多少,0–255)
const SNAP_W = 400, SNAP_H = 225;
function snapshots() {
  const views = [{ pos: new THREE.Vector3(focus.x - 260, 300, focus.z + 330), tgt: new THREE.Vector3(focus.x + 120, 0, focus.z - 60) }, { pos: new THREE.Vector3(focus.x - 70, 70, focus.z + 95), tgt: focus.clone() }, { pos: new THREE.Vector3(focus.x + 60, 40, focus.z - 60), tgt: focus.clone() }];
  const cam = new THREE.PerspectiveCamera(45, SNAP_W / SNAP_H, 0.5, 5000), rt = new THREE.WebGLRenderTarget(SNAP_W, SNAP_H, { colorSpace: THREE.SRGBColorSpace });
  const out = views.map((v) => {
    cam.position.copy(v.pos); cam.lookAt(v.tgt);
    renderer.setRenderTarget(rt); renderer.render(scene, cam);
    const px = new Uint8Array(SNAP_W * SNAP_H * 4); renderer.readRenderTargetPixels(rt, 0, 0, SNAP_W, SNAP_H, px);
    return px;
  });
  renderer.setRenderTarget(null); rt.dispose();
  return out;
}
const packed = new Map();
async function packAll() {
  if (showSrc) toggleSource(false);
  $('srcBtn').disabled = true; // 打包後各面已合併,不能再切換來源顯示
  const before = { ...countCalls(), fps: await measureFps(1500), snaps: snapshots() };
  // 貼圖預算:全校區 ≤ 門檻的 92%。有實拍的建築先保留原解析度,其餘等比縮小到放得進剩下的預算
  const texOf = (id) => { const ms = planes.filter((p) => p.b === id).map((p) => p.mesh); roofs.get(id)?.group.traverse((o) => o.isMesh && o.material.map && ms.push(o)); return ms; };
  const areaOf = (id) => texOf(id).reduce((a, m) => a + m.material.map.image.width * m.material.map.image.height, 0);
  const isObs = (b) => b.faces.some((f) => f.spec);
  const budgetPx = (CHECK.textureMB * 0.92 * 1048576) / (16 / 3) / 1.25; // ÷ 每像素 4 bytes × mipmap 4/3;÷1.25 留排列空隙
  const aObs = data.buildings.filter(isObs).reduce((a, b) => a + areaOf(b.id), 0), aRest = data.buildings.filter((b) => !isObs(b)).reduce((a, b) => a + areaOf(b.id), 0);
  const sObs = Math.min(1, Math.sqrt((budgetPx * 0.7) / Math.max(1, aObs))), sRest = Math.min(1, Math.sqrt(Math.max(0, budgetPx - aObs * sObs * sObs) / Math.max(1, aRest)));
  let bytes = 0, inputs = 0;
  for (const [i, b] of data.buildings.entries()) {
    const roof = roofs.get(b.id);
    const textured = planes.filter((p) => p.b === b.id).map((p) => p.mesh), plain = [massBy.get(b.id)];
    roof?.group.traverse((o) => { if (o.isMesh) (o.material.map ? textured : plain).push(o); });
    for (const g of extrasBy.get(b.id) ?? []) g.traverse((o) => o.isMesh && plain.push(o));
    const r = packBuilding(textured, plain, 4096, isObs(b) ? sObs : sRest);
    for (const m of [...textured, ...plain]) m.removeFromParent();
    roof?.group.removeFromParent();
    for (const g of extrasBy.get(b.id) ?? []) g.removeFromParent();
    scene.add(r.group);
    packed.set(b.id, r);
    bytes += r.bytes; inputs += r.inputs;
    $('now').innerHTML = `<div class="kv"><span class="step">③ 打包</span> 第 ${i + 1} / ${data.buildings.length} 棟</div><div class="name">${b.name}</div>
      <div class="kv">${r.inputs} 個零件 → 2 個模型・貼圖集 ${r.atlas}${r.scale < 1 ? `(縮成 ${(r.scale * 100).toFixed(0)}%)` : ''}・${r.ms.toFixed(0)} ms</div>`;
    await sleep(40);
  }
  await sleep(300);
  const after = { ...countCalls(), fps: await measureFps(2000), snaps: snapshots() };
  let diff = 0, n = 0;
  after.snaps.forEach((px, k) => { const p0 = before.snaps[k]; for (let i = 0; i < px.length; i += 4) { diff += Math.abs(px[i] - p0[i]) + Math.abs(px[i + 1] - p0[i + 1]) + Math.abs(px[i + 2] - p0[i + 2]); n += 3; } });
  diff /= n;
  const nb = data.buildings.length, linkCalls = data.links.length, extraCalls = 2 + (window.__site?.calls ?? 0); // 地面、校區線、場地
  const callsPerB = (after.calls - linkCalls - extraCalls) / nb;
  const res = {
    before: { calls: before.calls, tris: before.tris, fps: before.fps }, after: { calls: after.calls, tris: after.tris, fps: after.fps },
    inputs, textureMB: bytes / 1048576, callsPerBuilding: callsPerB, diff,
    scale: { observed: sObs, rest: sRest },
    atlases: [...packed].map(([id, r]) => [id, r.atlas, +r.scale.toFixed(2), +(r.bytes / 1048576).toFixed(2), r.fill]),
    pass: { calls: callsPerB <= CHECK.callsPerBuilding, texture: bytes / 1048576 <= CHECK.textureMB, fps: after.fps >= CHECK.fps, diff: diff <= CHECK.diff },
  };
  window.__pack = res;
  const ok = (v) => (v ? '✅' : '❌');
  $('now').innerHTML = `<div class="kv"><span class="step">8.5 效能檢查</span>(門檻暫定)</div>
    <table><thead><tr><th>項目(門檻)</th><th>打包前</th><th>打包後</th></tr></thead><tbody>
    <tr><td>${ok(res.pass.calls)} draw call(每棟 ≤ ${CHECK.callsPerBuilding})</td><td>${before.calls}</td><td>${after.calls}(${callsPerB.toFixed(1)}/棟)</td></tr>
    <tr><td>${ok(res.pass.texture)} 貼圖記憶體(≤ ${CHECK.textureMB} MB)</td><td>—</td><td>${res.textureMB.toFixed(0)} MB</td></tr>
    <tr><td>　 三角形</td><td>${before.tris.toLocaleString()}</td><td>${after.tris.toLocaleString()}</td></tr>
    <tr><td>${ok(res.pass.fps)} FPS(≥ ${CHECK.fps},要在手機上量)</td><td>${before.fps.toFixed(0)}</td><td>${after.fps.toFixed(0)}</td></tr>
    <tr><td>${ok(res.pass.diff)} 畫面差異(≤ ${CHECK.diff})</td><td colspan="2">${diff.toFixed(2)} / 255</td></tr>
    </tbody></table><div class="kv" style="margin-top:6px">貼圖預算:有實拍的建築保留 ${(sObs * 100).toFixed(0)}%、其他縮成 ${(sRest * 100).toFixed(0)}% 解析度</div><div class="kv">${inputs} 個零件 → ${packed.size * 2} 個模型;${Object.values(res.pass).every(Boolean) ? '全部通過,可以發布' : '有項目沒通過,不發布'}</div>`;
  return res;
}
// 匯出每棟打包好的模型(glb,base64);錄影腳本存成 buildings/<編號>/model/v1.glb
window.__exportGLB = async () => {
  const ex = new GLTFExporter(), out = {};
  for (const [id, r] of packed) {
    const buf = await ex.parseAsync(r.group, { binary: true });
    let s = '';
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    out[id] = btoa(s);
  }
  return out;
};

const busy = (on) => ['runAll', 'runTex', 'runCmp', 'runPack'].forEach((id) => ($(id).disabled = on));
$('runPack').onclick = async () => { busy(true); if (!rows.length) await texturize(); if (!window.__rest) await fillRest(); await addSite(); await packAll(); busy(false); };
$('srcBtn').onclick = () => toggleSource();
$('groundBtn').onclick = () => toggleGround();
$('runTex').onclick = async () => { busy(true); await texturize(); await fillRest(); busy(false); };
$('runCmp').onclick = async () => { busy(true); if (!rows.length) await texturize(); await compare(); busy(false); };
$('runAll').onclick = async () => {
  busy(true);
  await sleep(800);
  await texturize();
  await sleep(1000);
  await compare();
  await fillRest();          // 其他牆面依規則推定
  await addSite();           // ④ 場地(預設路面)
  toggleGround(false);       // 換成中性地面,看不靠正射影像的樣子
  await sleep(3000);
  toggleGround(true);
  await sleep(2500);
  toggleSource(true);        // 顯示每面的來源
  await sleep(3500);
  toggleSource(false);
  await sleep(800);
  await packAll();           // ③ 打包 + 8.5 效能檢查
  await sleep(5000);
  busy(false);
  window.__done = true;
};

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => {
  nav.update();
  if (fly) {
    const k = Math.min(1, (performance.now() - fly.s) / fly.ms), e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(fly.p0, fly.p1, e);
    controls.target.lerpVectors(fly.t0, fly.t1, e);
    if (k >= 1) fly = null;
  }
  controls.update();
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.render(scene, camera);
  if (cmpState) { // 右半邊:用截圖的相機畫一次
    const { rect, cap, aspect } = cmpState;
    poseCamera(cmpCam, cap.view, aspect);
    const vy = innerHeight - rect.y - rect.h;
    renderer.setScissorTest(true);
    renderer.setScissor(rect.x, vy, rect.w, rect.h);
    renderer.setViewport(rect.x, vy, rect.w, rect.h);
    renderer.render(scene, cmpCam);
    renderer.setScissorTest(false);
  }
});
window.__ready = true;
if (params.get('run') === 'all') $('runAll').click();
