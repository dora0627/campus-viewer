// 屋頂:依 roof.json(屋頂規格)用程式畫屋面貼圖、加女兒牆與屋頂上的構造;沒有規格的用預設(平屋頂、灰色、女兒牆 0.9 m)。
// 不直接貼正射影像(授權未確認,見 LICENSES.md),影像只給 /roof-spec 當參考。
import * as THREE from 'three';

const PPM = 8;
export const DEFAULT_ROOF = { roof: { shape: 'flat', material: 'concrete', color: '#a7a49c' }, parapet: { h_m: 0.9, color: '#bdb9b0' }, parts: [] };

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// 屋面貼圖:依材質畫分隔縫、瓦線、斑駁
function roofCanvas(spec, wM, hM, seed) {
  const W = Math.max(16, Math.min(1024, Math.round(wM * PPM))), H = Math.max(16, Math.min(1024, Math.round(hM * PPM)));
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = cv.getContext('2d'), r = rng(seed);
  const color = spec.roof?.color ?? DEFAULT_ROOF.roof.color, mat = spec.roof?.material ?? 'concrete';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  const k = W / wM;
  ctx.fillStyle = shade(color, 0.88);
  if (mat === 'concrete' || mat === 'waterproof') { // 伸縮縫(每 3 m)
    for (let x = 0; x < W; x += 3 * k) ctx.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 3 * k) ctx.fillRect(0, y, W, 1);
  } else if (mat === 'tile' || mat === 'metal') { // 瓦線 / 浪板
    for (let y = 0; y < H; y += (mat === 'tile' ? 0.35 : 0.6) * k) ctx.fillRect(0, y, W, 1);
  } else if (mat === 'green') {
    ctx.fillStyle = 'rgba(40,90,40,0.35)';
    for (let i = 0; i < (W * H) / 40; i++) ctx.fillRect(r() * W, r() * H, 3, 3);
  }
  for (let i = 0; i < (W * H) / 120; i++) { // 斑駁(雨痕、汙漬)
    ctx.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.06})`;
    ctx.fillRect(r() * W, r() * H, 2 + r() * 8, 2 + r() * 8);
  }
  return cv;
}

// 局部斜屋頂:三角柱(ridge:ew 屋脊東西向、ns 南北向)
function gable(w, d, h, ridge) {
  const s = new THREE.Shape();
  const span = ridge === 'ns' ? w : d;
  s.moveTo(-span / 2, 0); s.lineTo(span / 2, 0); s.lineTo(0, h); s.lineTo(-span / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: ridge === 'ns' ? d : w, bevelEnabled: false });
  g.translate(0, 0, -(ridge === 'ns' ? d : w) / 2);
  if (ridge !== 'ns') g.rotateY(Math.PI / 2);
  return g;
}

// b:data.json 的一棟(ring 是場景公尺座標);spec:roof.json 或 null。回傳 { group, ms, bytes }
export function buildRoof(b, spec) {
  const t0 = performance.now();
  spec = spec ?? DEFAULT_ROOF;
  const ring = b.ring, H = b.height_m, grp = new THREE.Group();
  const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), minz = Math.min(...zs), maxz = Math.max(...zs);
  // 屋面:輪廓形狀,貼圖依外框對齊(上 = 北)
  const shape = new THREE.Shape();
  ring.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
  const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, H + 0.12, 0); // 離量體頂面 12 cm,遠看才不會跟頂面搶深度(z-fighting)
  const cv = roofCanvas(spec, maxx - minx, maxz - minz, b.id.length * 7919 + Math.round(minx * 13));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1 / (maxx - minx), 1 / (maxz - minz)); // ShapeGeometry 的 uv = 形狀座標(x, -z)
  tex.offset.set(-minx / (maxx - minx), maxz / (maxz - minz));
  const roof = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  roof.receiveShadow = true;
  grp.add(roof);
  // 女兒牆:沿每條邊一道矮牆
  const ph = spec.parapet?.h_m ?? 0.9, pm = new THREE.MeshStandardMaterial({ color: spec.parapet?.color ?? '#bdb9b0', roughness: 0.9 });
  if (ph > 0.05) ring.forEach(([x1, z1], i) => {
    const [x2, z2] = ring[(i + 1) % ring.length], len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.3) return;
    const w = new THREE.Mesh(new THREE.BoxGeometry(len + 0.25, ph, 0.25), pm);
    w.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
    w.position.set((x1 + x2) / 2, H + ph / 2, (z1 + z2) / 2);
    w.castShadow = true;
    grp.add(w);
  });
  // 屋頂上的構造:座標是 roof_ref.jpg 上的比例,影像比輪廓外擴 pad_m
  const pad = spec.frame?.pad_m ?? 3, fx0 = minx - pad, fz0 = minz - pad, fw = maxx - minx + 2 * pad, fd = maxz - minz + 2 * pad;
  for (const p of spec.parts ?? []) {
    const x0 = fx0 + p.x0 * fw, x1 = fx0 + p.x1 * fw, z0 = fz0 + p.y0 * fd, z1 = fz0 + p.y1 * fd;
    const w = Math.max(0.5, x1 - x0), d = Math.max(0.5, z1 - z0), h = p.h_m ?? 2.5, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const m = new THREE.MeshStandardMaterial({ color: p.color ?? '#b9b5ad', roughness: 0.85 });
    let mesh = null;
    if (p.type === 'pitched-roof') mesh = new THREE.Mesh(gable(w, d, h, p.ridge), m);
    else if (p.type === 'water-tank') mesh = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) / 2, Math.min(w, d) / 2, h, 16).translate(0, h / 2, 0), m);
    else if (p.type === 'solar' || p.type === 'skylight') mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, d).translate(0, 0.3, 0), new THREE.MeshStandardMaterial({ color: p.type === 'solar' ? '#26324a' : '#9fb7c4', roughness: 0.3, metalness: 0.3 }));
    else if (p.type === 'courtyard') continue;
    else mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), m); // 屋突、樓梯間、冷氣主機群
    mesh.position.set(cx, H, cz);
    mesh.castShadow = mesh.receiveShadow = true;
    grp.add(mesh);
  }
  return { group: grp, ms: performance.now() - t0, bytes: Math.round(cv.width * cv.height * 4 * 4 / 3), parts: (spec.parts ?? []).length };
}
