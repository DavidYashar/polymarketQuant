"""Read-only access to the local Hyperliquid warehouse Postgres database.

The HL bot writes 1h candles, 1h funding, and per-scan OI snapshots into:
    candles_1h(coin, ts, o, h, l, c, v)              -- ts = unix ms
    funding_1h(coin, ts, funding_rate, premium)      -- ts = unix ms
    oi_snapshot(coin, ts, oi, mark_px, day_ntl_vlm, funding_rate)

For calibration we only need candles_1h (resolution ground truth) and
funding_1h / oi_snapshot (signal inputs).
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor


def _conn_kwargs() -> dict:
    return {
        "host": os.environ.get("PG_HOST", "127.0.0.1"),
        "port": int(os.environ.get("PG_PORT", "5432")),
        "dbname": os.environ.get("PG_DB", "hl_warehouse"),
        "user": os.environ.get("PG_USER", "postgres"),
        "password": os.environ.get("PG_PASSWORD", "postgres"),
    }


@contextmanager
def connect() -> Iterator[psycopg2.extensions.connection]:
    conn = psycopg2.connect(**_conn_kwargs())
    try:
        yield conn
    finally:
        conn.close()


def load_candles_1h(coin: str, *, start_ms: int, end_ms: int) -> pd.DataFrame:
    """Load 1h OHLCV for `coin` between [start_ms, end_ms) inclusive on left.

    Returns DataFrame indexed by ts (UTC), columns o,h,l,c,v.
    """
    sql = """
        SELECT ts, o, h, l, c, v
        FROM candles_1h
        WHERE coin = %s AND ts >= %s AND ts < %s
        ORDER BY ts ASC
    """
    with connect() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (coin, start_ms, end_ms))
        rows = cur.fetchall()
    if not rows:
        return pd.DataFrame(columns=["o", "h", "l", "c", "v"])
    df = pd.DataFrame(rows)
    df.index = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df.index.name = "ts_utc"
    return df[["o", "h", "l", "c", "v"]].astype(float)


def load_funding_1h(coin: str, *, start_ms: int, end_ms: int) -> pd.DataFrame:
    sql = """
        SELECT ts, funding_rate, premium
        FROM funding_1h
        WHERE coin = %s AND ts >= %s AND ts < %s
        ORDER BY ts ASC
    """
    with connect() as conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (coin, start_ms, end_ms))
        rows = cur.fetchall()
    if not rows:
        return pd.DataFrame(columns=["funding_rate", "premium"])
    df = pd.DataFrame(rows)
    df.index = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df.index.name = "ts_utc"
    return df[["funding_rate", "premium"]].astype(float)


def warehouse_status() -> dict:
    """Quick health-check: row counts + min/max ts per table."""
    out: dict = {}
    with connect() as conn, conn.cursor() as cur:
        for table in ("candles_1h", "funding_1h", "oi_snapshot"):
            cur.execute(f"SELECT count(*), min(ts), max(ts) FROM {table}")
            n, mn, mx = cur.fetchone()
            out[table] = {"rows": int(n or 0), "min_ts_ms": mn, "max_ts_ms": mx}
    return out


__all__ = ["connect", "load_candles_1h", "load_funding_1h", "warehouse_status"]
