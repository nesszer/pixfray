// Minimal in-memory ZIP reader (stored + deflate entries) so the character build needs no unzip tool or npm package.
import zlib from "node:zlib";

export type Zip = { read(name: string): Buffer };

export function readZip(buffer: Buffer): Zip {
  // The end-of-central-directory record sits in the last 22 bytes plus up to 64 KB of comment.
  let eocd = buffer.length - 22;
  while (eocd >= Math.max(0, buffer.length - 65558) && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < Math.max(0, buffer.length - 65558)) throw new Error("not a ZIP file (no end-of-central-directory record)");
  const entries = new Map<string, { method: number; csize: number; offset: number }>();
  for (let n = buffer.readUInt16LE(eocd + 10), p = buffer.readUInt32LE(eocd + 16); n > 0; n--) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const nameLen = buffer.readUInt16LE(p + 28);
    const name = buffer.toString(buffer.readUInt16LE(p + 8) & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    const entry = {
      method: buffer.readUInt16LE(p + 10),
      csize: buffer.readUInt32LE(p + 20),
      offset: buffer.readUInt32LE(p + 42),
    };
    if (!name.endsWith("/")) entries.set(name, entry);
    p += 46 + nameLen + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }
  return {
    read(name: string): Buffer {
      const e = entries.get(name);
      if (!e) throw new Error("not in archive: " + name);
      const start = e.offset + 30 + buffer.readUInt16LE(e.offset + 26) + buffer.readUInt16LE(e.offset + 28);
      const raw = buffer.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error("unsupported ZIP method " + e.method + " for " + name);
    },
  };
}
