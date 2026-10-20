// GPU checkout calculator for "How it works". Demo only: no payment, no booking, no storage, no network writes.
// Prices come from GET /api/prices when it answers within 3 s; otherwise the embedded Ornn daily index is used.
(() => {
const FALLBACK={"H100":[["2026-07-18",2.67],["2026-07-19",2.71],["2026-07-20",2.68],["2026-07-21",2.73],["2026-07-22",2.7],["2026-07-23",2.7],["2026-07-24",2.73],["2026-07-25",2.68],["2026-07-26",2.6],["2026-07-27",2.72],["2026-07-28",2.78],["2026-07-29",2.69],["2026-07-30",2.75],["2026-07-31",2.76],["2026-08-01",2.69],["2026-08-02",2.6],["2026-08-03",2.64],["2026-08-04",2.68],["2026-08-05",2.7],["2026-08-06",2.72],["2026-08-07",2.68],["2026-08-08",2.66],["2026-08-09",2.53],["2026-08-10",2.56],["2026-08-11",2.67],["2026-08-12",2.72],["2026-08-13",2.73],["2026-08-14",2.79],["2026-08-15",2.66],["2026-08-16",2.64],["2026-08-17",2.74],["2026-08-18",3.04],["2026-08-19",2.93],["2026-08-20",2.9],["2026-08-21",2.88],["2026-08-22",2.68],["2026-08-23",2.87],["2026-08-24",3],["2026-08-25",2.97],["2026-08-26",2.68],["2026-08-27",2.76],["2026-08-28",2.93],["2026-08-29",2.87],["2026-08-30",3.01],["2026-08-31",2.97],["2026-09-01",2.83],["2026-09-02",2.83],["2026-09-03",2.92],["2026-09-04",2.89],["2026-09-05",3.06],["2026-09-06",3.07],["2026-09-07",3.17],["2026-09-08",3.08],["2026-09-09",2.96],["2026-09-10",2.84],["2026-09-11",2.87],["2026-09-12",2.81],["2026-09-13",2.78],["2026-09-14",2.75],["2026-09-15",2.53],["2026-09-16",2.62],["2026-09-17",2.85],["2026-09-18",3.02],["2026-09-19",2.85],["2026-09-20",2.65],["2026-09-21",2.79],["2026-09-22",2.85],["2026-09-23",3.05],["2026-09-24",2.92],["2026-09-25",2.85],["2026-09-26",2.54],["2026-09-27",2.49],["2026-09-28",2.56],["2026-09-29",2.74],["2026-09-30",2.71],["2026-10-01",2.92],["2026-10-02",2.79],["2026-10-03",2.64],["2026-10-04",2.59],["2026-10-05",2.52],["2026-10-06",2.86],["2026-10-07",2.85],["2026-10-08",2.84],["2026-10-09",2.79],["2026-10-10",2.67],["2026-10-11",2.65],["2026-10-12",2.92],["2026-10-13",3.17],["2026-10-14",3.21],["2026-10-15",3.13],["2026-10-16",2.74],["2026-10-17",2.78]],"H200":[["2026-07-18",4.78],["2026-07-19",4.9],["2026-07-20",4.99],["2026-07-21",4.96],["2026-07-22",4.84],["2026-07-23",4.66],["2026-07-24",4.55],["2026-07-25",4.55],["2026-07-26",4.86],["2026-07-27",5.31],["2026-07-28",5],["2026-07-29",4.98],["2026-07-30",5.4],["2026-07-31",5.62],["2026-08-01",5.25],["2026-08-02",4.82],["2026-08-03",4.36],["2026-08-04",4.54],["2026-08-05",4.81],["2026-08-06",4.92],["2026-08-07",4.83],["2026-08-08",4.56],["2026-08-09",4.67],["2026-08-10",4.67],["2026-08-11",4.49],["2026-08-12",4.51],["2026-08-13",4.7],["2026-08-14",4.86],["2026-08-15",4.94],["2026-08-16",4.75],["2026-08-17",5],["2026-08-18",5.11],["2026-08-19",5.29],["2026-08-20",5.44],["2026-08-21",5.09],["2026-08-22",4.85],["2026-08-23",4.42],["2026-08-24",4.33],["2026-08-25",4.26],["2026-08-26",4.24],["2026-08-27",4.29],["2026-08-28",4.49],["2026-08-29",4.44],["2026-08-30",4.5],["2026-08-31",4.42],["2026-09-01",4.51],["2026-09-02",4.47],["2026-09-03",4.59],["2026-09-04",4.63],["2026-09-05",4.55],["2026-09-06",4.47],["2026-09-07",4.56],["2026-09-08",4.91],["2026-09-09",4.91],["2026-09-10",4.93],["2026-09-11",5.12],["2026-09-12",4.69],["2026-09-13",4.38],["2026-09-14",4.6],["2026-09-15",4.68],["2026-09-16",5.27],["2026-09-17",5.16],["2026-09-18",5.6],["2026-09-19",5.13],["2026-09-20",5.22],["2026-09-21",5.07],["2026-09-22",4.94],["2026-09-23",5.02],["2026-09-24",5.16],["2026-09-25",5.08],["2026-09-26",4.78],["2026-09-27",4.62],["2026-09-28",4.84],["2026-09-29",4.94],["2026-09-30",5.58],["2026-10-01",5.96],["2026-10-02",6.23],["2026-10-03",6.05],["2026-10-04",5.57],["2026-10-05",5.23],["2026-10-06",5.04],["2026-10-07",5.29],["2026-10-08",5.65],["2026-10-09",5.7],["2026-10-10",5.91],["2026-10-11",5.61],["2026-10-12",5.24],["2026-10-13",5.51],["2026-10-14",6.12],["2026-10-15",6.51],["2026-10-16",6.34],["2026-10-17",6.39]],"B200":[["2026-07-18",7.16],["2026-07-19",7.14],["2026-07-20",7.12],["2026-07-21",7.05],["2026-07-22",6.9],["2026-07-23",6.77],["2026-07-24",6.78],["2026-07-25",6.7],["2026-07-26",6.58],["2026-07-27",6.5],["2026-07-28",6.45],["2026-07-29",6.44],["2026-07-30",6.37],["2026-07-31",6.41],["2026-08-01",6.43],["2026-08-02",6.33],["2026-08-03",6.09],["2026-08-04",5.96],["2026-08-05",5.84],["2026-08-06",5.75],["2026-08-07",5.76],["2026-08-08",5.73],["2026-08-09",5.7],["2026-08-10",5.68],["2026-08-11",5.71],["2026-08-12",5.72],["2026-08-13",5.82],["2026-08-14",6],["2026-08-15",5.91],["2026-08-16",5.93],["2026-08-17",6.17],["2026-08-18",6.6],["2026-08-19",6.63],["2026-08-20",6.87],["2026-08-21",6.95],["2026-08-22",6.74],["2026-08-23",6.64],["2026-08-24",6.55],["2026-08-25",6.45],["2026-08-26",6.22],["2026-08-27",6.03],["2026-08-28",6.01],["2026-08-29",6.06],["2026-08-30",6.05],["2026-08-31",6.07],["2026-09-01",6.4],["2026-09-02",6.46],["2026-09-03",6.28],["2026-09-04",6.4],["2026-09-05",6.42],["2026-09-06",6.64],["2026-09-07",6.75],["2026-09-08",6.72],["2026-09-09",6.82],["2026-09-10",6.89],["2026-09-11",6.84],["2026-09-12",6.8],["2026-09-13",7.06],["2026-09-14",7.19],["2026-09-15",7.21],["2026-09-16",7.03],["2026-09-17",7.1],["2026-09-18",7.26],["2026-09-19",7.43],["2026-09-20",7.71],["2026-09-21",7.71],["2026-09-22",7.77],["2026-09-23",7.95],["2026-09-24",8.01],["2026-09-25",8.04],["2026-09-26",8.04],["2026-09-27",8.08],["2026-09-28",8.11],["2026-09-29",8.14],["2026-09-30",8.09],["2026-10-01",7.96],["2026-10-02",7.9],["2026-10-03",7.81],["2026-10-04",7.71],["2026-10-05",7.55],["2026-10-06",7.56],["2026-10-07",7.56],["2026-10-08",7.51],["2026-10-09",7.46],["2026-10-10",7.53],["2026-10-11",7.45],["2026-10-12",7.33],["2026-10-13",7.83],["2026-10-14",7.88],["2026-10-15",7.92],["2026-10-16",8.12],["2026-10-17",8.48]],"A100":[["2026-07-18",0.99],["2026-07-19",1.01],["2026-07-20",1.02],["2026-07-21",1.04],["2026-07-22",1.03],["2026-07-23",1.06],["2026-07-24",1.06],["2026-07-25",1.06],["2026-07-26",1.05],["2026-07-27",1.05],["2026-07-28",1.04],["2026-07-29",1.06],["2026-07-30",1.03],["2026-07-31",1.03],["2026-08-01",1.06],["2026-08-02",1.03],["2026-08-03",1.04],["2026-08-04",1.04],["2026-08-05",1.04],["2026-08-06",1.04],["2026-08-07",1.03],["2026-08-08",1.05],["2026-08-09",1.06],["2026-08-10",1.06],["2026-08-11",1.08],["2026-08-12",1.05],["2026-08-13",1.04],["2026-08-14",1.04],["2026-08-15",1.03],["2026-08-16",1.02],["2026-08-17",1.05],["2026-08-18",1.06],["2026-08-19",1.09],["2026-08-20",1.08],["2026-08-21",1.07],["2026-08-22",1.08],["2026-08-23",1.07],["2026-08-24",1.07],["2026-08-25",1.08],["2026-08-26",1.06],["2026-08-27",1.06],["2026-08-28",1.21],["2026-08-29",1.03],["2026-08-30",1.03],["2026-08-31",1.02],["2026-09-01",1],["2026-09-02",0.98],["2026-09-03",1.01],["2026-09-04",1.06],["2026-09-05",1.09],["2026-09-06",1.06],["2026-09-07",1.05],["2026-09-08",1.02],["2026-09-09",0.98],["2026-09-10",0.98],["2026-09-11",0.99],["2026-09-12",1.03],["2026-09-13",1.03],["2026-09-14",1.02],["2026-09-15",1.02],["2026-09-16",1.05],["2026-09-17",1.01],["2026-09-18",1],["2026-09-19",0.99],["2026-09-20",0.97],["2026-09-21",0.99],["2026-09-22",1.02],["2026-09-23",1.03],["2026-09-24",1.02],["2026-09-25",1.02],["2026-09-26",0.95],["2026-09-27",0.91],["2026-09-28",0.91],["2026-09-29",0.92],["2026-09-30",0.88],["2026-10-01",0.93],["2026-10-02",0.9],["2026-10-03",0.9],["2026-10-04",0.88],["2026-10-05",0.92],["2026-10-06",0.9],["2026-10-07",0.9],["2026-10-08",0.91],["2026-10-09",0.92],["2026-10-10",0.95],["2026-10-11",0.96],["2026-10-12",0.95],["2026-10-13",0.96],["2026-10-14",0.96],["2026-10-15",0.95],["2026-10-16",0.94],["2026-10-17",0.97]],"RTX 5090":[["2026-07-18",0.5],["2026-07-19",0.5],["2026-07-20",0.49],["2026-07-21",0.49],["2026-07-22",0.49],["2026-07-23",0.49],["2026-07-24",0.49],["2026-07-25",0.48],["2026-07-26",0.48],["2026-07-27",0.49],["2026-07-28",0.48],["2026-07-29",0.49],["2026-07-30",0.49],["2026-07-31",0.49],["2026-08-01",0.49],["2026-08-02",0.49],["2026-08-03",0.48],["2026-08-04",0.49],["2026-08-05",0.49],["2026-08-06",0.49],["2026-08-07",0.49],["2026-08-08",0.49],["2026-08-09",0.49],["2026-08-10",0.49],["2026-08-11",0.5],["2026-08-12",0.51],["2026-08-13",0.5],["2026-08-14",0.5],["2026-08-15",0.51],["2026-08-16",0.51],["2026-08-17",0.52],["2026-08-18",0.53],["2026-08-19",0.52],["2026-08-20",0.52],["2026-08-21",0.52],["2026-08-22",0.53],["2026-08-23",0.52],["2026-08-24",0.53],["2026-08-25",0.53],["2026-08-26",0.54],["2026-08-27",0.53],["2026-08-28",0.53],["2026-08-29",0.53],["2026-08-30",0.53],["2026-08-31",0.54],["2026-09-01",0.62],["2026-09-02",0.63],["2026-09-03",0.63],["2026-09-04",0.63],["2026-09-05",0.63],["2026-09-06",0.62],["2026-09-07",0.62],["2026-09-08",0.63],["2026-09-09",0.64],["2026-09-10",0.66],["2026-09-11",0.66],["2026-09-12",0.74],["2026-09-13",0.73],["2026-09-14",0.71],["2026-09-15",0.71],["2026-09-16",0.68],["2026-09-17",0.67],["2026-09-18",0.67],["2026-09-19",0.65],["2026-09-20",0.66],["2026-09-21",0.64],["2026-09-22",0.63],["2026-09-23",0.65],["2026-09-24",0.67],["2026-09-25",0.66],["2026-09-26",0.65],["2026-09-27",0.64],["2026-09-28",0.64],["2026-09-29",0.63],["2026-09-30",0.63],["2026-10-01",0.61],["2026-10-02",0.6],["2026-10-03",0.6],["2026-10-04",0.6],["2026-10-05",0.59],["2026-10-06",0.6],["2026-10-07",0.6],["2026-10-08",0.6],["2026-10-09",0.61],["2026-10-10",0.61],["2026-10-11",0.61],["2026-10-12",0.61],["2026-10-13",0.61],["2026-10-14",0.64],["2026-10-15",0.66],["2026-10-16",0.69],["2026-10-17",0.69]]};
let DATA = FALLBACK, priceSource = null;
const ORDER = ["H100", "H200", "B200", "A100", "RTX 5090"];
const ZONES = [["UTC", "UTC"], ["America/New_York", "US Eastern"], ["America/Los_Angeles", "US Pacific"], ["Europe/London", "UK"], ["Europe/Berlin", "Central Europe"]];
const QTY = [1, 2, 4].concat(Array.from({ length: 16 }, (_, i) => (i + 1) * 8));
const HOUR = 3600000, YEAR = 365 * 24 * HOUR;
const MIN_LEAD = 48 * HOUR, MAX_LEAD = YEAR, MIN_WINDOW = 4 * HOUR, CLAIM_BEFORE = 24 * HOUR;
const BOOKING_FEE = 2, CAP_MARKUP = 1.1, FEE_FACTOR = 0.4, CAP_FEE_FACTOR = 0.6;
const PRICE_TIMEOUT = 3000;
const NS = "http://www.w3.org/2000/svg";
const $ = id => document.getElementById(id);
if (!$("paper-order")) return;

const state = { gpu: "H100", kind: "lock", preset: "7" };
let pending = null;

const pad = n => String(n).padStart(2, "0");
const usd0 = n => "$" + Math.round(n).toLocaleString("en-US");
const usd2 = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = s => new Date(s + "T00:00:00Z");
const fmtDay = s => day(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// Price statistics, ported from the original app.
function stats(g) {
  const v = (DATA[g] || []).map(p => p[1]);
  if (v.length < 2) return { today: 0, first: 0, hi: 0, lo: 0, vol: 0.6 };
  const r = []; for (let i = 1; i < v.length; i++) r.push(Math.log(v[i] / v[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1));
  return { today: v[v.length - 1], first: v[0], hi: Math.max(...v), lo: Math.min(...v), vol: isFinite(sd) && sd > 0 ? sd * Math.sqrt(365) : 0.6 };
}
function spark(vals) {
  const w = 100, h = 30, lo = Math.min(...vals), hi = Math.max(...vals), k = hi - lo || 1;
  return vals.map((v, i) => (i ? "L" : "M") + (i / (vals.length - 1) * w).toFixed(1) + " " + (h - 2 - (v - lo) / k * (h - 4)).toFixed(1)).join(" ");
}

// Time zones: all maths on UTC epochs, all display through Intl.
const fmtCache = {};
function fmt(tz, opts, locale = "en-US") {
  const key = locale + tz + JSON.stringify(opts);
  return fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat(locale, Object.assign({ timeZone: tz }, opts)));
}
function parts(t, tz) {
  const o = {};
  fmt(tz, { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute };
}
function offset(t, tz) {
  const p = parts(t, tz), whole = Math.floor(t / 60000) * 60000;
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - whole;
}
function toEpoch(dateStr, h, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, h);
  const first = wall - offset(wall, tz);
  return wall - offset(first, tz);
}
function ymd(y, m, d) {
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() + "-" + pad(x.getUTCMonth() + 1) + "-" + pad(x.getUTCDate());
}
const splitDate = s => s.split("-").map(Number);
function addDays(s, n) { const [y, m, d] = splitDate(s); return ymd(y, m, d + n); }
function addMonth(s) {
  const [y, m, d] = splitDate(s);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return ymd(y, m + 1, Math.min(d, last));
}
function dateIn(t, tz) { const p = parts(t, tz); return ymd(p.y, p.m, p.d); }
function zoneName(t, tz) {
  let fallback = "";
  for (const locale of ["en-US", "en-GB"]) {
    const p = fmt(tz, { timeZoneName: "short" }, locale).formatToParts(new Date(t)).find(x => x.type === "timeZoneName");
    if (p && !/^GMT[+-]/.test(p.value)) return p.value;
    if (p && !fallback) fallback = p.value;
  }
  return fallback;
}
function dateParts(t, tz) {
  const o = {};
  fmt(tz, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; });
  return o;
}
function fmtLong(t, tz) { const o = dateParts(t, tz); return `${o.weekday} ${o.day} ${o.month} ${o.year}, ${pad(+o.hour % 24)}:${o.minute} ${zoneName(t, tz)}`; }
function fmtMid(t, tz) { const o = dateParts(t, tz); return `${o.weekday} ${o.day} ${o.month}, ${pad(+o.hour % 24)}:${o.minute} ${zoneName(t, tz)}`; }
function fmtDate(t, tz) { const o = dateParts(t, tz); return `${o.weekday} ${o.day} ${o.month}`; }
function fmtUtc(t) { const o = dateParts(t, "UTC"); return `${pad(+o.hour % 24)}:${o.minute} ${o.day} ${o.month}`; }
const fmtUtcRange = (a, b) => `${fmtUtc(a)} → ${fmtUtc(b)}`;

function qtyLabel(n) {
  if (n < 8) return `${n} GPU${n > 1 ? "s" : ""} · single`;
  const nodes = n / 8;
  return `${n} GPUs · ${nodes} node${nodes > 1 ? "s" : ""}`;
}

function setupControls() {
  const qty = $("co-qty");
  QTY.forEach(n => qty.add(new Option(n < 8 ? `${n} GPU${n > 1 ? "s" : ""}` : `${n / 8} node${n > 8 ? "s" : ""} (${n} GPUs)`, n)));
  qty.value = "8";
  const tz = $("co-tz"), local = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!ZONES.some(z => z[0] === local)) tz.add(new Option(`Your time (${local.replace(/_/g, " ")})`, local));
  ZONES.forEach(([id, name]) => tz.add(new Option(id === local ? `${name} (your time)` : name, id)));
  tz.value = local;
  ["co-start-h", "co-end-h"].forEach(id => { for (let h = 0; h < 24; h++) $(id).add(new Option(pad(h) + ":00", h)); });
}

// Default window: the first Monday 09:00 at least 48 h away, for one week.
function setDefaults() {
  const tz = $("co-tz").value, now = Date.now(), today = dateIn(now, tz);
  let start = addDays(today, 3);
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i), [y, m, dd] = splitDate(d);
    if (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() === 1 && toEpoch(d, 9, tz) >= now + MIN_LEAD) { start = d; break; }
  }
  $("co-start-d").value = start;
  $("co-start-h").value = "9";
  state.preset = "7";
  applyPreset();
}
function applyPreset() {
  const sd = $("co-start-d").value;
  if (!state.preset || !sd) return;
  $("co-end-d").value = state.preset === "m1" ? addMonth(sd) : addDays(sd, +state.preset);
  $("co-end-h").value = $("co-start-h").value;
}
function updateLimits() {
  const tz = $("co-tz").value, now = Date.now();
  $("co-start-d").min = dateIn(now + MIN_LEAD, tz);
  $("co-start-d").max = dateIn(now + MAX_LEAD, tz);
  $("co-end-d").min = $("co-start-d").value || $("co-start-d").min;
}

