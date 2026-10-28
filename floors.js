// 樓層工具與挖空的測試頁:計網中心、理化實驗大樓用 shape.js 建(A + cuts)、打包,再加樓層著色器。
// 點牆 → 那層高亮;剖切 → 那層以上不畫、切口蓋樓板;爆炸圖 → 同一份幾何畫 N 次,每次只留一層。
// 網址參數:?run=test 自動跑完,量三角形、draw call、點選準確度(結果放在 window.__pack,給錄影腳本讀)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildRoof } from './roof.js';
import { packBuilding } from './pack.js';
import { buildShaped, edgeFrame, floorUniforms, patchFloors, slabGeometry, slabMaterial } from './shape.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = ['NCKU-CC', 'NCKU-PC'];
const GAP = 4; // 爆炸圖每層拉開幾公尺
const SETBACK = { from_floor: 6, inset_m: 2.5 }; // 示範用(資料裡沒有退縮的建築)

const data = await (await fetch('data.json', { cache: 'no-cache' })).json(); // 資料常重新匯出,不用快取
$('credit').textContent = data.ground.credit;
const byId = new Map(data.buildings.map((b) => [b.id, b]));

// ── 場景 ──
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
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
Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 200, bottom: -200, far: 1000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun);
const g = data.ground, gtex = g.image ? new THREE.TextureLoader().load(g.image) : null; // 公開版沒有正射底圖,用中性地面
if (gtex) gtex.colorSpace = THREE.SRGBColorSpace;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(g.x1 - g.x0, g.z1 - g.z0), new THREE.MeshStandardMaterial({ map: gtex, roughness: 1, color: gtex ? 0xb0b0b0 : 0x8f9a84 }));
ground.rotation.x = -Math.PI / 2;
ground.position.set((g.x0 + g.x1) / 2, 0, (g.z0 + g.z1) / 2);
ground.receiveShadow = true;
scene.add(ground);

// 其他建築:白模合成一個 mesh(只當背景)
const shapeOf = (ring) => { const s = new THREE.Shape(); ring.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z))); return s; };
const ctx = new THREE.Mesh(mergeGeometries(data.buildings.filter((b) => !TEST.includes(b.id)).map((b) => new THREE.ExtrudeGeometry(shapeOf(b.ring), { depth: b.height_m, bevelEnabled: false }).rotateX(-Math.PI / 2).toNonIndexed())),
  new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.85 }));
ctx.castShadow = ctx.receiveShadow = true;
scene.add(ctx);

// 連接橋(links.json):跟 texture.js 一樣,兩面最近兩點拉一座
function linkMesh(link) {
  const ends = [link.from, link.to].map((e) => { const b = byId.get(e.building), f = b?.faces.find((x) => x.id === e.face); return b && f ? [b.ring[f.edge], b.ring[(f.edge + 1) % b.ring.length], b] : null; });
  if (ends.some((e) => !e)) return null;
  let best = null;
  const [[a1, a2], [b1, b2]] = ends;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const p = [a1[0] + (a2[0] - a1[0]) * i / 20, a1[1] + (a2[1] - a1[1]) * i / 20], q = [b1[0] + (b2[0] - b1[0]) * j / 20, b1[1] + (b2[1] - b1[1]) * j / 20], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || d < best.d) best = { p, q, d };
  }
  const fh = ends[0][2].height_m / ends[0][2].floors, y = (link.level - 1) * fh, geo = new THREE.BoxGeometry(best.d + 1, fh, 3);
  geo.rotateY(-Math.atan2(best.q[1] - best.p[1], best.q[0] - best.p[0]));
  geo.translate((best.p[0] + best.q[0]) / 2, y + fh / 2, (best.p[1] + best.q[1]) / 2);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xa4503a, roughness: 0.85 }));
  m.castShadow = true;
  scene.add(m);
  return m;
}
data.links.forEach(linkMesh);

