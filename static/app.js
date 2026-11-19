/* Skylog — offline night sky observation logger (frontend) */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const D2R = Math.PI / 180;
const pad = n => String(n).padStart(2, "0");
const store = {
  get(k, d) { try { const v = localStorage.getItem("skylog:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("skylog:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------------ state */
const LAYERS = [
  { key: "stars",   label: "Stars",               color: "#ffffff", on: true,  op: 1 },
  { key: "planets", label: "Planets",             color: "#ff9d6b", on: true,  op: 1 },
  { key: "dsos",    label: "Deep-sky objects",    color: "#7ee0c8", on: true,  op: 0.9 },
  { key: "faint",   label: "Stars below limit",   color: "#5b6286", on: true,  op: 0.35 },
  { key: "lines",   label: "Constellation lines", color: "#7d8cff", on: true,  op: 0.7 },
  { key: "cnames",  label: "Constellation names", color: "#b9c1ff", on: true,  op: 0.8 },
  { key: "snames",  label: "Star names",          color: "#f5c86a", on: true,  op: 0.75 },
  { key: "grid",    label: "Alt/Az grid",         color: "#3d4a7a", on: false, op: 0.4 },
  { key: "horizon", label: "Horizon & compass",   color: "#9aa3c7", on: true,  op: 0.9 },
  { key: "sunmoon", label: "Sun & Moon",          color: "#f0e6c8", on: true,  op: 1 },
];
const savedLayers = store.get("layers", {});

const state = {
  lat: 51.5074, lon: -0.1278, place: "London, UK", tz: -new Date().getTimezoneOffset() / 60,
  date: "", minutes: 540, bortle: 5,
  layers: Object.fromEntries(LAYERS.map(l => [l.key, { on: l.on, op: l.op, ...(savedLayers[l.key] || {}) }])),
  highlightLogged: store.get("hlLogged", false),
  showLogged: store.get("showLogged", true),
  filter: "good", search: "",
  view: { zoom: 1, px: 0, py: 0 },
  sky: null,
  session: null,
  history: [],
  dirty: false,
  selected: null, // {kind, ref}
};
Object.assign(state, store.get("inputs", {}));

/* --------------------------------------------------------------- helpers */
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2400);
}
function localClock(minutes) { const m = (720 + minutes) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
function utcFromInputs() {
  const [y, mo, d] = state.date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 12, 0) + state.minutes * 60e3 - state.tz * 3600e3);
}
function nowToInputs() {
  const shifted = new Date(Date.now() + state.tz * 3600e3); // "local" clock at site, in UTC fields
  let h = shifted.getUTCHours(), mi = shifted.getUTCMinutes();
  const night = new Date(shifted);
  if (h < 12) { night.setUTCDate(night.getUTCDate() - 1); h += 24; }
  state.date = `${night.getUTCFullYear()}-${pad(night.getUTCMonth() + 1)}-${pad(night.getUTCDate())}`;
  state.minutes = Math.round(((h - 12) * 60 + mi) / 5) * 5;
}
function fmtLat(v) { return `${Math.abs(v).toFixed(2)}°${v >= 0 ? "N" : "S"}`; }
function fmtLon(v) { return `${Math.abs(v).toFixed(2)}°${v >= 0 ? "E" : "W"}`; }
function compass(az) { return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(az / 22.5) % 16]; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function starLabel(s) { return s.name || (s.bayer ? `${s.bayer} ${s.con}` : `HIP ${s.hip}`); }
function bvColor(bv) {
  const stops = [[-0.4, [155, 176, 255]], [0, [202, 215, 255]], [0.4, [248, 247, 255]], [0.6, [255, 244, 234]], [1.0, [255, 214, 165]], [1.5, [255, 178, 98]], [2.0, [255, 140, 60]]];
  bv = Math.max(-0.4, Math.min(2, bv));
  for (let i = 1; i < stops.length; i++) if (bv <= stops[i][0]) {
    const [x0, c0] = stops[i - 1], [x1, c1] = stops[i], t = (bv - x0) / (x1 - x0);
    return c0.map((c, j) => Math.round(c + (c1[j] - c) * t));
  }
  return stops.at(-1)[1];
}

/* ------------------------------------------------------------- data/API */
let skyAbort = null, skyTimer = null;
function requestSky(delay = 40) {
  clearTimeout(skyTimer);
  skyTimer = setTimeout(fetchSky, delay);
}
async function fetchSky() {
  if (!state.date || !isFinite(state.lat) || !isFinite(state.lon)) return;
  skyAbort?.abort(); skyAbort = new AbortController();
  $("#loading").classList.add("on");
  const q = new URLSearchParams({ lat: state.lat, lon: state.lon, utc: utcFromInputs().toISOString(), bortle: state.bortle });
  try {
    const r = await fetch("/api/sky?" + q, { signal: skyAbort.signal });
    if (!r.ok) throw new Error((await r.json()).error);
    state.sky = await r.json();
    indexSky();
    renderChips(); renderVisible(); draw(); renderChecklist();
  } catch (e) { if (e.name !== "AbortError") toast("Couldn't compute sky: " + e.message); }
  finally { $("#loading").classList.remove("on"); }
}
function indexSky() {
  const sky = state.sky;
  sky.starByHip = new Map(sky.stars.map(s => [s.hip, s]));
  sky.conById = new Map(sky.constellations.map(c => [c.id, c]));
  // the Moon is drawn by the Sun & Moon layer but can be clicked/logged like a planet
  const m = sky.moon;
  sky.bodies = [...sky.planets, { id: "moon", name: "Moon", alt: m.alt, az: m.az, mag: -12.7 + 2.5 * (1 - m.illum) * 4,
    illum: m.illum, color: "#f0e6c8", vis: m.alt > 0, isMoon: true, phase: m.phase }];
  // "near <constellation>": nearest catalogued star that has a constellation
  const vec = (alt, az) => [Math.cos(alt * D2R) * Math.sin(az * D2R), Math.cos(alt * D2R) * Math.cos(az * D2R), Math.sin(alt * D2R)];
  const starVecs = sky.stars.filter(s => s.con).map(s => [vec(s.alt, s.az), s.con]);
  for (const b of sky.bodies) {
    const v = vec(b.alt, b.az); let best = -2;
    for (const [w, con] of starVecs) { const d = v[0] * w[0] + v[1] * w[1] + v[2] * w[2]; if (d > best) { best = d; b.con = con; } }
    if (best < Math.cos(12 * D2R)) b.con = null;
  }
  sky.bodyById = new Map(sky.bodies.map(b => [b.id, b]));
  sky.dsoById = new Map(sky.dsos.map(d => [d.id, d]));
}
const DSO_COLORS = { cluster: "#9fd0ff", globular: "#ffd88a", galaxy: "#ffa8d2", nebula: "#7ee0c8", planetary: "#9ff0ff" };
const HOW_LABEL = { "naked-eye": "Naked eye", binoculars: "Binoculars", telescope: "Telescope" };
async function loadHistory() {
  try { state.history = await (await fetch("/api/observations")).json(); } catch { state.history = []; }
}

/* ------------------------------------------------------------ sessions */
function sameSite(s) { return Math.abs(s.lat - state.lat) < 0.5 && Math.abs(s.lon - state.lon) < 0.5; }
function ensureSession() {
  const cur = state.session;
  if (cur && cur.date === state.date && sameSite(cur)) { syncSessionMeta(); return; }
  if (cur && state.dirty && cur.items.length) saveSession(true);
  const existing = state.history.find(s => s.date === state.date && sameSite(s));
  state.session = existing ? structuredClone(existing) : {
    date: state.date, place: state.place, lat: state.lat, lon: state.lon, tz: state.tz,
    bortle: state.bortle, limit_mag: null, seeing: 0, transparency: 0, notes: "", items: [],
  };
  state.dirty = false;
  syncSessionMeta(); renderLog();
}
function syncSessionMeta() {
  const s = state.session; if (!s) return;
  const changed = s.bortle !== state.bortle || s.place !== state.place;
  Object.assign(s, { place: state.place, lat: state.lat, lon: state.lon, tz: state.tz, bortle: state.bortle });
  if (state.sky) s.limit_mag = state.sky.limit_mag;
  if (changed && s.items.length) markDirty();
}
function isLogged(kind, ref) { return !!state.session?.items.some(i => i.kind === kind && i.ref === ref); }
function loggedSets() {
  const cons = new Set(), stars = new Set(), planets = new Set(), dsos = new Set();
  for (const i of state.session?.items || []) ({ constellation: cons, star: stars, planet: planets, dso: dsos }[i.kind])?.add(i.ref);
  return { cons, stars, planets, dsos };
}
function mapLoggedSets() {
  // what the *map* marks as logged; empty when "Mark logged objects" is off (the log itself is untouched)
  if (!state.showLogged && !state.highlightLogged) return { cons: new Set(), stars: new Set(), planets: new Set(), dsos: new Set() };
  return loggedSets();
}
function lookup(kind, ref) {
  const sky = state.sky;
  return kind === "constellation" ? sky.conById.get(ref) : kind === "planet" ? sky.bodyById.get(ref)
    : kind === "dso" ? sky.dsoById.get(ref) : sky.starByHip.get(ref);
}
function toggleLog(kind, ref) {
  const s = state.session;
  const idx = s.items.findIndex(i => i.kind === kind && i.ref === ref);
  if (idx >= 0) { const [it] = s.items.splice(idx, 1); toast(`Removed ${it.name} from log`); }
  else {
    const obj = lookup(kind, ref);
    if (!obj) return;
    s.items.push({
      kind, ref, name: kind === "star" ? starLabel(obj) : obj.name,
      time: localClock(state.minutes), utc: utcFromInputs().toISOString(),
      alt: +obj.alt.toFixed(1), az: +obj.az.toFixed(1),
      ...(kind !== "constellation" ? { mag: +obj.mag.toFixed(1), con: obj.con || "" } : {}),
      ...(kind === "dso" ? { desig: obj.desig, type: obj.kind, seen_with: obj.how } : {}),
      notes: "",
    });
    toast(`Logged ${s.items.at(-1).name} ✦`);
  }
  markDirty(); renderLog(); renderVisible(); draw(); if (popover.cur) openPopover(popover.cur);
}
let autoSaveT = null;
function markDirty() {
  state.dirty = true; renderSaveState();
  clearTimeout(autoSaveT); autoSaveT = setTimeout(() => saveSession(true), 1500);
}
async function saveSession(quiet = false) {
  const s = state.session; if (!s) return;
  if (!s.items.length && !s.notes && !s.id) { if (!quiet) toast("Nothing to save yet — log something first"); return; }
  if (state.sky) s.limit_mag = state.sky.limit_mag;
  try {
    const r = await fetch("/api/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    const saved = await r.json();
    if (state.session === s) { s.id = saved.id; s.created = saved.created; s.updated = saved.updated; state.dirty = false; }
    state.history = [saved, ...state.history.filter(h => h.id !== saved.id)].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    renderSaveState(); renderHistory();
    if (!quiet) toast("Saved to " + (state.logFile || "observations.json"));
  } catch (e) { toast("Save failed: " + e.message); }
}

/* ============================================================ CANVAS */
const canvas = $("#sky");
let ctx = canvas.getContext("2d");   // swapped temporarily when rendering an image export
let W = 0, H = 0, DPR = 1, hitStars = [], hitLabels = [], hitBodies = [], hitDsos = [];
new ResizeObserver(() => {
  const r = canvas.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1; W = r.width; H = r.height;
  canvas.width = W * DPR; canvas.height = H * DPR; draw();
}).observe(canvas);

function geom() {
  const R = Math.min(W, H) / 2 * 0.9 * state.view.zoom;
  return { R, cx: W / 2 + state.view.px, cy: H / 2 + state.view.py };
}
function proj(alt, az, g) {
  const r = g.R * Math.tan((90 - alt) * D2R / 2);
  return [g.cx - r * Math.sin(az * D2R), g.cy - r * Math.cos(az * D2R)];
}
function skyColors() {
  const sun = state.sky?.sun.alt ?? -30, b = state.bortle;
  const t = Math.max(0, Math.min(1, (sun + 18) / 18));       // 0 night → 1 sunset
  const day = Math.max(0, Math.min(1, (sun + 2) / 8));
  const mix = (a, c, k) => a.map((v, i) => Math.round(v + (c[i] - v) * k));
  let zen = mix([0, 0, 0], [30, 48, 105], t); zen = mix(zen, [90, 150, 225], day);
  let hor = mix([0, 0, 0], [170, 105, 80], t * (1 - day)); hor = mix(hor, [170, 205, 240], day);
  const glow = (b - 1) / 8; // light-pollution dome: faint glow only near the horizon
  hor = mix(hor, [70, 48, 30], glow * 0.5 * (1 - day));
  return { zen: `rgb(${zen})`, hor: `rgb(${hor})` };
}

/* ---------- collision-free labels ---------- */
let labelQ = [];
const ZOOM_MAX = 80;
/* spatial hash so labels can avoid thousands of dots / line samples quickly */
const CELL = 24;
class BoxGrid {
  constructor() { this.m = new Map(); }
  *cells(b) {
    const x0 = Math.floor(b[0] / CELL), x1 = Math.floor((b[0] + b[2]) / CELL);
    const y0 = Math.floor(b[1] / CELL), y1 = Math.floor((b[1] + b[3]) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield (x + 4096) * 8192 + (y + 4096);
  }
  add(b) { for (const k of this.cells(b)) { let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(b); } }
  hits(b) {
    for (const k of this.cells(b)) {
      const a = this.m.get(k); if (!a) continue;
      for (const o of a) if (b[0] < o[0] + o[2] && b[0] + b[2] > o[0] && b[1] < o[1] + o[3] && b[1] + b[3] > o[1]) return true;
    }
    return false;
  }
}
let dotGrid = new BoxGrid(), lineGrid = new BoxGrid();
function zs(p) { return Math.pow(Math.min(state.view.zoom, 8), p); }   // symbol growth, capped
function pxPerDeg(alt, g) {                                             // local stereographic scale
  const c = Math.cos((90 - Math.max(alt, 0)) * D2R / 2);
  return g.R / 2 * D2R / (c * c);
}
function queueLabel(l) { labelQ.push(l); }
function addObstacle(x, y, r) { if (x > -r && y > -r && x < W + r && y < H + r) dotGrid.add([x - r, y - r, 2 * r, 2 * r]); }
function addLineObstacle(x1, y1, x2, y2) {
  // sample the segment every ~6px (only the on-screen part) as tiny boxes
  const len = Math.hypot(x2 - x1, y2 - y1), n = Math.min(4000, Math.ceil(len / 6));
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    if (x < -4 || y < -4 || x > W + 4 || y > H + 4) continue;
    lineGrid.add([x - 1.5, y - 1.5, 3, 3]);
  }
}
function placeLabels(g) {
  if (suppressLabels) return;
  labelQ.sort((a, b) => b.pri - a.pri);
  const placed = new BoxGrid();
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.lineJoin = "round";
  const inDome = (px, py) => Math.hypot(px - g.cx, py - g.cy) < g.R - 2;
  for (const l of labelQ) {
    // labels that are nearly invisible (dimmed by "highlight logged") don't compete for space
    if (!l.force && l.a != null && l.a < 0.12) continue;
    ctx.font = l.font; ctx.letterSpacing = l.spacing || "0px";
    const w = ctx.measureText(l.text).width, h = l.px + 2, x = l.x, y = l.y;
    let cands;
    if (l.center) {
      cands = [];
      for (const dy of [0, 1, -1, 2, -2, 3, -3]) for (const dx of [0, -0.35, 0.35, -0.7, 0.7])
        cands.push([x - w / 2 + dx * w, y - h / 2 + dy * h * 0.9]);
      const vx = g.cx - x, vy = g.cy - y, n = Math.hypot(vx, vy) || 1;   // slide toward the zenith
      for (const k of [20, 40, 60, 80]) cands.push([x + vx / n * k - w / 2, y + vy / n * k - h / 2]);
    } else {
      cands = [];
      for (const f of [1, 1.9, 2.9]) {   // three rings of positions, nearest first
        const gap = (l.r || 0) + 3 + (f - 1) * 7, d = gap * 0.72;
        cands.push([x + gap, y - h / 2], [x + d, y - d - h], [x + d, y + d], [x - gap - w, y - h / 2],
          [x - w / 2, y - gap - h], [x - w / 2, y + gap], [x - d - w, y - d - h], [x - d - w, y + d]);
      }
    }
    const ok = (bx, by) => bx >= 2 && by >= 2 && bx + w <= W - 2 && by + h <= H - 2 &&
      inDome(bx, by) && inDome(bx + w, by) && inDome(bx, by + h) && inDome(bx + w, by + h);
    // tiers: avoid labels+dots+lines → labels+dots → (constellation names only) labels
    const tiers = l.center ? [[placed, dotGrid, lineGrid], [placed, dotGrid], [placed]] : [[placed, dotGrid, lineGrid], [placed, dotGrid]];
    let spot = null;
    for (const grids of tiers) {
      for (const [bx, by] of cands) {
        if (!ok(bx, by)) continue;
        const box = [bx - 1, by - 1, w + 2, h + 2];
        if (grids.some(gr => gr.hits(box))) continue;
        spot = [bx, by, box]; break;
      }
      if (spot) break;
    }
    if (!spot && l.force) { const [bx, by] = cands[0]; spot = [bx, by, [bx, by, w, h]]; }
    if (!spot) continue;
    // dark halo keeps text readable where it has to cross a line
    ctx.strokeStyle = "rgba(0,0,0,0.9)"; ctx.lineWidth = 3;
    ctx.strokeText(l.text, spot[0], spot[1]);
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, spot[0], spot[1]);
    placed.add(spot[2]);
    if (l.con) hitLabels.push({ x: spot[0] - 3, y: spot[1] - 3, w: w + 6, h: h + 6, con: l.con });
  }
  ctx.letterSpacing = "0px"; ctx.textBaseline = "alphabetic";
}

function draw() {
  if (!W) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  const sky = state.sky; if (!sky) return;
  const g = geom(), L = state.layers;
  const { cons: logCons, stars: logStars, planets: logPlanets } = mapLoggedSets();
  const hl = state.highlightLogged;
  const dimF = 0.1; // opacity multiplier for non-logged when highlighting
  hitStars = []; hitLabels = []; hitBodies = []; hitDsos = [];
  labelQ = []; dotGrid = new BoxGrid(); lineGrid = new BoxGrid();
  const font = getComputedStyle(document.body).fontFamily;

  // ---- sky dome background
  const c = skyColors();
  const grad = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.R);
  grad.addColorStop(0, c.zen); grad.addColorStop(0.75, c.zen); grad.addColorStop(1, c.hor);
  ctx.save();
  ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();
  ctx.clip();

  // ---- grid
  if (L.grid.on) {
    ctx.strokeStyle = `rgba(110,130,200,${L.grid.op})`; ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 5]);
    for (const a of [15, 30, 45, 60, 75]) {
      const r = g.R * Math.tan((90 - a) * D2R / 2);
      ctx.beginPath(); ctx.arc(g.cx, g.cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    for (let az = 0; az < 360; az += 30) {
      const [x, y] = proj(0, az, g); ctx.beginPath(); ctx.moveTo(g.cx, g.cy); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = `rgba(150,165,220,${L.grid.op})`; ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
    for (const a of [30, 60]) { const [x, y] = proj(a, 180, g); ctx.fillText(a + "°", x + 3, y - 3); }
  }

  // ---- constellation lines
  if (L.lines.on) {
    for (const con of sky.constellations) {
      const logged = logCons.has(con.id), sel = state.selected?.kind === "constellation" && state.selected.ref === con.id;
      let op = L.lines.op * (hl && !logged ? dimF : 1);
      if (con.status === "below") continue;
      ctx.strokeStyle = logged || sel ? `rgba(245,200,106,${Math.min(1, op + (sel ? .3 : .15))})` : `rgba(125,140,255,${op})`;
      ctx.lineWidth = logged || sel ? 1.8 : 1.1;
      ctx.beginPath();
      for (const seg of con.lines) {
        let prev = null;
        for (const [alt, az] of seg) {
          const p = proj(alt, az, g);
          if (prev && (alt > -25 || prev[2] > -25)) {
            ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]);
            if (op >= 0.12 && (alt > 0 || prev[2] > 0)) addLineObstacle(prev[0], prev[1], p[0], p[1]);
          }
          prev = [p[0], p[1], alt];
        }
      }
      ctx.stroke();
    }
  }

  // ---- deep-sky objects (under the stars)
  const { dsos: logDsos } = mapLoggedSets();
  if (L.dsos.on) {
    for (const d of sky.dsos) {
      if (d.alt < 0) continue;
      const loggedD = logDsos.has(d.id), sel = state.selected?.kind === "dso" && state.selected.ref === d.id;
      if (d.how === "telescope" && !loggedD && !sel && state.view.zoom < 3) continue;
      const [x, y] = proj(d.alt, d.az, g);
      if (x < -60 || y < -60 || x > W + 60 || y > H + 60) continue;
      let a = L.dsos.op * (d.how === "naked-eye" ? 1 : d.how === "binoculars" ? 0.45 : 0.25);
      if (hl && !loggedD) a *= dimF;
      const col = loggedD || sel ? "#f5c86a" : DSO_COLORS[d.group] || "#9fd0ff";
      const rgb = [1, 3, 5].map(i => parseInt(col.slice(i, i + 2), 16)).join(",");
      const r = Math.max(4.5, d.size / 60 / 2 * pxPerDeg(d.alt, g));  // true angular size
      ctx.strokeStyle = `rgba(${rgb},${a})`; ctx.lineWidth = loggedD || sel ? 1.6 : 1.1;
      ctx.fillStyle = `rgba(${rgb},${a * 0.1})`;
      ctx.beginPath();
      if (d.group === "galaxy") {
        ctx.ellipse(x, y, r, Math.max(2.5, r * Math.min(1, d.size2 / d.size)), -0.5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else if (d.group === "nebula") {
        ctx.roundRect ? ctx.roundRect(x - r, y - r, 2 * r, 2 * r, r * 0.35) : ctx.rect(x - r, y - r, 2 * r, 2 * r);
        ctx.fill(); ctx.stroke();
      } else if (d.group === "globular") {
        ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
      } else if (d.group === "planetary") {
        ctx.arc(x, y, r * 0.7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); for (const k of [0, 1, 2, 3]) { const t = k * Math.PI / 2; ctx.moveTo(x + Math.cos(t) * r * .7, y + Math.sin(t) * r * .7); ctx.lineTo(x + Math.cos(t) * r * 1.3, y + Math.sin(t) * r * 1.3); } ctx.stroke();
      } else { // open cluster: dotted circle
        ctx.setLineDash([2, 3]); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      }
      hitDsos.push({ x, y, r: Math.max(r, 7), d });
      if (r <= 30 && a >= 0.1) addObstacle(x, y, r + 1);   // small symbols block labels; big ones may hold labels inside
      // labels: brighter objects first; more appear as you zoom (placer drops any that would overlap)
      const named = d.name !== d.id;
      const magCut = 4.0 + Math.log2(state.view.zoom) * 1.5;
      if (loggedD || sel || (d.how === "naked-eye" && d.mag <= magCut) || (d.how !== "telescope" && state.view.zoom > 2.5) || state.view.zoom > 4) {
        const big = r > 40;  // large on screen: label inside, near the top edge
        queueLabel({ text: named ? d.name : d.id, x, y: big ? y - r * 0.8 : y, r: big ? 0 : r, center: big, px: 10.5,
          font: `${loggedD || sel ? 700 : 400} 10.5px ${font}`, color: `rgba(${rgb},${Math.min(1, a * 1.1)})`,
          pri: (loggedD || sel ? 2000 : 0) + (d.how === "naked-eye" ? 760 : 400) - d.mag * 20, force: loggedD || sel, a });
      }
    }
  }

  // ---- stars
  const lim = sky.limit_mag;
  if (L.stars.on || L.faint.on) {
    for (const s of sky.stars) {
      if (s.alt < 0) continue;
      const [x, y] = proj(s.alt, s.az, g);
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      const loggedS = logStars.has(s.hip), inLoggedCon = logCons.has(s.con);
      const emph = loggedS || inLoggedCon;
      let a, r;
      if (s.vis) {
        if (!L.stars.on) continue;
        r = Math.max(0.6, (Math.min(lim, 6.5) + 1.2 - s.mag) * 0.62) * zs(0.35);
        a = L.stars.op * Math.min(1, 0.45 + (lim - s.mag) * 0.25);
      } else {
        if (!L.faint.on) continue;
        r = 0.7 * zs(0.3); a = L.faint.op * 0.6;
      }
      if (hl && !emph) a *= dimF * 1.5;
      const [cr, cg, cb] = bvColor(s.bv);
      if (s.vis && s.mag < 1.6 && a > 0.3) {
        const gl = ctx.createRadialGradient(x, y, 0, x, y, r * 4.5);
        gl.addColorStop(0, `rgba(${cr},${cg},${cb},${0.35 * a})`); gl.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, r * 4.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (loggedS || (state.selected?.kind === "star" && state.selected.ref === s.hip)) {
        ctx.strokeStyle = "rgba(245,200,106,.95)"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
      }
      hitStars.push({ x, y, r: Math.max(r, 3), s });
      // prominent dots block labels; tiny faint ones don't (the text halo covers them). More dots count as you zoom in.
      if (s.vis && a >= 0.1 && s.mag < 3 + Math.log2(state.view.zoom) * 1.5) addObstacle(x, y, r + 1.5);
    }
  }

  // ---- star names
  if (L.snames.on) {
    const magCut = 1.6 + Math.log2(state.view.zoom) * 1.3;
    for (const s of sky.stars) {
      const loggedS = logStars.has(s.hip), sel = state.selected?.kind === "star" && state.selected.ref === s.hip;
      if (!s.name || s.alt < 0 || (!loggedS && !sel && (!s.vis || s.alt < 2))) continue;
      if (s.mag > magCut && !loggedS && !sel) continue;
      const a = L.snames.op * (hl && !loggedS && !logCons.has(s.con) ? dimF : 1);
      const [x, y] = proj(s.alt, s.az, g);
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const r = Math.max(0.6, (Math.min(lim, 6.5) + 1.2 - s.mag) * 0.62) * zs(0.35);
      queueLabel({ text: s.name, x, y, r, px: 11, font: `${loggedS || sel ? 700 : 400} 11px ${font}`,
        color: loggedS || sel ? `rgba(245,200,106,${Math.max(a, .9)})` : `rgba(245,214,150,${a})`,
        pri: (loggedS || sel ? 2000 : 0) + 800 - s.mag * 40, force: loggedS || sel, a });
    }
  }

  // ---- constellation names
  if (L.cnames.on) {
    for (const con of sky.constellations) {
      if (con.status === "below") continue;
      let alt = con.alt, az = con.az;
      if (alt < 3) { // place at mean of above-horizon vertices
        const up = con.lines.flat().filter(p => p[0] > 3); if (!up.length) continue;
        alt = up.reduce((t, p) => t + p[0], 0) / up.length;
        const sx = up.reduce((t, p) => t + Math.sin(p[1] * D2R), 0), cx = up.reduce((t, p) => t + Math.cos(p[1] * D2R), 0);
        az = (Math.atan2(sx, cx) / D2R + 360) % 360;
      }
      const logged = logCons.has(con.id);
      if (con.rank > 2 && state.view.zoom < 1.4 && !logged && con.status !== "visible") continue;
      const [x, y] = proj(alt, az, g);
      const sel = state.selected?.kind === "constellation" && state.selected.ref === con.id;
      let a = L.cnames.op * (con.status === "visible" ? 1 : 0.55);
      if (hl && !logged) a *= dimF;
      const px = con.rank === 1 ? 11.5 : 10.5;
      queueLabel({ text: con.name.toUpperCase(), x, y, center: true, px, spacing: "1.5px", con,
        font: `${logged || sel ? 700 : 400} ${px}px ${font}`,
        color: logged || sel ? `rgba(245,200,106,${Math.max(a, .95)})` : `rgba(185,193,255,${a})`,
        pri: (logged || sel ? 2000 : 0) + 600 + (con.rank === 1 ? 20 : 0) + (con.status === "visible" ? 10 : 0), force: logged || sel, a });
    }
  }

  // ---- sun & moon
  if (L.sunmoon.on) {
    const op = L.sunmoon.op;
    const m = sky.moon;
    if (m.alt > -2) {
      const [x, y] = proj(m.alt, m.az, g), r = Math.max(9 * zs(.3), 0.26 * pxPerDeg(m.alt, g));
      const gl = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      gl.addColorStop(0, `rgba(240,230,200,${0.25 * op * m.illum})`); gl.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, r * 5, 0, Math.PI * 2); ctx.fill();
      drawMoon(x, y, r, m.elong, op);
      addObstacle(x, y, r);
      queueLabel({ text: `Moon · ${Math.round(m.illum * 100)}%`, x, y, r, px: 11, font: `400 11px ${font}`,
        color: `rgba(240,230,200,${op * .85})`, pri: 950 });
    }
    const sn = sky.sun;
    if (sn.alt > -2) {
      const [x, y] = proj(sn.alt, sn.az, g);
      const rs = Math.max(10, 0.27 * pxPerDeg(sn.alt, g));
      ctx.fillStyle = `rgba(255,210,120,${op})`; ctx.beginPath(); ctx.arc(x, y, rs, 0, Math.PI * 2); ctx.fill();
      addObstacle(x, y, rs);
      queueLabel({ text: "Sun", x, y, r: rs, px: 11, font: `400 11px ${font}`, color: `rgba(255,230,180,${op})`, pri: 960 });
    }
  }
  // ---- planets
  if (L.planets.on) {
    const { planets: logP } = mapLoggedSets();
    for (const p of sky.planets) {
      if (p.alt < -1) continue;
      const [x, y] = proj(p.alt, p.az, g);
      const loggedP = logP.has(p.id), sel = state.selected?.kind === "planet" && state.selected.ref === p.id;
      let a = L.planets.op * (p.vis ? 1 : 0.4);
      if (hl && !loggedP) a *= dimF * 1.5;
      const r = Math.max(2.4, Math.min(6, 3 - p.mag * 0.7)) * zs(0.3);
      const col = p.color, rgb = [1, 3, 5].map(i => parseInt(col.slice(i, i + 2), 16)).join(",");
      if (p.vis) {
        const gl = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
        gl.addColorStop(0, `rgba(${rgb},${0.45 * a})`); gl.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = `rgba(${rgb},${a})`; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (p.id === "saturn") {
        ctx.strokeStyle = `rgba(${rgb},${a * .9})`; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.ellipse(x, y, r * 2.1, r * 0.7, -0.35, 0, Math.PI * 2); ctx.stroke();
      }
      if (loggedP || sel) {
        ctx.strokeStyle = "rgba(245,200,106,.95)"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke();
      }
      addObstacle(x, y, p.id === "saturn" ? r * 2.1 : r + 1);
      queueLabel({ text: p.name, x, y, r: p.id === "saturn" ? r * 2.1 : r + 2, px: 11.5, font: `700 11.5px ${font}`,
        color: loggedP || sel ? `rgba(245,200,106,${Math.max(a, .95)})` : `rgba(${rgb},${Math.min(1, a * 1.1)})`,
        pri: (loggedP || sel ? 2000 : 0) + 900 - p.mag * 10, force: loggedP || sel, a });
      hitBodies.push({ x, y, r: r + 3, b: p });
    }
  }
  if (L.sunmoon.on && sky.moon.alt > -2) {
    const [x, y] = proj(sky.moon.alt, sky.moon.az, g);
    const rm = Math.max(9 * zs(.3), 0.26 * pxPerDeg(sky.moon.alt, g));
    hitBodies.push({ x, y, r: rm + 3, b: sky.bodyById.get("moon") });
    if (logPlanets.has("moon")) {
      ctx.strokeStyle = "rgba(245,200,106,.95)"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, rm + 4, 0, Math.PI * 2); ctx.stroke();
    }
  }
  placeLabels(g);
  ctx.restore();

  // ---- horizon ring and compass
  if (L.horizon.on) {
    const op = L.horizon.op;
    ctx.strokeStyle = `rgba(154,163,199,${op * .6})`; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let az = 0; az < 360; az += 15) {
      const major = az % 90 === 0, mid = az % 45 === 0;
      const r1 = g.R, r2 = g.R + (major ? 10 : mid ? 7 : 4), s = Math.sin(az * D2R), c2 = Math.cos(az * D2R);
      ctx.beginPath(); ctx.moveTo(g.cx - r1 * s, g.cy - r1 * c2); ctx.lineTo(g.cx - r2 * s, g.cy - r2 * c2); ctx.stroke();
      if (mid) {
        const lab = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][az / 45], rr = g.R + 22;
        ctx.font = `${major ? 700 : 500} ${major ? 14 : 11}px ${font}`;
        ctx.fillStyle = az === 0 ? `rgba(255,107,138,${op})` : `rgba(200,207,235,${op * (major ? 1 : .7)})`;
        ctx.fillText(lab, g.cx - rr * s, g.cy - rr * c2);
      }
    }
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }
}

