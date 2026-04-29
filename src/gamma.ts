import { httpJson } from "./http.js";
import type { GammaMarket } from "./types.js";

export interface ListMarketsParams {
  tagId: number;
  sportsMarketTypes: string[];
  closed: boolean;
  activeOnly: boolean;
  limit: number;
  offset: number;
  order?: string;
  ascending?: boolean;
}

export class GammaClient {
  constructor(private readonly host: string) {}

  async getMarketById(marketId: string): Promise<GammaMarket> {
    const url = new URL(`/markets/${marketId}`, this.host);
    return await httpJson<GammaMarket>(url.toString());
  }

  async listMarkets(params: ListMarketsParams): Promise<GammaMarket[]> {
    const url = new URL("/markets", this.host);
    url.searchParams.set("tag_id", String(params.tagId));
    url.searchParams.set("closed", String(params.closed));
    url.searchParams.set("limit", String(params.limit));
    url.searchParams.set("offset", String(params.offset));

    if (params.activeOnly) url.searchParams.set("active", "true");

    for (const t of params.sportsMarketTypes) {
      // API accepts sports_market_types as string[]; repeated query key works.
      url.searchParams.append("sports_market_types", t);
    }

    if (params.order) url.searchParams.set("order", params.order);
    if (typeof params.ascending === "boolean") url.searchParams.set("ascending", String(params.ascending));

    return await httpJson<GammaMarket[]>(url.toString());
  }

  async listAllMarkets(params: Omit<ListMarketsParams, "offset">): Promise<GammaMarket[]> {
    const out: GammaMarket[] = [];

    for (let offset = 0; ; offset += params.limit) {
      const page = await this.listMarkets({ ...params, offset });
      if (!page.length) break;
      out.push(...page);
      if (page.length < params.limit) break;
    }

    return out;
  }
}
