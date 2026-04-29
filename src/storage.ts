import fs from "node:fs";
import path from "node:path";
import type { Snapshot } from "./types.js";

function tsKeyUtc(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}Z`;
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeSnapshot(dataDir: string, snapshot: Snapshot): string {
  ensureDir(dataDir);
  const fileName = `sports_snapshot_${tsKeyUtc(snapshot.ts)}.json`;
  const filePath = path.join(dataDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  return filePath;
}