function drawMoon(x, y, r, elong, op) {
  // lit fraction drawn with a terminator ellipse; waxing = lit on the west (right in this view is W)
  ctx.save();
  ctx.fillStyle = `rgba(40,42,55,${op})`; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  const k = Math.cos(elong * D2R); // 1 new, -1 full
  const waxing = elong < 180;
  ctx.fillStyle = `rgba(240,232,205,${op})`;
  ctx.beginPath();
  const side = waxing ? 1 : -1; // lit limb toward the sun: waxing → west → right side (+x)
  ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2, side < 0);
  ctx.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) === (side > 0) ? true : false);
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------- interactions */
const tooltip = $("#tooltip"), popover = $("#popover");
function hitTest(mx, my) {
  for (const h of hitBodies) if (Math.hypot(h.x - mx, h.y - my) <= h.r + 4) return { kind: "planet", ref: h.b.id };
  for (const l of hitLabels) if (mx >= l.x && mx <= l.x + l.w && my >= l.y && my <= l.y + l.h) return { kind: "constellation", ref: l.con.id };
  let best = null, bd = 12;
  for (const h of hitStars) {
    const d = Math.hypot(h.x - mx, h.y - my) - h.r * 0.5;
    if (d < bd && (h.s.vis || state.layers.faint.on)) { bd = d; best = h; }
  }
  let bestD = null, bdd = Infinity;
  for (const h of hitDsos) { const dd = Math.hypot(h.x - mx, h.y - my); if (dd <= h.r + 3 && dd < bdd) { bdd = dd; bestD = h; } }
  const starDist = best ? Math.hypot(best.x - mx, best.y - my) : Infinity;
  if (bestD && (bdd <= starDist || starDist > 6)) return { kind: "dso", ref: bestD.d.id };
  if (best) return { kind: "star", ref: best.s.hip };
  return null;
}
function describe(hit) {
  const sky = state.sky;
  if (hit.kind === "dso") {
    const d = sky.dsoById.get(hit.ref), con = sky.conById.get(d.con);
    const size = d.size >= 60 ? `${(d.size / 60).toFixed(1)}°` : `${d.size}′`;
    return {
      title: d.name,
      meta: [`${d.kind} · ${d.desig}`, `mag ${d.mag.toFixed(1)} · ${size} across`,
        `${HOW_LABEL[d.how]}${d.how === "naked-eye" ? " — visible tonight" : d.how === "binoculars" ? " needed here tonight" : " needed"}`,
        `Alt ${d.alt.toFixed(1)}° · Az ${d.az.toFixed(1)}° (${compass(d.az)})`, con ? `in ${con.name}` : ""].filter(Boolean),
      d, con,
    };
  }
  if (hit.kind === "planet") {
    const b = sky.bodyById.get(hit.ref), con = b.con && sky.conById.get(b.con);
    return {
      title: b.name,
      meta: [b.isMoon ? `${b.phase} · ${Math.round(b.illum * 100)}% lit` : `Planet · mag ${b.mag.toFixed(1)} · ${b.vis ? "naked-eye visible" : "below limit"}`,
        b.isMoon ? "" : `${b.dist_au.toFixed(2)} AU away · ${Math.round(b.illum * 100)}% lit · ${b.elong.toFixed(0)}° from Sun`,
        `Alt ${b.alt.toFixed(1)}° · Az ${b.az.toFixed(1)}° (${compass(b.az)})`, con ? `near ${con.name}` : ""].filter(Boolean),
      b, con,
    };
  }
  if (hit.kind === "star") {
    const s = sky.starByHip.get(hit.ref), con = sky.conById.get(s.con);
    return {
      title: starLabel(s),
      meta: [s.name && s.bayer ? `${s.bayer} ${s.con}` : "", `mag ${s.mag.toFixed(2)} · ${s.vis ? "naked-eye visible" : "below limit"}`,
        `Alt ${s.alt.toFixed(1)}° · Az ${s.az.toFixed(1)}° (${compass(s.az)})`, con ? `in ${con.name}` : ""].filter(Boolean),
      s, con,
    };
  }
  const c = sky.conById.get(hit.ref);
  const label = { visible: "Well placed & visible", partial: "Partly visible", faint: "Too faint / low", below: "Below horizon" }[c.status];
  return {
    title: c.name,
    meta: [label, `${c.n_visible} of ${c.n_members} pattern stars visible`, `Center alt ${c.alt.toFixed(0)}° · ${compass(c.az)}`],
    con: c,
  };
}
canvas.addEventListener("mousemove", e => {
  if (drag) return;
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const hit = state.sky && hitTest(mx, my);
  canvas.classList.toggle("hover", !!hit);
  if (!hit || popover.classList.contains("on")) { tooltip.style.opacity = 0; return; }
  const d = describe(hit);
  tooltip.innerHTML = `<b>${esc(d.title)}</b><br><span class="muted">${esc(d.meta.slice(0, 2).join(" · "))}</span>`;
  tooltip.style.left = mx + "px"; tooltip.style.top = my + "px"; tooltip.style.opacity = 1;
});
canvas.addEventListener("mouseleave", () => tooltip.style.opacity = 0);

