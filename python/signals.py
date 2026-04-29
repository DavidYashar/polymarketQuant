"""Signal computation for the hourly-crypto calibration.

This is a clean-room port of the methodology described in
`docs/hourly-crypto-bot-plan.md` (Section "Trading Strategy").

Only signals that can be computed from the HL warehouse 1h candles + funding
are implemented here. We deliberately keep this module self-contained (no
imports from the live HL bot) so the calibration is reproducible from CSV
exports if needed.

Inputs are pandas DataFrames indexed by UTC timestamp.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd


# ---- Primitive indicators ----------------------------------------------------

def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI on a price series."""
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100.0 - (100.0 / (1.0 + rs))
    return out.fillna(50.0)


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def momentum(series: pd.Series, lookback: int) -> pd.Series:
    """Simple % change over `lookback` bars, clipped to [-1, 1] after scaling."""
    pct = (series / series.shift(lookback) - 1.0)
    # 1% in `lookback` hours -> full signal
    return pct.mul(100.0).clip(-1.0, 1.0)


def volume_zscore(volume: pd.Series, window: int = 24) -> pd.Series:
    mean = volume.rolling(window).mean()
    std = volume.rolling(window).std(ddof=0).replace(0.0, np.nan)
    return ((volume - mean) / std).fillna(0.0)


# ---- Composite hourly-direction signal --------------------------------------

@dataclass(frozen=True)
class SignalAtTime:
    """Snapshot of all features at one decision instant."""

    ts_utc: pd.Timestamp
    coin: str

    hourly_open: float
    spot_price: float
    minutes_into_hour: int

    position_pct: float
    position_signal: float
    momentum_2h: float
    momentum_4h: float
    rsi_14: float
    ema_fast: float
    ema_slow: float
    ema_cross_signal: float
    funding_rate: float
    volume_z: float

    score: float          # combined weighted score in [-1, +1]
    p_up_model: float     # mapped to a probability in [0, 1]


def _ema_cross_signal(fast: float, slow: float) -> float:
    if not np.isfinite(fast) or not np.isfinite(slow) or slow == 0.0:
        return 0.0
    diff = (fast - slow) / slow
    # ~0.3% gap -> full signal
    return float(np.clip(diff * 333.0, -1.0, 1.0))


def _logistic(x: float, k: float = 2.5) -> float:
    """Squash a score in [-1, 1] to a probability in [0, 1] via logistic."""
    return float(1.0 / (1.0 + np.exp(-k * x)))


