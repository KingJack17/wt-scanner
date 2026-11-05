/* WT Tarayıcı – web uygulaması
 * Aşama 1 (WaveTrend listeleri) sunucuda (GitHub Actions) hesaplanır.
 * Aşama 2 (kırılım) burada, kullanıcının seçtiği göstergelerle hesaplanır.
 */
(() => {
"use strict";

// ------------------------------------------------------------ ayarlar
const DEFAULTS = {
  st:   { on: true,  atr: 10, mult: 3 },
  ema:  { on: true,  fast: 5, slow: 12 },
  macd: { on: false, fast: 12, slow: 26, sig: 9 },
  wtx:  { on: true,  lookback: 3 },
  combine: "any",              // any = herhangi biri, all = hepsi
  rsi: { role: "confirm", len: 14, mode: "cross" },   // confirm | require | off
  lookback: 2, rsiLookback: 3,
  obBull: false, osBear: false,
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const clone = o => JSON.parse(JSON.stringify(o));
function mergeDeep(base, over) {
  const out = clone(base);
  for (const k in over || {}) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) && out[k]) Object.assign(out[k], over[k]);
    else if (k in out) out[k] = over[k];
  }
  return out;
}
let CFG = mergeDeep(DEFAULTS, store.get("wt_cfg", {}));
const UI = Object.assign({ market: "us", tf: "daily", view: "signals", fSig: "all", fList: "all", deep: false, wtxOnly: false },
                         store.get("wt_ui", {}));

const { ema, analyze } = window.WTI;
const dirsFor = side => side === "oversold" ? (CFG.osBear ? ["BULL", "BEAR"] : ["BULL"])
                                            : (CFG.obBull ? ["BEAR", "BULL"] : ["BEAR"]);

// ------------------------------------------------------------ veri
const cache = {};
async function getJSON(path) {
  if (window.DEMO && window.DEMO[path]) return window.DEMO[path];
  if (cache[path]) return cache[path];
  const r = await fetch(path + "?v=" + (META && META.updated ? encodeURIComponent(META.updated) : Date.now()), { cache: "no-cache" });
  if (!r.ok) throw new Error(r.status + " " + path);
  return (cache[path] = await r.json());
}
let META = null, DS = null, SIGNALS = [];
const safe = s => s.replace(/[^A-Za-z0-9_-]/g, "_");

async function loadDataset() {
  const key = `data/${UI.market}_${UI.tf}.json`;
  $("#main").innerHTML = `<div class="empty">Yükleniyor…</div>`;
  try { DS = await getJSON(key); }
  catch (e) {
    DS = null;
    $("#main").innerHTML = `<div class="empty">Bu piyasa için henüz veri yok.<br><span class="note">İlk tarama tamamlanınca burada görünecek. GitHub → Actions sekmesinden durumu kontrol edebilirsin.</span></div>`;
    updateCounts(); updateHeader(); return;
  }
  computeSignals(); render();
}

function computeSignals() {
  SIGNALS = [];
  if (!DS) return;
  for (const side of ["oversold", "overbought"]) {
    for (const row of DS.lists[side]) {
      const b = DS.bars[row.s]; if (!b || b.c.length < 30) continue;
      const R = analyze(b, CFG, DS.wt);
      row._wtx = R.wtxAgo(side === "oversold" ? "BULL" : "BEAR");
      for (const dir of dirsFor(side)) {
        const sg = R.signalAt(R.L - 1, dir);
        if (sg) SIGNALS.push({ row, side, dir, ...sg, rsi: R.rsi[R.L - 1] });
      }
    }
  }
  const rank = { STRONG: 0, SIG: 0, WEAK: 1 };
  SIGNALS.sort((a, b) => rank[a.strength] - rank[b.strength] || b.trig.length - a.trig.length ||
    Math.abs(b.row.pk) - Math.abs(a.row.pk));
}

// ------------------------------------------------------------ görünüm
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtPx = v => v == null ? "–" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) :
  v >= 1 ? v.toFixed(2) : v.toPrecision(3);
const exOf = tv => (tv || "").split(":")[0];
const symOf = s => s.replace("/", "·");
let shown = 150;

function updateHeader() {
  const m = META && META.markets && META.markets[UI.market] && META.markets[UI.market][UI.tf];
  const when = m ? new Date(m.generated) : null;
  $("#upd").textContent = window.DEMO ? "Demo verisi · gerçek tarama değil" :
    m ? `Son bar ${m.bar_date || "–"} · tarandı ${when.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · ${m.universe_size} sembol`
      : "Henüz tarama yok";
}
function updateCounts() {
  $("#nSig").textContent = DS ? SIGNALS.length : "";
  $("#nOs").textContent = DS ? DS.lists.oversold.length : "";
  $("#nOb").textContent = DS ? DS.lists.overbought.length : "";
}
function setSeg(id, val) { document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle("on", b.dataset.v === val)); }

