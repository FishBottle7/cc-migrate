/**
 * cc-migrate DSH plugin — 宿主半 fenced HTTP 路由层（GUI 的数据通道）。
 *
 * GUI 的 React 向导跑在浏览器（client 半，见 src/client/），迁移引擎跑在
 * DSH 的 Node 宿主半（core 的 zstd 解压只能在 Node 侧跑）——两半之间用
 * better-sidebar 同款的「宿主 webServer 服务 + fenced JSON 路由」桥接：
 * 客户端 fetch `/cc-migrate/api/<method>`，宿主半把请求转发给命令层
 * （src/commands.ts 的纯函数），结果以 `{ok:true,value}` / `{ok:false,error}`
 * 信封回写。实现照抄 dsh-better-sidebar 的 /sidebar/api（kind:'prefix' 单
 * 路由 + 方法名尾部分发），客户端 URL 形态与宿主分发代码零耦合。
 *
 * ── 浏览器信任围栏（为什么）──────────────────────────────────────
 * /api 网关同款 fence：浏览器请求必须带可信 Host（回环或部署方声明的
 * trustedHosts），且带 Origin 时必须与 Host 同主机。这是防 DNS rebinding /
 * 跨站页打到宿主路由的围栏，不是鉴权——better-sidebar 的 trust-fence.ts
 * 没有导出（它不发布这些 helper，依赖它的内部实现会碎），这里按 BSD-3
 * 同款语义重实现（源码级对照：src/trust-fence.ts），fence 决策只读
 * `ctx.webRuntime.trustedHosts` 的【活性】值——每请求现读，宿主换列表
 * 不用重启插件。
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────
 * src/index.ts 保持「注册 + 参数解析 + fiber 清理」的薄壳纪律；本文件
 * 是可无头测试的路由构造器：buildMigrateRoutes(ctx) 返回方法表 + 路由
 * 注册闭包，宿主/冒烟共用同一实现（宿主同形 mock 纪律——mock 的
 * webServer 形状与 @deepseek-ai/dsh-host-webserver 的 register 契约同形：
 * `{kind, path, handler} => disposer`）。
 */

import {
  importSession,
  listSources,
  previewPayload,
} from './commands.js';
import type {
  ImportOptions,
  ImportOutcome,
  ListSourcesOutcome,
  PreviewPayload,
  PreviewPayloadOutcome,
} from './commands.js';

/* ── 结构类型（宿主同形，不依赖 cordis 包）───────────────────────
 * 与 better-sidebar src/context-types.ts 的 SidebarHttpRequest/Response/
 * WebRoute 同款：node IncomingMessage/ServerResponse 的结构子集，宿主半
 * 可见 Node 类型（本文件不进 client 声明图），mock 也按同一形状造。
 */
export interface MigrateHttpRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

export interface MigrateHttpResponse {
  statusCode: number;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Uint8Array): void;
}

export interface MigrateWebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: MigrateHttpRequest, res: MigrateHttpResponse) => void | Promise<void>;
}

/** dsh-host-webserver 服务面（结构镜像：register 恒返回注销函数）。 */
export interface MigrateWebServer {
  register(route: MigrateWebRoute): () => void;
}

/** dsh-web-runtime 服务面（fence 只读 trustedHosts 的活性值）。 */
export interface MigrateWebRuntime {
  readonly trustedHosts: readonly string[];
}

/** 宿主 ctx 的本文件消费面（index.ts 的 PluginContext 再交并）。 */
export interface RoutesContext {
  webServer?: MigrateWebServer;
  webRuntime?: MigrateWebRuntime;
}

/* ── wire 助手（better-sidebar src/wire.ts 同款信封）───────────── */

/** 一处错误码（宿主 4xx/5xx 与 code 配对；泛化用 internal 500）。 */
type MigrateErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'too-large'
  | 'internal';

