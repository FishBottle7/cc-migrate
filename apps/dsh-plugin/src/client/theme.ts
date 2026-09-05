/**
 * cc-migrate client 半 — 主题 token（浅色/暗色双适配的核心）。
 *
 * 为什么是 var + 兜底：v0.3.0 前所有颜色是硬编码暗色——DSH 宿主切浅色
 * 主题时整个 tab 仍是暗色补丁。宿主前端跑 DSH web 设计系统，主题色以
 * CSS 自定义属性（--dsw-alias-*）下发且随宿主主题翻转（better-sidebar
 * 的视图全部消费这套 token，见其 lib/client.js 的 var(--dsw-alias-…)
 * 用法统计——label-primary/secondary/tertiary、bg-layer-1..3、border-l1/l2
 * 等）。CSS 变量沿 DOM 继承，我们的 tab 挂在 better-sidebar 容器内，
 * 天然拿得到。
 *
 * 因此每条颜色 = `var(--dsw-alias-<token>, <v0.3.0 暗色值>)`：
 *  - 宿主有变量（真机）→ 跟随宿主浅/暗主题；
 *  - 无变量（无头冒烟 SSR、老宿主）→ 兜底 = 原暗色，观感零变化。
 * token 对照表（取自 better-sidebar 消费频次 + 语义）：
 *  文本 label-primary > secondary > tertiary > dimmed；
 *  背景 bg-base > layer-1 > layer-2 > layer-3；
 *  边框 border-l1（细）/ border-l2（强）/ hairline；
 *  强调 brand-primary / button-primary-fill / interactive-bg-hover-accent；
 *  状态 state-error-primary / state-warn-label / state-success-primary /
 *       state-business-primary（紫系分类色——子会话标签/旁链卡）。
 */

export const T = {
  /* 文本 */
  fg: 'var(--dsw-alias-label-primary, #dcdce4)',
  fgBright: 'var(--dsw-alias-label-primary, #e0e0e8)',
  fg2: 'var(--dsw-alias-label-secondary, #c8c8d0)',
  fgBody: 'var(--dsw-alias-label-secondary, #c0c0cc)',
  fg3: 'var(--dsw-alias-label-tertiary, #9a9aa8)',
  /* 次要 meta 文本（时间/计数/提示/思考正文）：用 tertiary 而非 dimmed——
   * dimmed 在浅色主题是「淡化占位符」级，白底上真实信息看不清（真机浅色
   * 反馈踩过）；各自的暗色兜底值不变，暗色观感零变化 */
  dim: 'var(--dsw-alias-label-tertiary, #7a7a88)',
  dimmer: 'var(--dsw-alias-label-tertiary, #6a6a78)',
  think: 'var(--dsw-alias-label-tertiary, #8a8a9a)',
  pre: 'var(--dsw-alias-label-secondary, #a8b2c0)',

  /* 背景 */
  bg1: 'var(--dsw-alias-bg-layer-1, #1b1b23)',
  bg2: 'var(--dsw-alias-bg-layer-2, #22222b)',
  bg3: 'var(--dsw-alias-bg-layer-3, #26262f)',
  bgSide: 'var(--dsw-alias-bg-layer-1, #1d1b2a)',

  /* 边框 */
  line1: 'var(--dsw-alias-border-l1, #26262f)',
  hairline: 'var(--dsw-alias-border-l1, #2a2a33)',
  line2: 'var(--dsw-alias-border-l2, #2e2e38)',
  lineTool: 'var(--dsw-alias-border-l2, #2a2f42)',

  /* 强调（品牌/选中/hover） */
  accent: 'var(--dsw-alias-brand-primary, #4f6ef7)',
  accentBg: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(79,110,247,.16))',
  accentBgSoft: 'var(--dsw-alias-interactive-bg-hover-accent, rgba(79,110,247,.14))',
  toolName: 'var(--dsw-alias-brand-primary, #8fb7f2)',

  /* 状态 */
  err: 'var(--dsw-alias-state-error-primary, #f2a1a1)',
  errBg: 'var(--dsw-alias-state-error-primary, rgba(220,110,110,.5))',
  errBorder: 'var(--dsw-alias-state-error-primary, rgba(220,110,110,.45))',
  ok: 'var(--dsw-alias-state-success-primary, #7fd49a)',
  okSoft: 'var(--dsw-alias-state-success-primary, #8a9a8a)',
  okBorder: 'var(--dsw-alias-state-success-primary, rgba(127,212,154,.4))',
  /* 半透明绿底：透明度极低，浅/暗主题下都可读，不换 token */
  okBg: 'rgba(127,212,154,.05)',
  warn: 'var(--dsw-alias-state-warn-label, #d8a44a)',
  warnBorder: 'var(--dsw-alias-state-warn-label, rgba(216,164,74,.45))',
  warnText: 'var(--dsw-alias-state-warn-label, #e0d0a0)',
  /* 半透明暖底：透明度极低，浅/暗主题下都可读，不换 token */
  warnBg: 'rgba(216,164,74,.06)',

  /* 子会话/旁链（紫系分类色） */
  business: 'var(--dsw-alias-state-business-primary, #9a8cf2)',
  businessBright: 'var(--dsw-alias-state-business-primary, #b0a6f5)',
  businessBg: 'var(--dsw-alias-state-business-primary, rgba(118,99,224,.35))',
  businessBorder: 'var(--dsw-alias-state-business-primary, rgba(118,99,224,.4))',
} as const;
