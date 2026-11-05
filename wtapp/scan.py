#!/usr/bin/env python3
"""WT Scanner - WaveTrend bölge taraması + Supertrend/EMA/RSI kırılım taraması.

Örnekler:
  python scan.py --market us --tf daily
  python scan.py --market all --tf both
  python scan.py --market crypto --stage 2
  python scan.py --market all --demo        # internetsiz test (sentetik veri)
"""
import argparse
import json
import logging
import os
from datetime import datetime

import pandas as pd
import requests
import yaml

import data as D
import db as DB
import export as X
from indicators import wavetrend, supertrend, ema, rsi, crossed_above, crossed_below

log = logging.getLogger("wtscanner")
TF_MAP = {"daily": ("short", "daily"), "weekly": ("long", "weekly")}


# ================================================================== Aşama 1
def zone_state(wt1: pd.Series, wt2: pd.Series, side: str, wc: dict) -> dict | None:
    """Bir sembolün oversold/overbought listesindeki durumu (geçmişten deterministik)."""
    wt1 = wt1.dropna()
    if len(wt1) < 5:
        return None
    if side == "oversold":
        inz = wt1 <= wc["os_level1"]
    else:
        inz = wt1 >= wc["ob_level1"]
    flags = inz.values
    L = len(flags)
    hits = [i for i in range(L) if flags[i]]
    if not hits:
        return None
    j = hits[-1]                       # bölgede görülen son bar
    since_exit = L - 1 - j
    if since_exit > wc["keep_after_exit"]:
        return None
    start = j
    while start > 0 and flags[start - 1]:
        start -= 1
    run = wt1.iloc[start:j + 1]
    peak = run.min() if side == "oversold" else run.max()

    def level(v):
        if side == "oversold":
            return "OS2" if v <= wc["os_level2"] else ("OS1" if v <= wc["os_level1"] else "NONE")
        return "OB2" if v >= wc["ob_level2"] else ("OB1" if v >= wc["ob_level1"] else "NONE")

    return {
        "zone_level": level(peak),
        "current_level": level(wt1.iloc[-1]),
        "wt1": round(float(wt1.iloc[-1]), 2),
        "wt2": round(float(wt2.iloc[-1]), 2) if pd.notna(wt2.iloc[-1]) else None,
        "peak_wt1": round(float(peak), 2),
        "first_seen_date": str(wt1.index[start].date()),
        "last_seen_date": str(wt1.index[j].date()),
        "bar_date": str(wt1.index[-1].date()),
        "bars_in_zone": int(j - start + 1),
        "bars_since_exit": int(since_exit),
        "status": "active" if since_exit == 0 else "exited",
    }


def stage1(con, universe: dict, tf: str, cfg) -> dict[str, list]:
    horizon, frame = TF_MAP[tf]
    wc = cfg["wavetrend"]
    lists = {f"{horizon}_oversold": [], f"{horizon}_overbought": []}
    now = datetime.now().isoformat(timespec="seconds")
    for sym, d in universe.items():
        df = d[frame]
        if df is None or len(df) < wc["n1"] + wc["n2"] + 10:
            continue
        wt1, wt2 = wavetrend(df, wc["n1"], wc["n2"], wc["signal"])
        for side in ("oversold", "overbought"):
            st = zone_state(wt1, wt2, side, wc)
            if st:
                lists[f"{horizon}_{side}"].append({
                    "symbol": sym, "tv_symbol": d["tv"], "timeframe": frame,
                    **st, "close": round(float(df["close"].iloc[-1]), 6), "updated_at": now,
                })
    for t, rows in lists.items():
        DB.replace_watchlist(con, t, rows)
        a = sum(r["status"] == "active" for r in rows)
        log.info("  %-17s %4d sembol (%d aktif, %d çıkmış)", t, len(rows), a, len(rows) - a)
    return lists