// ── 測試建築:shape.js 建 → 打包(每棟 2 個 draw call)→ 材質加樓層著色器 ──
const B = new Map(); // id → { b, L, u, shaped, group, tris, slices, cap }
function build(id, opts) {
  const old = B.get(id);
  if (old) { unexplode(id); old.group.removeFromParent(); old.cap?.removeFromParent(); }
  const b = byId.get(id), s = buildShaped(b, opts), roof = buildRoof({ ...b, ring: s.topRing }, b.roof);
  const textured = [...s.textured], plain = [...s.plain];
  roof.group.traverse((o) => { if (o.isMesh) (o.material.map ? textured : plain).push(o); });
  const r = packBuilding(textured, plain);
  const u = old?.u ?? floorUniforms(s.L);
  Object.assign(u.uG, { value: s.L.g }); Object.assign(u.uT, { value: s.L.typ }); Object.assign(u.uN, { value: s.L.n });
  r.group.traverse((o) => { if (o.isMesh) { patchFloors(o.material, u); o.userData.bid = id; } });
  scene.add(r.group);
  const st = { b, L: s.L, u, shaped: s, group: r.group, tris: r.tris, bands: s.bands, pieces: s.pieces, opts, slices: null, cap: null };
  B.set(id, st);
  if (sel?.id === id && clipOn) clip(id, sel.floor);
  return st;
}
let cutsOn = true, clipOn = false, setbackOn = false, sel = null;
const optsOf = (id) => ({ cuts: cutsOn, setback: setbackOn && id === 'NCKU-PC' ? SETBACK : null });
for (const id of TEST) build(id, optsOf(id));

// 剖切:選到的那層以上不畫(著色器丟掉像素),切口蓋一片照那個高度輪廓的樓板
const slabMat = slabMaterial();
function clip(id, floor) {
  const st = B.get(id);
  st.cap?.removeFromParent();
  st.u.uCut.value = st.L.top(floor);
  st.cap = new THREE.Mesh(slabGeometry(st.shaped.ringAt(st.L.top(floor) - 0.01), st.L.top(floor)), slabMat);
  st.cap.userData.bid = id;
  scene.add(st.cap);
}
function unclip(id) { const st = B.get(id); st.u.uCut.value = 1e5; st.cap?.removeFromParent(); st.cap = null; }

// 爆炸圖:原本的 2 個 mesh 每層各畫一次(共用幾何,只換 uLo / uHi 與位置),每層頂上蓋樓板(合成 1 個 mesh)
function explode(id) {
  const st = B.get(id), { L } = st;
  if (st.slices) return;
  unclip(id);
  st.group.visible = false;
  const grp = new THREE.Group(), caps = [];
  for (let f = 1; f <= L.n; f++) {
    for (const m of st.group.children) {
      const mat = m.material.clone();
      patchFloors(mat, { ...st.u, uLo: { value: f === 1 ? -1e5 : L.bottom(f) }, uHi: { value: f === L.n ? 1e5 : L.top(f) } });
      const c = new THREE.Mesh(m.geometry, mat);
      Object.assign(c.userData, { bid: id, slice: f });
      c.position.y = (f - 1) * GAP;
      c.castShadow = m.castShadow; c.receiveShadow = m.receiveShadow;
      grp.add(c);
    }
    if (f < L.n) caps.push(slabGeometry(st.shaped.ringAt(L.top(f) - 0.01), L.top(f)).translate(0, (f - 1) * GAP, 0));
  }
  const cap = new THREE.Mesh(mergeGeometries(caps), slabMat);
  cap.userData.bid = id;
  grp.add(cap);
  scene.add(grp);
  st.slices = grp;
}
function unexplode(id) {
  const st = B.get(id);
  if (!st?.slices) return;
  st.slices.traverse((o) => o.isMesh && o.material !== slabMat && o.material.dispose());
  st.slices.removeFromParent();
  st.slices = null;
  st.group.visible = true;
}

