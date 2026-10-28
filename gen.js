// 建築生成畫面:讀 data.json,用兩種方法一棟一棟生成白模,量時間、三角形、draw call,最後並排比較。
//   A 整體拉高:輪廓 × 總高度一次擠出(ExtrudeGeometry)
//   B 逐層堆疊:每層一片樓板 + 沿輪廓每條邊一道牆(BoxGeometry),疊 N 層後合併成一個 mesh
// 只生成形狀;貼圖是之後依截圖描述另外畫的階段。
// 網址參數:?run=A|B|AB 自動開始;&pace=毫秒(每棟之間的停頓,只影響畫面,不算進生成時間)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { addNav } from './nav.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PACE = +(params.get('pace') ?? 180);
const SLAB = 0.2, WALL = 0.25;
const COLOR = { A: 0xf0b44c, B: 0x5fb3f0 };

const data = await (await fetch('data.json')).json();
$('credit').textContent = data.ground.credit;
// 流程效率:② AI 看圖描述的實測用量(tools/token_log.py 匯總);④ 生成是純程式,不用 token
const tokens = await fetch('tokens.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
const shots = data.buildings.reduce((a, b) => a + b.photos, 0), shotBuildings = data.buildings.filter((b) => b.photos).length;
const pi = tokens?.per_image;
$('pipe').innerHTML = [
  pi ? `② 描述(AI 看圖):每張 <b>$${pi.cost_usd.toFixed(2)}</b>・輸出約 <b>${pi.output_tokens.toLocaleString()}</b> token・約 ${pi.seconds} 秒(實測 ${tokens.images} 張)` : '② 描述(AI 看圖):尚未實測',
  `目前 ${shotBuildings} 棟有截圖、共 ${shots} 張(平均每棟 ${shotBuildings ? (shots / shotBuildings).toFixed(0) : 0} 張)`,
  '④ 生成(程式):<b>0 token</b>,只花計算時間(見下方)',
].join('<br>');

// ── 場景 ──
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-180, 320, 140);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -400, right: 400, top: 400, bottom: -400, far: 1200 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6; // 消除牆面上的陰影條紋(shadow acne)
scene.add(sun);

// 底圖(正射影像)與校區範圍
const g = data.ground;
const tex = g.image ? new THREE.TextureLoader().load(g.image) : null; // 公開版沒有正射底圖(授權未確認),用中性地面
if (tex) tex.colorSpace = THREE.SRGBColorSpace;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(g.x1 - g.x0, g.z1 - g.z0), new THREE.MeshStandardMaterial({ map: tex, roughness: 1, color: tex ? 0xb8b8b8 : 0x8f9a84 }));
ground.rotation.x = -Math.PI / 2;
ground.position.set((g.x0 + g.x1) / 2, 0, (g.z0 + g.z1) / 2);
ground.receiveShadow = true;
scene.add(ground);
const bpts = data.boundary.map(([x, z]) => new THREE.Vector3(x, 0.3, z));
scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(bpts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })));
const center = bpts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / bpts.length);
controls.target.copy(center);
camera.position.set(center.x - 260, 300, center.z + 330);
const nav = addNav({ camera, controls, renderer, scene, buildings: data.buildings });

// ── 兩種生成方法 ──
function shapeOf(ring) {
  // 場景 z 往南;Shape 在 xy 平面,擠出後繞 x 轉 -90°:shape 的 y 會變成 -z,所以 y 用 -z
  const s = new THREE.Shape();
  ring.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)));
  return s;
}
const extrude = (ring, depth, y0 = 0) => new THREE.ExtrudeGeometry(shapeOf(ring), { depth, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0);

function buildA(b) {
  return { geo: extrude(b.ring, b.height_m), parts: 1 };
}

function buildB(b) {
  const fh = b.height_m / b.floors, parts = [];
  const cx = b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length, cz = b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length;
  for (let f = 0; f < b.floors; f++) {
    const y = f * fh;
    parts.push(extrude(b.ring, SLAB, y)); // 樓板
    b.ring.forEach(([x1, z1], i) => {     // 牆:每條邊一道,往內退半個牆厚
      const [x2, z2] = b.ring[(i + 1) % b.ring.length], len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.3) return;
      const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2, nx = cx - mx, nz = cz - mz, nl = Math.hypot(nx, nz) || 1;
      const w = new THREE.BoxGeometry(len, fh - SLAB, WALL);
      w.rotateY(-Math.atan2(z2 - z1, x2 - x1));
      w.translate(mx + (nx / nl) * WALL / 2, y + SLAB + (fh - SLAB) / 2, mz + (nz / nl) * WALL / 2);
      parts.push(w);
    });
  }
  parts.push(extrude(b.ring, SLAB, b.height_m - SLAB)); // 屋頂
  const geo = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  parts.forEach((p) => p.dispose());
  return { geo, parts: parts.length };
}

