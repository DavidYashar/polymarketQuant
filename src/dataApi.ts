export interface DataApiPosition {
  asset: string; // tokenId (ERC-1155 id as decimal string)
  conditionId: string;
  size: number; // shares held
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  curPrice: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  redeemable: boolean;
  mergeable: boolean;
  negativeRisk: boolean;
  proxyWallet?: string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  eventId?: string;
  endDate?: string;
}

export async function fetchPositions(opts: {
  user: string;
  redeemable?: boolean;
  sizeThreshold?: number;
}): Promise<DataApiPosition[]> {
  const redeemableStr = typeof opts.redeemable === "boolean" ? String(opts.redeemable) : undefined;
  const sizeThreshold = typeof opts.sizeThreshold === "number" ? opts.sizeThreshold : 0;

  const url = new URL("https://data-api.polymarket.com/positions");
  url.searchParams.set("user", opts.user);
  if (redeemableStr) url.searchParams.set("redeemable", redeemableStr);
  url.searchParams.set("sizeThreshold", String(sizeThreshold));

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: { accept: "application/json", "user-agent": "polymarketBot/0.1" },
    });
  } catch (err: any) {
    console.error(`[dataApi] fetch failed: ${err?.message ?? err}`);
    return [];
  }

  if (!resp.ok) {
    console.error(`[dataApi] ${resp.status} ${resp.statusText}: ${await resp.text().catch(() => "")}`);
    return [];
  }

  const data = await resp.json();
  if (!Array.isArray(data)) {
    console.error(`[dataApi] unexpected response (not array)`);
    return [];
  }

  return data as DataApiPosition[];
}

export function isMeaningfulPosition(p: DataApiPosition, minShares: number): boolean {
  const s = Number(p.size);
  return Number.isFinite(s) && Math.abs(s) >= minShares;
}

export function positionLabel(p: DataApiPosition): string {
  return (p.title ?? p.slug ?? p.conditionId).toString();
}
