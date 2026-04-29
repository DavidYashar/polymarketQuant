import "dotenv/config";

import { config } from "./config.js";
import { initClobClient } from "./liveClob.js";
import { Side } from "@polymarket/clob-client/dist/types";

function mustGetEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dateIdx = args.findIndex((a) => a === "--date");
  const date = dateIdx >= 0 ? args[dateIdx + 1] : undefined;
  return { date };
}

function isoRangeForUtcDate(dateUtc: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) {
    throw new Error(`Invalid --date, expected YYYY-MM-DD (UTC): ${dateUtc}`);
  }
  return {
    start: `${dateUtc}T00:00:00.000Z`,
    end: `${dateUtc}T23:59:59.999Z`,
  };
}

function unixSecondsRangeForUtcDate(dateUtc: string): { after: string; before: string } {
  const { start, end } = isoRangeForUtcDate(dateUtc);
  const after = Math.floor(Date.parse(start) / 1000);
  const before = Math.floor(Date.parse(end) / 1000);
  if (!Number.isFinite(after) || !Number.isFinite(before)) {
    throw new Error(`Failed to compute unix timestamp range for date: ${dateUtc}`);
  }
  return { after: String(after), before: String(before) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
  const { date } = parseArgs();
  const dateUtc = date ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { start, end } = isoRangeForUtcDate(dateUtc);
  const { after, before } = unixSecondsRangeForUtcDate(dateUtc);

  const privateKey = mustGetEnv("PRIVATE_KEY");
  const signatureType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funderAddress = process.env.POLY_FUNDER_ADDRESS?.trim() || undefined;

  const { client } = await initClobClient({
    host: config.clobHost,
    chainId: config.chainId,
    privateKey,
    signatureType,
    funderAddress,
    auth: {
      key: process.env.POLY_API_KEY?.trim(),
      secret: process.env.POLY_API_SECRET?.trim(),
      passphrase: process.env.POLY_API_PASSPHRASE?.trim(),
    },
  });

  // Polymarket CLOB trades endpoint supports `after`/`before` params.
  const trades = (await client.getTrades({ after, before })) as Array<any>;

  let buyUsd = 0;
  let sellUsd = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const t of trades) {
    const side = String(t?.side ?? "").toUpperCase();
    const size = Number(t?.size ?? 0);
    const price = Number(t?.price ?? 0);
    if (!(Number.isFinite(size) && Number.isFinite(price))) continue;
    const usd = size * price;
    if (side === Side.BUY) {
      buyUsd += usd;
      buyCount++;
    } else if (side === Side.SELL) {
      sellUsd += usd;
      sellCount++;
    }
  }

  const netUsd = sellUsd - buyUsd;

  const byMarket = new Map<string, { count: number; buyUsd: number; sellUsd: number }>();
  for (const t of trades) {
    const market = String(t?.market ?? "unknown");
    const side = String(t?.side ?? "").toUpperCase();
    const size = Number(t?.size ?? 0);
    const price = Number(t?.price ?? 0);
    if (!(Number.isFinite(size) && Number.isFinite(price))) continue;
    const usd = size * price;
    const cur = byMarket.get(market) ?? { count: 0, buyUsd: 0, sellUsd: 0 };
    cur.count++;
    if (side === Side.BUY) cur.buyUsd += usd;
    if (side === Side.SELL) cur.sellUsd += usd;
    byMarket.set(market, cur);
  }

  const topMarkets = [...byMarket.entries()]
    .map(([market, v]) => ({ market, count: v.count, buyUsd: v.buyUsd, sellUsd: v.sellUsd, netUsd: v.sellUsd - v.buyUsd }))
    .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))
    .slice(0, 10)
    .map((x) => ({
      market: x.market,
      count: x.count,
      buyUsd: round2(x.buyUsd),
      sellUsd: round2(x.sellUsd),
      netUsd: round2(x.netUsd),
    }));

  console.log(
    JSON.stringify(
      {
        dateUtc,
        range: { start, end },
        unixRange: { after, before },
        trades: {
          count: trades.length,
          buyCount,
          sellCount,
          buyUsd: round2(buyUsd),
          sellUsd: round2(sellUsd),
          netUsd: round2(netUsd),
          note:
            "netUsd = sells - buys for trades matched in this UTC day (unrealized PnL not included; fees may be excluded depending on how Polymarket charges maker/taker).",
        },
        topMarketsByAbsNet: topMarkets,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
