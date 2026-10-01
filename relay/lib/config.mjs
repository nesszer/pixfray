import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DPAPI_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dpapi.ps1');

export function configDirectory() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'MiniChatRelay');
}

export function configFilePath() {
  return path.join(configDirectory(), 'config.dpapi');
}

function invokeDpapi(mode, input) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    DPAPI_SCRIPT,
    mode,
  ], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    throw new Error('Windows DPAPI operation failed');
  }
  return result.stdout.trim();
}

function assertConfig(value) {
  if (!value || value.version !== 1 || !value.backend || !value.twitch) {
    throw new Error('Relay configuration is invalid; run setup.ps1 again');
  }
  for (const field of ['origin', 'credential']) {
    if (typeof value.backend[field] !== 'string' || !value.backend[field]) {
      throw new Error('Relay configuration is invalid; run setup.ps1 again');
    }
  }
  for (const field of ['clientId', 'clientSecret', 'accessToken', 'refreshToken', 'userId', 'login']) {
    if (typeof value.twitch[field] !== 'string' || !value.twitch[field]) {
      throw new Error('Relay configuration is invalid; run setup.ps1 again');
    }
  }
  return value;
}

export function loadConfig(file = configFilePath()) {
  if (!fs.existsSync(file)) throw new Error('Relay is not configured; run setup.ps1 first');
  const encrypted = fs.readFileSync(file, 'utf8');
  const cleartext = invokeDpapi('Unprotect', encrypted);
  return assertConfig(JSON.parse(cleartext));
}

export function saveConfig(value, file = configFilePath()) {
  assertConfig(value);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const protectedText = invokeDpapi('Protect', JSON.stringify(value));
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(temporary, protectedText + '\n', { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } catch {
    throw new Error('Could not safely update the DPAPI-protected relay configuration');
  }
}