function openPopover(hit, at) {
  popover.cur = hit; tooltip.style.opacity = 0;
  if (at) popover.at = at;
  const d = describe(hit);
  const acts = [];
  if (hit.kind === "dso") {
    const on = isLogged("dso", d.d.id);
    acts.push(`<button class="btn ${on ? "logged" : ""}" data-log="dso:${d.d.id}">${on ? "✓ Logged — remove" : `＋ Log ${esc(d.d.name)}`}</button>`);
  } else if (hit.kind === "planet") {
    const on = isLogged("planet", d.b.id);
    acts.push(`<button class="btn ${on ? "logged" : ""}" data-log="planet:${d.b.id}">${on ? "✓ Logged — remove" : `＋ Log ${esc(d.b.name)}`}</button>`);
  } else if (hit.kind === "star") {
    const on = isLogged("star", d.s.hip);
    acts.push(`<button class="btn ${on ? "logged" : ""}" data-log="star:${d.s.hip}">${on ? "✓ Logged — remove" : "＋ Log this star"}</button>`);
    if (d.con) { const on2 = isLogged("constellation", d.con.id); acts.push(`<button class="btn ${on2 ? "logged" : ""}" data-log="constellation:${d.con.id}">${on2 ? `✓ ${esc(d.con.name)} logged` : `＋ Log ${esc(d.con.name)}`}</button>`); }
  } else {
    const on = isLogged("constellation", d.con.id);
    acts.push(`<button class="btn ${on ? "logged" : ""}" data-log="constellation:${d.con.id}">${on ? "✓ Logged — remove" : "＋ Log this constellation"}</button>`);
  }
  popover.innerHTML = `<button class="x" aria-label="Close">✕</button><h4>${esc(d.title)}</h4><div class="meta">${d.meta.map(esc).join("<br>")}</div><div class="acts">${acts.join("")}</div>`;
  const [x, y] = popover.at, wrap = $("#skyWrap").getBoundingClientRect();
  popover.classList.add("on");
  const pw = popover.offsetWidth, ph = popover.offsetHeight;
  popover.style.left = Math.min(x + 14, wrap.width - pw - 10) + "px";
  popover.style.top = Math.min(y + 14, wrap.height - ph - 10) + "px";
  state.selected = hit; draw();
}
function closePopover() { popover.classList.remove("on"); popover.cur = null; state.selected = null; draw(); }
popover.addEventListener("click", e => {
  if (e.target.closest(".x")) return closePopover();
  const b = e.target.closest("[data-log]"); if (!b) return;
  const [kind, ref] = b.dataset.log.split(":");
  toggleLog(kind, kind === "star" ? +ref : ref);
});