function renderChips() {
  const c = $("#chips");
  if (UI.view === "signals") {
    const opts = [["all", "Hepsi"], ["strong", "Güçlü"], ["weak", "Zayıf"], ["bull", "▲ Yükseliş"], ["bear", "▼ Düşüş"]];
    c.innerHTML = opts.map(([v, t]) => `<button class="chip ${UI.fSig === v ? "on" : ""}" data-f="fSig" data-v="${v}">${t}</button>`).join("");
  } else {
    const wtp = (DS && DS.wt) || {};
    const deepName = UI.view === "oversold" ? `Sadece OS2 (${wtp.os_level2 ?? -53} altı)` : `Sadece OB2 (${wtp.ob_level2 ?? 53} üstü)`;
    const opts = [["all", "Hepsi"], ["active", "Bölgede"], ["exited", "Çıkmış"]];
    c.innerHTML = opts.map(([v, t]) => `<button class="chip ${UI.fList === v ? "on" : ""}" data-f="fList" data-v="${v}">${t}</button>`).join("") +
      `<button class="chip ${UI.wtxOnly ? "on" : ""}" data-f="wtxOnly" data-v="1">WT kesişimi · son ${CFG.wtx.lookback} bar</button>` +
      `<button class="chip ${UI.deep ? "on" : ""}" data-f="deep" data-v="1">${deepName}</button>`;
  }
}

function currentItems() {
  const q = $("#search").value.trim().toUpperCase();
  const match = s => !q || s.toUpperCase().includes(q);
  if (!DS) return [];
  if (UI.view === "signals") {
    return SIGNALS.filter(x => match(x.row.s) &&
      (UI.fSig === "all" || (UI.fSig === "strong" && x.strength !== "WEAK") || (UI.fSig === "weak" && x.strength === "WEAK") ||
       (UI.fSig === "bull" && x.dir === "BULL") || (UI.fSig === "bear" && x.dir === "BEAR")));
  }
  const deepLvl = UI.view === "oversold" ? "OS2" : "OB2";
  return DS.lists[UI.view].filter(r => match(r.s) && (UI.fList === "all" || r.st === UI.fList) && (!UI.deep || r.zl === deepLvl) &&
      (!UI.wtxOnly || (r._wtx != null && r._wtx < +CFG.wtx.lookback)))
    .slice().sort((a, b) => (a.st === b.st ? 0 : a.st === "active" ? -1 : 1) || Math.abs(b.w1) - Math.abs(a.w1))
    .map(r => ({ row: r, side: UI.view }));
}

function zoneText(r) {
  return r.st === "active" ? `bölgede · ${r.biz} bar` : `çıktı · ${r.bse} bar önce`;
}
function cardHTML(x, idx) {
  const r = x.row;
  const dirCls = x.dir ? (x.dir === "BULL" ? "bull" : "bear") : (x.side === "oversold" ? "bull" : "bear");
  let tags = "";
  if (x.dir) {
    tags += `<span class="tag ${dirCls}">${x.dir === "BULL" ? "▲ YÜKSELİŞ" : "▼ DÜŞÜŞ"}</span>`;
    if (x.strength === "STRONG") tags += `<span class="tag strong">GÜÇLÜ</span>`;
    else if (x.strength === "WEAK") tags += `<span class="tag weak">ZAYIF</span>`;
    tags += x.trig.map(t => `<span class="tag trig">${t}</span>`).join("");
  }
  tags += `<span class="tag ${/2$/.test(r.zl) ? "deep" : ""}">${r.zl}</span>`;
  if (r._wtx != null && r._wtx <= 10 && !(x.trig && x.trig.includes("WTX")))
    tags += `<span class="tag ${r._wtx < +CFG.wtx.lookback ? "wtx" : ""}">WT✕ ${r._wtx === 0 ? "son bar" : r._wtx + " bar önce"}</span>`;
  if (x.dir) tags += `<span class="tag">${x.side === "oversold" ? "OS listesi" : "OB listesi"}</span>`;
  const rsiPart = x.rsi != null ? `<span>RSI <b>${x.rsi.toFixed(0)}</b></span>` : "";
  return `<button class="card ${dirCls}" data-i="${idx}">
    <div class="l1"><div class="sym">${esc(symOf(r.s))}<span class="ex">${esc(exOf(r.tv))}</span></div><div class="px">${fmtPx(r.c)}</div></div>
    <div class="l2">${tags}</div>
    <div class="l3"><span>WT1 <b>${r.w1.toFixed(1)}</b></span><span>en uç <b>${r.pk.toFixed(1)}</b></span>${rsiPart}<span>${zoneText(r)}</span></div>
  </button>`;
}

