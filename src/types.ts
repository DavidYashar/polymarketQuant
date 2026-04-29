export type LeagueKey = "nfl" | "nba" | "epl" | "laLiga" | "bundesliga" | "serieA";

// Gamma API types (partial; we only model what we need)
export interface GammaTag {
  id: string;
  label?: string | null;
  slug?: string | null;
}

export interface GammaEvent {
  id: string;
  ticker?: string | null;
  slug?: string | null;
  title?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  // Sports event runtime state (present in many /markets responses)
  startTime?: string | null;
  live?: boolean | null;
  ended?: boolean | null;
  elapsed?: string | null;
  period?: string | null;
  score?: string | null;
  seriesSlug?: string | null;
}

export interface GammaMarket {
  id: string;
  question?: string | null;
  slug?: string | null;
  conditionId: string;

  // Gamma uses these names in practice for sports markets
  endDate?: string | null;
  startDate?: string | null;

  // Sports timings (often better than startDate for game kickoff)
  gameStartTime?: string | null;

  // Back-compat aliases (some older docs/schemas use *Iso)
  endDateIso?: string | null;
  startDateIso?: string | null;

  // Sports
  sportsMarketType?: string | null;
  gameId?: string | null;

  // Liquidity/volume (Gamma provides both string and numeric versions)
  volume?: string | null;
  liquidity?: string | null;
  volumeNum?: number | null;
  liquidityNum?: number | null;
  volume24hr?: number | null;

  // Book-ish hints (may be stale)
  bestBid?: number | null;
  bestAsk?: number | null;
  spread?: number | null;
  lastTradePrice?: number | null;

  // Outcomes + tokens are often JSON-encoded strings
  outcomes?: string | null; // JSON string array
  outcomePrices?: string | null; // JSON string array
  clobTokenIds?: string | null; // JSON string array
  shortOutcomes?: string | null; // JSON string array

  acceptingOrders?: boolean | null;
  active?: boolean | null;
  closed?: boolean | null;

  tags?: GammaTag[] | null;

  // Grouping (commonly used in sports)
  groupItemTitle?: string | null;

  // Event metadata (Gamma embeds events in many responses)
  events?: GammaEvent[] | null;
}

export interface ClobTopOfBook {
  tokenId: string;
  bestBid: number;
  bestBidSize: number;
  bestAsk: number;
  bestAskSize: number;
  mid: number;
  spread: number;
  ts: number;
}

export interface EnrichedMarket {
  league: LeagueKey;
  market: GammaMarket;

  tokenIds: string[];
  outcomes?: string[];
  outcomePrices?: number[];

  // Optional CLOB enrichment per token
  clob?: Record<string, ClobTopOfBook | null>;
}

export interface Snapshot {
  ts: number;
  source: {
    gammaHost: string;
    clobHost: string;
  };
  filters: {
    leagues: Record<string, { tagId: number; label: string }>;
    sportsMarketTypes: string[];
    closed: boolean;
    activeOnly: boolean;
  };
  counts: {
    markets: number;
    leagues: Record<string, number>;
  };
  markets: EnrichedMarket[];
}
