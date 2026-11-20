// GPU checkout calculator for "How it works". Demo only: no payment, no booking, no server writes.
// Prices come from GET /api/prices when it answers within 3 s; otherwise the embedded Ornn daily index is used.
// Quotes come from GET /api/quote (pricing v0); if it fails, a local formula is shown as "indicative (offline)".
// Each demo receipt is appended to sessionStorage.dodonaDemoBookings for the dashboard.
(() => {
const FALLBACK={"H100":[["2026-07-18",2.67],["2026-07-19",2.71],["2026-07-20",2.68],["2026-07-21",2.73],["2026-07-22",2.7],["2026-07-23",2.7],["2026-07-24",2.73],["2026-07-25",2.68],["2026-07-26",2.6],["2026-07-27",2.72],["2026-07-28",2.78],["2026-07-29",2.69],["2026-07-30",2.75],["2026-07-31",2.76],["2026-08-01",2.69],["2026-08-02",2.6],["2026-08-03",2.64],["2026-08-04",2.68],["2026-08-05",2.7],["2026-08-06",2.72],["2026-08-07",2.68],["2026-08-08",2.66],["2026-08-09",2.53],["2026-08-10",2.56],["2026-08-11",2.67],["2026-08-12",2.72],["2026-08-13",2.73],["2026-08-14",2.79],["2026-08-15",2.66],["2026-08-16",2.64],["2026-08-17",2.74],["2026-08-18",3.04],["2026-08-19",2.93],["2026-08-20",2.9],["2026-08-21",2.88],["2026-08-22",2.68],["2026-08-23",2.87],["2026-08-24",3],["2026-08-25",2.97],["2026-08-26",2.68],["2026-08-27",2.76],["2026-08-28",2.93],["2026-08-29",2.87],["2026-08-30",3.01],["2026-08-31",2.97],["2026-09-01",2.83],["2026-09-02",2.83],["2026-09-03",2.92],["2026-09-04",2.89],["2026-09-05",3.06],["2026-09-06",3.07],["2026-09-07",3.17],["2026-09-08",3.08],["2026-09-09",2.96],["2026-09-10",2.84],["2026-09-11",2.87],["2026-09-12",2.81],["2026-09-13",2.78],["2026-09-14",2.75],["2026-09-15",2.53],["2026-09-16",2.62],["2026-09-17",2.85],["2026-09-18",3.02],["2026-09-19",2.85],["2026-09-20",2.65],["2026-09-21",2.79],["2026-09-22",2.85],["2026-09-23",3.05],["2026-09-24",2.92],["2026-09-25",2.85],["2026-09-26",2.54],["2026-09-27",2.49],["2026-09-28",2.56],["2026-09-29",2.74],["2026-09-30",2.71],["2026-10-01",2.92],["2026-10-02",2.79],["2026-10-03",2.64],["2026-10-04",2.59],["2026-10-05",2.52],["2026-10-06",2.86],["2026-10-07",2.85],["2026-10-08",2.84],["2026-10-09",2.79],["2026-10-10",2.67],["2026-10-11",2.65],["2026-10-12",2.92],["2026-10-13",3.17],["2026-10-14",3.21],["2026-10-15",3.13],["2026-10-16",2.74],["2026-10-17",2.78]],"H200":[["2026-07-18",4.78],["2026-07-19",4.9],["2026-07-20",4.99],["2026-07-21",4.96],["2026-07-22",4.84],["2026-07-23",4.66],["2026-07-24",4.55],["2026-07-25",4.55],["2026-07-26",4.86],["2026-07-27",5.31],["2026-07-28",5],["2026-07-29",4.98],["2026-07-30",5.4],["2026-07-31",5.62],["2026-08-01",5.25],["2026-08-02",4.82],["2026-08-03",4.36],["2026-08-04",4.54],["2026-08-05",4.81],["2026-08-06",4.92],["2026-08-07",4.83],["2026-08-08",4.56],["2026-08-09",4.67],["2026-08-10",4.67],["2026-08-11",4.49],["2026-08-12",4.51],["2026-08-13",4.7],["2026-08-14",4.86],["2026-08-15",4.94],["2026-08-16",4.75],["2026-08-17",5],["2026-08-18",5.11],["2026-08-19",5.29],["2026-08-20",5.44],["2026-08-21",5.09],["2026-08-22",4.85],["2026-08-23",4.42],["2026-08-24",4.33],["2026-08-25",4.26],["2026-08-26",4.24],["2026-08-27",4.29],["2026-08-28",4.49],["2026-08-29",4.44],["2026-08-30",4.5],["2026-08-31",4.42],["2026-09-01",4.51],["2026-09-02",4.47],["2026-09-03",4.59],["2026-09-04",4.63],["2026-09-05",4.55],["2026-09-06",4.47],["2026-09-07",4.56],["2026-09-08",4.91],["2026-09-09",4.91],["2026-09-10",4.93],["2026-09-11",5.12],["2026-09-12",4.69],["2026-09-13",4.38],["2026-09-14",4.6],["2026-09-15",4.68],["2026-09-16",5.27],["2026-09-17",5.16],["2026-09-18",5.6],["2026-09-19",5.13],["2026-09-20",5.22],["2026-09-21",5.07],["2026-09-22",4.94],["2026-09-23",5.02],["2026-09-24",5.16],["2026-09-25",5.08],["2026-09-26",4.78],["2026-09-27",4.62],["2026-09-28",4.84],["2026-09-29",4.94],["2026-09-30",5.58],["2026-10-01",5.96],["2026-10-02",6.23],["2026-10-03",6.05],["2026-10-04",5.57],["2026-10-05",5.23],["2026-10-06",5.04],["2026-10-07",5.29],["2026-10-08",5.65],["2026-10-09",5.7],["2026-10-10",5.91],["2026-10-11",5.61],["2026-10-12",5.24],["2026-10-13",5.51],["2026-10-14",6.12],["2026-10-15",6.51],["2026-10-16",6.34],["2026-10-17",6.39]],"B200":[["2026-07-18",7.16],["2026-07-19",7.14],["2026-07-20",7.12],["2026-07-21",7.05],["2026-07-22",6.9],["2026-07-23",6.77],["2026-07-24",6.78],["2026-07-25",6.7],["2026-07-26",6.58],["2026-07-27",6.5],["2026-07-28",6.45],["2026-07-29",6.44],["2026-07-30",6.37],["2026-07-31",6.41],["2026-08-01",6.43],["2026-08-02",6.33],["2026-08-03",6.09],["2026-08-04",5.96],["2026-08-05",5.84],["2026-08-06",5.75],["2026-08-07",5.76],["2026-08-08",5.73],["2026-08-09",5.7],["2026-08-10",5.68],["2026-08-11",5.71],["2026-08-12",5.72],["2026-08-13",5.82],["2026-08-14",6],["2026-08-15",5.91],["2026-08-16",5.93],["2026-08-17",6.17],["2026-08-18",6.6],["2026-08-19",6.63],["2026-08-20",6.87],["2026-08-21",6.95],["2026-08-22",6.74],["2026-08-23",6.64],["2026-08-24",6.55],["2026-08-25",6.45],["2026-08-26",6.22],["2026-08-27",6.03],["2026-08-28",6.01],["2026-08-29",6.06],["2026-08-30",6.05],["2026-08-31",6.07],["2026-09-01",6.4],["2026-09-02",6.46],["2026-09-03",6.28],["2026-09-04",6.4],["2026-09-05",6.42],["2026-09-06",6.64],["2026-09-07",6.75],["2026-09-08",6.72],["2026-09-09",6.82],["2026-09-10",6.89],["2026-09-11",6.84],["2026-09-12",6.8],["2026-09-13",7.06],["2026-09-14",7.19],["2026-09-15",7.21],["2026-09-16",7.03],["2026-09-17",7.1],["2026-09-18",7.26],["2026-09-19",7.43],["2026-09-20",7.71],["2026-09-21",7.71],["2026-09-22",7.77],["2026-09-23",7.95],["2026-09-24",8.01],["2026-09-25",8.04],["2026-09-26",8.04],["2026-09-27",8.08],["2026-09-28",8.11],["2026-09-29",8.14],["2026-09-30",8.09],["2026-10-01",7.96],["2026-10-02",7.9],["2026-10-03",7.81],["2026-10-04",7.71],["2026-10-05",7.55],["2026-10-06",7.56],["2026-10-07",7.56],["2026-10-08",7.51],["2026-10-09",7.46],["2026-10-10",7.53],["2026-10-11",7.45],["2026-10-12",7.33],["2026-10-13",7.83],["2026-10-14",7.88],["2026-10-15",7.92],["2026-10-16",8.12],["2026-10-17",8.48]],"A100":[["2026-07-18",0.99],["2026-07-19",1.01],["2026-07-20",1.02],["2026-07-21",1.04],["2026-07-22",1.03],["2026-07-23",1.06],["2026-07-24",1.06],["2026-07-25",1.06],["2026-07-26",1.05],["2026-07-27",1.05],["2026-07-28",1.04],["2026-07-29",1.06],["2026-07-30",1.03],["2026-07-31",1.03],["2026-08-01",1.06],["2026-08-02",1.03],["2026-08-03",1.04],["2026-08-04",1.04],["2026-08-05",1.04],["2026-08-06",1.04],["2026-08-07",1.03],["2026-08-08",1.05],["2026-08-09",1.06],["2026-08-10",1.06],["2026-08-11",1.08],["2026-08-12",1.05],["2026-08-13",1.04],["2026-08-14",1.04],["2026-08-15",1.03],["2026-08-16",1.02],["2026-08-17",1.05],["2026-08-18",1.06],["2026-08-19",1.09],["2026-08-20",1.08],["2026-08-21",1.07],["2026-08-22",1.08],["2026-08-23",1.07],["2026-08-24",1.07],["2026-08-25",1.08],["2026-08-26",1.06],["2026-08-27",1.06],["2026-08-28",1.21],["2026-08-29",1.03],["2026-08-30",1.03],["2026-08-31",1.02],["2026-09-01",1],["2026-09-02",0.98],["2026-09-03",1.01],["2026-09-04",1.06],["2026-09-05",1.09],["2026-09-06",1.06],["2026-09-07",1.05],["2026-09-08",1.02],["2026-09-09",0.98],["2026-09-10",0.98],["2026-09-11",0.99],["2026-09-12",1.03],["2026-09-13",1.03],["2026-09-14",1.02],["2026-09-15",1.02],["2026-09-16",1.05],["2026-09-17",1.01],["2026-09-18",1],["2026-09-19",0.99],["2026-09-20",0.97],["2026-09-21",0.99],["2026-09-22",1.02],["2026-09-23",1.03],["2026-09-24",1.02],["2026-09-25",1.02],["2026-09-26",0.95],["2026-09-27",0.91],["2026-09-28",0.91],["2026-09-29",0.92],["2026-09-30",0.88],["2026-10-01",0.93],["2026-10-02",0.9],["2026-10-03",0.9],["2026-10-04",0.88],["2026-10-05",0.92],["2026-10-06",0.9],["2026-10-07",0.9],["2026-10-08",0.91],["2026-10-09",0.92],["2026-10-10",0.95],["2026-10-11",0.96],["2026-10-12",0.95],["2026-10-13",0.96],["2026-10-14",0.96],["2026-10-15",0.95],["2026-10-16",0.94],["2026-10-17",0.97]],"RTX 5090":[["2026-07-18",0.5],["2026-07-19",0.5],["2026-07-20",0.49],["2026-07-21",0.49],["2026-07-22",0.49],["2026-07-23",0.49],["2026-07-24",0.49],["2026-07-25",0.48],["2026-07-26",0.48],["2026-07-27",0.49],["2026-07-28",0.48],["2026-07-29",0.49],["2026-07-30",0.49],["2026-07-31",0.49],["2026-08-01",0.49],["2026-08-02",0.49],["2026-08-03",0.48],["2026-08-04",0.49],["2026-08-05",0.49],["2026-08-06",0.49],["2026-08-07",0.49],["2026-08-08",0.49],["2026-08-09",0.49],["2026-08-10",0.49],["2026-08-11",0.5],["2026-08-12",0.51],["2026-08-13",0.5],["2026-08-14",0.5],["2026-08-15",0.51],["2026-08-16",0.51],["2026-08-17",0.52],["2026-08-18",0.53],["2026-08-19",0.52],["2026-08-20",0.52],["2026-08-21",0.52],["2026-08-22",0.53],["2026-08-23",0.52],["2026-08-24",0.53],["2026-08-25",0.53],["2026-08-26",0.54],["2026-08-27",0.53],["2026-08-28",0.53],["2026-08-29",0.53],["2026-08-30",0.53],["2026-08-31",0.54],["2026-09-01",0.62],["2026-09-02",0.63],["2026-09-03",0.63],["2026-09-04",0.63],["2026-09-05",0.63],["2026-09-06",0.62],["2026-09-07",0.62],["2026-09-08",0.63],["2026-09-09",0.64],["2026-09-10",0.66],["2026-09-11",0.66],["2026-09-12",0.74],["2026-09-13",0.73],["2026-09-14",0.71],["2026-09-15",0.71],["2026-09-16",0.68],["2026-09-17",0.67],["2026-09-18",0.67],["2026-09-19",0.65],["2026-09-20",0.66],["2026-09-21",0.64],["2026-09-22",0.63],["2026-09-23",0.65],["2026-09-24",0.67],["2026-09-25",0.66],["2026-09-26",0.65],["2026-09-27",0.64],["2026-09-28",0.64],["2026-09-29",0.63],["2026-09-30",0.63],["2026-10-01",0.61],["2026-10-02",0.6],["2026-10-03",0.6],["2026-10-04",0.6],["2026-10-05",0.59],["2026-10-06",0.6],["2026-10-07",0.6],["2026-10-08",0.6],["2026-10-09",0.61],["2026-10-10",0.61],["2026-10-11",0.61],["2026-10-12",0.61],["2026-10-13",0.61],["2026-10-14",0.64],["2026-10-15",0.66],["2026-10-16",0.69],["2026-10-17",0.69]]};
let DATA = FALLBACK, priceSource = null, dataVersion = 0;
const ORDER = ["H100", "H200", "B200", "A100", "RTX 5090"];
const ZONES = [["UTC", "UTC"], ["America/New_York", "US Eastern"], ["America/Los_Angeles", "US Pacific"], ["Europe/London", "UK"], ["Europe/Berlin", "Central Europe"]];
const QTY = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const RFQ = "rfq";
const HOUR = 3600000, DAY = 24 * HOUR, YEAR = 365 * DAY;
const MIN_LEAD = 48 * HOUR, MAX_LEAD = YEAR, MIN_WINDOW = 4 * HOUR, CLAIM_BEFORE = 24 * HOUR;
const FEE_FACTOR = 0.4, CAP_FEE_FACTOR = 0.6, PLATFORM_FEE_SHARE = 0.15;
const DRIFT_CLAMP = 0.3, WEEK_POINTS = 7, MIN_WEEKLY_POINTS = 8, MAX_STRIKE = 1000;
const CONFIG = "SXM-IB";
const PRICE_TIMEOUT = 3000, QUOTE_TIMEOUT = 3000, QUOTE_DEBOUNCE = 250;
const BOOKINGS_KEY = "dodonaDemoBookings";
const AUDIT_URL = "/api/audit/events";
const NS = "http://www.w3.org/2000/svg";
const $ = id => document.getElementById(id);
if (!$("paper-order")) return;

const state = { gpu: "H100", kind: "lock", preset: "7", strikeFactor: 1, strikeCustom: null };
let pending = null, live = null, requestedKey = null, quoteTimer = null, quoteSeq = 0;

const pad = n => String(n).padStart(2, "0");
const round2 = n => Math.round(n * 100) / 100;
const usd2 = n => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const perHour = n => usd2(n) + " / GPU-h";
const day = s => new Date(s + "T00:00:00Z");
const fmtDay = s => day(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// Price statistics for the tabs and the chart, ported from the original app.
function stats(g) {
  const v = (DATA[g] || []).map(p => p[1]);
  if (v.length < 2) return { today: 0, first: 0, hi: 0, lo: 0, vol: 0.6 };
  const r = []; for (let i = 1; i < v.length; i++) r.push(Math.log(v[i] / v[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1));
  return { today: v[v.length - 1], first: v[0], hi: Math.max(...v), lo: Math.min(...v), vol: isFinite(sd) && sd > 0 ? sd * Math.sqrt(365) : 0.6 };
}
// Same spot, weekly-sampled volatility and halved, clamped drift as marketStats in lib/valuation.mjs.
function market(g) {
  const v = (DATA[g] || []).map(p => p[1]);
  const logs = xs => xs.slice(1).map((x, i) => Math.log(x / xs[i]));
  const stdev = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)); };
  const daily = logs(v), weekly = [];
  for (let i = v.length - 1; i >= 0; i -= WEEK_POINTS) weekly.unshift(v[i]);
  const useWeekly = weekly.length >= MIN_WEEKLY_POINTS;
  const vol = useWeekly ? stdev(logs(weekly)) * Math.sqrt(52) : stdev(daily) * Math.sqrt(365);
  const rawDrift = daily.reduce((a, b) => a + b, 0) / daily.length * 365;
  return { spot: v[v.length - 1], vol, volSampling: useWeekly ? "weekly" : "daily", drift: Math.max(-DRIFT_CLAMP, Math.min(DRIFT_CLAMP, rawDrift)) / 2, asOf: DATA[g][DATA[g].length - 1][0] };
}
function forwardFor(g, w) {
  const m = market(g), now = Date.now(), tMid = ((w.start - now) + (w.end - now)) / 2 / YEAR;
  return m.spot * Math.exp(m.drift * tMid);
}
const chipStrike = (forward, factor) => round2(Math.round(forward / 0.05) * 0.05 * factor);
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
  if (n === RFQ) return "Larger blocks are quoted by request.";
  if (n < 8) return `${n} GPU${n > 1 ? "s" : ""} · single`;
  const nodes = n / 8;
  return `${n} GPUs · ${nodes} node${nodes > 1 ? "s" : ""}`;
}
const readQty = () => $("co-qty").value === RFQ ? RFQ : +$("co-qty").value;
const regionKey = label => label.replace(/\s*\(.*\)$/, "");