function readWindow() {
  const tz = $("co-tz").value, sd = $("co-start-d").value, ed = $("co-end-d").value;
  if (!sd || !ed) return { ok: false, msg: "Pick a start and an end date.", field: sd ? "end" : "start", tz };
  const sh = +$("co-start-h").value, eh = +$("co-end-h").value;
  const start = toEpoch(sd, sh, tz), end = toEpoch(ed, eh, tz), now = Date.now();
  const shifted = parts(start, tz).h !== sh || parts(end, tz).h !== eh;
  let msg = "", field = "";
  if (start < now + MIN_LEAD) { msg = "Start must be at least 48 hours from now."; field = "start"; }
  else if (start > now + MAX_LEAD) { msg = "Start must be within the next 12 months."; field = "start"; }
  else if (end <= start) { msg = "End must be after the start."; field = "end"; }
  else if (end - start < MIN_WINDOW) { msg = "The window must be at least 4 hours."; field = "end"; }
  return { ok: !msg, msg, field, tz, start, end, shifted, hours: Math.round((end - start) / HOUR) };
}

function quote() {
  const g = state.gpu, kind = state.kind, s = stats(g), n = +$("co-qty").value, w = readWindow();
  const price = kind === "cap" ? Math.round(s.today * CAP_MARKUP * 100) / 100 : s.today;
  const q = { g, kind, n, w, price, today: s.today, vol: s.vol, region: $("co-region").value, ok: w.ok };
  if (!w.ok) return q;
  q.years = Math.max(1 / 52, (w.end - Date.now()) / YEAR);
  const raw = s.today * s.vol * Math.sqrt(q.years) * FEE_FACTOR * (kind === "cap" ? CAP_FEE_FACTOR : 1);
  q.per = Math.round(raw * 100) / 100;
  q.gpuHours = n * w.hours;
  q.fee = Math.round(q.per * q.gpuHours);
  q.compute = Math.round(price * q.gpuHours);
  q.upfront = q.fee + BOOKING_FEE;
  q.total = q.upfront + q.compute;
  q.claim = w.start - CLAIM_BEFORE;
  return q;
}