// pan / zoom
let drag = null;
canvas.addEventListener("mousedown", e => { drag = { x: e.clientX, y: e.clientY, px: state.view.px, py: state.view.py, moved: false }; });
window.addEventListener("mousemove", e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) { drag.moved = true; canvas.classList.add("dragging"); }
  if (drag.moved) { state.view.px = drag.px + dx; state.view.py = drag.py + dy; draw(); }
});
window.addEventListener("mouseup", e => {
  if (!drag) return;
  const wasDrag = drag.moved; drag = null; canvas.classList.remove("dragging");
  if (wasDrag || e.target !== canvas) return;
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const hit = state.sky && hitTest(mx, my);
  hit ? openPopover(hit, [mx, my]) : closePopover();
});
function zoomAt(f, mx = W / 2, my = H / 2) {
  const v = state.view, nz = Math.max(0.6, Math.min(ZOOM_MAX, v.zoom * f)); f = nz / v.zoom;
  const cx = W / 2 + v.px, cy = H / 2 + v.py;
  v.px = mx - (mx - cx) * f - W / 2; v.py = my - (my - cy) * f - H / 2; v.zoom = nz;
  closePopover(); draw();
}
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
$("#zoomIn").onclick = () => zoomAt(1.6);
$("#zoomOut").onclick = () => zoomAt(1 / 1.6);
$("#zoomReset").onclick = () => { state.view = { zoom: 1, px: 0, py: 0 }; closePopover(); draw(); };

/* ------------------------------------------------------------ UI: chips */
function renderChips() {
  const s = state.sky; if (!s) return;
  const sunCol = s.sun.alt > -0.8 ? "#ffd27a" : s.sun.alt > -12 ? "#8b7cff" : s.sun.alt > -18 ? "#4b56b8" : "#2a2f5a";
  const limCol = s.limit_mag >= 6 ? "var(--good)" : s.limit_mag >= 4.5 ? "var(--warn)" : "var(--bad)";
  $("#chips").innerHTML = `
    <div class="chip"><i class="ind" style="background:${sunCol}"></i><b>${s.sun.phase}</b><span class="k">Sun ${s.sun.alt.toFixed(0)}°</span></div>
    <div class="chip">${moonGlyph(s.moon.elong)}<b>${s.moon.phase}</b><span class="k">${Math.round(s.moon.illum * 100)}% · ${s.moon.alt > 0 ? "up " + s.moon.alt.toFixed(0) + "°" : "set"}</span></div>
    <div class="chip"><i class="ind" style="background:${limCol}"></i><span class="k">Limit</span><b>mag ${s.limit_mag.toFixed(1)}</b></div>
    <div class="chip"><span class="k">Planets</span><b>${s.counts.planets_visible}</b><span class="k">Deep-sky</span><b>${s.counts.dsos_visible}</b><span class="k">Stars</span><b>${s.counts.stars_visible}</b><span class="k">Constellations</span><b>${s.counts.constellations_visible}</b><span class="k">+${s.counts.constellations_partial} partial</span></div>`;
  const u = new Date(s.input.utc);
  $("#skyInfo").innerHTML = `<b>${esc(state.place || "Custom site")}</b><br>${fmtLat(state.lat)} ${fmtLon(state.lon)}<br>${state.date} · ${localClock(state.minutes)} (UTC${state.tz >= 0 ? "+" : ""}${state.tz})<br>UTC ${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())} · LST ${Math.floor(s.lst_hours)}h${pad(Math.floor((s.lst_hours % 1) * 60))}m`;
}
function moonGlyph(elong) {
  const k = Math.cos(elong * D2R), wax = elong < 180, r = 7;
  const rx = Math.abs(k) * r, sweepOuter = wax ? 1 : 0, sweepInner = (k > 0) === wax ? 0 : 1;
  return `<svg viewBox="-8 -8 16 16" style="width:16px;height:16px;stroke:none"><circle r="7" fill="#2b2f45"/><path d="M0 -7 A7 7 0 0 ${sweepOuter} 0 7 A${rx} 7 0 0 ${sweepInner} 0 -7Z" fill="#efe6c9"/></svg>`;
}

/* ------------------------------------------------------- UI: visible list */
function renderVisible() {
  const sky = state.sky; if (!sky) return;
  const q = state.search.trim().toLowerCase(), f = state.filter;
  const el = $("#visList"); const out = [];
  const rankStatus = { visible: 0, partial: 1, faint: 2, below: 3 };
  {
    let bodies = sky.bodies.filter(b => f === "good" ? b.vis : b.alt > 0);
    if (q) bodies = sky.bodies.filter(b => b.name.toLowerCase().includes(q));
    bodies.sort((a, b) => a.mag - b.mag);
    if (bodies.length) out.push(`<div class="group-h">Solar system · ${bodies.length}</div>`);
    for (const b of bodies) {
      const on = isLogged("planet", b.id), con = b.con && sky.conById.get(b.con);
      const sub = b.isMoon ? `${b.phase} · ${Math.round(b.illum * 100)}%` : `mag ${b.mag.toFixed(1)}${con ? " · near " + esc(con.name) : ""}`;
      out.push(`<div class="item" data-focus="planet:${b.id}"><i class="st" style="background:${b.color};box-shadow:0 0 7px ${b.color}"></i><div class="main"><div class="t">${esc(b.name)}</div><div class="s">${sub} · ${b.alt > 0 ? `alt ${b.alt.toFixed(0)}° ${compass(b.az)}` : "below horizon"}${b.vis || b.alt <= 0 ? "" : " · below limit"}</div></div><button class="add ${on ? "on" : ""}" data-log="planet:${b.id}">${on ? "✓" : "+"}</button></div>`);
    }
  }
  if (f !== "stars") {
    let dsos = sky.dsos.filter(d => d.alt > 0 && (f === "good" ? d.vis : d.how !== "telescope"));
    if (q) dsos = sky.dsos.filter(d => d.alt > 0 && (d.name.toLowerCase().includes(q) || d.desig.toLowerCase().replace(/\s/g, "").includes(q.replace(/\s/g, ""))));
    dsos.sort((a, b) => (a.how > b.how) - (a.how < b.how) || a.mag - b.mag);
    if (dsos.length) out.push(`<div class="group-h">Deep-sky · ${dsos.length}</div>`);
    for (const d of dsos) {
      const on = isLogged("dso", d.id), col = DSO_COLORS[d.group];
      out.push(`<div class="item" data-focus="dso:${esc(d.id)}"><i class="st" style="background:${col};box-shadow:0 0 6px ${col}"></i><div class="main"><div class="t">${esc(d.name)}</div><div class="s">${esc(d.kind)} · mag ${d.mag.toFixed(1)} · alt ${d.alt.toFixed(0)}° ${compass(d.az)}${d.how !== "naked-eye" ? ` · <span class="tag">${HOW_LABEL[d.how]}</span>` : ""}</div></div><button class="add ${on ? "on" : ""}" data-log="dso:${esc(d.id)}">${on ? "✓" : "+"}</button></div>`);
    }
  }
  if (f !== "stars") {
    let cons = sky.constellations.filter(c => f === "all" ? c.frac_up > 0 : (c.status === "visible" || c.status === "partial"));
    if (q) cons = cons.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase() === q);
    cons.sort((a, b) => rankStatus[a.status] - rankStatus[b.status] || b.alt - a.alt);
    out.push(`<div class="group-h">Constellations · ${cons.length}</div>`);
    for (const c of cons) {
      const on = isLogged("constellation", c.id), sel = state.selected?.ref === c.id;
      out.push(`<div class="item ${sel ? "sel" : ""}" data-focus="constellation:${c.id}"><i class="st ${c.status}"></i><div class="main"><div class="t">${esc(c.name)}</div><div class="s">${c.n_visible}/${c.n_members} stars · alt ${Math.max(0, c.alt).toFixed(0)}° ${compass(c.az)}</div></div><button class="add ${on ? "on" : ""}" data-log="constellation:${c.id}" title="${on ? "Remove from log" : "Log it"}">${on ? "✓" : "+"}</button></div>`);
    }
  }
  if (f !== "good" || q) {
    let stars = sky.stars.filter(s => s.vis && (s.name || s.mag < 2.5));
    if (q) stars = sky.stars.filter(s => s.alt > 0 && (s.name.toLowerCase().includes(q) || (s.bayer && `${s.bayer} ${s.con}`.toLowerCase().includes(q))));
    stars.sort((a, b) => a.mag - b.mag); stars = stars.slice(0, 120);
    out.push(`<div class="group-h">Stars · ${stars.length}</div>`);
    for (const s of stars) {
      const on = isLogged("star", s.hip), [r, g, b] = bvColor(s.bv);
      out.push(`<div class="item" data-focus="star:${s.hip}"><i class="st" style="background:rgb(${r},${g},${b});box-shadow:0 0 6px rgb(${r},${g},${b})"></i><div class="main"><div class="t">${esc(starLabel(s))}</div><div class="s">mag ${s.mag.toFixed(1)} · ${esc(s.con)} · alt ${s.alt.toFixed(0)}° ${compass(s.az)}${s.vis ? "" : " · below limit"}</div></div><button class="add ${on ? "on" : ""}" data-log="star:${s.hip}">${on ? "✓" : "+"}</button></div>`);
    }
  }
  if (!out.some(x => x.startsWith('<div class="item'))) out.push(`<div class="empty"><div class="big">☁</div>Nothing visible with these settings.<br>Try a later time or a darker sky.</div>`);
  el.innerHTML = out.join("");
}
$("#visList").addEventListener("click", e => {
  const add = e.target.closest("[data-log]");
  if (add) { const [k, r] = add.dataset.log.split(":"); return toggleLog(k, k === "star" ? +r : r); }
  const it = e.target.closest("[data-focus]"); if (!it) return;
  const [k, r] = it.dataset.focus.split(":"); focusObject({ kind: k, ref: k === "star" ? +r : r });
});
function focusObject(hit) {
  const o = lookup(hit.kind, hit.ref);
  if (!o) return;
  const g = geom(), [x, y] = proj(Math.max(o.alt, 2), o.az, g);
  openPopover(hit, [Math.max(20, Math.min(W - 260, x)), Math.max(20, Math.min(H - 160, y))]);
  renderVisible();
}
$("#search").addEventListener("input", e => { state.search = e.target.value; renderVisible(); });
$("#filterSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#filterSeg button").forEach(x => x.classList.toggle("active", x === b)); state.filter = b.dataset.f; renderVisible();
});

