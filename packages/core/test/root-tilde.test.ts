/**
 * Root-tilde expansion at the orchestration chokepoint (migrate.ts).
 *
 * 「~ 没展开」是本仓库复发过的坑：GUI/CLI 的 root 入参默认是给人看的
 * `~/.claude/projects` 形态，漏展开时文件系统把 `~` 当字面目录（相对进程
 * CWD），症状是「列表能出、预览/导入必挂」。收口修法：expandHomeRoot 在
 * readSource/writeTarget/listSessions —— 所有 root 碰文件系统前的最后一
 * 站——展开一次，覆盖全部前端（独立 CLI / DSH 插件 / 桌面 App / GUI）。
 *
 * 测试用 HOME/USERPROFILE 重定向到临时目录造库（os.homedir() 每次现读
 * env，finally 恢复），绝不碰真实 ~/.claude、~/.dsh。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  builtinRegistry,
  expandHomeRoot,
  fallbackIr,
  listSessions,
  readSource,
  writeTarget,
} from '../src/index.js';

/** 临时家目录夹具：HOME/USERPROFILE 重定向，finally 恢复。 */
async function withFakeHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(join(tmpdir(), 'sm-tilde-home-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await run(home);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('expandHomeRoot: pure mapping, no filesystem access', () => {
  assert.equal(expandHomeRoot(undefined), undefined);
  assert.equal(expandHomeRoot(''), undefined);
  assert.equal(expandHomeRoot('/abs/path'), '/abs/path');
  assert.equal(expandHomeRoot('relative/path'), 'relative/path');
  // `~user` 是 shell 的能力，不归我们管——保持字面
  assert.equal(expandHomeRoot('~user/x'), '~user/x');
  const home = process.env.HOME || process.env.USERPROFILE;
  assert.ok(home);
  assert.equal(expandHomeRoot('~'), home);
  assert.equal(expandHomeRoot('~/.claude/projects'), join(home, '.claude', 'projects'));
  assert.equal(expandHomeRoot('~\\.dsh\\sessions'), join(home, '.dsh', 'sessions'));
  // 幂等：已展开的绝对路径原样过
  assert.equal(expandHomeRoot(join(home, '.claude', 'projects')), join(home, '.claude', 'projects'));
});

test('listSessions expands a tilde root at the chokepoint', async () => {
  await withFakeHome(async (home) => {
    const registry = builtinRegistry();
    const realRoot = join(home, '.claude', 'projects');
    const written = await writeTarget(registry.get('claude'), fallbackIr(), { root: realRoot, targetCwd: 'D:\\demo\\proj' });

    // `~` 形态 root 必须命中同一个会话（修复前：字面 `~` 目录 → 空列表）
    const metas = await listSessions(registry.get('claude'), '~/.claude/projects');
    assert.ok(metas.some((m) => m.sessionId === written.sessionId), 'tilde root lists the session seeded under the real home');
  });
});

test('readSource expands a tilde root at the chokepoint', async () => {
  await withFakeHome(async (home) => {
    const registry = builtinRegistry();
    const written = await writeTarget(registry.get('claude'), fallbackIr(), { root: join(home, '.claude', 'projects'), targetCwd: 'D:\\demo\\proj' });

    const ir = await readSource(registry, 'claude', written.sessionId, '~/.claude/projects');
    assert.equal(ir.messages.length > 0, true, 'tilde root parses the seeded session');
  });
});

test('writeTarget expands a tilde root at the chokepoint', async () => {
  await withFakeHome(async (home) => {
    const registry = builtinRegistry();
    // dst root 用 `~` 形态传：必须落在真实家目录下，而不是 CWD 下的字面 `~` 目录
    const written = await writeTarget(registry.get('dsh'), fallbackIr(), { root: '~/.dsh/sessions', targetCwd: 'D:\\demo\\proj' });
    for (const p of written.paths) {
      assert.ok(p.startsWith(home), `written path must land under the real home: ${p}`);
    }
  });
});
