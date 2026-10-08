// Minimal in-memory ZIP reader (stored + deflate entries) so the character build needs no unzip tool or npm package.
import zlib from "node:zlib";

export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no end-of-central-directory record)");
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const csize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28),
      extraLen = buffer.readUInt16LE(p + 30),
      commentLen = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    entries.set(name, { name, method, csize, offset });
  }
  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error("not in archive: " + name);
      const nl = buffer.readUInt16LE(e.offset + 26),
        el = buffer.readUInt16LE(e.offset + 28);
      const start = e.offset + 30 + nl + el;
      const raw = buffer.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error("unsupported ZIP method " + e.method + " for " + name);
    },
  };
}
