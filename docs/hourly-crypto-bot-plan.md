# Hourly Crypto Markets Bot - Implementation Plan

## Overview

This document outlines the changes needed to adapt the bot from 15-minute BTC markets to hourly crypto markets (BTC, ETH, SOL, XRP).

**Created**: January 21, 2026  
**Status**: Planning - Not yet implemented

---

## Market Structure

### Coins Supported
| Coin | Slug Pattern | Hyperliquid Symbol |
|------|-------------|-------------------|
| Bitcoin | `bitcoin-up-or-down-{month}-{day}-{hour}{am/pm}-et` | BTC |
| Ethereum | `ethereum-up-or-down-{month}-{day}-{hour}{am/pm}-et` | ETH |
| Solana | `solana-up-or-down-{month}-{day}-{hour}{am/pm}-et` | SOL |
| XRP | `xrp-up-or-down-{month}-{day}-{hour}{am/pm}-et` | XRP |

### Example Slugs (January 20, 4PM ET)
- `bitcoin-up-or-down-january-20-4pm-et`
- `ethereum-up-or-down-january-20-4pm-et`
- `solana-up-or-down-january-20-4pm-et`
- `xrp-up-or-down-january-20-4pm-et`

### Market Details
- **Outcomes**: "Up" / "Down" (NOT "Yes"/"No")
- **Resolution**: Based on Binance 1-hour candle
  - "Up" wins if: Close >= Open
  - "Down" wins if: Close < Open
- **Min Order Size**: $5 (orderbook), but $1 works for market orders
- **Tick Size**: 0.01
- **Timezone**: Eastern Time (ET)

### API Endpoints

**Gamma API (Market Discovery)**
```
GET https://gamma-api.polymarket.com/events/slug/{slug}
```

**CLOB API (Orderbook/Trading)**
```
GET https://clob.polymarket.com/book?token_id={token_id}
```

**Token IDs**
- Extracted from market response: `clobTokenIds` field
- Format: `["{up_token_id}", "{down_token_id}"]`

---

## Verified API Response (January 20, 4PM ET Markets)

### Bitcoin
```json
{
  "slug": "bitcoin-up-or-down-january-20-4pm-et",
  "outcomes": "[\"Up\", \"Down\"]",
  "clobTokenIds": "[\"106507265189761048745459424799044259570656679718136930298423445451003299989740\", \"75587057952760705567124770437197620702228968284537472873998920358400990692032\"]",
  "acceptingOrders": true
}
```

### Ethereum
```json
{
  "slug": "ethereum-up-or-down-january-20-4pm-et",
  "clobTokenIds": "[\"28200146035654970245313670744205935421452578627044574540034775720398149341773\", \"20007385475824118852781437937865702025574414038159971467164524619590935993312\"]"
}
```

### Solana
```json
{
  "slug": "solana-up-or-down-january-20-4pm-et",
  "clobTokenIds": "[\"50264145873277848463985987130120461744854317062961339645926246660147756212639\", \"108438236730822447549494612403019962096551132490354809639959405601081602207241\"]"
}
```

### XRP
```json
{
  "slug": "xrp-up-or-down-january-20-4pm-et",
  "clobTokenIds": "[\"43879428203446976267182495102017977037893637630024239312471404747990605873863\", \"89291309565578665018350512049422649326157640491374114613006754716751405537262\"]"
}
```

All orderbooks verified working with good liquidity.

---

## Trading Strategy

### Key Insight
The hourly market resolves based on whether the Binance 1-hour candle closes above or below its open:
- If `Close >= Open` → "Up" wins
- If `Close < Open` → "Down" wins

### Prediction Factors

#### 1. Position Relative to Hourly Open (40% weight)
```python
# Get the current hour's open price from Binance/Hyperliquid
hourly_open = get_hourly_candle_open(coin)
current_price = get_current_price(coin)

position_pct = (current_price - hourly_open) / hourly_open * 100

# If we're +0.3% above open, we have a "buffer" for Up to win
# If we're -0.3% below open, Down is currently winning
```