let ITEMS = [];
function render() {
  setSeg("segMarket", UI.market); setSeg("segTf", UI.tf); setSeg("segView", UI.view);
  renderChips(); updateCounts(); updateHeader();
  if (!DS) return;
  ITEMS = currentItems();
  let html = "";
  if (UI.view === "signals") {
    const sb = SIGNALS.filter(s => s.dir === "BULL" && s.strength !== "WEAK").length;
    const sr = SIGNALS.filter(s => s.dir === "BEAR" && s.strength !== "WEAK").length;
    const wk = SIGNALS.filter(s => s.strength === "WEAK").length;
    html += `<div class="summary">
      <div class="tile"><div class="k">Güçlü yükseliş</div><div class="v bull">${sb}</div></div>
      <div class="tile"><div class="k">Güçlü düşüş</div><div class="v bear">${sr}</div></div>
      <div class="tile"><div class="k">Zayıf</div><div class="v">${wk}</div></div></div>`;
    html += `<div class="note">${describeRule()}</div>`;
  }
  if (!ITEMS.length) html += `<div class="empty">${UI.view === "signals" ? "Bu ayarlarla listedeki sembollerde kırılım yok." : "Listede sembol yok."}</div>`;
  html += ITEMS.slice(0, shown).map(cardHTML).join("");
  if (ITEMS.length > shown) html += `<button class="more" id="btnMore">${ITEMS.length - shown} sembol daha göster</button>`;
  $("#main").innerHTML = html;
}
function describeRule() {
  const t = [];
  if (CFG.st.on) t.push(`Supertrend(${CFG.st.atr}, ${CFG.st.mult})`);
  if (CFG.ema.on) t.push(`EMA ${CFG.ema.fast}/${CFG.ema.slow}`);
  if (CFG.macd.on) t.push(`MACD ${CFG.macd.fast}/${CFG.macd.slow}/${CFG.macd.sig}`);
  if (CFG.wtx.on) t.push(`WT kesişimi (son ${CFG.wtx.lookback} bar)`);
  if (!t.length) return "Hiç tetikleyici seçili değil. Ayarlardan en az birini aç.";
  const join = CFG.combine === "all" ? " ve " : " veya ";
  const r = CFG.rsi.role === "off" ? "RSI kullanılmıyor" :
    `RSI(${CFG.rsi.len}) ${CFG.rsi.mode === "cross" ? "kesişimi" : "50 seviyesi"} ${CFG.rsi.role === "require" ? "zorunlu" : "güçlü/zayıf ayrımı için"}`;
  return `Kural: ${t.join(join)} tetiklendi (göstergeler için son ${CFG.lookback} bar) · ${r}.`;
}

