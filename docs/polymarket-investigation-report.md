# Polymarket Investigation Report (Jan 28, 2026)

This report consolidates the key Polymarket developer surfaces (Gamma API, CLOB API, Data API, WebSockets, and on-chain/CTF operations) and highlights practical implications for building bots, market makers, and “builder” apps.

## 1) Mental Model: What Polymarket is (for developers)

Polymarket is a prediction market platform where outcomes are tokenized on Polygon. The trading interface exposed to builders is a **hybrid-decentralized CLOB**:

- **Off-chain operator**: maintains orderbooks, performs matching/ordering.
- **On-chain settlement**: matched trades are executed on-chain using signed order messages, so trading remains **non-custodial**.
- **Outcome tokens**: markets resolve into “YES/NO” outcome tokens (CTF ERC1155) backed by collateral (USDCe on Polygon).

Key consequence: you’ll interact with *both* fast off-chain APIs (orderbooks, posting orders, websockets) and slower on-chain flows (allowances, splits/merges, redemption on resolution).

## 2) Endpoints: What exists and what each is for

From the “Endpoints” docs:

### REST APIs
- **CLOB API**: `https://clob.polymarket.com`
  - Order management, prices, orderbooks, trade history.
- **Gamma API**: `https://gamma-api.polymarket.com`
  - Market discovery + metadata (events, markets, tags, slugs, mapping to token IDs).
- **Data API**: `https://data-api.polymarket.com`
  - Portfolio-like read APIs: positions, activity, trades history, leaderboards.

### WebSockets
- **CLOB WebSocket**: `wss://ws-subscriptions-clob.polymarket.com/ws/`
  - Two channels: `market` (public) and `user` (authenticated).
- **RTDS**: `wss://ws-live-data.polymarket.com`
  - Low-latency streams (not deeply covered in this report beyond existence).

## 3) Authentication: L1 vs L2 and why it matters

Polymarket CLOB uses **two authentication levels**:

### L1 (wallet private key / EIP-712)
- Uses the wallet’s private key to sign an **EIP-712** struct.
- Enables:
  - Creating/deriving L2 API credentials.
  - Locally signing/creating user orders.
- REST headers (when not using the official client):
  - `POLY_ADDRESS`
  - `POLY_SIGNATURE` (EIP-712)
  - `POLY_TIMESTAMP`
  - `POLY_NONCE` (default 0)

Common L1 endpoints:
- `POST /auth/api-key` (create)
- `GET /auth/derive-api-key` (derive)

### L2 (API key/secret/passphrase / HMAC)
- Uses API credentials created from L1.
- Requests are signed using **HMAC-SHA256**.
- Enables:
  - Posting orders, canceling orders, fetching open orders, getting trades, checking balances/allowances.
- REST headers (when not using official client):
  - `POLY_ADDRESS`
  - `POLY_SIGNATURE` (HMAC)
  - `POLY_TIMESTAMP`
  - `POLY_API_KEY`
  - `POLY_PASSPHRASE`

Important nuance from docs: even with L2 request auth, **creating orders still requires signing the order payload** (the official clients abstract this).

### Signature types + funder
When using the CLOB client with L2, you must set:
- `signatureType`:
  - `0` EOA
  - `1` POLY_PROXY
  - `2` GNOSIS_SAFE
- `funder` address:
  - The address holding funds/allowances.
  - The “address shown to the user” on polymarket.com may be a proxy wallet; that proxy should often be used as funder.

Practical implication: “who signs” (signer) and “who pays/owns funds” (funder) can be different; bot logic must be explicit.

## 4) Rate limits: enforced by Cloudflare throttling

Docs highlight that limits are **throttling/queuing**, not immediate hard rejections:
- Sliding windows (e.g., per 10 seconds).
- Some endpoints allow bursts.

### Selected limits (high-signal ones)
- General: **15000 req / 10s**
- Data API general: **1000 / 10s**
  - `/trades`: 200 / 10s
  - `/positions`: 150 / 10s
- Gamma general: **4000 / 10s**
  - `/markets`: 300 / 10s
  - `/events`: 500 / 10s
- CLOB general: **9000 / 10s**
- CLOB market data (e.g. `/book`, `/price`): up to **1500 / 10s** for single; **500 / 10s** for multi.
- CLOB trading:
  - `POST /order`: 3500 / 10s (burst), 36000 / 10m
  - `DELETE /order`: 3000 / 10s (burst), 30000 / 10m
  - Batch endpoints lower.

Bot implication: for high-frequency market data, use **WebSockets**, not aggressive REST polling.

## 5) Market discovery workflow (Gamma → CLOB)

Gamma is the canonical “what is tradeable?” discovery service.

