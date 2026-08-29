/**
 * DSH workspace registration — makes an externally-written session visible
 * in the Web GUI without restarting the harness.
 *
 * The GUI's workspace panel is NOT a live filesystem scan. It renders
 * `~/.dsh/storages/workspace.json` → `workspaceDomainSpec` → `sessionIds[]`.
 * The registry's `bootstrap` (history→workspace grouping) only runs once
 * (`initialized:false → true`). Afterwards every new session must be
 * registered via `workspaceRegistry.attachSession(id)` or its durable
 * equivalent (the `sessionIds` array). A raw `fs.writeFile` to
 * `~/.dsh/sessions/.../session.jsonl.zstd` is therefore invisible on refresh.
 *
 * This module performs the durable equivalent directly against the JSON
 * storage file, atomically and idempotently. It is best-effort: callers
 * should never fail a migration because the workspace file could not be
 * touched (sandbox, concurrent writer, etc.).
 */

import { promises as fs } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

/** Resolve the workspace.json path from a sessions root like `~/.dsh/sessions`. */
function workspaceJsonPath(sessionsRoot: string): string | null {
  // sessionsRoot is expected to be `<dshHome>/sessions`
  // dshHome = dirname(sessionsRoot); workspace file = <dshHome>/storages/workspace.json
  const dshHome = dirname(sessionsRoot);
  if (!dshHome || dshHome === sessionsRoot) return null;
  return join(dshHome, 'storages', 'workspace.json');
}

async function canonicalize(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** Atomically replace `path` with `data` (tmp+rename, POSIX fsync on dir). */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path);
}

/**
 * Ensure `sessionId` is accounted in the workspace that owns `cwd`.
 * If no workspace owns `cwd`, a new one is created (mirrors bootstrap's
 * `createCanonical` naming: `basename(path)`).
 *
 * No-op when:
 *  - `sessionsRoot` is not the default DSH sessions dir (hermetic tmp roots)
 *  - the workspace file does not exist or is unreadable
 *  - the caller already passed an explicit custom root (we detect via `isDefaultRoot`)
 */
export async function ensureWorkspaceRegistration(
  sessionsRoot: string,
  cwd: string,
  sessionId: string,
  opts?: { isDefaultRoot?: boolean },
): Promise<{ registered: boolean; reason?: string }> {
  if (!cwd) return { registered: false, reason: 'no cwd' };
  // Only touch the real DSH home; never mutate a hermetic tmp workspace file.
  // Callers that use an explicit tmp root should set isDefaultRoot=false.
  if (opts?.isDefaultRoot === false) return { registered: false, reason: 'hermetic root' };

  const wsPath = workspaceJsonPath(sessionsRoot);
  if (!wsPath) return { registered: false, reason: 'no workspace path' };

  let raw: string;
  try {
    raw = await fs.readFile(wsPath, 'utf8');
  } catch (e) {
    return { registered: false, reason: `read workspace.json: ${String((e as Error).message)}` };
  }

  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { registered: false, reason: `parse workspace.json: ${String((e as Error).message)}` };
  }

  if (!doc?.tables?.workspaces || !doc?.global) {
    return { registered: false, reason: 'unexpected workspace.json shape' };
  }

  const canonical = await canonicalize(cwd);
  const lowerEq = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

  // Find owning workspace (compare canonical paths; Windows is case-insensitive)
  let ownerId: string | undefined;
  let ownerRec: any | undefined;
  for (const [id, rec] of Object.entries<any>(doc.tables.workspaces)) {
    if (lowerEq(rec.path, canonical)) {
      ownerId = id;
      ownerRec = rec;
      break;
    }
  }

  const nowIso = new Date().toISOString();

  if (ownerId && ownerRec) {
    if (Array.isArray(ownerRec.sessionIds) && ownerRec.sessionIds.includes(sessionId)) {
      return { registered: false, reason: 'already registered' };
    }
    // Prepend — mirrors attachSession's `[sessionId, ...sessionIds]`
    ownerRec.sessionIds = [sessionId, ...(ownerRec.sessionIds ?? [])];
    ownerRec.updatedAt = nowIso;
    // Archived sessions are hidden; ensure we are not archived.
    if (Array.isArray(doc.global.archivedSessionIds)) {
      const idx = doc.global.archivedSessionIds.indexOf(sessionId);
      if (idx !== -1) doc.global.archivedSessionIds.splice(idx, 1);
    }
  } else {
    // Create a new workspace — mirrors WorkspaceRegistry.createCanonical
    const newId = randomUUID();
    const title = basename(canonical) || canonical;
    const rec = {
      path: canonical,
      title,
      sessionIds: [sessionId],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    doc.tables.workspaces[newId] = rec;
    // New workspaces are prepended to the durable order.
    if (Array.isArray(doc.global.workspaceIds)) {
      doc.global.workspaceIds.unshift(newId);
    } else {
      doc.global.workspaceIds = [newId];
    }
    ownerId = newId;
  }

  // Ensure initialized stays true (bootstrap is one-shot)
  if (doc.global.initialized !== true) doc.global.initialized = true;

  const nextRaw = `${JSON.stringify(doc, null, 2)}\n`;
  try {
    await writeAtomic(wsPath, nextRaw);
  } catch (e) {
    return { registered: false, reason: `write workspace.json: ${String((e as Error).message)}` };
  }
  return { registered: true };
}

