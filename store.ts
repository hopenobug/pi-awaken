import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExitReason = "exit" | "stopped" | "timeout" | "lost";
export type JobExit = { code: number | null; reason: ExitReason; endedAt: number };
export type JobMeta = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  timeoutSec?: number;
  wakeOn?: string;
};
export type Job = JobMeta & { log: string; exit?: JobExit; matched?: string; delivered: boolean };
export type InboxMessage = { file: string; from?: string; text: string; at: number };
export type StartOptions = {
  command: string;
  cwd: string;
  name?: string;
  timeoutSec?: number;
  wakeOn?: string;
  env?: Record<string, string>;
};

export const wakeRoot = () => process.env.PI_WAKE_DIR || join(homedir(), ".pi", "wake");

const RUNNER = 'bash "$1"; c=$?; echo "$c" > "$2.tmp" && mv "$2.tmp" "$2"';
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function writeAtomic(path: string, data: string) {
  writeFileSync(`${path}.tmp`, data);
  renameSync(`${path}.tmp`, path);
}

function cleanLine(line: string): string {
  const visible = line.replace(ANSI, "").split("\r").filter((part) => part.length > 0).pop() ?? "";
  return visible.length > 400 ? `${visible.slice(0, 400)}…` : visible;
}

export function lastLines(text: string, count: number): string[] {
  const lines = text.split("\n").map(cleanLine);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-count);
}

export function defaultName(command: string): string {
  const first = command.trim().split("\n")[0].trim();
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

export class JobStore {
  readonly jobsDir: string;
  readonly inboxDir: string;

  constructor(
    readonly sessionId: string,
    readonly root = wakeRoot(),
  ) {
    this.jobsDir = join(root, sessionId, "jobs");
    this.inboxDir = join(root, sessionId, "inbox");
  }

  ensure() {
    mkdirSync(this.jobsDir, { recursive: true });
    mkdirSync(this.inboxDir, { recursive: true });
  }

  path(id: string, ext: string) {
    return join(this.jobsDir, `${id}.${ext}`);
  }

  private ids(): string[] {
    if (!existsSync(this.jobsDir)) return [];
    return readdirSync(this.jobsDir)
      .filter((file) => /^j\d+\.json$/.test(file))
      .map((file) => file.slice(0, -5))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }

  start(options: StartOptions): Job {
    if (options.wakeOn) new RegExp(options.wakeOn);
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      throw new Error(`Working directory does not exist: ${options.cwd}`);
    }
    this.ensure();
    const last = this.ids().pop();
    const id = `j${last ? Number(last.slice(1)) + 1 : 1}`;
    writeFileSync(this.path(id, "sh"), options.command);
    const fd = openSync(this.path(id, "log"), "a");
    let pid: number | undefined;
    try {
      const child = spawn("/bin/bash", ["-c", RUNNER, "pi-wake", this.path(id, "sh"), this.path(id, "exit")], {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, ...options.env, PI_WAKE_JOB_ID: id },
      });
      child.on("error", () => {});
      child.unref();
      pid = child.pid;
    } finally {
      closeSync(fd);
    }
    if (!pid) throw new Error("Failed to spawn bash");
    const meta: JobMeta = {
      id,
      name: options.name?.trim() || defaultName(options.command),
      command: options.command,
      cwd: options.cwd,
      pid,
      startedAt: Date.now(),
      timeoutSec: options.timeoutSec,
      wakeOn: options.wakeOn,
    };
    writeAtomic(this.path(id, "json"), JSON.stringify(meta));
    return this.get(id)!;
  }

  get(id: string): Job | undefined {
    if (!/^j\d+$/.test(id) || !existsSync(this.path(id, "json"))) return undefined;
    const meta = JSON.parse(readFileSync(this.path(id, "json"), "utf8")) as JobMeta;
    const matchedPath = this.path(id, "matched");
    return {
      ...meta,
      log: this.path(id, "log"),
      exit: this.readExit(id),
      matched: existsSync(matchedPath) ? readFileSync(matchedPath, "utf8") : undefined,
      delivered: existsSync(this.path(id, "delivered")),
    };
  }

  list(): Job[] {
    return this.ids().flatMap((id) => this.get(id) ?? []);
  }

  private readExit(id: string): JobExit | undefined {
    const path = this.path(id, "exit");
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8").trim();
    if (raw.startsWith("{")) return JSON.parse(raw) as JobExit;
    const code = Number.parseInt(raw, 10);
    return { code: Number.isNaN(code) ? null : code, reason: "exit", endedAt: statSync(path).mtimeMs };
  }

  finish(id: string, reason: ExitReason) {
    const exit: JobExit = { code: null, reason, endedAt: Date.now() };
    writeAtomic(this.path(id, "exit"), JSON.stringify(exit));
  }

  async stop(id: string, reason: ExitReason = "stopped", graceMs = 3000): Promise<Job> {
    const job = this.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    if (job.exit) return job;
    signalGroup(job.pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (isAlive(job.pid) && Date.now() < deadline) await sleep(100);
    if (isAlive(job.pid)) {
      signalGroup(job.pid, "SIGKILL");
      await sleep(100);
    }
    this.finish(id, reason);
    return this.get(id)!;
  }

  markDelivered(id: string) {
    writeFileSync(this.path(id, "delivered"), "");
  }

  markMatched(id: string, line: string) {
    writeFileSync(this.path(id, "matched"), line);
  }

  tail(id: string, count = 15, maxBytes = 64 * 1024): string[] {
    const path = this.path(id, "log");
    if (!existsSync(path)) return [];
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return lastLines(buffer.toString("utf8"), count);
    } finally {
      closeSync(fd);
    }
  }

  readFrom(id: string, offset: number, maxBytes = 1024 * 1024): { text: string; offset: number } {
    const path = this.path(id, "log");
    if (!existsSync(path)) return { text: "", offset };
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return { text: "", offset: size < offset ? size : offset };
      const length = Math.min(size - offset, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, offset);
      return { text: buffer.toString("utf8"), offset: offset + length };
    } finally {
      closeSync(fd);
    }
  }

  inbox(): InboxMessage[] {
    if (!existsSync(this.inboxDir)) return [];
    return readdirSync(this.inboxDir)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .flatMap((file) => {
        const path = join(this.inboxDir, file);
        try {
          const data = JSON.parse(readFileSync(path, "utf8")) as { from?: string; text?: string; at?: number };
          return [{ file: path, from: data.from, text: String(data.text ?? ""), at: data.at ?? Date.now() }];
        } catch {
          return [{ file: path, text: readFileSync(path, "utf8"), at: Date.now() }];
        }
      });
  }

  consume(file: string) {
    try {
      unlinkSync(file);
    } catch {}
  }

  static prune(root = wakeRoot(), maxAgeMs = 14 * 24 * 3600 * 1000) {
    if (!existsSync(root)) return;
    for (const session of readdirSync(root)) {
      const dir = join(root, session);
      try {
        if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
        const store = new JobStore(session, root);
        if (store.list().some((job) => !job.exit && isAlive(job.pid))) continue;
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function jobState(job: Job): string {
  if (!job.exit) return "running";
  if (job.exit.reason === "exit") return job.exit.code === 0 ? "ok" : `failed (exit ${job.exit.code})`;
  if (job.exit.reason === "timeout") return `killed by ${job.timeoutSec}s timeout`;
  if (job.exit.reason === "lost") return "lost (process vanished without an exit code)";
  return "stopped";
}

export function jobElapsed(job: Job, now = Date.now()): string {
  return formatDuration((job.exit?.endedAt ?? now) - job.startedAt);
}
