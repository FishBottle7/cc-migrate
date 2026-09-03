# DSH — 特征与存储

> 源码：`deepseek-harness-master` @ `0.1.2-alpha.1` · 格式 `version:0`
> 锚点：`packages/session/session-persistence-jsonl/src/format.ts` · `zstd.ts` · `index.ts` · `packages/core/session/src/types.ts` · `surface.ts` · `chunk-rows.ts`

## 定位

- 默认根：`~/.dsh/sessions`（解析后冻结，`index.ts:153`）
- 路径：
  - `cwd` 有值：`<root>/--<projectKey>--/<encodeSegment(id)>/session.jsonl.zstd`
  - `cwd===undefined`：`<root>/_no-cwd/<encodeSegment(id)>/session.jsonl.zstd`（`format.ts:178`）

## 物理格式

- 单文件 = 多 zstd frame 拼接，每帧 `ZSTD_c_checksumFlag=1`（`zstd.ts:18`）
- frame 0 = header 单行 + `\n`（`assertZstdHeaderFrame:50` 强制恰好一行）
- 后续帧 = 事件批（`encodeMaterialization:635` / `encodeEventBatch`）
- 扫描为结构化帧解析（magic `0xFD2FB528` + descriptor + block header + checksum，`zstd.ts:48`），尾帧不完整返回 `tornStart`；非简单 magic 搜索
- `packChunks` 默认 `true`（`index.ts:39`）：连续 `assistant/chunk` 打包为 `text-chunks`/`reasoning-chunks`/`tool-call-chunks` 存储行（`chunk-rows.ts:9/100`），读对两种布局兼容（`decodeStorageRecord`）

## 路径编码

- `projectKey(cwd)`（`format.ts:149`）：`:`/`\`/`/` 的连续段压缩为单个 `-`，安全码元 `A-Za-z0-9._-` 保留，`~` 转义，其余 `~XXXX`，去前导 `-`，截 251，包 `--...--`；空串抛错；`/`→`--root--`
- `encodeSegment(id)`（`format.ts:123`）：`~` 转义，`.`→`~002E` / `..`→`~002E~002E`，单射（含孤代理）

## Header 行

```json
{"type":"session","version":0,"id":"session-<uuid>","createdAt":1787844419631,"cwd":"D:\\...","delegationDepth":0,"agentPreset":"standard","parentSession":"session-...","seedLength":123,"origin":"subagent"}
```

| 字段 | 约束 |
|------|------|
| `type` | `session` |
| `version` | `SESSION_FORMAT_VERSION=0`（`types.ts:56`），外来版本直接拒载 `refuseForeignFormatVersion:273` |
| `id` | brand string |
| `createdAt` | 非负 safe int，`-0` 非法 |
| `delegationDepth` | 必需，非负 safe int，顶层 0 子=`parent+1` |
| `cwd` | 可选，缺省走 `_no-cwd`，有则参与 `logPath` |
| `parentSession`/`seedLength`/`origin`/`agentPreset` | 可选；`origin` 仅 `subagent`；退役 `sandboxMode`/`approvalPolicy` 出现即抛错 `format.ts:74` |

## 事件与 Surface

- 每事件 `seq` 连续（`applySurfaceEvent:397` 校验）+ `time` + `data` + 可选 `surfaceOp`/`sourceEventSeqs`
- Surface 仅三类（`surface.ts:15`）：`user/message` | `assistant/message` | `tool/result`；其余携 `surfaceOp` 即抛错
- `surfaceOp`：`append` 或 `{op:'replace',start,end}` 闭区间替换，需 `sourceEventSeqs` 覆盖全部被遮蔽节点（`assertProvenance:211`），`tool/result` 替换仅改 `content`（`assertToolResultRewrite:287`）
- `foldSurface(events)` 重放得到 `nodes` + `replacements`；`deriveEventMessage`：`assistant/message` 的 `content.length===0` 视为 `null` 不进 surface
- 模型可见 surface（三类 `deriveEventMessage` 投影）是 resume 真实输入

## 发现与校验

- `listArtifacts:488` 仅读首 frame/header（`readFirstZstdLine/scanZstdFrames(...,1)`），校验 `header.id` 与路径一致性（含 `realpath` 大小写不敏感 `sameFile:854`），拒绝 `oppositeCompression` 与 `legacy flat-file`（`checkRootEncoding:894`）

## 可 resume 最小集合

1. header frame（`type/version/id/createdAt/delegationDepth`）
2. 事件 frame：若干 `user/message`+`assistant/message`(需 `content.length>0`)+`tool/result` 且 `surfaceOp:'append'`，`seq` 从 0 连续
3. 可选 `turn/step/tool/call` 等 log-only 事件

## IR 映射（v3 无损）

- `MigratedMessage` ↔ surface 三类；`cwd` 参与 `projectKey`；`model` 仅提示；旁链为独立 session 文件（`parentSession` 引用）
- **v3 breaking（`schemaVersion: 2`）**：`agent→IR` 零过滤（除 `encrypted_content/encrypted` 占位 `[encrypted omitted]`），`goal/change → goals`、`plan/mode → planModes`、`todo/write → todos`，其余 `~40` 类 `known-event-type` 进 `unmappedEvents`（含 `surfaceOp/sourceEventSeqs`），`session/title` 促升为 `ir.title` + 保留原事件；`IR→DSH` 按 `time` 合并重排 `seq 0..N-1` 写回，全量保留。`IR→Claude/Codex/OpenCode/Pi` 按能力表丢弃领域桶（见 `docs/plans/ir-v3-lossless-100.md §2.4`）。
- claude teammate 侧链：dsh 端显式丢弃并警告——team 事件语义不同构，转译待专项调查