// ── 點選:射線打到的點,用高度算樓層(剖切、爆炸圖時跳過沒畫出來的部分)──
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
function hitFloor(origin, dir) {
  ray.set(origin, dir);
  const targets = [...B.values()].flatMap((st) => (st.slices ? st.slices.children : st.group.children).concat(st.cap ? [st.cap] : []));
  for (const h of ray.intersectObjects([...targets, ctx], false)) {
    const id = h.object.userData.bid;
    if (!id) return null; // 被其他建築擋住
    const st = B.get(id), y = h.point.y - h.object.position.y;
    if (h.object === st.cap) return { id, floor: st.L.floorAt(st.u.uCut.value - 0.01), y };
    if (y > st.u.uCut.value + 1e-3) continue;
    const f = h.object.userData.slice;
    if (f && (y < (f === 1 ? -1e5 : st.L.bottom(f)) || y >= (f === st.L.n ? 1e5 : st.L.top(f)))) continue;
    return { id, floor: Math.min(st.L.n, st.L.floorAt(y)), y, roof: st.L.floorAt(y) > st.L.n };
  }
  return null;
}
function hitAt(cx, cy) {
  mouse.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  return hitFloor(ray.ray.origin.clone(), ray.ray.direction.clone());
}
renderer.domElement.addEventListener('pointermove', (e) => {
  const h = hitAt(e.clientX, e.clientY);
  for (const st of B.values()) st.u.uHover.value = h?.id === st.b.id ? h.floor : 0;
  Object.assign($('tip').style, { display: h ? 'block' : 'none', left: `${e.clientX + 14}px`, top: `${e.clientY + 10}px` });
  if (h) $('tip').textContent = `${B.get(h.id).b.name} ${h.roof ? '屋頂' : `${h.floor} 樓`}`;
});
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // 拖曳旋轉不算點選
  const h = hitAt(e.clientX, e.clientY);
  h ? select(h.id, h.floor) : clear();
});
function select(id, floor) {
  sel = { id, floor };
  for (const st of B.values()) st.u.uPick.value = st.b.id === id ? floor : 0;
  if (clipOn) { for (const k of B.keys()) if (k !== id) unclip(k); clip(id, floor); }
  render();
}
function clear() {
  sel = null; clipOn = false;
  for (const id of B.keys()) { unexplode(id); unclip(id); B.get(id).u.uPick.value = 0; }
  render();
}

// ── 量測 ──
const measCam = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 5000); // 固定用總覽視角量(跟著目前鏡頭量,看不到的會被裁掉,數字會跳)
function countCalls() {
  const sh = renderer.shadowMap.enabled, keep = [camera.position.clone(), controls.target.clone()];
  overview();
  measCam.position.copy(camera.position); measCam.lookAt(controls.target);
  camera.position.copy(keep[0]); controls.target.copy(keep[1]);
  renderer.shadowMap.enabled = false; // 只算主畫面(陰影另外畫)
  renderer.render(scene, measCam);
  const r = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  renderer.shadowMap.enabled = sh;
  return r;
}
const statRows = [];
function measure(label) {
  const c = countCalls(), per = Object.fromEntries([...B].map(([id, st]) => [id, { tris: st.tris, bands: st.bands, pieces: st.pieces }]));
  const row = { label, ...c, per };
  statRows.push(row);
  $('stats').querySelector('tbody').innerHTML = statRows.map((r) => `<tr><td>${r.label}</td><td>${r.tris.toLocaleString()}</td><td>${r.calls}</td></tr>`).join('');
  return row;
}
function render() {
  const st = sel && B.get(sel.id);
  $('now').innerHTML = st ? `<div class="name">${st.b.name} ${sel.floor} 樓</div>
    <div class="kv">共 ${st.L.n} 層・一樓 ${st.L.g.toFixed(1)} m、標準層 ${st.L.typ.toFixed(2)} m・這層 ${st.L.bottom(sel.floor).toFixed(1)}–${st.L.top(sel.floor).toFixed(1)} m</div>
    <div class="kv">${clipOn ? '剖切中:這層以上不畫' : ''}${st.slices ? '爆炸圖:每層拉開 ' + GAP + ' m' : ''}</div>` : '<div class="kv">點牆選樓層(計網中心、理化實驗大樓)</div>';
  $('clipBtn').classList.toggle('on', clipOn);
  $('explodeBtn').classList.toggle('on', !!(sel && B.get(sel.id).slices));
  $('cutsBtn').classList.toggle('on', cutsOn);
  $('cutsBtn').textContent = `挖空:${cutsOn ? '開' : '關'}`;
  $('setbackBtn').classList.toggle('on', setbackOn);
}
$('clipBtn').onclick = () => { if (!sel) return; clipOn = !clipOn; unexplode(sel.id); clipOn ? clip(sel.id, sel.floor) : unclip(sel.id); render(); };
$('explodeBtn').onclick = () => { if (!sel) return; const st = B.get(sel.id); clipOn = false; st.slices ? unexplode(sel.id) : explode(sel.id); render(); };
$('cutsBtn').onclick = () => { cutsOn = !cutsOn; for (const id of TEST) build(id, optsOf(id)); measure(cutsOn ? '挖空開' : '挖空關'); render(); };
$('setbackBtn').onclick = () => { setbackOn = !setbackOn; build('NCKU-PC', optsOf('NCKU-PC')); measure(setbackOn ? '示範退縮' : '取消退縮'); render(); };
$('clearBtn').onclick = clear;