// ------------------------------------------------------------ grafik
let chart = null;
async function openChart(x) {
  const r = x.row;
  $("#chartView").classList.remove("hidden");
  $("#cSym").textContent = symOf(r.s);
  $("#cSub").textContent = `${UI.tf === "daily" ? "Günlük" : "Haftalık"} · ${r.zl} · ${zoneText(r)} · WT1 ${r.w1.toFixed(1)}`;
  $("#cTv").href = "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(r.tv);
  const box = $("#chartBox"); box.innerHTML = "";
  let b;
  try { b = await getJSON(`data/bars/${UI.market}_${UI.tf}/${safe(r.s)}.json`); }
  catch { b = DS.bars[r.s]; }
  drawChart(box, b, r);
}
function drawChart(box, b, row) {
  if (chart) { chart.remove(); chart = null; }
  const css = getComputedStyle(document.documentElement);
  const C = k => css.getPropertyValue(k).trim();
  const wt = (DS && DS.wt) || (META && META.wt);
  const R = analyze(b, CFG, wt);
  const T = b.t.map(d => d * 86400);
  const LW = window.LightweightCharts;
  chart = LW.createChart(box, {
    autoSize: true,
    layout: { background: { color: C("--bg") }, textColor: C("--muted"), fontFamily: C("--font-num"), fontSize: 11,
              panes: { separatorColor: C("--line"), separatorHoverColor: C("--raise") } },
    grid: { vertLines: { color: "rgba(38,48,60,.45)" }, horzLines: { color: "rgba(38,48,60,.45)" } },
    rightPriceScale: { borderColor: C("--line") },
    timeScale: { borderColor: C("--line"), rightOffset: 4, barSpacing: 6 },
    crosshair: { mode: 0 },
    localization: { locale: "tr-TR" },
  });
  const bull = C("--bull"), bear = C("--bear"), acc = C("--accent");
  const candle = chart.addSeries(LW.CandlestickSeries, {
    upColor: bull, downColor: bear, borderUpColor: bull, borderDownColor: bear, wickUpColor: bull, wickDownColor: bear,
    priceLineVisible: false,
  });
  candle.setData(T.map((t, i) => ({ time: t, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] })));
  const line = (data, color, w = 1.5, pane = 0, extra = {}) => {
    const s = chart.addSeries(LW.LineSeries, { color, lineWidth: w, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, ...extra }, pane);
    s.setData(data); return s;
  };
  const pts = (arr, ok = () => true) => T.map((t, i) => (!isNaN(arr[i]) && ok(i)) ? { time: t, value: arr[i] } : { time: t });
  if (R.st) {
    // tek çizgi, nokta bazlı renk; yön değişen barda şeffaf → TradingView'daki gibi kopukluk
    const d = R.st.dir;
    line(T.map((t, i) => isNaN(R.st.line[i]) ? { time: t } : { time: t, value: R.st.line[i],
      color: i < d.length - 1 && d[i + 1] !== d[i] && d[i] !== 0 ? "rgba(0,0,0,0)" : d[i] === 1 ? bull : bear }), bull, 1.5);
  }
  if (R.ef) { line(pts(R.ef), acc, 1.2); line(pts(R.es), "#6aa6f8", 1.2); }

  // sinyal işaretleri: sinyalin başladığı (veya zayıftan güçlüye döndüğü) bar
  const markers = [];
  for (const dir of ["BULL", "BEAR"]) {
    const allowed = dir === "BULL" ? (i => R.nearOS[i] || (CFG.obBull && R.nearOB[i]))
                                   : (i => R.nearOB[i] || (CFG.osBear && R.nearOS[i]));
    let prev = null;
    for (let i = 30; i < R.L; i++) {
      const sg = allowed(i) ? R.signalAt(i, dir) : null;
      const lvl = sg ? (sg.strength === "WEAK" ? 1 : 2) : 0;
      const pl = prev ? (prev.strength === "WEAK" ? 1 : 2) : 0;
      if (lvl > pl) {
        const strong = lvl === 2;
        markers.push({ time: T[i], position: dir === "BULL" ? "belowBar" : "aboveBar",
          color: strong ? (dir === "BULL" ? bull : bear) : "#9aa5b4",
          shape: strong ? (dir === "BULL" ? "arrowUp" : "arrowDown") : "circle",
          size: strong ? 1.3 : 0.8 });
      }
      prev = sg;
    }
  }
  markers.sort((a, b) => a.time - b.time);
  LW.createSeriesMarkers(candle, markers);

  // WT paneli
  let pane = 1;
  const w1 = line(pts(R.wt.wt1), bull, 1.6, pane, { lastValueVisible: true });   // TradingView WT Alpha: WT1 yeşil, WT2 kırmızı
  line(pts(R.wt.wt2), "rgba(236,91,86,.85)", 1.2, pane);
  for (const [v, c] of [[wt.ob_level2, bear], [wt.ob_level1, "rgba(236,91,86,.5)"], [0, C("--line")],
                        [wt.os_level1, "rgba(38,176,122,.5)"], [wt.os_level2, bull]])
    w1.createPriceLine({ price: +v, color: c, lineWidth: 1, lineStyle: 2, axisLabelVisible: v !== 0, title: "" });
  const zoneDots = [];
  for (let i = 1; i < R.L; i++) {
    if (R.wtxUp[i]) zoneDots.push({ time: T[i], position: "inBar", color: "#f5d90a", shape: "circle", size: 1.4 });
    else if (R.wtxDn[i]) zoneDots.push({ time: T[i], position: "inBar", color: "#f5d90a", shape: "circle", size: 1.4 });
    else if (R.wtxAll[i]) zoneDots.push({ time: T[i], position: "inBar", color: R.wt.wt1[i] > R.wt.wt2[i] ? bull : bear, shape: "circle", size: 0.5 });
  }
  LW.createSeriesMarkers(w1, zoneDots);
  const panes = [[pane, 120]];
  if (CFG.rsi.role !== "off") {
    pane++;
    const rs = line(pts(R.rsi), "#c79bf2", 1.4, pane, { lastValueVisible: true });
    for (const v of [70, 50, 30]) rs.createPriceLine({ price: v, color: v === 50 ? C("--muted") : C("--line"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    panes.push([pane, 80]);
  }
  if (R.macd) {
    pane++;
    const h = chart.addSeries(LW.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
    h.setData(T.map((t, i) => { const v = R.macd.m[i] - R.macd.sig[i]; return isNaN(v) ? { time: t } : { time: t, value: v, color: v >= 0 ? "rgba(38,176,122,.6)" : "rgba(236,91,86,.6)" }; }));
    line(pts(R.macd.m), "#6aa6f8", 1.2, pane); line(pts(R.macd.sig), acc, 1.2, pane);
    panes.push([pane, 80]);
  }
  requestAnimationFrame(() => { const ps = chart.panes(); for (const [i, hgt] of panes) if (ps[i]) ps[i].setHeight(hgt); });
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, R.L - (innerWidth < 500 ? 90 : 160)), to: R.L + 3 });

  // açıklama
  const lg = [];
  lg.push(`<span><i class="tri-up"></i> güçlü yükseliş</span>`, `<span><i class="tri-dn"></i> güçlü düşüş</span>`,
          `<span><i class="dot" style="background:#9aa5b4"></i> zayıf (RSI teyidi yok)</span>`);
  lg.push(`<span><i class="dot" style="background:#f5d90a"></i> WT bölge içi kesişim</span>`);
  if (R.st) lg.push(`<span><i class="sw" style="background:${bull}"></i><i class="sw" style="background:${bear}"></i> Supertrend</span>`);
  if (R.ef) lg.push(`<span><i class="sw" style="background:${acc}"></i> EMA${CFG.ema.fast}</span><span><i class="sw" style="background:#6aa6f8"></i> EMA${CFG.ema.slow}</span>`);
  $("#chartInfo").innerHTML = `<div class="legend">${lg.join("")}</div>
    <div>Paneller: WT alpha (${wt.n1}/${wt.n2}, bantlar ${wt.os_level2}/${wt.os_level1} · ${wt.ob_level1}/${wt.ob_level2})${CFG.rsi.role !== "off" ? " · RSI" : ""}${R.macd ? " · MACD" : ""}. İşaretler yalnızca WT bölgesindeyken ya da çıktıktan sonraki ${wt.keep_after_exit} bar içinde gösterilir.</div>`;
}