# ================================================================== Aşama 2
def check_breakout(df: pd.DataFrame, direction: str, bc: dict) -> dict:
    lb, rlb = bc["lookback"], bc["rsi_lookback"]
    _, st_dir = supertrend(df, bc["supertrend_atr"], bc["supertrend_mult"])
    ef, es = ema(df["close"], bc["ema_fast"]), ema(df["close"], bc["ema_slow"])
    r = rsi(df["close"], bc["rsi_len"])
    if direction == "BULL":
        a = crossed_above(st_dir.astype(float), 0, lb)
        b = crossed_above(ef, es, lb)
        if bc["rsi_mode"] == "level":
            c = bool(r.iloc[-1] > 50)
        else:
            c = crossed_above(r, 50, rlb) or crossed_above(r, 30, rlb)
    else:
        a = crossed_below(st_dir.astype(float), 0, lb)
        b = crossed_below(ef, es, lb)
        if bc["rsi_mode"] == "level":
            c = bool(r.iloc[-1] < 50)
        else:
            c = crossed_below(r, 50, rlb) or crossed_below(r, 70, rlb)
    return {"A": a, "B": b, "C": c, "rsi": round(float(r.iloc[-1]), 1)}


def stage2(con, universe: dict, tf: str, cfg) -> list[dict]:
    horizon, frame = TF_MAP[tf]
    bc = cfg["breakout"]
    now = datetime.now().isoformat(timespec="seconds")
    out = []
    for side in ("oversold", "overbought"):
        table = f"{horizon}_{side}"
        dirs = ["BULL"] if side == "oversold" else ["BEAR"]
        if side == "overbought" and bc.get("overbought_bullish_continuation"):
            dirs.append("BULL")
        if side == "oversold" and bc.get("oversold_bearish_continuation"):
            dirs.append("BEAR")
        for row in DB.read_watchlist(con, table):
            d = universe.get(row["symbol"])
            if not d or d[frame] is None or len(d[frame]) < 30:
                continue
            df = d[frame]
            for dr in dirs:
                t = check_breakout(df, dr, bc)
                if not (t["A"] or t["B"]):
                    continue
                out.append({
                    "scan_time": now, "bar_date": row["bar_date"], "symbol": row["symbol"],
                    "tv_symbol": row["tv_symbol"], "list_name": table, "timeframe": frame,
                    "direction": dr, "strength": "STRONG" if t["C"] else "WEAK",
                    "trig_supertrend": int(t["A"]), "trig_ema": int(t["B"]), "trig_rsi": int(t["C"]),
                    "zone_level": row["zone_level"], "status": row["status"],
                    "bars_in_zone": row["bars_in_zone"], "bars_since_exit": row["bars_since_exit"],
                    "wt1": row["wt1"], "rsi": t["rsi"], "close": row["close"],
                })
    DB.insert_signals(con, out)
    return out