/* ------------------------------------------------------------ UI: log */
const LOG_GROUPS = [["planet", "Planets & Moon"], ["dso", "Deep-sky objects"], ["constellation", "Constellations"], ["star", "Stars"]];
function renderLog() {
  const s = state.session; if (!s) return;
  $("#sessTitle").textContent = "Night of " + new Date(s.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  $("#sessSub").textContent = `${s.place || "Custom site"} · Bortle ${s.bortle}${s.limit_mag != null ? ` · limit mag ${(+s.limit_mag).toFixed(1)}` : ""}`;
  if (document.activeElement !== $("#sessNotes")) $("#sessNotes").value = s.notes || "";
  $$(".stars-rate").forEach(el => {
    const k = el.dataset.key, v = s[k] || 0;
    el.innerHTML = [1, 2, 3, 4, 5].map(i => `<button data-v="${i}" class="${i <= v ? "on" : ""}" title="${i}/5">★</button>`).join("");
  });
  $("#logCount").textContent = s.items.length;
  if (document.activeElement !== $("#winStart")) $("#winStart").value = s.start || "";
  if (document.activeElement !== $("#winEnd")) $("#winEnd").value = s.end || "";
  const nightKey = t => (t < "12:00" ? "1" : "0") + t;
  const items = [...s.items].sort((a, b) => nightKey(a.time).localeCompare(nightKey(b.time)));
  const one = it => `
    <div class="log-item" data-key="${it.kind}:${it.ref}">
      <div class="top"><span class="kind ${it.kind}">${{ star: "Star", planet: it.ref === "moon" ? "Moon" : "Planet", constellation: "Const.", dso: "Deep-sky" }[it.kind]}</span><span class="nm">${esc(it.name)}</span><span class="tm">${it.time}</span>
      <button class="rm" title="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="muted small">Alt ${it.alt}° · Az ${it.az}° ${compass(it.az)}${it.mag != null ? ` · mag ${it.mag}` : ""}</div>
      <input class="note" placeholder="Add a note (e.g. 'saw with binoculars')" value="${esc(it.notes)}">
    </div>`;
  $("#logList").innerHTML = items.length ? LOG_GROUPS.map(([kind, label]) => {
    const g = items.filter(i => i.kind === kind);
    return g.length ? `<div class="log-group"><span>${label}</span><b>${g.length}</b></div>` + g.map(one).join("") : "";
  }).join("") : `<div class="empty"><div class="big">✦</div>No observations yet for this night.<br>Click a star or constellation on the sky, or use <b>+</b> in the Visible tab.</div>`;
  renderSaveState(); renderHistory(); requestStats(); renderChecklist();
}
function renderSaveState() {
  const el = $("#saveState"), s = state.session;
  if (!s || (!s.items.length && !s.id)) { el.className = "save-state"; el.textContent = ""; return; }
  el.className = "save-state " + (state.dirty ? "dirty" : "saved");
  el.textContent = state.dirty ? "● Unsaved" : "✓ Saved";
}
$("#logList").addEventListener("click", e => {
  const rm = e.target.closest(".rm"); if (!rm) return;
  const [k, r] = rm.closest(".log-item").dataset.key.split(":"); toggleLog(k, k === "star" ? +r : r);
});
$("#logList").addEventListener("input", e => {
  if (!e.target.classList.contains("note")) return;
  const [k, r] = e.target.closest(".log-item").dataset.key.split(":");
  const it = state.session.items.find(i => i.kind === k && String(i.ref) === r); if (it) { it.notes = e.target.value; markDirty(); }
});
for (const id of ["winStart", "winEnd"]) $("#" + id).addEventListener("change", e => {
  state.session[id === "winStart" ? "start" : "end"] = e.target.value || ""; markDirty(); requestStats();
});
$("#winClear").onclick = () => { state.session.start = state.session.end = ""; renderLog(); markDirty(); };

/* ------------------------------------------------------------ UI: stats */
let statsT = null, statsAbort = null;
function requestStats() { clearTimeout(statsT); statsT = setTimeout(fetchStats, 300); }
async function fetchStats() {
  if (!$("#tab-stats").classList.contains("active")) return;   // computed when the tab is opened
  const s = state.session;
  if (!s?.items.length) { $("#statsBody").innerHTML = `<div class="empty"><div class="big">📊</div>Log some observations to see stats for this night.</div>`; return; }
  statsAbort?.abort(); statsAbort = new AbortController();
  try {
    const r = await fetch("/api/stats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s), signal: statsAbort.signal });
    const st = await r.json();
    if (!r.ok) throw new Error(st.error);
    renderStats(st);
  } catch (e) { if (e.name !== "AbortError") $("#statsBody").innerHTML = `<div class="empty">Couldn't compute stats: ${esc(e.message)}</div>`; }
}
const BORTLE_COLORS = { 1: "#5b6cff", 2: "#3f7fd8", 3: "#2a5ea8", 4: "#3fa46a", 5: "#d7d34a", 6: "#f39a3c", 7: "#f06464", 8: "#f4a0a0", 9: "#ffffff" };
const CAT_COLORS = { planet: "#ff9d6b", dso: "#7ee0c8", constellation: "#8f9cff", star: "#f5d68a" };
function renderStats(st) {
  const el = $("#statsBody");
  if (st.empty) { el.innerHTML = `<div class="empty">No observations yet.</div>`; return; }
  const w = st.window, cov = st.coverage, lp = st.light_pollution;
  const hrs = w.minutes >= 60 ? `${Math.floor(w.minutes / 60)} h ${w.minutes % 60} min` : `${w.minutes} min`;
  const total = Object.values(st.counts).reduce((a, b) => a + b, 0);
  const vl = st.visible_logged;
  const cards = `<div class="st-cards">
    <div class="st-card wide"><div class="k">Visible objects you logged</div>
      <div class="v">${vl.pct.toFixed(0)}%<small> · ${vl.logged} of ${vl.available}</small></div>
      <div class="bar"><i style="width:${vl.pct}%;background:var(--good)"></i></div>
      <div class="sub">Naked-eye planets, deep-sky objects, constellations and bright stars (mag ≤ 2) that were up during ${w.start} → ${w.end}${w.from_log ? " (from your log)" : ""}, under your Bortle ${lp.overall.set_bortle} setting${total > vl.logged ? ` · +${total - vl.logged} other logged objects not counted here` : ""}</div></div>
    <div class="st-card"><div class="k">Observing window</div><div class="v">${hrs}</div>
      <div class="sub">${w.start} → ${w.end}${w.from_log ? " · from your log" : ""}</div></div>
    <div class="st-card"><div class="k">Sky coverage</div><div class="v">${cov.pct_up.toFixed(0)}%<small> of the sky rose</small></div>
      <div class="sub">${cov.pct_up20.toFixed(0)}% above 20° · max ${cov.max_possible.toFixed(0)}% ever rises from this latitude</div></div>
    <div class="st-card"><div class="k">Logged</div><div class="v">${total}<small> objects</small></div>
      <div class="sub">${st.counts.planet} planets · ${st.counts.dso} deep-sky · ${st.counts.constellation} const. · ${st.counts.star} stars</div></div>
    <div class="st-card"><div class="k">Sky estimate</div><div class="v">${lp.overall.bortle ? `${lp.overall.bortle}<small> Bortle or darker</small>` : `—`}</div>
      <div class="sub">${lp.overall.bortle ? `you set ${lp.overall.set_bortle}` : "nothing logged was faint enough to tell"}</div></div>
  </div>`;
  const cats = st.categories.map(c => `<div class="cat">
      <div class="row"><span class="nm">${esc(c.label)}</span><span class="num"><b>${c.logged_available}</b> / ${c.available} seen${c.pct != null ? ` · ${c.pct.toFixed(0)}%` : ""}</span></div>
      <div class="bar"><i style="width:${c.pct || 0}%;background:${CAT_COLORS[c.kind]}"></i></div>
      ${c.missed.length ? `<div class="miss">Missed: ${c.missed.map(esc).join(", ")}${c.missed_more ? ` +${c.missed_more} more` : ""}</div>` : c.available ? `<div class="miss">Got them all ✦</div>` : `<div class="miss">None were naked-eye visible during your window.</div>`}
      ${c.logged_total > c.logged_available ? `<div class="miss">+${c.logged_total - c.logged_available} logged beyond these</div>` : ""}
    </div>`).join("");
  const rows = lp.by_hour.map(h => {
    const why = h.estimated
      ? `${esc(h.evidence)}${h.evidence_mag != null ? ` needed mag ${h.evidence_mag.toFixed(1)}` : ""}${h.moon_up ? " with the Moon up" : ""}${h.beyond_model ? " — fainter than the model allows, so the darkest class" : ""}`
      : `Nothing logged this hour narrows it down${h.uninformative.length ? ` (${h.uninformative.map(esc).join(", ")} ${h.uninformative.length > 1 ? "are" : "is"} visible under any sky)` : ""} — kept your setting`;
    return `<div class="lp-row ${h.estimated ? "" : "asis"}"><div class="hr">${h.hour}<small>${h.n_items} logged</small></div>
      <div><span class="lp-badge"><i style="background:${BORTLE_COLORS[h.bortle]}"></i>${h.estimated ? "Bortle " + h.bortle + " or darker" : "Bortle " + h.bortle + " (as set)"}</span>
      <div class="lp-why">${why}${h.inconsistent.length ? ` · ignored: ${h.inconsistent.map(esc).join(", ")} (below the horizon then)` : ""}</div>
      <div class="lp-items">${h.items.map(i => `<div class="lp-item"><span class="nm"><i style="background:${CAT_COLORS[i.kind]}"></i>${esc(i.name)} <small>${i.time}</small></span>
        <span class="mg" title="catalogue magnitude → effective magnitude after haze at its altitude${i.kind === "dso" ? " and size penalty" : ""}${i.kind === "constellation" ? " (faintest of the ~half pattern stars needed)" : ""}">${i.mag != null ? `mag ${i.mag.toFixed(1)}` : ""}${i.eff_mag != null && i.mag != null && Math.abs(i.eff_mag - i.mag) >= 0.05 ? ` → ${i.eff_mag.toFixed(1)}` : ""}${i.max_bortle && i.max_bortle < 9 ? ` · ≤B${i.max_bortle}` : i.max_bortle === 9 ? " · any sky" : ""}</span></div>`).join("")}</div>
      <div class="lp-strip" title="Faintest magnitude visible under each Bortle class at this time (twilight and Moon included). Crossed-out classes would have hidden ${h.estimated ? esc(h.evidence) : "nothing logged"}.">${h.limits.map((l, k) => `<span class="${h.ok[k] ? "ok" : "no"}${k + 1 === state.session.bortle ? " set" : ""}"><b>B${k + 1}</b>${l.toFixed(1)}</span>`).join("")}</div></div></div>`;
  }).join("");
  const o = lp.overall;
  const summary = o.bortle && o.bortle < o.set_bortle
    ? `<div class="lp-summary"><span>What you saw needs a darker sky than the <b>Bortle ${o.set_bortle}</b> you set — at least <b>Bortle ${o.bortle}</b> at its best.</span><button class="btn ghost sm" id="applyBortle" data-b="${o.bortle}">Use ${o.bortle}</button></div>` : "";
  el.innerHTML = `${cards}
    <div class="st-h">By category · naked-eye objects up during your window</div>${cats}
    <div class="st-h">Sky coverage</div>
    <canvas class="cov-map" id="covMap"></canvas>
    <div class="cov-legend"><span><i style="background:#2c3a6e"></i>Rose above 20°</span><span><i style="background:#18203c"></i>Above horizon (low)</span><span><i style="background:#0b0b0b;border:1px solid #222"></i>Never up</span><span><i style="background:#f5c86a;border-radius:50%"></i>Logged</span></div>
    <div class="st-h">Light pollution by hour · from what you saw</div>
    ${summary}
    <div class="lp-legend"><span>mag <b>catalogue → effective</b> (after haze / size)</span><span><i style="background:rgba(95,224,168,.25)"></i>B-class thresholds you passed</span><span><i style="background:rgba(255,107,138,.18)"></i>would have hidden it</span><span><i style="border:1px solid rgba(245,200,106,.8)"></i>your setting</span></div>
    <div class="lp-table">${rows}</div>
    <div class="note-muted">Each logged object is checked at its logged time against every Bortle class, accounting for its altitude (haze), size (diffuse objects are harder), twilight and moonlight. The hour's value is the brightest sky that still lets you see its most demanding object — an upper bound: your sky was at least that dark. Constellations count as seen when about half of their pattern stars are visible.</div>`;
  drawCoverage(st);
  $("#applyBortle")?.addEventListener("click", e => { state.bortle = +e.target.dataset.b; syncInputs(); onInputsChanged(0); toast(`Light pollution set to Bortle ${state.bortle}`); });
}
function drawCoverage(st) {
  const c = $("#covMap"); if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.fillStyle = "#000"; x.fillRect(0, 0, w, h);
  const P = (ra, dec) => [w - (ra / 360) * w, (90 - dec) / 180 * h];   // RA increases to the left, like the sky
  const cell = Math.max(3, w / 64);
  for (const [ra, dec, f] of st.coverage.points) {
    const [px, py] = P(ra, dec);
    x.fillStyle = f === 2 ? "#2c3a6e" : f === 1 ? "#18203c" : "#0b0b0b";
    x.beginPath(); x.arc(px, py, cell * 0.55, 0, Math.PI * 2); x.fill();
  }
  x.strokeStyle = "rgba(255,255,255,.12)"; x.lineWidth = 1; x.font = `10px ${getComputedStyle(document.body).fontFamily}`; x.fillStyle = "rgba(255,255,255,.35)";
  for (const dec of [-60, -30, 0, 30, 60]) { const [, py] = P(0, dec); x.beginPath(); x.moveTo(0, py); x.lineTo(w, py); x.stroke(); x.fillText(`${dec}°`, 3, py - 2); }
  for (let ra = 0; ra < 360; ra += 90) { const [px] = P(ra, 0); x.fillText(`${ra / 15}h`, px - 14, h - 4); }
  for (const p of st.positions) {
    const [px, py] = P(p.ra, p.dec);
    x.fillStyle = CAT_COLORS[p.kind] || "#f5c86a";
    x.beginPath(); x.arc(px, py, 3, 0, Math.PI * 2); x.fill();
  }
}

/* -------------------------------------------------------- UI: checklist */
const ck = { items: [], kind: "all", status: "all", showAll: false };
async function loadChecklist() { try { ck.items = await (await fetch("/api/checklist")).json(); } catch { ck.items = []; } }
function seenMap() {
  // earliest date each object was logged, across saved sessions and tonight's (possibly unsaved) log
  const m = new Map();
  const add = (sess) => { for (const it of sess?.items || []) {
    const k = it.kind + ":" + it.ref, d = sess.date;
    if (!m.has(k) || d < m.get(k)) m.set(k, d);
  } };
  state.history.forEach(add); add(state.session);
  return m;
}
function upNow(it) {
  const sky = state.sky; if (!sky) return null;
  const o = it.kind === "star" ? sky.starByHip.get(it.ref) : it.kind === "dso" ? sky.dsoById.get(it.ref) : sky.bodyById.get(it.ref);
  if (!o || o.alt <= 0) return null;
  return { o, vis: !!o.vis };
}
function renderChecklist() {
  if (!$("#tab-checklist").classList.contains("active") || !ck.items.length) return;
  const seen = seenMap();
  const all = ck.items.map(it => ({ ...it, seenOn: seen.get(it.kind + ":" + it.ref), up: upNow(it) }));
  const nSeen = all.filter(i => i.seenOn).length, nUp = all.filter(i => i.up?.vis && !i.seenOn).length;
  $("#ckCount").innerHTML = `${nSeen}<small> / ${all.length} seen</small>`;
  $("#ckBar").style.width = (100 * nSeen / all.length) + "%";
  $("#ckUp").textContent = nUp ? `${nUp} unseen ${nUp === 1 ? "is" : "are"} up now` : "";
  let list = all.filter(i => ck.kind === "all" || i.kind === ck.kind);
  if (ck.status === "todo") list = list.filter(i => !i.seenOn);
  if (ck.status === "seen") list = list.filter(i => i.seenOn);
  if (ck.status === "up") list = list.filter(i => i.up?.vis);
  const LIMIT = 100, shown = ck.showAll ? list : list.slice(0, LIMIT);
  $("#ckList").innerHTML = (shown.length ? shown.map(i => {
    const loggedTonight = isLogged(i.kind, i.ref);
    const where = i.up ? (i.up.vis ? `<span class="ck-up">Up now · alt ${i.up.o.alt.toFixed(0)}° ${compass(i.up.o.az)}</span>` : `<span class="ck-dim">Up but too faint now</span>`) : "Not up now";
    const meta = [i.kind === "planet" ? i.detail : `mag ${i.mag.toFixed(1)}`, i.kind !== "planet" ? i.detail : "", i.con ? esc(i.con) : ""].filter(Boolean).join(" · ");
    const btn = i.up?.vis ? `<button class="add ${loggedTonight ? "on" : ""}" data-log="${i.kind}:${esc(String(i.ref))}" title="${loggedTonight ? "Remove from tonight's log" : "Log it tonight"}">${loggedTonight ? "✓" : "+"}</button>` : "";
    return `<div class="ck-item ${i.seenOn ? "seen" : ""}" data-focus="${i.kind}:${esc(String(i.ref))}"${i.up ? "" : ' data-noup="1"'}>
      <span class="ck-rank">${i.rank}</span><span class="ck-box">${i.seenOn ? "✓" : ""}</span>
      <div class="main"><div class="t">${esc(i.name)}</div><div class="s">${meta}</div>
      <div class="s">${i.seenOn ? `Seen ${i.seenOn} · ` : ""}${where}</div></div>${btn}</div>`;
  }).join("") : `<div class="empty">Nothing here with these filters.</div>`)
    + (!ck.showAll && list.length > LIMIT ? `<button class="btn ghost sm ck-more" id="ckMore">Show all ${list.length}</button>` : "");
}
$("#ckKind").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
  $$("#ckKind button").forEach(x => x.classList.toggle("active", x === b)); ck.kind = b.dataset.v; renderChecklist(); });
