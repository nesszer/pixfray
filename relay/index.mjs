#!/usr/bin/env node
// mini-chat Windows relay. Commands: pair <code>, login, run, stop, status, unpair, logout.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { configDirectory, configFilePath, loadConfig, saveConfig } from './lib/config.mjs';
import { CHANNEL_LOGIN, DEFAULT_ORIGIN, REQUIRED_CHAT_SCOPE, USER_AGENT, normalizeOrigin } from './lib/core.mjs';
import { statusLog } from './lib/log.mjs';
import { Relay } from './lib/relay.mjs';
import { deviceCodeLogin, validateToken } from './lib/twitch.mjs';

const HEX64 = /^[0-9a-f]{64}$/i;
const pidFile = () => path.join(configDirectory(), 'relay.pid');
const controlFile = () => path.join(configDirectory(), 'relay.control');

const USAGE = `mini-chat relay

Usage:
  node index.mjs pair <code> [--origin https://chat.miolaf.xyz]
  node index.mjs login [--client-id <id>]
  node index.mjs run [--watch-pid <pid>]
  node index.mjs stop
  node index.mjs status
  node index.mjs unpair | logout

Environment:
  MINI_CHAT_TWITCH_CLIENT_ID      Twitch app client ID (instead of --client-id)
  MINI_CHAT_TWITCH_CLIENT_SECRET  only for Confidential Twitch apps; Public apps need none
  MINI_CHAT_RELAY_HOME            config folder (default %LOCALAPPDATA%\\MiniChatRelay)
`;

function say(text) { process.stdout.write(text + '\n'); }

function readConfig() { return loadConfig({ allowMissing: true }); }

// Test hook: point Twitch endpoints at local fakes. Only loopback URLs are accepted.
function testEndpoints() {
  const raw = process.env.MINI_CHAT_RELAY_TEST_ENDPOINTS;
  if (!raw) return {};
  const value = JSON.parse(raw);
  const out = {};
  for (const key of ['eventsubUrl', 'idBase', 'helixBase']) {
    if (!value[key]) continue;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value[key]).hostname)) throw new Error('Test endpoints must be loopback');
    out[key] = value[key];
  }
  return out;
}

async function pair(code, origin) {
  if (!HEX64.test(code || '')) throw new Error('The pairing code is 64 hex characters; copy it from the admin page');
  const base = normalizeOrigin(origin || DEFAULT_ORIGIN);
  const response = await fetch(base + '/api/relay/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ code: code.toLowerCase() }),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error('Pairing failed (' + response.status + '): ' + (data?.error || 'no details') + '. Create a new code and try again');
  if (!HEX64.test(data?.credential || '') || !data?.channel) throw new Error('The server returned an unexpected pairing response');
  const config = readConfig();
  const now = Date.now();
  config.backend = { origin: base, channel: String(data.channel), credential: data.credential, pairedAt: now, expiresAt: now + (Number(data.expiresIn) || 0) * 1000 };
  saveConfig(config);
  statusLog('relay', 'paired');
  say('Paired with channel ' + config.backend.channel + ' on ' + base + '. The credential is stored encrypted and expires ' + new Date(config.backend.expiresAt).toISOString().slice(0, 10) + '.');
}

async function login(clientIdArg) {
  const config = readConfig();
  const clientId = clientIdArg || process.env.MINI_CHAT_TWITCH_CLIENT_ID || config.twitch?.clientId;
  if (!clientId) throw new Error('Pass --client-id <id> or set MINI_CHAT_TWITCH_CLIENT_ID (the Twitch app client ID)');
  const clientSecret = process.env.MINI_CHAT_TWITCH_CLIENT_SECRET || config.twitch?.clientSecret || '';
  const { idBase } = testEndpoints();
  const tokens = await deviceCodeLogin({
    clientId, clientSecret, ...(idBase ? { idBase } : {}),
    onPrompt: ({ verificationUri, userCode }) => {
      say('Open ' + verificationUri + ' in a browser signed in as ' + CHANNEL_LOGIN + ',');
      say('check that the code shown is ' + userCode + ', and approve "' + REQUIRED_CHAT_SCOPE + '". Waiting...');
    },
  });
  const info = await validateToken({ accessToken: tokens.accessToken, ...(idBase ? { idBase } : {}) });
  if (!info) throw new Error('Twitch returned a token that does not validate; run "login" again');
  config.twitch = { clientId, ...(clientSecret ? { clientSecret } : {}), ...tokens, userId: info.userId, login: info.login };
  saveConfig(config);
  statusLog('twitch', 'logged_in');
  say('Linked Twitch account ' + info.login + '. Tokens are stored encrypted on this PC only.');
  if (info.login !== CHANNEL_LOGIN) say('Note: this account is not ' + CHANNEL_LOGIN + '; it can read that chat only if it is a moderator there or the broadcaster authorized this app.');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function runningPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile(), 'utf8'), 10);
    return processAlive(pid) && pid !== process.pid ? pid : 0;
  } catch { return 0; }
}

