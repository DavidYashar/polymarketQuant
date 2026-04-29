import fs from "node:fs";
import path from "node:path";

export interface LogTeeOptions {
  logDir: string;
  baseName?: string;
  rotateHours?: number;
  useUtc?: boolean;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function bucketStart(d: Date, rotateHours: number, useUtc: boolean): Date {
  const year = useUtc ? d.getUTCFullYear() : d.getFullYear();
  const month = (useUtc ? d.getUTCMonth() : d.getMonth());
  const day = useUtc ? d.getUTCDate() : d.getDate();
  const hour = useUtc ? d.getUTCHours() : d.getHours();

  const bucketHour = Math.floor(hour / rotateHours) * rotateHours;

  const out = new Date(d.getTime());
  if (useUtc) {
    out.setUTCFullYear(year, month, day);
    out.setUTCHours(bucketHour, 0, 0, 0);
  } else {
    out.setFullYear(year, month, day);
    out.setHours(bucketHour, 0, 0, 0);
  }

  return out;
}

function nextBucketMs(now: Date, rotateHours: number, useUtc: boolean): number {
  const start = bucketStart(now, rotateHours, useUtc).getTime();
  return start + rotateHours * 60 * 60 * 1000;
}

function fileNameForBucket(start: Date, baseName: string, useUtc: boolean): string {
  const yyyy = useUtc ? start.getUTCFullYear() : start.getFullYear();
  const mm = pad2((useUtc ? start.getUTCMonth() : start.getMonth()) + 1);
  const dd = pad2(useUtc ? start.getUTCDate() : start.getDate());
  const hh = pad2(useUtc ? start.getUTCHours() : start.getHours());
  const tz = useUtc ? "Z" : "";
  return `${baseName}_${yyyy}-${mm}-${dd}_${hh}00${tz}.log`;
}

export function installRotatingLogTee(options: LogTeeOptions): { currentPath: () => string; stop: () => void } {
  const {
    logDir,
    baseName = "bot",
    rotateHours = 4,
    useUtc = false,
  } = options;

  fs.mkdirSync(logDir, { recursive: true });

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  let stream: fs.WriteStream | null = null;
  let currentLogPath = "";
  let timer: NodeJS.Timeout | null = null;

  function openForNow() {
    const now = new Date();
    const start = bucketStart(now, rotateHours, useUtc);
    const fileName = fileNameForBucket(start, baseName, useUtc);
    const filePath = path.join(logDir, fileName);

    if (filePath === currentLogPath && stream) return;

    try {
      stream?.end();
    } catch {
      // ignore
    }

    stream = fs.createWriteStream(filePath, { flags: "a" });
    currentLogPath = filePath;

    const header = `\n===== log opened ${now.toISOString()} (rotateHours=${rotateHours}, useUtc=${useUtc}) =====\n`;
    stream.write(header);

    const nextMs = nextBucketMs(now, rotateHours, useUtc);
    const delay = Math.max(1_000, nextMs - now.getTime());

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      openForNow();
    }, delay);
    timer.unref?.();
  }

  function writeToLog(chunk: any) {
    if (!stream) return;
    try {
      stream.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
    } catch {
      // ignore
    }
  }

  // Install tee
  (process.stdout as any).write = (chunk: any, encoding?: any, cb?: any) => {
    originalStdoutWrite(chunk, encoding, cb);
    writeToLog(chunk);
    return true;
  };

  (process.stderr as any).write = (chunk: any, encoding?: any, cb?: any) => {
    originalStderrWrite(chunk, encoding, cb);
    writeToLog(chunk);
    return true;
  };

  openForNow();

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      stream?.end();
    } catch {
      // ignore
    }
    stream = null;

    // Best-effort restore
    (process.stdout as any).write = originalStdoutWrite;
    (process.stderr as any).write = originalStderrWrite;
  }

  return {
    currentPath: () => currentLogPath,
    stop,
  };
}