function renderTabs() {
  const box = $("co-tabs"); box.textContent = "";
  ORDER.forEach(g => {
    const s = stats(g), chg = (s.today / s.first - 1) * 100;
    const b = document.createElement("button");
    b.type = "button"; b.className = "co-tab"; b.dataset.gpu = g; b.setAttribute("aria-pressed", String(g === state.gpu));
    b.innerHTML = '<span class="co-tab-name"></span><span class="co-tab-price"></span><span class="co-tab-chg"></span><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path></path></svg>';
    b.querySelector(".co-tab-name").textContent = g;
    b.querySelector(".co-tab-price").innerHTML = usd2(s.today) + " <small>/ GPU-h</small>";
    b.querySelector(".co-tab-chg").textContent = (chg >= 0 ? "↑ +" : "↓ −") + Math.abs(chg).toFixed(0) + "% in 90 days";
    b.querySelector("path").setAttribute("d", spark(DATA[g].map(p => p[1])));
    b.addEventListener("click", () => { state.gpu = g; renderAll(); $("co-tabs").querySelector(`[data-gpu="${g}"]`).focus(); });
    box.appendChild(b);
  });
}

function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; }
// Chart drawing, ported from the original app (history only; a dashed line marks the cap).
function renderChart() {
  const g = state.gpu, hist = DATA[g], s = stats(g), chg = (s.today / s.first - 1) * 100;
  const cap = state.kind === "cap" ? Math.round(s.today * CAP_MARKUP * 100) / 100 : null;
  $("co-chart-title").textContent = g + " price, last 90 days";
  $("co-s-today").textContent = usd2(s.today); $("co-s-high").textContent = usd2(s.hi); $("co-s-low").textContent = usd2(s.lo);
  $("co-s-chg").textContent = (chg >= 0 ? "+" : "−") + Math.abs(chg).toFixed(1) + "%";
  const svg = $("co-svg"); svg.textContent = "";
  const W = Math.max(300, $("co-plot").clientWidth), H = W < 560 ? 190 : 250, L = 46, R = cap ? 74 : 14, T = 12, B = 26;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  const t0 = day(hist[0][0]).getTime(), t1 = day(hist[hist.length - 1][0]).getTime();
  const vals = hist.map(p => p[1]).concat(cap ? [cap] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const step = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5].find(v => (hi - lo) / v <= 5) || 10;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step; if (hi === lo) hi = lo + step;
  const x = d => L + (day(d).getTime() - t0) / (t1 - t0) * (W - L - R), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  for (let v = lo; v <= hi + step / 2; v += step) {
    const yy = y(v);
    el("line", { x1: L, x2: W - R, y1: yy, y2: yy, stroke: "#052b4214" }, svg);
    el("text", { x: L - 8, y: yy + 4, "text-anchor": "end" }, svg).textContent = "$" + v.toFixed(step < 1 ? 2 : 0);
  }
  const d0 = day(hist[0][0]); d0.setUTCDate(1);
  let tick = 0;
  for (let d = new Date(d0); d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 1)) {
    if (d.getTime() < t0) continue;
    if (W < 560 && tick++ % 2) continue;
    el("text", { x: x(d.toISOString().slice(0, 10)), y: H - 6, "text-anchor": "middle" }, svg).textContent = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  }
  const line = pts => pts.map((p, i) => (i ? "L" : "M") + x(p[0]).toFixed(1) + " " + y(p[1]).toFixed(1)).join(" ");
  if (cap) {
    el("line", { x1: L, x2: W - R, y1: y(cap), y2: y(cap), stroke: "#052b42", "stroke-width": 1.5, "stroke-dasharray": "4 5" }, svg);
    el("text", { x: W - R + 8, y: y(cap) + 4 }, svg).textContent = "Cap " + usd2(cap);
  }
  const last = hist[hist.length - 1];
  el("path", { d: line(hist), fill: "none", stroke: "var(--violet)", "stroke-width": 2, "stroke-linejoin": "round" }, svg);
  el("circle", { cx: x(last[0]), cy: y(last[1]), r: 9, fill: "var(--violet)", "fill-opacity": .18 }, svg);
  el("circle", { cx: x(last[0]), cy: y(last[1]), r: 4.5, fill: "var(--violet)", stroke: "#fffefb", "stroke-width": 2 }, svg);
  const cross = el("line", { y1: T, y2: H - B, stroke: "#052b4240", visibility: "hidden" }, svg);
  const dot = el("circle", { r: 4, fill: "var(--ink)", visibility: "hidden" }, svg);
  const tip = $("co-tip");
  svg.onpointermove = e => {
    const r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) * W / r.width;
    let best = hist[0], bd = 1e9; hist.forEach(p => { const dd = Math.abs(x(p[0]) - mx); if (dd < bd) { bd = dd; best = p; } });
    const px = x(best[0]), py = y(best[1]);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    tip.textContent = fmtDay(best[0]) + "  " + usd2(best[1]);
    tip.style.left = (px * r.width / W) + "px"; tip.style.top = (py * r.height / H) + "px"; tip.hidden = false;
  };
  svg.onpointerleave = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; };
  $("co-asof").textContent = priceSource
    ? `Ornn daily index. Prices as of ${fmtDay(priceSource.asOf)} · ${priceSource.live ? "live" : "cached"}.`
    : "Ornn daily index. Prices as of " + fmtDay(last[0]) + ".";
}

