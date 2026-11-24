import { inflateRawSync } from 'node:zlib';

// Deliberately bounded ZIP32 support. Never extract untrusted archive paths.
export const TRACE_LIMITS = { archive: 32 * 1024 * 1024, expanded: 64 * 1024 * 1024, member: 8 * 1024 * 1024, entries: 2048, ratio: 200, records: 100000, depth: 80 } as const;
export class ArtifactSecurityError extends Error {
  readonly code = 'ARTIFACT_SECURITY_BLOCKED';
  readonly statusCode = 422;
  constructor() { super('Artifact blocked: a validated sanitized copy is unavailable. Raw evidence cannot be downloaded.'); }
}
export function blocked(): never { throw new ArtifactSecurityError(); }
export type ArchiveMember = { name: string; data: Buffer };
const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(data: Buffer): number { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const safeName = (name: string) => /^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(name) && !name.split('/').some(part => part === '.' || part === '..' || part.endsWith('.') || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part));
function extras(data: Buffer) {
  let cursor = 0;
  while (cursor < data.length) {
    if (cursor + 4 > data.length) blocked();
    const type = data.readUInt16LE(cursor), length = data.readUInt16LE(cursor + 2);
    if (![0x5455, 0x000a, 0x7875].includes(type) || cursor + 4 + length > data.length) blocked();
    cursor += 4 + length;
  }
}
export function readTraceArchive(input: Buffer): ArchiveMember[] {
  try {
    if (input.length < 22 || input.length > TRACE_LIMITS.archive) blocked();
    const end = input.length - 22;
    if (input.readUInt32LE(end) !== 0x06054b50 || input.readUInt16LE(end + 20) !== 0 || input.readUInt32LE(end + 4) !== 0) blocked();
    const count = input.readUInt16LE(end + 10), directorySize = input.readUInt32LE(end + 12), directory = input.readUInt32LE(end + 16);
    if (!count || count > TRACE_LIMITS.entries || input.readUInt16LE(end + 8) !== count || directory + directorySize !== end) blocked();
    const names = new Set<string>(); const members: ArchiveMember[] = [];
    let cursor = directory, total = 0, expectedLocal = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || input.readUInt32LE(cursor) !== 0x02014b50) blocked();
      const version = input.readUInt16LE(cursor + 6), flags = input.readUInt16LE(cursor + 8), method = input.readUInt16LE(cursor + 10);
      const crc = input.readUInt32LE(cursor + 16), compressed = input.readUInt32LE(cursor + 20), size = input.readUInt32LE(cursor + 24);
      const nameSize = input.readUInt16LE(cursor + 28), extraSize = input.readUInt16LE(cursor + 30), comment = input.readUInt16LE(cursor + 32), offset = input.readUInt32LE(cursor + 42);
      const mode = input.readUInt32LE(cursor + 38) >>> 16;
      if (![10, 20].includes(version) || flags & ~0x0808 || ![0, 8].includes(method) || comment || input.readUInt16LE(cursor + 34) || (input.readUInt32LE(cursor + 38) & 0x10) || ((mode & 0xf000) && (mode & 0xf000) !== 0x8000)) blocked();
      if (nameSize > 240 || !nameSize || cursor + 46 + nameSize + extraSize > end || offset !== expectedLocal) blocked();
      const nameBytes = input.subarray(cursor + 46, cursor + 46 + nameSize), name = nameBytes.toString('utf8');
      if (!safeName(name) || !Buffer.from(name).equals(nameBytes) || names.has(name.toLowerCase())) blocked();
      names.add(name.toLowerCase()); extras(input.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize));
      total += size;
      if (size > TRACE_LIMITS.member || total > TRACE_LIMITS.expanded || size > Math.max(1, compressed) * TRACE_LIMITS.ratio) blocked();
      if (offset + 30 > directory || input.readUInt32LE(offset) !== 0x04034b50 || input.readUInt16LE(offset + 4) !== version || input.readUInt16LE(offset + 6) !== flags || input.readUInt16LE(offset + 8) !== method) blocked();
      const localName = input.readUInt16LE(offset + 26), localExtra = input.readUInt16LE(offset + 28), start = offset + 30 + localName + localExtra;
      if (start + compressed > directory || localName !== nameSize || !input.subarray(offset + 30, offset + 30 + localName).equals(nameBytes)) blocked();
      extras(input.subarray(offset + 30 + localName, start));
      if (!(flags & 8) && (input.readUInt32LE(offset + 14) !== crc || input.readUInt32LE(offset + 18) !== compressed || input.readUInt32LE(offset + 22) !== size)) blocked();
      expectedLocal = start + compressed;
      if (flags & 8) {
        if (expectedLocal + 12 > directory) blocked();
        if (input.readUInt32LE(expectedLocal) === 0x08074b50) expectedLocal += 4;
        if (expectedLocal + 12 > directory || input.readUInt32LE(expectedLocal) !== crc || input.readUInt32LE(expectedLocal + 4) !== compressed || input.readUInt32LE(expectedLocal + 8) !== size) blocked();
        expectedLocal += 12;
      }
      const bytes = input.subarray(start, start + compressed);
      const inflated = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: Math.min(TRACE_LIMITS.member, size + 1), info: true });
      const data = Buffer.isBuffer(inflated) ? inflated : (inflated as any).buffer as Buffer;
      if (!Buffer.isBuffer(inflated) && (inflated as any).engine.bytesWritten !== compressed) blocked();
      if (data.length !== size || crc32(data) !== crc) blocked();
      members.push({ name, data }); cursor += 46 + nameSize + extraSize;
    }
    if (cursor !== end || expectedLocal !== directory) blocked();
    return members;
  } catch { return blocked(); }
}
export function writeTraceArchive(members: ArchiveMember[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  if (!members.length || members.length > TRACE_LIMITS.entries) blocked();
  for (const { name, data } of members) {
    if (!safeName(name)) blocked();
    const bytes = Buffer.from(name), header = Buffer.alloc(30), directory = Buffer.alloc(46), crc = crc32(data);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(bytes.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(bytes.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, bytes, data); central.push(directory, bytes); offset += header.length + bytes.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const output = Buffer.concat([...local, cd, end]);
  readTraceArchive(output); // independently re-read sizes, CRCs and directory boundaries
  return output;
}
