/**
 * Adapter contract + registry.
 *
 * Every tool ships one Adapter exposing the 5 capabilities that the CLI, the
 * DSH plugin and the standalone desktop app all consume from a single shared
 * core — so the format logic lives exactly once.
 */

import { compareIrVersions, IR_VERSION } from './ir.js';
import type { MigratedSession, SessionMeta, ToolId } from './ir.js';

export interface Adapter {
  readonly tool: ToolId;
  /**
   * IR protocol version this adapter was last audited against (see
   * `IR_VERSION` in ir.ts). The registry REFUSES to register an adapter whose
   * version is older than the core's — an un-synced adapter must be brought
   * up to date (write-side handling of new slots/roles per
   * docs/ir-protocol.md) before it can run at all. Bump both sides in the
   * same commit that extends the IR.
   */
  readonly irVersion: string;

  /** List available sessions in a given root/dir (or default). Lightweight. */
  listSessions(root?: string): Promise<SessionMeta[]>;

  /** Read one session fully into IR. */
  parse(sessionId: string, root?: string): Promise<MigratedSession>;

  /** Write IR back into the target tool's native, resumable storage. */
  write(ir: MigratedSession, opts?: WriteOptions): Promise<WriteResult>;

  /** Human-readable offline preview of a session (no LLM). */
  preview(session: MigratedSession): string;
}

export interface WriteOptions {
  /** Root directory where to write (defaults to this tool's standard dir). */
  root?: string;
  /** Map the IR source cwd to a target working directory (defaults to IR.cwd). */
  targetCwd?: string;
  /** Override the target session id (DSH generates a new one unless provided). */
  sessionId?: string;
  /** Cross-tool flattening: when true, hidden subagent transcripts become top-level messages. */
  flatten?: boolean;
  /**
   * When `true`, DSH self-migrations get a disambiguating title suffix
   * (`" (migrated)"`) so the export filename is visibly distinct from the
   * source. Default `false` — keeps `write` faithful / round-trip lossless.
   */
  disambiguateTitle?: boolean;
  /**
   * Keep harness-injected content (IR `synthetic` messages: DSH runtime-context
   * snapshots, `<system-reminder>` skill/instruction payloads) in the target
   * session, flagged inert where the target supports it (OpenCode text parts
   * get `ignored: true` — hidden in the timeline AND excluded from LLM replay).
   * Default `false`: drop them — the target harness manages its own runtime
   * context, and replaying the source's would fight it.
   */
  keepSynthetic?: boolean;
  /**
   * System-prompt source choice (docs/agents/codex.md §7.2 选择规范). There is
   * ONE canonical system-prompt slot per target; never stack the source
   * prompt on top of the target's own.
   *  - `'source'` (default): carry `ir.systemPrompt` into the target's native
   *    canonical slot when it has one (codex `session_meta.base_instructions`
   *    {provenance: custom}). Targets without a channel ignore it.
   *  - `'target'`: write nothing — the target opens with its own prompt.
   */
  systemPromptSource?: 'source' | 'target';
  /**
   * Foreign tool-call transpilation at the DSH write side (docs/agents/dsh.md
   * 「外来工具转译」): rename source-harness tool calls (claude/zcode
   * Read/Edit/Write/Bash/Glob/Grep/WebFetch/WebSearch/TodoWrite, opencode
   * lowercase/filePath dialects) to the DSH-native vocabulary with
   * shape-gated argument rewriting, so the DSH GUI classifies them onto the
   * native card variants and resume replay shows calls shaped like its real
   * tools. Shape-gated + idempotent (packages/core/src/adapters/dsh/
   * transpile.ts) — dsh→dsh native rows stay byte-identical; unconfident
   * shapes pass through verbatim; the IR keeps source values. Default
   * `true`; `false` keeps every call byte-faithful to the source.
   */
  transpileTools?: boolean;
}

export interface WriteResult {
  tool: ToolId;
  sessionId: string;
  /** Absolute path(s) written. */
  paths: string[];
}

export interface AdapterRegistry {
  get(tool: ToolId): Adapter;
  has(tool: ToolId): boolean;
  tools(): ToolId[];
}

class MapRegistry implements AdapterRegistry {
  #map = new Map<ToolId, Adapter>();
  register(adapter: Adapter): void {
    if (compareIrVersions(adapter.irVersion, IR_VERSION) < 0) {
      throw new Error(
        `registry: adapter "${adapter.tool}" targets IR v${adapter.irVersion} but this core speaks v${IR_VERSION} — ` +
        `sync the adapter first (write-side handling of new slots/roles, docs/ir-protocol.md「适配器适配状态」), then bump its irVersion`,
      );
    }
    if (this.#map.has(adapter.tool)) {
      throw new Error(`registry: adapter for tool "${adapter.tool}" already registered`);
    }
    this.#map.set(adapter.tool, adapter);
  }
  get(tool: ToolId): Adapter {
    const a = this.#map.get(tool);
    if (!a) throw new Error(`no adapter registered for tool "${tool}"`);
    return a;
  }
  has(tool: ToolId): boolean {
    return this.#map.has(tool);
  }
  tools(): ToolId[] {
    return [...this.#map.keys()];
  }
}

export function createRegistry(): AdapterRegistry & { register(adapter: Adapter): void } {
  return new MapRegistry();
}
