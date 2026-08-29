/**
 * DSH attachment store reader (`~/.dsh/attachments/v1`).
 *
 * Image bytes are content-addressed by sha256 (`attachment-local/src/store.ts`):
 * `objects/<sha256[0:2]>/<sha256>`, and the ImageBlock's `attachmentId` IS the
 * store ref — `sha256:<64hex>` (ID_PATTERN in store.ts:22). Resolving the
 * reference turns a `dsh-attachment://<id>` FileBlock url into real bytes for
 * cross-tool export; within dsh->dsh the reference alone already round-trips.
 * (`request-images/` holds derived request-time variants, not originals —
 * not read here.)
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const ATTACHMENT_ID_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/;

/** Default DSH attachment store root for the current OS user. */
export function defaultDshAttachmentRoot(): string | null {
  const home = process.env.HOME || (process.env.USERPROFILE ?? null);
  return home ? join(home, '.dsh', 'attachments', 'v1') : null;
}

/**
 * Read one attachment's bytes from the store. Accepts both the native ref
 * form (`sha256:<hex>`) and a bare hex digest. Returns null when the id is
 * malformed or the object is absent — callers decide the fallback (text
 * placeholder, skip, …); this never throws for a missing file.
 */
export async function readDshAttachment(attachmentId: string, root?: string): Promise<Buffer | null> {
  const m = ATTACHMENT_ID_PATTERN.exec(String(attachmentId));
  if (!m) return null;
  const hash = m[1]!;
  const storeRoot = root ?? defaultDshAttachmentRoot();
  if (!storeRoot) return null;
  try {
    return await fs.readFile(join(storeRoot, 'objects', hash.slice(0, 2), hash));
  } catch {
    return null;
  }
}