// 連接構件(links.json):兩面之間最近的兩點拉一座橋,放在指定樓層
function linkGeo(link) {
  const ends = [link.from, link.to].map((e) => {
    const b = data.buildings.find((x) => x.id === e.building), f = b?.faces.find((x) => x.id === e.face);
    return b && f ? [b.ring[f.edge], b.ring[(f.edge + 1) % b.ring.length], b] : null;
  });
  if (ends.some((e) => !e)) return null;
  let best = null;
  const [[a1, a2], [b1, b2]] = ends;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const p = [a1[0] + (a2[0] - a1[0]) * i / 20, a1[1] + (a2[1] - a1[1]) * i / 20], q = [b1[0] + (b2[0] - b1[0]) * j / 20, b1[1] + (b2[1] - b1[1]) * j / 20];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || d < best.d) best = { p, q, d };
  }
  const fh = ends[0][2].height_m / ends[0][2].floors, y = (link.level - 1) * fh;
  const geo = new THREE.BoxGeometry(best.d + 1, fh, 3);
  geo.rotateY(-Math.atan2(best.q[1] - best.p[1], best.q[0] - best.p[0]));
  geo.translate((best.p[0] + best.q[0]) / 2, y + fh / 2, (best.p[1] + best.q[1]) / 2);
  return geo;
}

// ── 生成流程 ──
const groups = { A: new THREE.Group(), B: new THREE.Group() };
scene.add(groups.A, groups.B);
const results = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rising = [];
let labelTarget = null;

// 從計網中心開始,依距離往外
const order = [...data.buildings].sort((p, q) => {
  const c = (b) => b.ring.reduce((a, r) => [a[0] + r[0] / b.ring.length, a[1] + r[1] / b.ring.length], [0, 0]);
  const [px, pz] = c(p), [qx, qz] = c(q);
  return Math.hypot(px, pz) - Math.hypot(qx, qz);
});

function clear(method) {
  for (const m of [...groups[method].children]) { m.geometry.dispose(); groups[method].remove(m); }
}

async function run(method) {
  for (const k of ['A', 'B']) groups[k].visible = k === method;
  clear(method);
  const mat = new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.85 });
  const matPhoto = new THREE.MeshStandardMaterial({ color: 0xf1dcc0, roughness: 0.85 }); // 有截圖的建築
  const r = { method, buildings: 0, genMs: 0, tris: 0, verts: 0, partsUnmerged: 0, perBuilding: [] };
  const tStart = performance.now();
  for (const [i, b] of order.entries()) {
    const t0 = performance.now();
    const { geo, parts } = method === 'A' ? buildA(b) : buildB(b);
    const ms = performance.now() - t0;
    const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    const mesh = new THREE.Mesh(geo, b.photos ? matPhoto : mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.scale.y = 0.001;
    mesh.userData = { b };
    groups[method].add(mesh);
    rising.push({ mesh, t: performance.now() });
    r.buildings++; r.genMs += ms; r.tris += tris; r.verts += geo.attributes.position.count; r.partsUnmerged += parts;
    r.perBuilding.push({ name: b.name, floors: b.floors, ms: +ms.toFixed(2), tris });
    labelTarget = { mesh, text: b.name };
    $('now').innerHTML = `<div class="kv"><span class="tag ${method}">${method}</span> 第 ${i + 1} / ${order.length} 棟</div>
      <div class="name">${b.name}</div>
      <div class="kv">${b.floors} 層(${b.floors_src})・高 ${b.height_m} m${b.photos ? `・截圖 ${b.photos} 張` : ''}</div>
      <div class="kv">生成 ${ms.toFixed(2)} ms・${tris.toLocaleString()} 個三角形${method === 'B' ? `・${parts} 個零件合併` : ''}</div>
      <div class="bar"><div style="width:${((i + 1) / order.length) * 100}%;background:${method === 'A' ? 'var(--a)' : 'var(--b)'}"></div></div>`;
    await sleep(PACE);
  }
  // 連接構件
  for (const link of data.links) {
    const geo = linkGeo(link);
    if (!geo) continue;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8785a, roughness: 0.8 }));
    m.castShadow = true;
    groups[method].add(m);
    r.tris += geo.index.count / 3;
  }
  r.wallMs = performance.now() - tStart;
  await sleep(800);
  // 量 2 秒的 FPS 與 draw call
  let frames = 0;
  const f0 = performance.now();
  await new Promise((done) => { const tick = () => { frames++; performance.now() - f0 < 2000 ? requestAnimationFrame(tick) : done(); }; requestAnimationFrame(tick); });
  r.fps = frames / ((performance.now() - f0) / 1000);
  renderer.render(scene, camera);
  r.drawCalls = renderer.info.render.calls;
  r.geometries = renderer.info.memory.geometries;
  results[method] = r;
  labelTarget = null;
  showResults();
  return r;
}

