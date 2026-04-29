# All-Markets “Buy Shares → Sell for Profit” Investigation (Polymarket)

Date: 2026-02-14

## Executive summary
A market-agnostic bot that treats every outcome token as a tradable share (buy → later sell for profit) is technically feasible on Polymarket **only for markets that have CLOB orderbooks enabled and sufficient liquidity**. The main blocker is not the API surface; it’s market microstructure:

- Many markets are illiquid, have wide spreads, or have CLOB disabled.
- A strategy that only “sells when in profit” can still get trapped (no bids / spread widens / news reversal) and end up holding to settlement.
- To scale to “all markets”, you must **filter aggressively** and rely on **real-time book data** (websocket or frequent polling) rather than Gamma’s often-stale bestBid/bestAsk.

A realistic implementation is: **scan all active markets → select a small top-N by liquidity/volume/tight spread → trade only those**.

## What you have today (repo)
- Execution: the bot uses `@polymarket/clob-client` for posting FOK buys and FAK sells.
- Positions/PnL source of truth: Data API `/positions`.
- Price inputs:
  - Gamma market metadata (tags, acceptingOrders, endDate/startDate, outcomePrices, etc).
  - CLOB top-of-book via `GET /book?token_id=...`.

Current live flow:
- `src/bot.ts` orchestrates:
  - `src/liveMonitor.ts` (manage/close existing positions)
  - `src/liveSoccerHedge.ts` (open new soccer positions)

The monitor already has the key mechanics a general trader needs:
- Recomputes exact shares on-chain before selling.
- Uses conservative valuation based on top-of-book + haircut.
- Uses FAK sells and verifies fill by checking on-chain balances afterwards.

## What “all available bets” means in Gamma
Gamma exposes **all markets**, not only sports.

You can fetch:
- All active markets: `GET /markets?closed=false&limit=...&offset=...`.
- Best practice for full discovery: `GET /events?order=id&ascending=false&closed=false&limit=...` and then process markets inside events.

Useful filters for an all-market bot include:
- `closed=false`
- `acceptingOrders=true` (field)
- `enableOrderBook=true` (field)
- `liquidity_num_min`, `volume_num_min` (query)
- `start_date_min/max`, `end_date_min/max` (query)
- `tag_id` (optional)

## Hard constraints (why “all markets” is not literally all)
### 1) CLOB availability
Some markets are AMM-only or have orderbook disabled (`enableOrderBook=false`). A CLOB-based bot cannot trade these.

### 2) Liquidity and spread
Profit from buying then selling requires overcoming:
- crossing the spread twice (buy at ask, sell at bid), and
- fees, and
- slippage/partial fill risk.

If spread is wide, even correct “direction” won’t realize profit.

### 3) Fill risk (unwind risk)
Even if your take-profit triggers on paper, selling may fail to fill if bids disappear. Your existing monitor correctly warns about this risk by verifying on-chain share balances after selling.

### 4) Rate limits / throughput
Scanning “everything” requires pagination through hundreds/thousands of markets and, for each candidate token, fetching orderbooks. Without strict filtering, you’ll hit rate limits or become too slow.

## Strategy viability (market-agnostic)
A generic “buy shares and sell on profit” approach is viable when you can do all of the following consistently:

1) Select markets with tight spreads + real depth.
2) Enter with controlled slippage (often maker-style or small taker size).
3) Exit reliably at your take-profit bid with acceptable slippage.
4) Cut exposure via time-based exits and/or stop-loss rules.

Without #1 and #3, the bot will frequently be forced to hold to settlement (which defeats the “least risk” goal).

## Recommended architecture to generalize
### A) Discovery loop (slow)
Use Gamma to discover candidate markets:
- Fetch active markets or events.
- Filter to: `acceptingOrders`, `enableOrderBook`, liquidity/volume thresholds.
- Keep only a small list (e.g., top 50–200 tokens) to track more closely.

### B) Pricing loop (fast)
For the selected tokens only:
- Use CLOB book (`/book`) or websocket market channel to get bestBid/bestAsk and depth.
- Compute spread, mid, and whether the bid/ask is “real” (non-placeholder).

### C) Entry signal (must exist)
To trade “everything”, you still need a reason to buy. Common generic signals:
- Momentum (price up + volume up) — often crowded.
- Mean reversion after spikes — needs careful filters.
- Event-driven (news) — requires external data.

Without a signal, trading becomes random and expected value is negative after spread/fees.

### D) Exit logic (general)
Generalize monitor to all positions:
- Take-profit: close when conservativeValue >= cost + TP.
- Optional stop-loss: close when conservativeValue <= cost - SL.
- Time-based exit: close positions if time-to-end < X or holding time > Y.

### E) Safety controls
- Max stake per token, per market, and total open exposure.
- Skip tokens with spread above threshold or bestBidSize too small.
- Avoid trading very near endDate if liquidity collapses.

## Concrete implementation changes (if you decide to build it)
1) Extend Gamma client to support:
- `GET /markets` without requiring `tag_id`
- `GET /events` (recommended for full discovery)

2) Add a new script, e.g. `src/liveTradeAll.ts`, that:
- discovers candidates
- places small buys on selected signals

3) Add a new general monitor, or adapt `src/liveMonitor.ts`, to:
- evaluate all positions (not only soccer hedges)
- apply TP/SL/time exits per token/market

4) Add config knobs:
- minLiquidityNum, minVolume24hr
- maxSpread
- maxTrackedTokens
- maxHoldMinutes
- global TP/SL defaults

## Bottom line
Yes, you can make the bot market-agnostic and treat positions as tradable “shares”, but **not** by literally trading every market. The viable version is:

- “All markets eligible for discovery”
- “Only trade a filtered subset with proven liquidity/spread characteristics”
- “Always have an exit plan (TP/SL/time) and verify fills”

If you want to proceed, the first practical step is to add a read-only scanner report: list the top 200 active markets by liquidity/volume, and for each outcome token print `bestBid/bestAsk/spread/bidSize/askSize`. That will show you immediately how many markets are realistically tradable.