function markInvalid(ids, bad) { ids.forEach(id => { if (bad) $(id).setAttribute("aria-invalid", "true"); else $(id).removeAttribute("aria-invalid"); }); }
function renderWindow(w) {
  document.querySelectorAll("#paper-order [data-preset]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset)));
  const has = w.start !== undefined;
  $("co-dur").textContent = has && w.end > w.start ? `${w.hours.toLocaleString("en-US")} h` : "—";
  $("co-win-local").textContent = has ? `${fmtLong(w.start, w.tz)} → ${fmtLong(w.end, w.tz)}` : "";
  $("co-win-utc").textContent = has ? "UTC " + fmtUtcRange(w.start, w.end) + (w.shifted ? " · clock change: moved to the next real hour" : "") : "";
  const err = $("co-error");
  err.hidden = w.ok; err.textContent = w.ok ? "" : w.msg;
  markInvalid(["co-start-d", "co-start-h"], !w.ok && w.field === "start");
  markInvalid(["co-end-d", "co-end-h"], !w.ok && w.field === "end");
}

function renderQuote() {
  const q = quote(), cap = q.kind === "cap", dash = "—";
  $("co-qty-read").textContent = qtyLabel(q.n);
  renderWindow(q.w);
  $("co-quote-title").textContent = `${q.g} · ${cap ? "Cap" : "Lock"}`;
  $("co-q-price-l").textContent = cap ? "Cap price" : "Locked price";
  $("co-q-price").textContent = usd2(q.price) + " / GPU-h";
  $("co-q-compute-l").textContent = cap ? "Compute, at most" : "Compute, if used";
  $("co-q-total-l").textContent = cap ? "Total, at most" : "Total, if used";
  $("co-q-hours").textContent = q.ok ? q.gpuHours.toLocaleString("en-US") : dash;
  $("co-q-per").textContent = q.ok ? usd2(q.per) + " / GPU-h" : "";
  $("co-q-fee").textContent = q.ok ? usd0(q.fee) : dash;
  $("co-q-upfront").textContent = q.ok ? usd0(q.upfront) : dash;
  $("co-q-compute").textContent = q.ok ? usd0(q.compute) : dash;
  $("co-q-total").textContent = q.ok ? usd0(q.total) : dash;
  const tz = q.w.tz;
  $("co-t-now").textContent = fmtDate(Date.now(), tz);
  $("co-t-claim").textContent = q.ok ? fmtMid(q.claim, tz) : dash;
  $("co-t-start").textContent = q.ok ? fmtMid(q.w.start, tz) : dash;
  $("co-t-end").textContent = q.ok ? fmtMid(q.w.end, tz) : dash;
  $("co-buy").disabled = !q.ok;
}
function renderAll() {
  renderTabs(); renderChart(); updateLimits(); renderQuote();
  document.querySelectorAll("#paper-order [data-kind]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.kind === state.kind)));
}

function fillList(list, rows) {
  list.textContent = "";
  rows.forEach(([label, value, sub, strong]) => {
    const row = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
    if (strong) row.className = "co-dl-strong";
    dt.textContent = label; dd.textContent = value;
    if (sub) { const s = document.createElement("small"); s.textContent = sub; dd.appendChild(s); }
    row.append(dt, dd); list.appendChild(row);
  });
}
function summaryRows(q) {
  const cap = q.kind === "cap";
  return [
    ["Compute", `${q.g} · ${qtyLabel(q.n)}`, q.region + " (preference)"],
    ["Window", `${fmtLong(q.w.start, q.w.tz)} → ${fmtLong(q.w.end, q.w.tz)}`, `${q.w.hours} h · ${q.gpuHours.toLocaleString("en-US")} GPU-hours`],
    ["UTC", fmtUtcRange(q.w.start, q.w.end)],
    ["Claim by", fmtLong(q.claim, q.w.tz), "Unclaimed bookings expire; the upfront fee is kept."],
    ["Protection", `${cap ? "Cap" : "Lock"} at ${usd2(q.price)} / GPU-h`],
    ["Pay now", usd0(q.upfront), `Protection ${usd0(q.fee)} + booking ${usd0(BOOKING_FEE)}`, true],
    [cap ? "Compute, at most" : "Compute, if used", usd0(q.compute)],
    [cap ? "Total, at most" : "Total, if used", usd0(q.total), null, true],
  ];
}
function demoRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", bytes = crypto.getRandomValues(new Uint8Array(6));
  return "DEMO-" + Array.from(bytes, b => chars[b % chars.length]).join("");
}

function openReview() {
  const q = quote();
  if (!q.ok) return;
  pending = q;
  fillList($("co-review-list"), summaryRows(q));
  $("co-consent").checked = false; $("co-confirm").disabled = true;
  $("co-review").hidden = false; $("co-receipt").hidden = true;
  const d = $("co-dialog");
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
}
function closeDialog() { const d = $("co-dialog"); if (d.close) d.close(); else d.removeAttribute("open"); }
function confirmBooking() {
  if (!pending || !$("co-consent").checked) return;
  if (pending.w.start < Date.now() + MIN_LEAD) { closeDialog(); renderQuote(); return; }
  const ref = demoRef();
  $("co-ref").textContent = ref;
  fillList($("co-receipt-list"), summaryRows(pending));
  $("co-review").hidden = true; $("co-receipt").hidden = false;
  $("co-r-title").focus();
}
function startAnother() {
  closeDialog(); pending = null;
  state.kind = "lock";
  $("co-qty").value = "8"; $("co-region").selectedIndex = 0;
  setDefaults(); renderAll();
}

// Live prices replace the embedded series only when every GPU has a usable history.
const isDay = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const validSeries = s => Array.isArray(s) && s.length >= 2 && s.every(p => Array.isArray(p) && isDay(p[0]) && Number.isFinite(p[1]) && p[1] > 0);
async function loadPrices() {
  if (!window.fetch || !window.AbortController) return;
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), PRICE_TIMEOUT);
  try {
    const res = await fetch("/api/prices", { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const body = await res.json();
    if (!body || !body.data || !ORDER.every(g => validSeries(body.data[g]))) return;
    DATA = body.data;
    priceSource = { asOf: isDay(body.asOf) ? body.asOf : DATA[state.gpu].at(-1)[0], live: body.live === true };
    const focusedTab = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.gpu : null;
    renderAll();
    if (focusedTab) $("co-tabs").querySelector(`[data-gpu="${focusedTab}"]`).focus();
  } catch {
    // No endpoint, offline, or slow: keep the embedded prices.
  } finally { clearTimeout(timer); }
}

setupControls();
setDefaults();
renderAll();
loadPrices();

$("co-form").addEventListener("submit", e => e.preventDefault());
["co-qty", "co-region"].forEach(id => $(id).addEventListener("change", renderQuote));
$("co-tz").addEventListener("change", () => { updateLimits(); renderQuote(); });
["co-start-d", "co-start-h"].forEach(id => $(id).addEventListener("change", () => { applyPreset(); updateLimits(); renderQuote(); }));
["co-end-d", "co-end-h"].forEach(id => $(id).addEventListener("change", () => { state.preset = null; renderQuote(); }));
document.querySelectorAll("#paper-order [data-preset]").forEach(b => b.addEventListener("click", () => { state.preset = b.dataset.preset; applyPreset(); updateLimits(); renderQuote(); }));
document.querySelectorAll("#paper-order [data-kind]").forEach(b => b.addEventListener("click", () => {
  state.kind = b.dataset.kind;
  document.querySelectorAll("#paper-order [data-kind]").forEach(o => o.setAttribute("aria-pressed", String(o === b)));
  renderChart(); renderQuote();
}));
$("co-buy").addEventListener("click", openReview);
$("co-back").addEventListener("click", closeDialog);
$("co-consent").addEventListener("change", e => { $("co-confirm").disabled = !e.target.checked; });
$("co-confirm").addEventListener("click", confirmBooking);
$("co-again").addEventListener("click", startAnother);
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 120); });
})();
