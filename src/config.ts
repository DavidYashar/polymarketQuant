import dotenv from "dotenv";

dotenv.config();

function envString(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing env var ${name}`);
  return value;
}

function envNumber(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`Missing env var ${name}`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return value;
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? fallback).toString().trim() as T;
  if ((allowed as readonly string[]).includes(raw)) return raw;
  return fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = raw.toString().trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

export const config = {
  gammaHost: envString("GAMMA_HOST", "https://gamma-api.polymarket.com"),
  clobHost: envString("CLOB_HOST", "https://clob.polymarket.com"),
  chainId: envNumber("CHAIN_ID", 137),

  tradingMode: "live" as const,

  // Ingestion scope
  leagues: {
    nfl: { tagId: envNumber("TAG_NFL", 450), label: "NFL" },
    nba: { tagId: envNumber("TAG_NBA", 745), label: "NBA" },
    epl: { tagId: envNumber("TAG_EPL", 82), label: "EPL" },
    laLiga: { tagId: envNumber("TAG_LA_LIGA", 780), label: "La Liga" },
    bundesliga: { tagId: envNumber("TAG_BUNDESLIGA", 1494), label: "Bundesliga" },
    serieA: { tagId: envNumber("TAG_SERIE_A", 101962), label: "Serie A" },
  },

  // Most sports “match winner” markets are moneyline.
  sportsMarketTypes: (process.env.SPORTS_MARKET_TYPES ?? "moneyline")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Gamma pagination
  pageLimit: envNumber("PAGE_LIMIT", 100),

  // Optional: enrich each token with CLOB top-of-book bid/ask.
  enrichClob: (process.env.ENRICH_CLOB ?? "true").toLowerCase() === "true",
  clobMaxConcurrent: envNumber("CLOB_MAX_CONCURRENT", 6),

  // Persistence
  logDir: envString("LOG_DIR", "logs"),
  snapshotDir: envString("SNAPSHOT_DIR", "logs/snapshots"),

  // Watch mode
  refreshSeconds: envNumber("REFRESH_SECONDS", 300),

  // General
  maxGamesPerRun: envNumber("MAX_GAMES_PER_RUN", 20),

  // Monitor exits
  monitorTakeProfitUsd: envNumber("MONITOR_TAKE_PROFIT_USD", 5),
  monitorSellHaircutPct: envNumber("MONITOR_SELL_HAIRCUT_PCT", 0.04),
  monitorHalfTimeMinute: envNumber("MONITOR_HALF_TIME_MINUTE", 44),
  monitorHalfTimeMinLossUsd: envNumber("MONITOR_HALF_TIME_MIN_LOSS_USD", 0),
  monitorNoSell: envBool("MONITOR_NO_SELL", false),

  // Live trading knobs (secrets are read by live scripts directly)
  liveDryRun: envBool("LIVE_DRY_RUN", false),
  liveMinutesAhead: envNumber("LIVE_MINUTES_AHEAD", 60),
  liveMaxEventsScan: envNumber("LIVE_MAX_EVENTS_SCAN", 1200),
  // Only place a new bet when the market's end timestamp is within the next N minutes
  // (and the event is not live). This is used as an "eligibility window".
  liveMinMinutesToFinish: envNumber("LIVE_MIN_MINUTES_TO_FINISH", 100),

  // Stake sizing: per-game stake = wallet balance × livePerGamePct
  // Bot stops placing bets when wallet < liveMinWalletUsd
  livePerGamePct: envNumber("LIVE_PER_GAME_PCT", 0.10),
  liveMinGameStakeUsd: envNumber("LIVE_MIN_GAME_STAKE_USD", 5),
  liveMaxGameStakeUsd: envNumber("LIVE_MAX_GAME_STAKE_USD", 100),
  liveMinWalletUsd: envNumber("LIVE_MIN_WALLET_USD", 50),
  liveMinLegStakeUsd: envNumber("LIVE_MIN_LEG_STAKE_USD", envNumber("MIN_BET_USD", 1)),

  liveSlippagePct: envNumber("LIVE_SLIPPAGE_PCT", 0.03),
  liveMaxBuyPrice: envNumber("LIVE_MAX_BUY_PRICE", 0.95),
  liveMinSellPrice: envNumber("LIVE_MIN_SELL_PRICE", 0.05),
} as const;

export type LeagueKey = keyof typeof config.leagues;
