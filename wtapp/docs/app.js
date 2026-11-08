/* WT Tarayıcı – web uygulaması (v4)
 * Aşama 1 (WT alpha listeleri) sunucuda (GitHub Actions) hesaplanır.
 * Aşama 2 (kırılım), puanlama ve izleme listesi burada, seçtiğin göstergelerle hesaplanır.
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
const UI = Object.assign({
  market: "us", tab: "signals",
  sigTf: "daily", sigDir: "BULL", fNew: false, fStrong: false,   // sinyaller
  listTf: "daily", listSide: "oversold", listStatus: "all", wtxOnly: false, deep: false,   // listeler
  watchTf: "daily",                                         // izleme
}, store.get("wt_ui4", {}));
if (UI.sigTf === "all") UI.sigTf = "daily";
if (!UI.sigDir) UI.sigDir = "BULL";
const saveUI = () => store.set("wt_ui4", UI);

const { analyze } = window.WTI;
const TF_ORDER = ["4h", "daily", "weekly"];
const TF_LABEL = { "4h": "4S", daily: "Günlük", weekly: "Haftalık" };
const TF_SHORT = { "4h": "4S", daily: "G", weekly: "H" };
const dirsFor = side => side === "oversold" ? (CFG.osBear ? ["BULL", "BEAR"] : ["BULL"])
                                            : (CFG.obBull ? ["BEAR", "BULL"] : ["BEAR"]);

// ------------------------------------------------------------ veri
const cache = {};
let META = null;
async function getJSON(path) {
  if (window.DEMO) { if (window.DEMO[path]) return window.DEMO[path]; throw new Error("demo: " + path); }
  if (cache[path]) return cache[path];
  const v = META && META.updated ? encodeURIComponent(META.updated) : Date.now();
  const r = await fetch(path + "?v=" + v, { cache: "no-cache" });
  if (!r.ok) throw new Error(r.status + " " + path);
  return (cache[path] = await r.json());
}
const safe = s => s.replace(/[^A-Za-z0-9_-]/g, "_");
const tfsOf = m => TF_ORDER.filter(tf => META && META.markets && META.markets[m] && META.markets[m][tf]);
const DS = {};          // "us_daily" → veri seti
async function loadDS(m, tf) {
  const k = `${m}_${tf}`;
  if (DS[k]) return DS[k];
  try { DS[k] = await getJSON(`data/${k}.json`); } catch { DS[k] = null; }
  return DS[k];
}

// ------------------------------------------------------------ sinyal + puan
/** Sinyal bu bardan kaç bar önce başladı (0 = son bar, yani YENİ) */
function ageOf(R, dir, i = R.L - 1) {
  let a = 0;
  while (a < 30 && i - a - 1 >= 0 && R.signalAt(i - a - 1, dir)) a++;
  return a;
}
/** 0–100 puan: RSI teyidi, tetikleyici sayısı, WT kesişimi, bölge derinliği, tazelik, bölgede olma */
function scoreOf(sg, row, age) {
  const t = sg.trig.filter(x => x !== "RSI");
  let s = sg.strength === "WEAK" ? 20 : 45;
  s += Math.min(2, Math.max(0, t.length - 1)) * 8;
  if (t.includes("WTX")) s += 10;
  if (row && /2$/.test(row.zl || "")) s += 10;
  s += age === 0 ? 15 : age === 1 ? 10 : age === 2 ? 5 : 0;
  if (row && row.st) s += row.st === "active" ? 4 : -Math.min(4, row.bse || 0);
  return Math.max(0, Math.min(100, Math.round(s)));
}
const SIG = {};         // "us_daily" → sinyal listesi
let cfgVersion = 0;
function signalsFor(m, tf) {
  const k = `${m}_${tf}`, ds = DS[k];
  if (!ds) return [];
  if (SIG[k] && SIG[k].v === cfgVersion) return SIG[k].list;
  const list = [];
  for (const side of ["oversold", "overbought"]) {
    for (const row of ds.lists[side]) {
      const b = ds.bars[row.s]; if (!b || b.c.length < 30) continue;
      const R = analyze(b, CFG, ds.wt);
      row._wtx = R.wtxAgo(side === "oversold" ? "BULL" : "BEAR");
      for (const dir of dirsFor(side)) {
        const sg = R.signalAt(R.L - 1, dir);
        if (!sg) continue;
        const age = ageOf(R, dir);
        list.push({ m, tf, row, side, dir, ...sg, age, score: scoreOf(sg, row, age), rsi: R.rsi[R.L - 1], live: !!ds.live });
      }
    }
  }
  list.sort((a, b) => b.score - a.score || a.age - b.age);
  SIG[k] = { v: cfgVersion, list };
  return list;
}
function invalidate() { cfgVersion++; }

// ------------------------------------------------------------ yardımcılar
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtPx = v => v == null || isNaN(v) ? "–" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) :
  v >= 1 ? v.toFixed(2) : v.toPrecision(3);
