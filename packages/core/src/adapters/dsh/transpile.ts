/**
 * Foreign tool-call → DSH-native tool transpilation (DSH write side only,
 * per AGENT.md「事件跨工具共识」: 转译层放在各目标写端，转译表登记在
 * docs/agents/dsh.md).
 *
 * Why: the DSH client renders tool cards from the PERSISTED log by
 * classifying the wire tool NAME (`classifyTool` → TOOL_VARIANTS in
 * dsh-client-ui-tool: bash/pwsh→bash, read/web_fetch→read,
 * web_search/grep/glob→search, write→write, edit→edit, run_code→code;
 * unknown names fall to the generic "others" card) and reading arguments
 * from the `tool/call` event's `arguments` JSON (FILE_PATH_KEYS
 * ["path","file_path"]). Foreign sessions (claude/zcode/opencode) arrive
 * with source-harness names (Read/Edit/Write/…), so every migrated tool
 * call renders as an anonymous "others" card. Renaming to the native
 * vocabulary — the schemas being near-isomorphic because DeepSeek Harness
 * was modeled on the same tool family — restores the native cards AND
 * makes resume-replay show the model calls shaped like its actual tools.
 *
 * 纪律（对齐 team/* 裁决「没有 payload 契约就没有转译」）：
 *  - every rule's target schema was read from the INSTALLED packages
 *    (~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tool-*), not guessed;
 *  - rules are SHAPE-GATED: a call only transpiles when its arguments carry
 *    the foreign dialect's signature (and every required native key maps);
 *    otherwise the call passes through untouched — 宁缺勿错;
 *  - normalizers are IDEMPOTENT for native-shaped inputs and return the
 *    SAME object reference when nothing changes, so dsh→dsh round-trips
 *    keep their byte-exact raw `arguments` strings (idempotent name key:
 *    native 'read' and opencode 'read' share a rule, but a native input is
 *    returned untouched);
 *  - keys the native schema has no slot for are dropped at write-out (the
 *    IR retains the source call verbatim — write-side per-capability
 *    discard is the established pattern); nothing is fabricated (a missing
 *    native `description` stays missing rather than being invented);
 *  - codex `shell_command` / `apply_patch` are deliberately NOT transpiled:
 *    the command string is PowerShell on Windows hosts (labeling it `bash`
 *    would misrepresent the interpreter), and an apply_patch document is a
 *    whole patch far from old_string/new_string pairs — both stay on the
 *    generic card. `update_plan` and `web_search` DO transpile (identical
 *    status vocabulary / clean query-array fold).
 *
 * Results are NOT transpiled: a tool/result carries no tool name (pairing
 * is by callId) and the client flattens un-metad result content as text —
 * foreign result text renders fine inside the native call card.
 */

/** One foreign→native rule. `normalize` contract: see module header. */
interface TranspileRule {
  /** Foreign wire names routed through this rule (case-sensitive). */
  from: readonly string[];
  /** Native DSH tool name. */
  to: string;
  /**
   * Shape-gated normalizer. Returns the SAME reference when the input is
   * already native-shaped, a rebuilt object when renamed/dropped, or null
   * when the shape does not match confidently (call passes through).
   */
  normalize(input: Record<string, unknown>): Record<string, unknown> | null;
}

/* Native schemas (installed @deepseek-ai/dsh-tool-fs / -bash / -fs-search /
 * -web / -todo), flattened to their argument keys. */
const READ_KEYS = ['file_path', 'offset', 'limit'] as const;
const BASH_KEYS = ['command', 'description', 'timeoutMs', 'workdir', 'run_in_background'] as const;

/** True when `input` has every required key and no key outside `allowed`. */
function isNativeShaped(input: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  for (const k of required) if (!(k in input)) return false;
  return Object.keys(input).every((k) => (allowed as readonly string[]).includes(k));
}

/** Rename a foreign path key to the native one; null when neither exists. */
function withNativePath(input: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof input.file_path === 'string') return input;
  if (typeof input.filePath === 'string') {
    const { filePath, ...rest } = input;
    return { file_path: filePath, ...rest };
  }
  return null;
}

