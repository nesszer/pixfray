import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DPAPI_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dpapi.ps1');
export const CONFIG_VERSION = 2;

export function configDirectory() {
  if (process.env.MINI_CHAT_RELAY_HOME) return path.resolve(process.env.MINI_CHAT_RELAY_HOME);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'MiniChatRelay');
}

export function configFilePath() {
  return path.join(configDirectory(), 'config.dpapi');
}

function powershellEnv() {
  // A PowerShell 7 PSModulePath breaks module autoloading in Windows PowerShell 5.1.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  return env;
}

function invokeDpapi(mode, input) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DPAPI_SCRIPT, mode,
  ], { input: Buffer.from(input, 'utf8'), encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024, env: powershellEnv() });
  if (result.error || result.status !== 0 || !result.stdout) throw new Error('Windows DPAPI operation failed');
  return result.stdout.trim();
}

// DPAPI (CurrentUser scope, fixed entropy) through dpapi.ps1. Only this Windows account can decrypt.
export const dpapiProtector = {
  protect: (text) => invokeDpapi('Protect', text),
  unprotect: (text) => invokeDpapi('Unprotect', text),
};

export function dpapiAvailable() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, timeout: 20_000, env: powershellEnv() });
  return !result.error && result.status === 0;
}

export function emptyConfig() {
  return { version: CONFIG_VERSION, backend: null, twitch: null };
}

const str = (value) => typeof value === 'string' && value.length > 0;

export function assertConfig(value) {
  if (!value || value.version !== CONFIG_VERSION) throw new Error('Relay configuration is invalid; run "pair" and "login" again');
  const { backend, twitch } = value;
  if (backend !== null && (!backend || !str(backend.origin) || !str(backend.credential) || !str(backend.channel))) {
    throw new Error('Relay pairing is invalid; run "pair <code>" again');
  }
  if (twitch !== null && (!twitch || !str(twitch.clientId) || !str(twitch.accessToken) || !str(twitch.refreshToken) || !str(twitch.userId) || !str(twitch.login))) {
    throw new Error('Twitch login is invalid; run "login" again');
  }
  return value;
}

export function loadConfig({ file = configFilePath(), protector = dpapiProtector, allowMissing = false } = {}) {
  if (!fs.existsSync(file)) {
    if (allowMissing) return emptyConfig();
    throw new Error('Relay is not configured; run "pair <code>" and "login" first');
  }
  const cleartext = protector.unprotect(fs.readFileSync(file, 'utf8'));
  let parsed;
  try {
    parsed = JSON.parse(cleartext);
  } catch {
    throw new Error('Relay configuration could not be decrypted for this Windows account');
  }
  return assertConfig(parsed);
}

export function saveConfig(value, { file = configFilePath(), protector = dpapiProtector } = {}) {
  assertConfig(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const protectedText = protector.protect(JSON.stringify(value));
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(temporary, protectedText + '\n', { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } catch {
    throw new Error('Could not safely update the DPAPI-protected relay configuration');
  }
}
