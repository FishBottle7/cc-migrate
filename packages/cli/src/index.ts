#!/usr/bin/env node
/**
 * session-migrate CLI.
 *
 * Usage:
 *   session-migrate list <tool> [--root <dir>]
 *   session-migrate preview <tool> <sessionId> [--root <dir>]
 *   session-migrate migrate <srcTool> <srcSessionId> <dstTool>
 *                    [--src-root <dir>] [--dst-root <dir>] [--target-cwd <path>]
 *   session-migrate wizard [--src-root <dir>] [--dst-root <dir>]  # interactive
 *   session-migrate reconcile dsh [--root <dir>]  # fix workspace.json registration
 *   session-migrate verify dsh [--root <dir>] [sessionId]  # validate artifacts
 *   session-migrate demo      # dsh->dsh self round-trip
 *   session-migrate demo2     # claude<->dsh round-trip in a temp dir
 */

import { builtinRegistry } from '@session-migrate/core';
import {
  previewSession,
  readSource,
  writeTarget,
  listSessions,
  fallbackIr,
} from '@session-migrate/core';

interface Flags {
  srcRoot?: string;
  dstRoot?: string;
  targetCwd?: string;
  root?: string;
  flatten?: boolean;
}

function parseFlags(argv: string[]): { flags: Flags; positionals: string[] } {
  const f: Flags = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const value = (name: string) => (i + 1 < argv.length ? argv[++i] : undefined);
    if (tok === '--root') f.root = value('root');
    else if (tok === '--src-root') f.srcRoot = value('src-root');
    else if (tok === '--dst-root') f.dstRoot = value('dst-root');
    else if (tok === '--target-cwd') f.targetCwd = value('target-cwd');
    else if (tok === '--flatten') f.flatten = value('flatten') !== 'false';
    else if (tok === '--no-flatten') f.flatten = false;
    else positionals.push(tok);
  }
  return { flags: f, positionals };
}