$("#ckStatus").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
  $$("#ckStatus button").forEach(x => x.classList.toggle("active", x === b)); ck.status = b.dataset.v; renderChecklist(); });
$("#ckList").addEventListener("click", e => {
  if (e.target.id === "ckMore") { ck.showAll = true; return renderChecklist(); }
  const add = e.target.closest("[data-log]");
  if (add) { const [k, r] = add.dataset.log.split(":"); toggleLog(k, k === "star" ? +r : r); return renderChecklist(); }
  const row = e.target.closest("[data-focus]"); if (!row) return;
  if (row.dataset.noup) return toast("Not above the horizon at this time — try another time with the slider");
  const [k, r] = row.dataset.focus.split(":"); focusObject({ kind: k, ref: k === "star" ? +r : r });
});

$("#sessNotes").addEventListener("input", e => { state.session.notes = e.target.value; markDirty(); });
$$(".stars-rate").forEach(el => el.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const k = el.dataset.key, v = +b.dataset.v; state.session[k] = state.session[k] === v ? 0 : v; markDirty(); renderLog();
}));
$("#saveBtn").onclick = () => saveSession(false);
$("#exportBtn").onclick = e => { e.stopPropagation(); $("#exportMenu").classList.toggle("on"); };
document.addEventListener("click", () => $("#exportMenu").classList.remove("on"));
$("#exportMenu").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.fmt === "png") return exportImage();
  if (!state.session.id || state.dirty) await saveSession(true);
  if (!state.session.id) return toast("Log something first");
  const a = document.createElement("a"); a.href = `/api/observations/${state.session.id}/export?fmt=${b.dataset.fmt}`; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
  toast("Exported — a copy is also in " + (state.dataDir ? state.dataDir + "/exports" : "exports/"));
});

