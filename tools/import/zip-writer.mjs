// Minimal ZIP writer (stored or deflate). Used by the task packager and by tests.
import zlib from 'node:zlib';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/**
 * @param {Array<{
 *   name: string, data?: Buffer|string, method?: 'store'|'deflate', mode?: number, dir?: boolean,
 *   flags?: number, hostOS?: number, methodCode?: number,
 *   central?: {usize?: number, csize?: number, crc?: number},
 *   corrupt?: boolean, sameLocalAs?: number
 * }>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  const offsets = [];
  let offset = 0;

  entries.forEach((e, idx) => {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.dir ? '' : (e.data ?? ''));
    const method = e.methodCode ?? (e.dir || e.method === 'store' ? 0 : 8);
    let body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw);
    if (e.corrupt && body.length > 0) { body = Buffer.from(body); body[0] ^= 0xff; }
    const flags = 0x0800 | (e.flags ?? 0);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0x0021),
      u32(crc), u32(body.length), u32(raw.length), u16(name.length), u16(0), name, body,
    ]);
    offsets.push(offset);
    locals.push(local);
    offset += local.length;

    const mode = e.mode ?? (e.dir ? 0o040755 : 0o100644);
    const host = e.hostOS ?? 3;
    const c = e.central ?? {};
    const localOffset = e.sameLocalAs !== undefined ? offsets[e.sameLocalAs] : offsets[idx];
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16((host << 8) | 20), u16(20), u16(flags), u16(method), u16(0), u16(0x0021),
      u32(c.crc ?? crc), u32(c.csize ?? body.length), u32(c.usize ?? raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(((mode << 16) >>> 0) | (e.dir ? 0x10 : 0)), u32(localOffset), name,
    ]));
  });

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}
