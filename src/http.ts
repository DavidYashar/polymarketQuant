export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function httpJson<T>(
  url: string,
  init?: RequestInit,
  options: HttpOptions = {}
): Promise<T> {
  const {
    timeoutMs = 25_000,
    retries = 3,
    retryDelayMs = 500,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has("accept")) headers.set("accept", "application/json");
      if (!headers.has("user-agent")) headers.set("user-agent", "polymarketBot/0.1");

      const resp = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}${text ? `: ${text.slice(0, 500)}` : ""}`);
      }

      return (await resp.json()) as T;
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      await sleep(retryDelayMs * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function parseJsonArrayString(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export function parseJsonNumberArrayString(value: string | null | undefined): number[] {
  const arr = parseJsonArrayString(value);
  const nums = arr.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  return nums;
}
