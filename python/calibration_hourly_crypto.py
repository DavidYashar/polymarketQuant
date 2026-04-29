"""End-to-end calibration study for hourly crypto markets on Polymarket.

What this script does
---------------------
For each (coin, past hour) in the calibration window:

  1. Resolve the Polymarket "X up or down at HH ET" market (Gamma API).
  2. Fetch the YES-Up token's price 5 minutes BEFORE the resolution top-of-hour
     (CLOB /prices-history with fidelity=5).
  3. Compute our own model's directional score using HL warehouse 1h candles
     up to (but not including) the resolution hour.
  4. Resolve the outcome from the HL warehouse: did the 1h bar close >= open?
  5. Record (p_market, p_model, outcome).

Then it prints / writes:
  - Calibration table: bucketed p_model -> empirical hit rate.
  - Edge table:        bucketed (p_model - p_market) -> empirical hit rate
                       and simulated round-trip PnL after Polymarket Crypto
                       fees (0.072 * p * (1-p)) and a configurable spread.
  - A simple "trade-when-edge>theta" backtest sweep.

This script is READ-ONLY. No orders, no signing, no money at risk.
It is safe to run alongside the live HL bot on the same laptop -- the only
external write is the markdown report file.

Usage
-----
    cd polymarketBot/python
    python -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env  # then edit if needed
    python calibration_hourly_crypto.py --days 14

By default it studies the last 14 days. Use --days N for a different window.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from dotenv import load_dotenv

# Local modules
from polymarket_client import (
    GammaClient,
    ClobClient,
    COIN_SLUG_NAMES,
    hourly_slug,
)
from hl_warehouse import load_candles_1h, load_funding_1h, warehouse_status
from signals import (
    compute_signal_at,
    resolve_outcome,
    crypto_taker_fee,
    CRYPTO_FEE_RATE,
)

ET = ZoneInfo("America/New_York")
UTC = timezone.utc

# Default cost assumptions for the simulated PnL.
DEFAULT_SPREAD_USD = 0.02   # 2 cents bid-ask -> 1 cent of slippage per side
DEFAULT_TRADE_SHARES = 50.0 # $25 stake at p=0.5 -> 50 shares


@dataclass
class Sample:
    coin: str
    hour_start_utc: pd.Timestamp
    slug: str
    p_market_up: float
    p_model_up: float
    score: float
    outcome_up: int
    minutes_to_resolution: int
    fee_at_p_market: float
    notes: str = ""


# -----------------------------------------------------------------------------
# Step 1: enumerate the (coin, hour) pairs we want to calibrate.
# -----------------------------------------------------------------------------

def enumerate_target_hours(days_back: int, end_utc: datetime) -> list[tuple[str, datetime]]:
    """Return list of (coin, hour_start_utc) for every coin and every fully
    closed hour in the [end_utc - days_back, end_utc) window.
    """
    coins = [c.strip().upper() for c in os.environ.get("CALIB_COINS", "BTC,ETH,SOL,XRP").split(",") if c.strip()]
    start_utc = end_utc - timedelta(days=days_back)
    # Round both to top of hour
    start_utc = start_utc.replace(minute=0, second=0, microsecond=0)
    end_utc = end_utc.replace(minute=0, second=0, microsecond=0)
    out: list[tuple[str, datetime]] = []
    cur = start_utc
    while cur < end_utc:
        for coin in coins:
            out.append((coin, cur))
        cur += timedelta(hours=1)
    return out


# -----------------------------------------------------------------------------
# Step 2: resolve a Polymarket market for a (coin, ET hour).
# -----------------------------------------------------------------------------

def resolve_market(gamma: GammaClient, coin: str, hour_start_utc: datetime) -> Optional[dict]:
    """Look up the Polymarket event by deterministic slug. Returns the event
    dict, or None if the market doesn't exist (e.g. coin wasn't tradeable
    that hour).
    """
    et = hour_start_utc.astimezone(ET)
    slug = hourly_slug(coin, et.year, et.month, et.day, et.hour)
    return gamma.get_event_by_slug(slug)


def extract_up_token_id(event: dict) -> Optional[str]:
    """The event has nested `markets`; the binary market has `clobTokenIds`
    as a JSON-encoded list of two ids: [up_id, down_id].
    """
    markets = event.get("markets") or []
    if not markets:
        return None
    market = markets[0]
    raw = market.get("clobTokenIds")
    if not raw:
        return None
    try:
        ids = json.loads(raw) if isinstance(raw, str) else raw
        if isinstance(ids, list) and len(ids) >= 1:
            return str(ids[0])
    except (json.JSONDecodeError, TypeError):
        return None
    return None


# -----------------------------------------------------------------------------
# Step 3: fetch market price near the decision instant (T-5 minutes).
# -----------------------------------------------------------------------------

def fetch_market_price(clob: ClobClient, token_id: str, decision_ts_utc: datetime) -> Optional[float]:
    """Get the price closest to `decision_ts_utc - 5 minutes` from the
    token's history. We pull a 30-minute window so we have a buffer.
    """
    target = decision_ts_utc - timedelta(minutes=5)
    start = int((target - timedelta(minutes=30)).timestamp())
    end = int((target + timedelta(minutes=5)).timestamp())
    history = clob.prices_history(token_id, start_ts=start, end_ts=end, interval="1h", fidelity=5)
    if not history:
        return None
    target_unix = int(target.timestamp())
    closest = min(history, key=lambda pt: abs(int(pt.get("t", 0)) - target_unix))
    p = closest.get("p")
    try:
        return float(p)
    except (TypeError, ValueError):
        return None


# -----------------------------------------------------------------------------
# Step 4-5 wrapped in the main loop.
# -----------------------------------------------------------------------------

def run_calibration(days_back: int) -> tuple[list[Sample], dict]:
    load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

    end_utc = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    targets = enumerate_target_hours(days_back, end_utc)

    coins = sorted({c for c, _ in targets})
    print(f"[calib] window: {(end_utc - timedelta(days=days_back)).isoformat()} -> {end_utc.isoformat()}")
    print(f"[calib] coins:  {coins}")
    print(f"[calib] hours:  {len(targets) // max(1, len(coins))} per coin -> {len(targets)} total samples")

    # Warehouse health check up front -- bail loudly if it's empty.
    try:
        wh = warehouse_status()
    except Exception as exc:
        print(f"[calib] FATAL: cannot reach Postgres warehouse: {exc}", file=sys.stderr)
        sys.exit(2)
    print(f"[calib] warehouse status:")
    for tbl, info in wh.items():
        print(f"        {tbl}: rows={info['rows']:,}  ts=[{info['min_ts_ms']}, {info['max_ts_ms']}]")

    # Preload candle history per coin (28 days back from window start) for indicator warmup.
    history_start = end_utc - timedelta(days=days_back + 14)
    history_end = end_utc + timedelta(hours=1)
    candles_by_coin: dict[str, pd.DataFrame] = {}
    funding_by_coin: dict[str, pd.DataFrame] = {}
    for coin in coins:
        candles_by_coin[coin] = load_candles_1h(coin, start_ms=int(history_start.timestamp() * 1000),
                                                 end_ms=int(history_end.timestamp() * 1000))
        funding_by_coin[coin] = load_funding_1h(coin, start_ms=int(history_start.timestamp() * 1000),
                                                 end_ms=int(history_end.timestamp() * 1000))
        print(f"[calib] preloaded {coin}: candles={len(candles_by_coin[coin])} funding={len(funding_by_coin[coin])}")

    gamma = GammaClient(os.environ.get("POLY_GAMMA_HOST", "https://gamma-api.polymarket.com"))
    clob = ClobClient(os.environ.get("POLY_CLOB_HOST", "https://clob.polymarket.com"))

    samples: list[Sample] = []
    misses = {"no_market": 0, "no_token": 0, "no_price": 0, "no_signal": 0, "no_outcome": 0}

    last_log = time.time()
    for i, (coin, hour_start_utc) in enumerate(targets):
        if time.time() - last_log > 5.0:
            print(f"[calib] progress {i}/{len(targets)}  kept={len(samples)}  misses={misses}")
            last_log = time.time()

        event = resolve_market(gamma, coin, hour_start_utc)
        if not event:
            misses["no_market"] += 1
            continue
        token_id = extract_up_token_id(event)
        if not token_id:
            misses["no_token"] += 1
            continue

        slug = event.get("slug") or hourly_slug(
            coin, hour_start_utc.astimezone(ET).year,
            hour_start_utc.astimezone(ET).month,
            hour_start_utc.astimezone(ET).day,
            hour_start_utc.astimezone(ET).hour,
        )

        # Decision: 5 min before the resolution hour starts.
        decision_ts = hour_start_utc - timedelta(minutes=5)

        p_market = fetch_market_price(clob, token_id, decision_ts)
        if p_market is None or not (0.0 <= p_market <= 1.0):
            misses["no_price"] += 1
            continue

        # Compute our model signal at decision_ts.
        # We use the candle that just closed (the one ending at decision_ts.floor('h')+1h is the open one
        # we're predicting). Here decision_ts is at HH:55, so the prior closed candle is HH-1.
        # compute_signal_at requires decision_ts to be inside a candle that exists; pass the prior bar's start.
        prior_bar_start = (hour_start_utc - timedelta(hours=1))
        ts_pd = pd.Timestamp(prior_bar_start)
        sig = compute_signal_at(
            candles_by_coin[coin],
            funding_by_coin[coin],
            decision_ts_utc=ts_pd,
            coin=coin,
        )
        if sig is None:
            misses["no_signal"] += 1
            continue

        outcome = resolve_outcome(candles_by_coin[coin], pd.Timestamp(hour_start_utc))
        if outcome is None:
            misses["no_outcome"] += 1
            continue

        fee = crypto_taker_fee(p_market, DEFAULT_TRADE_SHARES)
        samples.append(
            Sample(
                coin=coin,
                hour_start_utc=pd.Timestamp(hour_start_utc),
                slug=slug,
                p_market_up=float(p_market),
                p_model_up=float(sig.p_up_model),
                score=float(sig.score),
                outcome_up=int(outcome),
                minutes_to_resolution=5,
                fee_at_p_market=float(fee),
            )
        )

    print(f"[calib] done. kept={len(samples)} misses={misses}")
    return samples, misses


# -----------------------------------------------------------------------------
# Reporting.
# -----------------------------------------------------------------------------

def calibration_table(df: pd.DataFrame, col: str, n_buckets: int = 10) -> pd.DataFrame:
    """Bucket `col` into n_buckets and report empirical hit rate."""
    if df.empty:
        return pd.DataFrame()
    buckets = pd.cut(df[col], bins=np.linspace(0.0, 1.0, n_buckets + 1), include_lowest=True)
    grouped = df.groupby(buckets, observed=True).agg(
        n=("outcome_up", "size"),
        empirical_p_up=("outcome_up", "mean"),
        avg_p_model=("p_model_up", "mean"),
        avg_p_market=("p_market_up", "mean"),
    )
    return grouped.reset_index()


def edge_table(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    df = df.copy()
    df["edge"] = df["p_model_up"] - df["p_market_up"]
    bins = [-1.0, -0.10, -0.05, -0.02, 0.02, 0.05, 0.10, 1.0]
    labels = ["<-10%", "-10..-5%", "-5..-2%", "-2..2%", "2..5%", "5..10%", ">10%"]
    df["edge_bucket"] = pd.cut(df["edge"], bins=bins, labels=labels, include_lowest=True)
    grouped = df.groupby("edge_bucket", observed=True).agg(
        n=("outcome_up", "size"),
        empirical_p_up=("outcome_up", "mean"),
        avg_p_market=("p_market_up", "mean"),
        avg_p_model=("p_model_up", "mean"),
    )
    return grouped.reset_index()


def simulate_pnl(df: pd.DataFrame, *, edge_threshold: float, spread_usd: float) -> dict:
    """Simulate trading every sample where |p_model - p_market| > threshold.

    BUY YES-Up at (p_market + spread/2) when model says Up is underpriced.
    BUY YES-Down at (1 - p_market + spread/2) when model says Up is overpriced.
    Pay Crypto fee on entry, no fee on resolution.
    Resolution: holders of winning token receive $1/share.
    """
    if df.empty:
        return {"trades": 0, "wins": 0, "losses": 0, "win_rate": float("nan"),
                "gross_pnl": 0.0, "fees": 0.0, "net_pnl": 0.0, "roi": float("nan")}

    df = df.copy()
    df["edge"] = df["p_model_up"] - df["p_market_up"]
    take = df[df["edge"].abs() > edge_threshold].copy()
    if take.empty:
        return {"trades": 0, "wins": 0, "losses": 0, "win_rate": float("nan"),
                "gross_pnl": 0.0, "fees": 0.0, "net_pnl": 0.0, "roi": float("nan")}

    take["bet_up"] = take["edge"] > 0  # True if we bet on Up
    take["entry_price"] = np.where(
        take["bet_up"],
        np.clip(take["p_market_up"] + spread_usd / 2.0, 0.001, 0.999),
        np.clip((1.0 - take["p_market_up"]) + spread_usd / 2.0, 0.001, 0.999),
    )
    take["won"] = np.where(take["bet_up"], take["outcome_up"] == 1, take["outcome_up"] == 0)
    take["payout"] = take["won"].astype(float) * 1.0  # $1/share if won, $0 if lost
    take["fee"] = take["entry_price"].apply(lambda p: crypto_taker_fee(p, DEFAULT_TRADE_SHARES))
    take["pnl"] = (take["payout"] - take["entry_price"]) * DEFAULT_TRADE_SHARES - take["fee"]
    take["stake"] = take["entry_price"] * DEFAULT_TRADE_SHARES + take["fee"]

    return {
        "trades": int(len(take)),
        "wins": int(take["won"].sum()),
        "losses": int((~take["won"]).sum()),
        "win_rate": float(take["won"].mean()),
        "gross_pnl": float(((take["payout"] - take["entry_price"]) * DEFAULT_TRADE_SHARES).sum()),
        "fees": float(take["fee"].sum()),
        "net_pnl": float(take["pnl"].sum()),
        "roi": float(take["pnl"].sum() / take["stake"].sum()) if take["stake"].sum() > 0 else float("nan"),
    }


def render_report(samples: list[Sample], misses: dict, days: int) -> str:
    if not samples:
        return f"# Calibration report\n\nNo samples collected in last {days} days. Misses: {misses}\n"

    df = pd.DataFrame([dataclasses.asdict(s) for s in samples])

    lines: list[str] = []
    lines.append(f"# Hourly Crypto Calibration Report")
    lines.append("")
    lines.append(f"- Window: last **{days} days**")
    lines.append(f"- Samples: **{len(df)}** (across {df['coin'].nunique()} coins)")
    lines.append(f"- Misses: `{misses}`")
    lines.append(f"- Decision lead time: **5 minutes** before resolution top-of-hour")
    lines.append(f"- Trade size assumption: **{DEFAULT_TRADE_SHARES:.0f} shares** at ~$0.50/share = ~$25 notional")
    lines.append(f"- Spread assumption (per round trip): **${DEFAULT_SPREAD_USD:.02f}**")
    lines.append(f"- Crypto fee rate: **{CRYPTO_FEE_RATE}** (max ~1.8¢/share at p=0.50)")
    lines.append("")

    lines.append("## Headline numbers")
    lines.append("")
    lines.append(f"- Empirical Up rate (all hours): **{df['outcome_up'].mean():.3f}**")
    lines.append(f"- Mean p_market_up: **{df['p_market_up'].mean():.3f}**")
    lines.append(f"- Mean p_model_up:  **{df['p_model_up'].mean():.3f}**")
    lines.append(f"- Brier score (model):  **{((df['p_model_up'] - df['outcome_up']) ** 2).mean():.4f}**")
    lines.append(f"- Brier score (market): **{((df['p_market_up'] - df['outcome_up']) ** 2).mean():.4f}**")
    lines.append("")

    lines.append("## Per-coin headline")
    lines.append("")
    by_coin = df.groupby("coin").agg(
        n=("outcome_up", "size"),
        emp_p_up=("outcome_up", "mean"),
        mean_p_market=("p_market_up", "mean"),
        mean_p_model=("p_model_up", "mean"),
        brier_model=("p_model_up", lambda s: float(((s - df.loc[s.index, "outcome_up"]) ** 2).mean())),
        brier_market=("p_market_up", lambda s: float(((s - df.loc[s.index, "outcome_up"]) ** 2).mean())),
    ).round(4)
    lines.append(by_coin.to_markdown())
    lines.append("")

    lines.append("## Calibration table — model probability buckets")
    lines.append("")
    cal = calibration_table(df, "p_model_up", n_buckets=10).round(4)
    if not cal.empty:
        lines.append(cal.to_markdown(index=False))
    lines.append("")

    lines.append("## Calibration table — market probability buckets")
    lines.append("")
    calm = calibration_table(df, "p_market_up", n_buckets=10).round(4)
    if not calm.empty:
        lines.append(calm.to_markdown(index=False))
    lines.append("")

    lines.append("## Edge histogram (p_model − p_market)")
    lines.append("")
    et = edge_table(df).round(4)
    if not et.empty:
        lines.append(et.to_markdown(index=False))
    lines.append("")

    lines.append("## Simulated PnL — sweep over edge threshold")
    lines.append("")
    rows = []
    for theta in (0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15):
        r = simulate_pnl(df, edge_threshold=theta, spread_usd=DEFAULT_SPREAD_USD)
        r["edge_threshold"] = theta
        rows.append(r)
    sim = pd.DataFrame(rows)[["edge_threshold", "trades", "wins", "losses", "win_rate", "gross_pnl", "fees", "net_pnl", "roi"]].round(4)
    lines.append(sim.to_markdown(index=False))
    lines.append("")

    lines.append("## Reading guide")
    lines.append("")
    lines.append("- **Calibration table**: each row should have `empirical_p_up` close to `avg_p_model` if the model is well-calibrated. Big gaps mean the model is over- or under-confident in that bucket.")
    lines.append("- **Edge histogram**: the rightmost bucket (`>10%`) is the high-conviction tail; if `empirical_p_up` there is meaningfully above 0.50, the bot has signal.")
    lines.append("- **PnL sweep**: positive `net_pnl` and `roi` at any `edge_threshold` indicates a profitable strategy AFTER fees and spread. If everything is negative, the edge is too small to overcome friction.")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Hourly-crypto Polymarket calibration")
    parser.add_argument("--days", type=int, default=14, help="Days of history to study (default 14)")
    parser.add_argument("--report", type=str, default=None, help="Output markdown path (overrides .env CALIB_REPORT_PATH)")
    parser.add_argument("--csv", type=str, default=None, help="Optional CSV dump of raw samples")
    args = parser.parse_args()

    samples, misses = run_calibration(args.days)

    if args.csv and samples:
        pd.DataFrame([dataclasses.asdict(s) for s in samples]).to_csv(args.csv, index=False)
        print(f"[calib] wrote raw samples to {args.csv}")

    report = render_report(samples, misses, args.days)
    out_path = args.report or os.environ.get("CALIB_REPORT_PATH", "docs/calibration_hourly_crypto.md")
    out_full = Path(__file__).resolve().parent.parent / out_path
    out_full.parent.mkdir(parents=True, exist_ok=True)
    out_full.write_text(report, encoding="utf-8")
    print(f"[calib] wrote report to {out_full}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
