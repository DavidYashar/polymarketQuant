import fs from "node:fs";
import path from "node:path";

function removeMatching(dir: string, prefix: string) {
  if (!fs.existsSync(dir)) return { dir, removed: 0 };
  const files = fs.readdirSync(dir);
  let removed = 0;
  for (const f of files) {
    if (f.startsWith(prefix) && f.endsWith(".json")) {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    }
  }
  return { dir, removed };
}

function main() {
  const dataDir = process.argv[2] ?? "data";
  const result = removeMatching(dataDir, "sports_snapshot_");
  console.log(`[cleanSnapshots] dir=${result.dir} removed=${result.removed}`);
}

main();
