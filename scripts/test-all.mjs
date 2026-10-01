// Runs every check in order and stops at the first failure: unit + relay tests, cf build, the workerd upload test,
// then a local `cf dev` (own port, own state folder, seeded test sessions) for the browser and end-to-end tests.
// Usage: npm run test:all          (MINI_PORT=5199 by default; set MINI_BASE_URL to reuse a running, seeded server)
// Nothing here deploys or talks to a deployed site. smoke.mjs joins the real nesszerra Twitch chat read-only.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../tests/seed-local.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.MINI_PORT || '5199';
const persist = '.cloudflare/e2e-state';
const external = process.env.MINI_BASE_URL;
const base = external || 'http://127.0.0.1:' + port;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(name, cmd, env = {}) {
  const started = Date.now();
  console.log('\n=== ' + name + ': ' + cmd);
  const r = spawnSync(cmd, { cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
  results.push([name, r.status === 0 ? 'PASS' : 'FAIL', Math.round((Date.now() - started) / 1000) + ' s']);
  if (r.status !== 0) { stop(); summary(); process.exit(1); }
}
let server = null;
async function start() {
  console.log('\n=== start: npx cf dev on ' + base + ' (state ' + persist + ')');
  server = spawn('npx cf dev', { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MINI_PORT: port, MINI_PERSIST: persist } });
  server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('dev server did not answer on ' + base);
}
function stop() {
  if (!server) return;
  spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });   // only the tree this script started
  server = null;
}
function summary() {
  console.log('\n=== summary');
  for (const [name, status, time] of results) console.log(status.padEnd(5) + name.padEnd(22) + time);
}
process.on('exit', stop);
try {
  run('unit + relay tests', 'npm run -s test:unit');
  run('cf build', 'npx cf build');
  run('upload (workerd)', 'node tests/upload-workerd.mjs');
  if (!external) {
    await start();   // first start creates the local AuthStore, then sessions are seeded with the server stopped
    await fetch(base + '/api/session', { headers: { Cookie: 'mini_session=' + '0'.repeat(64) } });
    stop(); await sleep(1500);
    const cookies = seed(path.join(root, persist));
    process.env.MINI_OWNER_COOKIE = cookies.owner;
    await start();
  }
  const env = { MINI_BASE_URL: base };
  run('smoke (v1 overlay)', 'node tests/smoke.mjs', env);
  run('ui (dashboard/admin)', 'node tests/ui.mjs', env);
  run('dev-ui (live-fix)', 'node tests/dev-ui.mjs', env);
  run('arena browser', 'node tests/arena-browser.mjs', env);
  run('e2e local', 'node tests/e2e-local.mjs', env);
} catch (error) {
  console.error(error);
  results.push(['harness', 'FAIL', '']);
  stop(); summary(); process.exit(1);
}
stop();
summary();