function readControl() {
  try { return JSON.parse(fs.readFileSync(controlFile(), 'utf8')); } catch { return null; }
}

async function run(watchPid) {
  const other = runningPid();
  if (other) { say('The relay is already running (pid ' + other + ').'); return 0; }
  const config = loadConfig();
  if (!config.backend) throw new Error('Relay is not paired; run "pair <code>" first');
  if (!config.twitch) throw new Error('Twitch is not linked; run "login" first');
  if (config.backend.expiresAt && config.backend.expiresAt < Date.now()) throw new Error('The relay credential expired; pair again with a new code');

  fs.mkdirSync(configDirectory(), { recursive: true });
  fs.writeFileSync(pidFile(), String(process.pid), 'utf8');
  const startedAt = Date.now();
  const relay = new Relay({ config, persist: async (next) => saveConfig(next), WebSocket, ...testEndpoints() });
  relay.on('status', ({ component, event }) => { statusLog(component, event); say('[' + component + '] ' + event); });
  relay.on('ack', (ack) => { if (!ack.ok) say('[backend] command rejected: ' + ack.reason); });

  let exitCode = 0;
  let finishing = null;
  const finish = (code, reason) => {
    if (finishing) return finishing;
    exitCode = code;
    say('Stopping relay (' + reason + ')');
    finishing = relay.stop({ offline: true }).finally(() => {
      clearInterval(watcher);
      try { if (fs.readFileSync(pidFile(), 'utf8').trim() === String(process.pid)) fs.writeFileSync(pidFile(), '', 'utf8'); } catch {}
    });
    return finishing;
  };

  // The "stop" command writes a request into relay.control; OBS uses it on exit.
  // With --watch-pid, the relay also stops when that process (OBS) is gone, e.g. after a crash.
  const watcher = setInterval(() => {
    const control = readControl();
    if (control?.stopAt > startedAt) finish(0, 'stop requested');
    else if (watchPid && !processAlive(watchPid)) finish(0, 'watched process exited');
  }, 1_000);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, () => finish(0, signal));
  relay.on('fatal', ({ reason, message }) => { statusLog('relay', 'fatal_' + reason); say('Relay stopped: ' + message); finish(2, reason); });

  try {
    await relay.start();
  } catch (error) {
    await finish(2, 'start failed');
    throw error;
  }
  say('Relay running for ' + relay.channel + ' (pid ' + process.pid + '). Press Ctrl+C to stop.');
  await new Promise((resolve) => {
    const check = setInterval(() => { if (finishing) { clearInterval(check); finishing.then(resolve); } }, 200);
  });
  return exitCode;
}

async function stop() {
  fs.mkdirSync(configDirectory(), { recursive: true });
  fs.writeFileSync(controlFile(), JSON.stringify({ stopAt: Date.now() }), 'utf8');
  const pid = runningPid();
  if (!pid) { say('The relay is not running.'); return 0; }
  for (let i = 0; i < 50 && processAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  say(processAlive(pid) ? 'Stop requested; the relay is still shutting down (pid ' + pid + ').' : 'Relay stopped.');
  return 0;
}

function status() {
  const config = readConfig();
  const pid = runningPid();
  say('Config: ' + configFilePath());
  say('Running: ' + (pid ? 'yes (pid ' + pid + ')' : 'no'));
  say(config.backend ? 'Paired: ' + config.backend.channel + ' on ' + config.backend.origin + ', expires ' + new Date(config.backend.expiresAt).toISOString().slice(0, 10) : 'Paired: no (run "pair <code>")');
  say(config.twitch ? 'Twitch: ' + config.twitch.login + ' (client ' + config.twitch.clientId.slice(0, 6) + '...)' : 'Twitch: not linked (run "login")');
  return 0;
}

function forget(part) {
  const config = readConfig();
  config[part] = null;
  saveConfig(config);
  say(part === 'backend' ? 'Pairing removed. Revoke it on the admin page too.' : 'Twitch tokens removed from this PC. Disconnect the app at twitch.tv/settings/connections to revoke them.');
  return 0;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { origin: { type: 'string' }, 'client-id': { type: 'string' }, 'watch-pid': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, arg] = positionals;
  if (values.help || !command) { say(USAGE); return command ? 0 : 1; }
  switch (command) {
    case 'pair': await pair(arg, values.origin); return 0;
    case 'login': await login(values['client-id']); return 0;
    case 'run': return run(values['watch-pid'] ? Number.parseInt(values['watch-pid'], 10) : 0);
    case 'stop': return stop();
    case 'status': return status();
    case 'unpair': return forget('backend');
    case 'logout': return forget('twitch');
    default: say(USAGE); return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  process.stderr.write('Error: ' + (error?.message || String(error)) + '\n');
  process.exit(2);
});