const RULES: TranspileRule[] = [
  {
    // read(file_path, offset?, limit?) — claude/zcode Read + opencode read
    // (opencode crosses file_path/filePath dialects across versions).
    from: ['Read', 'read'],
    to: 'read',
    normalize(input) {
      if (isNativeShaped(input, READ_KEYS, ['file_path'])) return input;
      const mapped = withNativePath(input);
      if (!mapped) return null;
      const { offset, limit, ...rest } = mapped;
      const foreignKeys = Object.keys(rest).filter((k) => k !== 'file_path');
      if (foreignKeys.length === 0) return mapped;
      return { file_path: rest.file_path, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
    },
  },
  {
    // write(file_path, content) — claude/zcode Write + opencode write
    from: ['Write', 'write'],
    to: 'write',
    normalize(input) {
      if (isNativeShaped(input, ['file_path', 'content'], ['file_path', 'content'])) return input;
      const mapped = withNativePath(input);
      if (!mapped || typeof mapped.content !== 'string') return null;
      return { file_path: mapped.file_path, content: mapped.content };
    },
  },
  {
    // edit(file_path, old_string, new_string, replace_all?) — claude/zcode
    // Edit + opencode edit; argument names are identical across the family.
    from: ['Edit', 'edit'],
    to: 'edit',
    normalize(input) {
      if (isNativeShaped(input, ['file_path', 'old_string', 'new_string', 'replace_all'], ['file_path', 'old_string', 'new_string'])) return input;
      const mapped = withNativePath(input);
      if (!mapped || typeof mapped.old_string !== 'string' || typeof mapped.new_string !== 'string') return null;
      return {
        file_path: mapped.file_path,
        old_string: mapped.old_string,
        new_string: mapped.new_string,
        ...(typeof mapped.replace_all === 'boolean' ? { replace_all: mapped.replace_all } : {}),
      };
    },
  },
  {
    // bash(command, description, timeoutMs?, workdir?, run_in_background?) —
    // claude/zcode Bash (timeout in ms → native timeoutMs) + opencode bash.
    // description has no foreign slot in older dialects and is NOT invented.
    from: ['Bash', 'bash'],
    to: 'bash',
    normalize(input) {
      if (isNativeShaped(input, BASH_KEYS, ['command'])) return input;
      if (typeof input.command !== 'string') return null;
      const { command, timeout, description, workdir, run_in_background } = input;
      if (timeout !== undefined && typeof timeout !== 'number') return null;
      return {
        command,
        ...(typeof description === 'string' ? { description } : {}),
        ...(typeof timeout === 'number' ? { timeoutMs: timeout } : {}),
        ...(typeof workdir === 'string' ? { workdir } : {}),
        ...(typeof run_in_background === 'boolean' ? { run_in_background } : {}),
      };
    },
  },
  {
    // glob(pattern, path?) — claude/zcode Glob + opencode glob
    from: ['Glob', 'glob'],
    to: 'glob',
    normalize(input) {
      if (isNativeShaped(input, ['pattern', 'path'], ['pattern'])) return input;
      if (typeof input.pattern !== 'string') return null;
      return { pattern: input.pattern, ...(typeof input.path === 'string' ? { path: input.path } : {}) };
    },
  },
  {
    // grep(pattern, path?) — claude/zcode Grep + opencode grep; foreign-only
    // flags (output_mode/-i/-n/head_limit/…) have no native slot and drop.
    from: ['Grep', 'grep'],
    to: 'grep',
    normalize(input) {
      if (isNativeShaped(input, ['pattern', 'path'], ['pattern'])) return input;
      if (typeof input.pattern !== 'string') return null;
      return { pattern: input.pattern, ...(typeof input.path === 'string' ? { path: input.path } : {}) };
    },
  },
  {
    // web_fetch(url) — claude WebFetch {url, prompt} + opencode webfetch;
    // prompt has no native slot and drops.
    from: ['WebFetch', 'webfetch'],
    to: 'web_fetch',
    normalize(input) {
      if (isNativeShaped(input, ['url'], ['url'])) return input;
      if (typeof input.url !== 'string') return null;
      return { url: input.url };
    },
  },
  {
    // web_search(queries: string[]) — claude WebSearch {query: string} and
    // codex web_search {type:'search', query} both fold into the native 1..N
    // query array; an input already carrying `queries` passes through.
    // Idempotent for the native name: {queries} input → same reference.
    from: ['WebSearch', 'websearch', 'web_search'],
    to: 'web_search',
    normalize(input) {
      if (Array.isArray(input.queries) && input.queries.every((q) => typeof q === 'string')) return input;
      if (typeof input.query !== 'string' || !input.query) return null;
      return { queries: [input.query] };
    },
  },
  {
    // todo_write(todos: [{content, status}]) — claude TodoWrite items carry
    // an extra active_form the native schema has no slot for (dropped);
    // codex update_plan {plan:[{step,status}]} renames step→content with the
    // IDENTICAL status vocabulary (pending/in_progress/completed) — a clean
    // shape-gated rename. Unknown statuses → not confident → passthrough.
    from: ['TodoWrite', 'todowrite', 'update_plan'],
    to: 'todo_write',
    normalize(input) {
      const list = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : null;
      if (isNativeShaped(input, ['todos'], ['todos']) && Array.isArray(list)) {
        const native = list.every((t) => typeof t === 'object' && t !== null && isNativeShaped(t as Record<string, unknown>, ['content', 'status'], ['content', 'status']));
        if (native) return input;
      }
      if (!Array.isArray(list) || list.length === 0) return null;
      for (const t of list) {
        if (typeof t !== 'object' || t === null) return null;
        const item = t as Record<string, unknown>;
        // claude dialect: content required; codex dialect: step required
        if (typeof item.content !== 'string' && typeof item.step !== 'string') return null;
        if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') return null;
      }
      return {
        todos: (list as Record<string, unknown>[]).map((t) => ({
          content: (t.content ?? t.step) as string,
          status: t.status as string,
        })),
      };
    },
  },
];

const RULES_BY_NAME = new Map<string, TranspileRule>(RULES.flatMap((r) => r.from.map((n) => [n, r])));

function tryParseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export interface TranspiledCall {
  name: string;
  arguments: string;
}

/**
 * Transpile one tool invocation for the DSH write-out. Returns null when no
 * rule confidently applies — callers must then emit the call VERBATIM (the
 * source name and, when present, the raw source `arguments` string).
 *
 * @param name source wire tool name
 * @param input parsed source arguments (or an unparsed JSON string)
 * @param rawArguments the source raw arguments string, when one exists
 *   (toolCalls bucket `metadata.dsh.arguments`) — returned verbatim unless
 *   the arguments actually change, preserving dsh→dsh byte fidelity.
 */
export function transpileCall(name: unknown, input: unknown, rawArguments?: string): TranspiledCall | null {
  if (typeof name !== 'string' || !name) return null;
  const rule = RULES_BY_NAME.get(name);
  if (!rule) return null;
  const obj = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : tryParseJson(input)) as Record<string, unknown> | null;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const normalized = rule.normalize(obj);
  if (!normalized) return null;
  if (normalized === obj && typeof rawArguments === 'string') {
    // nothing changed in the arguments — keep the source string byte-exact
    return { name: rule.to, arguments: rawArguments };
  }
  return { name: rule.to, arguments: JSON.stringify(normalized) };
}