function setupControls() {
  const qty = $("co-qty");
  QTY.forEach(n => qty.add(new Option(n < 8 ? `${n} GPU${n > 1 ? "s" : ""}` : `${n / 8} node${n > 8 ? "s" : ""} (${n} GPUs)`, n)));
  qty.add(new Option("More than 256 GPUs", RFQ));
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

// The cap price: a chip (forward rounded to $0.05, times 1, 1.1 or 1.2) or the typed value.
function currentStrike(g, w) {
  if (state.strikeFactor != null) return w.ok ? chipStrike(forwardFor(g, w), state.strikeFactor) : null;
  return state.strikeCustom;
}

// Local inputs for one quote; the key identifies the matching /api/quote answer.
function quote() {
  const g = state.gpu, kind = state.kind, n = readQty(), w = readWindow();
  const q = { g, kind, n, w, region: $("co-region").value, rfq: n === RFQ, ok: w.ok && n !== RFQ };
  if (kind === "cap") {
    q.strike = currentStrike(g, w);
    q.strikeBad = state.strikeFactor == null && !(q.strike > 0 && q.strike <= MAX_STRIKE);
    if (q.strikeBad) q.ok = false;
  }
  if (!q.ok) return q;
  q.gpuHours = n * w.hours;
  q.claim = w.start - CLAIM_BEFORE;
  q.params = { gpu: g, count: String(n), start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(), type: kind === "cap" ? "call" : "lock", region: regionKey(q.region), config: CONFIG };
  if (kind === "cap") q.params.strike = q.strike.toFixed(2);
  q.key = new URLSearchParams(q.params).toString() + "#" + dataVersion;
  return q;
}

// The original local formula, kept as the offline fallback and labelled indicative.
function offlineQuote(q) {
  const s = stats(q.g), m = market(q.g), cap = q.kind === "cap";
  const years = Math.max(1 / 52, (q.w.end - Date.now()) / YEAR);
  const per = round2(s.today * s.vol * Math.sqrt(years) * FEE_FACTOR * (cap ? CAP_FEE_FACTOR : 1));
  const strike = cap ? q.strike : s.today;
  const premiumTotal = round2(per * q.gpuHours);
  return {
    gpuHours: q.gpuHours, type: cap ? "call" : "lock", strike, premiumPerGpuHour: per, premiumTotal,
    platformFee: round2(premiumTotal * PLATFORM_FEE_SHARE), payNow: premiumTotal,
    costIfUsed: round2(strike * q.gpuHours), breakEven: cap ? round2(strike + per) : null,
    forward: forwardFor(q.g, q.w), spot: s.today, vol: s.vol, volSampling: "daily", tYears: years, tEffYears: years,
    method: "indicative (offline)", asOf: m.asOf,
  };
}

function scheduleQuote(q) {
  if (q.key === requestedKey) return;
  requestedKey = q.key;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => fetchQuote(q), QUOTE_DEBOUNCE);
}
async function fetchQuote(q) {
  clearTimeout(quoteTimer);
  requestedKey = q.key;
  const seq = ++quoteSeq;
  let result = null;
  if (window.fetch && window.AbortController) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT);
    try {
      const res = await fetch("/api/quote?" + new URLSearchParams(q.params), { signal: ctrl.signal, headers: { Accept: "application/json" } });
      const body = res.ok ? await res.json() : null;
      if (body && Number.isFinite(body.payNow) && Number.isFinite(body.costIfUsed) && Number.isFinite(body.strike)) result = { key: q.key, data: body, offline: false };
    } catch {
      // No endpoint, offline, or slow: use the indicative local formula.
    } finally { clearTimeout(timer); }
  }
  if (!result) result = { key: q.key, data: offlineQuote(q), offline: true };
  if (seq !== quoteSeq) return result;
  live = result;
  requestedKey = null;
  renderQuote();
  return result;
}
const liveFor = q => (q.ok && live && live.key === q.key ? live : null);

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
  const strike = state.kind === "cap" ? currentStrike(g, readWindow()) : null;
  const cap = strike > 0 && strike <= MAX_STRIKE ? strike : null;
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
  $("co-price-tag").hidden = !priceSource;
  $("co-price-tag").textContent = priceSource ? (priceSource.live ? "live" : "cached") : "";
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
  $("co-win-utc").textContent = has ? "UTC " + fmtUtcRange(w.start, w.end) + (w.shifted ? " · moved to the next real hour for the clock change" : "") : "";
  const err = $("co-error");
  err.hidden = w.ok; err.textContent = w.ok ? "" : w.msg;
  markInvalid(["co-start-d", "co-start-h"], !w.ok && w.field === "start");
  markInvalid(["co-end-d", "co-end-h"], !w.ok && w.field === "end");
}