/**
 * Best-effort repair: scan `sessionsRoot` for session artifacts whose
 * header `cwd` is not yet accounted, and register each missing one.
 * Also prunes dangling registrations (sessionIds whose artifact directory
 * no longer exists anywhere under `sessionsRoot`) so the GUI list never
 * offers entries that cannot load.
 * Useful for the "exported filename not visible after refresh" diagnosis.
 */
export async function reconcileWorkspaces(
  sessionsRoot: string,
): Promise<{ scanned: number; registered: number; pruned: number; errors: string[] }> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const { decompressSessionBuffer } = await import('./format.js');

  let projects: string[];
  try {
    projects = await readdir(sessionsRoot);
  } catch (e) {
    return { scanned: 0, registered: 0, pruned: 0, errors: [String((e as Error).message)] };
  }

  let scanned = 0;
  let registered = 0;
  let pruned = 0;
  const errors: string[] = [];

  // Collect the on-disk session id set across every project dir. A
  // registration is dangling when its artifact directory is gone.
  const onDisk = new Set<string>();
  const projectDirs: Array<{ proj: string; sessDirs: string[] }> = [];
  for (const proj of projects) {
    if (!(proj.startsWith('--') && proj.endsWith('--'))) continue;
    let sessDirs: string[];
    try {
      sessDirs = await readdir(joinPath(sessionsRoot, proj));
    } catch {
      continue;
    }
    projectDirs.push({ proj, sessDirs });
    for (const sid of sessDirs) onDisk.add(sid);
  }

  // Prune dangling registrations first, using one read-modify-write cycle.
  const wsPath = workspaceJsonPath(sessionsRoot);
  let accounted = new Set<string>();
  if (wsPath) {
    try {
      const raw = await readFile(wsPath, 'utf8');
      const doc = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { sessionIds?: string[] }> } };
      let dirty = false;
      for (const rec of Object.values<any>(doc.tables?.workspaces ?? {})) {
        const ids = rec.sessionIds;
        if (!Array.isArray(ids)) continue;
        const kept = ids.filter((sid) => onDisk.has(sid));
        if (kept.length !== ids.length) {
          pruned += ids.length - kept.length;
          rec.sessionIds = kept;
          dirty = true;
        }
        for (const sid of kept) accounted.add(sid);
      }
      if (dirty) await writeAtomic(wsPath, JSON.stringify(doc, null, '\t') + '\n');
    } catch {
      // best-effort
    }
  }

  for (const { proj, sessDirs } of projectDirs) {
    for (const sid of sessDirs) {
      scanned++;
      if (accounted.has(sid)) continue;
      const p = joinPath(sessionsRoot, proj, sid, 'session.jsonl.zstd');
      try {
        const buf = await readFile(p);
        const plain = decompressSessionBuffer(buf as unknown as Buffer);
        const first = plain.split('\n').find((l) => l.trim());
        if (!first) continue;
        const hdr = JSON.parse(first) as { cwd?: string; id?: string };
        const cwd = hdr.cwd;
        if (!cwd) continue;
        const res = await ensureWorkspaceRegistration(sessionsRoot, cwd, hdr.id ?? sid);
        if (res.registered) {
          registered++;
          accounted.add(hdr.id ?? sid);
        }
      } catch (e) {
        errors.push(`${sid}: ${String((e as Error).message)}`);
      }
    }
  }
  return { scanned, registered, pruned, errors };
}
