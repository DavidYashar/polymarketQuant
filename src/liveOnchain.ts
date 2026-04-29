import { ethers } from "ethers";
import { getContractConfig } from "@polymarket/clob-client";

const ERC1155_ABI = ["function balanceOf(address account, uint256 id) view returns (uint256)"];

function extractJsonRpcError(err: any): { code?: number; message?: string; raw?: string } {
  const message = err?.error?.message ?? err?.message;
  const body = err?.error?.body ?? err?.body;

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      const code = parsed?.error?.code;
      const msg = parsed?.error?.message;
      return {
        code: typeof code === "number" ? code : undefined,
        message: typeof msg === "string" ? msg : (typeof message === "string" ? message : undefined),
        raw: typeof message === "string" ? message : undefined,
      };
    } catch {
      // ignore parse failures
    }
  }

  return {
    code: typeof err?.error?.code === "number" ? err.error.code : undefined,
    message: typeof message === "string" ? message : undefined,
    raw: typeof message === "string" ? message : undefined,
  };
}

function isEthCallNotSupported(err: any): boolean {
  const { code, message, raw } = extractJsonRpcError(err);
  const hay = `${message ?? ""}\n${raw ?? ""}`.toLowerCase();

  // JSON-RPC -32601 = Method not found (common for providers that disable eth_call)
  if (code === -32601 && hay.includes("eth_call")) return true;

  // Ethers/drpc style
  if (hay.includes("eth_call") && hay.includes("does not exist")) return true;
  if (hay.includes("eth_call") && hay.includes("not available")) return true;
  if (hay.includes("the method eth_call") && hay.includes("is not available")) return true;

  return false;
}

function isRateLimitError(err: any): boolean {
  const { code, message, raw } = extractJsonRpcError(err);
  const hay = `${message ?? ""}\n${raw ?? ""}`.toLowerCase();
  // Polygon public RPC often returns -32090 with message: "Too many requests... retry in 10s"
  if (code === -32090) return true;
  if (hay.includes("too many requests")) return true;
  if (hay.includes("rate limit")) return true;
  if (hay.includes("call rate limit exhausted")) return true;
  return false;
}

function parseRetryAfterMs(err: any): number {
  const { message, raw } = extractJsonRpcError(err);
  const hay = `${message ?? ""}\n${raw ?? ""}`;
  const m = hay.match(/retry\s+in\s+(\d+)s/i);
  if (m) {
    const sec = Number(m[1]);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  return 10_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class ThrottledRetryingStaticJsonRpcProvider extends ethers.providers.StaticJsonRpcProvider {
  private queue: Promise<unknown> = Promise.resolve();
  private lastStartMs = 0;
  constructor(
    url: string,
    network: ethers.providers.Network,
    private readonly throttleMs: number,
    private readonly maxRetries: number,
  ) {
    super(url, network);
  }

  async perform(method: string, params: any): Promise<any> {
    // Serialize requests to avoid hammering rate-limited public RPCs.
    // Ensure the queue continues even if a prior request failed.
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.throttleMs - (now - this.lastStartMs));
      if (wait > 0) await sleep(wait);
      this.lastStartMs = Date.now();

      let lastErr: any;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          return await super.perform(method, params);
        } catch (err: any) {
          lastErr = err;
          if (!isRateLimitError(err) || attempt === this.maxRetries) throw err;
          const baseDelay = parseRetryAfterMs(err);
          const jitter = Math.floor(Math.random() * 500);
          const delay = baseDelay + jitter;
          console.warn(`[onchain] rate-limited on ${method} (attempt ${attempt}/${this.maxRetries}); sleeping ${delay}ms`);
          await sleep(delay);
        }
      }
      throw lastErr;
    });

    return (await this.queue) as any;
  }
}

export function getProvider(rpcUrl: string): ethers.providers.Provider {
  const polygonNetwork = { name: "matic", chainId: 137 };
  const throttleMsRaw = process.env.POLYGON_RPC_THROTTLE_MS?.trim();
  const throttleMs = throttleMsRaw ? Number(throttleMsRaw) : 250;
  const maxRetriesRaw = process.env.POLYGON_RPC_MAX_RETRIES?.trim();
  const maxRetries = maxRetriesRaw ? Number(maxRetriesRaw) : 5;

  return rpcUrl.startsWith("wss://")
    ? new ethers.providers.WebSocketProvider(rpcUrl, polygonNetwork)
    : new ThrottledRetryingStaticJsonRpcProvider(
        rpcUrl,
        polygonNetwork,
        Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : 250,
        Number.isFinite(maxRetries) && maxRetries >= 1 ? Math.floor(maxRetries) : 5,
      );
}

export async function closeProvider(provider: ethers.providers.Provider): Promise<void> {
  const anyProv: any = provider as any;
  if (typeof anyProv.destroy === "function") {
    try {
      await anyProv.destroy();
    } catch {
      // ignore
    }
  }
}

export function getConditionalTokensContract(chainId: number, provider: ethers.providers.Provider): ethers.Contract {
  const contracts = getContractConfig(chainId as 137 | 80002);
  return new ethers.Contract(contracts.conditionalTokens, ERC1155_ABI, provider);
}

export async function getErc1155BalanceBase(opts: {
  conditionalTokens: ethers.Contract;
  account: string;
  tokenId: string;
}): Promise<ethers.BigNumber> {
  const maxRetries = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return (await opts.conditionalTokens.balanceOf(opts.account, opts.tokenId)) as ethers.BigNumber;
    } catch (err: any) {
      lastErr = err;

      // If the RPC endpoint doesn't support eth_call at all, retrying won't help.
      if (isEthCallNotSupported(err)) {
        const { message, raw } = extractJsonRpcError(err);
        const details = (message ?? raw ?? "").trim();
        throw new Error(
          `RPC endpoint does not support eth_call (required for on-chain balance checks). ` +
            `Set POLYGON_RPC_URL to a Polygon JSON-RPC endpoint that supports eth_call (e.g. https://polygon-rpc.com).` +
            (details ? ` Underlying error: ${details}` : "")
        );
      }

      if (attempt < maxRetries) {
        const delay = 1000 * attempt;
        console.warn(`[onchain] balanceOf attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export function baseToShares6(base: ethers.BigNumber): number {
  const shares = Number(ethers.utils.formatUnits(base, 6));
  return Number.isFinite(shares) ? shares : 0;
}