def compute_signal_at(
    candles_1h: pd.DataFrame,
    funding_1h: Optional[pd.DataFrame],
    *,
    decision_ts_utc: pd.Timestamp,
    coin: str,
    spot_price: Optional[float] = None,
) -> Optional[SignalAtTime]:
    """Compute the full signal snapshot at `decision_ts_utc`.

    The candles passed in must include at least 30+ hours of history before
    `decision_ts_utc` so the indicators have warm-up data.

    `decision_ts_utc` is the moment we'd be placing a bet -- it does not have
    to align with a candle boundary. The "hourly open" is the open of the
    candle that contains `decision_ts_utc`.

    Returns None if there isn't enough data.
    """
    if candles_1h.empty:
        return None

    # Find the candle that contains the decision instant.
    bar_start = decision_ts_utc.floor("h")
    if bar_start not in candles_1h.index:
        return None
    bar = candles_1h.loc[bar_start]
    hourly_open = float(bar["o"])

    # Use spot if provided, else use the candle's "close-so-far" approximation.
    # In a true historical replay, spot at decision_ts is unknown unless we
    # have sub-hourly data. We approximate it by the bar's close (i.e. assume
    # we're looking at the bar after it has fully formed). For the calibration
    # the right thing is to fix `decision_ts_utc` at the END of the bar, so
    # `spot_price = bar["c"]` and we're using the just-closed-hour as our edge
    # signal for the NEXT hour's market. The minutes_into_hour will be 0.
    if spot_price is None:
        spot_price = float(bar["c"])

    # All bars strictly BEFORE the decision ts (so we don't peek into the future).
    history = candles_1h.loc[candles_1h.index < bar_start]
    if len(history) < 24:
        return None

    closes = history["c"]
    volumes = history["v"]

    rsi14 = float(rsi(closes, 14).iloc[-1])
    mom_2h = float(momentum(closes, 2).iloc[-1])
    mom_4h = float(momentum(closes, 4).iloc[-1])
    ema_fast = float(ema(closes, 4).iloc[-1])
    ema_slow = float(ema(closes, 12).iloc[-1])
    ema_cross = _ema_cross_signal(ema_fast, ema_slow)
    vol_z = float(volume_zscore(volumes, 24).iloc[-1])

    fund = 0.0
    if funding_1h is not None and not funding_1h.empty:
        prior = funding_1h.loc[funding_1h.index < bar_start]
        if not prior.empty:
            fund = float(prior["funding_rate"].iloc[-1])

    # Position vs hourly open
    if hourly_open <= 0:
        return None
    position_pct = (spot_price - hourly_open) / hourly_open * 100.0
    # 0.33% above open -> full +1 signal
    position_signal = float(np.clip(position_pct * 3.0, -1.0, 1.0))

    minutes_into_hour = int(((decision_ts_utc - bar_start).total_seconds() // 60))

    # Time-aware weighting (mirrors the plan doc).
    minutes_remaining = max(0, 60 - minutes_into_hour)
    if minutes_remaining > 45:
        w_pos, w_mom = 0.30, 0.50
    elif minutes_remaining > 20:
        w_pos, w_mom = 0.40, 0.40
    else:
        w_pos, w_mom = 0.55, 0.25
    w_other = 1.0 - w_pos - w_mom

    momentum_blend = 0.6 * mom_2h + 0.4 * mom_4h
    score = (
        w_pos * position_signal
        + w_mom * momentum_blend
        + w_other * ema_cross
    )
    # Tiny RSI-extreme tilt (mean reversion at extremes).
    if rsi14 >= 75:
        score -= 0.05
    elif rsi14 <= 25:
        score += 0.05
    score = float(np.clip(score, -1.0, 1.0))

    p_up = _logistic(score)

    return SignalAtTime(
        ts_utc=decision_ts_utc,
        coin=coin,
        hourly_open=hourly_open,
        spot_price=spot_price,
        minutes_into_hour=minutes_into_hour,
        position_pct=position_pct,
        position_signal=position_signal,
        momentum_2h=mom_2h,
        momentum_4h=mom_4h,
        rsi_14=rsi14,
        ema_fast=ema_fast,
        ema_slow=ema_slow,
        ema_cross_signal=ema_cross,
        funding_rate=fund,
        volume_z=vol_z,
        score=score,
        p_up_model=p_up,
    )


# ---- Outcome resolution ------------------------------------------------------

def resolve_outcome(candles_1h: pd.DataFrame, hour_start_utc: pd.Timestamp) -> Optional[int]:
    """Return 1 if the 1h bar starting at `hour_start_utc` closed >= open
    (i.e. "Up" wins on Polymarket), 0 if "Down" wins, None if no data.
    """
    if hour_start_utc not in candles_1h.index:
        return None
    bar = candles_1h.loc[hour_start_utc]
    return 1 if float(bar["c"]) >= float(bar["o"]) else 0


# ---- Polymarket fee model ----------------------------------------------------

# Per docs/polymarket-investigation-report.md and the Maker Rebates page:
#   fee_per_share = C * feeRate * p * (1 - p)
# For the Crypto category, feeRate = 0.072 (max ~1.8 cents/share at p=0.5).
CRYPTO_FEE_RATE = 0.072


def crypto_taker_fee(price: float, shares: float) -> float:
    """USDC fee charged by Polymarket on a Crypto-category trade."""
    p = max(0.0, min(1.0, price))
    return shares * CRYPTO_FEE_RATE * p * (1.0 - p)


__all__ = [
    "SignalAtTime",
    "compute_signal_at",
    "resolve_outcome",
    "crypto_taker_fee",
    "CRYPTO_FEE_RATE",
]