/* --------------------------------------------------- image of what I saw */
let suppressLabels = false;
function renderSkyImage(w, h, view = { zoom: 1, px: 0, py: 0 }, opts = {}) {
  // re-render the sky off-screen (2x for crispness) with logged objects highlighted — not a screenshot
  const off = document.createElement("canvas"); off.width = w * 2; off.height = h * 2;
  const saved = { ctx, W, H, DPR, view: state.view, hl: state.highlightLogged, sel: state.selected };
  ctx = off.getContext("2d"); W = w; H = h; DPR = 2;
  state.view = view; state.highlightLogged = state.session.items.length > 0; state.selected = null;
  suppressLabels = !!opts.noLabels;
  try { draw(); } finally {
    suppressLabels = false;
    ({ ctx, W, H, DPR } = saved); state.view = saved.view; state.highlightLogged = saved.hl; state.selected = saved.sel;
    draw();
  }
  return off;
}
const IMG_MAX_ZOOM = 12;
function loggedExtent(w, h) {
  // bounding box (at zoom 1 on a w×h canvas) of every logged object that is up at the shown time
  const g = { R: Math.min(w, h) / 2 * 0.9, cx: w / 2, cy: h / 2 };
  const pts = [];
  for (const it of state.session.items) {
    const o = lookup(it.kind, it.ref); if (!o || o.alt <= 0) continue;
    if (it.kind === "constellation") {
      for (const seg of o.lines) for (const [alt, az] of seg) if (alt > 0) pts.push([...proj(alt, az, g), 0]);
    } else {
      const [x, y] = proj(o.alt, o.az, g);
      const r = it.kind === "dso" ? o.size / 60 / 2 * pxPerDeg(o.alt, g) : 0;
      // labels sit beside points: reserve their (unzoomed-size) width so they stay inside the frame
      pts.push([x - r, y - r, 0], [x + r, y + r, 12 + it.name.length * 6.5]);
    }
  }
  if (!pts.length) return null;
  return { g, pts };
}
function frameLogged(w, h) {
  // tightest zoom + pan that still contains every logged object (and its label) that is up now
  const ext = loggedExtent(w, h);
  if (!ext) return { zoom: 1, px: 0, py: 0 };
  const xs = ext.pts.map(p => p[0]), ys = ext.pts.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const bx = (minX + maxX) / 2, by = (minY + maxY) / 2;
  const fit = z => {   // labels keep their pixel size while the sky scales, so check the fit at zoom z
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    for (const [x, y, lw] of ext.pts) {
      const X = w / 2 + (x - bx) * z, Y = h / 2 + (y - by) * z;
      l = Math.min(l, X); r = Math.max(r, X + lw); t = Math.min(t, Y - 10); b = Math.max(b, Y + 10);
    }
    const m = 0.05;   // 5% margin
    return l >= w * m && r <= w * (1 - m) && t >= h * m && b <= h * (1 - m);
  };
  let lo = 1, hi = IMG_MAX_ZOOM;
  if (!fit(lo)) return { zoom: 1, px: 0, py: 0 };
  if (fit(hi)) lo = hi;
  else for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (fit(mid)) lo = mid; else hi = mid; }
  // centre on the box *including* labels
  let l = Infinity, r = -Infinity;
  for (const [x, , lw] of ext.pts) { const X = (x - bx) * lo; l = Math.min(l, X); r = Math.max(r, X + lw); }
  const shiftX = -(l + r) / 2;
  return { zoom: lo, px: -(bx - w / 2) * lo + shiftX, py: -(by - h / 2) * lo };
}
function imageAspect() {
  // wide groups get a wide picture, tall groups a tall one (sky area 900–2000 × 1100 logical px)
  const ext = loggedExtent(1000, 1000);
  if (!ext) return 1;
  const xs = ext.pts.map(p => p[0]), ys = ext.pts.map(p => p[1]);
  const bw = Math.max(Math.max(...xs) - Math.min(...xs), 20), bh = Math.max(Math.max(...ys) - Math.min(...ys), 20);
  return Math.max(900 / 1100, Math.min(2000 / 1100, bw / bh));
}
async function exportImage() {
  const s = state.session, sky = state.sky;
  if (!sky) return toast("Sky not ready yet");
  toast("Rendering image…");
  await new Promise(r => setTimeout(r, 30));
  const SKY = 1100, PANEL = 520, S = 2;                      // logical px; output is 2x (2200 px tall)
  const SKYW = Math.round(SKY * imageAspect());              // sky area follows the shape of what you logged
  const out = document.createElement("canvas"); out.width = (SKYW + PANEL) * S; out.height = SKY * S;
  const c = out.getContext("2d"); c.scale(S, S);
  c.fillStyle = "#000"; c.fillRect(0, 0, SKYW + PANEL, SKY);
  const view = frameLogged(SKYW, SKY);
  const zoomed = view.zoom > 1.01;
  c.drawImage(renderSkyImage(SKYW, SKY, view), 0, 0, SKYW, SKY);
  c.fillStyle = "rgba(255,255,255,.08)"; c.fillRect(SKYW, 30, 1, SKY - 60);

  // whole-sky inset with the zoomed field outlined, for context
  const INSET = 300, insetX = SKYW + 32 + (PANEL - 56 - INSET) / 2, insetY = SKY - 40 - INSET;
  if (zoomed) {
    c.drawImage(renderSkyImage(INSET, INSET, { zoom: 1, px: 0, py: 0 }, { noLabels: true }), insetX, insetY, INSET, INSET);
    // image (X,Y) → zoom-1 position on the SKYW×SKY canvas → inset
    const R0 = Math.min(SKYW, SKY) / 2 * 0.9, Ri = INSET / 2 * 0.9;
    const back = (X, Y) => {
      const x0 = SKYW / 2 + (X - SKYW / 2 - view.px) / view.zoom, y0 = SKY / 2 + (Y - SKY / 2 - view.py) / view.zoom;
      return [insetX + INSET / 2 + (x0 - SKYW / 2) * Ri / R0, insetY + INSET / 2 + (y0 - SKY / 2) * Ri / R0];
    };
    const [ax, ay] = back(0, 0), [bx2, by2] = back(SKYW, SKY);
    c.strokeStyle = "#f5c86a"; c.lineWidth = 1.5; c.strokeRect(ax, ay, bx2 - ax, by2 - ay);
    c.font = `400 11px ${getComputedStyle(document.body).fontFamily}`; c.fillStyle = "#8a8a8a"; c.textAlign = "center";
    c.fillText(`Whole sky · box = this view (${view.zoom.toFixed(1)}× zoom)`, insetX + INSET / 2, insetY - 8);
    c.textAlign = "left";
  }

  const F = getComputedStyle(document.body).fontFamily;
  const x0 = SKYW + 32, maxW = PANEL - 56;
  let y = 52;
  const text = (t, size, weight, color, gap = 6) => {
    c.font = `${weight} ${size}px ${F}`; c.fillStyle = color;
    let str = String(t);
    while (c.measureText(str).width > maxW && str.length > 3) str = str.slice(0, -2) + "…";
    c.fillText(str, x0, y); y += size + gap;
  };
  const dateStr = new Date(s.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  text("✦ Skylog", 13, 700, "#f5c86a", 14);
  text("Night of " + dateStr, 22, 900, "#ffffff", 8);
  text(`${s.place || "Custom site"} · ${fmtLat(state.lat)} ${fmtLon(state.lon)}`, 13, 400, "#a0a0a0");
  text(`Sky shown at ${localClock(state.minutes)} (UTC${state.tz >= 0 ? "+" : ""}${state.tz}) · Bortle ${state.bortle} · limit mag ${sky.limit_mag.toFixed(1)}`, 13, 400, "#a0a0a0");
  const rate = (k, label) => s[k] ? `${label} ${"★".repeat(s[k])}${"☆".repeat(5 - s[k])}` : "";
  const r = [rate("seeing", "Seeing"), rate("transparency", "Transparency")].filter(Boolean).join("   ");
  if (r) text(r, 13, 400, "#a0a0a0");
  y += 14;

  const colors = { planet: "#ff9d6b", dso: "#7ee0c8", constellation: "#8f9cff", star: "#f5d68a" };
  const nightKey = t => (t < "12:00" ? "1" : "0") + t;
  const items = [...s.items].sort((a, b) => nightKey(a.time).localeCompare(nightKey(b.time)));
  text(`${items.length} object${items.length === 1 ? "" : "s"} observed`, 15, 700, "#ffffff", 12);
  const bottom = zoomed ? insetY - 50 : SKY - 60;
  let hidden = 0;
  for (const [kind, label] of LOG_GROUPS) {
    const g = items.filter(i => i.kind === kind); if (!g.length) continue;
    if (y > bottom - 40) { hidden += g.length; continue; }
    text(`${label.toUpperCase()} · ${g.length}`, 11, 700, "#8a8a8a", 9);
    for (const it of g) {
      if (y > bottom) { hidden++; continue; }
      const o = lookup(it.kind, it.ref), up = o && o.alt > 0;
      c.fillStyle = colors[kind]; c.beginPath(); c.arc(x0 + 4, y - 5, 3.5, 0, Math.PI * 2); c.fill();
      c.font = `700 14px ${F}`; c.fillStyle = "#ececec";
      let name = it.name; while (c.measureText(name).width > maxW - 120 && name.length > 3) name = name.slice(0, -2) + "…";
      c.fillText(name, x0 + 16, y);
      c.font = `400 12px ${F}`; c.fillStyle = "#8a8a8a"; c.textAlign = "right";
      c.fillText(it.time + (up ? "" : " · not up now"), x0 + maxW, y); c.textAlign = "left";
      y += 22;
    }
    y += 8;
  }
  if (hidden) text(`+${hidden} more in the log`, 12, 400, "#8a8a8a");
  if (s.notes) { y = Math.min(y + 6, bottom); text("“" + s.notes.replace(/\s+/g, " ") + "”", 12, 400, "#a0a0a0"); }
  c.font = `400 11px ${F}`; c.fillStyle = "#5a5a5a";
  c.fillText("Logged objects highlighted · made with Skylog", x0, SKY - 16);

  const fname = `skylog_${s.date}_${(s.place || "site").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.jpg`;
  const blob = await new Promise(res => out.toBlob(res, "image/jpeg", 0.9));
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  // keep a copy next to the other exports
  fetch("/api/export-image?name=" + encodeURIComponent(fname), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob })
    .then(r => r.ok && toast("Image downloaded — a copy is also in " + (state.dataDir ? state.dataDir + "/exports" : "exports/")))
    .catch(() => toast("Image downloaded"));
}
$("#snapBtn").onclick = () => exportImage();

/* -------------------------------------------------------- UI: history */
function renderHistory() {
  const el = $("#histList");
  if (!state.history.length) { el.innerHTML = `<div class="empty"><div class="big">🔭</div>No saved sessions yet.</div>`; return; }
  el.innerHTML = state.history.map(h => {
    const cur = state.session?.id === h.id;
    const tags = h.items.slice(0, 8).map(i => `<span>${esc(i.name)}</span>`).join("") + (h.items.length > 8 ? `<span>+${h.items.length - 8}</span>` : "");
    return `<div class="hist ${cur ? "cur" : ""}" data-id="${h.id}"><div class="h1"><span>${esc(h.date)}</span><button class="del" title="Delete session"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>
      <div class="h2">${esc(h.place || "Custom site")} · Bortle ${h.bortle} · ${h.items.length} logged</div><div class="tags">${tags}</div></div>`;
  }).join("");
}
$("#histList").addEventListener("click", async e => {
  const card = e.target.closest(".hist"); if (!card) return;
  const h = state.history.find(x => x.id === card.dataset.id);
  if (e.target.closest(".del")) {
    if (!confirm(`Delete the session from ${h.date}?`)) return;
    await fetch(`/api/observations/${h.id}`, { method: "DELETE" });
    state.history = state.history.filter(x => x.id !== h.id);
    if (state.session?.id === h.id) { delete state.session.id; state.session.items = []; state.dirty = false; renderLog(); draw(); }
    renderHistory(); toast("Session deleted"); return;
  }
  if (state.dirty) await saveSession(true);
  Object.assign(state, { date: h.date, lat: h.lat, lon: h.lon, place: h.place, tz: h.tz ?? state.tz, bortle: h.bortle });
  const first = h.items[0];
  if (first?.time) { const [hh, mm] = first.time.split(":").map(Number); state.minutes = ((hh + 12) % 24) * 60 + mm; }
  state.session = null; syncInputs(); onInputsChanged();
  $$(".tab").find(t => t.dataset.tab === "log").click();
});

/* ------------------------------------------------------------ tabs */
$$(".tab").forEach(t => t.onclick = () => {
  $$(".tab").forEach(x => x.classList.toggle("active", x === t));
  $$(".tab-body").forEach(b => b.classList.toggle("active", b.id === "tab-" + t.dataset.tab));
  if (t.dataset.tab === "stats") fetchStats();
  if (t.dataset.tab === "checklist") renderChecklist();
});

/* ----------------------------------------------------------- inputs */
const BORTLE = {
  1: ["Excellent dark site", 7.6], 2: ["Truly dark site", 7.1], 3: ["Rural sky", 6.6], 4: ["Rural/suburban transition", 6.2],
  5: ["Suburban sky", 5.8], 6: ["Bright suburban sky", 5.3], 7: ["Suburban/urban transition", 4.8], 8: ["City sky", 4.3], 9: ["Inner-city sky", 3.8],
};
function syncInputs() {
  $("#place").value = state.place; $("#coords").value = fmtCoords(state.lat, state.lon); $("#coords").classList.remove("err");
  $("#date").value = state.date; $("#tz").value = state.tz; $("#minutes").value = state.minutes;
  $("#bortle").value = state.bortle; $("#hlLogged").checked = state.highlightLogged; $("#showLogged").checked = state.showLogged;
  updateLabels(); renderPlaces();
}
function updateLabels() {
  $("#timeLabel").textContent = localClock(state.minutes);
  $("#bortleNum").textContent = state.bortle;
  $("#bortleLabel").textContent = BORTLE[state.bortle][0];
  $("#bortleNelm").textContent = `zenith limit ≈ mag ${BORTLE[state.bortle][1]}`;
}
function onInputsChanged(delay) {
  updateLabels(); renderPlaces(); saveSettings();
  ensureSession(); requestSky(delay);
}

/* settings persist to a file via the server (survive port changes / browsers) */
let settingsT = null;
function saveSettings() {
  const settings = {
    location: { place: state.place, lat: state.lat, lon: state.lon, tz: state.tz, bortle: state.bortle },
    layers: state.layers, highlightLogged: state.highlightLogged, showLogged: state.showLogged,
  };
  store.set("inputs", settings.location); store.set("layers", state.layers); store.set("hlLogged", state.highlightLogged);
  clearTimeout(settingsT);
  settingsT = setTimeout(() => fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }).catch(() => {}), 400);
}
async function loadSettings() {
  try {
    const s = await (await fetch("/api/settings")).json();
    if (s.location && isFinite(s.location.lat)) Object.assign(state, s.location);
    if (s.layers) for (const k in state.layers) Object.assign(state.layers[k], s.layers[k] || {});
    if (typeof s.highlightLogged === "boolean") state.highlightLogged = s.highlightLogged;
    if (typeof s.showLogged === "boolean") state.showLogged = s.showLogged;
  } catch { /* fall back to browser storage */ }
}

