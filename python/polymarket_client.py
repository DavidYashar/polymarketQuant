"""Read-only Polymarket REST client used by the calibration script.

Only what we need:
- Gamma:  resolve event slug -> markets[]   (so we can find historical hourly markets)
- CLOB:   /prices-history                    (to get the time series of YES/NO prices)
- CLOB:   /batch-prices-history              (bulk variant; up to 20 token ids)

No auth, no signing, no order placement. Pure HTTP.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Iterable

import requests

DEFAULT_TIMEOUT = 15
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _request(method: str, url: str, *, params=None, json_body=None, timeout=DEFAULT_TIMEOUT, max_retries=4) -> Any:
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            resp = requests.request(
                method,
                url,
                params=params,
                json=json_body,
                timeout=timeout,
                headers={"Accept": "application/json"},
            )
            if resp.status_code in RETRYABLE_STATUS:
                time.sleep(min(8.0, 0.5 * (2 ** attempt)))
                continue
            resp.raise_for_status()
            if not resp.content:
                return None
            return resp.json()
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_exc = exc
            time.sleep(min(8.0, 0.5 * (2 ** attempt)))
    raise RuntimeError(f"{method} {url} failed after {max_retries} retries: {last_exc}")


@dataclass(frozen=True)
class HourlyMarket:
    """One side of a Polymarket hourly crypto market (e.g. BTC up-or-down 4PM ET).

    The "Up" outcome corresponds to one CTF token id; "Down" to the other.
    For calibration we only need the YES-Up token because the implied probability
    of "Up" + "Down" sums to ~$1, so prob(Up) = 1 - prob(Down).
    """

    coin: str               # "BTC", "ETH", "SOL", "XRP"
    slug: str               # e.g. "bitcoin-up-or-down-march-15-4pm-et"
    resolve_ts_ms: int      # UTC ms at the top of the resolution hour
    up_token_id: str
    down_token_id: str
    accepting_orders: bool


class GammaClient:
    def __init__(self, host: str = "https://gamma-api.polymarket.com"):
        self.host = host.rstrip("/")

    def get_event_by_slug(self, slug: str) -> dict | None:
        """Returns the event dict (with nested `markets`) or None if not found."""
        url = f"{self.host}/events/slug/{slug}"
        try:
            return _request("GET", url)
        except RuntimeError as exc:
            # 404s come through as raise_for_status -> RuntimeError; treat as missing
            if "404" in str(exc):
                return None
            raise

    def list_markets(self, *, closed: bool | None = None, limit: int = 500, offset: int = 0,
                     tag: str | None = None) -> list[dict]:
        """Generic /markets listing. Used for discovering hourly markets."""
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if closed is not None:
            params["closed"] = "true" if closed else "false"
        if tag:
            params["tag_slug"] = tag
        url = f"{self.host}/markets"
        return _request("GET", url, params=params) or []


class ClobClient:
    def __init__(self, host: str = "https://clob.polymarket.com"):
        self.host = host.rstrip("/")

    def prices_history(self, token_id: str, *, start_ts: int, end_ts: int,
                       interval: str = "1h", fidelity: int = 60) -> list[dict]:
        """GET /prices-history.

        Parameters
        ----------
        token_id : str
            CTF token id (asset id) of one outcome.
        start_ts, end_ts : int
            Unix seconds.
        interval : str
            One of: max, all, 1m, 1w, 1d, 6h, 1h.
        fidelity : int
            Sampling interval in minutes (default 60 -> hourly).

        Returns
        -------
        list of {"t": unix_seconds, "p": price}
        """
        params = {
            "market": token_id,
            "startTs": start_ts,
            "endTs": end_ts,
            "interval": interval,
            "fidelity": fidelity,
        }
        data = _request("GET", f"{self.host}/prices-history", params=params)
        return (data or {}).get("history", []) if isinstance(data, dict) else []

    def batch_prices_history(self, token_ids: list[str], *, start_ts: int, end_ts: int,
                             interval: str = "1h", fidelity: int = 60) -> dict[str, list[dict]]:
        """POST /batch-prices-history. Up to 20 markets per request.

        Returns
        -------
        dict mapping token_id -> list of {"t", "p"}
        """
        if len(token_ids) > 20:
            raise ValueError("batch-prices-history accepts at most 20 markets")
        body = {
            "markets": token_ids,
            "start_ts": start_ts,
            "end_ts": end_ts,
            "interval": interval,
            "fidelity": fidelity,
        }
        data = _request("POST", f"{self.host}/batch-prices-history", json_body=body)
        return (data or {}).get("history", {}) if isinstance(data, dict) else {}

    def fee_rate(self, token_id: str) -> int | None:
        """GET /fee-rate -> base_fee in basis points."""
        try:
            data = _request("GET", f"{self.host}/fee-rate", params={"token_id": token_id})
        except RuntimeError:
            return None
        if isinstance(data, dict):
            v = data.get("base_fee")
            if isinstance(v, int):
                return v
            try:
                return int(v) if v is not None else None
            except (TypeError, ValueError):
                return None
        return None


# ---- Slug + resolution helpers ----------------------------------------------

COIN_SLUG_NAMES = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "XRP": "xrp",
}

MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
]


def hour_to_et_label(hour_24: int) -> str:
    """0 -> '12am', 12 -> '12pm', 17 -> '5pm', etc."""
    if hour_24 == 0:
        return "12am"
    if hour_24 < 12:
        return f"{hour_24}am"
    if hour_24 == 12:
        return "12pm"
    return f"{hour_24 - 12}pm"


def hourly_slug(coin: str, year: int, month_1to12: int, day: int, hour_et_24: int) -> str:
    """Build the deterministic Polymarket hourly slug for a given coin and ET hour.

    NOTE: year is not in the slug because Polymarket only keeps recent markets
    in the active set, but historical ones still resolve via this same slug
    pattern. Caller is responsible for filtering out duplicates from prior years.
    """
    coin_name = COIN_SLUG_NAMES[coin.upper()]
    return f"{coin_name}-up-or-down-{MONTHS[month_1to12 - 1]}-{day}-{hour_to_et_label(hour_et_24)}-et"


__all__ = [
    "GammaClient",
    "ClobClient",
    "HourlyMarket",
    "COIN_SLUG_NAMES",
    "hour_to_et_label",
    "hourly_slug",
]
