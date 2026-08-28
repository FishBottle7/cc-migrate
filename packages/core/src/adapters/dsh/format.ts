/**
 * DSH on-disk format helpers (path encoding + zstd physical layout).
 *
 * Verified against a real machine (`~/.dsh/sessions`):
 *  - project directory key: separators (`:`, `\`, `/`) become `-`, unsafe code
 *    units become `~XXXX`, wrapped in `--`; e.g. `D:\codes\dshPlugins`
 *    -> `--D-codes-dshPlugins--`.
 *  - session directory: `encodeSegment(id)`, id is a safe segment already.
 *  - artifact: `session.jsonl.zstd` = concatenated independent Zstandard frames,
 *    each compressed with the checksum flag (mirrors what `@deepseek-ai/dsh`
 *    does with `node:zlib`). Frame 0 is the header line; later frames hold
 *    batches of event rows.
 */

import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { join } from 'node:path';

const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } as Record<number, number> };

export function projectKey(cwd: string): string {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = cwd[i];
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = raw[i];
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** Locate complete zstd frame [start,end) ranges in a buffer (magic scan heuristic). */
export function scanZstdFrameRanges(buf: Buffer): Array<{ start: number; end: number }> {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const ranges: Array<{ start: number; end: number }> = [];
  let idx = 0;
  // We rely on the fact that each a complete zstd frame ends where the next magic begins.
  // Robust approach: repeatedly decompress from an anchor until we consume bytes.
  // Simpler: find all magic positions and treat gaps between consecutive magics as frame payloads.
  const anchors: number[] = [];
  let pos = 0;
  for (;;) {
    const found = buf.indexOf(magic, pos);
    if (found === -1) break;
    anchors.push(found);
    pos = found + 4;
  }
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1] : buf.length;
    ranges.push({ start, end });
  }
  return ranges;
}

/** Decompress a DSH session artifact into its plaintext JSONL (header + events). */
export function decompressSessionBuffer(buf: Buffer): string {
  let plain = Buffer.alloc(0);
  for (const range of scanZstdFrameRanges(buf)) {
    const decoded = zstdDecompressSync(buf.subarray(range.start, range.end));
    plain = Buffer.concat([plain, decoded]);
  }
  return plain.toString('utf8');
}

/** Compress one plaintext frame exactly as DSH does (checksummed single frame). */
export function compressFrame(plaintext: string | Buffer): Buffer {
  return zstdCompressSync(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext), ZSTD_CHECKSUM_OPTIONS);
}

/** Build the full session artifact path under a sessions root. */
export function sessionLogPath(sessionsRoot: string, cwd: string, id: string, compression: 'zstd' | 'none' = 'zstd'): string {
  const suffix = compression === 'zstd' ? '.jsonl.zstd' : '.jsonl';
  return join(sessionsRoot, projectKey(cwd), encodeSegment(id), `session${suffix}`);
}

/** Default DSH sessions root for the current OS user. */
export function defaultDshRoot(): string | null {
  const home = process.env.HOME || (process.env.USERPROFILE ?? null);
  return home ? join(home, '.dsh', 'sessions') : null;
}