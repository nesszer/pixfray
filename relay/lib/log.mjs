import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LOG_LINES = 100;
const SAFE_COMPONENTS = new Set(['relay', 'runner', 'twitch', 'backend']);

function defaultDirectory() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'MiniChatRelay');
}

export function formatStatusRecord(component, event, now = new Date()) {
  if (!SAFE_COMPONENTS.has(component)) return null;
  if (typeof event !== 'string' || !/^[a-z0-9_:-]{1,48}$/.test(event)) return null;
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return JSON.stringify({ at, component, event });
}

export function statusLog(component, event, now = new Date()) {
  const record = formatStatusRecord(component, event, now);
  if (!record) return;

  try {
    const directory = defaultDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'relay.log');
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      // A missing first-run log is expected.
    }
    lines.push(record);
    fs.writeFileSync(file, lines.slice(-MAX_LOG_LINES).join('\n') + '\n', 'utf8');
  } catch {
    // Logging must not prevent chat relay recovery.
  }
}