// Strike chips show their price for the current window; the number box mirrors the chosen strike.
function renderStrike(q) {
  const cap = q.kind === "cap";
  $("co-strike").hidden = !cap;
  if (!cap) return;
  const forward = q.w.ok ? forwardFor(q.g, q.w) : null;
  document.querySelectorAll("#paper-order [data-strike]").forEach(b => {
    const factor = +b.dataset.strike;
    b.setAttribute("aria-pressed", String(state.strikeFactor === factor));
    b.querySelector("small").textContent = forward ? usd2(chipStrike(forward, factor)) : "";
  });
  const input = $("co-strike-in");
  if (state.strikeFactor != null && document.activeElement !== input) input.value = q.strike ? q.strike.toFixed(2) : "";
  const err = $("co-strike-err");
  err.hidden = !q.strikeBad;
  err.textContent = q.strikeBad ? "Enter a cap price above $0 per GPU-hour." : "";
  markInvalid(["co-strike-in"], q.strikeBad);
}

const setText = (id, text) => { $(id).textContent = text; };
function renderHow(q, result) {
  const d = result && result.data;
  if (!d) { ["co-h-fwd", "co-h-vol", "co-h-win", "co-h-method", "co-h-asof"].forEach(id => setText(id, "—")); return; }
  const startsIn = (q.w.start - Date.now()) / DAY;
  setText("co-h-fwd", perHour(round2(d.forward)) + ` (index today ${usd2(d.spot)})`);
  setText("co-h-vol", `${(d.vol * 100).toFixed(0)}% a year, ${d.volSampling}-sampled and annualised, from the Ornn ${q.g} series`);
  setText("co-h-win", `${q.w.hours.toLocaleString("en-US")} h, starting in ${startsIn.toFixed(1)} days · averaging time ${(d.tEffYears * 365).toFixed(1)} days`);
  setText("co-h-method", result.offline ? "Indicative (offline) · simple volatility formula" : (d.type === "lock" ? "Forward plus a 2% provider margin" : "Black-76 on the forward, average-price adjusted") + ` · ${d.method}`);
  setText("co-h-asof", fmtDay(d.asOf) + (Number.isFinite(d.computeMs) ? ` · priced in ${d.computeMs < 10 ? d.computeMs.toFixed(1) : Math.round(d.computeMs)} ms` : ""));
}

