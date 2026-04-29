# Polymarket calibration — Python tools

This folder contains the **calibration study** for hourly crypto markets on Polymarket.
It is read-only: pulls historical Polymarket prices via REST, joins them against
the local Hyperliquid warehouse Postgres, and writes a markdown report.

It does **not** trade, sign, or place orders. Safe to run alongside the live HL bot.

## What it answers

> Does our HL hourly signal have enough probabilistic skill to overcome
> Polymarket's ~3–6% per-trade friction (fees + spread)?

Output: `docs/calibration_hourly_crypto.md` with:
- Per-coin Brier scores vs the market's implied probabilities
- Calibration tables (bucketed model probability → empirical hit rate)
- Edge histogram and a sweep of simulated PnL at different edge thresholds

## Setup (on the old Ubuntu laptop)

```bash
cd ~/polymarketBot/python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env if your Postgres credentials differ from defaults
```

## Run

```bash
# default: last 14 days of hourly markets across BTC/ETH/SOL/XRP
python calibration_hourly_crypto.py --days 14

# longer window
python calibration_hourly_crypto.py --days 30

# also dump raw samples to CSV for ad-hoc analysis
python calibration_hourly_crypto.py --days 30 --csv /tmp/samples.csv
```

## Files

| File | Purpose |
| --- | --- |
| `polymarket_client.py` | Read-only Gamma + CLOB REST clients. No SDK dependency. |
| `hl_warehouse.py` | Postgres reader for `candles_1h`, `funding_1h`. |
| `signals.py` | Self-contained port of the hourly-direction scoring (RSI, momentum, EMA crossover, position-vs-open, time-aware weighting, logistic mapping to probability). |
| `calibration_hourly_crypto.py` | Main script: enumerate hours, fetch prices, compute signals, resolve outcomes, render report. |

## Methodology (in one paragraph)

For every past hour `H`, for every coin `C`:
1. Look up the Polymarket market `{coin}-up-or-down-{month}-{day}-{HH}-et` via Gamma.
2. Pull the YES-Up token's price at `H − 5min` from CLOB `/prices-history` (fidelity 5).
3. Compute our model's `p_up` using HL warehouse 1h candles up to `H`.
4. Resolve the outcome: did the 1h bar starting at `H` close `>=` open?
5. Append `(p_market, p_model, outcome)` to the dataset.

Then we report per-coin Brier scores, calibration buckets, edge histogram, and
a fees+spread-aware PnL simulation across edge thresholds.

## Caveats

- The HL warehouse must be populated for the coins and time window you study.
  Run `python -c "from hl_warehouse import warehouse_status; print(warehouse_status())"`
  to sanity-check.
- Polymarket only retains historical price data while the market still exists in
  the orderbook listing. Markets older than ~30 days may return empty.
- The signal computation uses the **just-closed prior 1h candle** as the proxy
  for "spot at decision time". This is a deliberate conservative choice — sub-hourly
  spot would be more accurate but requires a separate HL data source.
