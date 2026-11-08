"""Web uygulaması için JSON çıktısı.

state/data/meta.json                     → genel bilgi (tarama zamanı, WT parametreleri, varsayılanlar)
state/data/{market}_{tf}.json            → 2 liste + listedeki her sembol için son N bar (kırılım hesabı)
state/data/bars/{market}_{tf}/{SYM}.json → grafik için uzun geçmiş
"""
import json
import os
import re
import shutil
from datetime import datetime, timezone

import pandas as pd

EPOCH = pd.Timestamp("1970-01-01")


def _safe(sym: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", sym)


def _r(x: float) -> float:
    """4-5 anlamlı basamak: dosya boyutunu küçük tutar."""
    if x == 0 or pd.isna(x):
        return 0
    a = abs(x)
    nd = 3 if a >= 100 else 4 if a >= 10 else 5 if a >= 1 else 7 if a >= 0.01 else 10
    return round(float(x), nd)


def _pack(df: pd.DataFrame, n: int, intraday: bool = False) -> dict:
    df = df.tail(n)
    idx = pd.to_datetime(df.index)
    if intraday:  # New York duvar saati, saniye (grafik saatleri ET gösterir)
        t = ((idx - EPOCH).total_seconds()).astype("int64").tolist()
    else:
        t = ((idx - EPOCH).days).astype(int).tolist()
    out = {
        "t": t,
        "o": [_r(v) for v in df["open"]],
        "h": [_r(v) for v in df["high"]],
        "l": [_r(v) for v in df["low"]],
        "c": [_r(v) for v in df["close"]],
    }
    if intraday:
        out["u"] = "s"
    return out


SHORT_KEYS = {  # satırları kısaltılmış anahtarlarla yaz
    "symbol": "s", "tv_symbol": "tv", "zone_level": "zl", "current_level": "cl", "wt1": "w1",
    "wt2": "w2", "peak_wt1": "pk", "close": "c", "first_seen_date": "fs", "last_seen_date": "ls",
    "bar_date": "bd", "bars_in_zone": "biz", "bars_since_exit": "bse", "status": "st",
}


FRAMES = {"daily": ("daily", "short"), "weekly": ("weekly", "long"), "4h": ("h4", "intraday")}


def export_market_tf(market: str, tf: str, universe: dict, lists: dict, cfg: dict,
                     watch=([], []), live: bool = False):
    frame, horizon = FRAMES[tf]
    intra = tf == "4h"
    ddir = cfg["data_dir"]
    ex = cfg.get("export", {})
    nc, nchart = ex.get("compact_bars", 150), ex.get("chart_bars", 400)
    bars_dir = os.path.join(ddir, "bars", f"{market}_{tf}")
    shutil.rmtree(bars_dir, ignore_errors=True)
    os.makedirs(bars_dir, exist_ok=True)

    out_lists, bars, syms = {}, {}, set()
    bar_date = None
    for side in ("oversold", "overbought"):
        rows = lists.get(f"{horizon}_{side}", [])
        out_lists[side] = [{SHORT_KEYS[k]: v for k, v in r.items() if k in SHORT_KEYS} for r in rows]
        for r in rows:
            syms.add(r["symbol"])
            bar_date = max(bar_date or r["bar_date"], r["bar_date"])
    wfound, wmissing = watch
    out_lists["watch"] = [{"s": s, "tv": universe[s]["tv"], "c": _r(float(universe[s][frame]["close"].iloc[-1]))}
                          for s in wfound if universe.get(s, {}).get(frame) is not None and len(universe[s][frame])]
    syms |= {r["s"] for r in out_lists["watch"]}
    for s in syms:
        df = universe[s][frame]
        bars[s] = _pack(df, nc, intra)
        with open(os.path.join(bars_dir, _safe(s) + ".json"), "w") as f:
            json.dump(_pack(df, nchart, intra), f, separators=(",", ":"))

    payload = {
        "market": market, "tf": tf, "bar_date": bar_date,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe_size": len(universe), "wt": cfg["wavetrend"],
        "lists": out_lists, "bars": bars, "watch_missing": wmissing, "live": bool(live),
    }
    with open(os.path.join(ddir, f"{market}_{tf}.json"), "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    _update_meta(market, tf, payload, cfg)


def _update_meta(market, tf, payload, cfg):
    path = os.path.join(cfg["data_dir"], "meta.json")
    try:
        with open(path) as f:
            meta = json.load(f)
    except Exception:
        meta = {"markets": {}}
    meta["wt"] = cfg["wavetrend"]
    meta["breakout_defaults"] = cfg["breakout"]
    meta["updated"] = payload["generated"]
    m = meta["markets"].setdefault(market, {})
    m[tf] = {
        "generated": payload["generated"], "bar_date": payload["bar_date"],
        "universe_size": payload["universe_size"],
        "oversold": len(payload["lists"]["oversold"]),
        "overbought": len(payload["lists"]["overbought"]), "live": payload["live"],
    }
    try:
        with open("my_symbols.json") as f:
            meta["watch"] = json.load(f)
    except Exception:
        meta.setdefault("watch", {})
    with open(path, "w") as f:
        json.dump(meta, f, indent=1)