// ── 鏡頭 ──
const center = (id) => { const b = byId.get(id); return b.ring.reduce((a, p) => [a[0] + p[0] / b.ring.length, a[1] + p[1] / b.ring.length], [0, 0]); };
function lookAtFace(id, faceId, t, dist, h, y = 3) {
  const b = byId.get(id), f = b.faces.find((x) => x.id === faceId), F = edgeFrame(b.ring, f.edge), p = F.at(t);
  camera.position.set(p[0] + F.n[0] * dist + F.R[0] * dist * 0.35, h, p[1] + F.n[1] * dist + F.R[1] * dist * 0.35);
  controls.target.set(p[0], y, p[1]);
}
function overview() {
  const [x, z] = center('NCKU-CC'), [x2, z2] = center('NCKU-PC'), cx = (x + x2) / 2, cz = (z + z2) / 2;
  camera.position.set(cx - 70, 55, cz + 75);
  controls.target.set(cx, 10, cz);
}
overview();

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
window.__ready = true;
measure('挖空開');
render();

// ── 自動測試 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(n, ms = 900) { controls.update(); await sleep(ms); window.__cmpStep = n; await sleep(700); }
async function runTest() {
  const res = {};
  // 法線檢查:shape.js 自己算的朝外法線 vs 資料裡的 normal_deg
  res.normals = Math.min(...TEST.flatMap((id) => byId.get(id).faces.map((f) => { const F = edgeFrame(byId.get(id).ring, f.edge), r = (f.normal_deg * Math.PI) / 180; return F.n[0] * Math.sin(r) - F.n[1] * Math.cos(r); })));
  cutsOn = false; for (const id of TEST) build(id, optsOf(id)); res.plain = measure('A(沒挖空)');
  cutsOn = true; for (const id of TEST) build(id, optsOf(id)); res.cuts = measure('A + 挖空');
  render();
  lookAtFace('NCKU-CC', 'e2-east', 0.29, 16, 4, 3); await step(1);
  lookAtFace('NCKU-CC', 'e0-west', 0.85, 22, 8, 6); await step(2);
  lookAtFace('NCKU-PC', 'e1-south', 0.23, 24, 10, 10); await step(3);
  overview(); select('NCKU-CC', 4); res.pick = measure('選 4 樓(高亮)'); await step(4);
  clipOn = true; clip('NCKU-CC', 4); render(); res.clip = measure('剖切到 4 樓'); await step(5);
  clipOn = false; unclip('NCKU-CC'); explode('NCKU-CC'); render(); res.explode = measure('爆炸圖(9 層)');
  { const [x, z] = center('NCKU-CC'); camera.position.set(x - 60, 70, z + 60); controls.target.set(x, 22, z); } await step(6);
  unexplode('NCKU-CC'); clear();
  // 點選準確度:每一面、每一層的中間高度,從牆外 15 m 打一條水平射線
  const acc = { ok: 0, wrong: 0, blocked: 0, bad: [] };
  for (const id of TEST) {
    const st = B.get(id), b = st.b;
    for (const f of b.faces) {
      const F = edgeFrame(b.ring, f.edge), cs = f.spec?.cuts ?? [], t = cs.some((c) => c.t0 <= 0.5 && 0.5 <= c.t1) ? 0.1 : 0.5, p = F.at(t);
      for (let k = 1; k <= st.L.n; k++) {
        const y = (st.L.bottom(k) + st.L.top(k)) / 2, h = hitFloor(new THREE.Vector3(p[0] + F.n[0] * 15, y, p[1] + F.n[1] * 15), new THREE.Vector3(-F.n[0], 0, -F.n[1]));
        if (!h || h.id !== id) acc.blocked++;
        else if (h.floor === k) acc.ok++;
        else { acc.wrong++; acc.bad.push(`${id}/${f.id} ${k}→${h.floor}`); }
      }
    }
  }
  res.ray = acc;
  setbackOn = true; build('NCKU-PC', optsOf('NCKU-PC')); res.setback = measure('示範退縮(理化 6 樓以上退 2.5 m)'); render();
  { const [x, z] = center('NCKU-PC'); camera.position.set(x + 30, 48, z + 62); controls.target.set(x, 14, z); } await step(7);
  window.__pack = res;
  window.__done = true;
}
if (params.get('run') === 'test') runTest();
