// 오타루 슬로프 — 화면 (three.js 3D 지형 + 슬로프 오버레이)
import * as THREE from "three";

// ── 유틸 ────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Math.round(n).toLocaleString("ko-KR");
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 4);
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(t, 0, 1)));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const DIFF = {
  easy: { ko: "초급", color: "#5ee6a3", fill: "rgba(94,230,163,0.28)" },
  intermediate: { ko: "중급", color: "#ff6b5e", fill: "rgba(255,107,94,0.28)" },
  advanced: { ko: "상급", color: "#0b0e16", edge: "#f4f6fa", fill: "rgba(11,14,22,0.5)" },
  unknown: { ko: "난이도 미상", color: "#8f9ab0", fill: "rgba(143,154,176,0.22)" },
};
const KIND = { downhill: "", mogul: "모굴", snow_park: "스노파크" };
const LIFT = { chair_lift: "체어리프트", gondola: "곤돌라", cable_car: "로프웨이", magic_carpet: "스노 에스컬레이터", mixed_lift: "복합 리프트", drag_lift: "T바", platter: "플래터", rope_tow: "로프토" };
const RUN_W = 26; // 슬로프 선 폭 (m)
const EXAG = 1.3;  // 세로 강조 배율 (화면 표현만. 수치는 실측 그대로)
let yOf = (z) => z; // 실제 표고(m) → 장면 y

// ── 상태 ────────────────────────────────────────────────
const index = { resorts: [] };
const cache = new Map();
let current = null;     // 현재 리조트 데이터
let feats = [];          // 그릴 수 있는 것들 (피스트 + 리프트)
let byId = new Map();
let hot = null, sel = null;
let hotSrc = null;

