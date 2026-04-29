import { ClobClient } from "@polymarket/clob-client";
import type { ClobTopOfBook } from "./types.js";

export function createPublicClobClient(host: string, chainId: number): ClobClient {
  return new ClobClient(host, chainId);
}

export async function fetchTopOfBook(
  clobHost: string,
  tokenId: string
): Promise<ClobTopOfBook | null> {
  const url = `${clobHost.replace(/\/$/, "")}/book?token_id=${encodeURIComponent(tokenId)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "polymarketBot/0.1",
      },
    });
  } catch {
    return null;
  }

  // Common/expected: some tokens simply have no orderbook.
  if (resp.status === 404) return null;
  if (!resp.ok) return null;

  let book: any;
  try {
    book = await resp.json();
  } catch {
    return null;
  }

  if (book && typeof book === "object" && typeof book.error === "string") return null;

  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const bestBid = bids.length ? Number(bids[0]!.price) : 0;
  const bestBidSize = bids.length ? Number(bids[0]!.size) : 0;
  const bestAsk = asks.length ? Number(asks[0]!.price) : 1;
  const bestAskSize = asks.length ? Number(asks[0]!.size) : 0;

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;

  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  return {
    tokenId,
    bestBid,
    bestBidSize: Number.isFinite(bestBidSize) ? bestBidSize : 0,
    bestAsk,
    bestAskSize: Number.isFinite(bestAskSize) ? bestAskSize : 0,
    mid,
    spread,
    ts: Date.now(),
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}
