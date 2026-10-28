// 視角移動(三個頁面共用):右上角「跳到建築」選單與重設視角、雙擊建築飛過去、WASD / 方向鍵平移、操作提示。
// 用法:const nav = addNav({ camera, controls, renderer, scene, buildings: data.buildings });在動畫迴圈裡呼叫 nav.update()
import * as THREE from 'three';

const CSS = `
#nav { position: fixed; top: 16px; right: 16px; z-index: 4; display: flex; gap: 6px; align-items: center; max-width: calc(100% - 32px); }
#nav select, #nav button { font: 13px system-ui, "PingFang TC", sans-serif; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14); background: rgba(20,22,26,.88); color: #f2f2f2; }
#nav select { max-width: 220px; }
#navHelp { position: fixed; right: 16px; top: 54px; z-index: 4; padding: 8px 12px; border-radius: 10px; background: rgba(20,22,26,.88); border: 1px solid rgba(255,255,255,.12); color: #c9ced6; font: 12px/1.7 system-ui, "PingFang TC", sans-serif; }
#navHelp b { color: #f2f2f2; font-weight: 600; }
@media (max-width: 720px) { #nav { top: auto; bottom: 28px; right: 12px; } #navHelp { display: none; } }
`;

const inside = ([x, z], ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

export function addNav({ camera, controls, renderer, scene, buildings, onPick }) {
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  const info = buildings.map((b) => {
    const c = b.ring.reduce((a, p) => [a[0] + p[0] / b.ring.length, a[1] + p[1] / b.ring.length], [0, 0]);
    const r = Math.max(...b.ring.map(([x, z]) => Math.hypot(x - c[0], z - c[1])));
    return { b, c, r };
  });
  const home = { pos: camera.position.clone(), tgt: controls.target.clone() };
  const sorted = [...info].sort((a, b) => a.b.name.localeCompare(b.b.name, 'zh-Hant'));
  document.body.insertAdjacentHTML('beforeend', `<div id="nav"><select id="navSel" aria-label="跳到建築"><option value="">跳到建築…</option>${sorted.map((x) => `<option value="${x.b.id}">${x.b.name}</option>`).join('')}</select><button id="navHome" title="回到一開始的視角">重設視角</button><button id="navQ" title="操作說明">?</button></div>
    <div id="navHelp"><b>左鍵拖曳</b> 旋轉・<b>右鍵拖曳</b> 平移・<b>滾輪</b> 縮放<br><b>雙擊建築</b> 飛過去・<b>WASD / 方向鍵</b> 移動<br>手機:單指旋轉、雙指縮放與平移</div>`);
  const help = document.getElementById('navHelp');
  let fly = null;
  const flyTo = (pos, tgt, ms = 900) => { controls.autoRotate = false; fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: tgt, s: performance.now(), ms }; };
  // 飛到一棟:保持目前看的方向,距離依建築大小與高度
  function goto(id) {
    const x = info.find((v) => v.b.id === id);
    if (!x) return;
    const tgt = new THREE.Vector3(x.c[0], x.b.height_m * 0.4, x.c[1]);
    const dir = camera.position.clone().sub(controls.target).setY(0).normalize();
    if (!dir.lengthSq()) dir.set(-0.6, 0, 0.8);
    const d = Math.max(45, x.r * 2.4 + x.b.height_m * 1.2);
    flyTo(tgt.clone().add(dir.multiplyScalar(d)).setY(tgt.y + d * 0.55), tgt);
    document.getElementById('navSel').value = id;
    onPick?.(x.b);
  }
  document.getElementById('navSel').onchange = (e) => e.target.value && goto(e.target.value);
  document.getElementById('navHome').onclick = () => { flyTo(home.pos.clone(), home.tgt.clone()); document.getElementById('navSel').value = ''; };
  document.getElementById('navQ').onclick = () => (help.hidden = !help.hidden);
  setTimeout(() => (help.hidden = true), 9000); // 一開始顯示 9 秒,之後按「?」再看
  // 雙擊:打到的點落在哪一棟的輪廓內(或最近的一棟)
  const ray = new THREE.Raycaster(), m = new THREE.Vector2();
  renderer.domElement.addEventListener('dblclick', (e) => {
    m.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(m, camera);
    const h = ray.intersectObjects(scene.children, true).find((h) => h.object.visible && h.object.isMesh);
    if (!h) return;
    const p = [h.point.x, h.point.z];
    const hit = info.find((x) => inside(p, x.b.ring)) ?? info.reduce((a, x) => (Math.hypot(x.c[0] - p[0], x.c[1] - p[1]) - x.r < Math.hypot(a.c[0] - p[0], a.c[1] - p[1]) - a.r ? x : a));
    if (Math.hypot(hit.c[0] - p[0], hit.c[1] - p[1]) < hit.r + 15) goto(hit.b.id);
  });
  // WASD / 方向鍵:沿著畫面的前後左右平移(距離越遠走越快)
  const keys = new Set();
  addEventListener('keydown', (e) => { if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) keys.add(e.key.toLowerCase()); });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());
  let last = performance.now();
  return {
    goto,
    update() {
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (fly) {
        const k = Math.min(1, (now - fly.s) / fly.ms), e = k * k * (3 - 2 * k);
        camera.position.lerpVectors(fly.p0, fly.p1, e);
        controls.target.lerpVectors(fly.t0, fly.t1, e);
        if (k >= 1) fly = null;
      }
      const f = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
      const r = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
      if (f || r) {
        controls.autoRotate = false;
        const fwd = controls.target.clone().sub(camera.position).setY(0).normalize(), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const step = fwd.multiplyScalar(f).add(right.multiplyScalar(r)).multiplyScalar(camera.position.distanceTo(controls.target) * 0.45 * dt);
        camera.position.add(step);
        controls.target.add(step);
      }
    },
  };
}
