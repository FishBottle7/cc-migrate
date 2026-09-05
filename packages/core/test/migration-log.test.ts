/**
 * migration-log 单测 —— 「迁移过了吗」的底层契约。
 *
 * 三条铁律：append-only（不 rewrite/删除）、CC_MIGRATE_LOG 可改道/off、
 * 读取对坏行（崩溃残留的半截 JSON）容忍。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMigrationLog, findMigrationsBySource, migrationLogPath, readMigrationLog } from '../src/migration-log.js';
import type { MigrationRecord } from '../src/migration-log.js';

function record(ts: number, sessionId: string, targetSessionId: string): MigrationRecord {
  return {
    ts,
    via: 'cli',
    source: { tool: 'claude', sessionId, title: `t-${sessionId}` },
    target: { tool: 'dsh', sessionId: targetSessionId, paths: [`D:\\dst\\${targetSessionId}\\session.jsonl.zstd`] },
  };
}

test('append + read roundtrip, newest-first left to the caller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mlog-'));
  const log = join(dir, 'migrations.jsonl');
  process.env.CC_MIGRATE_LOG = log;
  try {
    assert.equal(migrationLogPath(), log, 'env overrides the log path');
    assert.deepEqual(await readMigrationLog(), [], 'fresh log reads empty');
    assert.equal((await appendMigrationLog(record(1, 's1', 'd1'))).ok, true);
    await appendMigrationLog(record(2, 's1', 'd2'));
    await appendMigrationLog(record(3, 's2', 'd3'));

    const all = await readMigrationLog();
    assert.equal(all.length, 3);
    assert.equal(all[0].target.sessionId, 'd1', 'append order preserved (file is the timeline)');

    const bySource = await findMigrationsBySource('claude', 's1');
    assert.deepEqual(bySource.map((r) => r.target.sessionId), ['d1', 'd2']);
    assert.equal(bySource[0].source.title, 't-s1', 'source metadata recorded');
    assert.equal((await findMigrationsBySource('claude', 'nope')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.CC_MIGRATE_LOG;
  }
});

test('append-only on disk: nothing is ever rewritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mlog-'));
  const log = join(dir, 'migrations.jsonl');
  process.env.CC_MIGRATE_LOG = log;
  try {
    await appendMigrationLog(record(1, 's1', 'd1'));
    const afterFirst = await readFile(log, 'utf8');
    await appendMigrationLog(record(2, 's1', 'd2'));
    const afterSecond = await readFile(log, 'utf8');
    assert.ok(afterSecond.startsWith(afterFirst), 'second append keeps the first line byte-identical (append-only)');
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.CC_MIGRATE_LOG;
  }
});

test('CC_MIGRATE_LOG=off disables both write and read', async () => {
  process.env.CC_MIGRATE_LOG = 'off';
  try {
    assert.equal(migrationLogPath(), null);
    assert.equal((await appendMigrationLog(record(1, 's1', 'd1'))).ok, true, 'append is a silent no-op');
    assert.deepEqual(await readMigrationLog(), []);
  } finally {
    delete process.env.CC_MIGRATE_LOG;
  }
});

test('corrupt lines are skipped, good rows still readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-mlog-'));
  const log = join(dir, 'migrations.jsonl');
  process.env.CC_MIGRATE_LOG = log;
  try {
    await writeFile(log, '{"ts":1,"via":"cli","source":{"tool":"claude","sessionId":"s1"},"target":{"tool":"dsh","sessionId":"d1","paths":[]}}\n{"ts":2,"via":"cl', 'utf8');
    const all = await readMigrationLog();
    assert.equal(all.length, 1, 'half-written tail line skipped');
    assert.equal(all[0].target.sessionId, 'd1');
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.CC_MIGRATE_LOG;
  }
});