#### 2. Momentum Indicators (35% weight)
Using 15-minute candles:
- Momentum signal (8 candle lookback = 2 hours)
- EMA crossover (fast=4, slow=12)
- Price action patterns

#### 3. RSI/Volume (25% weight)
- RSI for mean reversion signals
- Volume-weighted direction

### Timing Considerations
- **Early in hour (55+ min left)**: Position vs open less reliable, weight momentum more
- **Mid hour (30-55 min left)**: Balanced weighting
- **Late in hour (<30 min left)**: Position vs open more reliable, reduce momentum weight

---

## Technical Changes Required

### 1. Environment Variables (.env)
```bash
# Change from 1m to 15m candles
CANDLE_INTERVAL=15m
CANDLE_HISTORY_HOURS=8

# Bet size (market orders accept $1, but $5 safer)
BET_SIZE_USDC=5.0

# Trading interval (hourly instead of 15-min)
TRADE_INTERVAL_SECONDS=3600
```

### 2. New Market Scanner Module
Create `hourly_scanner.py`:
```python
COINS = ["BTC", "ETH", "SOL", "XRP"]

def get_hourly_slug(coin: str, target_hour: datetime) -> str:
    """Generate slug for a given coin and hour."""
    month = target_hour.strftime("%B").lower()  # january
    day = target_hour.day  # 20
    hour = target_hour.hour
    
    if hour == 0:
        hour_str = "12am"
    elif hour < 12:
        hour_str = f"{hour}am"
    elif hour == 12:
        hour_str = "12pm"
    else:
        hour_str = f"{hour - 12}pm"
    
    coin_name = {
        "BTC": "bitcoin",
        "ETH": "ethereum", 
        "SOL": "solana",
        "XRP": "xrp"
    }[coin]
    
    return f"{coin_name}-up-or-down-{month}-{day}-{hour_str}-et"
```

### 3. Hyperliquid Client Updates
```python
def get_hourly_candle_open(self, coin: str) -> Optional[float]:
    """Get the open price of the current hourly candle."""
    candles = self.get_candles(coin, interval="1h", hours_back=1)
    if candles:
        return float(candles[-1].get("o", candles[-1].get("open", 0)))
    return None
```

### 4. Signal Module Updates
Adjust lookback periods for 15m candles:
```python
# Old (1m candles for 15-min prediction)
momentum_signal(candles, lookback=15)  # 15 minutes
rsi_signal(candles, period=14)  # 14 minutes
ema_crossover_signal(candles, fast=5, slow=15)

# New (15m candles for hourly prediction)
momentum_signal(candles, lookback=8)  # 2 hours (8 * 15min)
rsi_signal(candles, period=14)  # 3.5 hours (14 * 15min)
ema_crossover_signal(candles, fast=4, slow=12)  # 1h vs 3h
```

### 5. New Prediction Function
```python
def predict_hourly_direction(
    candles_15m: List[Dict],
    hourly_open: float,
    current_price: float,
    minutes_remaining: int
) -> PredictionResult:
    """
    Predict if coin will close above (Up) or below (Down) its hourly open.
    
    Args:
        candles_15m: 15-minute candles for momentum analysis
        hourly_open: The open price of the current hourly candle
        current_price: Current market price
        minutes_remaining: Minutes until hour closes
    """
    # Position vs hourly open
    position_pct = (current_price - hourly_open) / hourly_open * 100
    
    # Momentum from 15m candles
    momentum = momentum_signal(candles_15m, lookback=8)
    ema_signal = ema_crossover_signal(candles_15m, fast=4, slow=12)
    
    # Adjust weights based on time remaining
    if minutes_remaining > 45:
        # Early: momentum matters more
        position_weight = 0.30
        momentum_weight = 0.50
    elif minutes_remaining > 20:
        # Mid: balanced
        position_weight = 0.40
        momentum_weight = 0.40
    else:
        # Late: position is more reliable
        position_weight = 0.55
        momentum_weight = 0.25
    
    other_weight = 1.0 - position_weight - momentum_weight
    
    # Convert position to signal
    position_signal = max(-1, min(1, position_pct * 3))  # 0.33% = full signal
    
    # Combined score
    combined = (
        position_weight * position_signal +
        momentum_weight * momentum +
        other_weight * ema_signal
    )
    
    direction = "UP" if combined > 0 else "DOWN"
    confidence = min(1.0, abs(combined) * 1.5)
    
    return PredictionResult(
        direction=direction,
        confidence=confidence,
        signals={
            "position_pct": position_pct,
            "position_signal": position_signal,
            "momentum": momentum,
            "ema": ema_signal,
            "combined": combined
        },
        reason=f"Position: {position_pct:.2f}%, Momentum: {momentum:.2f}"
    )
```