/** Wire 错误：code + HTTP status（commands 层的 {ok:false,error} 在这里升级）。 */
class MigrateWireError extends Error {
  constructor(
    readonly code: MigrateErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** 请求体上限（防无界读；预览载荷在命令层已截断，1MB 足够）。 */
const MAX_BODY_BYTES = 1 << 20;

/** 读 + 解析 JSON 请求体（有界；坏 JSON → bad-request）。 */
async function readJsonBody(req: MigrateHttpRequest): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new MigrateWireError('too-large', 'request body too large', 413);
    }
    chunks.push(buffer);
  }
  const parts: number[] = [];
  for (const c of chunks) parts.push(...c);
  const text = new TextDecoder().decode(new Uint8Array(parts));
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MigrateWireError('bad-request', 'request body is not valid JSON');
  }
}

function writeJson(res: MigrateHttpResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function writeError(res: MigrateHttpResponse, error: unknown): void {
  if (error instanceof MigrateWireError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } });
}

/* ── fence（/api 网关同款：Host 回环/trusted + 浏览器同源标记）──── */

function header(headers: MigrateHttpRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    // 与 better-sidebar 同款：canonical 化后按 host（含显式端口）或裸 hostname 匹配
    const entryPort = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
    const canonical = entryPort === '' ? entryUrl.hostname : `${entryUrl.hostname}:${entryPort}`;
    const target = entryPort === '' ? hostUrl.hostname : hostUrl.host;
    return canonical === target || entryUrl.hostname === hostUrl.hostname;
  });
}

/**
 * 一次请求是否可信（每请求现读 trustedHosts——列表换血即时生效）：
 * Host 头必须回环或命中 trustedHosts；sec-fetch-site: cross-site 拒绝；
 * 带 Origin 时 Origin 主机名必须与 Host 同主机（缺 Origin 放行——Host 围栏
 * 已绑定授权，非浏览器客户端不带 Origin）。
 */
export function isTrustedMigrateRequest(req: MigrateHttpRequest, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(req.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).hostname === hostUrl.hostname;
  } catch {
    return false;
  }
}

/* ── 载荷提取（要求 string 字段，坏形状 → bad-request）─────────── */

function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null;
  const value = record?.[key];
  if (typeof value !== 'string') {
    throw new MigrateWireError('bad-request', `missing or invalid "${key}"`);
  }
  return value;
}