Docs recommend three strategies:
1. **By slug**: best for a known market/event (get slug from `polymarket.com/event/<slug>`).
2. **By tags**: filter categories/sports using `tag_id`.
3. **Via `/events`**: most efficient for “all active markets” using pagination (`limit` + `offset`) and `closed=false`.

Practical mapping you should always hold:
- **Event** contains one or more markets.
- **Market** maps to:
  - condition ID (the “market id” in CLOB/WebSocket terminology)
  - one or more CLOB token IDs (asset IDs) (YES/NO)

Bot implication: keep a local cache keyed by `conditionId` and token IDs; refresh via Gamma periodically (seconds to minutes), not continuously.

## 6) CLOB order model: what’s really sent when placing orders

Even though most users think “price + size + side”, the actual `order` object is a fully structured on-chain-executable limit order.

From “Place Single Order”:

### Request payload
- `order` (signed object)
- `owner` (api key of order owner)
- `orderType` (`FOK`, `GTC`, `GTD`; docs also discuss `FAK`)
- `postOnly` optional

### Important behaviors
- **All orders are represented as limit orders**; “market orders” are achieved by sending a *marketable* limit price.
- **postOnly**:
  - If it would cross the spread, it is rejected (won’t execute immediately).
  - Cannot be combined with market-style types (`FOK` / `FAK`).

### Order types (behavioral)
- `GTC`: rests until filled/canceled.
- `GTD`: rests until specified expiration.
- `FOK`: must fill immediately and fully else canceled.
- `FAK`: fills immediately as much as possible; remainder canceled.

### Placement response fields
- `success` (server-side success)
- `errorMsg` (reason if not placed)
- `orderId`
- `orderHashes` (hashes of settlement tx if marketable and matched)

### Placement statuses
- `matched`, `live`, `delayed`, `unmatched`

### Common insert errors (subset)
- `INVALID_ORDER_MIN_TICK_SIZE`
- `INVALID_ORDER_MIN_SIZE`
- `INVALID_ORDER_NOT_ENOUGH_BALANCE`
- `INVALID_ORDER_EXPIRATION`
- `INVALID_POST_ONLY_ORDER_TYPE`
- `INVALID_POST_ONLY_ORDER`
- `FOK_ORDER_NOT_FILLED_ERROR`
- `MARKET_NOT_READY`

Practical implications for a bot:
- You need **tick size awareness** (and it can change; see websocket tick size message).
- You need **balance + allowance** awareness and must manage them on-chain.
- You must treat “delayed” placement as a first-class state (don’t assume immediate book state).

## 7) Allowances and “reserved balance” constraints

From Orders Overview:
- To place orders, the **Exchange contract** must have allowances:
  - When buying: USDCe allowance.
  - When selling: outcome token allowance (ERC1155-approval patterns via relevant contracts/wallet types).

Validity checks are continuous:
- Balances/allowances tracked and orders can become invalid.
- There are “rails” per market: your open orders in a market can reserve your entire balance (example given: one large buy can block subsequent buys in same market).

Bot implication: don’t naively place multiple large orders on same side of same market; build a portfolio-aware quote allocator.

## 8) WebSockets: what you get in real-time

### Subscription (WSS overview)
- Message includes:
  - `type`: `USER` or `MARKET` (docs show string ids)
  - `assets_ids` for market channel
  - `markets` for user channel
  - `custom_feature_enabled` flag
  - `auth` only for user channel

### Market channel (public)
Emits:
- `book`: snapshots/regen on subscribe and when trades affect book.
- `price_change`: incremental updates on order placement/cancel.
- `tick_size_change`: tick size changes when price gets extreme (<0.04 or >0.96).
- `last_trade_price`: on matches.
- `best_bid_ask`: behind `custom_feature_enabled`.
- `new_market`, `market_resolved`: also behind `custom_feature_enabled`.

Practical bot guidance:
- Use `book` to seed a local orderbook, then apply `price_change` updates.
- Consider the breaking-change note about `price_change` schema updates (migration guide referenced in docs).

### User channel (authenticated)
Two main event types:
- `order` events:
  - `type`: `PLACEMENT`, `UPDATE`, `CANCELLATION`
  - Includes `size_matched`, `original_size`, `associate_trades`.
- `trade` events:
  - Trade life-cycle statuses: `MATCHED` → `MINED` → `CONFIRMED` (terminal success) OR `RETRYING`/`FAILED`.

Trade reconciliation note (from Trades Overview):
- A “trade” may split across multiple transactions; use `(match_time, bucket_index, market_order_id)` to reconcile.

## 9) Data API (portfolio/user-facing read APIs)

