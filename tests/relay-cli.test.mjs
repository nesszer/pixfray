// Drives relay/index.mjs as a real process: pair -> login -> status -> run -> stop, plus --watch-pid.
// Uses real DPAPI for the config, so it only runs where Windows PowerShell is available.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dpapiAvailable } from '../relay/lib/config.mjs';
import { CREDENTIAL, PAIR_CODE, startFakes, waitFor } from './relay-fakes.mjs';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'index.mjs');
const all = (conn, type) => conn.messages.filter((m) => m.type === type);

function cli(args, env) {
  const child = spawn(process.execPath, [ENTRY, ...args], { env: { ...process.env, ...env }, windowsHide: true });
  const out = { stdout: '', stderr: '', code: null, child };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  out.done = new Promise((resolve) => child.on('exit', (code) => { out.code = code; resolve(out); }));
  return out;
}

test('relay CLI pairs, logs in, runs, forwards, and stops on request or when the watched process exits', { skip: dpapiAvailable() ? false : 'PowerShell DPAPI unavailable', timeout: 60_000 }, async () => {
  const fakes = await startFakes({ heartbeatMs: 200 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-chat-relay-cli-'));
  const env = {
    MINI_CHAT_RELAY_HOME: home,
    MINI_CHAT_RELAY_TEST_ENDPOINTS: JSON.stringify({
      eventsubUrl: 'ws://127.0.0.1:' + fakes.eventsubPort + '/ws',
      idBase: 'http://127.0.0.1:' + fakes.httpPort,
      helixBase: 'http://127.0.0.1:' + fakes.httpPort + '/helix',
    }),
    MINI_CHAT_TWITCH_CLIENT_ID: '',
    MINI_CHAT_TWITCH_CLIENT_SECRET: '',
  };
  const origin = 'http://127.0.0.1:' + fakes.workerPort;
  const running = [];
  try {
    let r = await cli(['pair', 'not-a-code', '--origin', origin], env).done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /64 hex/);

    r = await cli(['run'], env).done;
    assert.equal(r.code, 2, 'run without config fails');
    assert.match(r.stderr, /not configured/);

    r = await cli(['pair', PAIR_CODE, '--origin', origin], env).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Paired with channel nesszerra/);
    const configFile = path.join(home, 'config.dpapi');
    for (const text of [r.stdout, r.stderr, fs.readFileSync(configFile, 'utf8')]) assert.ok(!text.includes(CREDENTIAL), 'credential never printed or stored in clear');

    r = await cli(['pair', PAIR_CODE, '--origin', origin], env).done;
    assert.equal(r.code, 2, 'a pairing code works once');
    assert.match(r.stderr, /403/);

    r = await cli(['login', '--client-id', 'client123'], env).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ABCD-EFGH/);
    assert.match(r.stdout, /Linked Twitch account nesszerra/);
    for (const text of [r.stdout, fs.readFileSync(configFile, 'utf8')]) assert.ok(!text.includes('access-1') && !text.includes('refresh-1'), 'tokens never printed or stored in clear');

    r = await cli(['status'], env).done;
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Paired: nesszerra on http:\/\/127\.0\.0\.1/);
    assert.match(r.stdout, /Twitch: nesszerra/);
    assert.match(r.stdout, /Running: no/);

    // run + stop (the OBS script calls exactly these two commands).
    const relay = cli(['run'], env);
    running.push(relay);
    const es1 = await waitFor(() => fakes.eventsub.sockets[0], 'EventSub connection', 15_000);
    fakes.eventsub.welcome(es1);
    const w1 = await waitFor(() => fakes.worker.connections[0], 'Worker connection', 10_000);
    await waitFor(() => all(w1, 'heartbeat').length >= 1, 'heartbeat');
    fakes.eventsub.chat(es1, '!duel @someone');
    await waitFor(() => all(w1, 'command').length === 1, 'command forwarded by the CLI relay');

    r = await cli(['run'], env).done;
    assert.equal(r.code, 0);
    assert.match(r.stdout, /already running/);
    r = await cli(['status'], env).done;
    assert.match(r.stdout, /Running: yes/);

    r = await cli(['stop'], env).done;
    assert.equal(r.code, 0);
    await relay.done;
    assert.equal(relay.code, 0, relay.stderr);
    assert.equal(all(w1, 'offline').length, 1, 'clean shutdown sent offline');
    assert.ok(!relay.stdout.includes(CREDENTIAL) && !relay.stdout.includes('access-1'));

    // --watch-pid: the relay exits when the watched process (OBS) disappears.
    const fakeObs = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true });
    const relay2 = cli(['run', '--watch-pid', String(fakeObs.pid)], env);
    running.push(relay2);
    const es2 = await waitFor(() => fakes.eventsub.sockets[1], 'second EventSub connection', 15_000);
    fakes.eventsub.welcome(es2);
    const w2 = await waitFor(() => fakes.worker.connections[1], 'second Worker connection', 10_000);
    await waitFor(() => all(w2, 'heartbeat').length >= 1, 'heartbeat');
    fakeObs.kill();
    await relay2.done;
    assert.equal(relay2.code, 0);
    assert.match(relay2.stdout, /watched process exited/);
    assert.equal(all(w2, 'offline').length, 1);
  } finally {
    for (const item of running) if (item.code === null) item.child.kill();
    await fakes.close();
  }
});
