#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const usage = `usage: pi-wake [-s session-id] [-f from] <message...>
       pi-wake [-s session-id] [-f from] - < message.txt

Wakes the pi session with a message. The session defaults to $PI_SESSION_ID.`;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
let session = process.env.PI_SESSION_ID ?? "";
let from = process.env.PI_WAKE_FROM ?? (process.env.PI_WAKE_JOB_ID ? `job ${process.env.PI_WAKE_JOB_ID}` : "");
const words = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  } else if (arg === "-s" || arg === "--session") session = args[++i] ?? fail(usage);
  else if (arg === "-f" || arg === "--from") from = args[++i] ?? fail(usage);
  else words.push(arg);
}

if (!session) fail("pi-wake: no session; pass -s <session-id> or set PI_SESSION_ID");
const text = words.length === 0 || (words.length === 1 && words[0] === "-") ? readFileSync(0, "utf8") : words.join(" ");
if (!text.trim()) fail(usage);

const sessionDir = join(process.env.PI_WAKE_DIR || join(homedir(), ".pi", "wake"), session);
if (!existsSync(join(sessionDir, "inbox"))) fail(`pi-wake: unknown session ${session} (it never ran with pi-wake loaded)`, 1);

const file = join(sessionDir, "inbox", `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
writeFileSync(`${file}.tmp`, JSON.stringify({ from: from || undefined, text: text.trimEnd(), at: Date.now() }));
renameSync(`${file}.tmp`, file);