// ── 3D 기본 ─────────────────────────────────────────────
const canvas = $("#scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 10, 60000);
const raycaster = new THREE.Raycaster();
let terrain = null, overlayCtx = null, idData = null, liftGroup = null, liftPicks = [], elevAt = () => 0;
let world = { center: new THREE.Vector3(), radius: 1000, target: new THREE.Vector3(), upDir: new THREE.Vector3(0, 0, -1), hMin: 0, hMax: 1 };
let reveal = { v: 1.2, from: -0.1, to: 1.2, t0: 0, dur: 1 };
let liftMats = [];

// 카메라 궤도 상태
const cam = { theta: 0, phi: 0.95, dist: 3000, target: new THREE.Vector3(), minDist: 300, maxDist: 12000 };
let camAnim = null;     // { from:{theta,phi,dist,target}, to:{...}, t0, dur }
let lastInput = performance.now();
let touched = false;  // 사용자가 시점을 움직였는지 (아니면 리사이즈 때 다시 맞춤)
let needsRender = true;
const clock = new THREE.Clock();

const TERRAIN_VERT = /* glsl */ `
  varying vec3 vW; varying vec3 vN; varying float vH; varying vec2 vUv;
  void main() {
    vUv = uv; vH = position.y; vN = normal; vW = position;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }`;
const TERRAIN_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uOverlay; uniform sampler2D uId;
  uniform float uHover; uniform float uSel; uniform float uTime; uniform float uHMin; uniform float uHMax; uniform float uReveal; uniform float uExag;
  uniform vec3 uLow; uniform vec3 uMid; uniform vec3 uHigh; uniform vec3 uBg; uniform vec3 uAccent; uniform vec3 uLight; uniform vec3 uCam;
  uniform float uFogNear; uniform float uFogFar;
  varying vec3 vW; varying vec3 vN; varying float vH; varying vec2 vUv;
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    float h = uHMin + (vH - uHMin) / uExag; // 실제 표고
    float t = clamp((h - uHMin) / max(uHMax - uHMin, 1.0), 0.0, 1.0);
    if (t > uReveal) discard;
    vec3 n = normalize(vN); if (n.y < 0.0) n = -n;
    vec3 ns = normalize(n * vec3(1.0, 0.55, 1.0)); // 음영용 기복 강조
    vec3 base = t < 0.5 ? mix(uLow, uMid, t * 2.0) : mix(uMid, uHigh, (t - 0.5) * 2.0);
    float diff = max(dot(ns, normalize(uLight)), 0.0);
    float sky = 0.5 + 0.5 * ns.y;
    vec3 col = base * (0.38 * sky + 0.92 * diff);
    float steep = 1.0 - n.y;
    col = mix(col, col * vec3(0.7, 0.76, 0.98), smoothstep(0.3, 0.75, steep));
    // 등고선: 50m 마다 희미하게, 250m 마다 조금 더
    float c1 = h / 50.0; float d1 = abs(fract(c1 + 0.5) - 0.5); float l1 = 1.0 - smoothstep(0.0, fwidth(c1) * 1.3, d1);
    float c2 = h / 250.0; float d2 = abs(fract(c2 + 0.5) - 0.5); float l2 = 1.0 - smoothstep(0.0, fwidth(c2) * 1.3, d2);
    col = mix(col, col * 1.3 + 0.04, l1 * 0.3 + l2 * 0.24);
    // 가까이 왔을 때만: 10m 보조 등고선 + 눈 표면의 잔잔한 질감 (값 노이즈 2옥타브)
    float dCam = distance(vW, uCam);
    float near = 1.0 - smoothstep(600.0, 2400.0, dCam);
    if (near > 0.001) {
      float c0 = h / 10.0; float d0 = abs(fract(c0 + 0.5) - 0.5); float l0 = 1.0 - smoothstep(0.0, fwidth(c0) * 1.2, d0);
      col = mix(col, col * 1.18 + 0.02, l0 * 0.2 * near);
      col *= 1.0 + (vnoise(vW.xz / 24.0) * 0.6 + vnoise(vW.xz / 7.0) * 0.4 - 0.5) * 0.12 * near;
    }
    // 슬로프 오버레이
    vec4 ov = texture2D(uOverlay, vUv);
    vec3 idc = texture2D(uId, vUv).rgb;
    float id = floor(idc.r * 255.0 + 0.5) + 256.0 * floor(idc.g * 255.0 + 0.5);
    bool isHot = uHover > 0.5 && abs(id - uHover) < 0.5;
    bool isSel = uSel > 0.5 && abs(id - uSel) < 0.5;
    float a = ov.a; vec3 oc = ov.rgb;
    if (uSel > 0.5 && !isSel && !isHot) a *= 0.32;
    if (isHot || isSel) { float pulse = 0.5 + 0.5 * sin(uTime * 3.2); oc = mix(oc, vec3(1.0), 0.22 + 0.18 * pulse); a = min(1.0, a * 1.25 + 0.25); }
    col = mix(col, oc, a);
    // 드러나는 가장자리 (오로라 선)
    float edge = 1.0 - smoothstep(0.0, 0.035, uReveal - t);
    col = mix(col, uAccent, edge * 0.9 * step(uReveal, 1.0));
    // 안개
    float fog = smoothstep(uFogNear, uFogFar, distance(vW, uCam));
    col = mix(col, uBg, fog * 0.85);
    // 격자 가장자리 흐리기
    vec2 e = min(vUv, 1.0 - vUv); float ea = smoothstep(0.0, 0.07, min(e.x, e.y));
    gl_FragColor = vec4(col, ea);
  }`;

const terrainMat = new THREE.ShaderMaterial({
  vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, transparent: true, side: THREE.DoubleSide,
  uniforms: {
    uOverlay: { value: null }, uId: { value: null }, uHover: { value: 0 }, uSel: { value: 0 }, uTime: { value: 0 },
    uHMin: { value: 0 }, uHMax: { value: 1 }, uReveal: { value: 1.2 }, uExag: { value: EXAG },
    uLow: { value: raw("#1a2542") }, uMid: { value: raw("#3b527c") }, uHigh: { value: raw("#e6edf9") }, uBg: { value: raw("#0b1020") }, uAccent: { value: raw("#6ef0b2") },
    uLight: { value: new THREE.Vector3(-0.62, 0.42, 0.4) }, uCam: { value: new THREE.Vector3() }, uFogNear: { value: 3000 }, uFogFar: { value: 12000 },
  },
});
function raw(hex) { return new THREE.Color().setStyle(hex, THREE.LinearSRGBColorSpace); } // 변환 없이 그대로 (셰이더에서 직접 출력)

// ── 데이터 → 장면 ────────────────────────────────────────
function decodeHeights(b64) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function buildTerrain(d) {
  const { cols, rows, step, minX, maxY } = d.grid;
  const h = decodeHeights(d.grid.heights);
  const n = cols * rows;
  const hMin = d.grid.hMin;
  yOf = (z) => hMin + (z - hMin) * EXAG;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    pos[k * 3] = minX + i * step; pos[k * 3 + 1] = yOf(h[k] / 10); pos[k * 3 + 2] = -(maxY - j * step);
    uv[k * 2] = i / (cols - 1); uv[k * 2 + 1] = 1 - j / (rows - 1);
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let q = 0;
  for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
    const a = j * cols + i, b = a + 1, c = a + cols, e = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = e;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const minY = maxY - (rows - 1) * step;
  elevAt = (x, y) => {
    const fx = clamp((x - minX) / step, 0, cols - 1.001), fy = clamp((maxY - y) / step, 0, rows - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const h00 = h[j * cols + i], h10 = h[j * cols + i + 1], h01 = h[(j + 1) * cols + i], h11 = h[(j + 1) * cols + i + 1];
    return yOf(((h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v) / 10);
  };
  return { mesh: new THREE.Mesh(g, terrainMat), W: (cols - 1) * step, H: (rows - 1) * step, minX, maxY, minY };
}

function idColor(id) { return `rgb(${id & 255},${(id >> 8) & 255},0)`; }

function paintOverlay(d, t) {
  // 마우스 환경(대개 큰 화면)은 3072px, 터치 기기는 메모리를 아껴 2048px
  const RES = finePointer.matches && renderer.capabilities.maxTextureSize >= 4096 ? 3072 : 2048;
  const S = RES / Math.max(t.W, t.H);
  const cw = Math.max(2, Math.round(t.W * S)), ch = Math.max(2, Math.round(t.H * S));
  const mk = () => { const c = document.createElement("canvas"); c.width = cw; c.height = ch; return c; };
  const cc = mk(), ic = mk();
  const ctx = cc.getContext("2d"), ictx = ic.getContext("2d");
  const P = (p) => [(p[0] - t.minX) * S, (t.maxY - p[1]) * S];
  const path = (c, pts, close) => { c.beginPath(); pts.forEach((p, i) => { const [x, y] = P(p); i ? c.lineTo(x, y) : c.moveTo(x, y); }); if (close) c.closePath(); };
  ctx.lineJoin = ictx.lineJoin = "round"; ctx.lineCap = ictx.lineCap = "round";

  // 리조트 경계
  path(ctx, d.boundary, true); ctx.setLineDash([6, 6]); ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);

  const pistes = feats.filter((f) => f.kind === "piste");
  const areas = pistes.filter((f) => f.area), lines = pistes.filter((f) => !f.area).sort((a, b) => b.len - a.len);
  for (const f of areas) {
    const D = DIFF[f.difficulty];
    path(ctx, f.pts, true); ctx.fillStyle = D.fill; ctx.fill(); ctx.strokeStyle = D.edge ? "rgba(244,246,250,0.55)" : D.color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.globalAlpha = 1;
    path(ictx, f.pts, true); ictx.fillStyle = idColor(f.id); ictx.fill();
  }
  const w = Math.max(6, RUN_W * S);
  for (const f of lines) {
    const D = DIFF[f.difficulty];
    path(ctx, f.pts, false);
    ctx.strokeStyle = D.edge ? D.edge : "rgba(8,11,20,0.85)"; ctx.lineWidth = w + (D.edge ? 6 : 3); ctx.stroke();
    ctx.strokeStyle = D.color; ctx.lineWidth = w; ctx.stroke();
    if (f.pkind === "mogul") { ctx.setLineDash([w * 0.6, w * 0.5]); ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = w * 0.35; ctx.stroke(); ctx.setLineDash([]); }
    path(ictx, f.pts, false); ictx.strokeStyle = idColor(f.id); ictx.lineWidth = w + 10; ictx.stroke();
  }
  const tex = new THREE.CanvasTexture(cc); tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const itex = new THREE.CanvasTexture(ic); itex.magFilter = itex.minFilter = THREE.NearestFilter; itex.generateMipmaps = false;
  return { tex, itex, idData: ictx.getImageData(0, 0, cw, ch), cw, ch };
}

function buildLifts(d) {
  const g = new THREE.Group();
  liftPicks = []; liftMats = [];
  const cableMat = new THREE.MeshBasicMaterial({ color: 0xdde4f1, transparent: true, opacity: 1 });
  const gondolaMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
  const pylonMat = new THREE.MeshBasicMaterial({ color: 0x8794ad, transparent: true, opacity: 1 });
  const stationMat = new THREE.MeshBasicMaterial({ color: 0xe6ecf7, transparent: true, opacity: 1 });
  liftMats.push(cableMat, gondolaMat, pylonMat, stationMat);
  const pylons = [];
  const stationGeo = new THREE.CylinderGeometry(11, 13, 5, 10);
  for (const f of feats) {
    if (f.kind !== "lift") continue;
    const big = f.lkind === "gondola" || f.lkind === "cable_car";
    const cableH = big ? 16 : 11;
    const pts = f.pts.map((p, i) => new THREE.Vector3(p[0], elevAt(p[0], p[1]) + (i === 0 || i === f.pts.length - 1 ? 7 : cableH), -p[1]));
    if (pts.length < 2) continue;
    const path = new THREE.CurvePath();
    for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
    const segs = Math.max(8, pts.length * 4);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(path, segs, big ? 3.2 : 2.2, 6, false), big ? gondolaMat : cableMat);
    g.add(tube);
    const pick = new THREE.Mesh(new THREE.TubeGeometry(path, segs, 16, 5, false), new THREE.MeshBasicMaterial({ visible: false }));
    pick.userData.id = f.id; liftPicks.push(pick); g.add(pick);
    for (const p of [pts[0], pts[pts.length - 1]]) { const s = new THREE.Mesh(stationGeo, stationMat); s.position.copy(p).y -= 4; g.add(s); }
    // 지주: 150m 간격
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = a.distanceTo(b);
      for (let s = 150 - acc; s < L; s += 150) { const p = a.clone().lerp(b, s / L); const ground = elevAt(p.x, -p.z); pylons.push([p.x, ground, p.z, p.y - ground]); }
      acc = (acc + L) % 150;
    }
    f.mid = pts[Math.floor(pts.length / 2)].clone();
    f.v3 = pts;
  }
  if (pylons.length) {
    const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.4, 1.8, 1, 5), pylonMat, pylons.length);
    const m = new THREE.Matrix4();
    pylons.forEach(([x, y, z, h], i) => { m.makeScale(1, h, 1); m.setPosition(x, y + h / 2, z); im.setMatrixAt(i, m); });
    g.add(im);
  }
  return g;
}

function clearScene() {
  if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); }
  if (liftGroup) { scene.remove(liftGroup); liftGroup.traverse((o) => { o.geometry?.dispose?.(); }); }
  terrainMat.uniforms.uOverlay.value?.dispose(); terrainMat.uniforms.uId.value?.dispose();
  terrain = liftGroup = null;
}

function nameOf(f) {
  if (f.kind === "lift") {
    const type = LIFT[f.lkind] || "리프트";
    return { main: f.ko || f.en || f.ja || type, sub: f.ja && f.ja !== f.ko ? f.ja : f.en || (f.ko ? type : "이름 미등록 · " + type) };
  }
  const D = DIFF[f.difficulty].ko;
  const kind = KIND[f.pkind] ? ` · ${KIND[f.pkind]}` : "";
  if (f.ko) return { main: f.ko, sub: (f.ja && f.ja !== f.ko ? f.ja : f.en || "") };
  if (f.en) return { main: f.en, sub: f.ja || "" };
  if (f.ja) return { main: f.ja, sub: "" };
  return { main: `${D} ${f.area ? "구역" : "코스"}${kind}`, sub: "이름 미등록 (OSM)" };
}

function prepareFeatures(d) {
  feats = []; byId = new Map();
  let id = 1;
  for (const p of d.pistes) {
    const f = { ...p, kind: "piste", pkind: p.kind, osm: p.id, id: id++ };
    feats.push(f); byId.set(f.id, f);
  }
  for (const l of d.lifts) {
    const f = { ...l, kind: "lift", lkind: l.kind, osm: l.id, id: id++, difficulty: "lift" };
    feats.push(f); byId.set(f.id, f);
  }
  for (const f of feats) {
    const n = nameOf(f); f.main = n.main; f.sub = n.sub;
    const c = f.pts[Math.floor(f.pts.length / 2)];
    f.mid = new THREE.Vector3(c[0], yOf(c[2]) + 20, -c[1]);
    let r = 0; for (const p of f.pts) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1]));
    f.radius = Math.max(120, r);
    f.listed = f.kind === "lift" || !f.area || (f.named && !d.pistes.some((q) => !q.area && q.named && (q.ja === f.ja || (q.en && q.en === f.en))));
  }
}

async function loadResort(slug) {
  if (cache.has(slug)) return cache.get(slug);
  const res = await fetch(`data/${slug}.json`);
  if (!res.ok) throw new Error(`${slug} 데이터 ${res.status}`);
  const d = await res.json(); cache.set(slug, d); return d;
}

function mountResort(d) {
  clearScene();
  current = d;
  yOf = (z) => d.grid.hMin + (z - d.grid.hMin) * EXAG;
  prepareFeatures(d);
  const t = buildTerrain(d);
  terrain = t.mesh; scene.add(terrain);
  const ov = paintOverlay(d, t);
  overlayCtx = ov; idData = ov.idData;
  terrainMat.uniforms.uOverlay.value = ov.tex; terrainMat.uniforms.uId.value = ov.itex;
  terrainMat.uniforms.uHMin.value = d.grid.hMin; terrainMat.uniforms.uHMax.value = d.grid.hMax;
  liftGroup = buildLifts(d); scene.add(liftGroup);

  // 카메라 기준: 코스 전체 바운딩
  const box = new THREE.Box3();
  for (const f of feats) for (const p of f.pts) box.expandByPoint(new THREE.Vector3(p[0], yOf(p[2]), -p[1]));
  const center = box.getCenter(new THREE.Vector3());
  let r = 0; for (const f of feats) for (const p of f.pts) r = Math.max(r, center.distanceTo(new THREE.Vector3(p[0], yOf(p[2]), -p[1])));
  const s = d.summary;
  const up = new THREE.Vector3(s.topPt[0] - s.basePt[0], 0, -(s.topPt[1] - s.basePt[1])).normalize();
  const fitPts = new Float32Array(feats.reduce((n, f) => n + f.pts.length, 0) * 3);
  let q = 0; for (const f of feats) for (const p of f.pts) { fitPts[q++] = p[0]; fitPts[q++] = yOf(p[2]); fitPts[q++] = -p[1]; }
  world = { center, radius: r, target: center.clone(), upDir: up, hMin: d.grid.hMin, hMax: d.grid.hMax, yMin: yOf(d.grid.hMin), yMax: yOf(d.grid.hMax), step: d.grid.step, bounds: { minX: t.minX, maxX: t.minX + t.W, minY: t.minY, maxY: t.maxY }, fitPts };
  cam.minDist = Math.max(150, r * 0.1); cam.maxDist = r * 6; // 10m 격자라 꽤 가까이까지 허용 (카메라는 지표 위 30m 유지)
  terrainMat.uniforms.uFogNear.value = r * 2.2; terrainMat.uniforms.uFogFar.value = r * 7;

  setHot(null); setSel(null);
  renderUI();
  touched = false; lastInput = performance.now();
  const home = homeView();
  if (reduceMotion()) { Object.assign(cam, home); cam.target.copy(home.target); reveal = { v: 1.2, from: 1.2, to: 1.2, t0: 0, dur: 1 }; }
  else {
    Object.assign(cam, { theta: home.theta - 0.5, phi: home.phi - 0.25, dist: home.dist * 1.7 }); cam.target.copy(home.target);
    flyTo(home, 2000);
    reveal = { v: -0.1, from: -0.1, to: 1.2, t0: performance.now() + 150, dur: 1900 };
    for (const m of liftMats) m.opacity = 0;
  }
  needsRender = true;
}

// ── 카메라 ──────────────────────────────────────────────
function homeView() {
  // 베이스 쪽에서 정상을 바라보는 방향: 카메라 = target - upDir * d
  const theta = Math.atan2(-world.upDir.x, -world.upDir.z);
  return fitView(theta, camera.aspect < 1 ? 1.0 : 1.08, world.center);
}
// 히어로·도크를 뺀 화면 영역에 코스 전체가 들어오도록 거리와 중심을 맞춘다 (투영 기반, 4회 반복)
const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _p = new THREE.Vector3();
function fitView(theta, phi, target) {
  const narrow = innerWidth < 760;
  const topPx = narrow ? $("#hero").getBoundingClientRect().bottom + 8 : document.querySelector(".topbar").getBoundingClientRect().bottom + 24;
  const dock = $("#dock").getBoundingClientRect();
  const top = 1 - (2 * topPx) / innerHeight, bottom = -1 + (2 * (innerHeight - dock.top + 10)) / innerHeight;
  const side = narrow ? 0.94 : 0.88;
  const want = { cx: 0, cy: (top + bottom) / 2, rx: side, ry: Math.max(0.2, (top - bottom) / 2) };
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  let dist = clamp(world.radius * 2, cam.minDist, cam.maxDist);
  const tgt = target.clone();
  const pts = world.fitPts;
  for (let it = 0; it < 5; it++) {
    placeCamera(theta, phi, dist, tgt);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      _p.set(pts[i], pts[i + 1], pts[i + 2]).project(camera);
      if (_p.x < minX) minX = _p.x; if (_p.x > maxX) maxX = _p.x; if (_p.y < minY) minY = _p.y; if (_p.y > maxY) maxY = _p.y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
    const k = Math.max(rx / want.rx, ry / want.ry);
    const halfH = dist * Math.tan(vfov / 2), halfW = halfH * camera.aspect;
    _right.setFromMatrixColumn(camera.matrixWorld, 0); _up.setFromMatrixColumn(camera.matrixWorld, 1);
    tgt.addScaledVector(_right, (cx - want.cx) * halfW).addScaledVector(_up, (cy - want.cy) * halfH);
    dist = clamp(dist * k, cam.minDist, cam.maxDist);
  }
  return { theta, phi, dist, target: tgt };
}
function placeCamera(theta, phi, dist, target) {
  const sp = Math.sin(phi), x = target.x + dist * sp * Math.sin(theta), z = target.z + dist * sp * Math.cos(theta), y = target.y + dist * Math.cos(phi);
  camera.position.set(x, y, z); camera.lookAt(target); camera.updateMatrixWorld();
}
function applyCamera() {
  placeCamera(cam.theta, cam.phi, cam.dist, cam.target);
  // 가까이 확대했을 때 카메라가 산 속으로 들어가지 않도록 지표 위 30m 는 유지
  const ground = elevAt(camera.position.x, -camera.position.z) + 30;
  if (camera.position.y < ground) { camera.position.y = ground; camera.lookAt(cam.target); camera.updateMatrixWorld(); }
  terrainMat.uniforms.uCam.value.copy(camera.position);
  $("#compassNeedle").style.transform = `rotate(${(-cam.theta * 180) / Math.PI}deg)`;
}
function flyTo(to, dur = 800) {
  camAnim = { from: { theta: cam.theta, phi: cam.phi, dist: cam.dist, target: cam.target.clone() }, to: { ...to, target: to.target.clone() }, t0: performance.now(), dur: reduceMotion() ? 1 : dur };
  // 가장 짧은 회전 방향
  let dt = ((to.theta - cam.theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  camAnim.to.theta = cam.theta + dt;
  needsRender = true;
}
function focusFeature(f) {
  const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const d = clamp((f.radius * 1.6) / Math.sin(Math.min(vfov, hfov) / 2), cam.minDist, cam.maxDist);
  flyTo({ theta: cam.theta, phi: Math.min(cam.phi, 1.05), dist: Math.min(cam.dist, d), target: f.mid.clone() }, 700);
}
function stepCamera(now) {
  if (camAnim) {
    const k = easeOutExpo((now - camAnim.t0) / camAnim.dur);
    cam.theta = lerp(camAnim.from.theta, camAnim.to.theta, k); cam.phi = lerp(camAnim.from.phi, camAnim.to.phi, k); cam.dist = lerp(camAnim.from.dist, camAnim.to.dist, k);
    cam.target.lerpVectors(camAnim.from.target, camAnim.to.target, k);
    if (k >= 1) camAnim = null;
    needsRender = true;
  } else if (!touched && !reduceMotion() && !sel && !hot && now - lastInput > 5000 && document.visibilityState === "visible") {
    // 손대기 전까지만 천천히 돈다 (한 바퀴 약 2분). 한 번이라도 만지면 멈춘다
    cam.theta += 0.0008 * Math.min(1, (now - lastInput - 5000) / 2000); needsRender = true;
  }
}

// ── 입력 ────────────────────────────────────────────────
const pointers = new Map();
let drag = null, pinch0 = null, hoverRaf = 0;
function markInput() { lastInput = performance.now(); camAnim = null; touched = true; }
canvas.addEventListener("pointerdown", (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, type: e.pointerType };
  else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    placeCamera(cam.theta, cam.phi, cam.dist, cam.target);
    // 시작 시점의 거리·각도·손가락 중점 아래 지면(anchor)을 기억해 두고, 이후엔 anchor 가 항상 손가락 중점 아래에 오도록 맞춘다
    pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x), dist: cam.dist, theta: cam.theta, targetY: cam.target.y, anchor: terrainAt(cx, cy) ?? groundPoint(cx, cy) };
    drag = null;
  }
  markInput();
});
canvas.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinch0) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    cam.dist = clamp((pinch0.dist * pinch0.d) / Math.max(10, d), cam.minDist, cam.maxDist); // 벌리면 확대
    let da = Math.atan2(b.y - a.y, b.x - a.x) - pinch0.angle; da = Math.atan2(Math.sin(da), Math.cos(da));
    cam.theta = pinch0.theta + da; // 비틀면 같은 방향으로 회전 (측정으로 부호 확인)
    if (pinch0.anchor) cam.target.y = lerp(pinch0.targetY, pinch0.anchor.y, clamp(1 - cam.dist / pinch0.dist, 0, 1)); // 확대할수록 시점 높이를 손가락 아래 지면에 맞춤
    panToAnchor(cx, cy);
    markInput(); needsRender = true; return;
  }
  if (drag && pointers.size === 1) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) { drag.moved = true; canvas.classList.add("is-drag"); if (hot) setHot(null); }
    if (drag.moved) { cam.theta -= dx * 0.0055; cam.phi = clamp(cam.phi - dy * 0.0045, 0.2, 1.42); markInput(); needsRender = true; }
    drag.x = e.clientX; drag.y = e.clientY;
    return;
  }
  if (finePointer.matches && pointers.size === 0) {
    const x = e.clientX, y = e.clientY;
    cancelAnimationFrame(hoverRaf);
    hoverRaf = requestAnimationFrame(() => { const f = pickAt(x, y); setHot(f, "scene"); if (f) placeTip(x, y); });
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch0 = null;
  if (drag && e.type === "pointerup" && !drag.moved && performance.now() - drag.t0 < 500 && pointers.size === 0) {
    const f = pickAt(e.clientX, e.clientY);
    if (f) { setSel(f.id === sel?.id ? null : f); if (f.id === sel?.id) focusFeature(f); }
    else setSel(null);
    if (!finePointer.matches) setHot(null);
  }
  if (pointers.size === 0) { drag = null; canvas.classList.remove("is-drag"); }
  markInput();
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => { if (finePointer.matches && pointers.size === 0) setHot(null); });
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  // 커서 아래 지면을 향해 확대: 시점(target)을 그 지점 쪽으로 거리 비율만큼 끌어온다 → 확대할수록 시점이 산 표면에 놓인다
  const next = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), cam.minDist, cam.maxDist);
  const g = terrainAt(e.clientX, e.clientY);
  if (g) { const k = next / cam.dist; cam.target.lerpVectors(g, cam.target, k); }
  cam.dist = next; markInput(); needsRender = true;
}, { passive: false });
// 화면 좌표 아래의 실제 지표 점 (없으면 null)
function terrainAt(x, y) {
  placeCamera(cam.theta, cam.phi, cam.dist, cam.target);
  const rect = canvas.getBoundingClientRect();
  ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return marchTerrain(raycaster.ray);
}
// 화면 좌표 → 시점 높이의 수평면과 만나는 월드 점
function groundPoint(x, y, planeY = cam.target.y) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const ray = raycaster.ray, t = (planeY - ray.origin.y) / ray.direction.y;
  return t > 0 ? ray.origin.clone().addScaledVector(ray.direction, t) : null;
}
// 두 손가락 이동·확대·회전 뒤: 제스처 시작 때 손가락 중점 아래 있던 지면(anchor)이 지금 중점 아래에 오도록 시점을 옮긴다
function panToAnchor(cx, cy) {
  if (!pinch0?.anchor) return;
  placeCamera(cam.theta, cam.phi, cam.dist, cam.target);
  const b = groundPoint(cx, cy, pinch0.anchor.y);
  if (!b) return;
  cam.target.x += pinch0.anchor.x - b.x; cam.target.z += pinch0.anchor.z - b.z;
  const bd = world.bounds; if (bd) { cam.target.x = clamp(cam.target.x, bd.minX, bd.maxX); cam.target.z = clamp(cam.target.z, -bd.maxY, -bd.minY); }
}
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea")) return;
  const k = e.key;
  if (k === "Escape") { setSel(null); setHot(null); return; }
  if (k === "ArrowLeft" || k === "ArrowRight") { cam.theta += (k === "ArrowLeft" ? -1 : 1) * 0.12; markInput(); needsRender = true; e.preventDefault(); }
  if (k === "ArrowUp" || k === "ArrowDown") { cam.phi = clamp(cam.phi + (k === "ArrowUp" ? -1 : 1) * 0.08, 0.2, 1.42); markInput(); needsRender = true; e.preventDefault(); }
  if (k === "+" || k === "=") { cam.dist = clamp(cam.dist * 0.85, cam.minDist, cam.maxDist); markInput(); needsRender = true; }
  if (k === "-") { cam.dist = clamp(cam.dist / 0.85, cam.minDist, cam.maxDist); markInput(); needsRender = true; }
});

// ── 피킹 ────────────────────────────────────────────────
const ndc = new THREE.Vector2();
// 높이 격자와 광선의 교점 — 삼각형 30만 개를 다 검사하는 대신, 격자 상자 안을 반 칸씩 전진하다 지표 아래로 들어가면 이분법으로 다듬는다
const _m = new THREE.Vector3();
function marchTerrain(ray) {
  const b = world.bounds; if (!b) return null;
  const o = ray.origin, d = ray.direction;
  const lo = [b.minX, world.yMin - 5, -b.maxY], hi = [b.maxX, world.yMax + 5, -b.minY];
  let tmin = 0, tmax = 1e6;
  for (const [i, k] of [[0, "x"], [1, "y"], [2, "z"]]) {
    const inv = 1 / d[k]; let t0 = (lo[i] - o[k]) * inv, t1 = (hi[i] - o[k]) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
  }
  if (!(tmax >= tmin)) return null;
  const step = world.step * 0.5;
  let prev = tmin;
  for (let t = tmin; t <= tmax + step; t += step) {
    const tt = Math.min(t, tmax);
    _m.copy(o).addScaledVector(d, tt);
    if (_m.y <= elevAt(_m.x, -_m.z)) {
      let a = prev, c = tt;
      for (let i = 0; i < 10; i++) { const mid = (a + c) / 2; _m.copy(o).addScaledVector(d, mid); if (_m.y > elevAt(_m.x, -_m.z)) a = mid; else c = mid; }
      return _m.copy(o).addScaledVector(d, (a + c) / 2).clone();
    }
    prev = tt;
    if (tt === tmax) break;
  }
  return null;
}
function pickAt(x, y) {
  if (!terrain) return null;
  const rect = canvas.getBoundingClientRect();
  ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const tp = marchTerrain(raycaster.ray);
  const tDist = tp ? tp.distanceTo(raycaster.ray.origin) : Infinity;
  const lh = liftPicks.length ? raycaster.intersectObjects(liftPicks, false) : [];
  if (lh.length && lh[0].distance <= tDist + 40) return byId.get(lh[0].object.userData.id) || null; // 케이블은 지면 위에 떠 있으니 약간의 여유
  if (!tp || !idData) return null;
  const b = world.bounds;
  const u = (tp.x - b.minX) / (b.maxX - b.minX), v = (-tp.z - b.minY) / (b.maxY - b.minY);
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const px = Math.round(u * (overlayCtx.cw - 1)), py = Math.round((1 - v) * (overlayCtx.ch - 1));
  const read = (x, y) => { if (x < 0 || y < 0 || x >= overlayCtx.cw || y >= overlayCtx.ch) return 0; const i = (y * overlayCtx.cw + x) * 4; return idData.data[i + 3] === 255 ? idData.data[i] + (idData.data[i + 1] << 8) : 0; };
  let id = read(px, py);
  for (let r = 1; !id && r <= 3; r++) for (let dy = -r; !id && dy <= r; dy++) for (let dx = -r; !id && dx <= r; dx++) id = read(px + dx, py + dy);
  return (id && byId.get(id)) || null;
}

// ── 상태 → UI ────────────────────────────────────────────
function setHot(f, src = "scene") {
  if ((f?.id || null) === (hot?.id || null)) { hotSrc = src; return; }
  if (hot) $(`.run[data-id="${hot.id}"]`)?.classList.remove("is-hot");
  hot = f; hotSrc = src;
  terrainMat.uniforms.uHover.value = f?.id || 0;
  canvas.classList.toggle("is-hot", !!f);
  if (f) $(`.run[data-id="${f.id}"]`)?.classList.add("is-hot");
  const tip = $("#tip");
  if (f && finePointer.matches && src === "scene") { tip.innerHTML = tipHTML(f); tip.hidden = false; } else tip.hidden = true;
  needsRender = true;
}
function setSel(f) {
  if ((f?.id || null) === (sel?.id || null)) return;
  if (sel) $(`.run[data-id="${sel.id}"]`)?.classList.remove("is-sel");
  sel = f;
  terrainMat.uniforms.uSel.value = f?.id || 0;
  const detail = $("#detail"), legend = $("#legend");
  if (f) {
    const row = $(`.run[data-id="${f.id}"]`);
    row?.classList.add("is-sel"); row?.scrollIntoView({ block: "nearest", inline: "center", behavior: reduceMotion() ? "auto" : "smooth" });
    $("#dMark").className = `d-mark ${f.difficulty}`;
    $("#dName").textContent = f.main; $("#dSub").textContent = f.sub;
    $("#dStats").innerHTML = statsHTML(f);
    detail.hidden = false; legend.hidden = true; detail.classList.remove("enter"); void detail.offsetWidth; detail.classList.add("enter");
    $("#dock").classList.remove("collapsed"); $("#dockToggle").setAttribute("aria-expanded", "true");
  } else { detail.hidden = true; legend.hidden = false; }
  lastInput = performance.now(); needsRender = true; layoutDock();
}
function statsHTML(f) {
  const rows = [];
  if (f.kind === "lift") {
    rows.push(["종류", LIFT[f.lkind] || f.lkind], ["길이", dist(f.len)], ["표고", `${fmt(f.bottom)} → ${fmt(f.top)}m`], ["표고차", `${fmt(f.top - f.bottom)}m`]);
    if (f.occupancy) rows.push(["인승", `${f.occupancy}인`]);
  } else {
    rows.push(["난이도", DIFF[f.difficulty].ko + (KIND[f.pkind] ? ` · ${KIND[f.pkind]}` : "")]);
    if (f.area) rows.push(["형태", "구역 (면)"]); else rows.push(["길이", dist(f.len)]);
    rows.push(["표고차", `${fmt(f.drop)}m`], ["표고", `${fmt(f.top)} → ${fmt(f.bottom)}m`]);
    if (!f.area && f.grade != null) rows.push(["평균 경사", `${f.grade}%`]);
  }
  return rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
}
function tipHTML(f) {
  const s = f.kind === "lift" ? `<span><b>${esc(LIFT[f.lkind] || "리프트")}</b></span><span>${esc(dist(f.len))}</span><span>↑ ${fmt(f.top - f.bottom)}m</span>`
    : `<span><b>${esc(DIFF[f.difficulty].ko)}</b></span>${f.area ? "<span>구역</span>" : `<span>${esc(dist(f.len))}</span>`}<span>↓ ${fmt(f.drop)}m</span>${!f.area && f.grade != null ? `<span>${f.grade}%</span>` : ""}`;
  return `<b><i class="${esc(f.difficulty)}"></i>${esc(f.main)}</b>${f.sub ? `<span class="t-sub">${esc(f.sub)}</span>` : ""}<span class="t-stats">${s}</span>`;
}
function placeTip(x, y) {
  const tip = $("#tip"); if (tip.hidden) return;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const px = x + 16 + w > innerWidth - 8 ? x - w - 14 : x + 16, py = y + 18 + h > innerHeight - 8 ? y - h - 12 : y + 18;
  tip.style.setProperty("--x", `${px}px`); tip.style.setProperty("--y", `${py}px`);
}

function renderUI() {
  const d = current, s = d.summary;
  // 히어로
  const hero = $("#hero");
  $("#heroSr").textContent = d.ko;
  $("#heroVis").innerHTML = d.ko.split(" ").map((w, i) => `<span class="w"><span style="--i:${i}">${esc(w)}</span></span>`).join(" ");
  $("#heroJa").textContent = `${d.ja} · ${d.en}`;
  const longest = s.longest ? feats.find((f) => f.osm === s.longest.id) : null;
  $("#heroSub").innerHTML = `정상 <b class="num">${fmt(s.top)}m</b>에서 베이스 <b>${fmt(s.base)}m</b>까지, <b>${fmt(s.drop)}m</b>를 내려오는 코스 <b>${s.runs}개</b>와 리프트 <b>${s.lifts}기</b>.`;
  $("#heroNote").textContent = longest ? `가장 긴 코스는 ${longest.main} ${dist(longest.len)}. 초급 ${s.counts.easy} · 중급 ${s.counts.intermediate} · 상급 ${s.counts.advanced}` : "";
  hero.classList.remove("enter"); void hero.offsetWidth; hero.classList.add("enter");
  // 표식
  $("#markTop b").textContent = `${fmt(s.top)}m`; $("#markBase b").textContent = `${fmt(s.base)}m`;
  $("#markTop").hidden = $("#markBase").hidden = false;
  // 상단 칩
  for (const b of document.querySelectorAll("#resorts button")) b.setAttribute("aria-pressed", String(b.dataset.slug === d.slug));
  // 레일
  const order = { easy: 0, intermediate: 1, advanced: 2, unknown: 3 };
  const runs = feats.filter((f) => f.kind === "piste" && f.listed).sort((a, b) => order[a.difficulty] - order[b.difficulty] || b.len - a.len);
  const lifts = feats.filter((f) => f.kind === "lift").sort((a, b) => b.len - a.len);
  const row = (f) => `<li><button type="button" class="run ${esc(f.difficulty)}" data-id="${f.id}" aria-label="${esc(f.main)} ${esc(f.kind === "lift" ? LIFT[f.lkind] || "리프트" : DIFF[f.difficulty].ko)}"><i></i><b>${esc(f.main)}${f.sub ? `<small>${esc(f.sub)}</small>` : ""}</b><em>${f.kind === "lift" ? `${esc(LIFT[f.lkind] || "리프트")} · ${esc(dist(f.len))} · ↑${fmt(f.top - f.bottom)}m` : f.area ? `${esc(DIFF[f.difficulty].ko)} 구역 · ↓${fmt(f.drop)}m` : `${esc(dist(f.len))} · ↓${fmt(f.drop)}m${f.grade != null ? ` · ${f.grade}%` : ""}`}</em></button></li>`;
  $("#rail").innerHTML = runs.map(row).join("") + (lifts.length ? `<li class="sep" aria-hidden="true"></li>` : "") + lifts.map(row).join("");
  $("#rail").scrollLeft = 0;
  $("#legendHint").textContent = finePointer.matches ? "슬로프에 마우스를 올리면 이름이, 클릭하면 상세가 떠요" : "";
  document.title = `${d.short} — 오타루 슬로프`;
  layoutDock();
}
function layoutDock() {
  document.body.classList.add("has-dock");
  document.documentElement.style.setProperty("--dock-h", `${$("#dock").offsetHeight}px`);
}

// 레일 상호작용
const rail = $("#rail");
rail.addEventListener("pointerover", (e) => { const b = e.target.closest(".run"); if (b && finePointer.matches) setHot(byId.get(Number(b.dataset.id)), "rail"); });
rail.addEventListener("pointerleave", () => { if (hotSrc === "rail") setHot(null, "rail"); });
rail.addEventListener("click", (e) => {
  const b = e.target.closest(".run"); if (!b) return;
  const f = byId.get(Number(b.dataset.id)); if (!f) return;
  if (sel?.id === f.id) { focusFeature(f); return; }
  setSel(f); focusFeature(f);
});
$("#dClose").addEventListener("click", () => setSel(null));
$("#dockToggle").addEventListener("click", () => { const d = $("#dock"); d.classList.toggle("collapsed"); const open = !d.classList.contains("collapsed"); $("#dockToggle").setAttribute("aria-expanded", String(open)); $("#dockToggle").setAttribute("aria-label", open ? "목록 접기" : "목록 펼치기"); layoutDock(); });
$("#railPrev").addEventListener("click", () => rail.scrollBy({ left: -rail.clientWidth * 0.8, behavior: "smooth" }));
$("#railNext").addEventListener("click", () => rail.scrollBy({ left: rail.clientWidth * 0.8, behavior: "smooth" }));
$("#resetView").addEventListener("click", () => { setSel(null); flyTo(homeView(), 900); });
$("#compass").addEventListener("click", () => { flyTo({ theta: 0, phi: cam.phi, dist: cam.dist, target: cam.target }, 700); });
$("#brandHome").addEventListener("click", (e) => { e.preventDefault(); setSel(null); flyTo(homeView(), 900); });

// ── 리조트 전환 ───────────────────────────────────────────
let loading = null;
async function go(slug, push = true) {
  const r = index.resorts.find((x) => x.slug === slug);
  if (!r || (current && current.slug === r.slug && !loading)) return; // 모르는 해시·빈 해시는 무시
  if (push) history.replaceState(null, "", `#${r.slug}`);
  for (const b of document.querySelectorAll("#resorts button")) b.setAttribute("aria-pressed", String(b.dataset.slug === r.slug));
  const my = (loading = r.slug);
  $("#hero").classList.add("is-quiet");
  try {
    const d = await loadResort(r.slug);
    if (loading !== my) return;
    mountResort(d);
    $("#hero").classList.remove("is-quiet");
  } catch (err) {
    console.error(err);
    toast(`${r.ko} 데이터를 불러오지 못했어요`);
    $("#hero").classList.remove("is-quiet");
  } finally { if (loading === my) loading = null; }
}