Data API is useful for:
- Post-trade analytics.
- Portfolio dashboards.
- Cross-checking position states.

Examples from docs:
- `GET /positions` (requires `user` address)
  - Filters: `market[]` (condition IDs) or `eventId[]`, pagination (`limit`, `offset`), sorting, `sizeThreshold`, `redeemable`, `mergeable`.
- `GET /activity`
  - Types include: `TRADE`, `SPLIT`, `MERGE`, `REDEEM`, `REWARD`, `CONVERSION`, `MAKER_REBATE`.
- `GET /trades`
  - Filters: `user`, `market[]` or `eventId[]`, `side`, pagination, `takerOnly` default true.

Bot implication: don’t use Data API as your fill source of truth for low-latency execution; use **user websocket + CLOB /data/trades** for immediate fills, then use Data API for reconciliations.

## 10) On-chain / CTF operations (inventory is not optional for MMs)

Outcome tokens are Gnosis CTF ERC1155 tokens derived from:
- `conditionId` (from oracle + questionId + outcome slots)
- `collectionId` (conditionId + indexSet)
- `positionId` (collateral + collectionId)

Operations:
- **splitPosition**: convert $1 USDCe into 1 YES + 1 NO token (full set).
- **mergePositions**: convert equal YES+NO back into USDCe.
- **redeemPositions**: after resolution, redeem winning tokens for USDCe.

Market maker docs emphasize:
- Split USDCe into tokens for quoting inventory.
- Merge back to reduce exposure/free capital.
- Redeem post-resolution.

## 11) Relayer + Builder program: gasless infra and order attribution

### Relayer
- Endpoint: `https://relayer-v2.polymarket.com/`
- Purpose: route transactions so Polymarket pays gas (gasless UX).
- Requires **builder API credentials**: `key`, `secret`, `passphrase`.
- Auth headers:
  - `POLY_BUILDER_API_KEY`
  - `POLY_BUILDER_TIMESTAMP`
  - `POLY_BUILDER_PASSPHRASE`
  - `POLY_BUILDER_SIGNATURE` (HMAC)
- Recommended “remote signing” server pattern: client sends `{method, path, body}` to your server; server returns the above headers.

### Order attribution
- Adds builder auth headers when placing orders via CLOB client.
- Enables builder leaderboard credit/grants and monitoring via Data API.

Practical implication: if you’re building a public-facing app routing user orders, you likely want:
- user wallet signature for the order payload
- builder signing server to attach attribution headers
- optional relayer for wallet deployment + CTF operations

## 12) Practical “gotchas” and design recommendations for a bot

### Recommended architecture
- **Discovery loop (slow):** Gamma API every 10–60s (or longer) to refresh active markets/tokens.
- **Market data loop (fast):** WebSocket market channel for L2 book/price events.
- **Execution loop:** CLOB client for order creation/posting/canceling.
- **State reconciliation:**
  - user channel websocket for live order/trade events
  - periodic `/data/trades` and (optionally) Data API `/positions` for sanity checks

### Operational gotchas to handle
- **Tick size changes** (websocket `tick_size_change`) → your quoting grid must adapt.
- **Reservation rails** → avoid overcommitting balance on one market/side.
- **Allowances** → programmatically ensure USDCe + token approvals before quoting.
- **Trade status life-cycle** → treat `MATCHED` as “pending on-chain”; only `CONFIRMED` as final.
- **Cloudflare throttling** → timeouts/delays are expected under load; implement retries with jitter and circuit breakers.
- **postOnly rejections** → handle `INVALID_POST_ONLY_ORDER` explicitly.
- **Delayed matching** → order may be accepted but match is delayed; don’t double-place.

### Security guidance (from docs + best practice)
- Never commit private keys.
- Keep builder credentials server-side only.
- Prefer official clients (`@polymarket/clob-client`, `py-clob-client`) to avoid signature mistakes.

## 13) Quick “choose your path” guide

- **I want market metadata and prices:** Gamma API + CLOB public endpoints + market websocket.
- **I want to trade my own account programmatically:** CLOB client with L1+L2, user websocket.
- **I’m building an app routing user orders:** Builder program (order attribution), remote signing server, optional relayer for gasless operations.
- **I’m market making:** websockets + inventory management (CTF split/merge/redeem), likely relayer for batching/gas.

---

## Appendix A: Source docs referenced
- Developer quickstart overview, endpoints, rate limits
- CLOB: introduction, authentication, quickstart, orders (place/cancel), websocket overview + market/user channels
- Gamma: overview, structure, fetching markets
- Data API (core): positions, trades, activity
- CTF: overview, split, redeem
- Builders: relayer client, order attribution
- Market makers: introduction, data feeds, inventory
