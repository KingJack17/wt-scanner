/* Göstergeler ve kırılım mantığı (Python tarafıyla aynı formüller) */
(function (root) {
"use strict";
// ------------------------------------------------------------ göstergeler (Python ile aynı)
const N = NaN;
function ema(a, n) { const k = 2 / (n + 1), o = new Array(a.length); let p = N;
  for (let i = 0; i < a.length; i++) { const x = a[i]; if (isNaN(x)) { o[i] = p; continue; } p = isNaN(p) ? x : p + k * (x - p); o[i] = p; } return o; }
function sma(a, n) { const o = new Array(a.length).fill(N); let s = 0, c = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; c++; if (i >= n) s -= a[i - n], c--; if (c === n && !isNaN(s)) o[i] = s / n; } return o; }
function rma(a, n) { // pandas ewm(alpha=1/n, adjust=False, min_periods=n)
  const al = 1 / n, o = new Array(a.length).fill(N); let p = N, cnt = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]; if (isNaN(x)) continue; p = isNaN(p) ? x : p + al * (x - p); cnt++; if (cnt >= n) o[i] = p; } return o; }
function wavetrend(b, n1, n2, sig) {
  const ap = b.c.map((c, i) => (b.h[i] + b.l[i] + c) / 3);
  const esa = ema(ap, n1);
  const d = ema(ap.map((v, i) => Math.abs(v - esa[i])), n1);
  const ci = ap.map((v, i) => d[i] === 0 ? 0 : (v - esa[i]) / (0.015 * d[i]));
  const wt1 = ema(ci, n2);
  return { wt1, wt2: sma(wt1, sig) };
}
function rsi(c, n) {
  const g = [N], l = [N];
  for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  const ag = rma(g, n), alo = rma(l, n);
  return ag.map((x, i) => isNaN(x) ? N : alo[i] === 0 ? 100 : 100 - 100 / (1 + x / alo[i]));
}
function supertrend(b, n, mult) {
  const L = b.c.length, tr = new Array(L);
  for (let i = 0; i < L; i++) tr[i] = i === 0 ? b.h[i] - b.l[i] :
    Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
  const a = rma(tr, n), fu = new Array(L).fill(N), fd = new Array(L).fill(N), dir = new Array(L).fill(0), line = new Array(L).fill(N);
  for (let i = 0; i < L; i++) {
    if (isNaN(a[i])) continue;
    const hl2 = (b.h[i] + b.l[i]) / 2, up = hl2 - mult * a[i], dn = hl2 + mult * a[i];
    if (i === 0 || isNaN(fu[i - 1])) { fu[i] = up; fd[i] = dn; dir[i] = 1; }
    else {
      fu[i] = b.c[i - 1] > fu[i - 1] ? Math.max(up, fu[i - 1]) : up;
      fd[i] = b.c[i - 1] < fd[i - 1] ? Math.min(dn, fd[i - 1]) : dn;
      if (dir[i - 1] === -1 && b.c[i] > fd[i - 1]) dir[i] = 1;
      else if (dir[i - 1] === 1 && b.c[i] < fu[i - 1]) dir[i] = -1;
      else dir[i] = dir[i - 1];
    }
    line[i] = dir[i] === 1 ? fu[i] : fd[i];
  }
  return { line, dir };
}
function macd(c, f, s, g) { const ef = ema(c, f), es = ema(c, s), m = ef.map((v, i) => v - es[i]); return { m, sig: ema(m, g) }; }
// kesişim olay dizileri
const xUp = (a, b) => a.map((v, i) => i > 0 && v > b(i) && !(a[i - 1] > b(i - 1)) && !isNaN(a[i - 1]));
const xDn = (a, b) => a.map((v, i) => i > 0 && v < b(i) && !(a[i - 1] < b(i - 1)) && !isNaN(a[i - 1]));
const inWin = (ev, i, w) => { for (let j = Math.max(0, i - w + 1); j <= i; j++) if (ev[j]) return true; return false; };

/** Bir bar serisi için tüm gösterge ve olayları hesapla */
function analyze(b, cfg, wt) {
  const L = b.c.length, R = { L };
  const ev = { BULL: {}, BEAR: {} };
  if (cfg.st.on) {
    R.st = supertrend(b, +cfg.st.atr, +cfg.st.mult);
    const d = R.st.dir;
    ev.BULL.ST = d.map((v, i) => i > 0 && v === 1 && d[i - 1] === -1);
    ev.BEAR.ST = d.map((v, i) => i > 0 && v === -1 && d[i - 1] === 1);
  }
  if (cfg.ema.on) {
    R.ef = ema(b.c, +cfg.ema.fast); R.es = ema(b.c, +cfg.ema.slow);
    ev.BULL.EMA = xUp(R.ef, i => R.es[i]); ev.BEAR.EMA = xDn(R.ef, i => R.es[i]);
  }
  if (cfg.macd.on) {
    R.macd = macd(b.c, +cfg.macd.fast, +cfg.macd.slow, +cfg.macd.sig);
    ev.BULL.MACD = xUp(R.macd.m, i => R.macd.sig[i]); ev.BEAR.MACD = xDn(R.macd.m, i => R.macd.sig[i]);
  }
  {
    R.rsi = rsi(b.c, +cfg.rsi.len);
    const r = R.rsi;
    if (cfg.rsi.mode === "level") {
      R.rsiOkBull = r.map(v => v > 50); R.rsiOkBear = r.map(v => v < 50);
    } else {
      const u50 = xUp(r, () => 50), u30 = xUp(r, () => 30), d50 = xDn(r, () => 50), d70 = xDn(r, () => 70);
      R.rsiOkBull = r.map((_, i) => inWin(u50, i, +cfg.rsiLookback) || inWin(u30, i, +cfg.rsiLookback));
      R.rsiOkBear = r.map((_, i) => inWin(d50, i, +cfg.rsiLookback) || inWin(d70, i, +cfg.rsiLookback));
    }
  }
  if (wt) {
    R.wt = wavetrend(b, +wt.n1, +wt.n2, +wt.signal);
    const k = +wt.keep_after_exit;
    const nearOS = new Array(L).fill(false), nearOB = new Array(L).fill(false);
    let lastOS = -1e9, lastOB = -1e9;
    for (let i = 0; i < L; i++) {
      const w = R.wt.wt1[i];
      if (w <= wt.os_level1) lastOS = i;
      if (w >= wt.ob_level1) lastOB = i;
      nearOS[i] = i - lastOS <= k; nearOB[i] = i - lastOB <= k;
    }
    R.nearOS = nearOS; R.nearOB = nearOB;
  }
  R.ev = ev;
  /** i. barda dir yönünde sinyal var mı? → null | {strength, trig:[...]} */
  R.signalAt = (i, dir) => {
    const names = Object.keys(ev[dir]);
    if (!names.length) return null;
    const hit = names.filter(n => inWin(ev[dir][n], i, +cfg.lookback));
    const ok = cfg.combine === "all" ? hit.length === names.length : hit.length > 0;
    if (!ok) return null;
    const rOk = dir === "BULL" ? R.rsiOkBull[i] : R.rsiOkBear[i];
    if (cfg.rsi.role === "require" && !rOk) return null;
    const trig = hit.slice(); if (cfg.rsi.role !== "off" && rOk) trig.push("RSI");
    const strength = cfg.rsi.role === "off" ? "SIG" : rOk ? "STRONG" : "WEAK";
    return { strength, trig };
  };
  return R;
}

root.WTI = { ema, sma, rma, wavetrend, rsi, supertrend, macd, analyze };
})(typeof window !== "undefined" ? window : globalThis);