function renderQuote() {
  const q = quote(), cap = q.kind === "cap", dash = "—";
  $("co-qty-read").textContent = qtyLabel(q.n);
  $("co-rfq").hidden = !q.rfq;
  renderWindow(q.w);
  renderStrike(q);
  $("co-quote-title").textContent = `${q.g} · ${cap ? "Price cap" : "Lock"}`;
  $("co-q-price-l").textContent = cap ? "Cap price" : "Fixed price";
  $("co-q-compute-l").textContent = cap ? "Most you’ll pay if you use it" : "You’ll pay if you use it";
  $("co-q-total-l").textContent = cap ? "All-in, at most" : "All-in, if used";
  $("co-q-be-row").hidden = !cap;
  $("co-q-hours").textContent = q.ok ? q.gpuHours.toLocaleString("en-US") : dash;
  if (q.ok && !liveFor(q)) scheduleQuote(q);
  const result = liveFor(q), d = result && result.data, wait = q.ok ? "…" : dash;
  $("co-q-price").textContent = d ? perHour(d.strike) : cap && q.strike > 0 ? perHour(q.strike) : wait;
  $("co-q-per").textContent = d ? (d.premiumPerGpuHour > 0 ? perHour(d.premiumPerGpuHour) : "included in the fixed price") : "";
  $("co-q-fee").textContent = d ? usd2(d.premiumTotal) : wait;
  $("co-q-platform").textContent = d ? usd2(d.platformFee) : wait;
  $("co-q-upfront").textContent = d ? usd2(d.payNow) : wait;
  $("co-q-compute").textContent = d ? usd2(d.costIfUsed) : wait;
  $("co-q-be").textContent = d && d.breakEven != null ? perHour(d.breakEven) : wait;
  $("co-q-total").textContent = d ? usd2(round2(d.payNow + d.costIfUsed)) : wait;
  $("co-q-source").textContent = d ? (result.offline ? "Indicative price. The pricing service did not answer." : "Priced by Dodona pricing v0 on the Ornn daily index." + (cap ? " Hours are billed at the lower of the window’s average index price and the cap." : "")) : q.ok ? "Pricing…" : "";
  $("co-q-source").classList.toggle("co-offline", Boolean(d && result.offline));
  $("co-fee-tag").hidden = !d || result.offline;
  renderHow(q, result);
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
function summaryRows({ q, result }) {
  const cap = q.kind === "cap", d = result.data;
  return [
    ["Compute", `${q.g} · ${qtyLabel(q.n)}`, q.region + " (preference)"],
    ["Window", `${fmtLong(q.w.start, q.w.tz)} → ${fmtLong(q.w.end, q.w.tz)}`, `${q.w.hours} h · ${q.gpuHours.toLocaleString("en-US")} GPU-hours`],
    ["UTC", fmtUtcRange(q.w.start, q.w.end)],
    ["Claim by", fmtLong(q.claim, q.w.tz), "Unclaimed hours expire, and any upfront fee is kept."],
    cap ? ["Protection", `Price cap at ${perHour(d.strike)}`, `Hours billed at the lower of the window’s average index price and the cap. Pays off above ${perHour(d.breakEven)}`]
      : ["Protection", `Fixed price ${perHour(d.strike)}`, "The forward price plus a 2% provider margin"],
    d.payNow > 0 ? ["Pay now", usd2(d.payNow), `The fee, of which Dodona keeps ${usd2(d.platformFee)}`, true] : ["Pay now", usd2(0), "Nothing to pay now. A fixed price has no fee.", true],
    [cap ? "Most you’ll pay if you use it" : "You’ll pay if you use it", usd2(d.costIfUsed)],
    [cap ? "All-in, at most" : "All-in, if used", usd2(round2(d.payNow + d.costIfUsed)), null, true],
    ["Pricing", result.offline ? "Indicative (offline)" : `${d.method} · index as of ${fmtDay(d.asOf)}`],
  ];
}
function demoRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", bytes = crypto.getRandomValues(new Uint8Array(6));
  return "DEMO-" + Array.from(bytes, b => chars[b % chars.length]).join("");
}

