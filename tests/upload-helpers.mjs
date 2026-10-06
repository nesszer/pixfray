// Test helpers for Lane D: a tiny PNG encoder, PNG size reader and a fake ChannelRoom context on node:sqlite.
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { crc32 } from '../server/uploads.js';

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

// Encodes a real RGBA PNG (solid colour unless `pixel(x, y)` returns [r,g,b,a]). `extra` adds ancillary chunks.
export function makePng(width, height, { pixel = () => [200, 60, 60, 255], extra = [] } = {}) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...extra.map(([type, data]) => chunk(type, data)), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const b64 = (buf) => Buffer.from(buf).toString('base64');

export function fakeRoomCtx() {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  return {
    storage: {
      sql: { exec(query, ...params) { const rows = db.prepare(query).all(...params).map((r) => ({ ...r })); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } },
      transactionSync(fn) {
        if (depth) return fn();
        depth++; db.exec('BEGIN');
        try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
      },
      alarm: null, async getAlarm() { return this.alarm; }, async setAlarm(t) { this.alarm = t; }, async deleteAlarm() { this.alarm = null; },
    },
    acceptWebSocket() {}, getWebSockets() { return []; },
  };
}
