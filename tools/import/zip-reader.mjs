// Minimal, defensive ZIP reader (no zip64, no encryption, no multi-disk).
// Anything unusual is reported as a ZipError so the validator can reject it.
import zlib from 'node:zlib';

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

export function readZip(buf) {
  const minEocd = 22;
  if (buf.length < minEocd) throw new ZipError('zip-structure', 'archive is too small to be a ZIP file');
  let eocd = -1;
  const stop = Math.max(0, buf.length - minEocd - 0xffff);
  for (let i = buf.length - minEocd; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('zip-structure', 'end of central directory not found');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) throw new ZipError('zip64', 'zip64 archives are not supported');

  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0) throw new ZipError('multi-disk', 'multi-disk archives are not supported');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64', 'zip64 archives are not supported');
  if (cdOffset + cdSize > eocd) throw new ZipError('zip-structure', 'central directory is out of bounds');

  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipError('zip-structure', 'bad central directory entry');
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const diskStart = buf.readUInt16LE(p + 34);
    const externalAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw new ZipError('zip-structure', 'central directory entry is truncated');
    if (diskStart !== 0) throw new ZipError('multi-disk', 'multi-disk archives are not supported');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('zip64', 'zip64 archives are not supported');
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const hostOS = versionMadeBy >> 8;
    const unixMode = hostOS === 3 ? (externalAttr >>> 16) & 0xffff : 0;
    entries.push({
      name, versionMadeBy, hostOS, flags, method, crc, compressedSize, uncompressedSize,
      localOffset, externalAttr, unixMode,
      encrypted: (flags & 1) !== 0,
      isDirectory: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, size: buf.length };
}

/** Byte range [start, end) of an entry's local header plus data. */
export function entryRange(buf, entry) {
  const o = entry.localOffset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOC_SIG) throw new ZipError('zip-structure', `bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(o + 26);
  const extraLen = buf.readUInt16LE(o + 28);
  const dataStart = o + 30 + nameLen + extraLen;
  const end = dataStart + entry.compressedSize;
  if (end > buf.length) throw new ZipError('zip-structure', `data for ${entry.name} runs past the end of the archive`);
  return { start: o, dataStart, end, localName: buf.toString('utf8', o + 30, o + 30 + nameLen) };
}

/** Reports entries whose byte ranges overlap (a zip-bomb technique). */
export function findOverlaps(buf, entries) {
  const ranges = entries.map((e) => ({ name: e.name, ...entryRange(buf, e) })).sort((a, b) => a.start - b.start);
  const bad = [];
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) bad.push(ranges[i].name);
  }
  return bad;
}

/** Extracts one entry with hard output limits, verifying size and CRC-32. */
export function extractEntry(buf, entry, maxBytes) {
  if (entry.encrypted) throw new ZipError('encrypted', `${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError('method', `${entry.name} uses unsupported compression method ${entry.method}`);
  const { dataStart, end, localName } = entryRange(buf, entry);
  if (localName !== entry.name) throw new ZipError('name-mismatch', `local and central names differ for ${entry.name}`);
  const body = buf.subarray(dataStart, end);
  let data;
  try {
    data = entry.method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, Math.min(maxBytes, entry.uncompressedSize) + 1) });
  } catch (err) {
    throw new ZipError('inflate', `${entry.name} could not be decompressed: ${err.code ?? err.message}`);
  }
  if (data.length !== entry.uncompressedSize) throw new ZipError('size-mismatch', `${entry.name} expands to ${data.length} bytes but declares ${entry.uncompressedSize}`);
  if (zlib.crc32(data) !== entry.crc) throw new ZipError('crc', `${entry.name} fails its CRC-32 check`);
  return data;
}