/**
 * Visibility count for the write-side console notice: how many of the
 * session's tool invocations (assistant tool_use blocks + toolCalls bucket,
 * deduped by callId, sidechains included) would transpile. Pure — walk only.
 */
export function countTranspilableToolCalls(ir: MigratedSessionLike): { count: number; breakdown: string } {
  const byFrom = new Map<string, number>();
  const seen = new Set<unknown>();
  const count = (name: unknown, input: unknown): void => {
    if (typeof name !== 'string' || !name) return;
    const rule = RULES_BY_NAME.get(name);
    if (!rule) return;
    const obj = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : tryParseJson(input)) as Record<string, unknown> | null;
    if (typeof obj !== 'object' || obj === null) return;
    if (!rule.normalize(obj)) return;
    byFrom.set(name, (byFrom.get(name) ?? 0) + 1);
  };
  const walk = (session: MigratedSessionLike): void => {
    for (const msg of session.messages ?? []) {
      for (const b of msg?.content ?? []) {
        if (b?.type !== 'tool_use') continue;
        if (typeof b.id === 'string' && b.id) {
          if (seen.has(b.id)) continue;
          seen.add(b.id);
        }
        count(b.name, b.input);
      }
    }
    for (const tc of session.toolCalls ?? []) {
      if (seen.has(tc.callId)) continue;
      seen.add(tc.callId);
      count(tc.tool, tc.input);
    }
    for (const sc of session.sidechains ?? []) walk(sc);
  };
  walk(ir);
  const total = [...byFrom.values()].reduce((a, b) => a + b, 0);
  const breakdown = [...byFrom.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}×${n}`)
    .join(', ');
  return { count: total, breakdown };
}

/** Minimal structural type so the counter can walk sessions and sidechains without importing the IR module. */
interface MigratedSessionLike {
  messages?: Array<{ content?: Array<{ type?: unknown; id?: unknown; name?: unknown; input?: unknown }> | null } | null>;
  toolCalls?: Array<{ callId: unknown; tool: unknown; input?: unknown }>;
  sidechains?: MigratedSessionLike[];
}
