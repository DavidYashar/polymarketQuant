import fs from "node:fs";
import path from "node:path";

export type LogEventType =
  | "error"
  | "ingest_league"
  | "clob_enrich_start"
  | "clob_enrich_done"
  | "snapshot_written";

function dayKeyUtc(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export class JsonlLogger {
  constructor(private readonly dir: string) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  log(type: LogEventType, data: Record<string, unknown>, ts = Date.now()): void {
    const file = path.join(this.dir, `${dayKeyUtc(ts)}.jsonl`);
    const line = JSON.stringify({ ts, type, ...data });
    fs.appendFileSync(file, line + "\n");
  }
}