// Review always shows a priced quote: a pending or debounced request is settled first.
async function openReview() {
  const q = quote();
  if (!q.ok) return;
  const result = liveFor(q) || await fetchQuote(q);
  if (quote().key !== q.key) return;
  pending = { q, result };
  fillList($("co-review-list"), summaryRows(pending));
  $("co-consent").checked = false; $("co-confirm").disabled = true;
  $("co-review").hidden = false; $("co-receipt").hidden = true;
  const d = $("co-dialog");
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
}
function closeDialog() { const d = $("co-dialog"); if (d.close) d.close(); else d.removeAttribute("open"); }

// Demo bookings for the dashboard (sessionStorage only; nothing is sent to the server).
function saveBooking(ref, { q, result }) {
  const d = result.data;
  const booking = {
    ref, gpu: q.g, count: q.n, start: q.params.start, end: q.params.end, type: q.kind === "cap" ? "call" : "lock",
    strike: d.strike, premiumPerGpuHour: d.premiumPerGpuHour, premiumTotal: d.premiumTotal,
    region: q.params.region, config: CONFIG, createdAt: new Date().toISOString(),
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(BOOKINGS_KEY) || "[]");
    sessionStorage.setItem(BOOKINGS_KEY, JSON.stringify((Array.isArray(saved) ? saved : []).concat([booking])));
  } catch {
    // Storage blocked (private mode or a sandbox): the receipt still shows; the dashboard will not list it.
  }
}
// Fire-and-forget audit event; no personal data, and any failure or non-2xx answer is ignored.
const fmtShort = t => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function auditSummary({ q, result }) {
  const d = result.data, [sd, sm] = fmtShort(q.w.start).split(" "), end = fmtShort(q.w.end);
  const dates = end.endsWith(" " + sm) ? `${sd}–${end}` : `${sd} ${sm}–${end}`;
  const terms = `${q.kind === "cap" ? "call" : "fixed"} ${usd2(d.strike)} · fee ${usd2(d.premiumPerGpuHour)}/h`;
  return `Booking · ${q.g} × ${q.n} · ${dates} · ${terms}`;
}
function sendAudit(ref, booked) {
  try {
    if (!window.fetch) return;
    fetch(AUDIT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "booking_created", ref, summary: auditSummary(booked) }) }).catch(() => {});
  } catch {
    // Audit is best effort; the demo receipt never depends on it.
  }
}
function confirmBooking() {
  if (!pending || !$("co-consent").checked) return;
  if (pending.q.w.start < Date.now() + MIN_LEAD) { closeDialog(); renderQuote(); return; }
  const ref = demoRef();
  $("co-ref").textContent = ref;
  fillList($("co-receipt-list"), summaryRows(pending));
  saveBooking(ref, pending);
  sendAudit(ref, pending);
  $("co-review").hidden = true; $("co-receipt").hidden = false;
  $("co-r-title").focus();
}
function startAnother() {
  closeDialog(); pending = null;
  state.kind = "lock"; state.strikeFactor = 1; state.strikeCustom = null;
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
    dataVersion++;
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
$("co-tz").addEventListener("change", () => { updateLimits(); renderChart(); renderQuote(); });
["co-start-d", "co-start-h"].forEach(id => $(id).addEventListener("change", () => { applyPreset(); updateLimits(); renderChart(); renderQuote(); }));
["co-end-d", "co-end-h"].forEach(id => $(id).addEventListener("change", () => { state.preset = null; renderChart(); renderQuote(); }));
document.querySelectorAll("#paper-order [data-preset]").forEach(b => b.addEventListener("click", () => { state.preset = b.dataset.preset; applyPreset(); updateLimits(); renderChart(); renderQuote(); }));
document.querySelectorAll("#paper-order [data-kind]").forEach(b => b.addEventListener("click", () => {
  state.kind = b.dataset.kind;
  document.querySelectorAll("#paper-order [data-kind]").forEach(o => o.setAttribute("aria-pressed", String(o === b)));
  renderChart(); renderQuote();
}));
document.querySelectorAll("#paper-order [data-strike]").forEach(b => b.addEventListener("click", () => {
  state.strikeFactor = +b.dataset.strike; state.strikeCustom = null;
  renderChart(); renderQuote();
}));
$("co-strike-in").addEventListener("input", e => {
  const value = e.target.value === "" ? NaN : Number(e.target.value);
  state.strikeFactor = null; state.strikeCustom = Number.isFinite(value) ? round2(value) : null;
  renderChart(); renderQuote();
});
$("co-buy").addEventListener("click", openReview);
$("co-back").addEventListener("click", closeDialog);
$("co-consent").addEventListener("change", e => { $("co-confirm").disabled = !e.target.checked; });
$("co-confirm").addEventListener("click", confirmBooking);
$("co-again").addEventListener("click", startAnother);
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 120); });
})();
