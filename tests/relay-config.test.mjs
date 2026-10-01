import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dpapiAvailable, dpapiProtector, emptyConfig, loadConfig, saveConfig } from '../relay/lib/config.mjs';

// Fixed scratch folder, overwritten on each run (tests never delete files).
const dir = path.join(os.tmpdir(), 'mini-chat-relay-tests');
fs.mkdirSync(dir, { recursive: true });

const sample = () => ({
  version: 2,
  backend: { origin: 'https://chat.miolaf.xyz', channel: 'nesszerra', credential: 'a'.repeat(64), pairedAt: 1, expiresAt: 2 },
  twitch: { clientId: 'client123', accessToken: 'test-access-token', refreshToken: 'test-refresh-token', userId: '1001', login: 'nesszerra', scopes: ['user:read:chat'], expiresAt: 3 },
});

const fakeProtector = {
  protect: (text) => 'FAKE:' + Buffer.from(text).toString('base64'),
  unprotect: (text) => Buffer.from(text.trim().slice(5), 'base64').toString('utf8'),
};

test('config round-trips through a protector and validates its shape', () => {
  const file = path.join(dir, 'fake.dpapi');
  saveConfig(sample(), { file, protector: fakeProtector });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('test-access-token'));
  assert.deepEqual(loadConfig({ file, protector: fakeProtector }), sample());
  saveConfig({ ...emptyConfig(), backend: sample().backend }, { file, protector: fakeProtector });
  assert.equal(loadConfig({ file, protector: fakeProtector }).twitch, null, 'partial config (paired, not logged in) is allowed');
  assert.throws(() => saveConfig({ ...sample(), backend: { origin: 'x' } }, { file, protector: fakeProtector }), /pair/);
  assert.throws(() => saveConfig({ ...sample(), twitch: { clientId: 'x' } }, { file, protector: fakeProtector }), /login/);
  assert.throws(() => saveConfig({ version: 1 }, { file, protector: fakeProtector }));
  assert.deepEqual(loadConfig({ file: path.join(dir, 'missing.dpapi'), allowMissing: true }), emptyConfig());
  assert.throws(() => loadConfig({ file: path.join(dir, 'missing.dpapi') }), /not configured/);
});

const dpapi = dpapiAvailable();
test('config round-trips through real Windows DPAPI', { skip: dpapi ? false : 'PowerShell DPAPI unavailable' }, () => {
  const file = path.join(dir, 'real.dpapi');
  const value = sample();
  saveConfig(value, { file });
  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes('test-access-token') && !stored.includes('nesszerra'), 'ciphertext only on disk');
  assert.match(stored.trim(), /^[A-Za-z0-9+/]+=*$/, 'DPAPI blob stored as base64');
  assert.deepEqual(loadConfig({ file }), value);
  assert.throws(() => dpapiProtector.unprotect('AAAA'), /DPAPI/);
  const unicode = { ...value, twitch: { ...value.twitch, login: 'nesszerra', clientId: 'clé-中' } };
  saveConfig(unicode, { file });
  assert.deepEqual(loadConfig({ file }), unicode, 'non-ASCII survives the round-trip');
});
