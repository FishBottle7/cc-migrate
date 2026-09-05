/**
 * cc-migrate DSH plugin — agent skill 注册（对话式迁移入口）。
 *
 * DSH 宿主有 skill 体系（@deepseek-ai/dsh-skill 的 ctx.skills 注册表）：
 * 插件 apply() 时把 skills/cc-migrate/SKILL.md 作为运行时 skill 注册进去，
 * 用户就能在对话里说「帮我把 Claude 的会话迁过来」触发本 skill（也可显式
 * /cc-migrate 调用）。skill 正文教 agent 用插件自带的 agent CLI
 * （lib/cli.js）完成 list → preview → migrate；正文里的 {{CLI_PATH}} 占位符
 * 在注册时替换为本机 lib/cli.js 绝对路径 —— 用户装完插件即得可用通道，
 * 零全局安装。
 *
 * 同一份 SKILL.md 也是跨宿主安装件：不装插件的其他 agent（ZCode / Claude
 * Code 等）可把它手工拷进自己的 skill 目录（~/.agents/skills/cc-migrate/
 * 或 ~/.dsh/skills/，dsh-skill-filesystem 两大用户根），此时占位符按正文的
 * 回退规则解析（PATH 上的 cc-migrate / 重装插件提示）。
 *
 * 纪律（与 src/index.ts 同款）：结构类型、try/catch 探测 —— 老/异构宿主
 * 没有 skills 服务时 warn 一声跳过，命令层照常（向后兼容，绝不炸插件树）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 宿主 ctx.skills 的最小结构面（@deepseek-ai/dsh-skill 的 SkillRegistry.register）。 */
export interface HostSkillService {
  register(skill: {
    name: string;
    description: string;
    whenToUse?: string;
    content: string;
    /** 缺省 = 模型与用户两个面都可调用（宿主 SkillInvocationPolicy 的默认）。 */
    invocation?: { modelInvocable: boolean; userInvocable: boolean };
  }): () => void;
}

export interface SkillHostContext {
  logger?: { warn(...args: unknown[]): void; info(...args: unknown[]): void };
  skills?: HostSkillService;
}

export interface ParsedSkillFile {
  name: string;
  description: string;
  whenToUse?: string;
  /** frontmatter 之后的正文（{{CLI_PATH}} 占位符尚未替换）。 */
  body: string;
}

/** skill 包目录（lib/*.js 的 ../skills/cc-migrate —— tgz 内随包分发）。 */
export function skillDir(): string {
  // import.meta.url 指向 bundle 产物（lib/index.js 或其共享 chunk，都在 lib/
  // 下）——按包相对定位，不依赖进程 cwd。
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'cc-migrate');
}

/**
 * 极简 frontmatter 解析：`---` 围栏内 `key: value` 行（本 skill 只用平铺
 * 标量，不需要 YAML 依赖）。key 归一小写；值剥一层引号。
 */
export function parseSkillMd(raw: string): ParsedSkillFile {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  const meta: Record<string, string> = {};
  let body = raw;
  if (fence) {
    for (const line of fence[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
    body = raw.slice(fence[0].length);
  }
  const description = meta.description ?? '';
  if (!description) throw new Error('SKILL.md frontmatter has no description');
  return {
    name: meta.name || 'cc-migrate',
    description,
    ...(meta['whentouse'] || meta['when-to-use'] || meta['when_to_use']
      ? { whenToUse: meta['whentouse'] || meta['when-to-use'] || meta['when_to_use'] }
      : {}),
    body,
  };
}

/** 从包内读 SKILL.md 并解析（文件缺失/损坏时抛错，由 registerSkill 捕获降级）。 */
export function loadSkillMd(dir: string = skillDir()): ParsedSkillFile {
  return parseSkillMd(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
}

/** 正文占位符 → 本机 agent CLI 绝对路径。 */
export function renderSkillBody(body: string, cliPath: string): string {
  return body.split('{{CLI_PATH}}').join(cliPath);
}

/**
 * 注册运行时 skill。返回宿主给的注销函数（调用方走 ctx.effect 挂 fiber 清理）；
 * 任何失败（无 skills 服务 / 文件缺失 / 宿主拒绝）都降级为 warn + undefined，
 * 绝不让 skill 注册炸掉命令层。
 */
export function registerSkill(ctx: SkillHostContext, cliPath: string): (() => void) | undefined {
  const warn = (msg: string) => ctx.logger?.warn?.(`cc-migrate skill: ${msg}`);
  try {
    const skills = ctx.skills;
    if (!skills || typeof skills.register !== 'function') {
      warn('host has no skills service — skipped (commands unaffected)');
      return undefined;
    }
    const parsed = loadSkillMd();
    const disposer = skills.register({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      content: renderSkillBody(parsed.body, cliPath),
    });
    ctx.logger?.info?.(`cc-migrate skill: registered "${parsed.name}" (cli: ${cliPath})`);
    return typeof disposer === 'function' ? disposer : undefined;
  } catch (e) {
    warn(`registration skipped: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
