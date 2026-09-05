/**
 * Migration log — 「迁移过了吗」的一等答案。
 *
 * 每次成功的迁移在用户级 JSONL 追加一行（append-only：与 AGENT.md 铁律同款，
 * 不 rewrite、不删除）。谁消费：agent 在迁移前查重（migrate 命中的提示与
 * --json alreadyMigrated 字段）、`log check <tool> <id>` 主动查询、`log list`
 * 回顾。谁写入：独立 CLI 的 migrate 与 DSH 插件命令层的 importSession（斜杠
 * 命令 / GUI 向导 / 插件内嵌 CLI 全走这两处）。桌面 App 暂不经过这两处，
 * 不进日志（README 有说明）。
 *
 * 路径：`~/.cc-migrate/migrations.jsonl`；`CC_MIGRATE_LOG` 覆盖（测试/冒烟把
 * 它指到临时文件），值 `off`/`none` 关闭写入与读取（返回空）。读取逐行
 * try/parse——半截行（崩溃残留）跳过不炸。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolId } from './ir.js';

/** 一条迁移记录（JSONL 行）。字段只增不改；读取端容忍未知额外字段。 */
export interface MigrationRecord {
  /** 迁移完成时刻（epoch ms）。 */
  ts: number;
  /** 写入面：独立 CLI = 'cli'，DSH 插件命令层 = 'dsh-plugin'。 */
  via: 'cli' | 'dsh-plugin' | (string & {});
  source: { tool: ToolId; sessionId: string; title?: string; cwd?: string };
  target: { tool: ToolId; sessionId: string; paths: string[] };
}

export type MigrationLogOutcome = { ok: true } | { ok: false; error: string };

/** 日志文件路径（每次调用现读 env，测试随时改写生效）。 */
export function migrationLogPath(): string | null {
  const env = process.env.CC_MIGRATE_LOG?.trim();
  if (env === 'off' || env === 'none') return null;
  if (env) return env;
  return join(homedir(), '.cc-migrate', 'migrations.jsonl');
}

/** 追加一条迁移记录。写日志失败绝不影响迁移本身——返回结构化结果由调用方告警。 */
export async function appendMigrationLog(record: MigrationRecord): Promise<MigrationLogOutcome> {
  const path = migrationLogPath();
  if (!path) return { ok: true };
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 读全部记录（坏行跳过）。日志不存在 = 空数组，不报错。 */
export async function readMigrationLog(): Promise<MigrationRecord[]> {
  const path = migrationLogPath();
  if (!path) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const records: MigrationRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as MigrationRecord;
      if (parsed && typeof parsed === 'object' && parsed.source && parsed.target) records.push(parsed);
    } catch {
      // 半截行（进程中断残留）——跳过，不炸读取
    }
  }
  return records;
}

/** 按源会话查历史迁移（「这条迁过了吗」）。 */
export async function findMigrationsBySource(srcTool: string, srcSessionId: string): Promise<MigrationRecord[]> {
  const all = await readMigrationLog();
  return all.filter((r) => r.source?.tool === srcTool && r.source?.sessionId === srcSessionId);
}
