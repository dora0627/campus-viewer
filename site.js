// B5 場地(預設):道路段依種類給寬度與鋪面畫成路面帶;區域(草地、停車場、廣場、水池)畫成地面;樹列每 8 m 種一棵。
// 之後有 road-spec 的段改用規格(路寬、車道、標線);現在全部是「道路種類的預設值」。
// 同材質合併成一個 mesh,樹用 InstancedMesh → 整個場地只有幾個 draw call。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 道路種類 → 預設寬度(公尺)與鋪面
export const ROAD_DEFAULT = {
  secondary: [12, 'asphalt'], tertiary: [9, 'asphalt'], residential: [6, 'asphalt'], unclassified: [6, 'asphalt'], service: [6, 'asphalt'],
  living_street: [5, 'asphalt'], pedestrian: [4, 'pavers'], footway: [2.5, 'pavers'], cycleway: [2, 'asphalt'], path: [1.5, 'path'], steps: [2.5, 'steps'], track: [3, 'path'], corridor: [2, 'pavers'],
};
const SURFACE = { asphalt: 0x4a4c50, pavers: 0xb9ad9a, path: 0xa99a7e, steps: 0xc9c3b6, concrete: 0x9c9a94 };
const AREA = { grass: 0x5f8f45, park: 0x6b9a4c, parking: 0x5c5e62, plaza: 0xc4b59c, water: 0x3f7fb0, fountain: 0x5aa3cc, pitch: 0x4f8a4a, 'bike-parking': 0x8d8f93, 'moto-parking': 0x6d6f73 };
const LIFT = { area: 0.03, road: 0.06, foot: 0.08, steps: 0.1 }; // 疊放高度,避免跟地面、彼此搶深度

// 折線往左右各偏移 w/2,做成一條帶狀(轉角用兩邊法線的平均)
function ribbon(line, w, y) {
  const pos = [], idx = [];
  for (let i = 0; i < line.length; i++) {
    const p = line[i], a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    pos.push(p[0] - dz * w / 2, y, p[1] + dx * w / 2, p[0] + dz * w / 2, y, p[1] - dx * w / 2);
    if (i) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 帶子可能朝下(取決於走向),法線一律朝上
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g.toNonIndexed();
}
function polygon(coords, y) {
  const s = new THREE.Shape();
  coords.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)));
  const g = new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2).translate(0, y, 0);
  g.deleteAttribute('uv');
  return g.toNonIndexed();
}

export function buildSite(site) {
  const t0 = performance.now(), grp = new THREE.Group(), byMat = new Map(), stats = { segments: 0, length: 0, areas: 0, trees: 0 };
  const add = (color, g) => (byMat.get(color) ?? byMat.set(color, []).get(color)).push(g);
  for (const a of site.areas ?? []) {
    if (a.type !== 'Polygon' || !AREA[a.kind] || a.coords.length < 3) continue;
    add(AREA[a.kind], polygon(a.coords, LIFT.area));
    stats.areas++;
  }
  for (const s of site.segments ?? []) {
    const [w, surf] = ROAD_DEFAULT[s.kind] ?? [3, 'asphalt'];
    const surface = { paving_stones: 'pavers', concrete: 'concrete', asphalt: 'asphalt' }[s.tags?.surface] ?? surf; // OSM 有標鋪面就用
    const y = surf === 'asphalt' ? LIFT.road : surf === 'steps' ? LIFT.steps : LIFT.foot;
    add(SURFACE[surface] ?? SURFACE.asphalt, ribbon(s.line, w, y));
    stats.segments++;
    stats.length += s.line.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - s.line[i - 1][0], p[1] - s.line[i - 1][1]) : 0), 0);
  }
  for (const [color, geos] of byMat) {
    const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    m.receiveShadow = true;
    grp.add(m);
  }
  // 樹:樹列每 8 m 一棵、單棵樹的點;樹幹與樹冠各一個 InstancedMesh
  const spots = [];
  for (const a of site.areas ?? []) {
    if (a.kind !== 'tree-row') continue;
    for (let i = 1; i < a.coords.length; i++) {
      const [x1, z1] = a.coords[i - 1], [x2, z2] = a.coords[i], L = Math.hypot(x2 - x1, z2 - z1);
      for (let d = 0; d < L; d += 8) spots.push([x1 + (x2 - x1) * d / L, z1 + (z2 - z1) * d / L]);
    }
  }
  for (const p of site.points ?? []) if (p.kind === 'natural=tree') spots.push(p.at);
  if (spots.length) {
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 3, 6).translate(0, 1.5, 0), new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 1 }), spots.length);
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 0).translate(0, 4.6, 0), new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 1, flatShading: true }), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    spots.forEach(([x, z], i) => {
      const k = 0.8 + ((i * 7919) % 100) / 250; // 大小有點變化
      sc.set(k, k, k);
      m.compose(new THREE.Vector3(x, 0, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), i), sc);
      trunk.setMatrixAt(i, m); crown.setMatrixAt(i, m);
    });
    trunk.castShadow = crown.castShadow = true;
    grp.add(trunk, crown);
    stats.trees = spots.length;
  }
  stats.ms = performance.now() - t0;
  stats.calls = grp.children.length;
  return { group: grp, stats };
}
