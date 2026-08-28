/**
 * Demo helper — builds a small synthetic IR session used by the CLI `demo`
 * command and the self round-trip acceptance test.
 */

import type { MigratedSession } from './ir.js';

export function fallbackIr(): MigratedSession {
  const now = Date.now();
  return {
    schemaVersion: 1,
    originTool: 'dsh',
    createdAt: now,
    messages: [
      {
        role: 'user',
        timestamp: now - 10_000,
        content: [{ type: 'text', text: '你好，帮我看看这个迁移工具的想法怎么样？' }],
      },
      {
        role: 'assistant',
        timestamp: now,
        content: [
          { type: 'text', text: '这个想法很有意思。核心是把各家工具的统一成一套中间表示，避免两两手写转换。' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { file_path: 'docs/design.md' } },
        ],
      },
      {
        role: 'tool',
        timestamp: now + 1,
        content: [{ type: 'tool_result', toolUseId: 'call-1', content: '<design.md 内容略>', isError: false }],
      },
    ],
  };
}