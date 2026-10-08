// Runs every check in order and stops at the first failure: unit tests, both cf builds, the workerd upload test,
// then a local `cf dev` (own port, own state folder, seeded test sessions) for the browser and end-to-end tests.
// Usage: bun run test:all          (MINI_PORT=5199 by default; set MINI_BASE_URL to reuse a running, seeded server
//                                   that was started with MINI_LOCAL_TEST=1, and MINI_AUTH_SECRET to its AUTH_SECRET)
// Nothing here deploys or talks to Twitch or a deployed site. The local `cf dev` runs with MINI_LOCAL_TEST=1, so
// Connect chat records a local subscription, and e2e-local.mjs signs EventSub webhooks with the AUTH_SECRET from
// .dev.vars. That value is passed to the e2e process environment only and is never printed.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seed } from "../tests/seed-local.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.MINI_PORT || "5199";
const persist = ".cloudflare/e2e-state";
const external = process.env.MINI_BASE_URL;
const base = external || "http://127.0.0.1:" + port;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function devVar(name) {
  if (process.env["MINI_" + name]) return process.env["MINI_" + name];
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, ".dev.vars"), "utf8");
  } catch {
    throw new Error(".dev.vars is missing; it must define " + name);
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(".dev.vars does not define " + name);
  return line
    .slice(name.length + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}
function run(name, cmd, env = {}) {
  const started = Date.now();
  console.log("\n=== " + name + ": " + cmd);
  const r = spawnSync(cmd, { cwd: root, shell: true, stdio: "inherit", env: { ...process.env, ...env } });
  results.push([name, r.status === 0 ? "PASS" : "FAIL", Math.round((Date.now() - started) / 1000) + " s"]);
  if (r.status !== 0) {
    stop();
    summary();
    process.exit(1);
  }
}
let server = null;
async function start() {
  console.log("\n=== start: bunx cf dev on " + base + " (state " + persist + ")");
  server = spawn("bunx cf dev", {
    cwd: root,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MINI_PORT: port, MINI_PERSIST: persist, MINI_LOCAL_TEST: "1" },
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("dev server did not answer on " + base);
}
function stop() {
  if (!server) return;
  spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }); // only the tree this script started
  server = null;
}
function summary() {
  console.log("\n=== summary");
  for (const [name, status, time] of results) console.log(status.padEnd(5) + name.padEnd(22) + time);
}
process.on("exit", stop);
try {
  run("unit tests", "bun run test:unit");
  run("cf build", "bunx cf build");
  run("cf build (test)", "bunx cf build --mode test");
  run("module versions", "node tests/build-versions.mjs");
  run("upload (workerd)", "node tests/upload-workerd.mjs");
  if (!external) {
    await start(); // first start creates the local AuthStore, then sessions are seeded with the server stopped
    await fetch(base + "/api/session", { headers: { Cookie: "mini_session=" + "0".repeat(64) } });
    stop();
    await sleep(1500);
    const cookies = seed(path.join(root, persist));
    process.env.MINI_OWNER_COOKIE = cookies.owner;
    await start();
  }
  const env = { MINI_BASE_URL: base };
  run("smoke (v1 overlay)", "node tests/smoke.mjs", env);
  run("ui (dashboard/admin)", "node tests/ui.mjs", env);
  run("dev-ui (owner page)", "node tests/dev-ui.mjs", env);
  run("arena browser", "node tests/arena-browser.mjs", env);
  run("e2e local", "node tests/e2e-local.mjs", { ...env, MINI_AUTH_SECRET: devVar("AUTH_SECRET") });
} catch (error) {
  console.error(error);
  results.push(["harness", "FAIL", ""]);
  stop();
  summary();
  process.exit(1);
}
stop();
summary();