### 6. Main Bot Loop
```python
async def run_hourly_bot():
    """Main bot loop for hourly crypto markets."""
    
    COINS = ["BTC", "ETH", "SOL", "XRP"]
    
    while True:
        # Wait until X:05 of each hour (market should be open)
        await wait_until_next_hour_plus_5_min()
        
        for coin in COINS:
            try:
                # 1. Find the market for current hour
                slug = get_hourly_slug(coin, datetime.now(ET))
                market = fetch_market(slug)
                
                if not market or not market.get("acceptingOrders"):
                    log(f"Market not available for {coin}")
                    continue
                
                # 2. Get hourly candle open (from Binance via Hyperliquid)
                hourly_open = hyperliquid.get_hourly_candle_open(coin)
                current_price = hyperliquid.get_current_price(coin)
                
                # 3. Get 15m candles for analysis
                candles = hyperliquid.get_candles(coin, interval="15m", hours_back=6)
                
                # 4. Predict direction
                minutes_remaining = 55  # Betting early in the hour
                prediction = predict_hourly_direction(
                    candles, hourly_open, current_price, minutes_remaining
                )
                
                # 5. Place bet
                if prediction.confidence >= MIN_CONFIDENCE:
                    outcome = "Up" if prediction.direction == "UP" else "Down"
                    place_bet(market, outcome, BET_SIZE)
                
            except Exception as e:
                log(f"Error trading {coin}: {e}")
        
        # Wait 1 hour before next round
        await asyncio.sleep(3600)
```

---

## File Changes Summary

| File | Changes |
|------|---------|
| `.env` | CANDLE_INTERVAL=15m, CANDLE_HISTORY_HOURS=8, BET_SIZE=5 |
| `hyperliquid_client.py` | Add `get_hourly_candle_open()` method |
| `signal.py` | Add `predict_hourly_direction()`, adjust lookback periods |
| `hourly_scanner.py` | NEW: Market discovery for 4 coins |
| `main_hourly.py` | NEW: Main bot loop for hourly trading |
| `execution.py` | Update to handle "Up"/"Down" outcomes (not "Yes"/"No") |

---

## Testing Checklist

- [ ] Verify slug generation for different hours/dates
- [ ] Test API calls to Gamma for all 4 coins
- [ ] Verify orderbook access for all token IDs
- [ ] Test Hyperliquid 15m and 1h candle fetching
- [ ] Validate prediction logic with historical data
- [ ] Paper trade for 1 day before going live
- [ ] Verify bet placement with "Up"/"Down" outcomes

---

## Risk Management

- **Daily Loss Limit**: 30% of starting balance (same as 15m bot)
- **Bet Size**: $5 per trade
- **Max Trades/Hour**: 4 (one per coin)
- **Max Daily Trades**: ~64 (4 coins × 16 trading hours)
- **Max Daily Risk**: $320 if all bets lose

---

## Notes

- Markets use **Eastern Time (ET)** for hour naming
- Polymarket website: https://polymarket.com/crypto/hourly
- Series slugs:
  - BTC: `btc-up-or-down-hourly`
  - ETH: `eth-up-or-down-hourly`
  - SOL: `sol-up-or-down-hourly`
  - XRP: `xrp-up-or-down-hourly`