function showResults() {
  const A = results.A, B = results.B, rows = [
    ['生成時間(總計)', (r) => `${r.genMs.toFixed(1)} ms`],
    ['平均每棟', (r) => `${(r.genMs / r.buildings).toFixed(2)} ms`],
    ['三角形', (r) => r.tris.toLocaleString()],
    ['頂點', (r) => r.verts.toLocaleString()],
    ['零件數(合併前)', (r) => r.partsUnmerged.toLocaleString()],
    ['draw call(合併後)', (r) => r.drawCalls],
    ['FPS(本機)', (r) => r.fps.toFixed(0)],
    ['AI token', () => '0'],
  ];
  $('result').hidden = false;
  $('result').querySelector('tbody').innerHTML = rows.map(([k, f]) => `<tr><td>${k}</td><td>${A ? f(A) : '—'}</td><td>${B ? f(B) : '—'}</td></tr>`).join('');
  $('note').innerHTML = A && B
    ? `B 的三角形是 A 的 <b>${(B.tris / A.tris).toFixed(1)} 倍</b>、生成時間 <b>${(B.genMs / A.genMs).toFixed(1)} 倍</b>;沒合併的話 B 每格要畫 ${B.partsUnmerged.toLocaleString()} 次(A 只要 ${A.partsUnmerged})。`
    : '';
  window.__results = results;
}

const busy = (on) => ['runA', 'runB', 'runAB'].forEach((id) => ($(id).disabled = on));
$('runA').onclick = async () => { busy(true); await run('A'); busy(false); };
$('runB').onclick = async () => { busy(true); await run('B'); busy(false); };
$('runAB').onclick = async () => { busy(true); await run('A'); await sleep(1500); await run('B'); busy(false); window.__done = true; };

// ── 畫面更新 ──
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
const v = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  for (let i = rising.length - 1; i >= 0; i--) {
    const k = Math.min(1, (now - rising[i].t) / 260);
    rising[i].mesh.scale.y = 1 - (1 - k) ** 3;
    if (k >= 1) rising.splice(i, 1);
  }
  nav.update();
  controls.update();
  renderer.render(scene, camera);
  if (labelTarget) {
    const bb = new THREE.Box3().setFromObject(labelTarget.mesh);
    bb.getCenter(v).setY(bb.max.y);
    v.project(camera);
    Object.assign($('label').style, { display: 'block', left: `${(v.x * 0.5 + 0.5) * innerWidth}px`, top: `${(-v.y * 0.5 + 0.5) * innerHeight}px` });
    $('label').textContent = labelTarget.text;
  } else $('label').style.display = 'none';
});

window.__ready = true;
const auto = params.get('run');
if (auto === 'A') $('runA').click();
else if (auto === 'B') $('runB').click();
else if (auto === 'AB') $('runAB').click();
