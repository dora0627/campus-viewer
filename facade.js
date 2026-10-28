// 立面貼圖樣板:只依 spec.json(立面規格)用 Canvas 畫出一整面牆,不看截圖。
// 畫的方向:站在牆外面對這面,左 → 右、下 → 上;extras 的 t0 / t1 也是左 0 → 右 1。
// 回傳 { canvas, ms, bytes }:ms 是畫圖時間,bytes 是上傳到顯示卡的貼圖大小(含 mipmap 約 ×4/3)。

const PPM = 24; // 每公尺幾個像素(實拍的面);推定、預設的牆由呼叫端傳較低的值
const MAX = 2048;

// 固定種子的亂數(同一份規格每次畫出來一樣)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const hashStr = (t) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// 牆面材質:紅磚畫磚縫,清水模畫模板線與斑點
function wallFill(ctx, x, y, w, h, material, color, r, k = PPM) { // k:實際每公尺像素
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  if (material === 'brick' && 0.3 * k >= 3) { // 解析度太低時磚縫會擠成一片,就不畫
    const course = 0.3 * k, brick = 0.6 * k;
    ctx.fillStyle = shade(color, 0.82);
    for (let yy = y + h; yy > y; yy -= course) {
      ctx.fillRect(x, yy - 1, w, 1);
      const off = (Math.round((y + h - yy) / course) % 2) * brick / 2;
      for (let xx = x + off; xx < x + w; xx += brick) ctx.fillRect(xx, yy - course, 1, course);
    }
  } else if (material === 'concrete') {
    ctx.fillStyle = shade(color, 0.93);
    for (let yy = y + h; yy > y; yy -= 0.9 * k) ctx.fillRect(x, yy, w, 1);
    for (let xx = x; xx < x + w; xx += 1.8 * k) ctx.fillRect(xx, y, 1, h);
  }
  // 細微的明暗斑點,看起來比較不像純色塊
  for (let i = 0; i < (w * h) / 900; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.05})`;
    ctx.fillRect(x + r() * w, y + r() * h, 2 + r() * 4, 2 + r() * 4);
  }
}

function drawWindow(ctx, type, x, y, w, h, color, wallColor, k = PPM) {
  if (type === 'none') return;
  if (type === 'square-recessed') {
    ctx.fillStyle = shade(wallColor, 0.55); // 內凹的陰影
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x + w * 0.1, y + h * 0.14, w * 0.82, h * 0.8);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x + w * 0.1, y + h * 0.14, w * 0.82, 2);
    ctx.fillRect(x + w * 0.5, y + h * 0.14, 2, h * 0.8); // 窗框中線
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  if (type === 'vertical-slot') {
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, 2, h);
  } else if (type === 'band') {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    for (let xx = x; xx < x + w; xx += 1.2 * k) ctx.fillRect(xx, y, 2, h);
  }
}

export function drawFacade(spec, lengthM, heightM, ppm = PPM) {
  const t0 = performance.now();
  const W = Math.min(MAX, Math.max(16, Math.round(lengthM * ppm))), H = Math.min(MAX, Math.max(16, Math.round(heightM * ppm)));
  const sx = W / lengthM, sy = H / heightM; // 實際每公尺像素(超過上限時會小於 PPM)
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const r = rng(hashStr(`${spec.building}/${spec.face}`));
  const wall = spec.wall ?? { material: 'concrete', color: '#c8c4bc' };
  const win = { type: 'square-recessed', per_bay: 1, w: 0.6, h: 0.55, color: '#2b3036', ...(spec.window ?? {}) };
  const floors = Math.max(1, spec.floors ?? 1);
  const parapet = (spec.parapet?.h_m ?? 0.9) * sy;
  const groundH = (spec.ground_h_m ?? spec.floor_h_m ?? 3.6) * sy;
  const typH = floors > 1 ? (H - parapet - groundH) / (floors - 1) : H - parapet;
  const floorTop = (f) => (f === 0 ? H - groundH : H - groundH - f * typH); // 第 f 層(0 = 一樓)的上緣 y
  const floorH = (f) => (f === 0 ? groundH : typH);
  const left = (spec.edges?.left_m ?? 0) * sx, right = (spec.edges?.right_m ?? 0) * sx;
  const innerX = left, innerW = W - left - right;
  const bays = Math.max(1, spec.bays ?? Math.round(innerW / (4 * sx)));
  const bayW = innerW / bays, slot = bayW / Math.max(1, win.per_bay);

  wallFill(ctx, 0, 0, W, H, wall.material, wall.color, r, sx);
  // 兩側不同材質的條帶(例:資訊大樓清水模立面兩端包紅磚)
  if (left) wallFill(ctx, 0, 0, left, H, 'brick', spec.edges.color ?? '#9c4a36', r, sx);
  if (right) wallFill(ctx, W - right, 0, right, H, 'brick', spec.edges.color ?? '#9c4a36', r, sx);

  const g = spec.ground ?? { type: 'same' };
  const podium = g.type === 'brick-podium' ? Math.max(1, g.floors ?? 1) : 0;
  if (podium) wallFill(ctx, 0, floorTop(podium - 1), W, H - floorTop(podium - 1), 'brick', g.color ?? '#9a4632', r, sx);

  const entrances = (spec.extras ?? []).filter((e) => e.type === 'entrance' || e.type === 'stair-tower');
  const inSpan = (x, list) => list.some((e) => x >= (e.t0 ?? 0) * W && x <= (e.t1 ?? 1) * W);

  // 窗格:每層 × 每個窗組 × 每組幾扇
  for (let f = 0; f < floors; f++) {
    const top = floorTop(f), fh = floorH(f);
    const isPodium = f < podium;
    for (let bi = 0; bi < bays; bi++) {
      for (let k = 0; k < win.per_bay; k++) {
        const cx = innerX + bi * bayW + (k + 0.5) * slot;
        if (inSpan(cx, entrances)) continue;
        let type = win.type, ww = slot * win.w, wh = fh * win.h;
        if (f === 0 && g.type === 'grille') type = 'square-recessed';
        if (f === 0 && g.type === 'open') continue;
        if (isPodium) { type = 'square-recessed'; ww = slot * 0.5; wh = fh * 0.45; if ((bi + k) % 2) continue; }
        const x = cx - ww / 2, y = top + (fh - wh) * 0.45;
        drawWindow(ctx, type, x, y, ww, wh, win.color, isPodium ? (g.color ?? '#9a4632') : wall.color, sx);
        if (f === 0 && g.type === 'grille') { // 一樓鐵網窗
          ctx.strokeStyle = 'rgba(200,200,200,0.45)';
          ctx.lineWidth = 1;
          for (let d = -wh; d < ww; d += 4) { ctx.beginPath(); ctx.moveTo(x + d, y + wh); ctx.lineTo(x + d + wh, y); ctx.stroke(); }
        }
        const ac = (spec.extras ?? []).find((e) => e.type === 'ac-units');
        if (ac && f > 0 && !isPodium && r() < (ac.density ?? 0.4)) { // 窗下冷氣
          ctx.fillStyle = '#d9d9d6';
          ctx.fillRect(cx - 0.4 * sx, y + wh + 0.1 * sy, 0.8 * sx, 0.55 * sy);
          ctx.fillStyle = '#9a9a96';
          ctx.fillRect(cx - 0.4 * sx, y + wh + 0.6 * sy, 0.8 * sx, 2);
        }
      }
    }
    // 樓板線
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, top + fh - 2, W, 2);
  }

  // 頂層女兒牆
  ctx.fillStyle = shade(wall.color, 1.06);
  ctx.fillRect(left, 0, innerW, parapet);
  if (spec.parapet?.openings) {
    ctx.fillStyle = '#3a3f45';
    for (let bi = 0; bi < bays; bi += 2) ctx.fillRect(innerX + bi * bayW + bayW * 0.25, parapet * 0.2, bayW * 0.5, parapet * 0.55);
  }

  for (const e of spec.extras ?? []) {
    const a = (e.t0 ?? 0) * W, b = (e.t1 ?? 1) * W;
    if (e.type === 'railing') { // 欄杆
      const f = e.at_floor ?? 2, y = (f <= 1 ? H : floorTop(f - 2)) + 4; // 站在第 f 層的地板上 = 第 f−1 層的上緣
      ctx.fillStyle = '#d8d8d4';
      ctx.fillRect(0, y - 0.9 * sy, W, 2);
      for (let x = 0; x < W; x += 0.15 * sx) ctx.fillRect(x, y - 0.9 * sy, 1, 0.9 * sy);
    } else if (e.type === 'entrance') { // 入口:深色開口
      ctx.fillStyle = '#20242a';
      ctx.fillRect(a, H - groundH * 0.85, b - a, groundH * 0.85);
    } else if (e.type === 'canopy') { // 雨遮
      ctx.fillStyle = '#e4e4e0';
      ctx.fillRect(a, H - groundH - 0.4 * sy, b - a, 0.5 * sy);
    } else if (e.type === 'stair-tower') { // 樓梯塔背後的牆:細長直窗
      ctx.fillStyle = shade(wall.color, 0.6);
      for (let x = a + (b - a) * 0.2; x < b - (b - a) * 0.15; x += (b - a) * 0.3) ctx.fillRect(x, parapet + 0.5 * sy, 0.25 * sx, H - parapet - groundH - 0.5 * sy);
    }
  }
  return { canvas: cv, ms: performance.now() - t0, bytes: Math.round(W * H * 4 * 4 / 3) };
}
