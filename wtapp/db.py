"""SQLite katmanı. Her piyasa için ayrı DB, her DB'de 4 watchlist tablosu + signals."""
import os
import sqlite3

LISTS = ["short_oversold", "short_overbought", "long_oversold", "long_overbought",
         "intraday_oversold", "intraday_overbought"]

WATCHLIST_SCHEMA = """
CREATE TABLE IF NOT EXISTS {t} (
    symbol          TEXT PRIMARY KEY,
    tv_symbol       TEXT,
    timeframe       TEXT,
    zone_level      TEXT,     -- OS1/OS2/OB1/OB2 (o bölge ziyaretinde ulaşılan en derin seviye)
    current_level   TEXT,     -- son bardaki seviye (bölge dışındaysa NONE)
    wt1             REAL,
    wt2             REAL,
    peak_wt1        REAL,     -- bölge ziyaretindeki en uç WT1
    close           REAL,
    first_seen_date TEXT,     -- bu bölge ziyaretinin başladığı bar
    last_seen_date  TEXT,     -- bölgede görülen son bar
    bar_date        TEXT,     -- taranan son kapanmış bar
    bars_in_zone    INTEGER,
    bars_since_exit INTEGER,  -- 0 = hâlâ bölgede
    status          TEXT,     -- active / exited
    updated_at      TEXT
);
"""

SIGNALS_SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_time    TEXT,
    bar_date     TEXT,
    symbol       TEXT,
    tv_symbol    TEXT,
    list_name    TEXT,
    timeframe    TEXT,
    direction    TEXT,     -- BULL / BEAR
    strength     TEXT,     -- STRONG / WEAK
    trig_supertrend INTEGER,
    trig_ema     INTEGER,
    trig_rsi     INTEGER,
    trig_wtx     INTEGER,
    zone_level   TEXT,
    status       TEXT,
    bars_in_zone INTEGER,
    bars_since_exit INTEGER,
    wt1          REAL,
    rsi          REAL,
    close        REAL,
    UNIQUE(bar_date, symbol, list_name, direction)
);
"""


def connect(db_dir: str, market: str) -> sqlite3.Connection:
    os.makedirs(db_dir, exist_ok=True)
    con = sqlite3.connect(os.path.join(db_dir, f"{market}.db"))
    con.row_factory = sqlite3.Row
    for t in LISTS:
        con.execute(WATCHLIST_SCHEMA.format(t=t))
    con.execute(SIGNALS_SCHEMA)
    cols = {r[1] for r in con.execute("PRAGMA table_info(signals)")}
    if "trig_wtx" not in cols:  # önceki sürümden kalan veritabanı
        con.execute("ALTER TABLE signals ADD COLUMN trig_wtx INTEGER")
    con.commit()
    return con


def replace_watchlist(con, table: str, rows: list[dict]):
    """Watchlist'i tamamen yeniden yazar (geçmişten deterministik hesaplandığı için güvenli)."""
    con.execute(f"DELETE FROM {table}")
    if rows:
        cols = list(rows[0].keys())
        con.executemany(
            f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
            [tuple(r[c] for c in cols) for r in rows],
        )
    con.commit()


def read_watchlist(con, table: str) -> list[dict]:
    return [dict(r) for r in con.execute(f"SELECT * FROM {table}")]


def insert_signals(con, rows: list[dict]):
    if not rows:
        return
    cols = list(rows[0].keys())
    con.executemany(
        f"INSERT OR REPLACE INTO signals ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
        [tuple(r[c] for c in cols) for r in rows],
    )
    con.commit()
