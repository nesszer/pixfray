#!/usr/bin/env node
// Reads the room and Worker debug lines from Workers Logs (server/tracker.ts prints each as JSON). See docs/LIVE_FIX.md.
// Usage: node scripts/logs.ts [--mode test] [--channel nesszers] [--source alarm] [--hours 6] [--limit 100]
// Needs `bunx cf` signed in to the account. Prints only the log fields, never account or request metadata.
import { execFileSync } from "node:child_process";
import siteConfig from "../site.config.js";

/** One Workers Logs event, as far as this script reads it. JSON console lines arrive parsed under `source`. */
type LogEvent = { timestamp?: number; source?: { [field: string]: unknown }; $workers?: { scriptName?: string } };
type Filter = { key: string; operation: string; type: string; value?: string };

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]!); // !: i < argv.length
  // !: group 1 always matches; a flag without "=" takes the next argument
  if (m) flags[m[1]!] = m[2] ?? argv[++i] ?? "";
}
if ("help" in flags || argv[0] === "help") {
  console.log("node scripts/logs.ts [--mode test] [--channel <login>] [--source <log>] [--hours 6] [--limit 100]");
  console.log("sources: room worker command warn alarm duel chat event (event and 'heard' lines are only here)");
  process.exit(0);
}
const script = flags.mode === "test" ? siteConfig.workers.test : siteConfig.workers.production;
const hours = Math.min(72, Math.max(0.1, Number(flags.hours) || 6)); // Workers Logs keeps 3 days
const limit = Math.min(2000, Math.max(1, Number(flags.limit) || 100));

const filters: Filter[] = [
  { key: "$workers.scriptName", operation: "eq", type: "string", value: script },
  // the bare field name matches the parsed JSON field (checked on staging: "source.log" matches nothing)
  flags.source
    ? { key: "log", operation: "eq", type: "string", value: flags.source }
    : { key: "log", operation: "exists", type: "string" },
];
if (flags.channel) filters.push({ key: "channel", operation: "eq", type: "string", value: flags.channel });

const to = Date.now(),
  from = to - hours * 3_600_000,
  events: LogEvent[] = [];
let offset: string | undefined;
while (events.length < limit) {
  const body = {
    queryId: "pixfray-logs",
    timeframe: { from, to },
    view: "events",
    dry: true,
    parameters: { datasets: ["cloudflare-workers"], filters, limit: Math.min(200, limit - events.length) },
    ...(offset ? { offset } : {}),
  };
  let out: string;
  try {
    out = execFileSync("bunx", ["cf", "observability", "telemetry", "query", "--body", JSON.stringify(body)], {
      encoding: "utf8",
      maxBuffer: 100_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // the CLI's own message names what to fix (signed out, wrong account); the body never holds a secret
    console.error("cf observability query failed:", String((e as { stderr?: unknown }).stderr || e).slice(0, 400)); // as: execFileSync errors carry stderr
    process.exit(1);
  }
  // as: the query answer; only events.events is read, and each field below is checked where it is printed
  const page = (
    JSON.parse(out.slice(out.indexOf("{"))) as { events?: { events?: (LogEvent & { $metadata?: { id?: string } })[] } }
  ).events?.events;
  if (!page?.length) break;
  events.push(...page);
  if (page.length < 200) break;
  offset = page.at(-1)?.$metadata?.id;
  if (!offset) break;
}

events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
for (const e of events) {
  const { log, message, ...rest } = e.source || {};
  const at = new Date(e.timestamp || 0).toISOString().replace("T", " ").slice(0, 19);
  const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
  console.log(`${at} ${String(log).padEnd(7)} ${String(message ?? "")}${extra}`);
}
console.error(
  `${events.length} lines from ${script}, last ${hours} h${flags.channel ? ", channel " + flags.channel : ""}`,
);
