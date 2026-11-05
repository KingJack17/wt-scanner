"""Göstergeler: WaveTrend, Supertrend, EMA, RSI (pandas ile, harici kütüphane yok)."""
import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def wavetrend(df: pd.DataFrame, n1=10, n2=21, signal=4):
    """LazyBear WaveTrend. TradingView ile aynı formül."""
    ap = (df["high"] + df["low"] + df["close"]) / 3.0
    esa = ema(ap, n1)
    d = ema((ap - esa).abs(), n1)
    ci = (ap - esa) / (0.015 * d.replace(0, np.nan))
    wt1 = ema(ci.fillna(0), n2)
    wt2 = wt1.rolling(signal).mean()
    return wt1, wt2


def rsi(close: pd.Series, n=14) -> pd.Series:
    """Wilder RSI (TradingView ta.rsi ile aynı)."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(avg_loss != 0, 100.0)


def atr(df: pd.DataFrame, n=10) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()  # RMA


def supertrend(df: pd.DataFrame, n=10, mult=3.0):
    """Supertrend. Döner: (line, direction) direction: 1 = yükseliş, -1 = düşüş."""
    a = atr(df, n).values
    hl2 = ((df["high"] + df["low"]) / 2).values
    close = df["close"].values
    up = hl2 - mult * a
    dn = hl2 + mult * a
    L = len(df)
    final_up = np.full(L, np.nan)
    final_dn = np.full(L, np.nan)
    direction = np.zeros(L, dtype=int)
    line = np.full(L, np.nan)
    for i in range(L):
        if np.isnan(a[i]):
            continue
        if i == 0 or np.isnan(final_up[i - 1]):
            final_up[i], final_dn[i], direction[i] = up[i], dn[i], 1
        else:
            final_up[i] = max(up[i], final_up[i - 1]) if close[i - 1] > final_up[i - 1] else up[i]
            final_dn[i] = min(dn[i], final_dn[i - 1]) if close[i - 1] < final_dn[i - 1] else dn[i]
            if direction[i - 1] == -1 and close[i] > final_dn[i - 1]:
                direction[i] = 1
            elif direction[i - 1] == 1 and close[i] < final_up[i - 1]:
                direction[i] = -1
            else:
                direction[i] = direction[i - 1]
        line[i] = final_up[i] if direction[i] == 1 else final_dn[i]
    return pd.Series(line, index=df.index), pd.Series(direction, index=df.index)


def crossed_above(a: pd.Series, b, lookback: int) -> bool:
    """Son `lookback` bar içinde a, b'yi yukarı kesti mi?"""
    b = b if isinstance(b, pd.Series) else pd.Series(b, index=a.index)
    above = a > b
    cross = above & ~above.shift(1, fill_value=True)
    return bool(cross.iloc[-lookback:].any())


def crossed_below(a: pd.Series, b, lookback: int) -> bool:
    b = b if isinstance(b, pd.Series) else pd.Series(b, index=a.index)
    below = a < b
    cross = below & ~below.shift(1, fill_value=True)
    return bool(cross.iloc[-lookback:].any())
