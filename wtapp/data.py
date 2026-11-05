"""Veri katmanı. Her sağlayıcı sadece KAPANMIŞ barları döndürür.

Dönüş formatı: {symbol: {"tv": "NASDAQ:AAPL", "daily": df, "weekly": df}}
df kolonları: open, high, low, close, volume  (index = tarih)
"""
import io
import logging
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

log = logging.getLogger("wtscanner")
OHLCV = ["open", "high", "low", "close", "volume"]


# ------------------------------------------------------------------ yardımcılar
def _completed_daily(df: pd.DataFrame, tz: str, close_time: str) -> pd.DataFrame:
    """Bugünün barı henüz kapanmadıysa at."""
    if df.empty:
        return df
    now = datetime.now(ZoneInfo(tz))
    hh, mm = map(int, close_time.split(":"))
    close_dt = now.replace(hour=hh, minute=mm, second=0, microsecond=0) + timedelta(minutes=15)
    last = pd.Timestamp(df.index[-1]).date()
    if last >= now.date() and now < close_dt:
        df = df.iloc[:-1]
    return df


def _weekly_from_daily(df: pd.DataFrame, tz: str) -> pd.DataFrame:
    """Günlükten W-FRI haftalık bar. Bitmemiş haftayı at."""
    if df.empty:
        return df
    w = df.resample("W-FRI").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    ).dropna(subset=["close"])
    today = datetime.now(ZoneInfo(tz)).date()
    last_daily = pd.Timestamp(df.index[-1]).date()
    label = pd.Timestamp(w.index[-1]).date()
    # Hafta etiketi (Cuma) gelecekteyse veya bugün Cuma ama günlük bar henüz kapanmadıysa → bitmemiş
    if label > today or (label == today and last_daily < today):
        w = w.iloc[:-1]
    return w


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df[OHLCV].dropna(subset=["close"])
    df = df[df["close"] > 0]
    df.index = pd.to_datetime(df.index).tz_localize(None)
    return df


# ------------------------------------------------------------------ yfinance (US + BIST)
def _yf_download(tickers: list[str], period: str, chunk: int) -> dict[str, pd.DataFrame]:
    import yfinance as yf
    out = {}
    for i in range(0, len(tickers), chunk):
        part = tickers[i:i + chunk]
        for attempt in range(3):
            try:
                raw = yf.download(part, period=period, interval="1d", group_by="ticker",
                                  auto_adjust=False, threads=True, progress=False)
                break
            except Exception as e:  # ağ hatası → tekrar dene
                log.warning("yfinance hata (%s), tekrar deneniyor: %s", attempt + 1, e)
                time.sleep(3 * (attempt + 1))
        else:
            continue
        for t in part:
            try:
                df = raw[t] if isinstance(raw.columns, pd.MultiIndex) else raw
                df = df.rename(columns=str.lower)
                df = _clean(df)
                if len(df) >= 60:
                    out[t] = df
            except KeyError:
                pass
        log.info("  indirildi %d/%d", min(i + chunk, len(tickers)), len(tickers))
        time.sleep(1)
    missing = len(tickers) - len(out)
    if missing:
        log.info("  %d sembol için veri yok/eksik, atlandı", missing)
    return out


def us_universe(cfg) -> list[tuple[str, str]]:
    """NASDAQ Trader sembol dizininden (yf_symbol, tv_symbol) listesi."""
    base = "https://www.nasdaqtrader.com/dynamic/SymDir/"
    syms = []
    bad_words = ("warrant", "right", " unit", "preferred", "depositary", "notes", "% ")
    nas = pd.read_csv(io.StringIO(requests.get(base + "nasdaqlisted.txt", timeout=30).text), sep="|")
    nas = nas[(nas["Test Issue"] == "N") & (nas["ETF"] == "N")]
    for s, name in zip(nas["Symbol"], nas["Security Name"]):
        if isinstance(s, str) and s.isalpha() and not any(w in str(name).lower() for w in bad_words):
            syms.append((s, f"NASDAQ:{s}", "NASDAQ"))
    oth = pd.read_csv(io.StringIO(requests.get(base + "otherlisted.txt", timeout=30).text), sep="|")
    oth = oth[(oth["Test Issue"] == "N") & (oth["ETF"] == "N")]
    exmap = {"N": "NYSE", "A": "AMEX"}
    for s, name, ex in zip(oth["ACT Symbol"], oth["Security Name"], oth["Exchange"]):
        if ex not in exmap or not isinstance(s, str):
            continue
        if any(w in str(name).lower() for w in bad_words):
            continue
        clean = s.replace(".", "")
        if not clean.isalpha():
            continue
        syms.append((s.replace(".", "-"), f"{exmap[ex]}:{s}", exmap[ex]))
    allowed = set(cfg.get("exchanges", ["NASDAQ", "NYSE", "AMEX"]))
    return [(y, tv) for y, tv, ex in syms if ex in allowed]


def fetch_us(cfg, symbols: list[str] | None = None) -> dict:
    uni = us_universe(cfg)
    if symbols is not None:
        keep = set(symbols)
        uni = [u for u in uni if u[0] in keep]
    log.info("US evreni: %d sembol", len(uni))
    tvmap = dict(uni)
    raw = _yf_download([u[0] for u in uni], cfg["history"], cfg["chunk_size"])
    out = {}
    for s, df in raw.items():
        df = _completed_daily(df, cfg["timezone"], cfg["close_time"])
        if symbols is None:  # likidite filtresi sadece tam taramada
            if df["close"].iloc[-1] < cfg["min_price"]:
                continue
            if df["volume"].tail(20).mean() < cfg["min_avg_volume"]:
                continue
        out[s] = {"tv": tvmap[s], "daily": df, "weekly": _weekly_from_daily(df, cfg["timezone"])}
    log.info("US filtre sonrası: %d sembol", len(out))
    return out