# ================================================================== Çıktı
def report(market: str, tf: str, signals: list[dict], cfg):
    os.makedirs(cfg["output_dir"], exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d")
    if not signals:
        log.info("  [%s/%s] kırılım sinyali yok", market, tf)
        return
    df = pd.DataFrame(signals)
    df["triggers"] = (df["trig_supertrend"].map({1: "ST ", 0: ""}) +
                      df["trig_ema"].map({1: "EMA ", 0: ""}) +
                      df["trig_rsi"].map({1: "RSI", 0: ""})).str.strip()
    df = df.sort_values(["strength", "list_name", "zone_level"], ascending=[True, True, False])
    cols = ["symbol", "list_name", "direction", "strength", "triggers", "zone_level",
            "status", "bars_in_zone", "bars_since_exit", "wt1", "rsi", "close"]
    print(f"\n=== {market.upper()} / {tf} — {len(df)} sinyal "
          f"({(df.strength == 'STRONG').sum()} güçlü) ===")
    print(df[cols].to_string(index=False))
    base = os.path.join(cfg["output_dir"], f"{market}_{tf}_{stamp}")
    df[cols + ["tv_symbol", "bar_date"]].to_csv(base + "_signals.csv", index=False)
    # TradingView watchlist: ### başlıkları TV'de bölüm olarak görünür
    with open(base + "_tradingview.txt", "w") as f:
        for (lst, strength), g in df.groupby(["list_name", "strength"]):
            f.write(f"###{lst}_{strength},")
            f.write(",".join(g["tv_symbol"]) + ",\n")
    log.info("  yazıldı: %s_signals.csv / _tradingview.txt", base)


def export_watchlists(con, market: str, cfg):
    stamp = datetime.now().strftime("%Y%m%d")
    path = os.path.join(cfg["output_dir"], f"{market}_watchlists_{stamp}_tradingview.txt")
    os.makedirs(cfg["output_dir"], exist_ok=True)
    with open(path, "w") as f:
        for t in DB.LISTS:
            rows = DB.read_watchlist(con, t)
            if rows:
                f.write(f"###{t}," + ",".join(r["tv_symbol"] for r in rows) + ",\n")


def telegram(cfg, text: str):
    tg = cfg.get("telegram", {})
    if not tg.get("enabled") or not tg.get("token"):
        return
    try:
        requests.post(f"https://api.telegram.org/bot{tg['token']}/sendMessage",
                      data={"chat_id": tg["chat_id"], "text": text[:4000]}, timeout=15)
    except Exception as e:
        log.warning("Telegram gönderilemedi: %s", e)


# ================================================================== main
FETCHERS = {"us": D.fetch_us, "crypto": D.fetch_crypto, "bist": D.fetch_bist}


def run_market(market, tfs, stage, cfg, demo):
    con = DB.connect(cfg["db_dir"], market)
    mcfg = cfg["markets"][market]
    log.info("━━ %s ━━", market.upper())
    if demo:
        universe = D.fetch_demo(market)
    elif stage == "2":  # sadece watchlist sembollerini indir
        syms = sorted({r["symbol"] for t in DB.LISTS for r in DB.read_watchlist(con, t)})
        if not syms:
            log.warning("  watchlist boş — önce --stage 1 çalıştır")
            return
        universe = FETCHERS[market](mcfg, syms)
    else:
        universe = FETCHERS[market](mcfg)
    msg = []
    for tf in tfs:
        if stage in ("1", "both"):
            log.info(" Aşama 1 (%s)", tf)
            lists = stage1(con, universe, tf, cfg)
        else:
            h = TF_MAP[tf][0]
            lists = {f"{h}_{s}": DB.read_watchlist(con, f"{h}_{s}") for s in ("oversold", "overbought")}
        X.export_market_tf(market, tf, universe, lists, cfg)
        if stage in ("2", "both"):
            log.info(" Aşama 2 (%s)", tf)
            sigs = stage2(con, universe, tf, cfg)
            report(market, tf, sigs, cfg)
            strong = [s for s in sigs if s["strength"] == "STRONG"]
            if strong:
                msg.append(f"{market.upper()} {tf}: " + ", ".join(
                    f"{s['symbol']}({s['direction']})" for s in strong))
    export_watchlists(con, market, cfg)
    if msg:
        telegram(cfg, "\n".join(msg))
    con.close()


def main():
    ap = argparse.ArgumentParser(description="WaveTrend bölge + kırılım tarayıcı")
    ap.add_argument("--market", default="us", choices=["us", "crypto", "bist", "all"])
    ap.add_argument("--tf", default="both", choices=["daily", "weekly", "both"])
    ap.add_argument("--stage", default="both", choices=["1", "2", "both"])
    ap.add_argument("--config", default="config.yaml")
    ap.add_argument("--demo", action="store_true", help="internetsiz sentetik veri ile test")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with open(a.config) as f:
        cfg = yaml.safe_load(f)
    # WaveTrend parametreleri: wt_params.json (uygulamadan düzenlenir) > config.yaml
    if os.path.exists("wt_params.json"):
        with open("wt_params.json") as f:
            cfg["wavetrend"].update(json.load(f))
    log.info("WaveTrend: %s", cfg["wavetrend"])
    # Telegram bilgileri GitHub Secrets'tan gelebilir
    if os.environ.get("TELEGRAM_TOKEN"):
        cfg["telegram"] = {"enabled": True, "token": os.environ["TELEGRAM_TOKEN"],
                           "chat_id": os.environ.get("TELEGRAM_CHAT_ID", "")}
    if a.demo:
        cfg["db_dir"], cfg["output_dir"], cfg["data_dir"] = "state_demo/db", "state_demo/output", "state_demo/data"
    os.makedirs(cfg["data_dir"], exist_ok=True)
    markets = ["us", "crypto", "bist"] if a.market == "all" else [a.market]
    tfs = ["daily", "weekly"] if a.tf == "both" else [a.tf]
    failed = 0
    for m in markets:
        if not cfg["markets"][m].get("enabled", True):
            continue
        try:
            run_market(m, tfs, a.stage, cfg, a.demo)
        except Exception as e:
            failed += 1
            log.exception("%s taraması başarısız: %s", m, e)
    if failed and failed == len(markets):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