async function main(argv: string[]) {
  // Separate named flags from positional args FIRST so flags never occupy
  // positional slots (e.g. `list dsh --root X` must keep X out of positionals).
  const { flags, positionals } = parseFlags(argv);
  const [cmd, ...args] = positionals;
  const [a, b, c] = args;
  const registry = builtinRegistry();

  switch (cmd) {
    case 'list': {
      const adapter = registry.get(a as never);
      const metas = await listSessions(adapter, flags.root ?? flags.srcRoot);
      for (const m of metas) {
        console.log(`${m.sessionId}\t${m.title ?? ''}\t${m.createdAt ? new Date(m.createdAt).toISOString() : ''}\t${m.sourcePath ?? ''}`);
      }
      return;
    }
    case 'preview': {
      if (!a || !b) {
        console.error('usage: session-migrate preview <tool> <sessionId>');
        process.exit(1);
      }
      const adapter = registry.get(a as never);
      const ir = await readSource(registry, a, b, flags.root ?? flags.srcRoot);
      process.stdout.write(previewSession(adapter, ir));
      return;
    }
    case 'migrate': {
      if (!a || !b || !c) {
        console.error('usage: session-migrate migrate <srcTool> <srcSessionId> <dstTool>');
        process.exit(1);
      }
      const ir = await readSource(registry, a, b, flags.root ?? flags.srcRoot);
      const adapter = registry.get(c as never);
      const disambiguateTitle = a === 'dsh' && c === 'dsh';
      const res = await writeTarget(adapter, ir, {
        root: flags.dstRoot,
        targetCwd: flags.targetCwd ?? ir.cwd,
        flatten: flags.flatten,
        ...(disambiguateTitle ? { disambiguateTitle: true } : {}),
      });
      console.log(`migrated ${a}:${b} -> ${c}:${res.sessionId}`);
      for (const p of res.paths) console.log(`  ${p}`);
      return;
    }
    case 'reconcile': {
      if (a === 'dsh' || !a) {
        const { reconcileWorkspaces } = await import('@session-migrate/core/workspace');
        const { defaultDshRoot } = await import('@session-migrate/core');
        const root = (flags.root ?? flags.dstRoot ?? (defaultDshRoot as unknown as () => string | null)()) as string;
        if (!root) { console.error('cannot resolve DSH sessions root'); process.exit(1); }
        const res = await (reconcileWorkspaces as any)(root);
        console.log(`reconciled ${res.scanned} sessions, registered ${res.registered} orphan(s), pruned ${res.pruned ?? 0} dangling`);
        if (res.errors?.length) for (const e of res.errors) console.error('  ' + e);
        return;
      }
      console.error('usage: session-migrate reconcile [dsh] [--root <dir>]');
      process.exit(1);
    }
    case 'verify': {
      if (a === 'dsh' || !a) {
        const { verifySessionById, verifyAllSessions } = await import('@session-migrate/core/verify');
        const { defaultDshRoot } = await import('@session-migrate/core');
        const root = (flags.root ?? flags.dstRoot ?? (defaultDshRoot as unknown as () => string | null)()) as string | undefined;
        const sid = b;
        const results = sid ? [await verifySessionById(sid, root)] : await verifyAllSessions(root);
        let failed = 0;
        for (const r of results) {
          if (r.ok) {
            const s = r.stats;
            console.log(`OK   ${r.sessionId || '(root)'}  events=${s.events} assistant=${s.assistantMessages} text=${s.textBlocks} reasoning=${s.reasoningBlocks} toolCalls=${s.toolCalls} turns=${s.turns}`);
          } else {
            failed++;
            console.log(`FAIL ${r.sessionId || '(root)'}`);
            for (const issue of r.issues) {
              const at = [issue.line !== undefined ? `line ${issue.line}` : null, issue.seq !== undefined ? `seq ${issue.seq}` : null].filter(Boolean).join(', ');
              console.log(`     [${issue.check}]${at ? ' ' + at : ''}: ${issue.message}`);
            }
          }
        }
        console.log(`verified ${results.length} session(s), ${failed} failing`);
        if (failed > 0) process.exit(1);
        return;
      }
      console.error('usage: session-migrate verify [dsh] [--root <dir>] [sessionId]');
      process.exit(1);
    }
    case 'wizard':
    case 'interactive':
    case 'wiz': {
      const { runWizard } = await import('./wizard.js');
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const io = {
        print: (line: string) => console.log(line),
        question: (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
        close: () => rl.close(),
      };
      // allow preseed via flags for non-TTY callers: e.g. wizard --src-root X uses flags.srcRoot
      const pre: Record<string, unknown> = {};
      if (flags.srcRoot ?? flags.root) pre.srcRoot = flags.srcRoot ?? flags.root;
      if (flags.dstRoot) pre.dstRoot = flags.dstRoot;
      if (flags.targetCwd) pre.targetCwd = flags.targetCwd;
      if (flags.flatten !== undefined) pre.flatten = flags.flatten;
      try {
        const res = await runWizard(io, {
          builtinRegistry,
          previewSession: (await import('@session-migrate/core')).previewSession as never,
          readSource: (await import('@session-migrate/core')).readSource as never,
          writeTarget: (await import('@session-migrate/core')).writeTarget as never,
          listSessions: (await import('@session-migrate/core')).listSessions as never,
        }, pre as never);
        if (!res) process.exit(1);
      } finally {
        io.close();
      }
      return;
    }
    case 'demo': {
      await runDemo(registry);
      return;
    }
    case 'demo2': {
      await runDemoClaude(registry);
      return;
    }
    default:
      console.error('usage: session-migrate <list|preview|migrate|verify|reconcile|wizard|demo|demo2> [...]');
      process.exit(1);
  }
}

async function runDemo(registry: ReturnType<typeof builtinRegistry>) {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const ir = fallbackIr();
  const dsh = registry.get('dsh');
  console.log('--- demo: dsh -> dsh self round-trip (temp dir) ---');
  const tmp = await mkdtemp(join(tmpdir(), 'sm-demo-'));
  const res = await writeTarget(dsh, ir, { root: tmp, targetCwd: process.cwd() });
  console.log('wrote:', res.paths);
  const back = await readSource(registry, 'dsh', res.sessionId, tmp);
  console.log('round trip sessionId:', back.originSessionId);
  console.log('messages back:', back.messages.length);
  console.log('first msg role:', back.messages[0]?.role, '\ntext:', (back.messages[0]?.content[0] as { text?: string })?.text);
}

async function runDemoClaude(registry: ReturnType<typeof builtinRegistry>) {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  console.log('--- demo2: claude -> dsh -> claude round-trip (temp dirs) ---');
  const claudeRoot = await mkdtemp(join(tmpdir(), 'sm-claude-'));
  const dshRoot = await mkdtemp(join(tmpdir(), 'sm-dsh-'));

  const ir = fallbackIr();

  // IR -> Claude
  const claude = registry.get('claude');
  const w1 = await writeTarget(claude, ir, { root: claudeRoot, targetCwd: 'D:\\demo\\proj' });
  console.log('claude wrote:', w1.paths[0]);
  // Claude -> IR
  const back1 = await readSource(registry, 'claude', w1.sessionId, claudeRoot);
  console.log('claude->ir messages:', back1.messages.length, 'sessionId:', back1.originSessionId);

  // IR(claude-derived) -> DSH
  const dsh = registry.get('dsh');
  const w2 = await writeTarget(dsh, back1, { root: dshRoot, targetCwd: 'D:\\demo\\proj' });
  console.log('dsh wrote:', w2.paths[0]);
  // DSH -> IR
  const back2 = await readSource(registry, 'dsh', w2.sessionId, dshRoot);
  console.log('dsh->ir messages:', back2.messages.length);

  // verify text survives full loop
  const t0 = (ir.messages[0].content[0] as { text: string }).text;
  const t2 = (back2.messages[0].content[0] as { text: string }).text;
  console.log('first msg preserved across claude->dsh loop:', t0 === t2);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});