function optionalString(payload: unknown, key: string): string | undefined {
  const record = payload as Record<string, unknown> | null;
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalBoolean(payload: unknown, key: string): boolean | undefined {
  const record = payload as Record<string, unknown> | null;
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** 单个 method handler 表（宿主分发循环查这个表）。 */
export type MigrateApiMethod = (payload: unknown) => Promise<unknown> | unknown;

/**
 * 路由前缀：客户端 fetch 的基址（better-sidebar 用 '/sidebar/api'，我们用
 * '/cc-migrate/api'——插件自己的命名空间，不与宿主 /api 网关冲突）。
 */
export const MIGRATE_API_PREFIX = '/cc-migrate/api';

/** 四个 method 名（client 半 fetch 路径 + 冒烟断言共用）。 */
export const MIGRATE_API_METHODS = ['list-sources', 'preview', 'import', 'defaults'] as const;

/**
 * DSH 适配器的常识默认根（显示用）。import 不带 root 时命令层走
 * `opts.root ?? defaultRoot`，defaultRoot 由 core 的 dsh 适配器解析为
 * 真实 ~/.dsh/sessions——client 半拿不到宿主的路径解析，只能显示这个
 * 常识形态；插件配置了 dstRoot（bundle patch）时走 `defaults` 端点回显
 * 真值。确认页红线：目标根必须显式展示，不允许「写到哪算哪」。
 */
export const DSH_DEFAULT_ROOT_DISPLAY = '~/.dsh/sessions';

/**
 * 方法表构造器：把命令层纯函数映射到 wire method。命令层已把所有失败
 * 折叠成 {ok:false,error}（不抛），这里升级成 wire 信封——泛化异常兜
 * internal 500。preview 走 previewPayload（GUI 吃结构化 DTO，不吃 CLI 平
 * 文本——gui-smoke 的同一裁定）。
 */
export function buildMigrateApi(opts: { dstRoot?: string } = {}): Record<string, MigrateApiMethod> {
  return {
    'list-sources': async (payload): Promise<ListSourcesOutcome> =>
      listSources(requireString(payload, 'tool'), optionalString(payload, 'root')),

    'preview': async (payload): Promise<PreviewPayloadOutcome> =>
      previewPayload(
        requireString(payload, 'tool'),
        requireString(payload, 'sessionId'),
        optionalString(payload, 'root'),
      ) as unknown as PreviewPayloadOutcome,

    'import': async (payload): Promise<ImportOutcome> =>
      importSession(requireString(payload, 'tool'), requireString(payload, 'sessionId'), {
        srcRoot: optionalString(payload, 'srcRoot'),
        targetCwd: optionalString(payload, 'targetCwd'),
        // GUI 不让用户挑目标 session id（总是 core 铸新 id——read-old-write-new）
        root: optionalString(payload, 'root') ?? opts.dstRoot,
        flatten: optionalBoolean(payload, 'flatten'),
        keepSynthetic: optionalBoolean(payload, 'keepSynthetic'),
      } satisfies ImportOptions),

    /**
     * 目标根回显（v0.3.0 新端点）：确认页红线「显式展示目标根」的数据源。
     * dstRoot 是插件 bundle patch 的配置值（未配置为 null——client 半显示
     * DSH_DEFAULT_ROOT_DISPLAY）；同 fence 保护（同前缀路由，无独立面），
     * 只回显路径配置、不回显任何凭据。
     */
    'defaults': async (): Promise<{ dstRoot: string | null; dshDefaultRoot: string }> =>
      ({ dstRoot: opts.dstRoot ?? null, dshDefaultRoot: DSH_DEFAULT_ROOT_DISPLAY }),
  };
}

/* ── 路由注册闭包（index.ts apply() 里经 ctx.effect 挂进 fiber 清理）── */

/**
 * 注册 /cc-migrate/api 前缀路由。返回注销函数（webServer.register 的
 * disposer 原样回传——cordis fiber disposal 时一起收掉）。宿主没有
 * webServer/webRuntime 服务时返回 undefined（命令层照常，GUI fetch 会
 * 404——向后兼容老宿主）。
 *
 * ⚠ ctx 探测必须 try/catch：cordis ctx 是按 inject 门禁的 Proxy，访问未
 * inject 的属性直接抛而不是 undefined（真机验证踩过）。
 */
export function registerMigrateRoutes(
  ctx: RoutesContext & { logger?: { warn(...args: unknown[]): void } },
  opts: { dstRoot?: string } = {},
): (() => void) | undefined {
  const webServer = ctx.webServer;
  const webRuntime = ctx.webRuntime;
  if (webServer === undefined || webRuntime === undefined) {
    ctx.logger?.warn('cc-migrate gui: host provides no webServer/webRuntime service — HTTP routes skipped (commands still registered)');
    return undefined;
  }
  const api = buildMigrateApi(opts);
  const disposer = webServer.register({
    kind: 'prefix',
    path: MIGRATE_API_PREFIX,
    handler: async (req, res): Promise<void> => {
      // fence 每请求现读 trustedHosts 活性值（宿主换列表即时生效）
      if (!isTrustedMigrateRequest(req, webRuntime.trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } });
        return;
      }
      // 方法名 = 前缀后的第一段（better-sidebar 同款分发：段内再带 / 即 404）
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const method = pathname.startsWith(`${MIGRATE_API_PREFIX}/`)
        ? pathname.slice(MIGRATE_API_PREFIX.length + 1)
        : undefined;
      if (method === undefined || method.includes('/')) {
        writeError(res, new MigrateWireError('not-found', 'unknown cc-migrate API method', 404));
        return;
      }
      try {
        const payload = await readJsonBody(req);
        const handler = api[method];
        if (handler === undefined) {
          throw new MigrateWireError('not-found', `unknown cc-migrate API method "${method}"`, 404);
        }
        const outcome = await handler(payload);
        if (
          outcome !== null && typeof outcome === 'object' && 'ok' in outcome && (outcome as { ok: unknown }).ok === false
        ) {
          // 命令层结构化错误 → 4xx 信封（信息原样带出，GUI 渲染 error 行）
          const message = (outcome as { error?: unknown }).error;
          writeError(res, new MigrateWireError('bad-request', typeof message === 'string' ? message : 'command failed'));
          return;
        }
        writeJson(res, 200, { ok: true, value: outcome });
      } catch (error) {
        writeError(res, error);
      }
    },
  });
  return typeof disposer === 'function' ? disposer : undefined;
}