// ------------------------------------------------------------ ayarlar
const GH = Object.assign({ owner: "", repo: "", token: "" }, store.get("wt_gh", {}));
(function guessRepo() {
  if (!GH.owner && /\.github\.io$/.test(location.hostname)) {
    GH.owner = location.hostname.split(".")[0];
    GH.repo = location.pathname.split("/").filter(Boolean)[0] || `${GH.owner}.github.io`;
  }
})();
function numIn(id, label, val, step = 1) {
  return `<label>${label}<input id="${id}" type="number" inputmode="decimal" step="${step}" value="${val}"></label>`;
}
function toggle(id, on) { return `<span class="sw-toggle"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><span></span></span>`; }
function sel(id, label, val, opts) {
  return `<label>${label}<select id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${v === val ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
}
function renderSettings() {
  const wt = (META && META.wt) || {};
  $("#form").innerHTML = `
  <section class="sec"><h2>Kırılım tetikleyicileri</h2>
    <div class="opt"><div class="hd"><label for="st_on">Supertrend<small>Yön değişimi</small></label>${toggle("st_on", CFG.st.on)}</div>
      <div class="params">${numIn("st_atr", "ATR periyodu", CFG.st.atr)}${numIn("st_mult", "Çarpan", CFG.st.mult, 0.1)}</div></div>
    <div class="opt"><div class="hd"><label for="ema_on">EMA kesişimi<small>Hızlı EMA yavaşı keser</small></label>${toggle("ema_on", CFG.ema.on)}</div>
      <div class="params">${numIn("ema_fast", "Hızlı", CFG.ema.fast)}${numIn("ema_slow", "Yavaş", CFG.ema.slow)}</div></div>
    <div class="opt"><div class="hd"><label for="macd_on">MACD kesişimi<small>MACD sinyal çizgisini keser</small></label>${toggle("macd_on", CFG.macd.on)}</div>
      <div class="params">${numIn("macd_fast", "Hızlı", CFG.macd.fast)}${numIn("macd_slow", "Yavaş", CFG.macd.slow)}${numIn("macd_sig", "Sinyal", CFG.macd.sig)}</div></div>
    <div class="opt"><div class="hd"><label for="wtx_on">WT alpha kesişimi<small>Oversold'da WT1 WT2'yi yukarı, overbought'ta aşağı keser</small></label>${toggle("wtx_on", CFG.wtx.on)}</div>
      <div class="params">${numIn("wtx_lb", "Son kaç bar", CFG.wtx.lookback)}</div></div>
    <div class="opt"><div class="params">
      ${sel("combine", "Birden fazla açıksa", CFG.combine, [["any", "Herhangi"], ["all", "Hepsi"]])}
      ${numIn("lookback", "Son kaç bar (ST/EMA/MACD)", CFG.lookback)}</div></div>
  </section>
  <section class="sec"><h2>RSI teyidi</h2>
    <div class="status">Ayırıcı: RSI teyidi olan sinyal GÜÇLÜ, olmayan ZAYIF sayılır. Zorunlu: teyitsiz sinyaller gizlenir. Kesişim: yükselişte RSI 30 veya 50'yi yukarı keser, düşüşte 70 veya 50'yi aşağı keser. Seviye: RSI 50'nin üstünde (yükseliş) veya altında (düşüş).</div>
    <div class="params">
      ${sel("rsi_role", "Rol", CFG.rsi.role, [["confirm", "Ayırıcı"], ["require", "Zorunlu"], ["off", "Kapalı"]])}
      ${sel("rsi_mode", "Koşul", CFG.rsi.mode, [["cross", "Kesişim"], ["level", "Seviye"]])}
      ${numIn("rsi_len", "Periyot", CFG.rsi.len)}${numIn("rsi_lb", "Son kaç bar", CFG.rsiLookback)}</div>
  </section>
  <section class="sec"><h2>Yön</h2>
    <div class="opt"><div class="hd"><label for="obBull">Overbought'ta yükseliş devamı<small>OB listesinde yükseliş kırılımlarını da göster</small></label>${toggle("obBull", CFG.obBull)}</div></div>
    <div class="opt"><div class="hd"><label for="osBear">Oversold'da düşüş devamı<small>OS listesinde düşüş kırılımlarını da göster</small></label>${toggle("osBear", CFG.osBear)}</div></div>
    <button class="btn" id="btnReset">Kırılım ayarlarını varsayılana döndür</button>
  </section>
  <section class="sec"><h2><span class="main">WT alpha</span> · ana gösterge</h2>
    <div class="status">Bu ayarlar listeleri belirler. Değişiklik GitHub'daki tarayıcıya kaydedilir ve tüm piyasalar yeniden taranır (10–20 dk).</div>
    <div class="params">
      ${numIn("wt_n1", "Channel (n1)", wt.n1 ?? 10)}${numIn("wt_n2", "Average (n2)", wt.n2 ?? 21)}${numIn("wt_sig", "Sinyal SMA", wt.signal ?? 4)}
      ${numIn("wt_os1", "OS1 bandı", wt.os_level1 ?? -45)}${numIn("wt_os2", "OS2 bandı", wt.os_level2 ?? -55)}
      ${numIn("wt_ob1", "OB1 bandı", wt.ob_level1 ?? 45)}${numIn("wt_ob2", "OB2 bandı", wt.ob_level2 ?? 55)}
      ${numIn("wt_keep", "Çıkıştan sonra tut (bar)", wt.keep_after_exit ?? 10)}</div>
    <label class="wide">GitHub kullanıcı adı<input id="gh_owner" value="${esc(GH.owner)}" autocapitalize="none" autocomplete="off"></label>
    <label class="wide">Repo adı<input id="gh_repo" value="${esc(GH.repo)}" autocapitalize="none" autocomplete="off"></label>
    <label class="wide">GitHub token (sadece bu cihazda saklanır)<input id="gh_token" type="password" value="${esc(GH.token)}" autocomplete="off" placeholder="github_pat_…"></label>
    <button class="btn primary" id="btnWt" ${window.DEMO ? "disabled" : ""}>Kaydet ve yeniden tara</button>
    <button class="btn" id="btnRun" ${window.DEMO ? "disabled" : ""}>Sadece yeniden tara</button>
    <div class="status" id="ghStatus">${window.DEMO ? "Demo modunda GitHub bağlantısı kapalı." : ""}</div>
  </section>`;
  if (!window.DEMO && GH.token) ghLastRun();
}
function readSettings() {
  const v = id => document.getElementById(id);
  const n = (id, d, min = 1) => { const x = parseFloat(v(id).value); return isFinite(x) && x >= min ? x : d; };
  CFG = {
    st: { on: v("st_on").checked, atr: n("st_atr", 10), mult: n("st_mult", 3, 0.1) },
    ema: { on: v("ema_on").checked, fast: n("ema_fast", 5), slow: n("ema_slow", 12) },
    macd: { on: v("macd_on").checked, fast: n("macd_fast", 12), slow: n("macd_slow", 26), sig: n("macd_sig", 9) },
    wtx: { on: v("wtx_on").checked, lookback: n("wtx_lb", 3) },
    combine: v("combine").value,
    rsi: { role: v("rsi_role").value, mode: v("rsi_mode").value, len: n("rsi_len", 14, 2) },
    lookback: n("lookback", 2), rsiLookback: n("rsi_lb", 3),
    obBull: v("obBull").checked, osBear: v("osBear").checked,
  };
  store.set("wt_cfg", CFG);
  GH.owner = v("gh_owner").value.trim(); GH.repo = v("gh_repo").value.trim(); GH.token = v("gh_token").value.trim();
  store.set("wt_gh", GH);
}

// GitHub API
async function gh(path, opt = {}) {
  const r = await fetch("https://api.github.com" + path, { ...opt, headers: {
    Authorization: "Bearer " + GH.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
    ...(opt.body ? { "Content-Type": "application/json" } : {}) } });
  if (!r.ok && r.status !== 204) {
    let m = ""; try { m = (await r.json()).message; } catch {}
    throw new Error(`${r.status} ${m}`);
  }
  return r.status === 204 ? null : r.json();
}
function ghStatus(t, cls = "") { const e = $("#ghStatus"); if (e) { e.textContent = t; e.className = "status " + cls; } }
async function ghDispatch() {
  const repo = await gh(`/repos/${GH.owner}/${GH.repo}`);
  await gh(`/repos/${GH.owner}/${GH.repo}/actions/workflows/scan.yml/dispatches`,
    { method: "POST", body: JSON.stringify({ ref: repo.default_branch, inputs: { market: "all" } }) });
}
async function ghLastRun() {
  try {
    const r = await gh(`/repos/${GH.owner}/${GH.repo}/actions/workflows/scan.yml/runs?per_page=1`);
    const run = r.workflow_runs && r.workflow_runs[0];
    if (run) ghStatus(`Son tarama: ${new Date(run.created_at).toLocaleString("tr-TR")} · ${run.status === "completed" ? (run.conclusion === "success" ? "başarılı" : "hata: " + run.conclusion) : "çalışıyor…"}`,
      run.conclusion === "success" ? "ok" : run.conclusion && run.conclusion !== "success" ? "err" : "");
  } catch (e) { ghStatus("GitHub'a bağlanılamadı: " + e.message, "err"); }
}
function readWt() {
  const g = id => parseFloat(document.getElementById(id).value);
  const p = { n1: g("wt_n1"), n2: g("wt_n2"), signal: g("wt_sig"), os_level1: g("wt_os1"), os_level2: g("wt_os2"),
              ob_level1: g("wt_ob1"), ob_level2: g("wt_ob2"), keep_after_exit: g("wt_keep") };
  if (Object.values(p).some(x => !isFinite(x))) throw new Error("Tüm WT alanları sayı olmalı.");
  for (const k of ["n1", "n2", "signal"]) if (p[k] < 1 || p[k] % 1) throw new Error(`${k} pozitif tam sayı olmalı.`);
  if (!(p.os_level2 <= p.os_level1 && p.os_level1 < 0)) throw new Error("OS bantları: OS2 ≤ OS1 < 0 olmalı.");
  if (!(p.ob_level2 >= p.ob_level1 && p.ob_level1 > 0)) throw new Error("OB bantları: OB2 ≥ OB1 > 0 olmalı.");
  if (p.keep_after_exit < 0 || p.keep_after_exit % 1) throw new Error("Tutma süresi 0 veya pozitif tam sayı olmalı.");
  return p;
}
const b64 = s => btoa(unescape(encodeURIComponent(s)));
async function saveWt() {
  readSettings();
  if (!GH.owner || !GH.repo || !GH.token) return ghStatus("Kullanıcı adı, repo ve token gerekli.", "err");
  let p; try { p = readWt(); } catch (e) { return ghStatus(e.message, "err"); }
  ghStatus("Kaydediliyor…");
  try {
    const path = `/repos/${GH.owner}/${GH.repo}/contents/wt_params.json`;
    let sha; try { sha = (await gh(path)).sha; } catch {}
    await gh(path, { method: "PUT", body: JSON.stringify({ message: "WT alpha parametreleri uygulamadan güncellendi", content: b64(JSON.stringify(p, null, 2) + "\n"), sha }) });
    await ghDispatch();
    ghStatus("Kaydedildi, tarama başladı. 10–20 dk sonra uygulamayı yenile.", "ok");
  } catch (e) { ghStatus("Hata: " + e.message + " (token yetkilerini kontrol et)", "err"); }
}
async function runOnly() {
  readSettings();
  if (!GH.owner || !GH.repo || !GH.token) return ghStatus("Kullanıcı adı, repo ve token gerekli.", "err");
  ghStatus("Başlatılıyor…");
  try { await ghDispatch(); ghStatus("Tarama başladı. 10–20 dk sonra uygulamayı yenile.", "ok"); }
  catch (e) { ghStatus("Hata: " + e.message, "err"); }
}

// ------------------------------------------------------------ olaylar
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove("on"), 2200); }
function saveUI() { store.set("wt_ui", { market: UI.market, tf: UI.tf, view: UI.view, fSig: UI.fSig, fList: UI.fList, deep: UI.deep, wtxOnly: UI.wtxOnly }); }

$("#segMarket").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; UI.market = b.dataset.v; shown = 150; saveUI(); setSeg("segMarket", UI.market); loadDataset(); });
$("#segTf").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; UI.tf = b.dataset.v; shown = 150; saveUI(); setSeg("segTf", UI.tf); loadDataset(); });
$("#segView").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; UI.view = b.dataset.v; shown = 150; saveUI(); render(); $("#main").scrollTop = 0; });
$("#chips").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.f === "deep") UI.deep = !UI.deep;
  else if (b.dataset.f === "wtxOnly") UI.wtxOnly = !UI.wtxOnly;
  else UI[b.dataset.f] = b.dataset.v;
  saveUI(); render();
});
$("#search").addEventListener("input", () => { shown = 150; render(); });
$("#main").addEventListener("click", e => {
  if (e.target.id === "btnMore") { shown += 150; render(); return; }
  const c = e.target.closest(".card"); if (c) openChart(ITEMS[+c.dataset.i]);
});
$("#btnBack").addEventListener("click", () => { $("#chartView").classList.add("hidden"); if (chart) { chart.remove(); chart = null; } });
$("#btnSettings").addEventListener("click", () => { renderSettings(); $("#settingsView").classList.remove("hidden"); });
$("#btnSetBack").addEventListener("click", () => { readSettings(); $("#settingsView").classList.add("hidden"); computeSignals(); render(); });
$("#form").addEventListener("change", e => { if (!e.target.id.startsWith("wt_") && !e.target.id.startsWith("gh_")) { readSettings(); computeSignals(); render(); } });
$("#form").addEventListener("click", e => {
  if (e.target.id === "btnReset") { CFG = clone(DEFAULTS); store.set("wt_cfg", CFG); renderSettings(); computeSignals(); render(); toast("Varsayılanlar yüklendi"); }
  if (e.target.id === "btnWt") saveWt();
  if (e.target.id === "btnRun") runOnly();
});
$("#btnCopy").addEventListener("click", async () => {
  const syms = [...new Set(ITEMS.map(x => x.row.tv))];
  if (!syms.length) return toast("Kopyalanacak sembol yok");
  const name = `${UI.market}_${UI.tf}_${UI.view}`;
  const text = `###${name},` + syms.join(",");
  try { await navigator.clipboard.writeText(text); toast(`${syms.length} sembol kopyalandı`); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(`${syms.length} sembol kopyalandı`); } catch { toast("Kopyalanamadı"); }
    ta.remove();
  }
});

// ------------------------------------------------------------ başlat
(async () => {
  try { META = await getJSON("data/meta.json"); } catch { META = null; }
  if (META && META.breakout_defaults && !store.get("wt_cfg", null)) {
    const d = META.breakout_defaults;   // sunucu config.yaml'daki varsayılanları uygula
    CFG.st.atr = d.supertrend_atr; CFG.st.mult = d.supertrend_mult; CFG.ema.fast = d.ema_fast; CFG.ema.slow = d.ema_slow;
    CFG.rsi.len = d.rsi_len; CFG.rsi.mode = d.rsi_mode; CFG.lookback = d.lookback; CFG.rsiLookback = d.rsi_lookback;
    if (d.wt_cross != null) CFG.wtx.on = !!d.wt_cross; if (d.wt_cross_lookback) CFG.wtx.lookback = d.wt_cross_lookback;
    CFG.obBull = !!d.overbought_bullish_continuation; CFG.osBear = !!d.oversold_bearish_continuation;
  }
  await loadDataset();
})();
})();