const exOf = tv => (tv || "").split(":")[0];
const symOf = s => s.replace("/", "·");
const agoTxt = (n, tf) => n === 0 ? "bu bar" : `${n} bar önce`;
const trigTxt = t => t.filter(x => x !== "RSI").join(" + ");
let shown = 120;
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove("on"), 2200); }
const chip = (on, attrs, label) => `<button class="chip ${on ? "on" : ""}" ${attrs}>${label}</button>`;
function scoreHTML(sc) {
  const cls = sc >= 70 ? "hi" : sc >= 50 ? "mid" : "";
  return `<span class="score ${cls}" title="Puan"><span class="bar"><i style="width:${sc}%"></i></span><b>${sc}</b></span>`;
}
function fmtWhen(iso) {
  return new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ------------------------------------------------------------ üst bilgi
function updateHeader() {
  const mm = META && META.markets && META.markets[UI.market];
  if (window.DEMO) { $("#upd").textContent = "Demo verisi · gerçek tarama değil"; return; }
  if (!mm) { $("#upd").textContent = "Bu piyasa henüz taranmadı"; return; }
  const last = Object.values(mm).map(x => x.generated).sort().pop();
  const live = mm["4h"] && mm["4h"].live ? " · 4S son bar canlı" : "";
  const n = (mm.daily || mm["4h"] || {}).universe_size;
  $("#upd").textContent = `Son tarama ${fmtWhen(last)}${n ? ` · ${n} sembol` : ""}${live}`;
}

// ------------------------------------------------------------ alt başlık (sekmeye göre)
function renderSub() {
  const tfs = tfsOf(UI.market);
  let h = "";
  if (UI.tab === "signals") {
    if (!tfs.includes(UI.sigTf)) UI.sigTf = tfs.includes("daily") ? "daily" : tfs[0];
    const cnt = SIGCOUNT[`${UI.market}_${UI.sigTf}`] || {};
    const n = d => cnt[d] != null ? `<span class="n">${cnt[d]}</span>` : "";
    h += `<div class="seg">${tfs.map(tf => `<button data-k="sigTf" data-v="${tf}" class="${UI.sigTf === tf ? "on" : ""}">${TF_LABEL[tf]}</button>`).join("")}</div>
         <div class="seg"><button data-k="sigDir" data-v="BULL" class="${UI.sigDir === "BULL" ? "on" : ""}">▲ Yükseliş${n("BULL")}</button><button data-k="sigDir" data-v="BEAR" class="${UI.sigDir === "BEAR" ? "on" : ""}">▼ Düşüş${n("BEAR")}</button></div>
         <div class="subrow"><input class="search" id="search" type="search" placeholder="Sembol ara" autocomplete="off" autocapitalize="characters">
           <button class="iconbtn sm" id="btnCopy" aria-label="TradingView listesini kopyala" title="TradingView listesini kopyala"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button></div>
         <div class="chips">${chip(UI.fNew, 'data-t="fNew"', `Sadece yeni${cnt.NEW ? ` · ${cnt.NEW}` : ""}`)}${chip(UI.fStrong, 'data-t="fStrong"', "Sadece güçlü")}</div>`;
  } else if (UI.tab === "lists") {
    if (!tfs.includes(UI.listTf)) UI.listTf = tfs.includes("daily") ? "daily" : tfs[0];
    const dsk = `${UI.market}_${UI.listTf}`, ds = DS[dsk];
    const n = s => ds ? `<span class="n">${ds.lists[s].length}</span>` : "";
    const wtp = (ds && ds.wt) || (META && META.wt) || {};
    h += `<div class="row2">
        <div class="seg">${tfs.map(tf => `<button data-k="listTf" data-v="${tf}" class="${UI.listTf === tf ? "on" : ""}">${TF_LABEL[tf]}</button>`).join("")}</div>
        <div class="seg"><button data-k="listSide" data-v="oversold" class="${UI.listSide === "oversold" ? "on" : ""}">OS${n("oversold")}</button><button data-k="listSide" data-v="overbought" class="${UI.listSide === "overbought" ? "on" : ""}">OB${n("overbought")}</button></div></div>
      <div class="subrow"><input class="search" id="search" type="search" placeholder="Sembol ara" autocomplete="off" autocapitalize="characters">
        <button class="iconbtn sm" id="btnCopy" aria-label="TradingView listesini kopyala"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button></div>
      <div class="chips">
        ${chip(UI.wtxOnly, 'data-t="wtxOnly"', `WT kesişimi · son ${CFG.wtx.lookback} bar`)}
        ${chip(UI.listStatus === "active", 'data-k="listStatus" data-v="active" data-toggle="1"', "Bölgede")}
        ${chip(UI.listStatus === "exited", 'data-k="listStatus" data-v="exited" data-toggle="1"', "Çıkmış")}
        ${chip(UI.deep, 'data-t="deep"', UI.listSide === "oversold" ? `${wtp.os_level2 ?? -53} altı` : `${wtp.ob_level2 ?? 53} üstü`)}</div>`;
  } else {
    if (!tfs.includes(UI.watchTf)) UI.watchTf = tfs.includes("daily") ? "daily" : tfs[0];
    h += `<div class="seg">${tfs.map(tf => `<button data-k="watchTf" data-v="${tf}" class="${UI.watchTf === tf ? "on" : ""}">${TF_LABEL[tf]}</button>`).join("")}</div>`;
  }
  const keep = document.activeElement && document.activeElement.id === "search" ? $("#search").value : (renderSub.q || "");
  $("#sub").innerHTML = h;
  const s = $("#search"); if (s) s.value = keep;
}
const query = () => { const s = $("#search"); return (renderSub.q = s ? s.value.trim().toUpperCase() : ""); };

// ------------------------------------------------------------ SİNYALLER
let ITEMS = [];
const SIGCOUNT = {};
async function renderSignals() {
  const tfs = tfsOf(UI.market), tf = UI.sigTf;
  if (!tfs.length) { $("#main").innerHTML = `<div class="empty">Bu piyasa için henüz veri yok. İlk tarama bitince burada görünecek.</div>`; ITEMS = []; return; }
  await loadDS(UI.market, tf);
  const all = signalsFor(UI.market, tf);
  const k = `${UI.market}_${tf}`, before = JSON.stringify(SIGCOUNT[k] || {});
  SIGCOUNT[k] = { BULL: all.filter(x => x.dir === "BULL").length, BEAR: all.filter(x => x.dir === "BEAR").length,
                  NEW: all.filter(x => x.dir === UI.sigDir && x.age === 0).length };
  if (JSON.stringify(SIGCOUNT[k]) !== before && render.sub !== false) renderSub();
  $("#tbNew").textContent = all.filter(x => x.age === 0 && x.strength !== "WEAK").length || "";
  const q = query();
  ITEMS = all.filter(x => x.dir === UI.sigDir && (!q || x.row.s.toUpperCase().includes(q)) &&
    (!UI.fNew || x.age === 0) && (!UI.fStrong || x.strength !== "WEAK"));
  const nNew = ITEMS.filter(x => x.age === 0).length, nStrong = ITEMS.filter(x => x.strength !== "WEAK").length;
  const ds = DS[k];
  let h = `<div class="note">${TF_LABEL[tf]} · ${UI.sigDir === "BULL" ? "Oversold listesinden yükseliş" : "Overbought listesinden düşüş"} kırılımları · <b>${ITEMS.length}</b> sinyal, <b>${nNew}</b> yeni, <b>${nStrong}</b> güçlü${ds && ds.bar_date ? ` · son bar ${esc(ds.bar_date)}${ds.live && tf === "4h" ? " (canlı)" : ""}` : ""}</div>`;
  if (!ITEMS.length) h += `<div class="empty">Bu listede sinyal yok.</div>`;
  h += ITEMS.slice(0, shown).map((x, i) => sigCard(x, i)).join("");
  if (ITEMS.length > shown) h += `<button class="more" id="btnMore">${ITEMS.length - shown} sinyal daha göster</button>`;
  h += `<div class="note">${describeRule()} Puan (0–100): RSI teyidi, tetikleyici sayısı, WT kesişimi, ${(META && META.wt && META.wt.os_level2) || -53}/${(META && META.wt && META.wt.ob_level2) || 53} derinliği ve sinyalin tazeliğinden hesaplanır.</div>`;
  $("#main").innerHTML = h;
}
function sigCard(x, i) {
  const r = x.row, d = x.dir === "BULL";
  const tags = [];
  if (x.age === 0) tags.push(`<span class="tag new">YENİ</span>`);
  tags.push(`<span class="tag ${d ? "bull" : "bear"}">${d ? "▲" : "▼"} ${x.strength === "WEAK" ? "Zayıf" : "Güçlü"}</span>`);
  if (x.live && x.tf === "4h") tags.push(`<span class="tag live" title="Son 4 saatlik bar henüz kapanmadı">canlı</span>`);
  const rsiOk = x.trig.includes("RSI") ? " · RSI ✓" : "";
  return `<button class="card ${d ? "bull" : "bear"}" data-i="${i}">
    <div class="l1"><div class="ttl"><span class="sym">${esc(symOf(r.s))}</span><span class="ex">${esc(exOf(r.tv))}</span></div><div class="px">${fmtPx(r.c)}</div></div>
    <div class="l2">${tags.join("")}${scoreHTML(x.score)}</div>
    <div class="meta"><b>${esc(trigTxt(x.trig))}</b>${rsiOk} · ${r.zl} · ${agoTxt(x.age)} · WT1 ${r.w1.toFixed(1)}</div>
  </button>`;
}

// ------------------------------------------------------------ WT LİSTELERİ
async function renderLists() {
  const ds = await loadDS(UI.market, UI.listTf);
  if (render.sub !== false) renderSub();   // sayılar için
  if (!ds) { $("#main").innerHTML = `<div class="empty">Bu zaman dilimi için henüz veri yok.</div>`; ITEMS = []; return; }
  signalsFor(UI.market, UI.listTf);   // _wtx değerleri
  const q = query(), deepLvl = UI.listSide === "oversold" ? "OS2" : "OB2";
  ITEMS = ds.lists[UI.listSide].filter(r => (!q || r.s.toUpperCase().includes(q)) &&
      (UI.listStatus === "all" || r.st === UI.listStatus) && (!UI.deep || r.zl === deepLvl) &&
      (!UI.wtxOnly || (r._wtx != null && r._wtx < +CFG.wtx.lookback)))
    .slice().sort((a, b) => (a._wtx ?? 99) - (b._wtx ?? 99) || (a.st === b.st ? 0 : a.st === "active" ? -1 : 1) || Math.abs(b.w1) - Math.abs(a.w1))
    .map(r => ({ m: UI.market, tf: UI.listTf, row: r, side: UI.listSide }));
  let h = ITEMS.length ? "" : `<div class="empty">Listede sembol yok.</div>`;
  h += ITEMS.slice(0, shown).map((x, i) => listCard(x, i)).join("");
  if (ITEMS.length > shown) h += `<button class="more" id="btnMore">${ITEMS.length - shown} sembol daha göster</button>`;
  $("#main").innerHTML = h;
}
function listCard(x, i) {
  const r = x.row, os = x.side === "oversold";
  const tags = [`<span class="tag ${/2$/.test(r.zl) ? "deep" : ""}">${r.zl}</span>`,
    `<span class="tag">${r.st === "active" ? `bölgede · ${r.biz} bar` : `çıktı · ${r.bse} bar önce`}</span>`];
  if (r._wtx != null && r._wtx <= 10) tags.push(`<span class="tag ${r._wtx < +CFG.wtx.lookback ? "wtx" : ""}">WT✕ ${agoTxt(r._wtx)}</span>`);
  return `<button class="card ${os ? "bull" : "bear"}" data-i="${i}">
    <div class="l1"><div class="ttl"><span class="sym">${esc(symOf(r.s))}</span><span class="ex">${esc(exOf(r.tv))}</span></div><div class="px">${fmtPx(r.c)}</div></div>
    <div class="l2">${tags.join("")}</div>
    <div class="meta">WT1 <b>${r.w1.toFixed(1)}</b> · en uç <b>${r.pk.toFixed(1)}</b> · bölgeye giriş ${esc(r.fs)}</div>
  </button>`;
}

// ------------------------------------------------------------ İZLEME
const WATCH = { saved: null, edit: null };
function watchList() {
  const m = UI.market;
  if (!WATCH.saved) WATCH.saved = clone((META && META.watch) || {});
  if (!WATCH.edit) WATCH.edit = Object.assign(clone(WATCH.saved), store.get("wt_watch_edit", {}));
  return WATCH.edit[m] || [];
}
const watchDirty = () => JSON.stringify((WATCH.edit || {})[UI.market] || []) !== JSON.stringify((WATCH.saved || {})[UI.market] || []);
async function renderWatch() {
  const syms = watchList();
  const ds = await loadDS(UI.market, UI.watchTf);
  const wt = (ds && ds.wt) || (META && META.wt) || {};
  const rows = ds ? ds.lists.watch || [] : [];
  const missing = new Set(ds ? ds.watch_missing || [] : []);
  ITEMS = [];
  const cards = [];
  for (const s of syms) {
    const key = s.replace(".", "-");
    const row = rows.find(r => r.s === key || r.s === s || r.s.split("/")[0] === s);
    if (!row) {
      cards.push(`<div class="card"><div class="l1"><div class="ttl"><span class="sym">${esc(s)}</span></div></div>
        <div class="meta">${missing.has(s) ? "Veri bulunamadı. Sembolü kontrol et (US: AAPL, BIST: THYAO, kripto: BTC)." : "Veri bekleniyor. Listeyi kaydedip taramayı başlat."}</div></div>`);
      continue;
    }
    const b = ds.bars[row.s];
    const R = analyze(b, CFG, wt), L = R.L, w1 = R.wt.wt1[L - 1];
    // bölge durumu
    let zone = "Nötr bölgede", zc = "";
    const run = (cond) => { let n = 0; while (n < L && cond(R.wt.wt1[L - 1 - n])) n++; return n; };
    if (w1 <= wt.os_level1) { zone = `Oversold bölgesinde · ${run(v => v <= wt.os_level1)} bar${w1 <= wt.os_level2 ? " · derin" : ""}`; zc = "bull"; }
    else if (w1 >= wt.ob_level1) { zone = `Overbought bölgesinde · ${run(v => v >= wt.ob_level1)} bar${w1 >= wt.ob_level2 ? " · derin" : ""}`; zc = "bear"; }
    else {
      let j = L - 1; while (j >= 0 && R.wt.wt1[j] > wt.os_level1 && R.wt.wt1[j] < wt.ob_level1) j--;
      if (j >= 0 && L - 1 - j <= 10) zone = `${R.wt.wt1[j] <= wt.os_level1 ? "Oversold" : "Overbought"}'dan çıktı · ${L - 1 - j} bar önce`;
    }
    // son 10 bardaki en yakın sinyal (bölge şartı olmadan)
    let last = null;
    for (let i = L - 1; i >= Math.max(30, L - 10) && !last; i--)
      for (const dir of ["BULL", "BEAR"]) { const sg = R.signalAt(i, dir); if (sg && !(R.signalAt(i - 1, dir))) { last = { ...sg, dir, ago: L - 1 - i }; break; } }
    const wx = Math.min(R.wtxAgo("BULL") ?? 99, R.wtxAgo("BEAR") ?? 99);
    const pos = Math.max(0, Math.min(100, (w1 + 100) / 2));
    const idx = ITEMS.push({ m: UI.market, tf: UI.watchTf, row: Object.assign({ zl: "", st: "", w1 }, row), side: w1 < 0 ? "oversold" : "overbought" }) - 1;
    const sigLine = last ? `<span class="tag ${last.dir === "BULL" ? "bull" : "bear"}">${last.dir === "BULL" ? "▲" : "▼"} ${last.strength === "WEAK" ? "Zayıf" : "Güçlü"}</span>
        <span class="meta"><b>${esc(trigTxt(last.trig))}</b>${last.trig.includes("RSI") ? " · RSI ✓" : ""} · ${agoTxt(last.ago)}</span>`
      : `<span class="meta">Son 10 barda kırılım yok</span>`;
    cards.push(`<button class="card ${zc}" data-i="${idx}">
      <div class="l1"><div class="ttl"><span class="sym">${esc(symOf(row.s))}</span><span class="ex">${esc(exOf(row.tv))}</span></div><div class="px">${fmtPx(row.c)}</div></div>
      <div class="gauge" title="WT1 ${w1.toFixed(1)}" style="background:linear-gradient(90deg, rgba(38,176,122,.45) 0 ${(wt.os_level1 + 100) / 2}%, var(--raise) ${(wt.os_level1 + 100) / 2}% ${(wt.ob_level1 + 100) / 2}%, rgba(236,91,86,.45) ${(wt.ob_level1 + 100) / 2}% 100%)"><i style="left:${pos}%"></i></div>
      <div class="meta">WT1 <b>${w1.toFixed(1)}</b> · ${zone}${wx <= 10 ? ` · WT✕ ${agoTxt(wx)}` : ""}</div>
      <div class="l2">${sigLine}</div></button>`);
  }
  const dirty = watchDirty();
  const editor = `<div class="wedit">
    <div class="add"><input id="wAdd" placeholder="${UI.market === "us" ? "AAPL" : UI.market === "bist" ? "THYAO" : "BTC"}" autocomplete="off" autocapitalize="characters" enterkeyhint="done">
      <button class="btn sm" id="btnWAdd">Ekle</button></div>
    <div class="wchips">${syms.map(s => `<span class="wchip ${(WATCH.saved[UI.market] || []).includes(s) ? "" : "pending"}">${esc(s)}<button data-del="${esc(s)}" aria-label="${esc(s)} sil">×</button></span>`).join("") || `<span class="meta">Liste boş. Takip etmek istediğin sembolleri ekle.</span>`}</div>
    ${dirty ? `<button class="btn primary" id="btnWSave" ${window.DEMO ? "disabled" : ""}>Kaydet ve ${UI.market.toUpperCase()} taramasını başlat</button><div class="status" id="wStatus">Kaydedince sunucu bu sembolleri her taramada indirir (10–20 dk).</div>` : ""}
  </div>`;
  $("#main").innerHTML = editor + cards.join("") +
    `<div class="note">İzleme listesindeki semboller WT bölgesinde olmasa da taranır. Kırılımlar seçtiğin göstergelere göre, bölge şartı olmadan gösterilir.</div>`;
}

// ------------------------------------------------------------ ortak render
async function render(sub = true) {
  render.sub = sub;
  document.querySelectorAll("#segMarket button").forEach(b => b.classList.toggle("on", b.dataset.v === UI.market));
  document.querySelectorAll("#tabbar button").forEach(b => b.classList.toggle("on", b.dataset.v === UI.tab));
  updateHeader();
  if (sub) renderSub();
  if (!window.__rendering) window.__rendering = 0;
  const token = ++window.__rendering;
  if (!$("#main").innerHTML) $("#main").innerHTML = `<div class="empty">Yükleniyor…</div>`;
  if (UI.tab === "signals") await renderSignals();
  else if (UI.tab === "lists") await renderLists();
  else await renderWatch();
  if (token !== window.__rendering) return;
}
function describeRule() {
  const t = [];
  if (CFG.st.on) t.push(`Supertrend(${CFG.st.atr}, ${CFG.st.mult})`);
  if (CFG.ema.on) t.push(`EMA ${CFG.ema.fast}/${CFG.ema.slow}`);
  if (CFG.macd.on) t.push(`MACD ${CFG.macd.fast}/${CFG.macd.slow}/${CFG.macd.sig}`);
  if (CFG.wtx.on) t.push(`WT kesişimi`);
  if (!t.length) return "Hiç tetikleyici seçili değil. Ayarlardan en az birini aç.";
  const r = CFG.rsi.role === "off" ? "RSI kapalı" : CFG.rsi.role === "require" ? "RSI teyidi zorunlu" : "RSI teyidi güçlü/zayıf ayırır";
  return `Kural: ${t.join(CFG.combine === "all" ? " ve " : " veya ")} · ${r}.`;
}

// ------------------------------------------------------------ grafik
let chart = null;
async function openChart(x) {
  const r = x.row, ds = DS[`${x.m}_${x.tf}`];
  $("#chartView").classList.remove("hidden");
  $("#cSym").textContent = symOf(r.s);
  const zoneTxt = r.st ? ` · ${r.zl} · ${r.st === "active" ? `bölgede ${r.biz} bar` : `çıktı ${r.bse} bar önce`}` : "";
  $("#cSub").textContent = `${TF_LABEL[x.tf]}${zoneTxt}${ds && ds.live && x.tf === "4h" ? " · son bar canlı" : ""}`;
  $("#cTv").href = "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(r.tv) + (x.tf === "4h" ? "&interval=240" : x.tf === "weekly" ? "&interval=W" : "&interval=D");
  const box = $("#chartBox"); box.innerHTML = `<div id="ohlc"></div>`;
  let b;
  try { b = await getJSON(`data/bars/${x.m}_${x.tf}/${safe(r.s)}.json`); }
  catch { b = ds.bars[r.s]; }
  drawChart(box, b, ds, x.tf);
}
const fmtTime = (sec, intra) => new Date(sec * 1000).toLocaleString("tr-TR", Object.assign(
  { timeZone: "UTC", day: "2-digit", month: "short", year: "2-digit" }, intra ? { hour: "2-digit", minute: "2-digit" } : {}));
function drawChart(box, b, ds, tf) {
  if (chart) { chart.remove(); chart = null; }
  const css = getComputedStyle(document.documentElement);
  const C = k => css.getPropertyValue(k).trim();
  const wt = (ds && ds.wt) || (META && META.wt);
  const R = analyze(b, CFG, wt);
  const intra = b.u === "s";
  const T = b.t.map(d => intra ? d : d * 86400);
  const LW = window.LightweightCharts;
  chart = LW.createChart(box, {
    autoSize: true,
    layout: { background: { color: C("--bg") }, textColor: C("--muted"), fontFamily: C("--font-num"), fontSize: 11,
              panes: { separatorColor: C("--line"), separatorHoverColor: C("--raise") } },
    grid: { vertLines: { color: "rgba(38,48,60,.45)" }, horzLines: { color: "rgba(38,48,60,.45)" } },
    rightPriceScale: { borderColor: C("--line") },
    timeScale: { borderColor: C("--line"), rightOffset: 4, barSpacing: 6, timeVisible: intra, secondsVisible: false },
    crosshair: { mode: 0 },
    localization: { locale: "tr-TR" },
  });
  const bull = C("--bull"), bear = C("--bear"), acc = C("--accent");
  const candle = chart.addSeries(LW.CandlestickSeries, {
    upColor: bull, downColor: bear, borderUpColor: bull, borderDownColor: bear, wickUpColor: bull, wickDownColor: bear,
    priceLineVisible: true, priceLineStyle: 2,
  });
  candle.setData(T.map((t, i) => ({ time: t, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] })));
  const line = (data, color, w = 1.5, pane = 0, extra = {}) => {
    const s = chart.addSeries(LW.LineSeries, { color, lineWidth: w, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, ...extra }, pane);
    s.setData(data); return s;
  };
  const pts = (arr, ok = () => true) => T.map((t, i) => (!isNaN(arr[i]) && ok(i)) ? { time: t, value: arr[i] } : { time: t });
  if (R.st) {
    const d = R.st.dir;   // tek çizgi, yön değişen yerde kopukluk (TradingView gibi)
    line(T.map((t, i) => isNaN(R.st.line[i]) ? { time: t } : { time: t, value: R.st.line[i],
      color: i < d.length - 1 && d[i + 1] !== d[i] && d[i] !== 0 ? "rgba(0,0,0,0)" : d[i] === 1 ? bull : bear }), bull, 1.5);
  }
  if (R.ef) { line(pts(R.ef), acc, 1.2); line(pts(R.es), "#6aa6f8", 1.2); }

  // sinyal okları: sinyalin başladığı (veya zayıftan güçlüye döndüğü) bar
  const markers = [];
  for (const dir of ["BULL", "BEAR"]) {
    const allowed = dir === "BULL" ? (i => R.nearOS[i] || (CFG.obBull && R.nearOB[i]))
                                   : (i => R.nearOB[i] || (CFG.osBear && R.nearOS[i]));
    let prev = null;
    for (let i = 30; i < R.L; i++) {
      const sg = allowed(i) ? R.signalAt(i, dir) : null;
      const lvl = sg ? (sg.strength === "WEAK" ? 1 : 2) : 0, pl = prev ? (prev.strength === "WEAK" ? 1 : 2) : 0;
      if (lvl > pl) {
        const strong = lvl === 2;
        markers.push({ time: T[i], position: dir === "BULL" ? "belowBar" : "aboveBar",
          color: strong ? (dir === "BULL" ? bull : bear) : "#9aa5b4",
          shape: strong ? (dir === "BULL" ? "arrowUp" : "arrowDown") : "circle", size: strong ? 1.3 : 0.8 });
      }
      prev = sg;
    }
  }
  markers.sort((a, b) => a.time - b.time);
  LW.createSeriesMarkers(candle, markers);

  // WT alpha paneli (TradingView: WT1 yeşil, WT2 kırmızı)
  let pane = 1;
  const w1 = line(pts(R.wt.wt1), bull, 1.6, pane, { lastValueVisible: true });
  line(pts(R.wt.wt2), "rgba(236,91,86,.85)", 1.2, pane);
  for (const [v, c] of [[wt.ob_level2, bear], [wt.ob_level1, "rgba(236,91,86,.5)"], [0, C("--line")],
                        [wt.os_level1, "rgba(38,176,122,.5)"], [wt.os_level2, bull]])
    w1.createPriceLine({ price: +v, color: c, lineWidth: 1, lineStyle: 2, axisLabelVisible: v !== 0, title: "" });
  const dots = [];
  for (let i = 1; i < R.L; i++) {
    if (R.wtxUp[i] || R.wtxDn[i]) dots.push({ time: T[i], position: "inBar", color: "#f5d90a", shape: "circle", size: 1.4 });
    else if (R.wtxAll[i]) dots.push({ time: T[i], position: "inBar", color: R.wt.wt1[i] > R.wt.wt2[i] ? bull : bear, shape: "circle", size: 0.5 });
  }
  LW.createSeriesMarkers(w1, dots);
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

  // bar bilgisi: parmağını/fareyi grafikte gezdir
  const idxOf = new Map(T.map((t, i) => [t, i]));
  const ohlc = box.querySelector("#ohlc");
  const show = i => {
    const p = i > 0 ? b.c[i - 1] : b.o[i], ch = (b.c[i] - p) / p * 100;
    const f = v => fmtPx(v);
    ohlc.innerHTML = `${fmtTime(T[i], intra)}${i === R.L - 1 && ds && ds.live && intra ? " · canlı" : ""}<br>
      A <b>${f(b.o[i])}</b> Y <b>${f(b.h[i])}</b> D <b>${f(b.l[i])}</b> K <b>${f(b.c[i])}</b> <span class="${ch >= 0 ? "up" : "dn"}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%</span><br>
      WT1 <b>${isNaN(R.wt.wt1[i]) ? "–" : R.wt.wt1[i].toFixed(1)}</b> WT2 <b>${isNaN(R.wt.wt2[i]) ? "–" : R.wt.wt2[i].toFixed(1)}</b>${R.rsi ? ` RSI <b>${isNaN(R.rsi[i]) ? "–" : R.rsi[i].toFixed(1)}</b>` : ""}`;
  };
  show(R.L - 1);
  chart.subscribeCrosshairMove(p => { const i = p && p.time != null ? idxOf.get(p.time) : undefined; show(i == null ? R.L - 1 : i); });

  const lg = [`<span><i class="tri-up"></i> güçlü yükseliş</span>`, `<span><i class="tri-dn"></i> güçlü düşüş</span>`,
    `<span><i class="dot" style="background:#9aa5b4"></i> zayıf</span>`, `<span><i class="dot" style="background:#f5d90a"></i> WT bölge içi kesişim</span>`];
  if (R.st) lg.push(`<span><i class="sw" style="background:${bull}"></i><i class="sw" style="background:${bear}"></i> Supertrend</span>`);
  if (R.ef) lg.push(`<span><i class="sw" style="background:${acc}"></i> EMA${CFG.ema.fast}</span><span><i class="sw" style="background:#6aa6f8"></i> EMA${CFG.ema.slow}</span>`);
  $("#chartInfo").innerHTML = `<div class="legend">${lg.join("")}</div>
    <div>Bar fiyatlarını görmek için parmağını grafikte gezdir. Oklar yalnızca WT bölgesindeyken ya da çıktıktan sonraki ${wt.keep_after_exit} bar içinde gösterilir.</div>`;
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
async function ghDispatch(market = "all", tf = "all") {
  const repo = await gh(`/repos/${GH.owner}/${GH.repo}`);
  await gh(`/repos/${GH.owner}/${GH.repo}/actions/workflows/scan.yml/dispatches`,
    { method: "POST", body: JSON.stringify({ ref: repo.default_branch, inputs: { market, tf } }) });
}
async function ghPutJSON(file, obj, message) {
  const path = `/repos/${GH.owner}/${GH.repo}/contents/${file}`;
  let sha; try { sha = (await gh(path)).sha; } catch {}
  await gh(path, { method: "PUT", body: JSON.stringify({ message, content: b64(JSON.stringify(obj, null, 2) + "\n"), sha }) });
}
async function saveWatch() {
  const st = t => { const e = $("#wStatus"); if (e) e.textContent = t; };
  if (!GH.owner || !GH.repo || !GH.token) { st("Kaydetmek için Ayarlar'da GitHub kullanıcı adı, repo ve token gir."); return; }
  st("Kaydediliyor…");
  try {
    await ghPutJSON("my_symbols.json", WATCH.edit, "İzleme listesi uygulamadan güncellendi");
    await ghDispatch(UI.market, "all");
    WATCH.saved = clone(WATCH.edit); store.set("wt_watch_edit", {});
    if (META) META.watch = clone(WATCH.saved);
    toast("Kaydedildi, tarama başladı");
    render();
  } catch (e) { st("Hata: " + e.message + " (token yetkilerini kontrol et)"); }
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
    await ghPutJSON("wt_params.json", p, "WT alpha parametreleri uygulamadan güncellendi");
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
$("#segMarket").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; UI.market = b.dataset.v; shown = 120; saveUI(); $("#main").innerHTML = ""; render(); });
$("#tabbar").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; UI.tab = b.dataset.v; shown = 120; saveUI(); $("#main").innerHTML = ""; render(); $("#main").scrollTop = 0; });
$("#sub").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "btnCopy") return copyTV();
  if (b.dataset.t) UI[b.dataset.t] = !UI[b.dataset.t];
  else if (b.dataset.k) {
    const k = b.dataset.k, v = b.dataset.v;
    if (b.dataset.toggle) UI[k] = UI[k] === v ? (k === "listStatus" ? "all" : "") : v; else UI[k] = v;
  } else return;
  shown = 120; saveUI(); render();
});
let qTimer; $("#sub").addEventListener("input", e => { if (e.target.id === "search") { clearTimeout(qTimer); qTimer = setTimeout(() => { shown = 120; render(false); }, 150); } });
$("#main").addEventListener("click", e => {
  if (e.target.id === "btnMore") { shown += 120; render(); return; }
  if (e.target.id === "btnWAdd") return addWatch();
  if (e.target.id === "btnWSave") return saveWatch();
  const del = e.target.closest("[data-del]");
  if (del) { const m = UI.market; WATCH.edit[m] = (WATCH.edit[m] || []).filter(s => s !== del.dataset.del); persistWatch(); render(); return; }
  const c = e.target.closest(".card[data-i]"); if (c) openChart(ITEMS[+c.dataset.i]);
});
$("#main").addEventListener("keydown", e => { if (e.target.id === "wAdd" && e.key === "Enter") addWatch(); });
function persistWatch() { const diff = {}; for (const m in WATCH.edit) diff[m] = WATCH.edit[m]; store.set("wt_watch_edit", diff); }
function addWatch() {
  const inp = $("#wAdd"); if (!inp) return;
  const vals = inp.value.toUpperCase().split(/[\s,;]+/).map(v => v.replace(/^[A-Z]+:/, "").trim()).filter(Boolean);
  if (!vals.length) return;
  const m = UI.market; watchList();
  const cur = WATCH.edit[m] || (WATCH.edit[m] = []);
  for (const v of vals) if (!cur.includes(v)) cur.push(v);
  persistWatch(); render();
}
async function copyTV() {
  const syms = [...new Set(ITEMS.map(x => x.row.tv).filter(Boolean))];
  if (!syms.length) return toast("Kopyalanacak sembol yok");
  const text = `###${UI.market}_${UI.tab},` + syms.join(",");
  try { await navigator.clipboard.writeText(text); toast(`${syms.length} sembol kopyalandı`); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(`${syms.length} sembol kopyalandı`); } catch { toast("Kopyalanamadı"); }
    ta.remove();
  }
}
$("#btnBack").addEventListener("click", () => { $("#chartView").classList.add("hidden"); if (chart) { chart.remove(); chart = null; } });
$("#btnSettings").addEventListener("click", () => { renderSettings(); $("#settingsView").classList.remove("hidden"); });
$("#btnSetBack").addEventListener("click", () => { readSettings(); invalidate(); $("#settingsView").classList.add("hidden"); render(); });
$("#form").addEventListener("change", e => { if (!e.target.id.startsWith("wt_") && !e.target.id.startsWith("gh_")) { readSettings(); invalidate(); } });
$("#form").addEventListener("click", e => {
  if (e.target.id === "btnReset") { CFG = clone(DEFAULTS); store.set("wt_cfg", CFG); invalidate(); renderSettings(); toast("Varsayılanlar yüklendi"); }
  if (e.target.id === "btnWt") saveWt();
  if (e.target.id === "btnRun") runOnly();
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
  await render();
})();
})();