let toastTimer = 0;
function toast(msg, ms = 4200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false; t.classList.remove("out");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.add("out"); setTimeout(() => (t.hidden = true), 420); }, ms);
}

// ── 프레임 ──────────────────────────────────────────────
const markTop = $("#markTop"), markBase = $("#markBase"), v3 = new THREE.Vector3();
function placeMark(el, p) {
  v3.set(p[0], yOf(p[2]), -p[1]).project(camera);
  const back = v3.z > 1;
  el.classList.toggle("is-back", back);
  if (!back) el.style.transform = `translate(calc(${((v3.x + 1) / 2) * innerWidth}px - 50%), calc(${((1 - v3.y) / 2) * innerHeight}px - 100%))`;
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w < h ? 56 : 48; camera.updateProjectionMatrix(); needsRender = true; layoutDock();
  if (terrain && !touched && !camAnim) { const home = homeView(); Object.assign(cam, { theta: home.theta, phi: home.phi, dist: home.dist }); cam.target.copy(home.target); }
}
addEventListener("resize", resize);
function frame(now) {
  requestAnimationFrame(frame);
  if (!terrain) return;
  stepCamera(now);
  if (reveal.v < 1.2) {
    const k = easeOut((now - reveal.t0) / reveal.dur);
    reveal.v = now < reveal.t0 ? reveal.from : lerp(reveal.from, reveal.to, k);
    terrainMat.uniforms.uReveal.value = reveal.v;
    for (const m of liftMats) m.opacity = clamp((reveal.v - 0.1) * 1.4, 0, 1);
    needsRender = true;
  }
  const pulse = hot || sel;
  if (pulse) { terrainMat.uniforms.uTime.value = clock.getElapsedTime(); needsRender = true; }
  if (!needsRender) return;
  needsRender = false;
  applyCamera();
  renderer.render(scene, camera);
  placeMark(markTop, current.summary.topPt); placeMark(markBase, current.summary.basePt);
}