def fetch_bist(cfg, symbols: list[str] | None = None) -> dict:
    with open(cfg["symbols_file"]) as f:
        tickers = sorted({l.strip().upper() for l in f if l.strip() and not l.startswith("#")})
    if symbols is not None:
        tickers = [t for t in tickers if t in set(symbols)]
    log.info("BIST evreni: %d sembol", len(tickers))
    raw = _yf_download([t + ".IS" for t in tickers], cfg["history"], cfg["chunk_size"])
    out = {}
    for yt, df in raw.items():
        s = yt[:-3]
        df = _completed_daily(df, cfg["timezone"], cfg["close_time"])
        if cfg.get("min_avg_volume", 0) and df["volume"].tail(20).mean() < cfg["min_avg_volume"]:
            continue
        out[s] = {"tv": f"BIST:{s}", "daily": df, "weekly": _weekly_from_daily(df, cfg["timezone"])}
    return out


# ------------------------------------------------------------------ ccxt (kripto)
def _ccxt_closed(ex, sym, tf, limit, period_ms):
    rows = ex.fetch_ohlcv(sym, tf, limit=limit)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows, columns=["ts"] + OHLCV)
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    df = df[df["ts"] + period_ms <= now_ms]  # açık mumu at
    df.index = pd.to_datetime(df["ts"], unit="ms")
    return df[OHLCV]


def fetch_crypto(cfg, symbols: list[str] | None = None) -> dict:
    import ccxt
    last_err = None
    for exc in cfg["exchanges"]:
        try:
            ex = getattr(ccxt, exc["id"])({"enableRateLimit": True})
            ex.load_markets()
            quote = exc["quote"]
            if symbols is None:
                tickers = ex.fetch_tickers()
                cands = []
                for m in ex.markets.values():
                    if not (m.get("spot") and m.get("active", True) and m["quote"] == quote):
                        continue
                    base = m["base"]
                    if base in cfg["exclude_bases"] or base.endswith(("UP", "DOWN", "BULL", "BEAR")):
                        continue
                    t = tickers.get(m["symbol"], {})
                    qv = t.get("quoteVolume") or ((t.get("baseVolume") or 0) * (t.get("last") or 0))
                    cands.append((qv or 0, m["symbol"]))
                cands.sort(reverse=True)
                pairs = [s for _, s in cands[: cfg["top_n"]]]
            else:
                pairs = [s for s in symbols if s in ex.markets]
            log.info("Kripto: %s üzerinden %d parite", exc["id"], len(pairs))
            out = {}
            for i, p in enumerate(pairs, 1):
                try:
                    d = _ccxt_closed(ex, p, "1d", 500, 86_400_000)
                    w = _ccxt_closed(ex, p, "1w", 300, 7 * 86_400_000)
                    if len(d) >= 60:
                        out[p] = {"tv": f"{exc['tv_prefix']}:{p.replace('/', '')}", "daily": d, "weekly": w}
                except Exception as e:
                    log.debug("  %s atlandı: %s", p, e)
                if i % 25 == 0:
                    log.info("  indirildi %d/%d", i, len(pairs))
            return out
        except Exception as e:
            last_err = e
            log.warning("Kripto borsası %s kullanılamadı (%s), sıradaki deneniyor", exc["id"], e)
    raise RuntimeError(f"Hiçbir kripto borsasına erişilemedi: {last_err}")


# ------------------------------------------------------------------ demo (sentetik)
def fetch_demo(market: str, n_symbols=150, seed=42) -> dict:
    """İnternet gerektirmeyen rastgele-yürüyüş verisi (sistemi test etmek için)."""
    rng = np.random.default_rng(seed + sum(map(ord, market)))
    end = pd.Timestamp.today().normalize() - pd.Timedelta(days=1)
    idx = pd.bdate_range(end=end, periods=750)
    out = {}
    prefix = {"us": "NASDAQ", "bist": "BIST", "crypto": "BINANCE"}[market]
    for k in range(n_symbols):
        vol = rng.uniform(0.01, 0.04)
        drift = rng.normal(0, 0.0008)
        # rejimler: arada sert trendler ekle ki bölgeler oluşsun
        rets = rng.normal(drift, vol, len(idx))
        for _ in range(4):
            a = rng.integers(0, len(idx) - 40)
            rets[a:a + rng.integers(10, 40)] += rng.choice([-1, 1]) * vol * 0.6
        close = 50 * np.exp(np.cumsum(rets))
        high = close * (1 + np.abs(rng.normal(0, vol / 2, len(idx))))
        low = close * (1 - np.abs(rng.normal(0, vol / 2, len(idx))))
        opn = np.r_[close[0], close[:-1]]
        df = pd.DataFrame({"open": opn, "high": np.maximum(high, np.maximum(opn, close)),
                           "low": np.minimum(low, np.minimum(opn, close)), "close": close,
                           "volume": rng.integers(5e5, 5e6, len(idx))}, index=idx)
        sym = f"DEMO{k:03d}"
        w = df.resample("W-FRI").agg({"open": "first", "high": "max", "low": "min",
                                      "close": "last", "volume": "sum"}).dropna()
        out[sym] = {"tv": f"{prefix}:{sym}", "daily": df, "weekly": w}
    return out