/* ---- coordinate parsing: decimal, hemispheres, DMS, map links */
function fmtCoords(lat, lon) { return `${(+lat).toFixed(4)}, ${(+lon).toFixed(4)}`; }
function parseCoords(text) {
  let t = String(text).trim()
    .replace(/[′’‘`]/g, "'").replace(/[″“”]/g, '"').replace(/''/g, '"').replace(/º|˚/g, "°")
    .replace(/\b(north)\b/gi, "N").replace(/\b(south)\b/gi, "S").replace(/\b(east)\b/gi, "E").replace(/\b(west)\b/gi, "W");
  // map links: ...@51.50,-0.12,15z  or  ?q=51.50,-0.12  or  geo:51.50,-0.12
  const link = t.match(/[@=:]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (link && /[a-z]{3,}/i.test(t.replace(/\b[NSEW]\b/gi, ""))) return check(+link[1], +link[2]);
  const dms = (nums, hemi) => {
    let [d, m = 0, sec = 0] = nums.map(Number);
    let v = Math.abs(d) + m / 60 + sec / 3600;
    if (d < 0 || /^-/.test(nums[0]) || /[SW]/i.test(hemi || "")) v = -v;
    return v;
  };
  // with hemisphere letters, e.g. 51°30'26"N 0°07'39"W  /  N51.51 W0.13
  const NUM = `(-?\\d+(?:\\.\\d+)?)\\s*°?\\s*(?:(\\d+(?:\\.\\d+)?)\\s*'?\\s*)?(?:(\\d+(?:\\.\\d+)?)\\s*"?\\s*)?`;
  const prefix = /^\s*[NSEW]/i.test(t);  // "N 51.5 W 0.12" vs "51.5N 0.12W"
  const hemiRe = new RegExp(prefix ? `([NSEW])\\s*${NUM}` : `${NUM}([NSEW])`, "gi");
  const parts = [];
  for (const m of t.matchAll(hemiRe)) {
    const g = prefix ? m.slice(1) : [m[4], m[1], m[2], m[3]];  // -> [hemi, d, m, s]
    parts.push({ hemi: g[0].toUpperCase(), nums: g.slice(1).filter(x => x != null) });
  }
  if (parts.length === 2 && parts.every(p => p.hemi)) {
    const latP = parts.find(p => /[NS]/.test(p.hemi)), lonP = parts.find(p => /[EW]/.test(p.hemi));
    if (latP && lonP) return check(dms(latP.nums, latP.hemi), dms(lonP.nums, lonP.hemi));
  }
  // plain numbers: "lat, lon" or "d m s, d m s"
  const halves = t.includes(",") ? t.split(",") : null;
  if (halves && halves.length === 2) {
    const a = halves[0].match(/-?\d+(?:\.\d+)?/g), b = halves[1].match(/-?\d+(?:\.\d+)?/g);
    if (a && b) return check(dms(a, halves[0].match(/[NSEW]/i)?.[0]), dms(b, halves[1].match(/[NSEW]/i)?.[0]));
  }
  const nums = t.match(/-?\d+(?:\.\d+)?/g) || [];
  if (nums.length === 2 || nums.length === 4 || nums.length === 6) {
    const h = nums.length / 2; return check(dms(nums.slice(0, h)), dms(nums.slice(h)));
  }
  return { error: "Couldn't read that — try “51.5074, -0.1278”" };
  function check(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon)) return { error: "Couldn't read that" };
    if (Math.abs(lat) > 90) return { error: "Latitude must be between -90 and 90" };
    if (Math.abs(lon) > 180) return { error: "Longitude must be between -180 and 180" };
    return { lat: +lat.toFixed(5), lon: +lon.toFixed(5) };
  }
}
function setHint(html, cls = "") { const h = $("#coordHint"); h.innerHTML = html; h.className = "hint " + cls; }
function tzHint() {
  const est = Math.round(state.lon / 15 * 2) / 2;
  return Math.abs(est - state.tz) >= 1 ? ` · <a id="tzFix">use UTC${est >= 0 ? "+" : ""}${est}?</a>` : "";
}
function applyCoords() {
  const r = parseCoords($("#coords").value);
  if (r.error) { $("#coords").classList.add("err"); setHint(r.error, "err"); return; }
  $("#coords").classList.remove("err");
  const moved = Math.abs(r.lat - state.lat) > 1e-4 || Math.abs(r.lon - state.lon) > 1e-4;
  state.lat = r.lat; state.lon = r.lon;
  if (moved) {
    const saved = state.places.find(p => Math.abs(p.lat - r.lat) < 1e-4 && Math.abs(p.lon - r.lon) < 1e-4);
    state.place = saved ? saved.name : "Custom site";
    if (saved) { state.tz = saved.tz; if (saved.bortle) state.bortle = saved.bortle; }
  }
  syncInputs();
  setHint(`✓ ${fmtLat(r.lat)} ${fmtLon(r.lon)}` + tzHint(), "ok");
  if (moved) onInputsChanged();
}
$("#coords").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); applyCoords(); } });
$("#coords").addEventListener("change", applyCoords);
$("#coords").addEventListener("paste", () => setTimeout(applyCoords, 0));
$("#coordsGo").onclick = applyCoords;
$("#coordHint").addEventListener("click", e => {
  if (e.target.id !== "tzFix") return;
  state.tz = Math.round(state.lon / 15 * 2) / 2; syncInputs(); onInputsChanged();
  setHint(`UTC offset set to ${state.tz >= 0 ? "+" : ""}${state.tz} (estimated from longitude — adjust if needed)`, "ok");
});

/* ---- saved places (stored in places.json next to your observations) */
state.places = [];
async function loadPlaces() { try { state.places = await (await fetch("/api/places")).json(); } catch { state.places = []; } }
function renderCityList() {
  $("#cities").innerHTML = [...state.places.map(p => `<option value="${esc(p.name)}">★ saved · ${fmtCoords(p.lat, p.lon)}</option>`),
    ...CITIES.map(c => `<option value="${esc(c[0])}">`)].join("");
}
function renderPlaces() {
  $("#places").innerHTML = state.places.map(p => {
    const cur = Math.abs(p.lat - state.lat) < 1e-4 && Math.abs(p.lon - state.lon) < 1e-4;
    return `<span class="place-chip ${cur ? "cur" : ""}" data-name="${esc(p.name)}" title="${fmtLat(p.lat)} ${fmtLon(p.lon)} · UTC${p.tz >= 0 ? "+" : ""}${p.tz}${p.bortle ? ` · Bortle ${p.bortle}` : ""}"><span class="nm">★ ${esc(p.name)}</span><button class="x" title="Remove">×</button></span>`;
  }).join("");
}
function usePlace(p) {
  Object.assign(state, { place: p.name, lat: p.lat, lon: p.lon, tz: p.tz }, p.bortle ? { bortle: p.bortle } : {});
  syncInputs(); setHint(`✓ ${fmtLat(p.lat)} ${fmtLon(p.lon)}`, "ok"); onInputsChanged();
}
$("#places").addEventListener("click", async e => {
  const chip = e.target.closest(".place-chip"); if (!chip) return;
  const p = state.places.find(x => x.name === chip.dataset.name);
  if (e.target.closest(".x")) {
    state.places = await (await fetch("/api/places?name=" + encodeURIComponent(p.name), { method: "DELETE" })).json();
    renderPlaces(); renderCityList(); toast(`Removed “${p.name}”`); return;
  }
  usePlace(p);
});
$("#savePlace").onclick = () => {
  const f = $("#saveForm"); f.classList.toggle("on");
  const generic = !state.place || state.place === "Custom site" || state.place === "My location" || CITIES.some(c => c[0] === state.place);
  $("#saveName").value = generic ? "" : state.place;
  if (f.classList.contains("on")) $("#saveName").focus();
};
$("#saveCancel").onclick = () => $("#saveForm").classList.remove("on");
async function confirmSavePlace() {
  const name = $("#saveName").value.trim();
  if (!name) { $("#saveName").focus(); return toast("Give the place a name"); }
  const r = await fetch("/api/places", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, lat: state.lat, lon: state.lon, tz: state.tz, bortle: state.bortle }) });
  const res = await r.json();
  if (!r.ok) return toast(res.error || "Couldn't save place");
  state.places = res; state.place = name;
  $("#saveForm").classList.remove("on"); syncInputs(); renderCityList(); onInputsChanged();
  toast(`★ Saved “${name}” — it'll be here next time`);
}
$("#saveConfirm").onclick = confirmSavePlace;
$("#saveName").addEventListener("keydown", e => { if (e.key === "Enter") confirmSavePlace(); if (e.key === "Escape") $("#saveForm").classList.remove("on"); });

$("#place").addEventListener("change", e => {
  const v = e.target.value.trim(), lc = v.toLowerCase();
  const saved = state.places.find(p => p.name.toLowerCase() === lc);
  if (saved) return usePlace(saved);
  const c = CITIES.find(c => c[0].toLowerCase() === lc);
  state.place = v || "Custom site";
  if (c) { [state.place, state.lat, state.lon, state.tz] = c; syncInputs(); setHint(`✓ ${fmtLat(state.lat)} ${fmtLon(state.lon)}`, "ok"); }
  onInputsChanged();
});
$("#tz").addEventListener("change", e => {
  const v = parseFloat(e.target.value); if (!isFinite(v) || v < -12 || v > 14) return syncInputs();
  state.tz = v; onInputsChanged();
});
$("#date").addEventListener("change", e => { if (e.target.value) { state.date = e.target.value; onInputsChanged(); } });
$("#minutes").addEventListener("input", e => { state.minutes = +e.target.value; updateLabels(); requestSky(0); });
$("#bortle").addEventListener("input", e => { state.bortle = +e.target.value; onInputsChanged(0); });
$("#now").onclick = () => { nowToInputs(); syncInputs(); onInputsChanged(); };
$("#hlLogged").addEventListener("change", e => {
  state.highlightLogged = e.target.checked;
  if (state.highlightLogged) { state.showLogged = true; $("#showLogged").checked = true; }   // highlighting needs the marks
  saveSettings(); draw();
});
$("#showLogged").addEventListener("change", e => {
  state.showLogged = e.target.checked;
  if (!state.showLogged && state.highlightLogged) { state.highlightLogged = false; $("#hlLogged").checked = false; }
  saveSettings(); draw();
  toast(state.showLogged ? "Logged objects marked on the map" : "Map cleared — your log is unchanged");
});
$("#geo").onclick = () => {
  if (!navigator.geolocation) return toast("Geolocation not available");
  toast("Locating…");
  navigator.geolocation.getCurrentPosition(p => {
    state.lat = +p.coords.latitude.toFixed(4); state.lon = +p.coords.longitude.toFixed(4);
    state.place = "My location"; state.tz = -new Date().getTimezoneOffset() / 60;
    syncInputs(); onInputsChanged(); toast("Location set — ★ save it to reuse later");
  }, err => toast("Location unavailable: " + err.message), { timeout: 10000 });
};
let playT = null;
$("#play").onclick = () => {
  const b = $("#play");
  if (playT) { clearInterval(playT); playT = null; b.classList.remove("on"); return; }
  b.classList.add("on");
  playT = setInterval(() => { state.minutes = (state.minutes + 5) % 1440; $("#minutes").value = state.minutes; updateLabels(); requestSky(0); }, 120);
};

/* layers panel */
function renderLayers() { $("#layers").innerHTML = LAYERS.map(l => {
  const s = state.layers[l.key];
  return `<div class="layer ${s.on ? "" : "off"}" data-k="${l.key}">
    <label class="name" for="ly-${l.key}"><i class="sw" style="background:${l.color}"></i>${l.label}</label>
    <label><input type="checkbox" id="ly-${l.key}" ${s.on ? "checked" : ""}><i class="switch"></i></label>
    <div class="op"><input type="range" class="range" min="0" max="1" step="0.05" value="${s.op}"><span>${Math.round(s.op * 100)}%</span></div>
  </div>`;
}).join(""); }
$("#layers").addEventListener("input", e => {
  const row = e.target.closest(".layer"), k = row.dataset.k, s = state.layers[k];
  if (e.target.type === "checkbox") { s.on = e.target.checked; row.classList.toggle("off", !s.on); }
  else { s.op = +e.target.value; row.querySelector(".op span").textContent = Math.round(s.op * 100) + "%"; }
  saveSettings(); draw();
});

document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea")) return;
  if (e.key === "Escape") closePopover();
  if (e.key === "h") {
    state.highlightLogged = !state.highlightLogged; $("#hlLogged").checked = state.highlightLogged;
    if (state.highlightLogged) { state.showLogged = true; $("#showLogged").checked = true; }
    saveSettings(); draw();
  }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { state.minutes = Math.max(0, Math.min(1435, state.minutes + (e.key === "ArrowRight" ? 15 : -15))); $("#minutes").value = state.minutes; updateLabels(); requestSky(0); }
});
window.addEventListener("pagehide", () => {
  if (state.dirty) navigator.sendBeacon?.("/api/observations", new Blob([JSON.stringify(state.session)], { type: "application/json" }));
  navigator.sendBeacon?.("/api/bye?tab=" + TAB_ID, "");
});
/* heartbeat: the packaged app shuts down a while after its last tab closes */
const TAB_ID = Math.random().toString(36).slice(2, 10);
async function ping() {
  try { const r = await (await fetch("/api/ping?tab=" + TAB_ID)).json(); state.dataDir = r.data_dir; state.logFile = r.log_file; } catch { /* server gone */ }
}
setInterval(ping, 10000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });

/* ------------------------------------------------------------- boot */
(async function boot() {
  await Promise.all([loadSettings(), loadPlaces(), loadChecklist(), document.fonts?.load("400 12px Lato").catch(() => {})]);
  document.fonts?.ready.then(() => draw());
  renderLayers(); renderCityList();
  nowToInputs();
  syncInputs();
  await ping();
  await loadHistory();
  ensureSession();
  renderHistory();
  fetchSky();
})();