// ── 시작 ────────────────────────────────────────────────
async function init() {
  resize();
  try {
    const res = await fetch("data/resorts.json");
    Object.assign(index, await res.json());
  } catch (e) { toast("스키장 목록을 불러오지 못했어요"); return; }
  // 오타루 근교 / 니세코 유나이티드 사이에 구분선
  $("#resorts").innerHTML = index.resorts.map((r, i) => `${i > 0 && r.group !== index.resorts[i - 1].group ? `<i class="sep" aria-hidden="true"></i>` : ""}<button type="button" data-slug="${esc(r.slug)}" aria-pressed="false">${esc(r.short)}<small>${r.summary.runs}</small></button>`).join("");
  $("#resorts").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) go(b.dataset.slug); });
  addEventListener("hashchange", () => go(location.hash.slice(1), false));
  $("#dock").classList.add("enter");
  const first = location.hash.slice(1);
  await go(index.resorts.some((r) => r.slug === first) ? first : "kiroro", false);
  requestAnimationFrame(frame);
  if (!store.get("hint")) {
    setTimeout(() => toast(finePointer.matches ? "드래그로 돌리고 휠로 확대 · 슬로프를 클릭하면 상세가 떠요" : "한 손가락으로 돌리고 두 손가락으로 확대 · 슬로프를 탭해 보세요", 6000), 2600);
    store.set("hint", "1");
  }
}
init();

// 개발·검증용 훅 (콘솔): __slopes.screen(id) → 코스 중간점의 화면 좌표
window.__slopes = {
  get feats() { return feats; }, get sel() { return sel; }, get hot() { return hot; }, get cam() { return cam; }, go,
  touch() { markInput(); }, pick: pickAt, yOf: (z) => yOf(z),
  project(x, y, z) { const p = new THREE.Vector3(x, y, z).project(camera); return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, behind: p.z > 1 }; },
  march(x, y) { const r = canvas.getBoundingClientRect(); ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); raycaster.setFromCamera(ndc, camera); return marchTerrain(raycaster.ray); },
  screen(id) { const f = byId.get(id); if (!f) return null; const p = f.mid.clone().project(camera); return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight, name: f.main }; },
};
