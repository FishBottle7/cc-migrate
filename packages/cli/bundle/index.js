#!/usr/bin/env node
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, promises } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { readFile, readdir, realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region ../core/dist/src/ir.js
/** Compare two dotted IR versions ('3.2' < '3.10' < '4.0'). */
function compareIrVersions(a, b) {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}
const MESSAGE_ROLES = /* @__PURE__ */ new Set([
	"user",
	"assistant",
	"tool",
	"system",
	"developer"
]);
const TOOL_IDS = /* @__PURE__ */ new Set([
	"dsh",
	"claude",
	"codex",
	"opencode",
	"pi",
	"zcode",
	"unknown"
]);
/**
* Block-level closed-set guard (hardening layer 1). Unknown block types are
* REJECTED — new block vocabulary must go through the IR evolution process
* (docs/ir-protocol.md 设计共识 #4); temporary payloads ride `meta`/`extensions`.
*/
function isValidFileBlock(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const f = v;
	if (f.type !== "file") return false;
	for (const key of [
		"filename",
		"mediaType",
		"data",
		"url"
	]) if (f[key] !== void 0 && typeof f[key] !== "string") return false;
	return f.filename !== void 0 || f.data !== void 0 || f.url !== void 0;
}
function isContentBlock(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const b = v;
	switch (b.type) {
		case "text": return typeof b.text === "string";
		case "tool_use": return typeof b.id === "string" && !!b.id && typeof b.name === "string" && !!b.name && b.input !== void 0;
		case "tool_result":
			if (typeof b.toolUseId !== "string") return false;
			if (typeof b.content !== "string") return false;
			if (b.isError !== void 0 && typeof b.isError !== "boolean") return false;
			if (b.attachments !== void 0) {
				if (!Array.isArray(b.attachments)) return false;
				for (const att of b.attachments) if (!isValidFileBlock(att)) return false;
			}
			return true;
		case "thinking": return typeof b.thinking === "string" && (b.signature === void 0 || typeof b.signature === "string");
		case "file": return isValidFileBlock(b);
		default: return false;
	}
}
function isMigratedMessage(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const m = v;
	if (typeof m.role !== "string" || !MESSAGE_ROLES.has(m.role)) return false;
	if (!Array.isArray(m.content)) return false;
	for (const block of m.content) if (!isContentBlock(block)) return false;
	if (m.meta !== void 0 && (typeof m.meta !== "object" || m.meta === null || Array.isArray(m.meta))) return false;
	if (m.seq !== void 0 && typeof m.seq !== "number") return false;
	if (m.timestamp !== void 0 && typeof m.timestamp !== "number") return false;
	if (m.synthetic !== void 0 && typeof m.synthetic !== "boolean") return false;
	for (const key of [
		"provider",
		"model",
		"stopReason"
	]) if (m[key] !== void 0 && typeof m[key] !== "string") return false;
	return true;
}
function isValidSidechain(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const s = v;
	if (typeof s.agentId !== "string" || !s.agentId) return false;
	if (s.kind !== "subagent" && s.kind !== "teammate") return false;
	if (!Array.isArray(s.messages)) return false;
	for (const msg of s.messages) if (!isMigratedMessage(msg)) return false;
	if (s.toolCalls !== void 0) {
		if (!Array.isArray(s.toolCalls)) return false;
		for (const tc of s.toolCalls) if (!isValidToolCall(tc)) return false;
	}
	if (s.unmappedEvents !== void 0) {
		if (!Array.isArray(s.unmappedEvents)) return false;
		for (const e of s.unmappedEvents) if (!isValidUnmappedEvent(e)) return false;
	}
	if (s.sessionEvents !== void 0) {
		if (!Array.isArray(s.sessionEvents)) return false;
		for (const e of s.sessionEvents) if (!isValidUnmappedEvent(e)) return false;
	}
	for (const key of [
		"goals",
		"planModes",
		"todos"
	]) {
		const bucket = s[key];
		if (bucket === void 0) continue;
		if (!Array.isArray(bucket)) return false;
		for (const g of bucket) {
			if (typeof g !== "object" || g === null || Array.isArray(g)) return false;
			const entry = g;
			if (typeof entry.seq !== "number" || typeof entry.time !== "number") return false;
			if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) return false;
		}
	}
	if (s.compaction !== void 0) {
		if (!Array.isArray(s.compaction)) return false;
		for (const c of s.compaction) {
			if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
			if (typeof c.summary !== "string") return false;
		}
	}
	if (s.meta !== void 0 && (typeof s.meta !== "object" || s.meta === null || Array.isArray(s.meta))) return false;
	if (s.sidechains !== void 0) {
		if (!Array.isArray(s.sidechains)) return false;
		for (const nested of s.sidechains) if (!isValidSidechain(nested)) return false;
	}
	return true;
}
const TOOL_CALL_STATUSES = /* @__PURE__ */ new Set([
	"pending",
	"running",
	"completed",
	"error"
]);
function isValidToolCall(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const t = v;
	if (typeof t.callId !== "string" || !t.callId) return false;
	if (typeof t.tool !== "string" || !t.tool) return false;
	if (typeof t.status !== "string" || !TOOL_CALL_STATUSES.has(t.status)) return false;
	for (const key of [
		"output",
		"error",
		"title"
	]) if (t[key] !== void 0 && typeof t[key] !== "string") return false;
	if (t.metadata !== void 0 && (typeof t.metadata !== "object" || t.metadata === null || Array.isArray(t.metadata))) return false;
	if (t.time !== void 0) {
		if (typeof t.time !== "object" || t.time === null || Array.isArray(t.time)) return false;
		const time = t.time;
		if (time.start !== void 0 && typeof time.start !== "number") return false;
		if (time.end !== void 0 && typeof time.end !== "number") return false;
	}
	if (t.source !== void 0) {
		if (typeof t.source !== "object" || t.source === null || Array.isArray(t.source)) return false;
		const src = t.source;
		if (typeof src.messageId !== "string" || !src.messageId) return false;
		if (typeof src.messageSequence !== "number" || typeof src.partSequence !== "number") return false;
	}
	return true;
}
function isValidUnmappedEvent(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const e = v;
	if (typeof e.seq !== "number" || typeof e.time !== "number") return false;
	if (typeof e.type !== "string") return false;
	if (e.surfaceOp !== void 0 && typeof e.surfaceOp !== "string") return false;
	if (e.ignorable !== void 0 && typeof e.ignorable !== "boolean") return false;
	if (e.sourceEventSeqs !== void 0) {
		if (!Array.isArray(e.sourceEventSeqs)) return false;
		for (const s of e.sourceEventSeqs) if (typeof s !== "number") return false;
	}
	return true;
}
/** Best-effort pointer to WHICH block of a malformed message failed, for error paths. */
function firstBlockProblem(msg) {
	if (typeof msg !== "object" || msg === null) return "";
	const m = msg;
	if (typeof m.role !== "string" || !MESSAGE_ROLES.has(m.role)) return ` (role=${JSON.stringify(m.role ?? null)})`;
	if (!Array.isArray(m.content)) return " (content not an array)";
	for (const [j, block] of m.content.entries()) if (!isContentBlock(block)) return ` (content[${j}] rejected: ${safeJson$3(typeof block === "object" && block !== null ? {
		...block,
		...block.input !== void 0 ? { input: "<…>" } : {}
	} : block)})`;
	return " (field type violation)";
}
function validateSession(ir) {
	if (!ir || typeof ir !== "object") throw new Error("validateSession: ir is not an object");
	if (ir.schemaVersion !== 2) throw new Error("validateSession: schemaVersion must be 2");
	if (typeof ir.originTool !== "string" || !TOOL_IDS.has(ir.originTool)) throw new Error(`validateSession: originTool must be a ToolId, got ${JSON.stringify(ir.originTool)}`);
	if (!Array.isArray(ir.messages)) throw new Error("validateSession: messages must be an array");
	for (const [i, msg] of ir.messages.entries()) if (!isMigratedMessage(msg)) throw new Error(`validateSession: message[${i}] is malformed${firstBlockProblem(msg)}`);
	if (ir.sidechains !== void 0) {
		if (!Array.isArray(ir.sidechains)) throw new Error("validateSession: sidechains must be an array");
		for (const [i, sc] of ir.sidechains.entries()) if (!isValidSidechain(sc)) throw new Error(`validateSession: sidechains[${i}] is malformed`);
	}
	if (ir.toolCalls !== void 0) {
		if (!Array.isArray(ir.toolCalls)) throw new Error("validateSession: toolCalls must be an array");
		for (const [i, tc] of ir.toolCalls.entries()) if (!isValidToolCall(tc)) throw new Error(`validateSession: toolCalls[${i}] is malformed`);
	}
	if (ir.compaction !== void 0) {
		if (!Array.isArray(ir.compaction)) throw new Error("validateSession: compaction must be an array");
		for (const [i, c] of ir.compaction.entries()) {
			if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error(`validateSession: compaction[${i}] is malformed`);
			if (typeof c.summary !== "string") throw new Error(`validateSession: compaction[${i}].summary must be a string`);
			const comp = c;
			if (comp.anchorIndex !== void 0 && typeof comp.anchorIndex !== "number") throw new Error(`validateSession: compaction[${i}].anchorIndex must be a number`);
			if (comp.tokensBefore !== void 0 && typeof comp.tokensBefore !== "number") throw new Error(`validateSession: compaction[${i}].tokensBefore must be a number`);
			if (comp.firstKeptId !== void 0 && typeof comp.firstKeptId !== "string") throw new Error(`validateSession: compaction[${i}].firstKeptId must be a string`);
			if (comp.retainedTail !== void 0 && !Array.isArray(comp.retainedTail)) throw new Error(`validateSession: compaction[${i}].retainedTail must be an array`);
			if (comp.replacementHistory !== void 0) {
				if (!Array.isArray(comp.replacementHistory)) throw new Error(`validateSession: compaction[${i}].replacementHistory must be an array`);
				for (const [j, msg] of comp.replacementHistory.entries()) if (!isMigratedMessage(msg)) throw new Error(`validateSession: compaction[${i}].replacementHistory[${j}] is malformed`);
			}
			if (comp.meta !== void 0 && (typeof comp.meta !== "object" || comp.meta === null || Array.isArray(comp.meta))) throw new Error(`validateSession: compaction[${i}].meta must be an object`);
		}
	}
	if (ir.branchSummaries !== void 0) {
		if (!Array.isArray(ir.branchSummaries)) throw new Error("validateSession: branchSummaries must be an array");
		for (const [i, bs] of ir.branchSummaries.entries()) {
			const b = bs;
			if (typeof b !== "object" || b === null || typeof b.fromId !== "string" || typeof b.summary !== "string") throw new Error(`validateSession: branchSummaries[${i}] must be { fromId: string, summary: string }`);
			if (b.anchorIndex !== void 0 && typeof b.anchorIndex !== "number") throw new Error(`validateSession: branchSummaries[${i}].anchorIndex must be a number`);
			if (b.time !== void 0 && typeof b.time !== "number") throw new Error(`validateSession: branchSummaries[${i}].time must be a number`);
			if (b.meta !== void 0 && (typeof b.meta !== "object" || b.meta === null || Array.isArray(b.meta))) throw new Error(`validateSession: branchSummaries[${i}].meta must be an object`);
		}
	}
	for (const key of [
		"goals",
		"planModes",
		"todos"
	]) {
		const bucket = ir[key];
		if (bucket === void 0) continue;
		if (!Array.isArray(bucket)) throw new Error(`validateSession: ${key} must be an array`);
		for (const [i, g] of bucket.entries()) {
			if (typeof g !== "object" || g === null || Array.isArray(g)) throw new Error(`validateSession: ${key}[${i}] is malformed`);
			const entry = g;
			if (typeof entry.seq !== "number" || typeof entry.time !== "number") throw new Error(`validateSession: ${key}[${i}] must carry numeric seq/time`);
			if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) throw new Error(`validateSession: ${key}[${i}].data must be an object`);
		}
	}
	for (const key of ["unmappedEvents", "sessionEvents"]) {
		const bucket = ir[key];
		if (bucket === void 0) continue;
		if (!Array.isArray(bucket)) throw new Error(`validateSession: ${key} must be an array`);
		for (const [i, e] of bucket.entries()) if (!isValidUnmappedEvent(e)) throw new Error(`validateSession: ${key}[${i}] is malformed`);
	}
	if (ir.meta !== void 0 && (typeof ir.meta !== "object" || ir.meta === null || Array.isArray(ir.meta))) throw new Error("validateSession: meta must be an object");
	if (ir.prLink !== void 0) {
		if (typeof ir.prLink !== "object" || ir.prLink === null || Array.isArray(ir.prLink)) throw new Error("validateSession: prLink must be an object");
		const pr = ir.prLink;
		if (typeof pr.prNumber !== "number" || typeof pr.prUrl !== "string" || typeof pr.prRepository !== "string") throw new Error("validateSession: prLink must carry prNumber/prUrl/prRepository");
	}
	if (ir.tag !== void 0 && typeof ir.tag !== "string") throw new Error("validateSession: tag must be a string");
	if (ir.permissionMode !== void 0 && typeof ir.permissionMode !== "string") throw new Error("validateSession: permissionMode must be a string");
	if (ir.systemPrompt !== void 0 && typeof ir.systemPrompt !== "string") throw new Error("validateSession: systemPrompt must be a string");
	if (ir.extensions !== void 0) {
		if (typeof ir.extensions !== "object" || ir.extensions === null || Array.isArray(ir.extensions)) throw new Error("validateSession: extensions must be an object");
		const claude = ir.extensions.claude;
		if (claude !== void 0 && (typeof claude !== "object" || claude === null || Array.isArray(claude))) throw new Error("validateSession: extensions.claude must be an object");
		const claudeRecordsRaw = claude?.recordsRaw;
		if (claudeRecordsRaw !== void 0 && !Array.isArray(claudeRecordsRaw)) throw new Error("validateSession: extensions.claude.recordsRaw must be an array");
	}
	if (ir.model !== void 0) {
		if (typeof ir.model !== "object" || ir.model === null || Array.isArray(ir.model)) throw new Error("validateSession: model must be an object { id }");
		const m = ir.model;
		if (typeof m.id !== "string" || !m.id) throw new Error("validateSession: model.id must be a non-empty string");
	}
	return ir;
}
function safeJson$3(v) {
	try {
		const s = JSON.stringify(v);
		return s && s.length > 200 ? `${s.slice(0, 200)}…` : s ?? "";
	} catch {
		return String(v);
	}
}
//#endregion
//#region ../core/dist/src/content.js
/**
* Shared content-normalization between tool formats and the IR v2.
*
* Each tool stores content blocks slightly differently (DSH/Claude use a
* text/tool_use/tool_result/thinking block vocabulary; Codex uses Responses blocks).
* These helpers fold those heterogeneous arrays into IR ContentBlock[] and
* render IR blocks to plain text for offline preview.
*/
/**
* Normalize an arbitrary content array into IR ContentBlock[].
* Accepts: text strings, `{type:'text',text}`, `{type:'tool_use',id,name,input}`,
* `{type:'tool_result',toolUseId/content[,content-array with images]}`,
* `{type:'thinking',thinking[,signature]}`, image/file blocks, and best-effort
* fallbacks. Images/files are preserved as FileBlocks (never flattened).
*/
function normalizeContent(content) {
	const out = [];
	for (const c of content) if (typeof c === "object" && c !== null && !Array.isArray(c)) {
		const block = c;
		const type = block.type;
		if (type === "text") out.push({
			type: "text",
			text: String(block.text ?? "")
		});
		else if (type === "thinking") {
			const thinking = String(block.thinking ?? block.text ?? "");
			const signature = typeof block.signature === "string" && block.signature ? block.signature : void 0;
			out.push(signature ? {
				type: "thinking",
				thinking,
				signature
			} : {
				type: "thinking",
				thinking
			});
		} else if (type === "tool_use") out.push({
			type: "tool_use",
			id: String(block.id ?? cryptoIdFallback(out)),
			name: String(block.name ?? "tool"),
			input: block.input
		});
		else if (type === "tool_result") {
			const toolUseId = String(block.tool_use_id ?? block.toolUseId ?? block.id ?? "");
			const inner = block.content;
			let text;
			let attachments;
			if (typeof inner === "string") text = inner;
			else if (Array.isArray(inner)) {
				const texts = [];
				attachments = [];
				for (const piece of inner) {
					if (typeof piece === "string") {
						texts.push(piece);
						continue;
					}
					const p = piece;
					if (p.type === "text" && typeof p.text === "string") {
						texts.push(p.text);
						continue;
					}
					const file = toFileBlock(piece);
					if (file) attachments.push(file);
					else texts.push(JSON.stringify(piece));
				}
				if (!attachments.length) attachments = void 0;
				text = texts.join("\n");
			} else text = JSON.stringify(inner ?? "");
			out.push(attachments ? {
				type: "tool_result",
				toolUseId,
				content: text,
				isError: Boolean(block.is_error ?? block.isError),
				attachments
			} : {
				type: "tool_result",
				toolUseId,
				content: text,
				isError: Boolean(block.is_error ?? block.isError)
			});
		} else if (type === "image" || type === "file") {
			const file = toFileBlock(block);
			if (file) out.push(file);
			else out.push({
				type: "text",
				text: `[file omitted]`
			});
		} else {
			const maybe = block.text ?? block.content;
			if (typeof maybe === "string") out.push({
				type: "text",
				text: maybe
			});
			else if (typeof block.thinking === "string") out.push({
				type: "thinking",
				thinking: block.thinking
			});
			else out.push({
				type: "text",
				text: JSON.stringify(block)
			});
		}
	} else if (typeof c === "string") out.push({
		type: "text",
		text: c
	});
	return out;
}
/** Claude/anthropic image shapes + generic file blocks → IR FileBlock. */
function toFileBlock(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return void 0;
	const b = v;
	if (b.type !== "image" && b.type !== "file") return void 0;
	const src = b.source && typeof b.source === "object" && !Array.isArray(b.source) ? b.source : void 0;
	const mediaType = typeof b.mediaType === "string" ? b.mediaType : typeof src?.media_type === "string" ? src.media_type : typeof b.mime === "string" ? b.mime : b.type === "image" ? "image/png" : void 0;
	const data = typeof b.data === "string" ? b.data : typeof src?.data === "string" ? src.data : void 0;
	const url = typeof b.url === "string" ? b.url : typeof src?.url === "string" ? src.url : void 0;
	const filename = typeof b.filename === "string" ? b.filename : typeof b.name === "string" ? b.name : void 0;
	const out = { type: "file" };
	if (filename) out.filename = filename;
	if (mediaType) out.mediaType = mediaType;
	if (data) out.data = data;
	if (url) out.url = url;
	return out.filename || out.mediaType || out.data || out.url ? out : void 0;
}
let ___cryptoCounter = 0;
function cryptoIdFallback(blocks) {
	___cryptoCounter += 1;
	return `blk_${___cryptoCounter}`;
}
/** Render IR blocks to plain text (used by preview + title inference). */
function blocksToText(blocks) {
	return blocks.map((b) => {
		switch (b.type) {
			case "text": return b.text;
			case "tool_use": return `[tool_use: ${b.name}] ${safeJson$2(b.input)}`;
			case "tool_result": return b.attachments?.length ? `${`[tool_result] ${b.content}`}\n${b.attachments.map(fileLabel).join("\n")}` : `[tool_result] ${b.content}`;
			case "thinking": return `[thinking] ${b.thinking}`;
			case "file": return fileLabel(b);
		}
	}).filter(Boolean).join("\n");
}
function fileLabel(b) {
	const name = b.filename ?? b.mediaType ?? (b.url ? "file" : "");
	return `[file${name ? `: ${name}` : ""}]`;
}
function safeJson$2(v) {
	try {
		const s = JSON.stringify(v);
		return s && s.length > 200 ? `${s.slice(0, 200)}…` : s ?? "";
	} catch {
		return String(v);
	}
}
//#endregion
//#region ../core/dist/src/registry.js
/**
* Adapter contract + registry.
*
* Every tool ships one Adapter exposing the 5 capabilities that the CLI, the
* DSH plugin and the standalone desktop app all consume from a single shared
* core — so the format logic lives exactly once.
*/
var MapRegistry = class {
	#map = /* @__PURE__ */ new Map();
	register(adapter) {
		if (compareIrVersions(adapter.irVersion, "3.3") < 0) throw new Error(`registry: adapter "${adapter.tool}" targets IR v${adapter.irVersion} but this core speaks v3.3 — sync the adapter first (write-side handling of new slots/roles, docs/ir-protocol.md「适配器适配状态」), then bump its irVersion`);
		if (this.#map.has(adapter.tool)) throw new Error(`registry: adapter for tool "${adapter.tool}" already registered`);
		this.#map.set(adapter.tool, adapter);
	}
	get(tool) {
		const a = this.#map.get(tool);
		if (!a) throw new Error(`no adapter registered for tool "${tool}"`);
		return a;
	}
	has(tool) {
		return this.#map.has(tool);
	}
	tools() {
		return [...this.#map.keys()];
	}
};
function createRegistry() {
	return new MapRegistry();
}
//#endregion
//#region ../core/dist/src/migrate.js
/**
* Orchestration: parse(source) -> IR -> write(target).
*
* The CLI, DSH plugin and desktop app all call these helpers. GUI flows are
* naturally supported: listSessions/preview come from the same adapters.
*/
/**
* Parse a source session into IR. The engine validates the adapter's output
* at this chokepoint — validation is enforced here, not left to adapter
* discipline (hardening layer 3).
*/
async function readSource(registry, sourceTool, sessionId, sourceRoot) {
	return validateSession(await registry.get(sourceTool).parse(sessionId, sourceRoot));
}
/** Write IR into the target tool. Adapter-internal validateSession calls stay as a second net. */
async function writeTarget(adapter, ir, opts) {
	validateSession(ir);
	return adapter.write(ir, opts);
}
/** Preview a session as pure offline text (no LLM). */
function previewSession(adapter, ir) {
	return adapter.preview(ir);
}
/** List sessions of a tool. */
function listSessions(adapter, root) {
	return adapter.listSessions(root);
}
/** 提取一条消息里人类可读的文本（text 块拼接；tool_result/thinking/file 不算话术）。 */
function readableText(blocks) {
	let out = "";
	for (const b of blocks) if (b.type === "text" && b.text) {
		if (out) out += "\n";
		out += b.text;
	}
	return out;
}
/** 摘录用截断：压平空白（标题里的换行/缩进最占上下文），超长加省略号。 */
function excerpt(text, cap) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, Math.max(0, cap - 1))}…` : flat;
}
/** IR → 有界摘要。纯同步、零 IO；ir 必须已 parse（readSource 之后）。 */
function summarizeIr(ir, opts = {}) {
	const cap = Math.min(Math.max(opts.excerptCap ?? 200, 20), 1e3);
	const firstCount = Math.min(Math.max(opts.firstUserMessages ?? 3, 0), 20);
	const firstUser = [];
	let last;
	let textChars = 0;
	let toolUseBlocks = 0;
	let userTurns = 0;
	let endedAt;
	for (const m of ir.messages) {
		for (const b of m.content) if (b.type === "text") textChars += b.text.length;
		else if (b.type === "tool_use") toolUseBlocks++;
		const text = readableText(m.content);
		if (m.timestamp !== void 0) endedAt = m.timestamp;
		if (!text.trim()) continue;
		if (!m.synthetic && m.role === "user") {
			userTurns++;
			if (firstUser.length < firstCount) firstUser.push(excerpt(text, cap));
		}
		if (!m.synthetic) last = {
			role: m.role,
			text: excerpt(text, cap)
		};
	}
	let sidechains = ir.sidechains?.length ?? 0;
	for (const sc of ir.sidechains ?? []) sidechains += countNested(sc.sidechains);
	return {
		tool: ir.originTool,
		sessionId: ir.originSessionId ?? "",
		...ir.title ? { title: excerpt(ir.title, Math.max(cap, 120)) } : {},
		...ir.createdAt !== void 0 ? { createdAt: ir.createdAt } : {},
		...endedAt !== void 0 ? { endedAt } : {},
		...ir.cwd ? { cwd: ir.cwd } : {},
		...ir.model?.id ? { model: ir.model.id } : {},
		stats: {
			messages: ir.messages.length,
			userTurns,
			toolUseBlocks,
			sidechains,
			textChars
		},
		firstUserMessages: firstUser,
		...last ? { lastMessage: last } : {}
	};
}
function countNested(list) {
	let n = list?.length ?? 0;
	for (const sc of list ?? []) n += countNested(sc.sidechains);
	return n;
}
//#endregion
//#region ../core/dist/src/demo.js
/**
* Demo helper — builds a small synthetic IR session used by the CLI `demo`
* command and the self round-trip acceptance test.
*/
function fallbackIr() {
	const now = Date.now();
	return {
		schemaVersion: 2,
		originTool: "dsh",
		createdAt: now,
		messages: [
			{
				role: "user",
				timestamp: now - 1e4,
				content: [{
					type: "text",
					text: "你好，帮我看看这个迁移工具的想法怎么样？"
				}]
			},
			{
				role: "assistant",
				timestamp: now,
				content: [{
					type: "text",
					text: "这个想法很有意思。核心是把各家工具的统一成一套中间表示，避免两两手写转换。"
				}, {
					type: "tool_use",
					id: "call-1",
					name: "read",
					input: { file_path: "docs/design.md" }
				}]
			},
			{
				role: "tool",
				timestamp: now + 1,
				content: [{
					type: "tool_result",
					toolUseId: "call-1",
					content: "<design.md 内容略>",
					isError: false
				}]
			}
		]
	};
}
//#endregion
//#region ../core/dist/src/adapters/dsh/format.js
/**
* DSH on-disk format helpers (path encoding + zstd physical layout).
*
* Verified against a real machine (`~/.dsh/sessions`):
*  - project directory key: separators (`:`, `\`, `/`) become `-`, unsafe code
*    units become `~XXXX`, wrapped in `--`; e.g. `D:\codes\dshPlugins`
*    -> `--D-codes-dshPlugins--`.
*  - session directory: `encodeSegment(id)`, id is a safe segment already.
*  - artifact: `session.jsonl.zstd` = concatenated independent Zstandard frames,
*    each compressed with the checksum flag (mirrors what `@deepseek-ai/dsh`
*    does with `node:zlib`). Frame 0 is the header line; later frames hold
*    batches of event rows.
*/
const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
function projectKey(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = cwd[i];
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = raw[i];
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return out;
}
/** Locate complete zstd frame [start,end) ranges in a buffer (magic scan heuristic). */
function scanZstdFrameRanges(buf) {
	const magic = Buffer.from([
		40,
		181,
		47,
		253
	]);
	const ranges = [];
	const anchors = [];
	let pos = 0;
	for (;;) {
		const found = buf.indexOf(magic, pos);
		if (found === -1) break;
		anchors.push(found);
		pos = found + 4;
	}
	for (let i = 0; i < anchors.length; i++) {
		const start = anchors[i];
		const end = i + 1 < anchors.length ? anchors[i + 1] : buf.length;
		ranges.push({
			start,
			end
		});
	}
	return ranges;
}
/** Decompress a DSH session artifact into its plaintext JSONL (header + events). */
function decompressSessionBuffer(buf) {
	const chunks = [];
	for (const range of scanZstdFrameRanges(buf)) chunks.push(zstdDecompressSync(buf.subarray(range.start, range.end)));
	return chunks.length === 1 ? chunks[0].toString("utf8") : Buffer.concat(chunks).toString("utf8");
}
/** Decompress ONLY the first frame and return its first line (the session header). */
function readFirstFrameLine(buf) {
	const ranges = scanZstdFrameRanges(buf);
	if (ranges.length === 0) return null;
	const { start, end } = ranges[0];
	const plain = zstdDecompressSync(buf.subarray(start, end));
	const nl = plain.indexOf(10);
	return (nl === -1 ? plain : plain.subarray(0, nl)).toString("utf8").trim() || null;
}
/** Compress one plaintext frame exactly as DSH does (checksummed single frame). */
function compressFrame(plaintext) {
	return zstdCompressSync(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext), ZSTD_CHECKSUM_OPTIONS);
}
/** Default DSH sessions root for the current OS user. */
function defaultDshRoot() {
	const home = process.env.HOME || (process.env.USERPROFILE ?? null);
	return home ? join(home, ".dsh", "sessions") : null;
}
//#endregion
//#region ../core/dist/src/adapters/dsh/index.js
/**
* DSH adapter — reads/writes `~/.dsh/sessions/.../session.jsonl.zstd`.
*
* The model-visible conversation is the *surface fold* of the event log:
* only events carrying `surfaceOp:'append'` and of the three surface types
* (`user/message`, `assistant/message`, `tool/result`) produce messages. See
* design doc §2.1 and `docs/session-formats-audit.md #1`.
*
* This adapter does NOT depend on `@deepseek-ai/dsh` internals — it re-derives
* enough of the format to read/write resumable sessions using only `node:zlib`.
*
* IR protocol status (docs/ir-protocol.md「dsh 待适配清单」— all landed;
* 第二轮盘点 2026-08-29 见 docs/session-formats-audit.md §1「深度盘点 #2」):
*  1. read: `tool/call` + `tool/result` events → typed `toolCalls` records
*     (status derived from result presence/isError; raw arguments preserved).
*  2. write: `ir.toolCalls` → re-emitted `tool/call` events (a running record
*     is a lone call event — native shape for interrupted calls).
*  3. per-message native fields ride MigratedMessage.meta.dsh (IR gap #2); the
*     session header rides session-level MigratedSession.meta.dsh (v3.1) —
*     extensions no longer carries DSH state. headerRaw is CONSUMED by write()
*     (delegationDepth/agentPreset/origin/parentSession/seedLength survive).
*  4. assistant/message `usage`/`interrupted` and tool/result event-level
*     `error`/`meta` round-trip via meta.dsh (round 2).
*  5. subagent trees nest (MigratedSidechain.sidechains) with full child
*     buckets; write-back relinks parents and never clobbers an existing log.
*  6. listSessions titles via session_projcache.json → last `session/title`
*     log-scan fallback; archive state via workspace.json; `_no-cwd` layout.
*  7. claude teammate sidechains ride the SAME child-session path as
*     subagents (content preserved, no team/* events — see write()) and the
*     kind round-trips via the child header's `agentPreset` marker (2026-09-03
*     调查结论：team/* 在安装产物里只有 catalog 条目、无 payload 契约，伪造
*     team/message 行属瞎猜，故承载形态=独立子会话，见 docs/agents/dsh.md).
*/
function withDshNative(msg, native) {
	const prev = msg.meta?.dsh ?? {};
	return {
		...msg,
		meta: {
			...msg.meta ?? {},
			dsh: {
				...prev,
				...native
			}
		}
	};
}
/** True when the raw DSH content array contains ImageBlock refs anywhere
* (top level or inside tool-result interiors) — i.e. the IR projection loses
* attachment bytes/dimensions and rawContent must be stashed. */
function dshContentHasImages(content) {
	if (!Array.isArray(content)) return false;
	return content.some((b) => {
		if (typeof b !== "object" || b === null) return false;
		const rec = b;
		if (rec.type === "image") return true;
		if (rec.type === "tool-result" || rec.type === "tool_result") return dshContentHasImages(rec.content);
		return false;
	});
}
/** Project a DSH ImageBlock ({type:'image', attachment:{attachmentId, mediaType, name?}})
* into an IR FileBlock. The bytes live in DSH's attachment service keyed by
* attachmentId — the reference rides FileBlock.url (gap #4 contract: "url when
* it references bytes stored elsewhere"). */
function dshImageToFileBlock(rec) {
	const att = rec.attachment;
	if (typeof att !== "object" || att === null || Array.isArray(att)) return void 0;
	const a = att;
	const id = typeof a.attachmentId === "string" ? a.attachmentId : void 0;
	if (!id) return void 0;
	const out = {
		type: "file",
		url: `dsh-attachment://${id}`
	};
	if (typeof a.name === "string" && a.name) out.filename = a.name;
	if (typeof a.mediaType === "string" && a.mediaType) out.mediaType = a.mediaType;
	return out;
}
const SURFACE_TYPES = /* @__PURE__ */ new Set([
	"user/message",
	"assistant/message",
	"tool/result"
]);
const PACKED_CHUNK_TYPES = /* @__PURE__ */ new Set([
	"reasoning-chunks",
	"text-chunks",
	"tool-call-chunks"
]);
/**
* teammate 子会话在 header.agentPreset 里的标识前缀（kind 往返保真，2026-09-03）。
* 为什么用 agentPreset：DSH header 是 strict 白名单字段（fromHeaderLine 只透传
* version/id/createdAt/cwd/parentSession/seedLength/origin/delegationDepth/
* agentPreset，origin 闭集仅 'subagent'，retired 字段出现即抛错）——在 header
* 里添加任何自定义 kind 字段都会被 DSH 加载器整份拒载，agentPreset 是唯一
* 自由字符串原生槽位。前缀命名空间 `teammate/` 由本引擎私有约定：dsh 原生
* preset 值（standard/explore/general-purpose 等）不携带 `/`，且读端用前缀
* 判定 kind 后会把 agentType 还原为去前缀部分，两种 kind 的往返互不污染
* （subagent 的 preset 撞上前缀的零概率由 dsh 原生词汇表保证）。
*/
const DSH_TEAMMATE_PRESET_PREFIX = "teammate/";
/**
* The event types the DSH harness knows — mirrored 1:1 from
* `@deepseek-ai/dsh-session`'s generated `known-event-types.ts`
* (SESSION_FORMAT_VERSION 0, 51 entries). DSH's loader
* (`assertEventsSupported`) refuses a WHOLE log when it contains any other
* type — there is no per-row skip mechanism, and the envelope key allowlist
* (`assertSessionEventEnvelope`: type/seq/time/data/surfaceOp/sourceEventSeqs)
* rejects extra keys like a hypothetical `ignorable` marker. So replayed
* `ir.unmappedEvents` rows whose type is not in this set must be DROPPED on
* write: keeping them (marked or not) makes the artifact unloadable, while
* the IR bucket still carries them for cross-tool transfers.
*/
const DSH_KNOWN_EVENT_TYPES = /* @__PURE__ */ new Set([
	"agent-preset/selected",
	"agent/inbox/spliced",
	"approval/asked",
	"approval/decided",
	"approval/policy",
	"assistant/chunk",
	"assistant/message",
	"command/done",
	"command/run",
	"compaction/end",
	"compaction/prune",
	"compaction/start",
	"compaction/summary",
	"feedback/record",
	"goal/change",
	"hook/invoked",
	"hook/result",
	"llm/retry",
	"llm/retry-started",
	"model/selection",
	"permission/preset",
	"plan/mode",
	"request/context",
	"request/header",
	"sandbox/mode",
	"schedule/change",
	"session-log-deepseek/delivery-accepted",
	"session/end-seed",
	"session/title",
	"session/title-llm-request",
	"step/end",
	"step/start",
	"subagent/descriptor",
	"subagent/model-selection-policy",
	"team/member",
	"team/message/delivered",
	"team/message/queued",
	"team/task",
	"todo/write",
	"tool-workflow/agent-end",
	"tool-workflow/agent-start",
	"tool-workflow/run-end",
	"tool-workflow/run-start",
	"tool/call",
	"tool/code-dispatch",
	"tool/code-dispatch-start",
	"tool/result",
	"turn/end",
	"turn/start",
	"user/message",
	"web/deepseek-search-llm-request"
]);
function stripEncrypted$1(obj) {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) return obj.map(stripEncrypted$1);
	const rec = obj;
	const out = {};
	for (const [k, v] of Object.entries(rec)) {
		if (k === "encrypted_content" || k === "encrypted") {
			out[k] = "[encrypted omitted]";
			continue;
		}
		out[k] = stripEncrypted$1(v);
	}
	return out;
}
function hasEncrypted(obj) {
	if (obj === null || typeof obj !== "object") return false;
	if (Array.isArray(obj)) return obj.some(hasEncrypted);
	const rec = obj;
	if ("encrypted_content" in rec || "encrypted" in rec) return true;
	return Object.values(rec).some(hasEncrypted);
}
var DshAdapter = class {
	tool = "dsh";
	irVersion = "3.3";
	/** Parse one DSH session artifact file into IR. */
	async parse(sessionId, root) {
		const sessionsRoot = root ?? defaultDshRoot();
		if (!sessionsRoot) throw new Error("DSH: cannot resolve ~/.dsh/sessions (HOME/USERPROFILE unset)");
		const path = await this.findLog(sessionsRoot, sessionId);
		if (!path) throw new Error(`DSH: session "${sessionId}" not found under ${sessionsRoot}`);
		const lines = decompressSessionBuffer(await promises.readFile(path)).split("\n").filter((l) => l.trim().length > 0);
		if (lines.length === 0) throw new Error(`DSH: session "${sessionId}" is empty`);
		const header = JSON.parse(lines[0]);
		const events = lines.slice(1).map((l) => JSON.parse(l));
		events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
		const ir = buildIrFromEvents(header, events);
		ir.originSessionId = header.id;
		ir.cwd = header.cwd;
		ir.createdAt = header.createdAt;
		try {
			const sidechains = await this.collectSubagentSidechains(sessionsRoot, sessionId);
			if (sidechains.length > 0) ir.sidechains = [...ir.sidechains ?? [], ...sidechains];
		} catch {}
		return validateSession(ir);
	}
	/** Aggregate subagent sidechains: one cheap first-frame pass over every
	* project dir (incl. `_no-cwd`) indexes children by header.parentSession,
	* then the delegation tree is walked from `parentId`. Grandchildren nest
	* under their parent's sidechain; each child carries its full mini-session
	* buckets and its original header under meta.dsh.headerRaw. */
	async collectSubagentSidechains(root, parentId) {
		const byParent = /* @__PURE__ */ new Map();
		let projects;
		try {
			projects = await promises.readdir(root);
		} catch {
			return [];
		}
		for (const proj of projects) {
			if (!(proj === "_no-cwd" || proj.startsWith("--") && proj.endsWith("--"))) continue;
			const projDir = join(root, proj);
			let sessionDirs;
			try {
				sessionDirs = await promises.readdir(projDir);
			} catch {
				continue;
			}
			for (const sessDir of sessionDirs) {
				const log = join(projDir, sessDir, "session.jsonl.zstd");
				let buf;
				try {
					buf = await promises.readFile(log);
				} catch {
					continue;
				}
				let firstLine;
				try {
					firstLine = readFirstFrameLine(buf);
				} catch {
					continue;
				}
				if (!firstLine) continue;
				let header;
				try {
					header = JSON.parse(firstLine);
				} catch {
					continue;
				}
				if (typeof header.parentSession !== "string" || !header.parentSession) continue;
				const id = typeof header.id === "string" && header.id ? header.id : sessDir;
				const createdAt = typeof header.createdAt === "number" && Number.isSafeInteger(header.createdAt) ? header.createdAt : 0;
				const list = byParent.get(header.parentSession) ?? [];
				list.push({
					id,
					header,
					createdAt,
					log
				});
				byParent.set(header.parentSession, list);
			}
		}
		const visited = /* @__PURE__ */ new Set([parentId]);
		const build = async (pid) => {
			const refs = (byParent.get(pid) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
			const out = [];
			for (const ref of refs) {
				if (visited.has(ref.id)) continue;
				visited.add(ref.id);
				let sc;
				try {
					sc = await this.decodeSidechain(ref);
				} catch {
					continue;
				}
				const kids = await build(ref.id);
				if (kids.length > 0) sc.sidechains = kids;
				out.push(sc);
			}
			return out;
		};
		return build(parentId);
	}
	/** Fully decode one child log into a mini-session sidechain: messages plus
	* every typed bucket (toolCalls/goals/planModes/todos/compaction/title/
	* unmappedEvents) and the original header under meta.dsh.headerRaw —
	* write-back restores the child's delegationDepth/agentPreset/seedLength.
	* kind 往返保真：teammate 子会话的 header.agentPreset 带 `teammate/` 私有
	* 前缀（DSH_TEAMMATE_PRESET_PREFIX），此处按前缀还原 kind==='teammate' 并
	* 把 agentType 剥回去前缀的真值；无前缀的 preset 维持 kind==='subagent'
	* 原判定（dsh 原生子代理会话零回归）。title 侧的 `(migrated teammate)`
	* 前缀保留原样——读端不吞标识，title 是会话列表的可辨识位（有意保留）。 */
	async decodeSidechain(ref) {
		const lines = decompressSessionBuffer(await promises.readFile(ref.log)).split("\n").filter((l) => l.trim().length > 0);
		if (lines.length === 0) throw new Error("empty child log");
		const events = lines.slice(1).map((l) => JSON.parse(l));
		events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
		const childIr = buildIrFromEvents(ref.header, events);
		const rawPreset = typeof ref.header.agentPreset === "string" ? ref.header.agentPreset : void 0;
		const isTeammate = rawPreset !== void 0 && rawPreset.startsWith(DSH_TEAMMATE_PRESET_PREFIX);
		return {
			agentId: ref.id,
			kind: isTeammate ? "teammate" : "subagent",
			...rawPreset !== void 0 ? { agentType: isTeammate ? rawPreset.slice(9) || void 0 : rawPreset } : {},
			messages: childIr.messages,
			...childIr.toolCalls?.length ? { toolCalls: childIr.toolCalls } : {},
			...childIr.goals?.length ? { goals: childIr.goals } : {},
			...childIr.planModes?.length ? { planModes: childIr.planModes } : {},
			...childIr.todos?.length ? { todos: childIr.todos } : {},
			...childIr.compaction?.length ? { compaction: childIr.compaction } : {},
			...childIr.unmappedEvents?.length ? { unmappedEvents: childIr.unmappedEvents } : {},
			...childIr.title ? { title: childIr.title } : {},
			...typeof ref.header.cwd === "string" && ref.header.cwd ? { cwd: ref.header.cwd } : {},
			originSessionId: ref.id,
			createdAt: ref.createdAt,
			meta: childIr.meta
		};
	}
	/** Write an IR session into DSH's native resumable storage (new session id). */
	async write(ir, opts) {
		validateSession(ir);
		const sessionsRoot = opts?.root ?? defaultDshRoot();
		if (!sessionsRoot) throw new Error("DSH: cannot resolve ~/.dsh/sessions");
		const requestedCwd = opts?.targetCwd ?? ir.cwd ?? "";
		const cwd = requestedCwd && isAbsolute(requestedCwd) ? requestedCwd : "";
		let newId;
		if (opts?.sessionId !== void 0) {
			if (await this.sessionLogExists(sessionsRoot, cwd, opts.sessionId)) {
				const takenPath = join(sessionsRoot, dshProjectDirName(cwd), encodeSegment(opts.sessionId), "session.jsonl.zstd");
				throw new Error(`DSH: target session "${opts.sessionId}" already exists at ${takenPath} — refusing to overwrite an existing session (never clobber). Pass a different --session-id, or omit it to let the engine mint a fresh id.`);
			}
			newId = opts.sessionId;
		} else newId = await this.claimFreeSessionId(sessionsRoot, cwd, `session-${randomUUID()}`);
		const createdAt = ir.createdAt ?? Date.now();
		const migratedTitle = opts?.disambiguateTitle && ir.originTool === "dsh" && ir.title && !ir.title.endsWith("(migrated)") ? `${ir.title} (migrated)` : void 0;
		const headerRaw = ir.meta?.dsh?.headerRaw;
		const headerObj = headerRaw && typeof headerRaw === "object" && !Array.isArray(headerRaw) ? { ...headerRaw } : {
			type: "session",
			version: 0,
			delegationDepth: 0,
			agentPreset: "standard"
		};
		headerObj.type = "session";
		headerObj.id = newId;
		headerObj.createdAt = createdAt;
		if (headerObj.version === void 0) headerObj.version = 0;
		delete headerObj.sandboxMode;
		delete headerObj.approvalPolicy;
		if (cwd) headerObj.cwd = cwd;
		else delete headerObj.cwd;
		const header = JSON.stringify(headerObj);
		let irForWrite = ir;
		if (migratedTitle) {
			const patchedUnmapped = (ir.unmappedEvents ?? []).map((ev) => ev.type === "session/title" || ev.type.startsWith("session/title") ? {
				...ev,
				data: {
					...ev.data,
					title: migratedTitle
				}
			} : ev);
			irForWrite = {
				...ir,
				title: migratedTitle,
				...patchedUnmapped.length ? { unmappedEvents: patchedUnmapped } : {}
			};
		}
		const events = irToEvents(irForWrite, createdAt);
		const frame1 = buildSessionFrame(header);
		const frame2 = buildEventsFrame(events);
		const dir = join(sessionsRoot, dshProjectDirName(cwd), encodeSegment(newId));
		await promises.mkdir(dir, { recursive: true });
		const payload = Buffer.concat([frame1, frame2]);
		const finalPath = join(dir, "session.jsonl.zstd");
		try {
			await promises.writeFile(finalPath, payload, { flag: "wx" });
		} catch (e) {
			if (e?.code === "EEXIST") throw new Error(`DSH: target session "${newId}" already exists at ${finalPath} — refusing to overwrite an existing session (never clobber). Pass a different --session-id, or omit it to let the engine mint a fresh id.`);
			throw e;
		}
		const paths = [finalPath];
		const isDefaultRoot = opts?.root === void 0;
		if (isDefaultRoot && cwd) try {
			const { ensureWorkspaceRegistration } = await Promise.resolve().then(() => workspace_exports);
			await ensureWorkspaceRegistration(sessionsRoot, cwd, newId, { isDefaultRoot });
		} catch {}
		const teammateCount = (ir.sidechains ?? []).filter((s) => s.kind === "teammate").length;
		if (teammateCount > 0) console.log(`[cc-migrate/dsh] ${teammateCount} teammate sidechain(s) written as standalone child sessions (dsh team/* events are runtime-only state — content preserved, live-team semantics not translatable; see docs/agents/dsh.md)`);
		const now = Date.now();
		let childCounter = 0;
		const writeSidechain = async (sc, parentWrittenId, parentDepth) => {
			const scHeaderRaw = sc.meta?.dsh?.headerRaw;
			const candidate = typeof sc.agentId === "string" && sc.agentId.trim().length > 0 && sc.agentId !== "." && sc.agentId !== ".." && !sc.agentId.includes("/") && !sc.agentId.includes("\\") && !sc.agentId.includes(":") ? sc.agentId : `session-${randomUUID()}`;
			const childId = await this.claimFreeSessionId(sessionsRoot, this.childCwd(sc, scHeaderRaw, cwd), candidate);
			const childCreatedAt = now + ++childCounter;
			const rawDepth = scHeaderRaw?.delegationDepth;
			const presetForChild = sc.kind === "teammate" ? DSH_TEAMMATE_PRESET_PREFIX + (sc.agentType ?? "teammate") : sc.agentType ?? "standard";
			const childHeaderObj = scHeaderRaw && typeof scHeaderRaw === "object" && !Array.isArray(scHeaderRaw) ? { ...scHeaderRaw } : {
				version: 0,
				agentPreset: presetForChild
			};
			childHeaderObj.type = "session";
			childHeaderObj.id = childId;
			childHeaderObj.createdAt = childCreatedAt;
			if (childHeaderObj.version === void 0) childHeaderObj.version = 0;
			childHeaderObj.delegationDepth = typeof rawDepth === "number" && Number.isSafeInteger(rawDepth) && rawDepth >= 0 ? rawDepth : parentDepth + 1;
			childHeaderObj.parentSession = parentWrittenId;
			childHeaderObj.origin = "subagent";
			if (sc.kind === "teammate") childHeaderObj.agentPreset = presetForChild;
			else if (childHeaderObj.agentPreset === void 0) childHeaderObj.agentPreset = sc.agentType ?? "standard";
			delete childHeaderObj.sandboxMode;
			delete childHeaderObj.approvalPolicy;
			const childCwd = this.childCwd(sc, scHeaderRaw, cwd);
			if (childCwd) childHeaderObj.cwd = childCwd;
			else delete childHeaderObj.cwd;
			const childHeader = JSON.stringify(childHeaderObj);
			const childEvents = irToEvents({
				schemaVersion: 2,
				originTool: "dsh",
				messages: sc.messages,
				...sc.toolCalls?.length ? { toolCalls: sc.toolCalls } : {},
				...sc.goals?.length ? { goals: sc.goals } : {},
				...sc.planModes?.length ? { planModes: sc.planModes } : {},
				...sc.todos?.length ? { todos: sc.todos } : {},
				...sc.compaction?.length ? { compaction: sc.compaction } : {},
				...sc.unmappedEvents?.length ? { unmappedEvents: sc.unmappedEvents } : {},
				...sc.kind === "teammate" ? { title: sc.title ? `(migrated teammate) ${sc.title}` : "(migrated teammate)" } : sc.title ? { title: sc.title } : {}
			}, childCreatedAt);
			const cFrame1 = buildSessionFrame(childHeader);
			const cFrame2 = buildEventsFrame(childEvents);
			const cDir = join(sessionsRoot, dshProjectDirName(childCwd), encodeSegment(childId));
			await promises.mkdir(cDir, { recursive: true });
			const cPayload = Buffer.concat([cFrame1, cFrame2]);
			const cPath = join(cDir, "session.jsonl.zstd");
			try {
				await promises.writeFile(cPath, cPayload, { flag: "wx" });
			} catch (e) {
				if (e?.code === "EEXIST") throw new Error(`DSH: sidechain session "${childId}" already exists at ${cPath} — refusing to overwrite an existing session (never clobber).`);
				throw e;
			}
			paths.push(cPath);
			if (isDefaultRoot && childCwd) try {
				const { ensureWorkspaceRegistration } = await Promise.resolve().then(() => workspace_exports);
				await ensureWorkspaceRegistration(sessionsRoot, childCwd, childId, { isDefaultRoot });
			} catch {}
			for (const nested of sc.sidechains ?? []) {
				const depth = typeof childHeaderObj.delegationDepth === "number" ? childHeaderObj.delegationDepth : parentDepth + 1;
				await writeSidechain(nested, childId, depth);
			}
		};
		const unknownKinds = (ir.sidechains ?? []).filter((s) => s.kind !== "subagent" && s.kind !== "teammate");
		if (unknownKinds.length > 0) console.warn(`[cc-migrate/dsh] ${unknownKinds.length} sidechain(s) of unknown kind(s) ${[...new Set(unknownKinds.map((s) => s.kind))].join(", ")} dropped (no dsh carry-over defined — see docs/agents/dsh.md)`);
		for (const sc of (ir.sidechains ?? []).filter((s) => s.kind === "subagent" || s.kind === "teammate")) {
			const baseDepth = typeof headerObj.delegationDepth === "number" ? headerObj.delegationDepth : 0;
			await writeSidechain(sc, newId, baseDepth);
		}
		return {
			tool: "dsh",
			sessionId: newId,
			paths
		};
	}
	/** Lightweight session listing from the DSH sessions root. Titles come from
	* DSH's own projection cache (`session_projcache.json`, one JSON read);
	* sessions it doesn't cover (e.g. migrated ones DSH never opened) fall back
	* to scanning the log for the LAST `session/title` event. Archive state
	* rides workspace.json's archivedSessionIds. `_no-cwd` sessions listed too. */
	async listSessions(root) {
		const sessionsRoot = root ?? defaultDshRoot();
		if (!sessionsRoot) return [];
		const [titles, archived] = await Promise.all([readProjcacheTitles(sessionsRoot), readArchivedSessionIds(sessionsRoot)]);
		const metas = [];
		let projects;
		try {
			projects = await promises.readdir(sessionsRoot);
		} catch {
			return [];
		}
		for (const proj of projects) {
			if (!(proj === "_no-cwd" || proj.startsWith("--") && proj.endsWith("--"))) continue;
			const projDir = join(sessionsRoot, proj);
			let sessions;
			try {
				sessions = await promises.readdir(projDir);
			} catch {
				continue;
			}
			for (const sid of sessions) {
				const sessDir = join(projDir, sid);
				const log = join(sessDir, "session.jsonl.zstd");
				try {
					const st = await promises.stat(log);
					let title = titles.get(sid);
					let headerCwd;
					const buf = await promises.readFile(log);
					if (title === void 0) title = scanTitleFromLog(buf);
					try {
						const headLine = readFirstFrameLine(buf);
						const parsed = headLine ? JSON.parse(headLine) : void 0;
						if (parsed && typeof parsed.cwd === "string" && parsed.cwd && isAbsolute(parsed.cwd)) headerCwd = parsed.cwd;
					} catch {}
					metas.push({
						tool: "dsh",
						sessionId: sid,
						...title !== void 0 ? { title } : {},
						...headerCwd !== void 0 ? { cwd: headerCwd } : {},
						createdAt: st.mtimeMs,
						sourcePath: log,
						...archived.has(sid) ? { archived: true } : {}
					});
				} catch {}
			}
		}
		return metas;
	}
	/** Offline preview: fold messages to text (includes sidechains). */
	preview(session) {
		const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`);
		if (!session.sidechains?.length) return main.join("\n\n");
		const branches = session.sidechains.map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join("\n")}`);
		return [...main, ...branches].join("\n\n");
	}
	/** Locate the log file for a session id by scanning project dirs. */
	async findLog(root, id) {
		let projects;
		try {
			projects = await promises.readdir(root);
		} catch {
			return null;
		}
		for (const proj of projects) {
			const projDir = join(root, proj);
			const candidate = join(projDir, encodeSegment(id));
			const log = join(candidate, "session.jsonl.zstd");
			try {
				await promises.access(log);
				return log;
			} catch {}
		}
		return null;
	}
	/** True when a session artifact already occupies the (root, cwd, id) slot —
	* the single occupancy test shared by the main-session collision gate and
	* claimFreeSessionId's re-roll loop. */
	async sessionLogExists(root, cwd, id) {
		try {
			await promises.access(join(root, dshProjectDirName(cwd), encodeSegment(id), "session.jsonl.zstd"));
			return true;
		} catch {
			return false;
		}
	}
	/** 子会话 cwd 解析：sc.cwd（IR 槽位，优先）> 子 headerRaw.cwd > 父 cwd。
	* 候选值必须通过 isAbsolute 校验（DSH header 契约），非绝对一律跳过取
	* 下一级——与主会话 cwd 的降级纪律同款。返回 '' 表示 cwd-less（落 _no-cwd）。 */
	childCwd(sc, scHeaderRaw, parentCwd) {
		const candidates = [sc.cwd, typeof scHeaderRaw?.cwd === "string" ? scHeaderRaw.cwd : void 0];
		for (const c of candidates) if (typeof c === "string" && isAbsolute(c)) return c;
		return parentCwd;
	}
	/** Return `preferred` when its artifact path is free; otherwise mint a fresh
	* id. Writing over an existing log would clobber a real session (dsh->dsh
	* copies share root+cwd, so a preserved source id collides by design). */
	async claimFreeSessionId(root, cwd, preferred) {
		if (!await this.sessionLogExists(root, cwd, preferred)) return preferred;
		for (let i = 0; i < 5; i++) {
			const fresh = `session-${randomUUID()}`;
			if (!await this.sessionLogExists(root, cwd, fresh)) return fresh;
		}
		throw new Error(`DSH: cannot find a free session dir for "${preferred}" under ${root}`);
	}
};
/** Turn header + parsed events into a MigratedSession. agent->IR is zero-loss (except encrypted). */
function buildIrFromEvents(header, events) {
	const messages = [];
	const goals = [];
	const planModes = [];
	const todos = [];
	const toolCalls = [];
	const toolCallByCallId = /* @__PURE__ */ new Map();
	const unmappedEvents = [];
	const compaction = [];
	let title;
	const nodes = [];
	const compactionSummaries = /* @__PURE__ */ new Map();
	const seqToMsg = /* @__PURE__ */ new Map();
	const stampAndPush = (ev, msg) => {
		msg.timestamp = ev.time;
		msg.seq = ev.seq;
		messages.push(msg);
		seqToMsg.set(ev.seq, msg);
	};
	for (const ev of events) {
		if (PACKED_CHUNK_TYPES.has(ev.type)) {
			const raw = ev;
			const cleanData = stripEncrypted$1(ev.data);
			const seq0 = typeof raw.seq0 === "number" ? raw.seq0 : ev.seq;
			const time0 = typeof raw.time0 === "number" ? raw.time0 : ev.time ?? 0;
			unmappedEvents.push({
				seq: seq0,
				time: time0,
				type: ev.type,
				data: cleanData
			});
			continue;
		}
		if (hasEncrypted(ev.data)) {}
		const cleanData = stripEncrypted$1(ev.data);
		if (ev.type === "session/title" || ev.type.startsWith("session/title")) {
			const t = cleanData.title;
			if (typeof t === "string" && t) title = t;
			unmappedEvents.push({
				seq: ev.seq,
				time: ev.time ?? 0,
				type: ev.type,
				data: cleanData,
				...ev.surfaceOp !== void 0 ? { surfaceOp: ev.surfaceOp } : {},
				...ev.surfaceOp !== void 0 && ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {}
			});
			continue;
		}
		if (ev.type === "compaction/summary") {
			compactionSummaries.set(ev.seq, cleanData);
			unmappedEvents.push({
				seq: ev.seq,
				time: ev.time ?? 0,
				type: ev.type,
				data: cleanData
			});
			continue;
		}
		if (ev.type === "tool/call") {
			const d = cleanData;
			if (typeof d.callId === "string" && d.callId) {
				const rec = {
					callId: d.callId,
					tool: String(d.name ?? "tool"),
					status: "running",
					input: tryParseJson(d.arguments),
					time: { start: ev.time },
					metadata: { dsh: {
						...typeof d.turn === "number" ? { turn: d.turn } : {},
						...typeof d.step === "number" ? { step: d.step } : {},
						seq: ev.seq,
						...typeof d.arguments === "string" ? { arguments: d.arguments } : {},
						...ev.time !== void 0 ? { time: ev.time } : {}
					} }
				};
				toolCalls.push(rec);
				toolCallByCallId.set(rec.callId, rec);
			}
			continue;
		}
		if (SURFACE_TYPES.has(ev.type) && (ev.surfaceOp === "append" || typeof ev.surfaceOp === "object" && ev.surfaceOp !== null && ev.surfaceOp.op === "replace")) {
			const msg = eventToMessage(ev.type, cleanData);
			if (msg) {
				msg.meta?.dsh;
				if (ev.surfaceOp !== "append") {
					const sourceSeqs = ev.sourceEventSeqs;
					const replacer = withDshNative(msg, {
						surfaceOp: ev.surfaceOp,
						...sourceSeqs ? { sourceEventSeqs: sourceSeqs } : {}
					});
					stampAndPush(ev, replacer);
					const op = ev.surfaceOp;
					const startIdx = nodes.indexOf(op.start);
					const endIdx = nodes.indexOf(op.end);
					if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) nodes.push(ev.seq);
					else {
						const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
						nodes.splice(startIdx, endIdx - startIdx + 1, ev.seq);
						for (const s of shadowedSeqs) {
							const shadowedMsg = seqToMsg.get(s);
							if (shadowedMsg) {
								const prev = shadowedMsg.meta?.dsh ?? {};
								shadowedMsg.meta = {
									...shadowedMsg.meta ?? {},
									dsh: {
										...prev,
										shadowed: true
									}
								};
							}
						}
					}
					const summaryText = replacer.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
					const tokensBefore = sourceSeqs?.map((s) => compactionSummaries.get(s)).map((d) => d ? d.shadowedTokenCount : void 0).find((v) => typeof v === "number");
					compaction.push({
						summary: summaryText,
						anchorIndex: messages.length - 1,
						...tokensBefore !== void 0 ? { tokensBefore } : {}
					});
				} else {
					stampAndPush(ev, msg);
					nodes.push(ev.seq);
					if (ev.type === "tool/result") backfillToolCall(toolCallByCallId, cleanData, ev.time);
				}
			} else unmappedEvents.push({
				seq: ev.seq,
				time: ev.time ?? 0,
				type: ev.type,
				data: cleanData,
				...ev.surfaceOp !== void 0 ? { surfaceOp: ev.surfaceOp } : {},
				...ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {}
			});
			continue;
		}
		if (ev.type === "goal/change") {
			goals.push({
				seq: ev.seq,
				time: ev.time ?? 0,
				data: cleanData
			});
			continue;
		}
		if (ev.type === "plan/mode") {
			planModes.push({
				seq: ev.seq,
				time: ev.time ?? 0,
				data: cleanData
			});
			continue;
		}
		if (ev.type === "todo/write") {
			todos.push({
				seq: ev.seq,
				time: ev.time ?? 0,
				data: cleanData
			});
			continue;
		}
		unmappedEvents.push({
			seq: ev.seq,
			time: ev.time ?? 0,
			type: ev.type,
			data: cleanData,
			...ev.surfaceOp !== void 0 ? { surfaceOp: ev.surfaceOp } : {},
			...ev.surfaceOp !== void 0 && ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {},
			...ev.ignorable === true ? { ignorable: true } : {}
		});
	}
	const ir = {
		schemaVersion: 2,
		originTool: "dsh",
		messages
	};
	if (title) ir.title = title;
	if (goals.length) ir.goals = goals;
	if (planModes.length) ir.planModes = planModes;
	if (todos.length) ir.todos = todos;
	if (toolCalls.length) ir.toolCalls = toolCalls;
	if (compaction.length) ir.compaction = compaction;
	if (unmappedEvents.length) ir.unmappedEvents = unmappedEvents;
	ir.meta = { dsh: { headerRaw: { ...header } } };
	return ir;
}
/** toolCalls 清单 #1（result 回填）：pair the result event with its bucket
* record by callId — status flips to completed/error, output/error text is
* extracted from the tool-result interior, time.end and DSH-native extras
* (error identity, tool-private result meta) ride metadata.dsh. */
function backfillToolCall(map, data, time) {
	const d = data;
	const callId = d?.message?.source?.callId;
	const rec = typeof callId === "string" ? map.get(callId) : void 0;
	if (!rec) return;
	const block = (d?.message?.content ?? []).find((b) => typeof b === "object" && b !== null && (b.type === "tool-result" || b.type === "tool_result"));
	const isError = Boolean(block?.isError) || d?.error !== void 0;
	const text = Array.isArray(block?.content) ? block.content.map((p) => typeof p === "object" && p !== null && p.type === "text" ? String(p.text ?? "") : JSON.stringify(p)).join("") : typeof block?.content === "string" ? block.content : "";
	rec.status = isError ? "error" : "completed";
	if (isError) rec.error = text;
	else rec.output = text;
	if (rec.time && time !== void 0) rec.time.end = time;
	rec.metadata = {
		...rec.metadata ?? {},
		dsh: {
			...rec.metadata?.dsh ?? {},
			...d?.error ? { errorIdentity: d.error } : {},
			...d?.meta !== void 0 ? { resultMeta: d.meta } : {}
		}
	};
}
function eventToMessage(type, data) {
	switch (type) {
		case "user/message": {
			const maybe = data;
			const content = maybe.content ?? [];
			const source = maybe.source;
			const isToolBridged = source?.kind === "tool" || Array.isArray(content) && content.some((b) => typeof b === "object" && b !== null && (b.type === "tool-result" || b.type === "tool_result"));
			const msg = normalizeMessageLike(data);
			if (!msg) return null;
			const native = { source };
			if (typeof maybe.id === "string") native.id = maybe.id;
			if (dshContentHasImages(content)) native.rawContent = content;
			const sourceKind = typeof source?.kind === "string" ? source.kind : void 0;
			const isCompactionCheckpoint = sourceKind === "plugin" && source?.plugin === "compact";
			const synthetic = sourceKind !== void 0 && sourceKind !== "user" && !isCompactionCheckpoint;
			if (isToolBridged) return withDshNative({
				...msg,
				role: "tool"
			}, native);
			if (synthetic) return withDshNative({
				...msg,
				synthetic: true
			}, native);
			return withDshNative(msg, native);
		}
		case "assistant/message": {
			const d = data;
			const m = d.message;
			if (!m || !Array.isArray(m.content) || m.content.length === 0) return null;
			const msg = normalizeMessageLike(m);
			if (!msg) return null;
			const native = { source: m.source };
			if (typeof m.id === "string") native.id = m.id;
			if (typeof d.turn === "number") native.turn = d.turn;
			if (typeof d.step === "number") native.step = d.step;
			if (d.usage !== void 0 && typeof d.usage === "object" && d.usage !== null) native.usage = d.usage;
			if (d.interrupted === true) native.interrupted = true;
			if (dshContentHasImages(m.content)) native.rawContent = m.content;
			return withDshNative(msg, native);
		}
		case "tool/result": {
			const d = data;
			const m = d.message;
			if (!m || !Array.isArray(m.content)) return null;
			const msg = normalizeMessageLike(m);
			if (!msg) return null;
			const native = { source: m.source };
			if (typeof m.id === "string") native.id = m.id;
			if (typeof d.turn === "number") native.turn = d.turn;
			if (typeof d.step === "number") native.step = d.step;
			if (d.error !== void 0 && typeof d.error === "object" && d.error !== null) native.resultError = d.error;
			if (d.meta !== void 0) native.resultMeta = d.meta;
			if (dshContentHasImages(m.content)) native.rawContent = m.content;
			return withDshNative({
				...msg,
				role: "tool"
			}, native);
		}
		default: return null;
	}
}
function normalizeMessageLike(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o = v;
	const role = o.role ?? "assistant";
	const blocks = normalizeContent((Array.isArray(o.content) ? o.content : []).map((b) => {
		if (typeof b !== "object" || b === null) return b;
		const rec = b;
		if (rec.type === "image") {
			const file = dshImageToFileBlock(rec);
			if (file) return file;
		}
		if ((rec.type === "tool-result" || rec.type === "tool_result") && Array.isArray(rec.content)) {
			const inner = rec.content.map((piece) => {
				if (typeof piece === "object" && piece !== null && !Array.isArray(piece)) {
					const p = piece;
					if (p.type === "image") {
						const file = dshImageToFileBlock(p);
						if (file) return file;
					}
				}
				return piece;
			});
			return {
				type: "tool_result",
				toolUseId: String(rec.toolCallId ?? rec.toolUseId ?? rec.id ?? ""),
				content: inner,
				isError: Boolean(rec.isError)
			};
		}
		if (rec.type === "reasoning" && typeof rec.text === "string") return {
			type: "thinking",
			thinking: rec.text
		};
		if (rec.type === "tool-call" && typeof rec.id === "string") return {
			type: "tool_use",
			id: rec.id,
			name: String(rec.name ?? "tool"),
			input: tryParseJson(rec.arguments) ?? rec.arguments
		};
		return b;
	}));
	const source = o.source;
	const provider = typeof source?.provider === "string" ? source.provider : void 0;
	const model = typeof source?.model === "string" ? source.model : void 0;
	const msg = {
		role,
		content: blocks
	};
	if (blocks.length === 0) return null;
	if (provider || model) {
		msg.provider = provider;
		msg.model = model;
	}
	return msg;
}
function tryParseJson(v) {
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return v;
	}
}
function isSafeSeq(v) {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
/**
* Build IR back into DSH event rows (with seq + surfaceOp).
*
* v3: merges messages + goals + planModes + todos + toolCalls + unmappedEvents
* into a single time-ordered stream, then reassigns contiguous seq 0..N-1. This
* is the only path that makes `agent->IR->agent` lossless for DSH (see
* docs/plans/ir-v3-lossless-100.md §3). Domain buckets are merged by time so
* the original wall-clock ordering survives. `session/title` is synthesized
* from `ir.title` when no matching unmapped event already carries it.
*/
function irToEvents(ir, baseTime) {
	const raw = [];
	const FALLBACK_SEQ_BASE = 0xe8d4a51000;
	let fallbackIdx = 0;
	const nativeOf = (msg) => msg.meta?.dsh ?? {};
	/** Restore the original surfaceOp ('append' or a replace object) plus its
	* sourceEventSeqs provenance — without this, compacted sessions would
	* round-trip as if nothing had been shadowed. */
	const surfaceOf = (msg) => {
		const native = nativeOf(msg);
		return {
			surfaceOp: native.surfaceOp ?? "append",
			...native.sourceEventSeqs ? { sourceEventSeqs: native.sourceEventSeqs } : {}
		};
	};
	let msgFallback = baseTime;
	const bucketCallIds = new Set((ir.toolCalls ?? []).map((r) => r.callId));
	const plannedCallIds = new Set(bucketCallIds);
	for (const m of ir.messages) for (const b of m.content) if (b.type === "tool_use" && b.id) plannedCallIds.add(b.id);
	const writtenCallIds = /* @__PURE__ */ new Set();
	const callSeats = /* @__PURE__ */ new Map();
	const claimCallSeat = (sourceId) => {
		const written = writtenCallIds.has(sourceId) ? `call_${randomUUID()}` : sourceId;
		writtenCallIds.add(written);
		const seats = callSeats.get(sourceId);
		if (seats) seats.pending.push(written);
		else callSeats.set(sourceId, {
			first: written,
			pending: [written]
		});
		return written;
	};
	/** tool/result 配对解析：FIFO 出队该源 id 最旧未配对席位；队列已空
	* （同 id 结果多于调用，或结果先于调用到达的乱序 IR）时回退首席位——
	* 引用必须始终指向一个真实存在的 tool/call 行，绝不生成孤儿。 */
	const seatForPairing = (sourceId) => {
		const seats = callSeats.get(sourceId);
		if (!seats) return void 0;
		return seats.pending.shift() ?? seats.first;
	};
	const bucketSeatIds = (ir.toolCalls ?? []).map((r) => claimCallSeat(r.callId));
	const blockSeatQueues = /* @__PURE__ */ new Map();
	for (const m of ir.messages) for (const b of m.content) {
		if (b.type !== "tool_use" || !b.id || bucketCallIds.has(b.id)) continue;
		const seat = claimCallSeat(b.id);
		const q = blockSeatQueues.get(b.id);
		if (q) q.push(seat);
		else blockSeatQueues.set(b.id, [seat]);
	}
	for (const msg of ir.messages) {
		const t = msg.timestamp;
		const time = typeof t === "number" && Number.isFinite(t) ? t : msgFallback++;
		const seq = typeof msg.seq === "number" && Number.isSafeInteger(msg.seq) ? msg.seq : FALLBACK_SEQ_BASE + fallbackIdx++;
		const native = nativeOf(msg);
		const isToolResultCarrier = msg.content.length > 0 && msg.content.every((b) => b.type === "tool_result");
		if (msg.role === "tool" || msg.role === "user" && isToolResultCarrier) {
			const toolBlocks = msg.content.filter((b) => b.type === "tool_result");
			const nativeSrc = native.source;
			const nativeCallId = typeof nativeSrc?.callId === "string" && nativeSrc.callId ? nativeSrc.callId : void 0;
			const blockCallId = toolBlocks[0]?.toolUseId;
			const sourceCallId = nativeCallId ?? (blockCallId || void 0);
			if (!sourceCallId || !plannedCallIds.has(sourceCallId)) continue;
			const pairedWrittenId = seatForPairing(sourceCallId);
			if (pairedWrittenId === void 0) continue;
			const toolData = {
				...native.turn !== void 0 || native.step !== void 0 ? {
					turn: native.turn ?? 1,
					step: native.step ?? 1
				} : {
					turn: 1,
					step: 1
				},
				...native.resultError !== void 0 ? { error: native.resultError } : {},
				...native.resultMeta !== void 0 ? { meta: native.resultMeta } : {},
				message: {
					...native.id ? { id: native.id } : { id: `msg_${randomUUID()}` },
					role: "user",
					source: {
						...native.source ?? { kind: "tool" },
						kind: "tool",
						callId: pairedWrittenId
					},
					...native.rawContent ? { content: native.rawContent.map((b) => b && typeof b === "object" && !Array.isArray(b) && b.type === "tool-result" && b.toolCallId === sourceCallId ? {
						...b,
						toolCallId: pairedWrittenId
					} : b) } : { content: msg.content.map((b) => {
						if (b.type === "tool_result") {
							const inner = [{
								type: "text",
								text: b.content
							}];
							for (const att of b.attachments ?? []) {
								const nativeImage = dshImageFromBlock(att);
								if (nativeImage) inner.push(nativeImage);
								else inner.push({
									type: "text",
									text: `[file: ${att.filename ?? att.url ?? "attachment"}]`
								});
							}
							return {
								type: "tool-result",
								toolCallId: pairedWrittenId,
								content: inner,
								isError: !!b.isError
							};
						}
						if (b.type === "text") return {
							type: "text",
							text: b.text
						};
						return {
							type: "text",
							text: b.thinking ?? ""
						};
					}) }
				}
			};
			raw.push({
				time,
				type: "tool/result",
				...surfaceOf(msg),
				data: toolData,
				_msg: msg,
				_seq: seq
			});
			continue;
		}
		if (msg.role === "user" || msg.role === "system" || msg.role === "developer") {
			const injected = msg.role !== "user" || msg.synthetic === true;
			const contentKind = msg.meta?.codex?.contentKind;
			const data = {
				...native.id ? { id: native.id } : { id: `msg_${randomUUID()}` },
				role: "user",
				...native.source !== void 0 ? { source: native.source } : injected ? { source: {
					kind: "plugin",
					plugin: contentKind ?? "external-harness"
				} } : { source: {
					kind: "user",
					rpcId: randomUUID(),
					clientTimeZone: "Asia/Shanghai"
				} },
				content: native.rawContent ?? dshContentFromBlocks(msg.content)
			};
			raw.push({
				time,
				type: "user/message",
				...surfaceOf(msg),
				data,
				_msg: msg,
				_seq: seq
			});
		} else {
			const content = native.rawContent ?? dshContentFromBlocks(msg.content);
			if (Array.isArray(content) && content.length === 0) continue;
			const provider = msg.provider ?? ir.model?.provider ?? "abrdns";
			const model = msg.model ?? ir.model?.id ?? "GLM-5.3-Flash";
			const nativeSource = native.source;
			const data = {
				...native.turn !== void 0 || native.step !== void 0 ? {
					turn: native.turn ?? 1,
					step: native.step ?? 1
				} : {
					turn: 1,
					step: 1
				},
				...native.usage !== void 0 ? { usage: native.usage } : {},
				...native.interrupted === true ? { interrupted: true } : {},
				message: {
					...native.id ? { id: native.id } : { id: `msg_${randomUUID()}` },
					role: "assistant",
					source: nativeSource ?? {
						kind: "model",
						provider,
						model
					},
					content
				}
			};
			raw.push({
				time,
				type: "assistant/message",
				...surfaceOf(msg),
				data,
				_msg: msg,
				_seq: seq
			});
			for (const b of msg.content) {
				if (b.type !== "tool_use" || !b.id || bucketCallIds.has(b.id)) continue;
				const seatQ = blockSeatQueues.get(b.id);
				if (!seatQ || seatQ.length === 0) continue;
				const writtenId = seatQ.shift();
				const args = b.input === void 0 ? "" : typeof b.input === "string" ? b.input : JSON.stringify(b.input);
				raw.push({
					time,
					type: "tool/call",
					data: {
						turn: 1,
						step: 1,
						callId: writtenId,
						name: b.name ?? "tool",
						arguments: args
					},
					_seq: seq
				});
			}
		}
	}
	for (const g of ir.goals ?? []) {
		const time = typeof g.time === "number" && Number.isFinite(g.time) ? g.time : baseTime;
		raw.push({
			time,
			type: "goal/change",
			data: g.data,
			_seq: g.seq
		});
	}
	(ir.toolCalls ?? []).forEach((tc, i) => {
		const writtenId = bucketSeatIds[i];
		const dsh = tc.metadata?.dsh;
		const time = typeof dsh?.time === "number" && Number.isFinite(dsh.time) ? dsh.time : baseTime;
		raw.push({
			time,
			type: "tool/call",
			data: {
				turn: dsh?.turn ?? 1,
				step: dsh?.step ?? 1,
				callId: writtenId,
				name: tc.tool,
				arguments: typeof dsh?.arguments === "string" ? dsh.arguments : JSON.stringify(tc.input ?? {})
			},
			_seq: isSafeSeq(dsh?.seq) ? dsh.seq : void 0
		});
	});
	for (const p of ir.planModes ?? []) {
		const time = typeof p.time === "number" && Number.isFinite(p.time) ? p.time : baseTime;
		raw.push({
			time,
			type: "plan/mode",
			data: p.data,
			_seq: p.seq
		});
	}
	for (const td of ir.todos ?? []) {
		const time = typeof td.time === "number" && Number.isFinite(td.time) ? td.time : baseTime;
		raw.push({
			time,
			type: "todo/write",
			data: td.data,
			_seq: td.seq
		});
	}
	for (const ev of ir.unmappedEvents ?? []) {
		const time = typeof ev.time === "number" && Number.isFinite(ev.time) ? ev.time : baseTime;
		if (PACKED_CHUNK_TYPES.has(ev.type)) {
			raw.push({
				time,
				type: ev.type,
				data: ev.data,
				_seq: ev.seq
			});
			raw[raw.length - 1].__packed = true;
			raw[raw.length - 1].__seq0 = ev.seq;
			raw[raw.length - 1].__time0 = time;
			continue;
		}
		if (!DSH_KNOWN_EVENT_TYPES.has(ev.type) && !PACKED_CHUNK_TYPES.has(ev.type)) continue;
		raw.push({
			time,
			type: ev.type,
			data: ev.data,
			...ev.surfaceOp !== void 0 ? { surfaceOp: ev.surfaceOp } : {},
			...ev.sourceEventSeqs ? { sourceEventSeqs: ev.sourceEventSeqs } : {},
			_seq: ev.seq
		});
	}
	if (ir.title) {
		if (!raw.some((r) => r.type === "session/title" || r.type.startsWith("session/title"))) {
			const titleTime = raw.length ? Math.min(baseTime, ...raw.map((r) => r.time)) : baseTime;
			raw.push({
				time: titleTime,
				type: "session/title",
				data: { title: ir.title },
				_seq: -1
			});
		}
	}
	raw.sort((a, b) => {
		if (a.time !== b.time) return a.time - b.time;
		return (a._seq ?? 0) - (b._seq ?? 0);
	});
	{
		const callIdxByWrittenId = /* @__PURE__ */ new Map();
		raw.forEach((r, i) => {
			if (r.type !== "tool/call") return;
			const cid = r.data?.callId;
			if (typeof cid === "string" && cid) {
				const list = callIdxByWrittenId.get(cid) ?? [];
				list.push(i);
				callIdxByWrittenId.set(cid, list);
			}
		});
		for (let i = 0; i < raw.length; i++) {
			const r = raw[i];
			if (r.type !== "tool/result") continue;
			const src = (r.data?.message)?.source;
			const cid = typeof src?.callId === "string" ? src.callId : void 0;
			if (!cid) continue;
			const callAfter = (callIdxByWrittenId.get(cid) ?? []).filter((j) => j !== void 0).find((j) => j > i);
			if (callAfter === void 0) continue;
			const [moved] = raw.splice(callAfter, 1);
			raw.splice(i, 0, moved);
			callIdxByWrittenId.clear();
			raw.forEach((rr, k) => {
				if (rr.type !== "tool/call") return;
				const c = rr.data?.callId;
				if (typeof c === "string" && c) {
					const l = callIdxByWrittenId.get(c) ?? [];
					l.push(k);
					callIdxByWrittenId.set(c, l);
				}
			});
		}
	}
	const packedRaw = raw.filter((r) => r.__packed);
	const normal = raw.filter((r) => !r.__packed);
	const merged = [];
	packedRaw.sort((a, b) => (a.__time0 ?? 0) - (b.__time0 ?? 0) || (a._seq ?? 0) - (b._seq ?? 0));
	{
		let pi = 0;
		let ni = 0;
		const key = (t, s) => t * 4294967296 + (s ?? 0);
		while (ni < normal.length || pi < packedRaw.length) {
			const n = normal[ni];
			const p = packedRaw[pi];
			if ((n ? key(n.time, n._seq) : Infinity) <= (p ? key(p.__time0 ?? 0, p._seq) : Infinity)) merged.push(normal[ni++]);
			else merged.push(packedRaw[pi++]);
		}
	}
	let curTurn = 1;
	let curStep = 1;
	const startedTurns = /* @__PURE__ */ new Set();
	const startedSteps = /* @__PURE__ */ new Set();
	const withSkeleton = [];
	for (const entry of merged) {
		if (entry.__packed) {
			withSkeleton.push(entry);
			continue;
		}
		const r = entry;
		const d = r.data;
		if (r.type === "turn/start") {
			if (typeof d?.turn === "number") {
				curTurn = d.turn;
				curStep = 1;
				startedTurns.add(curTurn);
			}
			withSkeleton.push(entry);
			continue;
		}
		if (r.type === "step/start") {
			if (typeof d?.turn === "number") curTurn = d.turn;
			if (typeof d?.step === "number") curStep = d.step;
			startedTurns.add(curTurn);
			startedSteps.add(`${curTurn}:${curStep}`);
			withSkeleton.push(entry);
			continue;
		}
		let evTurn;
		let evStep;
		if (r.type === "tool/call") {
			if (typeof d?.turn === "number") evTurn = d.turn;
			if (typeof d?.step === "number") evStep = d.step;
		} else if (r.type === "assistant/message" || r.type === "tool/result") {
			evTurn = curTurn;
			evStep = curStep;
		}
		if (evTurn !== void 0 && !startedTurns.has(evTurn)) {
			startedTurns.add(evTurn);
			withSkeleton.push({
				time: r.time,
				type: "turn/start",
				data: { turn: evTurn }
			});
		}
		if (evTurn !== void 0 && evStep !== void 0 && !startedSteps.has(`${evTurn}:${evStep}`)) {
			startedSteps.add(`${evTurn}:${evStep}`);
			withSkeleton.push({
				time: r.time,
				type: "step/start",
				data: {
					turn: evTurn,
					step: evStep
				}
			});
		}
		if (r.type === "assistant/message" || r.type === "tool/result") {
			r.data.turn = curTurn;
			r.data.step = curStep;
		}
		withSkeleton.push(entry);
	}
	merged.length = 0;
	merged.push(...withSkeleton);
	let cursor = 0;
	const out = [];
	const seqMap = /* @__PURE__ */ new Map();
	const isSourceSeq = (s) => typeof s === "number" && s >= 0 && s < FALLBACK_SEQ_BASE;
	for (const entry of merged) if (entry.__packed) {
		const packed = entry;
		const data = packed.data;
		const payloadLen = Array.isArray(data.texts) ? data.texts.length : Array.isArray(data.args) ? data.args.length : 0;
		const span = Math.max(1, payloadLen);
		out.push({
			type: packed.type,
			seq0: cursor,
			time0: packed.__time0,
			data: packed.data
		});
		if (isSourceSeq(packed.__seq0)) for (let k = 0; k < span; k++) seqMap.set(packed.__seq0 + k, cursor + k);
		cursor += span;
	} else {
		const r = entry;
		const ev = {
			seq: cursor,
			time: r.time,
			type: r.type,
			data: r.data
		};
		if (SURFACE_TYPES.has(r.type)) ev.surfaceOp = r.surfaceOp !== void 0 && typeof r.surfaceOp === "object" ? r.surfaceOp : "append";
		if (r.sourceEventSeqs !== void 0) ev.sourceEventSeqs = r.sourceEventSeqs;
		out.push(ev);
		if (isSourceSeq(r._seq)) seqMap.set(r._seq, cursor);
		cursor++;
	}
	for (const ev of out) {
		const op = ev.surfaceOp;
		if (op !== void 0 && typeof op === "object" && !Array.isArray(op)) {
			const rop = op;
			const start = seqMap.get(rop.start);
			const end = seqMap.get(rop.end);
			if (rop.op === "replace" && start !== void 0 && end !== void 0 && start <= end && end < ev.seq) ev.surfaceOp = {
				op: "replace",
				start,
				end
			};
			else if (SURFACE_TYPES.has(ev.type)) {
				ev.surfaceOp = "append";
				delete ev.sourceEventSeqs;
			} else {
				delete ev.surfaceOp;
				delete ev.sourceEventSeqs;
			}
		}
		if (Array.isArray(ev.sourceEventSeqs)) {
			const remapped = [...new Set(ev.sourceEventSeqs.map((s) => seqMap.get(s)).filter((s) => s !== void 0 && s < ev.seq))].sort((a, b) => a - b);
			if (remapped.length > 0) ev.sourceEventSeqs = remapped;
			else delete ev.sourceEventSeqs;
		}
	}
	return out;
}
/** Inverse of dshImageToFileBlock: an IR FileBlock carrying a
* `dsh-attachment://<id>` url becomes a DSH ImageBlock. Returns undefined for
* foreign files that cannot map (callers fall back to a text placeholder). */
function dshImageFromBlock(b) {
	const url = b.url ?? "";
	if (!url.startsWith("dsh-attachment://")) return void 0;
	const attachmentId = url.slice(17);
	if (!attachmentId) return void 0;
	const attachment = {
		attachmentId,
		mediaType: b.mediaType ?? "image/png"
	};
	if (b.filename) attachment.name = b.filename;
	return {
		type: "image",
		attachment
	};
}
function dshContentFromBlocks(blocks) {
	return blocks.map((b) => {
		switch (b.type) {
			case "text": return {
				type: "text",
				text: b.text
			};
			case "thinking": return {
				type: "reasoning",
				text: b.thinking
			};
			case "tool_use": return {
				type: "tool-call",
				id: b.id,
				name: b.name,
				arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {})
			};
			case "file": {
				const image = dshImageFromBlock(b);
				if (image) return image;
				return {
					type: "text",
					text: `[file: ${b.filename ?? b.url ?? b.mediaType ?? "attachment"}]`
				};
			}
			case "tool_result": return {
				type: "text",
				text: b.content
			};
		}
	});
}
function buildSessionFrame(headerJson) {
	return compressFrame(`${headerJson}\n`);
}
function buildEventsFrame(events) {
	return compressFrame(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
/** DSH side-store path derived from a sessions root (`<dshHome>/sessions`). */
function dshStoragesPath(sessionsRoot, file) {
	const dshHome = dirname(sessionsRoot);
	if (!dshHome || dshHome === sessionsRoot) return null;
	return join(dshHome, "storages", file);
}
/** Project directory name for a cwd — DSH parks cwd-less sessions under
* `_no-cwd`, not under the projectKey of an empty string. */
function dshProjectDirName(cwd) {
	return cwd ? projectKey(cwd) : "_no-cwd";
}
/** projcache title projection (`tables.sessions[id].rows.title.val`): one JSON
* read covers every session DSH has opened. Corrupt/missing file → empty map
* (callers fall back to per-log scans). */
async function readProjcacheTitles(sessionsRoot) {
	const out = /* @__PURE__ */ new Map();
	const p = dshStoragesPath(sessionsRoot, "session_projcache.json");
	if (!p) return out;
	let raw;
	try {
		raw = await promises.readFile(p, "utf8");
	} catch {
		return out;
	}
	try {
		const doc = JSON.parse(raw);
		for (const [id, rec] of Object.entries(doc.tables?.sessions ?? {})) {
			const val = rec?.rows?.title?.val;
			if (typeof val === "string" && val) out.set(id, val);
		}
	} catch {}
	return out;
}
/** Archived session ids from workspace.json's global.archivedSessionIds. */
async function readArchivedSessionIds(sessionsRoot) {
	const out = /* @__PURE__ */ new Set();
	const p = dshStoragesPath(sessionsRoot, "workspace.json");
	if (!p) return out;
	let raw;
	try {
		raw = await promises.readFile(p, "utf8");
	} catch {
		return out;
	}
	try {
		const doc = JSON.parse(raw);
		if (Array.isArray(doc.global?.archivedSessionIds)) {
			for (const id of doc.global.archivedSessionIds) if (typeof id === "string") out.add(id);
		}
	} catch {}
	return out;
}
/** Title of the LAST `session/title` event in a decompressed log — renames
* override earlier titles, so the last one wins. Substring-prefilters lines
* so only title-ish rows pay a JSON.parse. */
function scanTitleFromLog(buf) {
	let title;
	try {
		for (const line of decompressSessionBuffer(buf).split("\n")) {
			if (!line.includes("\"session/title\"")) continue;
			let ev;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			const t = ev.data?.title;
			if (ev.type === "session/title" && typeof t === "string" && t) title = t;
		}
	} catch {
		return;
	}
	return title;
}
/** src/utils/hash.ts:7 — djb2, 32-bit truncated. */
function djb2Hash(str) {
	let hash = 0;
	for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i) | 0;
	return hash;
}
/** sessionStoragePortable.ts:296 — the non-Bun fallback for the truncation suffix. */
function simpleHash(str) {
	return Math.abs(djb2Hash(str)).toString(36);
}
/** Bun.hash(name).toString(36) when running under Bun; simpleHash otherwise. */
function hashSuffix(name) {
	const bunGlobal = globalThis.Bun;
	if (typeof bunGlobal?.hash === "function") return bunGlobal.hash(name).toString(36);
	return simpleHash(name);
}
/** Encode an absolute cwd into Claude's project directory name (sessionStoragePortable.sanitizePath). */
function claudeProjectDirName(cwd) {
	const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= 200) return sanitized;
	return `${sanitized.slice(0, 200)}-${hashSuffix(cwd)}`;
}
/**
* Default Claude projects root. `CLAUDE_CONFIG_DIR` overrides the whole config
* home (src/utils/envUtils.ts:7), so the projects root is `$CLAUDE_CONFIG_DIR/projects`.
*/
function defaultClaudeProjectsRoot() {
	const envDir = process.env.CLAUDE_CONFIG_DIR;
	if (envDir) return join(envDir, "projects");
	const home = process.env.HOME || (process.env.USERPROFILE ?? null);
	return home ? join(home, ".claude", "projects") : null;
}
//#endregion
//#region ../core/dist/src/adapters/claude/parse.js
/**
* Claude Code adapter — READ side (docs/agents/claude.md §2/§3/§4 authoritative).
*
* Mirrors the native loadTranscriptFile pipeline so a migrated session carries
* the same conversation the real resume rebuilds:
*   1. tolerant JSONL parse (bad lines skipped, leading-NUL torn rows tolerated);
*   2. B/C-class metadata rows collected last-wins/accumulate;
*   3. legacy progress bridge (progress left the chain — children relink);
*   4. compact-boundary relinks (preservedMessages uuid list preferred over the
*      legacy preservedSegment tail→head walk; stale usage zeroed; pre-boundary
*      non-preserved rows pruned) + snip removals;
*   5. leaf = terminal message walked back to the nearest user/assistant;
*      chain = parentUuid walk (a boundary's parentUuid=null truncates it, so
*      the active chain holds only post-boundary rows — the folded segment's
*      fidelity is carried by extensions.claude.recordsRaw, §8#7) +
*      parallel tool_result recovery (siblings share message.id) + trailing
*      children of the leaf.
*
* Projection (docs/ir-protocol.md gaps #6/#7): user/assistant keep their native
* message object on `meta.claude.message` (block-level fidelity incl.
* redacted_thinking, caller, citations, usage); `toolUseResult` rides the
* tool_result block as `rawResult`; isMeta → synthetic; attachment rows project
* blocks + full raw payload on meta; system rows → sessionEvents (local_command
* → synthetic user text; compact_boundary → compaction anchor).
*/
/** Tolerant JSONL parse: skip blanks, leading-NUL tear markers, and bad lines. */
function parseClaudeLines(text) {
	const records = [];
	const lineIndex = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (!line) continue;
		let start = 0;
		while (start < line.length && line.charCodeAt(start) === 0) start++;
		if (start > 0) line = line.slice(start);
		if (!line.trim()) continue;
		try {
			const rec = JSON.parse(line);
			if (rec && typeof rec === "object" && !Array.isArray(rec)) {
				records.push(rec);
				lineIndex.push(i);
			}
		} catch {}
	}
	return {
		records,
		lineIndex
	};
}
/**
* Head-scan one session file for list metadata (enrichLog 64KB 窗口的精简等价):
* first line's isSidechain, first customTitle/ai-title/tag/last-prompt row,
* first transcript timestamp. File-name uuid validation is the caller's job.
*/
async function readClaudeLinesForList(path) {
	const text = await readFile(path, "utf8");
	const head = { isSidechain: false };
	const lines = text.split("\n");
	Math.min(lines.length, 400);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (!line) continue;
		let start = 0;
		while (start < line.length && line.charCodeAt(start) === 0) start++;
		if (start > 0) line = line.slice(start);
		if (!line.trim()) continue;
		if (i === 0) {
			if (line.includes("\"isSidechain\":true")) {
				head.isSidechain = true;
				break;
			}
			const tm = line.match(/"teamName":"([^"]*)"/);
			if (tm && tm[1]) head.teamName = tm[1];
		}
		try {
			const rec = JSON.parse(line);
			if (!head.firstTimestamp && typeof rec.timestamp === "string") head.firstTimestamp = rec.timestamp;
			if (!head.customTitle && rec.type === "custom-title" && typeof rec.customTitle === "string") head.customTitle = rec.customTitle;
			if (!head.aiTitle && rec.type === "ai-title" && typeof rec.aiTitle === "string") head.aiTitle = rec.aiTitle;
			if (!head.tag && rec.type === "tag" && typeof rec.tag === "string") head.tag = rec.tag;
			if (!head.lastPrompt && rec.type === "last-prompt") {
				if (typeof rec.lastPrompt === "string") head.lastPrompt = rec.lastPrompt;
			}
			if (!head.summary && rec.type === "summary" && typeof rec.summary === "string") head.summary = rec.summary;
			if (!head.gitBranch && typeof rec.gitBranch === "string" && rec.gitBranch) head.gitBranch = rec.gitBranch;
			if (!head.cwd && typeof rec.cwd === "string" && rec.cwd) head.cwd = rec.cwd;
			if (!head.firstPrompt && rec.type === "user" && !rec.isMeta && !rec.isCompactSummary) {
				const c = rec.message?.content;
				const flat = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ") : "").replace(/\s+/g, " ").trim();
				if (flat) head.firstPrompt = flat.slice(0, 120);
			}
			if (i > 200 && head.customTitle && (head.lastPrompt || head.firstTimestamp)) break;
		} catch {}
		if (i > 400) break;
	}
	return head;
}
const TRANSCRIPT_TYPES = /* @__PURE__ */ new Set([
	"user",
	"assistant",
	"attachment",
	"system"
]);
function collectMetadata(records) {
	const meta = {
		legacySummaries: [],
		contentReplacements: [],
		rows: []
	};
	for (const rec of records) {
		switch (rec.type) {
			case "user":
			case "assistant":
			case "attachment":
			case "system":
			case "progress": break;
			case "summary":
				meta.legacySummaries.push(rec);
				break;
			case "last-prompt":
				if (typeof rec.lastPrompt === "string") meta.lastPrompt = rec.lastPrompt;
				if (typeof rec.leafUuid === "string") meta.lastPromptLeafUuid = rec.leafUuid;
				break;
			case "custom-title":
				if (typeof rec.customTitle === "string") meta.customTitle = rec.customTitle;
				break;
			case "ai-title":
				if (typeof rec.aiTitle === "string") meta.aiTitle = rec.aiTitle;
				break;
			case "tag":
				if (typeof rec.tag === "string") meta.tag = rec.tag;
				break;
			case "mode":
				if (typeof rec.mode === "string") meta.mode = rec.mode;
				break;
			case "permission-mode":
				if (typeof rec.permissionMode === "string") meta.permissionMode = rec.permissionMode;
				break;
			case "agent-name":
				if (typeof rec.agentName === "string") meta.agentName = rec.agentName;
				break;
			case "agent-color":
				if (typeof rec.agentColor === "string") meta.agentColor = rec.agentColor;
				break;
			case "agent-setting":
				meta.agentSetting = rec.agentSetting;
				break;
			case "worktree-state":
				meta.worktreeSession = rec.worktreeSession;
				break;
			case "pr-link":
				meta.prLink = rec;
				break;
			case "cost-state":
				meta.costState = rec;
				break;
			case "atis-latch":
				meta.atisLatch = rec;
				break;
			case "content-replacement":
				meta.contentReplacements.push(rec);
				break;
			default: meta.rows.push(rec);
		}
		if (typeof rec.teamName === "string" && rec.teamName && !meta.teamName) meta.teamName = rec.teamName;
		if (typeof rec.agentName === "string" && rec.agentName && !meta.agentName) meta.agentName = rec.agentName;
	}
	return meta;
}
function loadTranscriptRecords(records, lineIndex) {
	const messages = /* @__PURE__ */ new Map();
	const progressBridge = /* @__PURE__ */ new Map();
	for (const rec of records) {
		if (rec.type === "progress" && typeof rec.uuid === "string") {
			const parent = rec.parentUuid ?? null;
			progressBridge.set(rec.uuid, parent && progressBridge.has(parent) ? progressBridge.get(parent) ?? null : parent);
			continue;
		}
		if (!TRANSCRIPT_TYPES.has(rec.type ?? "") || typeof rec.uuid !== "string") continue;
		const parent = rec.parentUuid;
		if (parent && progressBridge.has(parent)) messages.set(rec.uuid, {
			...rec,
			parentUuid: progressBridge.get(parent) ?? null
		});
		else messages.set(rec.uuid, rec);
	}
	applyPreservedSegmentRelinks(messages);
	applySnipRemovals(messages);
	return {
		messages,
		meta: collectMetadata(records),
		rawRecords: records,
		lineIndex
	};
}
function isCompactBoundary(rec) {
	return rec.type === "system" && rec.subtype === "compact_boundary";
}
/**
* preservedSegment/preservedMessages relink (sessionStorage.ts:1839, 2.1.251
* priority: explicit preservedMessages uuid list first, preservedSegment walk
* fallback). head→anchor relink, anchor's other children→tail, stale usage
* zeroed, non-preserved pre-boundary rows pruned.
*/
function applyPreservedSegmentRelinks(messages) {
	let absoluteLastBoundaryIdx = -1;
	let lastSegBoundaryIdx = -1;
	let lastSeg;
	let lastList;
	const entryIndex = /* @__PURE__ */ new Map();
	let i = 0;
	for (const entry of messages.values()) {
		entryIndex.set(entry.uuid, i);
		if (isCompactBoundary(entry)) {
			absoluteLastBoundaryIdx = i;
			const cm = entry.compactMetadata ?? {};
			if (cm.preservedSegment || cm.preservedMessages) {
				lastSegBoundaryIdx = i;
				lastSeg = cm.preservedSegment;
				lastList = cm.preservedMessages;
			}
		}
		i++;
	}
	if (!lastSeg && !lastList) return;
	if (!(lastSegBoundaryIdx === absoluteLastBoundaryIdx)) return;
	const preserved = /* @__PURE__ */ new Set();
	let anchorUuid;
	let headUuid;
	let tailUuid;
	if (lastList) {
		anchorUuid = lastList.anchorUuid;
		preserved.add(anchorUuid);
		for (const u of lastList.uuids ?? []) {
			if (!messages.has(u)) return;
			preserved.add(u);
			for (const tr of toolResultChildrenOf(messages, u)) preserved.add(tr);
		}
		headUuid = lastList.uuids?.[0];
		tailUuid = lastList.uuids?.[lastList.uuids.length - 1];
	} else if (lastSeg) {
		const seen = /* @__PURE__ */ new Set();
		let cur = messages.get(lastSeg.tailUuid);
		let reachedHead = false;
		while (cur && cur.uuid && !seen.has(cur.uuid)) {
			seen.add(cur.uuid);
			if (cur.uuid === lastSeg.headUuid) {
				reachedHead = true;
				break;
			}
			cur = cur.parentUuid ? messages.get(cur.parentUuid) : void 0;
		}
		if (!reachedHead) return;
		anchorUuid = lastSeg.anchorUuid;
		headUuid = lastSeg.headUuid;
		tailUuid = lastSeg.tailUuid;
		for (const u of seen) preserved.add(u);
	} else return;
	if (!anchorUuid) return;
	if (headUuid && messages.has(headUuid)) messages.set(headUuid, {
		...messages.get(headUuid),
		parentUuid: anchorUuid
	});
	if (tailUuid) {
		for (const [u, msg] of messages) if (u !== headUuid && msg.parentUuid === anchorUuid) messages.set(u, {
			...msg,
			parentUuid: tailUuid
		});
	}
	for (const u of preserved) {
		const msg = messages.get(u);
		if (msg?.type !== "assistant" || !msg.message) continue;
		messages.set(u, {
			...msg,
			message: {
				...msg.message,
				usage: {
					...msg.message.usage ?? {},
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0
				}
			}
		});
	}
	const toDelete = [];
	for (const [u] of messages) {
		const idx = entryIndex.get(u);
		if (idx !== void 0 && idx < absoluteLastBoundaryIdx && !preserved.has(u)) toDelete.push(u);
	}
	for (const u of toDelete) messages.delete(u);
}
function toolResultChildrenOf(messages, assistantUuid) {
	const out = [];
	for (const m of messages.values()) if (m.type === "user" && m.parentUuid === assistantUuid && Array.isArray(m.message?.content) && m.message.content.some((b) => b?.type === "tool_result")) {
		if (m.uuid) out.push(m.uuid);
	}
	return out;
}
/** Snip removals: delete removedUuids and relink survivors across the gap. */
function applySnipRemovals(messages) {
	const toDelete = /* @__PURE__ */ new Set();
	for (const entry of messages.values()) {
		const removed = entry.snipMetadata?.removedUuids;
		if (Array.isArray(removed)) for (const u of removed) toDelete.add(u);
	}
	if (!toDelete.size) return;
	const deletedParent = /* @__PURE__ */ new Map();
	for (const u of toDelete) {
		const e = messages.get(u);
		if (!e) continue;
		deletedParent.set(u, e.parentUuid ?? null);
		messages.delete(u);
	}
	const resolve = (start) => {
		let cur = start;
		while (cur && toDelete.has(cur)) {
			const next = deletedParent.get(cur);
			cur = next === void 0 ? null : next;
		}
		return cur;
	};
	for (const [u, msg] of [...messages]) if (msg.parentUuid && toDelete.has(msg.parentUuid)) messages.set(u, {
		...msg,
		parentUuid: resolve(msg.parentUuid)
	});
}
function computeLeafUuids(messages) {
	const all = [...messages.values()];
	const parents = new Set(all.map((m) => m.parentUuid).filter((u) => !!u));
	const leaves = /* @__PURE__ */ new Set();
	for (const terminal of all.filter((m) => !parents.has(m.uuid))) {
		const seen = /* @__PURE__ */ new Set();
		let cur = terminal;
		while (cur) {
			if (cur.uuid && seen.has(cur.uuid)) break;
			if (cur.uuid) seen.add(cur.uuid);
			if (cur.type === "user" || cur.type === "assistant") {
				leaves.add(cur.uuid);
				break;
			}
			cur = cur.parentUuid ? messages.get(cur.parentUuid) : void 0;
		}
	}
	return leaves;
}
function buildConversationChain(messages, leaf) {
	const chain = [];
	const seen = /* @__PURE__ */ new Set();
	let cur = leaf;
	while (cur) {
		if (cur.uuid && seen.has(cur.uuid)) break;
		if (cur.uuid) seen.add(cur.uuid);
		chain.push(cur);
		cur = cur.parentUuid ? messages.get(cur.parentUuid) : void 0;
	}
	chain.reverse();
	return recoverOrphanedParallelToolResults(messages, chain, seen);
}
/**
* Streaming splits N parallel tool_uses into N assistant records sharing
* message.id; each tool_result's parentUuid points at its own one-block
* assistant. A single-parent walk keeps one branch — off-chain siblings (same
* message.id) and their tool_results splice back after the last on-chain group
* member, timestamp order (sessionStorage.ts:2118).
*/
function recoverOrphanedParallelToolResults(allMessages, chain, seen) {
	const chainAssistants = chain.filter((m) => m.type === "assistant");
	if (!chainAssistants.length) return chain;
	const anchorByMsgId = /* @__PURE__ */ new Map();
	for (const a of chainAssistants) {
		const id = typeof a.message?.id === "string" ? a.message.id : void 0;
		if (id) anchorByMsgId.set(id, a);
	}
	const siblingsByMsgId = /* @__PURE__ */ new Map();
	const toolResultsByAsst = /* @__PURE__ */ new Map();
	for (const m of allMessages.values()) if (m.type === "assistant" && typeof m.message?.id === "string") {
		const g = siblingsByMsgId.get(m.message.id);
		if (g) g.push(m);
		else siblingsByMsgId.set(m.message.id, [m]);
	} else if (m.type === "user" && m.parentUuid && hasToolResultBlock(m)) {
		const g = toolResultsByAsst.get(m.parentUuid);
		if (g) g.push(m);
		else toolResultsByAsst.set(m.parentUuid, [m]);
	}
	const processed = /* @__PURE__ */ new Set();
	const inserts = /* @__PURE__ */ new Map();
	for (const asst of chainAssistants) {
		const msgId = typeof asst.message?.id === "string" ? asst.message.id : void 0;
		if (!msgId || processed.has(msgId)) continue;
		processed.add(msgId);
		const group = siblingsByMsgId.get(msgId) ?? [asst];
		const orphanSiblings = group.filter((s) => s.uuid && !seen.has(s.uuid));
		const orphanTRs = [];
		for (const member of group) for (const tr of toolResultsByAsst.get(member.uuid) ?? []) if (tr.uuid && !seen.has(tr.uuid)) orphanTRs.push(tr);
		if (!orphanSiblings.length && !orphanTRs.length) continue;
		orphanSiblings.sort(cmpTimestamp);
		orphanTRs.sort(cmpTimestamp);
		const anchor = anchorByMsgId.get(msgId);
		const recovered = [...orphanSiblings, ...orphanTRs];
		for (const r of recovered) if (r.uuid) seen.add(r.uuid);
		inserts.set(anchor.uuid, recovered);
	}
	if (!inserts.size) return chain;
	const out = [];
	for (const m of chain) {
		out.push(m);
		const add = inserts.get(m.uuid);
		if (add) out.push(...add);
	}
	return out;
}
function cmpTimestamp(a, b) {
	return String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? ""));
}
function hasToolResultBlock(rec) {
	return Array.isArray(rec.message?.content) && rec.message.content.some((b) => b && typeof b === "object" && b.type === "tool_result");
}
/**
* Trailing messages hanging off the conversation tail: the native loader keeps
* the chain ending at the leaf, then appends each subsequent child subtree
* depth-first (children of the leaf, then their children, …) — the shape after
* `Continue from where you left off` where queue/attachment/system records
* follow the final assistant (sessionStorage.ts:4630-4645, timestamp-sorted at
* each level).
*/
function trailingChildrenOf(messages, leafUuid) {
	const out = [];
	const walk = (parent) => {
		const kids = [...messages.values()].filter((m) => m.parentUuid === parent).sort(cmpTimestamp);
		for (const kid of kids) {
			out.push(kid);
			if (kid.uuid) walk(kid.uuid);
		}
	};
	walk(leafUuid);
	return out;
}
function isoToMs(iso) {
	if (typeof iso !== "string") return void 0;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : void 0;
}
/** Envelope fields that ride `meta.claude` (message-level native payload). */
function envelopeMeta(rec) {
	const m = {};
	for (const key of [
		"uuid",
		"parentUuid",
		"logicalParentUuid",
		"isSidechain",
		"teamName",
		"agentName",
		"promptId",
		"agentId",
		"userType",
		"entrypoint",
		"cwd",
		"version",
		"gitBranch",
		"slug",
		"sessionKind",
		"session_id",
		"origin",
		"promptSource",
		"permissionMode",
		"requestId",
		"effort",
		"isAbortedMidStream",
		"isVirtual",
		"sourceToolAssistantUUID",
		"interruptedMessageId",
		"toolDenialKind",
		"summarizeMetadata",
		"isVisibleInTranscriptOnly",
		"attributionAgent",
		"attributionSkill",
		"attributionMcpServer",
		"attributionMcpTool"
	]) if (rec[key] !== void 0) m[key] = rec[key];
	return m;
}
function attachmentBlocks(att) {
	const t = typeof att.type === "string" ? att.type : void 0;
	const asFile = () => {
		const f = { type: "file" };
		if (typeof att.filename === "string") f.filename = att.filename;
		if (typeof att.displayPath === "string") f.url = att.displayPath;
		return f;
	};
	switch (t) {
		case "file":
		case "compact_file_reference":
		case "pdf_reference":
		case "plan_file_reference": return [asFile()];
		case "edited_text_file": return [{
			type: "text",
			text: `[edited file: ${String(att.filename ?? "")}]\n${typeof att.snippet === "string" ? att.snippet : ""}`
		}];
		case "deferred_tools_delta":
		case "agent_listing_delta": {
			const parts = [
				att.addedLines,
				att.removedLines,
				att.readdedLines
			].flatMap((v) => Array.isArray(v) ? v.filter((s) => typeof s === "string" && !!s) : []);
			if (parts.length) return [{
				type: "text",
				text: parts.join("\n")
			}];
			const names = namesOf(att);
			if (names.length) return [{
				type: "text",
				text: `[${t}] ${names.join(", ")}`
			}];
			const json = safeJson$1(att);
			return json && json !== "{}" ? [{
				type: "text",
				text: `[${t}] ${json}`
			}] : [];
		}
		case "nested_memory":
		case "relevant_memories":
		case "dynamic_skill":
		case "skill_listing":
		case "skill_discovery":
		case "invoked_skills":
		case "current_session_memory":
		case "read_truncation_notice":
		case "total_tokens_reminder":
		case "task_reminder": {
			const c = att.content ?? att.text;
			if (typeof c === "string" && c) return [{
				type: "text",
				text: c
			}];
			const joined = stringsOf(c);
			if (joined) return [{
				type: "text",
				text: joined
			}];
			return c !== void 0 && c !== null ? [{
				type: "text",
				text: safeJson$1(c)
			}] : [];
		}
		case "hook_additional_context":
		case "hook_system_message": {
			const c = att.content;
			if (typeof c === "string" && c) return [{
				type: "text",
				text: c
			}];
			const joined = stringsOf(c);
			return joined ? [{
				type: "text",
				text: joined
			}] : [];
		}
		case "hook_success":
		case "hook_non_blocking_error": {
			if (!(typeof att.content === "string" && att.content || typeof att.stdout === "string" && att.stdout || typeof att.stderr === "string" && att.stderr) && att.exitCode === 0 && t === "hook_success") return [];
			const parts = [];
			if (typeof att.hookName === "string") parts.push(`[hook ${att.hookName}${att.exitCode !== void 0 ? ` exit=${att.exitCode}` : ""}]`);
			if (typeof att.content === "string" && att.content) parts.push(att.content);
			if (typeof att.stderr === "string" && att.stderr) parts.push(att.stderr);
			if (typeof att.stdout === "string" && att.stdout) parts.push(att.stdout);
			return parts.length ? [{
				type: "text",
				text: parts.join("\n")
			}] : [];
		}
		case "queued_command": {
			const p = att.prompt;
			if (typeof p === "string" && p) return [{
				type: "text",
				text: p
			}];
			if (Array.isArray(p)) return normalizeContent(p);
			return [];
		}
		case "date_change": {
			const text = typeof att.newDate === "string" ? att.newDate : typeof att.content === "string" ? att.content : "";
			return text ? [{
				type: "text",
				text
			}] : [];
		}
		case "plan_mode_exit": {
			const p = typeof att.planFilePath === "string" ? att.planFilePath : "";
			return p ? [{
				type: "text",
				text: `[plan_mode_exit: ${p}${att.planExists === false ? " (no plan file)" : ""}]`
			}] : [];
		}
		default: {
			const body = att.content ?? att.text ?? att.prompt ?? att.newDate;
			if (typeof body === "string" && body) return [{
				type: "text",
				text: body
			}];
			const joined = stringsOf(body);
			if (joined) return [{
				type: "text",
				text: joined
			}];
			const json = safeJson$1(att);
			return json && json !== "{}" ? [{
				type: "text",
				text: `[attachment: ${t ?? "unknown"}] ${json}`
			}] : [];
		}
	}
}
/** join a string[] payload (non-strings JSON-encoded), '' when empty. */
function stringsOf(v) {
	return Array.isArray(v) ? v.map((x) => typeof x === "string" ? x : safeJson$1(x)).filter(Boolean).join("\n") : "";
}
/** all delta name lists of a tools/agents delta attachment, flattened. */
function namesOf(att) {
	const out = [];
	for (const k of [
		"addedNames",
		"removedNames",
		"readdedNames",
		"addedTypes",
		"removedTypes"
	]) if (Array.isArray(att[k])) {
		for (const v of att[k]) if (typeof v === "string" && v) out.push(v);
		else if (v !== null && v !== void 0) out.push(safeJson$1(v));
	}
	return out;
}
function safeJson$1(v) {
	try {
		const s = JSON.stringify(v);
		return s && s.length > 400 ? `${s.slice(0, 400)}…` : s ?? "";
	} catch {
		return String(v);
	}
}
/**
* Project one reconstructed chain into IR messages + compaction + sessionEvents.
*/
function projectChain(chain, meta) {
	const messages = [];
	const compaction = [];
	const sessionEvents = [];
	const uuidToIndex = /* @__PURE__ */ new Map();
	let pendingBoundary = null;
	for (const { rec, line } of chain) {
		const ts = isoToMs(rec.timestamp);
		if (rec.type === "user" || rec.type === "assistant") {
			const blocks = normalizeContent(Array.isArray(rec.message?.content) ? rec.message.content : typeof rec.message?.content === "string" ? [{
				type: "text",
				text: rec.message.content
			}] : []);
			const toolUseResult = rec.toolUseResult;
			if (toolUseResult !== void 0) {
				const trBlock = blocks.find((b) => b.type === "tool_result");
				if (trBlock) trBlock.rawResult = toolUseResult;
			}
			if (rec.type === "assistant" && rec.isApiErrorMessage === true) continue;
			const msg = {
				role: rec.type === "assistant" ? "assistant" : "user",
				content: blocks,
				timestamp: ts
			};
			const m = envelopeMeta(rec);
			if (rec.isMeta === true) {
				msg.synthetic = true;
				m.isMeta = true;
			}
			if (rec.message) m.message = rec.message;
			if (rec.toolUseResult !== void 0 && !blocks.some((b) => b.type === "tool_result")) m.toolUseResult = rec.toolUseResult;
			if (Object.keys(m).length) msg.meta = { claude: m };
			uuidToIndex.set(rec.uuid, messages.length);
			if (rec.isCompactSummary === true) {
				const boundary = pendingBoundary && isCompactBoundary(pendingBoundary) ? pendingBoundary : null;
				const cm = boundary?.compactMetadata ?? {};
				const claudeMeta = {};
				if (boundary) claudeMeta.boundaryRecord = boundary;
				if (Object.keys(cm).length) claudeMeta.compactMetadata = cm;
				if (typeof rec.timestamp === "string") claudeMeta.summaryTimestamp = rec.timestamp;
				if (typeof rec.uuid === "string") claudeMeta.summaryUuid = rec.uuid;
				const entry = {
					summary: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
					meta: { claude: claudeMeta },
					anchorIndex: messages.length
				};
				compaction.push(entry);
				pendingBoundary = null;
			}
			messages.push(msg);
			continue;
		}
		if (rec.type === "attachment") {
			const msg = {
				role: "user",
				content: attachmentBlocks(rec.attachment ?? {}),
				timestamp: ts,
				synthetic: true
			};
			const m = envelopeMeta(rec);
			m.attachment = rec.attachment;
			m.systemSubtype = "attachment";
			msg.meta = { claude: m };
			messages.push(msg);
			continue;
		}
		if (rec.type === "system") {
			const subtype = typeof rec.subtype === "string" ? rec.subtype : "unknown";
			if (subtype === "local_command") {
				const msg = {
					role: "user",
					content: [{
						type: "text",
						text: typeof rec.content === "string" ? rec.content : safeJson$1(rec.content)
					}],
					timestamp: ts,
					synthetic: true,
					meta: { claude: {
						...envelopeMeta(rec),
						systemSubtype: "local_command",
						level: rec.level,
						...rec.isMeta === true ? { isMeta: true } : {}
					} }
				};
				messages.push(msg);
				continue;
			}
			if (isCompactBoundary(rec)) {
				pendingBoundary = rec;
				continue;
			}
			sessionEvents.push({
				seq: line,
				time: ts ?? 0,
				type: subtype,
				data: rec
			});
			continue;
		}
		sessionEvents.push({
			seq: line,
			time: ts ?? 0,
			type: String(rec.type ?? "unknown"),
			data: rec
		});
	}
	for (const s of meta.legacySummaries) {
		if (typeof s.summary !== "string") continue;
		const leafUuid = typeof s.leafUuid === "string" ? s.leafUuid : void 0;
		const anchor = leafUuid ? uuidToIndex.get(leafUuid) : void 0;
		compaction.push({
			summary: s.summary,
			...anchor !== void 0 ? { anchorIndex: anchor } : {},
			meta: { claude: {
				legacySummary: true,
				...leafUuid ? { leafUuid } : {}
			} }
		});
	}
	return {
		messages,
		compaction,
		sessionEvents
	};
}
/** Enrich an IR session from a loaded transcript (projection + session-level fields). */
function loadedTranscriptToIr(loaded, opts = {}) {
	const { messages: messageMap, meta } = loaded;
	const leaves = computeLeafUuids(messageMap);
	const leafCandidates = [...messageMap.values()].filter((m) => leaves.has(m.uuid) && (m.type === "user" || m.type === "assistant"));
	let chain = [];
	if (leafCandidates.length) {
		const leafHit = typeof meta.lastPromptLeafUuid === "string" ? messageMap.get(meta.lastPromptLeafUuid) : void 0;
		const latest = leafHit ? leafHit : leafCandidates.reduce((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")) > 0 ? a : b);
		chain = buildConversationChain(messageMap, latest);
		const trailing = trailingChildrenOf(messageMap, latest.uuid);
		chain.push(...trailing);
	}
	const projection = projectChain(chain.map((rec, i) => ({
		rec,
		line: rawLineOf(loaded, rec, i)
	})), meta);
	const ir = {
		schemaVersion: 2,
		originTool: "claude",
		originSessionId: sessionUuidOf(loaded),
		messages: projection.messages
	};
	const createdAt = chain.length ? isoToMs(chain[0].timestamp) : void 0;
	if (createdAt !== void 0) ir.createdAt = createdAt;
	const cwd = chain.map((r) => r.cwd).find((c) => typeof c === "string" && !!c);
	if (cwd) ir.cwd = cwd;
	if (meta.customTitle || meta.aiTitle) ir.title = meta.customTitle ?? meta.aiTitle;
	if (meta.tag) ir.tag = meta.tag;
	if (meta.permissionMode) ir.permissionMode = meta.permissionMode;
	if (meta.worktreeSession !== void 0) ir.worktreeSession = meta.worktreeSession;
	if (meta.prLink) ir.prLink = {
		prNumber: Number(meta.prLink.prNumber ?? 0),
		prUrl: String(meta.prLink.prUrl ?? ""),
		prRepository: String(meta.prLink.prRepository ?? ""),
		...typeof meta.prLink.timestamp === "string" ? { timestamp: meta.prLink.timestamp } : {}
	};
	if (meta.costState) ir.costState = meta.costState;
	if (projection.compaction.length) ir.compaction = projection.compaction;
	if (projection.sessionEvents.length) ir.sessionEvents = projection.sessionEvents;
	const sessionClaude = { metadata: meta };
	if (meta.teamName) sessionClaude.teamName = meta.teamName;
	if (meta.agentName) sessionClaude.agentName = meta.agentName;
	ir.meta = { claude: sessionClaude };
	return {
		ir,
		rawRecords: loaded.rawRecords
	};
}
function rawLineOf(loaded, rec, chainIdx) {
	const idx = loaded.rawRecords.indexOf(rec);
	return idx >= 0 ? loaded.lineIndex[idx] ?? chainIdx : chainIdx;
}
function sessionUuidOf(loaded) {
	for (const rec of loaded.rawRecords) if (typeof rec.sessionId === "string" && rec.sessionId) return rec.sessionId;
}
/** Read one main-file transcript (by path) → IR with sidechains attached. */
async function parseClaudeFile(path) {
	const parsed = parseClaudeLines(await readFile(path, "utf8"));
	const loaded = loadTranscriptRecords(parsed.records, parsed.lineIndex);
	const { ir, rawRecords } = loadedTranscriptToIr(loaded, { sourcePath: path });
	if (rawRecords.length) {
		ir.extensions ??= {};
		ir.extensions.claude = {
			...ir.extensions.claude,
			recordsRaw: rawRecords
		};
	}
	const dir = dirname(path);
	const sid = ir.originSessionId;
	if (sid) {
		const sidechains = await loadSidechains(join(dir, sid, "subagents"), loaded);
		if (sidechains.length) ir.sidechains = sidechains;
	}
	return ir;
}
/**
* Scan `<sessionId>/subagents/**` for `agent-<id>.jsonl` (+ `.meta.json`
* sidecars), recursing into workflow subdirs (§11.1). In-process teammate
* fragments (agentId `a<name>-<hex>`, one per turn) are aggregated by name
* prefix into a single teammate sidechain so the transcript travels whole.
*/
async function loadSidechains(subagentsDir, leader) {
	let files;
	try {
		files = await listFilesRecursive(subagentsDir);
	} catch {
		return [];
	}
	const jsonls = files.filter((f) => basename(f).startsWith("agent-") && f.endsWith(".jsonl"));
	const parsed = [];
	for (const file of jsonls) {
		const agentId = basename(file).slice(6, -6);
		if (!agentId) continue;
		const sidechain = await parseSidechainFile(file, agentId);
		if (sidechain) {
			parsed.push({
				agentId,
				path: file,
				sc: sidechain.sc,
				prefix: teammatePrefix(agentId),
				meta: sidechain.meta
			});
			if (sidechain.meta) sidechain.sc.meta = { claude: { agentMeta: sidechain.meta } };
		}
	}
	if (leader) resolveSpawnAnchors(parsed, leader);
	const byPrefix = /* @__PURE__ */ new Map();
	const out = [];
	for (const item of parsed) {
		if (item.prefix && item.sc?.kind === "teammate") {
			const list = byPrefix.get(item.prefix) ?? [];
			list.push({
				agentId: item.agentId,
				path: item.path,
				sc: item.sc
			});
			byPrefix.set(item.prefix, list);
			continue;
		}
		if (item.sc) out.push(item.sc);
	}
	for (const [prefix, group] of byPrefix) {
		if (group.length === 1) {
			out.push(group[0].sc);
			continue;
		}
		const merged = {
			agentId: prefix,
			kind: "teammate",
			messages: [],
			...group[0].sc.agentType ? { agentType: group[0].sc.agentType } : {}
		};
		for (const g of group) {
			merged.messages.push(...g.sc.messages);
			if (g.sc.meta) merged.meta = g.sc.meta;
		}
		out.push(merged);
	}
	return out;
}
/** `aD2-queue-head-fix-a221c8a287cf36cb` → prefix `D2-queue-head-fix`; plain hex → null. */
function teammatePrefix(agentId) {
	const m = agentId.match(/^a(.+?)-[0-9a-f]{16,17}$/);
	return m ? m[1] : null;
}
/**
* Fill each sidechain's `parentMessageId` with the leader-chain uuid that
* SPAWNED it (召唤位置). Channel 1: sidecar `toolUseId` → the assistant record
* whose message.content contains that tool_use block id. Channel 2 (teammate,
* sidecar toolUseId empty): the leader user row whose toolUseResult has
* `status:'teammate_spawned'` and `name`/`agent_id` matching the teammate
* name → the assistant that emitted the spawning tool_use (its source
* tool_use block carries `input.name === teammateName`).
*/
function resolveSpawnAnchors(parsed, leader) {
	const recs = leader.rawRecords;
	const toolUseOwner = /* @__PURE__ */ new Map();
	for (const r of recs) {
		if (r.type !== "assistant" || !Array.isArray(r.message?.content)) continue;
		for (const b of r.message.content ?? []) if (b && typeof b === "object" && b.type === "tool_use" && typeof b.id === "string") toolUseOwner.set(b.id, r.uuid);
	}
	const teammateSpawnOwner = /* @__PURE__ */ new Map();
	for (const rec of recs) {
		if (rec.type !== "user") continue;
		const tur = rec.toolUseResult;
		if (!tur || typeof tur !== "object" || tur.status !== "teammate_spawned") continue;
		const name = typeof tur.name === "string" ? tur.name : null;
		const tr = Array.isArray(rec.message?.content) ? rec.message.content.find((b) => b?.type === "tool_result") : null;
		if (name && tr?.tool_use_id) {
			const owner = toolUseOwner.get(tr.tool_use_id);
			if (owner) teammateSpawnOwner.set(name, owner);
		}
	}
	for (const item of parsed) {
		if (!item.sc) continue;
		const tid = item.meta?.toolUseId;
		if (typeof tid === "string" && tid) {
			const owner = toolUseOwner.get(tid);
			if (owner) {
				item.sc.parentMessageId = owner;
				continue;
			}
		}
		if (item.sc.kind !== "teammate") continue;
		const displayName = teammateDisplayName(item);
		const anchor = teammateSpawnOwner.get(displayName);
		if (anchor) {
			item.sc.parentMessageId = anchor;
			continue;
		}
		const stem = item.prefix ?? item.sc.agentId;
		for (const [n, owner] of teammateSpawnOwner) if (stem.includes(n)) {
			item.sc.parentMessageId = owner;
			break;
		}
	}
}
/** the human teammate name behind a sidechain: prefix for fragments, sidecar agentType otherwise. */
function teammateDisplayName(item) {
	return item.prefix ?? item.meta?.agentType ?? item.agentId;
}
async function listFilesRecursive(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const out = [];
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...await listFilesRecursive(p));
		else if (e.isFile()) out.push(p);
	}
	return out;
}
/** Parse one sidechain file → MigratedSidechain (+ optional sidecar meta). */
async function parseSidechainFile(path, agentId) {
	const parsed = parseClaudeLines(await readFile(path, "utf8"));
	const loaded = loadTranscriptRecords(parsed.records, parsed.lineIndex);
	const { messages: messageMap } = loaded;
	const agentRecords = [...messageMap.values()].filter((m) => m.agentId === agentId && m.isSidechain === true);
	if (!agentRecords.length) return null;
	const parentUuids = new Set(agentRecords.map((m) => m.parentUuid));
	const leaf = agentRecords.filter((m) => !parentUuids.has(m.uuid) && m.type !== "system").sort(cmpTimestamp).at(-1);
	if (!leaf) return null;
	let chain = buildConversationChain(messageMap, leaf);
	chain = chain.filter((m) => m.agentId === agentId);
	const { ir: sessionIr } = loadedTranscriptToIr(loadTranscriptRecords(parsed.records, parsed.lineIndex));
	const projection = projectChain(chain.map((rec, i) => ({
		rec,
		line: i
	})), loaded.meta);
	const sc = {
		agentId,
		kind: /^a.+?-[0-9a-f]{16,17}$/.test(agentId) ? "teammate" : "subagent",
		messages: projection.messages
	};
	const first = chain.find((m) => m.agentId === agentId);
	if (first) {
		if (typeof first.cwd === "string" && first.cwd) sc.cwd = first.cwd;
	}
	if (projection.compaction.length) sc.compaction = projection.compaction;
	if (projection.sessionEvents.length) sc.sessionEvents = projection.sessionEvents;
	let meta;
	try {
		const metaPath = path.replace(/\.jsonl$/, ".meta.json");
		const metaText = await readFile(metaPath, "utf8");
		meta = JSON.parse(metaText);
		if (meta && typeof meta === "object" && typeof meta.agentType === "string") sc.agentType = meta.agentType;
	} catch {}
	if (meta?.description !== void 0) {
		const m = sc.meta ??= {};
		const claudeNs = m.claude ??= {};
		claudeNs.agentDescription = meta.description;
	}
	return {
		sc,
		meta
	};
}
//#endregion
//#region ../core/dist/src/adapters/claude/write.js
/**
* Claude Code adapter — WRITE side.
*
* Native-shape recipes, machine-verified by §12 (a hand-forged session built
* with these stamps was loaded by the real 2.1.251 binary, replayed correctly
* through a mock Anthropic API, and claude appended follow-up records natively
* onto it):
*
*  - insertMessageChain stamp order (sessionStorage.ts:1039-1064):
*    parentUuid → logicalParentUuid? → isSidechain → teamName? → agentName?
*    → promptId?(user only) → agentId? → message → userType → entrypoint → cwd
*    → sessionId → (session_id) → version → gitBranch → slug → sessionKind.
*    2.1.251 real-file order confirmed: uuid/timestamp land right after
*    message, stamp fields end the row.
*  - EVERY tool_result becomes its OWN user record with parentUuid overridden
*    to the assistant that emitted the tool_use (sourceToolAssistantUUID) —
*    never one fat user record (§9#5).
*  - terminal last-prompt carries leafUuid and NO cwd (§2.5/§7).
*  - compaction = system/compact_boundary row (parentUuid=null, full
*    compactMetadata) + isCompactSummary/isVisibleInTranscriptOnly user record.
*  - IR.systemPrompt is ignored (红线 #3/#8): no system prompt ever enters the
*    jsonl — the engine passes --append-system-prompt at process level.
*/
function iso(ms) {
	return new Date(ms).toISOString();
}
function stripUndefined(rec) {
	for (const k of Object.keys(rec)) if (rec[k] === void 0) delete rec[k];
}
function claudeNativeBlock(block) {
	if (block.type === "text") return {
		type: "text",
		text: block.text
	};
	if (block.type === "tool_use") return {
		type: "tool_use",
		id: block.id,
		name: block.name,
		input: block.input
	};
	if (block.type === "thinking") return block.signature !== void 0 ? {
		type: "thinking",
		thinking: block.thinking,
		signature: block.signature
	} : {
		type: "thinking",
		thinking: block.thinking
	};
	if (block.type === "file") {
		if (block.data) return {
			type: "image",
			source: {
				type: "base64",
				media_type: block.mediaType ?? "image/png",
				data: block.data
			}
		};
		if (block.url) return {
			type: "image",
			source: {
				type: "url",
				url: block.url
			}
		};
		return {
			type: "text",
			text: `[file${block.filename ? `: ${block.filename}` : ""}]`
		};
	}
	const out = {
		type: "tool_result",
		tool_use_id: block.toolUseId,
		content: block.content,
		is_error: !!block.isError
	};
	if (block.attachments?.length) out.content = [{
		type: "text",
		text: block.content
	}, ...block.attachments.map(claudeNativeBlock)];
	return out;
}
function normalizeLastPrompt(text) {
	const flat = text.replace(/\n/g, " ").trim();
	return flat.length > 200 ? `${flat.slice(0, 200).trim()}…` : flat;
}
/** getFirstMeaningfulUserMessageTextContent analog for the last-prompt row. */
function messageFirstText(msg) {
	const parts = [];
	for (const b of msg.content) if (b.type === "text") parts.push(b.text);
	return normalizeLastPrompt(parts.join(" "));
}
/** last-prompt.leafUuid: the final user/assistant uuid on the written chain. */
function lastLeafUuidOf(records) {
	for (let i = records.length - 1; i >= 0; i--) {
		const r = records[i];
		if ((r.type === "user" || r.type === "assistant") && typeof r.uuid === "string") return r.uuid;
	}
}
/** Join a message's text blocks (file/attachments render as placeholders, mirroring claudeNativeBlock). */
function plainOf(msg) {
	return msg.content.map((b) => {
		if (b.type === "text") return b.text;
		if (b.type === "file") return `[file: ${b.filename ?? b.url ?? b.mediaType ?? "attachment"}]`;
		return "";
	}).filter(Boolean).join("\n");
}
function envelopeFromMeta(meta) {
	const out = {};
	for (const key of [
		"teamName",
		"agentName",
		"promptId"
	]) if (meta[key] !== void 0) out[key] = meta[key];
	return out;
}
/**
* P1-C: native.content 透传前置校验——其 tool_use id 集合必须与 IR 块一致
* （双向子集判定）。toolUseOwner 按 IR 块登记、tool_result 也按 IR id 配对，
* 透传携带 IR 之外的 tool_use id（或缺失 IR id）会写出文件中不存在的
* tool_use_id（配对断裂）。宁缺勿错：不一致则丢弃 native content 回退 IR 块重建。
*/
function nativeToolUseIdsConsistent(nativeContent, blocks) {
	const irIds = new Set(blocks.filter((b) => b.type === "tool_use").map((b) => b.id));
	const nativeIds = /* @__PURE__ */ new Set();
	for (const b of nativeContent) {
		if (!b || typeof b !== "object" || Array.isArray(b)) continue;
		const blk = b;
		if (blk.type !== "tool_use") continue;
		if (typeof blk.id !== "string") return false;
		nativeIds.add(blk.id);
	}
	if (nativeIds.size !== irIds.size) return false;
	for (const id of nativeIds) if (!irIds.has(id)) return false;
	return true;
}
function emitMessage(ctx, msg, opts = {}) {
	const { stamp: st, state } = ctx;
	const ts = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? iso(msg.timestamp) : iso(ctx.at());
	const meta = msg.meta?.claude ?? {};
	/** original source-row uuid — records its ride-through copy as represented;
	*  同时登记 srcUuid → 新行 uuid 的 rekey 映射（boundary preserved 引用换新） */
	const trackEmitted = (newUuid) => {
		if (typeof meta.uuid === "string" && meta.uuid) {
			state.emittedUuids.add(meta.uuid);
			state.uuidRekey.set(meta.uuid, newUuid);
		}
	};
	const native = meta.message ?? void 0;
	const env = envelopeFromMeta(meta);
	({
		...meta.teamName !== void 0 ? { teamName: meta.teamName } : {},
		...meta.agentName !== void 0 ? { agentName: meta.agentName } : {},
		...ctx.agentId !== void 0 ? { agentId: ctx.agentId } : {}
	});
	const isSidechain = ctx.isSidechain;
	if (msg.role === "assistant") {
		const content = msg.content.filter((b) => b.type !== "tool_result").map(claudeNativeBlock);
		if (!content.length) return;
		let message;
		if (native && Array.isArray(native.content) && native.content.length > 0 && nativeToolUseIdsConsistent(native.content, msg.content)) message = { ...native };
		else message = {
			id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
			container: null,
			model: msg.model ?? "claude-sonnet-4-5",
			role: "assistant",
			stop_reason: msg.stopReason ?? "end_turn",
			stop_sequence: null,
			type: "message",
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				server_tool_use: {
					web_search_requests: 0,
					web_fetch_requests: 0
				}
			},
			content
		};
		const uuid = randomUUID();
		const record = {
			type: "assistant",
			parentUuid: state.parentUuid,
			isSidechain,
			...env,
			message,
			uuid,
			timestamp: ts,
			requestId: typeof meta.requestId === "string" ? meta.requestId : void 0,
			...meta.isApiErrorMessage === true ? { isApiErrorMessage: true } : {},
			userType: st.userType ?? "external",
			entrypoint: st.entrypoint ?? "cli",
			cwd: st.cwd,
			sessionId: st.sessionId,
			...st.snakeSessionId ? { session_id: st.sessionId } : {},
			version: st.version,
			gitBranch: st.gitBranch,
			slug: st.slug,
			sessionKind: st.sessionKind
		};
		stripUndefined(record);
		state.records.push(record);
		state.parentUuid = uuid;
		trackEmitted(uuid);
		for (const b of msg.content) if (b.type === "tool_use") state.toolUseOwner.set(b.id, uuid);
		return;
	}
	if (meta.attachment !== void 0 && typeof meta.attachment === "object") {
		const uuid = randomUUID();
		const record = {
			parentUuid: state.parentUuid,
			isSidechain,
			attachment: meta.attachment,
			type: "attachment",
			uuid,
			timestamp: ts,
			userType: st.userType ?? "external",
			entrypoint: st.entrypoint ?? "cli",
			cwd: st.cwd,
			sessionId: st.sessionId,
			...st.snakeSessionId ? { session_id: st.sessionId } : {},
			version: st.version,
			gitBranch: st.gitBranch,
			slug: st.slug,
			sessionKind: st.sessionKind
		};
		stripUndefined(record);
		state.records.push(record);
		state.parentUuid = uuid;
		trackEmitted(uuid);
		return;
	}
	if (meta.systemSubtype === "local_command") {
		const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		const uuid = randomUUID();
		const record = {
			parentUuid: state.parentUuid,
			isSidechain,
			type: "system",
			subtype: "local_command",
			content: text,
			...meta.level !== void 0 ? { level: meta.level } : {},
			timestamp: ts,
			uuid,
			...meta.isMeta === true ? { isMeta: true } : {},
			userType: st.userType ?? "external",
			entrypoint: st.entrypoint ?? "cli",
			cwd: st.cwd,
			sessionId: st.sessionId,
			...st.snakeSessionId ? { session_id: st.sessionId } : {},
			version: st.version,
			gitBranch: st.gitBranch,
			slug: st.slug,
			sessionKind: st.sessionKind
		};
		stripUndefined(record);
		state.records.push(record);
		state.parentUuid = uuid;
		trackEmitted(uuid);
		return;
	}
	if (msg.role === "system" || msg.role === "developer") {
		const text = plainOf(msg);
		const uuid = randomUUID();
		const record = {
			parentUuid: state.parentUuid,
			isSidechain,
			type: "system",
			subtype: typeof meta.systemSubtype === "string" ? meta.systemSubtype : msg.role === "developer" ? "external_developer" : "external",
			...text ? { content: text } : {},
			...meta.level !== void 0 ? { level: meta.level } : {},
			timestamp: ts,
			uuid,
			...msg.synthetic === true ? { isMeta: true } : {},
			userType: st.userType ?? "external",
			entrypoint: st.entrypoint ?? "cli",
			cwd: st.cwd,
			sessionId: st.sessionId,
			...st.snakeSessionId ? { session_id: st.sessionId } : {},
			version: st.version,
			gitBranch: st.gitBranch,
			slug: st.slug,
			sessionKind: st.sessionKind
		};
		stripUndefined(record);
		state.records.push(record);
		state.parentUuid = uuid;
		trackEmitted(uuid);
		return;
	}
	const trBlocks = msg.content.filter((b) => b.type === "tool_result");
	const plain = msg.content.filter((b) => b.type !== "tool_result");
	const nativeContent = Array.isArray(native?.content) ? native.content : void 0;
	if (plain.length) {
		let messageContent = plain.map(claudeNativeBlock);
		if (native && typeof native.content === "string" && plain.length === 1 && plain[0].type === "text") messageContent = native.content;
		const uuid = randomUUID();
		const record = {
			type: "user",
			parentUuid: state.parentUuid,
			isSidechain,
			...env,
			message: {
				role: "user",
				content: messageContent
			},
			...msg.synthetic === true ? { isMeta: true } : {},
			...opts.compactSummary === true ? {
				isCompactSummary: true,
				isVisibleInTranscriptOnly: true
			} : {},
			uuid,
			timestamp: ts,
			userType: st.userType ?? "external",
			entrypoint: st.entrypoint ?? "cli",
			cwd: st.cwd,
			sessionId: st.sessionId,
			...st.snakeSessionId ? { session_id: st.sessionId } : {},
			version: st.version,
			gitBranch: st.gitBranch,
			slug: st.slug,
			sessionKind: st.sessionKind
		};
		stripUndefined(record);
		state.records.push(record);
		state.parentUuid = uuid;
		trackEmitted(uuid);
	}
	let trPos = 0;
	for (const tr of trBlocks) {
		const owner = ctx.state.toolUseOwner.get(tr.toolUseId);
		const nativeTr = nativeContent?.find((b) => b && typeof b === "object" && b.type === "tool_result" && b.tool_use_id === tr.toolUseId);
		const block = nativeTr ? { ...nativeTr } : claudeNativeBlock(tr);
		if (tr.isError && block.is_error === void 0) block.is_error = true;
		trPos += 1;
		const uuid = randomUUID();
		const record = {
			type: "user",
			parentUuid: owner ?? state.parentUuid,
			isSidechain,
			...env,
			message: {
				role: "user",
				content: [block]
			},
			uuid,
			timestamp: ts,
			toolUseResult: sanitizeToolUseResult(tr.rawResult),
			sourceToolAssistantUUID: owner ?? state.parentUuid,
			userType: st.userType ?? "external",
			entrypoint: st.entrypoint ?? "cli",
			cwd: st.cwd,
			sessionId: st.sessionId,
			...st.snakeSessionId ? { session_id: st.sessionId } : {},
			version: st.version,
			gitBranch: st.gitBranch,
			slug: st.slug,
			sessionKind: st.sessionKind
		};
		stripUndefined(record);
		state.records.push(record);
		state.parentUuid = uuid;
		trackEmitted(uuid);
	}
}
/** FHe() analog: toolUseResult must be JSON-serializable before persisting. */
function sanitizeToolUseResult(raw) {
	if (raw === void 0) return void 0;
	if (typeof raw !== "object") return raw;
	try {
		JSON.stringify(raw);
		return raw;
	} catch {
		return String(raw);
	}
}
/**
* Build the main jsonl records: header metadata rows → conversation chain →
* terminal last-prompt. Sidechains are built separately (buildSidechain).
*/
function buildMainRecords(ir, sessionId, opts) {
	const st = {
		sessionId,
		cwd: opts.targetCwd || (ir.cwd ?? ""),
		version: "2.1.251",
		gitBranch: "master",
		userType: "external",
		entrypoint: "cli",
		snakeSessionId: true
	};
	let clock = opts.nowMs ?? Date.now();
	const at = () => clock += 1;
	const ctx = {
		stamp: st,
		state: {
			records: [],
			parentUuid: null,
			toolUseOwner: /* @__PURE__ */ new Map(),
			emittedUuids: /* @__PURE__ */ new Set(),
			uuidRekey: /* @__PURE__ */ new Map()
		},
		isSidechain: false,
		at
	};
	const header = [];
	if (ir.title) header.push({
		type: "ai-title",
		aiTitle: ir.title,
		sessionId
	});
	const claudeMeta = ir.meta?.claude ?? {};
	const md = claudeMeta.metadata ?? {};
	const metaRows = md.rows;
	if (Array.isArray(metaRows)) for (const row of metaRows) {
		const t = row?.type;
		if (t === "ai-title" || t === "last-prompt") continue;
		header.push({
			...row,
			sessionId
		});
	}
	if (typeof claudeMeta.mode === "string") header.push({
		type: "mode",
		mode: claudeMeta.mode,
		sessionId
	});
	else if (typeof md.mode === "string") header.push({
		type: "mode",
		mode: md.mode,
		sessionId
	});
	if (typeof md.agentName === "string" && !header.some((h) => h.type === "agent-name")) header.push({
		type: "agent-name",
		agentName: md.agentName,
		sessionId
	});
	if (typeof md.agentColor === "string") header.push({
		type: "agent-color",
		agentColor: md.agentColor,
		sessionId
	});
	if (md.agentSetting !== void 0) header.push({
		type: "agent-setting",
		agentSetting: md.agentSetting,
		sessionId
	});
	if (md.atisLatch !== void 0 && typeof md.atisLatch === "object") header.push({
		...md.atisLatch,
		sessionId
	});
	if (ir.tag) header.push({
		type: "tag",
		tag: ir.tag,
		sessionId
	});
	if (ir.permissionMode) header.push({
		type: "permission-mode",
		permissionMode: ir.permissionMode,
		sessionId
	});
	if (ir.worktreeSession !== void 0) header.push({
		type: "worktree-state",
		worktreeSession: ir.worktreeSession,
		sessionId
	});
	if (ir.prLink) header.push({
		type: "pr-link",
		sessionId,
		prNumber: ir.prLink.prNumber,
		prUrl: ir.prLink.prUrl,
		prRepository: ir.prLink.prRepository,
		...typeof ir.prLink.timestamp === "string" ? { timestamp: ir.prLink.timestamp } : { timestamp: iso(clock) }
	});
	if (ir.costState) header.push({
		...ir.costState,
		sessionId
	});
	const compactByAnchor = /* @__PURE__ */ new Map();
	(ir.compaction ?? []).forEach((c) => {
		if (typeof c.anchorIndex === "number" && c.anchorIndex >= 0 && c.anchorIndex < ir.messages.length) compactByAnchor.set(c.anchorIndex, c);
		else if (typeof c.anchorIndex === "number") console.warn(`[claude write] compaction anchorIndex ${c.anchorIndex} out of range (messages.length=${ir.messages.length}) — boundary skipped`);
	});
	const keepGate = (m) => {
		const cm = m.meta?.claude ?? {};
		return m.synthetic !== true || opts.keepSynthetic === true || m.synthetic === true && cm.isMeta === true || cm.systemSubtype === "local_command" || m.content.some((b) => b.type === "tool_result");
	};
	for (let i = 0; i < ir.messages.length; i++) {
		const msg = ir.messages[i];
		const comp = compactByAnchor.get(i);
		if (comp) {
			emitCompactionPair(ctx, comp);
			const rest = stripSummaryBlocks(msg, comp.summary);
			if (rest.length && keepGate({
				...msg,
				content: rest
			})) emitMessage(ctx, {
				...msg,
				content: rest
			});
			continue;
		}
		if (!keepGate(msg)) continue;
		emitMessage(ctx, msg);
	}
	for (const ev of ir.sessionEvents ?? []) {
		const rec = ev.data ?? {};
		if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
		const t = rec.type;
		if (typeof t !== "string") continue;
		if (t === "system") {
			if (rec.subtype === "compact_boundary") continue;
			const uuid = randomUUID();
			const clone = {
				...rec,
				parentUuid: ctx.state.parentUuid,
				uuid,
				sessionId
			};
			if (st.snakeSessionId && rec.session_id !== void 0) clone.session_id = sessionId;
			ctx.state.records.push(clone);
			ctx.state.parentUuid = uuid;
			if (typeof rec.uuid === "string" && rec.uuid) ctx.state.emittedUuids.add(rec.uuid);
			continue;
		}
		if (TRANSCRIPT_ROW_TYPES.has(t)) ctx.state.records.push({
			...rec,
			sessionId
		});
	}
	const leaf = lastLeafUuidOf(ctx.state.records);
	const rawRecords = ir.extensions?.claude?.recordsRaw ?? [];
	const headerTypes = new Set(header.map((h) => h.type));
	for (const raw of rawRecords) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const r = raw;
		const t = typeof r.type === "string" ? r.type : void 0;
		if (typeof r.uuid === "string" && r.uuid && ctx.state.emittedUuids.has(r.uuid)) continue;
		if (t !== void 0 && headerTypes.has(t) && t !== "last-prompt" && t !== "ai-title") continue;
		const clone = {
			...r,
			sessionId
		};
		if (st.snakeSessionId && r.session_id !== void 0) clone.session_id = sessionId;
		ctx.state.records.push(clone);
	}
	const records = [...header, ...ctx.state.records];
	const lastUser = [...ir.messages].reverse().find((m) => m.role === "user" && m.synthetic !== true && m.content.some((b) => b.type === "text"));
	const lastPrompt = lastUser ? normalizeLastPrompt(messageFirstText(lastUser)) : void 0;
	if (lastPrompt !== void 0 || leaf !== void 0) {
		const lp = {
			type: "last-prompt",
			sessionId
		};
		if (lastPrompt) lp.lastPrompt = lastPrompt;
		if (leaf) lp.leafUuid = leaf;
		records.push(lp);
	}
	return {
		records,
		lastLeafUuid: leaf ?? void 0
	};
}
const TRANSCRIPT_ROW_TYPES = /* @__PURE__ */ new Set(["last-prompt", "ai-title"]);
/**
* P1-D: anchor 消息摘除构成 compaction 摘要的 text 块（emitCompactionPair 的
* isCompactSummary 行已承载摘要全文，重放会落盘两遍），其余块原样保留。
* 摘要块识别 = 等价文本块的拼接（其余实现如按 subsequence 精确切分，在
* 摘要块与额外 text 交错/部分重叠时会把额外内容误判成摘要块整体丢弃）。
*/
function stripSummaryBlocks(msg, summary) {
	const summaryText = summary.trim();
	if (!summaryText) return [...msg.content];
	const rest = [];
	let remaining = summaryText;
	for (const b of msg.content) {
		const text = b.type === "text" ? b.text.trim() : "";
		if (text !== "" && remaining.includes(text)) {
			const idx = remaining.indexOf(text);
			remaining = (remaining.slice(0, idx) + remaining.slice(idx + text.length)).trim();
			continue;
		}
		rest.push(b);
	}
	return rest;
}
/** sidechain file records (isSidechain:true + agentId stamps). */
function buildSidechainRecords(sc, sessionId, opts) {
	const st = {
		sessionId,
		cwd: opts.targetCwd || "",
		version: "2.1.251",
		gitBranch: void 0,
		userType: "external",
		entrypoint: "cli"
	};
	let clock = opts.nowMs ?? Date.now();
	const ctx = {
		stamp: st,
		state: {
			records: [],
			parentUuid: null,
			toolUseOwner: /* @__PURE__ */ new Map(),
			emittedUuids: /* @__PURE__ */ new Set(),
			uuidRekey: /* @__PURE__ */ new Map()
		},
		isSidechain: true,
		at: () => clock += 1,
		agentId: sc.agentId
	};
	for (const msg of sc.messages) {
		const scMeta = msg.meta?.claude ?? {};
		const isReplayRow = scMeta.isMeta === true || scMeta.systemSubtype === "local_command";
		if (msg.synthetic === true && opts.keepSynthetic !== true && !isReplayRow && !msg.content.some((b) => b.type === "tool_result")) continue;
		emitMessage(ctx, msg);
	}
	const agentMeta = sc.meta?.claude?.agentMeta ?? {};
	const meta = {
		...agentMeta,
		agentType: sc.agentType ?? (typeof agentMeta.agentType === "string" ? agentMeta.agentType : "general-purpose")
	};
	return {
		records: ctx.state.records,
		meta
	};
}
/** compaction entry → native boundary record + isCompactSummary user record. */
function emitCompactionPair(ctx, c) {
	const claudeMeta = c.meta?.claude ?? {};
	const cm = claudeMeta.compactMetadata ?? {};
	const boundaryRecord = claudeMeta.boundaryRecord;
	const boundary = boundaryRecord && typeof boundaryRecord === "object" && boundaryRecord.subtype === "compact_boundary" ? {
		...boundaryRecord,
		parentUuid: null
	} : {
		type: "system",
		subtype: "compact_boundary",
		content: "Conversation compacted",
		level: "info",
		compactMetadata: {
			trigger: "manual",
			...typeof c.tokensBefore === "number" ? { preTokens: c.tokensBefore } : {},
			...cm
		},
		uuid: randomUUID(),
		timestamp: iso(ctx.at())
	};
	boundary.parentUuid = null;
	if (typeof boundary.uuid !== "string" || !boundary.uuid) boundary.uuid = randomUUID();
	ctx.state.emittedUuids.add(boundary.uuid);
	if (typeof claudeMeta.summaryUuid === "string" && claudeMeta.summaryUuid) ctx.state.emittedUuids.add(claudeMeta.summaryUuid);
	{
		const rekey = ctx.state.uuidRekey;
		const cmAll = boundary.compactMetadata ?? {};
		const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
		const rekeyed = (u) => {
			if (typeof u !== "string") return void 0;
			const v = rekey.get(u);
			return typeof v === "string" ? v : void 0;
		};
		const segRaw = cmAll.preservedSegment;
		const pmRaw = cmAll.preservedMessages;
		const seg = isObj(segRaw) ? segRaw : void 0;
		const pm = isObj(pmRaw) ? pmRaw : void 0;
		const anchor = boundary.uuid;
		let segOut;
		if (seg) {
			const h = rekeyed(seg.headUuid);
			const t = rekeyed(seg.tailUuid);
			if (h !== void 0 && t !== void 0) segOut = {
				...seg,
				headUuid: h,
				anchorUuid: anchor,
				tailUuid: t
			};
		}
		let pmOut;
		if (pm) {
			const hits = (Array.isArray(pm.uuids) ? pm.uuids : []).map(rekeyed).filter((u) => u !== void 0);
			if (hits.length) {
				pmOut = {
					...pm,
					anchorUuid: anchor,
					uuids: hits
				};
				if (Array.isArray(pm.allUuids)) pmOut.allUuids = pm.allUuids.map(rekeyed).filter((u) => u !== void 0);
			}
		}
		if (seg !== void 0 || pm !== void 0) {
			const cmClone = { ...cmAll };
			if (segOut !== void 0) cmClone.preservedSegment = segOut;
			else delete cmClone.preservedSegment;
			if (pmOut !== void 0) cmClone.preservedMessages = pmOut;
			else delete cmClone.preservedMessages;
			boundary.compactMetadata = cmClone;
		}
	}
	if (typeof cm.logicalParentUuid === "string") boundary.logicalParentUuid = cm.logicalParentUuid;
	else if (ctx.state.parentUuid) boundary.logicalParentUuid = ctx.state.parentUuid;
	ctx.state.records.push(boundary);
	ctx.state.parentUuid = boundary.uuid;
	const sumMs = typeof claudeMeta.summaryTimestamp === "string" ? Date.parse(claudeMeta.summaryTimestamp) : NaN;
	emitMessage(ctx, {
		role: "user",
		content: [{
			type: "text",
			text: c.summary
		}],
		...Number.isFinite(sumMs) ? { timestamp: sumMs } : {}
	}, { compactSummary: true });
}
//#endregion
//#region ../core/dist/src/adapters/claude/index.js
/**
* Claude Code adapter — `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
* (+ `<sessionId>/subagents/agent-*.jsonl` sidechains & `.meta.json` sidecars).
*
* 红线 (docs/agents/claude.md §6):
*  1. NEVER delete, rewrite or append to an existing session file — write only
*     brand-new files under brand-new sessionIds; skip-and-report on collision;
*  2. 100% lossless except redacted_thinking.data; thinking.signature rides
*     byte-for-byte; everything without a typed slot survives in
*     extensions.claude.recordsRaw;
*  3. IR.systemPrompt is ignored on write (§5.4/#8) — claude regenerates its
*     system prompt per resume; the engine carries source prompts via the
*     --append-system-prompt process flag.
*
* listSessions follows the native /resume listing rules (§1/§1.0):
* filename must be a strict UUID; first line `"isSidechain":true` filters;
* head `teamName` (tmux teammate files) filters; title resolution is
* customTitle → aiTitle, summary display last-prompt.lastPrompt → legacy
* summary → firstPrompt; worktree dirs aggregate case-insensitively by
* longest-prefix (startsWith only allowed for ≥200 truncated+hash dirs).
*/
/** uuid v4-any-version validator (native listSessions validateUuid gate). */
function uuidValidate(s) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
var ClaudeAdapter = class {
	tool = "claude";
	irVersion = "3.3";
	/** Read one Claude session jsonl (main + sidechains) into IR. */
	async parse(sessionId, root) {
		const projectsRoot = root ?? defaultClaudeProjectsRoot();
		if (!projectsRoot) throw new Error("Claude: cannot resolve ~/.claude/projects");
		const path = await this.findJsonl(projectsRoot, sessionId);
		if (!path) throw new Error(`Claude: session "${sessionId}" not found under ${projectsRoot}`);
		return validateSession(await parseClaudeFile(path));
	}
	/**
	* Write IR as a brand-new Claude session file (红线 #1: 只新增).
	* When the target path already exists the write is SKIPPED and reported via
	* `skippedExisting` — never overwritten, never appended to.
	*/
	async write(ir, opts) {
		validateSession(ir);
		const projectsRoot = opts?.root ?? defaultClaudeProjectsRoot();
		if (!projectsRoot) throw new Error("Claude: cannot resolve ~/.claude/projects");
		const targetCwd = opts?.targetCwd ?? ir.cwd ?? "";
		if (!targetCwd) throw new Error("Claude: write needs a target cwd (opts.targetCwd or ir.cwd)");
		ir.systemPrompt;
		let newId = opts?.sessionId ?? randomUUID();
		const dir = join(projectsRoot, claudeProjectDirName(targetCwd));
		let finalPath = join(dir, `${newId}.jsonl`);
		if (await exists(finalPath)) {
			if (opts?.sessionId) throw new Error(`Claude: refusing to overwrite existing session file ${finalPath}`);
			newId = randomUUID();
			finalPath = join(dir, `${newId}.jsonl`);
		}
		const keepSynthetic = opts?.keepSynthetic === true;
		const paths = [];
		await promises.mkdir(dir, { recursive: true });
		const recordsRaw = (ir.extensions?.claude ?? {}).recordsRaw;
		if (ir.originTool === "claude" && Array.isArray(recordsRaw) && recordsRaw.length) {
			const lines = recordsRaw.map((row) => {
				if (!row || typeof row !== "object" || Array.isArray(row)) return JSON.stringify(row) ?? "";
				const clone = { ...row };
				if (clone.sessionId !== void 0) clone.sessionId = newId;
				if (clone.session_id !== void 0) clone.session_id = newId;
				return JSON.stringify(clone);
			});
			await promises.writeFile(finalPath, lines.join("\n") + "\n", {
				encoding: "utf8",
				flag: "wx"
			});
			paths.push(finalPath);
			if (ir.sidechains?.length) {
				const subagentsDir = join(dir, newId, "subagents");
				const used = /* @__PURE__ */ new Set();
				for (const sc of ir.sidechains) {
					let stem = `agent-${sanitizeStem(sc.agentId)}`;
					let n = 1;
					while (used.has(stem)) stem = `agent-${sanitizeStem(sc.agentId)}-${n++}`;
					used.add(stem);
					const { records, meta } = buildSidechainRecords(sc, newId, {
						targetCwd,
						keepSynthetic
					});
					const scPath = join(subagentsDir, `${stem}.jsonl`);
					if (await exists(scPath)) throw new Error(`Claude: refusing to overwrite existing sidechain file ${scPath}`);
					await promises.mkdir(subagentsDir, { recursive: true });
					await promises.writeFile(scPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", {
						encoding: "utf8",
						flag: "wx"
					});
					paths.push(scPath);
					await promises.writeFile(join(subagentsDir, `${stem}.meta.json`), JSON.stringify(meta), {
						encoding: "utf8",
						flag: "wx"
					});
					paths.push(`${scPath}.meta.json`);
				}
			}
			return {
				tool: "claude",
				sessionId: newId,
				paths
			};
		}
		const lines = buildMainRecords(ir, newId, {
			targetCwd,
			keepSynthetic
		}).records.map((r) => JSON.stringify(r));
		if (await exists(finalPath)) throw new Error(`Claude: refusing to overwrite existing session file ${finalPath}`);
		await promises.writeFile(finalPath, lines.join("\n") + "\n", {
			encoding: "utf8",
			flag: "wx"
		});
		paths.push(finalPath);
		if (ir.sidechains?.length) {
			const subagentsDir = join(dir, newId, "subagents");
			const used = /* @__PURE__ */ new Set();
			for (const sc of ir.sidechains) {
				let stem = `agent-${sanitizeStem(sc.agentId)}`;
				let n = 1;
				while (used.has(stem)) stem = `agent-${sanitizeStem(sc.agentId)}-${n++}`;
				used.add(stem);
				const { records, meta } = buildSidechainRecords(sc, newId, {
					targetCwd,
					keepSynthetic
				});
				const scPath = join(subagentsDir, `${stem}.jsonl`);
				if (await exists(scPath)) throw new Error(`Claude: refusing to overwrite existing sidechain file ${scPath}`);
				await promises.mkdir(subagentsDir, { recursive: true });
				await promises.writeFile(scPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", {
					encoding: "utf8",
					flag: "wx"
				});
				paths.push(scPath);
				await promises.writeFile(join(subagentsDir, `${stem}.meta.json`), JSON.stringify(meta), {
					encoding: "utf8",
					flag: "wx"
				});
				paths.push(`${scPath}.meta.json`);
			}
		}
		return {
			tool: "claude",
			sessionId: newId,
			paths
		};
	}
	/**
	* /resume-equivalent listing (§1.0): uuid-named files only, first-line
	* isSidechain + head teamName filtered, worktree dirs de-duplicated by
	* sessionId (mtime wins), titles customTitle → aiTitle.
	*/
	async listSessions(root) {
		const projectsRoot = root ?? defaultClaudeProjectsRoot();
		if (!projectsRoot) return [];
		let projects;
		try {
			projects = await promises.readdir(projectsRoot);
		} catch {
			return [];
		}
		const bySession = /* @__PURE__ */ new Map();
		for (const proj of projects) {
			const projDir = join(projectsRoot, proj);
			let entries;
			try {
				entries = await promises.readdir(projDir);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.endsWith(".jsonl")) continue;
				const sid = name.slice(0, -6);
				if (!uuidValidate(sid)) continue;
				const full = join(projDir, name);
				let head;
				try {
					head = await readClaudeLinesForList(full);
				} catch {
					continue;
				}
				if (head.isSidechain) continue;
				if (head.teamName) continue;
				let st;
				try {
					st = await promises.stat(full);
				} catch {
					continue;
				}
				const parsedCreated = head.firstTimestamp ? Date.parse(head.firstTimestamp) : NaN;
				const meta = {
					tool: "claude",
					sessionId: sid,
					...head.customTitle ?? head.aiTitle ?? head.lastPrompt ?? head.summary ?? head.firstPrompt ? { title: head.customTitle ?? head.aiTitle ?? head.lastPrompt ?? head.summary ?? head.firstPrompt } : {},
					createdAt: Number.isFinite(parsedCreated) ? parsedCreated : st.mtimeMs,
					sourcePath: full,
					...head.cwd ? { cwd: head.cwd } : {},
					archived: false
				};
				const prev = bySession.get(sid);
				if (!prev || st.mtimeMs > prev._mtime) bySession.set(sid, {
					...meta,
					_mtime: st.mtimeMs
				});
			}
		}
		return [...bySession.values()].map(({ _mtime, ...m }) => m);
	}
	/** Offline preview. */
	preview(session) {
		const main = session.messages.map((m) => `[${m.role}${m.synthetic ? " (synthetic)" : ""}]\n${blocksToText(m.content)}`).join("\n\n");
		if (session.sidechains?.length) {
			const extra = session.sidechains.map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]`).join("\n");
			return main ? `${main}\n\n${extra}` : extra;
		}
		return main;
	}
	/** Find the jsonl for a sessionId across all project dirs. */
	async findJsonl(root, sessionId) {
		let projects;
		try {
			projects = await promises.readdir(root);
		} catch {
			return null;
		}
		for (const proj of projects) {
			const candidate = join(root, proj, `${sessionId}.jsonl`);
			try {
				await promises.access(candidate);
				return candidate;
			} catch {}
		}
		return null;
	}
};
async function exists(p) {
	try {
		await promises.access(p);
		return true;
	} catch {
		return false;
	}
}
function sanitizeStem(agentId) {
	return agentId.replace(/[^A-Za-z0-9-]/g, "-") || "unknown";
}
//#endregion
//#region ../core/dist/src/adapters/codex/paths.js
/**
* Codex storage path helpers.
*
* Source-anchored (`D:\codes\Opensource\codex-main\codex-rs`):
*   - Sessions  : `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]`
*     (rollout/src/rollout_file_name.rs:39-74; `_rolloutId` suffix marks a reverted thread).
*   - Archives  : `<CODEX_HOME>/archived_sessions/…` (same format; rollout/src/list.rs:1595).
*   - Name index: `<CODEX_HOME>/session_index.jsonl` (append-only, newest match wins,
*     rollout/src/session_index.rs:24-71; entry = {id, thread_name, updated_at}).
*
* Filename quirk kept verbatim (docs/agents/codex.md §4): the recorder renders the
* filename timestamp in LOCAL time while the parser re-reads it as UTC
* (rollout_file_name.rs:54 `assume_utc`). We render UTC + build dirs in local
* time — same behavior Codex itself has, don't "fix" it.
*
* CODEX_HOME resolution mirrors the Codex CLI: `$CODEX_HOME`, else `~/.codex`.
*/
function defaultCodexHome() {
	if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) return process.env.CODEX_HOME;
	const home = homedir();
	return home ? join(home, ".codex") : void 0;
}
/**
* uuidv7-semantic thread id (Codex ThreadId/RolloutId are uuidv7: 48-bit
* unix-ms prefix + version 7 + RFC variant). Hand-rolled so Node 22 works too.
*/
function uuidv7() {
	const b = randomUUID().replace(/-/g, "").match(/../g).map((h) => parseInt(h, 16));
	const ts = Date.now();
	b[0] = ts / 2 ** 40 & 255;
	b[1] = ts / 2 ** 32 & 255;
	b[2] = ts / 2 ** 24 & 255;
	b[3] = ts / 2 ** 16 & 255;
	b[4] = ts / 256 & 255;
	b[5] = ts & 255;
	b[6] = b[6] & 15 | 112;
	b[8] = b[8] & 63 | 128;
	const hex = b.map((n) => n.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** `rollout-<YYYY-MM-DDTHH-mm-ss>-<id>.jsonl` (or `...-<threadId>_<rolloutId>.jsonl`). */
function rolloutFileName(threadId, createdAt, rolloutId) {
	return `rollout-${formatRolloutTimestampUtc(createdAt)}-${threadId}${rolloutId && rolloutId !== threadId ? `_${rolloutId}` : ""}.jsonl`;
}
/**
* Filename timestamp rendered in UTC (official format has no offset; the
* recorder writes local time here, the parser reads it back as UTC — quirk
* preserved, docs/agents/codex.md §4).
*/
function formatRolloutTimestampUtc(createdAt) {
	const d = new Date(createdAt);
	const p2 = (n) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-${p2(d.getUTCSeconds())}`;
}
/**
* Parse a rollout file name → `{ createdAt, threadId, rolloutId, compressed }`
* (rollout_file_name.rs:39-60: ts is 19 chars, parsed as UTC).
* Returns null for non-rollout names.
*/
function parseRolloutFileName(name) {
	const compressed = name.endsWith(".jsonl.zst");
	const core = compressed ? name.slice(0, -4) : name;
	if (!core.startsWith("rollout-") || !core.endsWith(".jsonl")) return null;
	const body = core.slice(8, -6);
	const ts = body.slice(0, 19);
	if (body[19] !== "-") return null;
	const ids = body.slice(20);
	const under = ids.indexOf("_");
	const threadId = under >= 0 ? ids.slice(0, under) : ids;
	const rolloutId = under >= 0 ? ids.slice(under + 1) : threadId;
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(ts);
	if (!m || !threadId || !rolloutId) return null;
	const createdAt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	if (!Number.isFinite(createdAt)) return null;
	return {
		createdAt,
		threadId,
		rolloutId,
		compressed
	};
}
/** `sessions/YYYY/MM/DD/` built from LOCAL time (recorder.rs:1630 `now_local`). */
function sessionDirFor(codexHome, createdAt) {
	const d = new Date(createdAt);
	const p2 = (n) => String(n).padStart(2, "0");
	return join(codexHome, "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
}
/** Convenience: absolute path for a new rollout file. */
function codexSessionPathFor(codexHome, threadId, createdAt, rolloutId) {
	return join(sessionDirFor(codexHome, createdAt), rolloutFileName(threadId, createdAt, rolloutId));
}
function archivedDir(codexHome) {
	return join(codexHome, "archived_sessions");
}
function sessionIndexPath(codexHome) {
	return join(codexHome, "session_index.jsonl");
}
//#endregion
//#region ../core/dist/src/adapters/codex/parse.js
/**
* Codex rollout READ side — `.codex` sessions tree (rollout JSONL, plain or
* zstd) into IR.
*
* Format authority: docs/agents/codex.md (v3 deep-dive), cross-checked against
* codex-rs sources: history/src/lib.rs (RolloutLine envelope, CompactedItem),
* history/src/rollout_payload.rs (wire shapes incl. response_item envelope
* `metadata.client_authored`), protocol/src/protocol.rs (SessionMeta(Line),
* TurnContextItem, WorldStateItem, InterAgentCommunication, EventMsg),
* protocol/src/models.rs (ResponseItem + ContentItem variants),
* rollout/src/policy.rs (persistence whitelist).
*
* Losslessness contract (docs/agents/codex.md §8):
*  - every rollout record type lands in a typed IR slot; nothing is dropped
*    except `encrypted_content` / `encrypted_function_args` (placeholder flag);
*  - session_meta lines (own + inherited prefix) → `meta.codex.sessionMetaLine`
*    / `inheritedMetaLines` (raw payload + envelope ts/ordinal);
*  - each response_item → one MigratedMessage (codex-native 1 item = 1 line),
*    native fields on `msg.meta.codex`; `msg.seq` = source line/ordinal so
*    write-back can rebuild exact order;
*  - turn_context / world_state rows attach to the NEXT created message
*    (`meta.codex.turnContext(s)` / `worldState[]`); orphans (nothing follows)
*    archive to unmappedEvents so replay still emits them verbatim;
*  - compacted → `compaction[]` (summary + anchorIndex + replacementHistory +
*    meta.codex window fields) with the summary ALSO projected as a message;
*  - event_msg + security_risk_score + realtime_item + iac-metadata + unknown
*    rows → `unmappedEvents[]` (seq = source line number, raw payload in data).
*/
const PLACEHOLDER_ENCRYPTED$1 = "[encrypted_content omitted by cc-migrate]";
const IR_ROLES = /* @__PURE__ */ new Set([
	"user",
	"assistant",
	"developer",
	"system"
]);
async function readRolloutText(path) {
	if (path.endsWith(".zst")) {
		const buf = await promises.readFile(path);
		const { zstdDecompressSync } = await import("node:zlib");
		if (typeof zstdDecompressSync !== "function") throw new Error(`Codex: cannot decompress ${path} — node:zlib zstdDecompressSync unavailable (needs Node >= 22.15)`);
		return zstdDecompressSync(buf).toString("utf8");
	}
	return promises.readFile(path, "utf8");
}
function parseRolloutLines(text) {
	const out = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			out.push({
				timestamp: "",
				type: "(unparseable)",
				payload: { raw: trimmed }
			});
		}
	}
	return out;
}
async function loadSessionIndexTitles(codexHome) {
	const titles = /* @__PURE__ */ new Map();
	let text;
	try {
		text = await promises.readFile(join(codexHome, "session_index.jsonl"), "utf8");
	} catch {
		return titles;
	}
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed);
			if (entry.id && typeof entry.thread_name === "string" && entry.thread_name.trim()) titles.set(entry.id, entry.thread_name);
		} catch {}
	}
	return titles;
}
/** Stop scanning once the title is found; 2 MB covers even goal-steered
*  sessions whose first real prompt sits behind large injected blocks. */
const HEAD_SCAN_BYTE_CAP = 2097152;
/**
* Streaming head scan for the session LIST: cwd + thread_spawn parent + first
* real user prompt, without a full parse. Title classification goes through
* the SAME code path as the full parse (`responseItemToMessage` →
* `markContentKind`), so list titles can never diverge from parse titles —
* including `content_item_kinds` filtering and legacy text-marker sniffing.
*/
async function scanRolloutHead(path) {
	const out = {};
	const consider = (env) => {
		const payload = env.payload;
		if (!payload || typeof payload !== "object") return false;
		if (env.type === "session_meta") {
			if (out.cwd === void 0 && typeof payload.cwd === "string") out.cwd = payload.cwd;
			if (out.parentThreadId === void 0) {
				const parent = (payload.source?.subagent)?.thread_spawn?.parent_thread_id;
				if (typeof parent === "string") out.parentThreadId = parent;
			}
			return false;
		}
		if (env.type !== "response_item") return false;
		if (payload.type !== "message" || payload.role !== "user") return false;
		const msg = responseItemToMessage(payload, {
			ts: "",
			clientAuthored: false,
			lineSeq: 0
		});
		if (!msg || msg.synthetic) return false;
		const meta = msg.meta.codex;
		if (meta.contentKind || meta.kind) return false;
		const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
		if (!text) return false;
		const one = text.replace(/\s+/g, " ");
		out.title = one.length > 60 ? `${one.slice(0, 60)}…` : one;
		return true;
	};
	const tryLine = (line) => {
		const trimmed = line.trim();
		if (!trimmed) return false;
		try {
			return consider(JSON.parse(trimmed));
		} catch {
			return false;
		}
	};
	if (path.endsWith(".zst")) {
		for (const line of (await readRolloutText(path)).split("\n")) if (tryLine(line)) break;
		return out;
	}
	const fh = await promises.open(path, "r");
	try {
		const buf = Buffer.alloc(262144);
		const dec = new StringDecoder("utf8");
		let carry = "";
		let pos = 0;
		while (pos < HEAD_SCAN_BYTE_CAP) {
			const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
			if (!bytesRead) break;
			pos += bytesRead;
			const lines = (carry + dec.write(buf.subarray(0, bytesRead))).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) if (tryLine(line)) return out;
		}
	} finally {
		await fh.close();
	}
	return out;
}
/**
* session_meta is always record #1, so the subagent linkage
* (`source.subagent.thread_spawn`, plus the top-level mirror fields) is
* answerable from the first line alone — cheap enough to run across every
* rollout to build the parent→children map for read-side sidechain stitching.
* Guarded on thread_source==='subagent'/'thread_spawn' so user forks
* (forked_from_id) never count as subagent children.
*/
async function scanRolloutMeta(path) {
	let head;
	if (path.endsWith(".zst")) head = (await readRolloutText(path)).split("\n")[0];
	else {
		const fh = await promises.open(path, "r");
		try {
			const buf = Buffer.alloc(65536);
			const chunks = [];
			let total = 0;
			while (total < 524288) {
				const { bytesRead } = await fh.read(buf, 0, buf.length, total);
				if (!bytesRead) break;
				chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
				total += bytesRead;
				const nl = Buffer.concat(chunks).indexOf(10);
				if (nl >= 0) {
					head = Buffer.concat(chunks).toString("utf8", 0, nl);
					break;
				}
			}
			if (head === void 0) head = Buffer.concat(chunks).toString("utf8");
		} finally {
			await fh.close();
		}
	}
	if (!head?.trim()) return {};
	try {
		const env = JSON.parse(head);
		if (env.type !== "session_meta") return {};
		const payload = env.payload;
		if (!payload || typeof payload !== "object") return {};
		const threadSpawn = (payload.source?.subagent)?.thread_spawn;
		if (!threadSpawn && payload.thread_source !== "subagent") return {};
		const pick = (nested, top) => typeof nested === "string" ? nested : typeof top === "string" ? top : void 0;
		const parent = pick(threadSpawn?.parent_thread_id, payload.parent_thread_id);
		return {
			...parent ? { parentThreadId: parent } : {},
			...pick(threadSpawn?.agent_nickname, payload.agent_nickname) ? { agentNickname: pick(threadSpawn?.agent_nickname, payload.agent_nickname) } : {},
			...pick(threadSpawn?.agent_role, payload.agent_role) ? { agentRole: pick(threadSpawn?.agent_role, payload.agent_role) } : {},
			...pick(threadSpawn?.agent_path, payload.agent_path) ? { agentPath: pick(threadSpawn?.agent_path, payload.agent_path) } : {}
		};
	} catch {
		return {};
	}
}
function rolloutRecordsToIr(records, ctx = {}) {
	const messages = [];
	const compaction = [];
	const unmapped = [];
	const metaLines = [];
	const pendingTurnBits = [];
	const scope = ctx.stitchedChain?.length ? `s${ctx.stitchedChain.length}` : void 0;
	for (let i = 0; i < records.length; i++) {
		const rec = records[i];
		const ts = rec.timestamp ?? "";
		const time = ts ? Date.parse(ts) : void 0;
		const ordinal = typeof rec.ordinal === "number" ? rec.ordinal : void 0;
		const row = ordinal === void 0 ? {
			ts,
			payload: rec.payload
		} : {
			ts,
			ordinal,
			payload: rec.payload
		};
		const clientAuthored = rec.metadata?.client_authored === true;
		switch (rec.type) {
			case "session_meta":
				metaLines.push(row);
				continue;
			case "response_item": {
				const payload = rec.payload ?? {};
				const item = responseItemToMessage(payload, {
					ts,
					ordinal,
					clientAuthored,
					lineSeq: i,
					...scope ? { scope } : {}
				});
				if (item) {
					flushTurnBits(item, pendingTurnBits);
					messages.push(item);
				} else unmapped.push(unmappedEvent(ordinal ?? i, time !== void 0 && Number.isFinite(time) ? time : void 0, "response_item", {
					codexResponseItem: stripEncrypted(payload),
					...clientAuthored ? { clientAuthored: true } : {}
				}));
				continue;
			}
			case "event_msg": {
				const payload = rec.payload ?? {};
				unmapped.push(unmappedEvent(ordinal ?? i, time !== void 0 && Number.isFinite(time) ? time : void 0, typeof payload.type === "string" ? payload.type : "(missing)", stripEncrypted(payload)));
				continue;
			}
			case "turn_context":
			case "world_state":
				pendingTurnBits.push({
					kind: rec.type === "turn_context" ? "turnContext" : "worldState",
					row: {
						...row,
						kind: rec.type
					},
					seq: ordinal ?? i,
					...time !== void 0 && Number.isFinite(time) ? { time } : {}
				});
				continue;
			case "compacted": {
				const entry = compactedToEntry(rec.payload ?? {}, {
					ts,
					ordinal,
					lineSeq: i,
					...scope ? { scope } : {}
				}, messages);
				flushTurnBits(entry.summaryMessage, pendingTurnBits);
				entry.entry.anchorIndex = messages.length;
				compaction.push(entry.entry);
				messages.push(entry.summaryMessage);
				continue;
			}
			case "inter_agent_communication": {
				const msg = iacToMessage(rec.payload ?? {}, {
					ts,
					ordinal,
					lineSeq: i
				});
				if (msg) {
					flushTurnBits(msg, pendingTurnBits);
					messages.push(msg);
				}
				continue;
			}
			case "inter_agent_communication_metadata":
			case "security_risk_score":
			case "realtime_item":
				unmapped.push(unmappedEvent(ordinal ?? i, time !== void 0 && Number.isFinite(time) ? time : void 0, rec.type, stripEncrypted(rec.payload ?? {})));
				continue;
			default:
				unmapped.push(unmappedEvent(ordinal ?? i, time !== void 0 && Number.isFinite(time) ? time : void 0, rec.type ?? "(missing)", { codexRolloutLine: rec }));
				continue;
		}
	}
	for (const pending of pendingTurnBits) unmapped.push(unmappedEvent(pending.seq, pending.time, pending.kind === "turnContext" ? "turn_context" : "world_state", { codexOrphanTurnBit: pending.row }));
	const own = metaLines[0]?.payload;
	const inherited = metaLines.slice(1);
	const threadId = typeof own?.id === "string" ? own.id : typeof own?.session_id === "string" ? own.session_id : void 0;
	const baseInstructions = own?.base_instructions;
	const modelProvider = typeof own?.model_provider === "string" ? own.model_provider : void 0;
	const createdAt = own && typeof own.timestamp === "string" ? orEpoch(own.timestamp) : void 0;
	const sessionMeta = { sessionMetaLine: metaLines[0] };
	if (inherited.length) sessionMeta.inheritedMetaLines = inherited;
	if (baseInstructions?.provenance !== void 0) sessionMeta.baseInstructionsProvenance = baseInstructions.provenance;
	const indexTitle = threadId ? ctx.titles?.get(threadId) : void 0;
	if (indexTitle) sessionMeta.sessionIndex = { thread_name: indexTitle };
	const title = indexTitle ?? titleFromMessages(messages);
	if (ctx.sourcePath) {
		sessionMeta.sourceFile = basename(ctx.sourcePath);
		sessionMeta.sourceDir = splitDir(ctx.sourcePath);
	}
	if (ctx.stitchedChain?.length) sessionMeta.historyChain = ctx.stitchedChain;
	return {
		schemaVersion: 2,
		originTool: "codex",
		originSessionId: threadId,
		...title !== void 0 ? { title } : {},
		...createdAt !== void 0 && Number.isFinite(createdAt) ? { createdAt } : {},
		...typeof own?.cwd === "string" ? { cwd: own.cwd } : {},
		...modelProvider ? { model: { id: modelProvider } } : {},
		...typeof baseInstructions?.text === "string" && baseInstructions.text ? { systemPrompt: baseInstructions.text } : {},
		messages,
		...compaction.length ? { compaction } : {},
		...unmapped.length ? { unmappedEvents: unmapped } : {},
		meta: { codex: sessionMeta }
	};
}
/**
* First real user prompt, collapsed to one 60-char line — the codex session
* naming convention. Harness-injected rows are skipped via the same fields the
* classifier sets (synthetic / contentKind / kind). Shared with the write side
* (sessionIndexTitle) so parse and write can never diverge on the rule.
*/
function titleFromMessages(messages) {
	for (const m of messages) {
		if (m.role !== "user" || m.synthetic) continue;
		const codex = m.meta?.codex;
		if (codex?.contentKind || codex?.kind) continue;
		const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
		if (!text) continue;
		const one = text.replace(/\s+/g, " ");
		return one.length > 60 ? `${one.slice(0, 60)}…` : one;
	}
}
/** MigratedUnmappedEvent with optional time (spread keeps it absent, not undefined). */
function unmappedEvent(seq, time, type, data) {
	return {
		seq,
		...time !== void 0 ? { time } : {},
		type,
		data
	};
}
function orEpoch(ts) {
	const t = Date.parse(ts);
	return Number.isFinite(t) ? t : 0;
}
/** Directory portion of a path with forward slashes ('sessions/2026/08/20', 'archived_sessions'). */
function splitDir(p) {
	const norm = p.replace(/\\/g, "/");
	const i = norm.lastIndexOf("/");
	return i > 0 ? norm.slice(0, i) : ".";
}
function baseMeta(ctx, itemType) {
	const meta = {
		itemType,
		ts: ctx.ts
	};
	if (ctx.ordinal !== void 0) meta.ordinal = ctx.ordinal;
	return meta;
}
/** response_item payload → one MigratedMessage (or null when archived instead). */
function responseItemToMessage(payload, ctx) {
	const itemType = typeof payload.type === "string" ? payload.type : "(unknown)";
	const itemId = typeof payload.id === "string" ? payload.id : void 0;
	const ts = ctx.ts;
	const timestamp = orEpoch(ts);
	switch (itemType) {
		case "message": {
			const nativeRole = typeof payload.role === "string" ? payload.role : "user";
			const irRole = IR_ROLES.has(nativeRole) ? nativeRole : "user";
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			meta.role = nativeRole;
			if (typeof payload.phase === "string") meta.phase = payload.phase;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			const kinds = passthroughKinds(payload.internal_chat_message_metadata_passthrough);
			if (kinds) meta.contentItemKinds = kinds;
			if (ctx.clientAuthored) meta.clientAuthored = true;
			const msg = {
				role: irRole,
				content: contentItemsToBlocks(payload.content, meta),
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
			markContentKind(msg);
			return msg;
		}
		case "agent_message": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			meta.kind = "agent_message";
			meta.author = typeof payload.author === "string" ? payload.author : "";
			meta.recipient = typeof payload.recipient === "string" ? payload.recipient : "";
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			const rawContent = Array.isArray(payload.content) ? payload.content : [];
			const hasEncrypted = rawContent.some((c) => typeof c === "object" && c !== null && c.type === "encrypted_content");
			const content = [];
			for (const part of rawContent) if (typeof part === "object" && part !== null && part.type === "input_text") content.push({
				type: "text",
				text: String(part.text ?? "")
			});
			else content.push({
				type: "text",
				text: PLACEHOLDER_ENCRYPTED$1
			});
			if (hasEncrypted) {
				meta.encryptedDropped = true;
				meta.contentRaw = rawContent.map((c) => typeof c === "object" && c !== null && c.type === "encrypted_content" ? {
					type: "encrypted_content",
					encrypted_content: PLACEHOLDER_ENCRYPTED$1
				} : c);
			}
			return {
				role: "assistant",
				content,
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "reasoning": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			const summary = Array.isArray(payload.summary) ? payload.summary : [];
			if (payload.content === null) meta.reasoningContentNull = true;
			const content = Array.isArray(payload.content) ? payload.content : [];
			const entries = [...summary, ...content];
			const entryTypes = [];
			const blocks = [];
			for (const e of entries) {
				const t = typeof e === "object" && e !== null ? String(e.type ?? "summary_text") : "summary_text";
				const text = typeof e === "object" && e !== null ? String(e.text ?? "") : "";
				entryTypes.push(t);
				blocks.push({
					type: "thinking",
					thinking: text
				});
			}
			meta.reasoningEntryTypes = entryTypes;
			meta.reasoningSummaryCount = summary.length;
			if (payload.encrypted_content !== void 0 && payload.encrypted_content !== null) meta.encryptedDropped = true;
			return {
				role: "assistant",
				content: blocks,
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "function_call": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			if (typeof payload.namespace === "string") meta.namespace = payload.namespace;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			const callId = typeof payload.call_id === "string" ? payload.call_id : "";
			const argumentsRaw = typeof payload.arguments === "string" ? payload.arguments : "";
			let input = argumentsRaw;
			try {
				input = JSON.parse(argumentsRaw);
			} catch {
				input = argumentsRaw;
			}
			if (JSON.stringify(input) !== argumentsRaw) meta.argumentsRaw = argumentsRaw;
			if (payload.encrypted_function_args !== void 0) meta.encryptedDropped = true;
			return {
				role: "assistant",
				content: [{
					type: "tool_use",
					id: callId,
					name: String(payload.name ?? "function"),
					input
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "custom_tool_call": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			if (typeof payload.namespace === "string") meta.namespace = payload.namespace;
			if (typeof payload.status === "string") meta.status = payload.status;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			return {
				role: "assistant",
				content: [{
					type: "tool_use",
					id: typeof payload.call_id === "string" ? payload.call_id : "",
					name: String(payload.name ?? "custom"),
					input: String(payload.input ?? "")
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "function_call_output":
		case "custom_tool_call_output": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			if (typeof payload.name === "string") meta.name = payload.name;
			if (typeof payload.namespace === "string") meta.namespace = payload.namespace;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			const hasCallId = typeof payload.call_id === "string" && payload.call_id !== "";
			meta.callId = hasCallId ? payload.call_id : null;
			const output = payload.output;
			if (Array.isArray(output)) meta.outputRaw = output;
			const { text, attachments } = outputToTextAndAttachments(output);
			const block = {
				type: "tool_result",
				toolUseId: hasCallId ? payload.call_id : "",
				content: text
			};
			if (attachments.length) block.attachments = attachments;
			return {
				role: "tool",
				content: [block],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "local_shell_call": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			const hasCallId = typeof payload.call_id === "string" && payload.call_id !== "";
			if (hasCallId) meta.callId = payload.call_id;
			else if (payload.call_id === null) meta.callId = null;
			meta.status = String(payload.status ?? "");
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			return {
				role: "assistant",
				content: [{
					type: "tool_use",
					id: hasCallId ? payload.call_id : `local_shell_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`,
					name: "local_shell",
					input: payload.action ?? {}
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "tool_search_call": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			const hasCallId = typeof payload.call_id === "string" && payload.call_id !== "";
			if (hasCallId) meta.callId = payload.call_id;
			else if (payload.call_id === null) meta.callId = null;
			if (typeof payload.status === "string") meta.status = payload.status;
			meta.execution = String(payload.execution ?? "");
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			return {
				role: "assistant",
				content: [{
					type: "tool_use",
					id: hasCallId ? payload.call_id : `tool_search_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`,
					name: "tool_search",
					input: payload.arguments ?? {}
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "tool_search_output": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			const hasCallId = typeof payload.call_id === "string" && payload.call_id !== "";
			if (hasCallId) meta.callId = payload.call_id;
			else if (payload.call_id === null) meta.callId = null;
			meta.status = String(payload.status ?? "");
			meta.execution = String(payload.execution ?? "");
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			return {
				role: "tool",
				content: [{
					type: "tool_result",
					toolUseId: hasCallId ? payload.call_id : `tool_search_out_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`,
					content: JSON.stringify(payload.tools ?? [])
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "web_search_call": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			if (typeof payload.status === "string") meta.status = payload.status;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			return {
				role: "assistant",
				content: [{
					type: "tool_use",
					id: itemId ?? `web_search_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`,
					name: "web_search",
					input: payload.action ?? {}
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "image_generation_call": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			meta.status = String(payload.status ?? "");
			if (typeof payload.revised_prompt === "string") meta.revisedPrompt = payload.revised_prompt;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			const callId = itemId ?? `image_gen_${ctx.scope ? `${ctx.scope}_${ctx.lineSeq}` : ctx.lineSeq}`;
			return {
				role: "assistant",
				content: [{
					type: "tool_use",
					id: callId,
					name: "image_generation",
					input: typeof payload.revised_prompt === "string" ? { revised_prompt: payload.revised_prompt } : {}
				}, {
					type: "tool_result",
					toolUseId: callId,
					content: "",
					attachments: [{
						type: "file",
						mediaType: "image/png",
						data: String(payload.result ?? "")
					}]
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		case "compaction":
		case "context_compaction": {
			const meta = baseMeta(ctx, itemType);
			if (itemId) meta.itemId = itemId;
			if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
			meta.encryptedDropped = itemType === "compaction" || payload.encrypted_content != null;
			return {
				role: "assistant",
				content: [{
					type: "text",
					text: PLACEHOLDER_ENCRYPTED$1
				}],
				timestamp,
				seq: ctx.ordinal ?? ctx.lineSeq,
				meta: { codex: meta }
			};
		}
		default: return null;
	}
}
function contentItemsToBlocks(content, meta) {
	const items = Array.isArray(content) ? content : content != null ? [content] : [];
	const blocks = [];
	for (const item of items) {
		if (typeof item === "string") {
			blocks.push({
				type: "text",
				text: item
			});
			continue;
		}
		if (typeof item !== "object" || item === null) continue;
		const c = item;
		switch (c.type) {
			case "input_text":
			case "output_text":
				blocks.push({
					type: "text",
					text: String(c.text ?? "")
				});
				break;
			case "input_image": {
				const url = String(c.image_url ?? "");
				const file = {
					type: "file",
					url
				};
				const mime = /^data:([^;,]+)/.exec(url)?.[1];
				if (mime) file.mediaType = mime;
				if (typeof c.detail === "string") {
					meta.imageDetails = meta.imageDetails ?? {};
					meta.imageDetails[blocks.length] = c.detail;
				}
				blocks.push(file);
				break;
			}
			case "input_audio": {
				const url = String(c.audio_url ?? "");
				const file = {
					type: "file",
					url
				};
				file.mediaType = /^data:([^;,]+)/.exec(url)?.[1] ?? "audio/basic";
				meta.audioBlocks = meta.audioBlocks ?? [];
				meta.audioBlocks.push(blocks.length);
				blocks.push(file);
				break;
			}
			default: blocks.push({
				type: "text",
				text: JSON.stringify(c)
			});
		}
	}
	return blocks;
}
/**
* Official channel: the positional `content_item_kinds` on
* `internal_chat_message_metadata_passthrough` (codex-rs
* context-fragments/src/annotated_content.rs — kinds zip with content items,
* missing entries read as "unknown"; ContentItemKind is a String newtype so
* the wire values are bare dotted strings, e.g. "goal.internal_context").
*
* Legacy rollouts without kinds fall back to the frozen text-marker list
* codex itself uses for persisted history (thread-store/src/local/
* rollout_migration/rollback.rs is_known_contextual_user_text + the
* developer-message prefix list).
*/
/** Kinds carrying user- or agent-authored content — never harness-only. */
const NON_HARNESS_KINDS = /* @__PURE__ */ new Set([
	"unknown",
	"shell.user_command",
	"multi_agent.inter_agent_message",
	"multi_agent.inter_agent_completion_message"
]);
function isHarnessContentKind(kind) {
	if (kind.startsWith("user.")) return false;
	return !NON_HARNESS_KINDS.has(kind);
}
/** Kinds codex regenerates per run (droppable on write; `keepSynthetic` keeps them). */
const SYNTHETIC_KIND_PREFIXES = [
	".internal_context",
	".reminder",
	".instructions",
	".environment_context"
];
const SYNTHETIC_KINDS = /* @__PURE__ */ new Set([
	"token_budget.context_window",
	"token_budget.context_window_guidance",
	"token_budget.remaining_tokens",
	"rollout_budget.remaining_tokens",
	"images.preparation_error",
	"images.resize_notice",
	"images.unsupported",
	"audio.unsupported",
	"model_switch.legacy_mismatch_warning",
	"permissions.approved_command_prefix_saved",
	"network_proxy.rule_saved",
	"guardian.policy",
	"guardian.approved_action",
	"guardian.node_repl_policy",
	"guardian.review_evidence",
	"guardian.node_repl_review_evidence",
	"guardian.followup_review_reminder",
	"guardian.warning",
	"hooks.additional_context",
	"extension.internal_context",
	"generic.turn_aborted",
	"generic.developer_policy",
	"generic.developer_instructions",
	"compaction.summary",
	"compaction.auto_fallback_prompt",
	"apply_patch.legacy_exec_command_warning",
	"unified_exec.legacy_process_limit_warning",
	"multi_agent.usage_hint",
	"multi_agent.subagent_notification",
	"multi_agent.role_instructions",
	"multi_agent.mode_instructions",
	"plugins.recommendations",
	"tools.deferred_namespaces",
	"tools.instructions"
]);
function isSyntheticContentKind(kind) {
	if (NON_HARNESS_KINDS.has(kind) || kind.startsWith("user.")) return false;
	if (SYNTHETIC_KINDS.has(kind)) return true;
	return SYNTHETIC_KIND_PREFIXES.some((p) => kind.endsWith(p));
}
/** Positional kinds out of the passthrough (wire values are bare strings). */
function passthroughKinds(passthrough) {
	if (typeof passthrough !== "object" || passthrough === null) return void 0;
	const kinds = passthrough.content_item_kinds;
	if (!Array.isArray(kinds) || !kinds.length) return void 0;
	const out = kinds.map((k) => typeof k === "string" ? k : typeof k === "object" && k !== null ? String(k.value ?? "unknown") : "unknown");
	return out.length ? out : void 0;
}
/**
* Legacy text-marker tables — mirrors codex-rs thread-store/src/local/
* rollout_migration/rollback.rs (frozen "alongside the legacy migration
* adapter"). [start, end | null, kind, synthetic]; end=null means prefix-only.
*/
const LEGACY_USER_MARKERS = [
	[
		"# AGENTS.md instructions",
		"</INSTRUCTIONS>",
		"agents_md.instructions",
		false
	],
	[
		"<environment_context>",
		"</environment_context>",
		"environments.environment_context",
		true
	],
	[
		"<user_shell_command>",
		"</user_shell_command>",
		"shell.user_command",
		false
	],
	[
		"<turn_aborted>",
		"</turn_aborted>",
		"generic.turn_aborted",
		true
	],
	[
		"<subagent_notification>",
		"</subagent_notification>",
		"multi_agent.subagent_notification",
		false
	],
	[
		"<recommended_plugins>",
		"</recommended_plugins>",
		"plugins.recommendations",
		false
	],
	[
		"<skill>",
		"</skill>",
		"skills.instructions",
		false
	],
	[
		"<goal_context>",
		"</goal_context>",
		"goal.internal_context",
		true
	],
	[
		"Warning: The maximum number of unified exec processes",
		null,
		"unified_exec.legacy_process_limit_warning",
		true
	],
	[
		"Warning: apply_patch was requested via ",
		null,
		"apply_patch.legacy_exec_command_warning",
		true
	],
	[
		"Warning: Your account was flagged for potentially high-risk cyber activity",
		null,
		"guardian.warning",
		true
	]
];
/** Developer-role harness injections (case-insensitive prefixes, all synthetic). */
const LEGACY_DEVELOPER_MARKERS = [
	["<permissions instructions>", "permissions.instructions"],
	["<model_switch>", "model_switch.instructions"],
	["<managed_developer_instructions>", "managed_config.developer_instructions"],
	["<apps_instructions>", "apps.instructions"],
	["<collaboration_mode>", "collaboration_mode.instructions"],
	["<multi_agent_mode>", "multi_agent.mode_instructions"],
	["<environments_instructions>", "environments.instructions"],
	["<git_attribution>", "generic.git_attribution"],
	["<plugins_instructions>", "plugins.instructions"],
	["<realtime_conversation>", "realtime_conversation.instructions"],
	["<skills_instructions>", "skills.instructions"],
	["<tools>", "tools.instructions"],
	["<personality_spec>", "personality.spec_instructions"],
	["<token_budget>", "token_budget.instructions"],
	["<context_window_guidance>", "token_budget.context_window_guidance"],
	["<context_window>", "token_budget.context_window"],
	["<rollout_budget>", "rollout_budget.instructions"]
];
function classifyLegacyText(text) {
	const t = text.trim();
	for (const [start, end, kind, synthetic] of LEGACY_USER_MARKERS) if (t.startsWith(start) && (end === null || t.endsWith(end))) return {
		kind,
		synthetic
	};
	if (t.startsWith("<codex_internal_context")) return {
		kind: `${/<codex_internal_context\s+source="([a-z][a-z0-9_]*)">/.exec(t)?.[1] ?? "extension"}.internal_context`,
		synthetic: true
	};
	if (t.startsWith("<external_")) {
		const gt = t.indexOf(">");
		const key = gt > 0 ? t.slice(10, gt) : "";
		if (key && t.endsWith(`</external_${key}>`)) return {
			kind: `external.${key}`,
			synthetic: false
		};
	}
	const lower = t.toLowerCase();
	for (const [prefix, kind] of LEGACY_DEVELOPER_MARKERS) if (lower.startsWith(prefix)) return {
		kind,
		synthetic: true
	};
	return null;
}
/** Classify a message line as harness-injected when applicable. */
function markContentKind(msg) {
	const meta = msg.meta.codex;
	const kinds = meta.contentItemKinds;
	if (kinds?.length) {
		const first = kinds[0] ?? "unknown";
		if (isHarnessContentKind(first)) {
			meta.contentKind = first;
			if (isSyntheticContentKind(first)) msg.synthetic = true;
		}
		return;
	}
	const first = msg.content[0];
	if (!first || first.type !== "text") return;
	const hit = classifyLegacyText(first.text);
	if (!hit) return;
	meta.contentKind = hit.kind;
	if (hit.synthetic) msg.synthetic = true;
}
function outputToTextAndAttachments(output) {
	const attachments = [];
	if (typeof output === "string") return {
		text: output,
		attachments
	};
	if (Array.isArray(output)) {
		const texts = [];
		for (const item of output) if (typeof item === "object" && item !== null && item.type === "input_image") {
			const url = String(item.image_url ?? "");
			const file = {
				type: "file",
				url
			};
			const mime = /^data:([^;,]+)/.exec(url)?.[1];
			if (mime) file.mediaType = mime;
			attachments.push(file);
		} else if (typeof item === "object" && item !== null && typeof item.text === "string") texts.push(String(item.text));
		else texts.push(JSON.stringify(item) ?? String(item));
		return {
			text: texts.join("\n"),
			attachments
		};
	}
	return {
		text: safeJson(output ?? ""),
		attachments
	};
}
function iacToMessage(payload, ctx) {
	const meta = {
		itemType: "inter_agent_communication",
		ts: ctx.ts
	};
	if (ctx.ordinal !== void 0) meta.ordinal = ctx.ordinal;
	if (typeof payload.id === "string") meta.itemId = payload.id;
	meta.kind = "iac";
	meta.author = String(payload.author ?? "");
	meta.recipient = String(payload.recipient ?? "");
	if (Array.isArray(payload.other_recipients)) meta.otherRecipients = payload.other_recipients.map(String);
	if (typeof payload.trigger_turn === "boolean") meta.triggerTurn = payload.trigger_turn;
	if (payload.internal_chat_message_metadata_passthrough !== void 0) meta.passthrough = payload.internal_chat_message_metadata_passthrough;
	if (payload.encrypted_content != null) meta.encryptedDropped = true;
	return {
		role: "assistant",
		content: [{
			type: "text",
			text: String(payload.content ?? "")
		}],
		timestamp: orEpoch(ctx.ts),
		seq: ctx.ordinal ?? ctx.lineSeq,
		meta: { codex: meta }
	};
}
function compactedToEntry(payload, ctx, _messages) {
	const summary = String(payload.message ?? "");
	const rh = Array.isArray(payload.replacement_history) ? payload.replacement_history : void 0;
	const nativeMeta = { ts: ctx.ts };
	if (ctx.ordinal !== void 0) nativeMeta.ordinal = ctx.ordinal;
	for (const [src, dst] of [
		["window_number", "windowNumber"],
		["first_window_id", "firstWindowId"],
		["previous_window_id", "previousWindowId"],
		["window_id", "windowId"],
		["mcp_resource_origins", "mcpResourceOrigins"],
		["replacement_history_metadata", "replacementHistoryMetadata"]
	]) if (payload[src] !== void 0) nativeMeta[dst] = payload[src];
	const entry = { summary };
	if (rh) {
		const rhMessages = [];
		for (let i = 0; i < rh.length; i++) {
			const envelope = rh[i];
			const msg = responseItemToMessage(envelope, {
				ts: ctx.ts,
				ordinal: ctx.ordinal,
				clientAuthored: false,
				lineSeq: i,
				...ctx.scope ? { scope: ctx.scope } : {}
			}) ?? placeholderMessage(envelope, i);
			rhMessages.push(msg);
		}
		entry.replacementHistory = rhMessages;
	}
	entry.meta = { codex: nativeMeta };
	return {
		entry,
		summaryMessage: {
			role: rh ? "assistant" : "user",
			content: summary ? [{
				type: "text",
				text: summary
			}] : [],
			timestamp: orEpoch(ctx.ts),
			seq: ctx.ordinal ?? ctx.lineSeq,
			meta: { codex: {
				itemType: "compacted",
				ts: ctx.ts,
				...ctx.ordinal !== void 0 ? { ordinal: ctx.ordinal } : {},
				kind: "compaction_summary"
			} }
		}
	};
}
function placeholderMessage(payload, index) {
	return {
		role: "assistant",
		content: [{
			type: "text",
			text: JSON.stringify(payload)
		}],
		seq: index,
		meta: { codex: {
			itemType: "replacement_history_unknown",
			ts: ""
		} }
	};
}
function flushTurnBits(msg, pending) {
	if (!pending.length) return;
	const meta = msg.meta.codex;
	const turns = pending.filter((p) => p.kind === "turnContext").map((p) => p.row);
	const worlds = pending.filter((p) => p.kind === "worldState").map((p) => p.row);
	if (turns.length === 1) meta.turnContext = turns[0];
	else if (turns.length > 1) {
		meta.turnContext = turns[0];
		meta.turnContexts = turns;
	}
	if (worlds.length) meta.worldState = worlds;
	if (pending.length > 1) meta.turnRows = pending.map((p) => p.row);
	for (const p of pending) if (p.row.seq === void 0) p.row.seq = p.seq;
	pending.length = 0;
}
/** Deep-strip encrypted fields from archived payloads (v3.1: data 去加密字段). */
function stripEncrypted(value) {
	if (Array.isArray(value)) return value.map(stripEncrypted);
	if (typeof value === "object" && value !== null) {
		const out = {};
		for (const [k, v] of Object.entries(value)) if (k === "encrypted_content" || k === "encrypted_function_args") out[k] = PLACEHOLDER_ENCRYPTED$1;
		else out[k] = stripEncrypted(v);
		return out;
	}
	return value;
}
function safeJson(v) {
	try {
		const s = JSON.stringify(v);
		return s && s.length > 200 ? `${s.slice(0, 200)}…` : s ?? "";
	} catch {
		return String(v);
	}
}
/**
* Paginated continuation stitching (docs/agents/codex.md §10): a rollout whose
* session_meta.history_base points at a prefix file inherits that file's
* records — codex resume loads the chain, so a migrated session must carry it
* too or the target sees a truncated history. Records are concatenated
* chronologically (prefix first); the SUFFIX's session_meta stays the own
* identity line. Missing links / cycles degrade gracefully to single-file.
*/
async function stitchRecords(records, sourcePath, codexHome, chain, visited) {
	const ownLine = records.find((r) => r.type === "session_meta");
	const hb = ownLine?.payload?.history_base;
	const prefixRolloutId = typeof hb?.thread_id === "string" ? hb.thread_id : void 0;
	const endByteOffset = typeof hb?.end_byte_offset === "number" ? hb.end_byte_offset : void 0;
	const endOrdinalExclusive = typeof hb?.end_ordinal_exclusive === "number" ? hb.end_ordinal_exclusive : void 0;
	if (!hb || !prefixRolloutId || typeof endByteOffset !== "number" || visited.has(prefixRolloutId) || chain.length >= 32) return records;
	visited.add(prefixRolloutId);
	const prefixPath = await findRolloutById(codexHome, prefixRolloutId, sourcePath);
	if (!prefixPath || prefixPath === sourcePath) return records;
	chain.push({
		rolloutId: prefixRolloutId,
		...endOrdinalExclusive !== void 0 ? { endOrdinalExclusive } : {},
		endByteOffset,
		sourcePath: prefixPath
	});
	const stitched = await stitchRecords(recordsUpToByte(await readRolloutText(prefixPath), endByteOffset), prefixPath, codexHome, chain, visited);
	const rest = records.filter((r) => r !== ownLine);
	return [
		ownLine,
		...stitched,
		...rest
	];
}
/** Records wholly contained before a byte offset (the exact paginated cut). */
function recordsUpToByte(text, endByteOffset) {
	const out = [];
	let offset = 0;
	for (const line of text.split("\n")) {
		if (offset >= endByteOffset) break;
		offset += Buffer.byteLength(line, "utf8") + 1;
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {}
	}
	return out;
}
/** Parse one rollout file (.jsonl or .jsonl.zst) into IR. */
async function parseRolloutFile(path, codexHome) {
	let records = parseRolloutLines(await readRolloutText(path));
	const home = codexHome ?? dirname(dirname(dirname(dirname(dirname(path)))));
	const titles = await loadSessionIndexTitles(home);
	const chain = [];
	const visited = /* @__PURE__ */ new Set();
	const base = parseRolloutFileNameBasic(basename(path));
	if (base) visited.add(base.rolloutId);
	records = await stitchRecords(records, path, home, chain, visited);
	return rolloutRecordsToIr(records, {
		titles,
		sourcePath: path,
		...chain.length ? { stitchedChain: chain } : {}
	});
}
/** Resolve a session id (thread id or rollout id) to a rollout file path. */
async function findRolloutById(codexHome, sessionId, exclude) {
	const candidates = [];
	await scanForId(codexHome, sessionId, candidates, exclude);
	await scanForId(join(codexHome, "archived_sessions"), sessionId, candidates, exclude);
	if (!candidates.length) return null;
	candidates.sort((a, b) => a.kind === b.kind ? b.mtime - a.mtime : a.kind === "rollout" ? -1 : 1);
	return candidates[0].path;
}
async function scanForId(dir, sessionId, out, exclude) {
	let entries;
	try {
		entries = await promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) await scanForId(full, sessionId, out, exclude);
		else if (full !== exclude && e.isFile() && e.name.startsWith("rollout-") && (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zst"))) {
			const parsed = parseRolloutFileNameBasic(e.name);
			if (!parsed) continue;
			const kind = parsed.rolloutId === sessionId && parsed.threadId !== sessionId ? "rollout" : "thread";
			if (parsed.threadId !== sessionId && parsed.rolloutId !== sessionId) continue;
			const st = await promises.stat(full).catch(() => null);
			out.push({
				path: full,
				mtime: st?.mtimeMs ?? 0,
				kind
			});
		}
	}
}
function parseRolloutFileNameBasic(name) {
	const stripped = name.endsWith(".zst") ? name.slice(0, -4) : name;
	if (!stripped.startsWith("rollout-") || !stripped.endsWith(".jsonl")) return null;
	const body = stripped.slice(8, -6);
	if (body.length < 21 || body[19] !== "-") return null;
	const ids = body.slice(20);
	const under = ids.indexOf("_");
	return under >= 0 ? {
		threadId: ids.slice(0, under),
		rolloutId: ids.slice(under + 1)
	} : {
		threadId: ids,
		rolloutId: ids
	};
}
//#endregion
//#region ../core/dist/src/adapters/codex/write.js
/**
* Codex rollout WRITE side — IR → `sessions/YYYY/MM/DD/rollout-*.jsonl` (docs/agents/codex.md §9).
*
* Codex-native IR (meta.codex present) is reconstructed field-for-field: native
* payloads ride back verbatim, messages map back to their exact response_item
* variants via meta.codex.itemType, turn_context/world_state rows re-emit
* ahead of their turn's first message, compaction[] rebuilds the `compacted`
* record (summary + replacement_history + window fields), and
* unmappedEvents replay as event_msg / archived rollout rows in original
* order (seq = source line number).
*
* Foreign IR (other tools) gets the §9 minimal synthesis: fresh session_meta,
* blocks → response_items, compaction bucket → native `compacted` records
* (replacement_history synthesized from post-anchor messages when the source
* didn't preserve one). System-prompt choice per docs/agents/codex.md §7.2:
* `systemPromptSource: 'source'` (default) writes ir.systemPrompt into
* base_instructions {provenance: custom}; `'target'` writes none.
*
* Mode: write side always produces LEGACY-mode files (no ordinals) unless the
* source session itself was paginated — then original ordinals (msg.seq /
* meta.ordinal / unmapped.seq) are re-emitted so positional fields stay valid.
*
* Iron rule (AGENT.md): only NEW files are written; callers must not point
* this at an existing session path (the adapter picks a fresh id on conflict).
*/
const PLACEHOLDER_ENCRYPTED = "[encrypted_content omitted by cc-migrate]";
/** §9.2: cli_version carries the target-adapter identity for synthesized metas. */
const ADAPTER_CLI_VERSION = "cc-migrate-1.0.0";
const ADAPTER_ORIGINATOR = "cc-migrate";
/** ms-precision RFC3339 Z — the recorder's exact timestamp format. */
function rolloutTimestamp(ms) {
	const d = new Date(ms);
	const p2 = (n) => String(n).padStart(2, "0");
	const p3 = (n) => String(n).padStart(3, "0");
	return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${p3(d.getUTCMilliseconds())}Z`;
}
function line(timestamp, ordinal, type, payload, metadata) {
	const out = {
		timestamp,
		type,
		payload
	};
	if (ordinal !== void 0) out.ordinal = ordinal;
	if (metadata !== void 0) out.metadata = metadata;
	return out;
}
function buildRolloutLines(ir, threadId, targetCwd, createdAt, opts) {
	const sessionCodex = ir.meta?.codex;
	const ownRow = sessionCodex?.sessionMetaLine;
	const inheritedRows = sessionCodex?.inheritedMetaLines ?? [];
	const paginated = isPaginated(ir, ownRow);
	const lines = [];
	lines.push(line(rolloutTimestamp(createdAt), paginated ? ownRow?.ordinal ?? 0 : void 0, "session_meta", buildSessionMetaPayload(ir, threadId, targetCwd, createdAt, opts)));
	for (const row of inheritedRows) lines.push(line(row.ts, paginated ? row.ordinal : void 0, "session_meta", row.payload));
	const compactions = ir.compaction ?? [];
	const anchored = /* @__PURE__ */ new Map();
	const preamble = [];
	for (const entry of compactions) if (typeof entry.anchorIndex === "number") anchored.set(entry.anchorIndex, entry);
	else preamble.push(entry);
	for (const entry of preamble) lines.push(line(rolloutTimestamp(createdAt), void 0, "compacted", compactedPayload(entry, ir)));
	const emitters = [];
	ir.messages.forEach((msg, index) => {
		const key = typeof msg.seq === "number" ? msg.seq : Number.MAX_SAFE_INTEGER - ir.messages.length + index;
		const meta = msg.meta?.codex;
		const inlineRows = [];
		for (const row of takeTurnBits(meta)) if (typeof row.seq === "number") emitters.push({
			key: row.seq,
			order: index,
			kind: "turnRow",
			row
		});
		else inlineRows.push(row);
		emitters.push({
			key,
			order: index,
			kind: "message",
			msg,
			index,
			inlineRows
		});
	});
	if (sessionCodex) for (const [i, ev] of (ir.unmappedEvents ?? []).entries()) emitters.push({
		key: typeof ev.seq === "number" ? ev.seq : Number.MAX_SAFE_INTEGER + i,
		order: i,
		kind: "event",
		ev
	});
	emitters.sort((a, b) => a.key - b.key || a.order - b.order);
	let turnSeq = 0;
	let openTurnId;
	let lastAssistantText;
	let lastTsMs = createdAt;
	for (const em of emitters) {
		if (em.kind === "event") {
			emitUnmapped(lines, em.ev, paginated, Number.isFinite(em.ev.time) ? em.ev.time : lastTsMs);
			continue;
		}
		if (em.kind === "turnRow") {
			emitNativeRow(lines, em.row, paginated);
			continue;
		}
		const msg = em.msg;
		msg.meta?.codex;
		const entry = anchored.get(em.index);
		if (entry) {
			for (const row of em.inlineRows) emitNativeRow(lines, row, paginated);
			const nativeTs = entry.meta?.codex ? entry.meta.codex.ts : void 0;
			lines.push(line(typeof nativeTs === "string" && nativeTs ? nativeTs : rolloutTimestamp(createdAt), paginated ? messageOrdinal(msg) : void 0, "compacted", compactedPayload(entry, ir)));
			continue;
		}
		if (msg.synthetic && !opts.keepSynthetic) continue;
		if (!sessionCodex && isTurnBoundaryUser(msg)) {
			if (openTurnId) lines.push(taskCompleteLine(msg.timestamp ?? createdAt, openTurnId, lastAssistantText));
			openTurnId = syntheticTurnId(msg.timestamp ?? createdAt, ++turnSeq);
			lines.push(taskStartedLine(msg.timestamp ?? createdAt, openTurnId));
		}
		if (msg.role === "assistant") {
			const text = textOfBlocks(msg.content);
			if (text) lastAssistantText = text;
		}
		for (const row of em.inlineRows) emitNativeRow(lines, row, paginated);
		for (const item of messageToResponseItems(msg, ir, createdAt)) {
			lines.push(item);
			const em = Number.isFinite(msg.timestamp) ? msg.timestamp : createdAt;
			if (em > lastTsMs) lastTsMs = em;
		}
	}
	if (!sessionCodex && openTurnId) lines.push(taskCompleteLine(createdAt, openTurnId, lastAssistantText));
	if (paginated && (sessionCodex?.historyChain?.length ?? 0) > 0) lines.forEach((l, i) => {
		l.ordinal = i;
	});
	return lines.map((l) => JSON.stringify(l));
}
function isPaginated(ir, ownRow) {
	return (ownRow?.payload)?.history_mode === "paginated";
}
function messageOrdinal(msg) {
	return (msg.meta?.codex)?.ordinal ?? (typeof msg.seq === "number" ? msg.seq : void 0);
}
function takeTurnBits(meta) {
	if (!meta) return [];
	if (meta.turnRows?.length) return meta.turnRows;
	return [...meta.turnContexts ?? (meta.turnContext ? [meta.turnContext] : []), ...meta.worldState ?? []];
}
function emitNativeRow(lines, row, paginated) {
	lines.push(line(row.ts, paginated ? row.ordinal : void 0, row.kind ?? "world_state", row.payload));
}
function buildSessionMetaPayload(ir, threadId, targetCwd, createdAt, opts) {
	const sessionCodex = ir.meta?.codex;
	const ownRow = sessionCodex?.sessionMetaLine;
	const wantSystemPrompt = (opts.systemPromptSource ?? "source") === "source" && typeof ir.systemPrompt === "string" && ir.systemPrompt.length > 0;
	if (ownRow && typeof ownRow.payload === "object" && ownRow.payload !== null) {
		const payload = { ...ownRow.payload };
		payload.id = threadId;
		payload.session_id = threadId;
		payload.cwd = targetCwd;
		payload.timestamp = rolloutTimestamp(createdAt);
		const sourcePayload = ownRow.payload;
		if ("history_mode" in sourcePayload) payload.history_mode = sourcePayload.history_mode;
		if (sessionCodex?.historyChain && "history_base" in payload) delete payload.history_base;
		if ((opts.systemPromptSource ?? "source") === "target") delete payload.base_instructions;
		else if (!payload.base_instructions && wantSystemPrompt) payload.base_instructions = {
			text: ir.systemPrompt,
			provenance: { type: "custom" }
		};
		return payload;
	}
	const payload = {
		session_id: threadId,
		id: threadId,
		timestamp: rolloutTimestamp(createdAt),
		cwd: targetCwd,
		originator: ADAPTER_ORIGINATOR,
		cli_version: ADAPTER_CLI_VERSION,
		source: "cli",
		history_mode: "legacy"
	};
	if (opts.parentThreadId) {
		payload.source = { subagent: { thread_spawn: {
			parent_thread_id: opts.parentThreadId,
			depth: opts.subagentDepth ?? 1
		} } };
		payload.thread_source = "subagent";
		if (opts.agentNickname) payload.agent_nickname = opts.agentNickname;
	}
	if (ir.model?.id) payload.model_provider = ir.model.id;
	if (wantSystemPrompt) payload.base_instructions = {
		text: ir.systemPrompt,
		provenance: { type: "custom" }
	};
	return payload;
}
function compactedPayload(entry, ir) {
	const native = entry.meta?.codex;
	const payload = { message: entry.summary };
	let replacementHistory = entry.replacementHistory;
	if (!replacementHistory && typeof entry.anchorIndex === "number" && !native) replacementHistory = ir.messages.slice(entry.anchorIndex + 1);
	if (replacementHistory) {
		payload.replacement_history = replacementHistory.map((m) => messageToSingleResponseItem(m, ir));
		const stored = native?.replacementHistoryMetadata;
		const derived = replacementHistory.some((m) => m.meta?.codex ? m.meta.codex.clientAuthored === true : false);
		if (stored !== void 0) payload.replacement_history_metadata = stored;
		else if (derived) payload.replacement_history_metadata = replacementHistory.map((m) => {
			return (m.meta?.codex)?.clientAuthored ? { client_authored: true } : {};
		});
	}
	if (native?.mcpResourceOrigins !== void 0) payload.mcp_resource_origins = native.mcpResourceOrigins;
	if (native?.windowNumber !== void 0) payload.window_number = native.windowNumber;
	if (native?.firstWindowId !== void 0) payload.first_window_id = native.firstWindowId;
	if (native?.previousWindowId !== void 0) payload.previous_window_id = native.previousWindowId;
	if (native?.windowId !== void 0) payload.window_id = native.windowId;
	return payload;
}
function messageToResponseItems(msg, ir, createdAt) {
	const meta = msg.meta?.codex;
	const ts = meta?.ts || rolloutTimestamp(msg.timestamp ?? createdAt);
	const ordinal = meta?.ordinal;
	if (meta?.kind === "iac") {
		const payload = {};
		if (meta.itemId) payload.id = meta.itemId;
		payload.author = meta.author ?? "";
		payload.recipient = meta.recipient ?? "";
		payload.other_recipients = meta.otherRecipients ?? [];
		payload.content = textOfBlocks(msg.content);
		if (meta.passthrough !== void 0) payload.internal_chat_message_metadata_passthrough = meta.passthrough;
		payload.encrypted_content = meta.encryptedDropped ? PLACEHOLDER_ENCRYPTED : null;
		payload.trigger_turn = meta.triggerTurn ?? false;
		return [line(ts, ordinal, "inter_agent_communication", payload)];
	}
	if (meta?.kind === "compaction_summary" && meta.itemType === "compacted") {}
	const envelopeMetadata = meta?.clientAuthored ? { client_authored: true } : void 0;
	if (meta && meta.itemType !== "compacted") {
		const payload = nativeResponseItemPayload(msg, meta, ir, createdAt);
		if (payload) return [line(ts, ordinal, "response_item", payload, envelopeMetadata)];
	}
	const items = [];
	for (const payload of foreignBlocksToPayloads(msg, ir, createdAt)) items.push(line(ts, ordinal, "response_item", payload, envelopeMetadata));
	if (!items.length) items.push(line(ts, ordinal, "response_item", {
		type: "message",
		role: irRoleToNative(msg.role),
		content: [{
			type: irRoleToNative(msg.role) === "assistant" ? "output_text" : "input_text",
			text: ""
		}]
	}, envelopeMetadata));
	return items;
}
function irRoleToNative(role) {
	return role === "tool" ? "user" : role;
}
function passthroughOf(meta) {
	return meta.passthrough === void 0 ? void 0 : { internal_chat_message_metadata_passthrough: meta.passthrough };
}
/** Native reconstruction via meta.codex (returns null when impossible). */
function nativeResponseItemPayload(msg, meta, ir, createdAt) {
	rolloutTimestamp(msg.timestamp ?? createdAt);
	switch (meta.itemType) {
		case "message": {
			const role = meta.role ?? irRoleToNative(msg.role);
			const payload = { type: "message" };
			if (meta.itemId) payload.id = meta.itemId;
			payload.role = role;
			payload.content = blocksToMessageContent(msg.content, role, meta);
			if (meta.phase !== void 0) payload.phase = meta.phase;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "reasoning": {
			const blocks = msg.content.filter((b) => b.type === "thinking");
			const summaryCount = meta.reasoningSummaryCount ?? blocks.length;
			const entryTypes = meta.reasoningEntryTypes ?? blocks.map(() => "summary_text");
			const payload = { type: "reasoning" };
			if (meta.itemId) payload.id = meta.itemId;
			payload.summary = blocks.slice(0, summaryCount).map((b) => ({
				type: "summary_text",
				text: b.thinking
			}));
			const contentEntries = blocks.slice(summaryCount).map((b, i) => ({
				type: entryTypes[summaryCount + i] ?? "reasoning_text",
				text: b.thinking
			}));
			if (contentEntries.length) payload.content = contentEntries;
			else if (meta.reasoningContentNull) payload.content = null;
			payload.encrypted_content = meta.encryptedDropped ? PLACEHOLDER_ENCRYPTED : null;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "function_call": {
			const block = msg.content.find((b) => b.type === "tool_use");
			if (!block) return null;
			const payload = { type: "function_call" };
			if (meta.itemId) payload.id = meta.itemId;
			payload.name = block.name;
			if (meta.namespace !== void 0) payload.namespace = meta.namespace;
			payload.arguments = meta.argumentsRaw !== void 0 ? meta.argumentsRaw : stableStringify(block.input);
			payload.call_id = block.id;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "custom_tool_call": {
			const block = msg.content.find((b) => b.type === "tool_use");
			if (!block) return null;
			const payload = { type: "custom_tool_call" };
			if (meta.itemId) payload.id = meta.itemId;
			if (meta.status !== void 0) payload.status = meta.status;
			payload.call_id = block.id;
			payload.name = block.name;
			if (meta.namespace !== void 0) payload.namespace = meta.namespace;
			payload.input = typeof block.input === "string" ? block.input : stableStringify(block.input);
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "function_call_output":
		case "custom_tool_call_output": {
			const block = msg.content.find((b) => b.type === "tool_result");
			if (!block) return null;
			const payload = { type: meta.itemType };
			if (meta.itemId) payload.id = meta.itemId;
			if (typeof meta.callId === "string") payload.call_id = meta.callId;
			if (meta.name !== void 0) payload.name = meta.name;
			if (meta.itemType === "function_call_output" && meta.namespace !== void 0) payload.namespace = meta.namespace;
			payload.output = meta.outputRaw !== void 0 ? meta.outputRaw : blockToOutputPayload(block);
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "local_shell_call": {
			const block = msg.content.find((b) => b.type === "tool_use");
			if (!block) return null;
			const payload = { type: "local_shell_call" };
			if (meta.itemId) payload.id = meta.itemId;
			if (meta.callId !== void 0) payload.call_id = meta.callId;
			payload.status = meta.status ?? "completed";
			payload.action = block.input;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "tool_search_call": {
			const block = msg.content.find((b) => b.type === "tool_use");
			if (!block) return null;
			const payload = { type: "tool_search_call" };
			if (meta.itemId) payload.id = meta.itemId;
			if (typeof meta.callId === "string") payload.call_id = meta.callId;
			if (meta.status !== void 0) payload.status = meta.status;
			payload.execution = meta.execution ?? "";
			payload.arguments = block.input;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "tool_search_output": {
			const block = msg.content.find((b) => b.type === "tool_result");
			if (!block) return null;
			const payload = { type: "tool_search_output" };
			if (meta.itemId) payload.id = meta.itemId;
			if (meta.callId !== void 0) payload.call_id = meta.callId;
			payload.status = meta.status ?? "completed";
			payload.execution = meta.execution ?? "";
			payload.tools = safeParse(block.content, []);
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "web_search_call": {
			const block = msg.content.find((b) => b.type === "tool_use");
			if (!block) return null;
			const payload = { type: "web_search_call" };
			if (meta.itemId) payload.id = meta.itemId;
			if (meta.status !== void 0) payload.status = meta.status;
			if (block.input && Object.keys(block.input).length) payload.action = block.input;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "image_generation_call": {
			const useBlock = msg.content.find((b) => b.type === "tool_use");
			const resultBlock = msg.content.find((b) => b.type === "tool_result");
			if (!useBlock || !resultBlock) return null;
			const data = resultBlock.attachments?.[0]?.data;
			const payload = { type: "image_generation_call" };
			if (meta.itemId) payload.id = meta.itemId;
			payload.status = meta.status ?? "completed";
			if (meta.revisedPrompt !== void 0) payload.revised_prompt = meta.revisedPrompt;
			payload.result = data ?? PLACEHOLDER_ENCRYPTED;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "compaction":
		case "context_compaction": {
			const payload = { type: meta.itemType };
			if (meta.itemId) payload.id = meta.itemId;
			if (meta.itemType === "compaction" || meta.encryptedDropped) payload.encrypted_content = PLACEHOLDER_ENCRYPTED;
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		case "agent_message": {
			const payload = { type: "agent_message" };
			if (meta.itemId) payload.id = meta.itemId;
			payload.author = meta.author ?? "";
			payload.recipient = meta.recipient ?? "";
			payload.content = meta.contentRaw ?? msg.content.filter((b) => b.type === "text").map((b) => ({
				type: "input_text",
				text: b.text
			}));
			const pt = passthroughOf(meta);
			if (pt) Object.assign(payload, pt);
			return payload;
		}
		default: return null;
	}
}
function blocksToMessageContent(blocks, role, meta) {
	const textKind = role === "assistant" ? "output_text" : "input_text";
	const out = [];
	blocks.forEach((b, i) => {
		if (b.type === "text") out.push({
			type: textKind,
			text: b.text
		});
		else if (b.type === "file") {
			if (meta.audioBlocks?.includes(i)) out.push({
				type: "input_audio",
				audio_url: b.url ?? ""
			});
			else {
				const item = {
					type: "input_image",
					image_url: b.url ?? ""
				};
				const detail = meta.imageDetails?.[i];
				if (detail) item.detail = detail;
				out.push(item);
			}
		}
	});
	return out;
}
function blockToOutputPayload(block) {
	if (block.attachments?.length) {
		const items = [];
		if (block.content) items.push({
			type: "input_text",
			text: block.content
		});
		for (const f of block.attachments) if (f.mediaType?.startsWith("audio/")) items.push({
			type: "input_audio",
			audio_url: f.data ? dataUrl(f) : f.url ?? ""
		});
		else items.push({
			type: "input_image",
			image_url: f.data ? dataUrl(f) : f.url ?? ""
		});
		return items;
	}
	return block.content;
}
function dataUrl(f) {
	return `data:${f.mediaType ?? "application/octet-stream"};base64,${f.data}`;
}
/** Foreign (no meta.codex) message → codex-shaped payloads, one per block. */
function foreignBlocksToPayloads(msg, ir, createdAt) {
	const out = [];
	const role = irRoleToNative(msg.role);
	const textParts = [];
	const flushText = () => {
		if (textParts.length) out.push({
			type: "message",
			role,
			content: textParts.splice(0)
		});
	};
	for (const block of msg.content) switch (block.type) {
		case "text":
			textParts.push({
				type: role === "assistant" ? "output_text" : "input_text",
				text: block.text
			});
			break;
		case "file":
			textParts.push(block.type === "file" && block.mediaType?.startsWith("audio/") ? {
				type: "input_audio",
				audio_url: block.data ? dataUrl(block) : block.url ?? ""
			} : {
				type: "input_image",
				image_url: block.data ? dataUrl(block) : block.url ?? ""
			});
			break;
		case "tool_use":
			flushText();
			out.push({
				type: "function_call",
				name: block.name,
				arguments: typeof block.input === "string" ? block.input : stableStringify(block.input),
				call_id: block.id
			});
			break;
		case "tool_result": {
			flushText();
			const payload = { type: "function_call_output" };
			if (block.toolUseId) payload.call_id = block.toolUseId;
			payload.output = blockToOutputPayload(block);
			out.push(payload);
			break;
		}
		case "thinking":
			flushText();
			out.push({
				type: "reasoning",
				summary: [{
					type: "summary_text",
					text: block.thinking
				}],
				encrypted_content: null
			});
	}
	flushText();
	return out;
}
/** Single-response-item projection used for replacement_history entries. */
function messageToSingleResponseItem(msg, ir) {
	const meta = msg.meta?.codex;
	if (meta && meta.itemType !== "compacted") {
		const payload = nativeResponseItemPayload(msg, meta, ir, 0);
		if (payload) return payload;
	}
	return foreignBlocksToPayloads(msg, ir, 0)[0] ?? {
		type: "message",
		role: "assistant",
		content: []
	};
}
/**
* A real user prompt opens a codex turn. Same rule as titleFromMessages
* (parse.ts): user role, not synthetic, no harness contentKind markers —
* dsh/claude/zcode injected rows must not fragment the turn stream.
*/
function isTurnBoundaryUser(msg) {
	if (msg.role !== "user" || msg.synthetic) return false;
	const codex = msg.meta?.codex;
	if (codex?.contentKind || codex?.kind) return false;
	return msg.content.some((b) => b.type === "text" && b.text.trim());
}
/**
* task_started / task_complete event_msg rows shaped like the official
* external-agent-migration importer's (session_importer.rs:457-497) — field
* set verified against real rollouts on this machine (both spellings
* task_started/task_complete are the wire aliases codex persists, §5).
* turn_id is a fresh uuid per synthesized turn; timestamps derive from the
* source messages, never fabricated wall-clock "now"s mid-history.
*/
function taskStartedLine(atMs, turnId) {
	return line(rolloutTimestamp(atMs), void 0, "event_msg", {
		type: "task_started",
		turn_id: turnId,
		started_at: Math.floor(atMs / 1e3),
		collaboration_mode_kind: "default"
	});
}
function taskCompleteLine(atMs, turnId, lastAssistantText) {
	const payload = {
		type: "task_complete",
		turn_id: turnId
	};
	if (lastAssistantText) payload.last_agent_message = lastAssistantText;
	return line(rolloutTimestamp(atMs), void 0, "event_msg", payload);
}
/**
* Deterministic uuid-shaped turn id derived from the session timestamp + the
* N-th synthesized turn (real events use uuidv7s; the seed keeps re-writes of
* the same IR reproducible and can never collide with a source uuidv7 space).
*/
function syntheticTurnId(atMs, turnSeq) {
	return `${`${(atMs >>> 0).toString(16).padStart(8, "0")}${(turnSeq * 2654435761 >>> 0).toString(16).padStart(8, "0")}`}-0000-4000-8000-${(turnSeq >>> 0).toString(16).padStart(12, "0")}`;
}
function emitUnmapped(lines, ev, paginated, fallbackMs) {
	const ts = Number.isFinite(ev.time) ? rolloutTimestamp(ev.time) : rolloutTimestamp(fallbackMs);
	const ordinal = paginated ? ev.seq : void 0;
	const data = ev.data;
	const rawLine = data?.codexRolloutLine;
	if (rawLine && typeof rawLine === "object") {
		lines.push(line(rawLine.timestamp ?? ts, paginated ? rawLine.ordinal ?? ev.seq : void 0, rawLine.type ?? ev.type, rawLine.payload, rawLine.metadata));
		return;
	}
	const orphanBit = data?.codexOrphanTurnBit;
	if (orphanBit && typeof orphanBit === "object") {
		lines.push(line(orphanBit.ts || ts, paginated ? orphanBit.ordinal : void 0, orphanBit.kind ?? ev.type, orphanBit.payload));
		return;
	}
	const respItem = data?.codexResponseItem;
	if (respItem && typeof respItem === "object") {
		const clientAuthored = data?.clientAuthored === true;
		lines.push(line(ts, ordinal, "response_item", respItem, clientAuthored ? { client_authored: true } : void 0));
		return;
	}
	if (ROLLOUT_RECORD_TAGS.has(ev.type)) {
		lines.push(line(ts, ordinal, ev.type, data));
		return;
	}
	const innerType = data?.type;
	if (typeof innerType === "string" && PERSISTED_EVENT_MSG_TYPES.has(innerType)) lines.push(line(ts, ordinal, "event_msg", data));
}
/**
* EventMsg variants codex persists (docs/agents/codex.md §5, policy.rs:90-135).
* Includes both wire spellings of the turn aliases and the legacy-mode-only
* set; anything else (retired / foreign / transient) is not written back.
*/
const PERSISTED_EVENT_MSG_TYPES = /* @__PURE__ */ new Set([
	"item_completed",
	"token_count",
	"thread_goal_updated",
	"thread_rolled_back",
	"turn_aborted",
	"turn_started",
	"task_started",
	"turn_complete",
	"task_complete",
	"thread_settings_applied",
	"user_message",
	"agent_message",
	"agent_reasoning",
	"agent_reasoning_raw",
	"entered_review_mode",
	"exited_review_mode",
	"patch_apply_end",
	"context_compacted",
	"mcp_tool_call_end",
	"web_search_end",
	"image_generation_end",
	"sub_agent_activity"
]);
const ROLLOUT_RECORD_TAGS = /* @__PURE__ */ new Set([
	"security_risk_score",
	"realtime_item",
	"inter_agent_communication_metadata",
	"turn_context",
	"world_state",
	"response_item"
]);
function textOfBlocks(blocks) {
	return blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function safeParse(s, fallback) {
	try {
		return JSON.parse(s);
	} catch {
		return fallback;
	}
}
/** JSON.stringify with a stable guard (undefined → ''). */
function stableStringify(v) {
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v) ?? "";
	} catch {
		return String(v);
	}
}
/**
* Title for the session_index append row (docs/agents/codex.md §9.7):
* `ir.title` → native sessionIndex.thread_name → first real user prompt
* (60-char cut). Undefined when the session has NO name codex would ever have
* recorded — codex only appends an index row when it actually learned a title,
* so a migrated '(untitled)' placeholder would be a row codex itself never
* writes; the caller must skip the append in that case.
*/
function sessionIndexTitle(ir) {
	if (ir.title) return ir.title;
	const nativeIndex = ir.meta?.codex?.sessionIndex;
	if (typeof nativeIndex?.thread_name === "string" && nativeIndex.thread_name.trim()) return nativeIndex.thread_name;
	return titleFromMessages(ir.messages);
}
//#endregion
//#region ../core/dist/src/adapters/codex/index.js
/**
* Codex adapter — reads/writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`
* + `archived_sessions/` + append-only `session_index.jsonl`.
*
* 100%-lossless per docs/agents/codex.md (v3 deep-dive, codex-rs 0.146 tree):
* all 11 rollout record types map to typed IR slots; the only legal drops are
* `encrypted_content` / `encrypted_function_args` (placeholder-flagged).
* Mapping tables: docs/agents/codex.md §8 (read) / §9 (write); IR slots
* registered in docs/ir-protocol.md §v3.1.
*
* Iron rule (AGENT.md): this adapter only ever CREATES new files. It never
* rewrites, truncates or deletes existing sessions; session_index.jsonl is
* append-only (one line per write).
*/
var CodexAdapter = class {
	tool = "codex";
	irVersion = "3.3";
	async parse(sessionId, root) {
		const codexHome = root ?? defaultCodexHome();
		if (!codexHome) throw new Error("Codex: cannot resolve CODEX_HOME/.codex");
		const path = await findRolloutById(codexHome, sessionId);
		if (!path) throw new Error(`Codex: session "${sessionId}" not found under ${codexHome}`);
		const ir = await parseRolloutFile(path, codexHome);
		const stitched = await loadSubagentTree(sessionId, ir, await subagentChildIndex(codexHome), /* @__PURE__ */ new Set([sessionId]));
		if (stitched.length) ir.sidechains = stitched;
		return validateSession(ir);
	}
	async write(ir, opts) {
		validateSession(ir);
		const codexHome = opts?.root ?? defaultCodexHome();
		if (!codexHome) throw new Error("Codex: cannot resolve CODEX_HOME/.codex");
		const targetCwd = opts?.targetCwd ?? ir.cwd ?? "";
		const createdAt = ir.createdAt ?? Date.now();
		const wopts = {
			targetCwd,
			createdAt,
			threadId: "",
			systemPromptSource: opts?.systemPromptSource,
			keepSynthetic: opts?.keepSynthetic
		};
		const main = await writeRolloutFile(ir, codexHome, wopts, targetCwd, createdAt, opts?.sessionId);
		await appendSessionIndex(codexHome, main.threadId, sessionIndexTitle(ir));
		const paths = [main.path];
		for (const sc of ir.sidechains ?? []) paths.push(...await writeSidechainTree(sc, ir, codexHome, wopts, targetCwd, main.threadId, 1));
		return {
			tool: "codex",
			sessionId: main.threadId,
			paths
		};
	}
	async listSessions(root) {
		const codexHome = root ?? defaultCodexHome();
		if (!codexHome) return [];
		const files = /* @__PURE__ */ new Map();
		await walkRollouts(codexHome, files, false);
		await walkRollouts(archivedDir(codexHome), files, true);
		const titles = await loadSessionIndexTitles(codexHome);
		const items = [];
		for (const [threadId, f] of files) {
			const head = await scanRolloutHead(f.path);
			const indexTitle = titles.get(threadId);
			items.push({
				tool: "codex",
				sessionId: threadId,
				...indexTitle ? { title: indexTitle } : head.title ? { title: head.title } : {},
				...head.cwd ? { cwd: head.cwd } : {},
				createdAt: f.createdAt ?? (f.mtime || void 0),
				sourcePath: f.path,
				...f.archived ? { archived: true } : {},
				...head.parentThreadId ? { parentSessionId: head.parentThreadId } : {}
			});
		}
		for (const [threadId, title] of titles) {
			if (files.has(threadId)) continue;
			items.push({
				tool: "codex",
				sessionId: threadId,
				...title ? { title } : {},
				deferredCreation: true
			});
		}
		items.sort((a, b) => (a.deferredCreation ? Number.MAX_SAFE_INTEGER : a.createdAt ?? 0) - (b.deferredCreation ? Number.MAX_SAFE_INTEGER : b.createdAt ?? 0));
		return items;
	}
	preview(session) {
		const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join("\n\n");
		if (!session.sidechains?.length) return main;
		return `${main}\n\n${session.sidechains.map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join("\n")}`).join("\n\n")}`;
	}
};
async function appendSessionIndex(codexHome, threadId, threadName) {
	if (!threadName) return;
	const entry = {
		id: threadId,
		thread_name: threadName,
		updated_at: (/* @__PURE__ */ new Date()).toISOString()
	};
	await promises.appendFile(sessionIndexPath(codexHome), JSON.stringify(entry) + "\n", "utf8");
}
/**
* Write one rollout file with collision-safe id selection (AGENT.md): a fresh
* uuidv7 per file; when the rendered path already exists, re-roll the id —
* never overwrite or append to an existing session.
*/
async function writeRolloutFile(ir, codexHome, wopts, targetCwd, createdAt, requestedId) {
	let threadId = requestedId ?? uuidv7();
	let finalPath = codexSessionPathFor(codexHome, threadId, createdAt);
	for (let attempt = 0; attempt < 8; attempt++) {
		if (!await promises.stat(finalPath).then(() => true).catch(() => false)) break;
		if (attempt === 7) throw new Error(`Codex: cannot find a free rollout path for thread ${threadId}`);
		threadId = uuidv7();
		finalPath = codexSessionPathFor(codexHome, threadId, createdAt);
	}
	wopts.threadId = threadId;
	wopts.createdAt = createdAt;
	const lines = buildRolloutLines(ir, threadId, targetCwd, createdAt, wopts);
	await promises.mkdir(dirname(finalPath), { recursive: true });
	await promises.writeFile(finalPath, lines.join("\n") + "\n", "utf8");
	return {
		threadId,
		path: finalPath
	};
}
/**
* Sidechains → independent child rollout files, recursively (grandchildren
* link to their own parent). Children are mini-sessions (MigratedSidechain):
* foreign-shaped messages ride the ordinary write projection; each gets its
* own thread id and its own session_index line (append-only, one per file).
*/
async function writeSidechainTree(sc, parentIr, codexHome, wopts, targetCwd, parentThreadId, depth) {
	const child = {
		schemaVersion: 2,
		originTool: parentIr.originTool,
		originSessionId: sc.originSessionId ?? sc.agentId,
		...sc.title ? { title: sc.title } : {},
		createdAt: sc.createdAt ?? parentIr.createdAt ?? Date.now(),
		...sc.cwd ?? parentIr.cwd ? { cwd: sc.cwd ?? parentIr.cwd } : {},
		messages: sc.messages,
		...sc.compaction?.length ? { compaction: sc.compaction } : {},
		...sc.toolCalls?.length ? { toolCalls: sc.toolCalls } : {},
		...sc.unmappedEvents?.length ? { unmappedEvents: sc.unmappedEvents } : {},
		...sc.meta ? { meta: sc.meta } : {}
	};
	const { threadId, path } = await writeRolloutFile(child, codexHome, {
		...wopts,
		parentThreadId,
		subagentDepth: depth,
		agentNickname: sc.agentType
	}, targetCwd, child.createdAt ?? Date.now());
	await appendSessionIndex(codexHome, threadId, sessionIndexTitle(child));
	const out = [path];
	for (const kid of sc.sidechains ?? []) out.push(...await writeSidechainTree(kid, parentIr, codexHome, wopts, targetCwd, threadId, depth + 1));
	return out;
}
/** Preview/migrate click arounds re-parse the same home — brief TTL cache. */
const SUBAGENT_INDEX_TTL_MS = 5e3;
const subagentIndexCache = /* @__PURE__ */ new Map();
/**
* parent thread id → subagent child rollouts, by first-line meta scan of every
* rollout in the home (session_meta is record #1, so this is cheap). Result is
* a snapshot: sessions written while the TTL entry lives appear on the next
* rebuild — fine for preview, and migrate re-checks nothing older than 5s.
*/
async function subagentChildIndex(codexHome) {
	const hit = subagentIndexCache.get(codexHome);
	if (hit && Date.now() - hit.at < SUBAGENT_INDEX_TTL_MS) return hit.byParent;
	const files = /* @__PURE__ */ new Map();
	await walkRollouts(codexHome, files, false);
	await walkRollouts(archivedDir(codexHome), files, true);
	const byParent = /* @__PURE__ */ new Map();
	for (const [threadId, f] of files) {
		const meta = await scanRolloutMeta(f.path);
		if (!meta.parentThreadId || meta.parentThreadId === threadId) continue;
		const list = byParent.get(meta.parentThreadId) ?? [];
		list.push({
			threadId,
			path: f.path,
			agentNickname: meta.agentNickname,
			agentRole: meta.agentRole,
			agentPath: meta.agentPath,
			ts: f.createdAt ?? void 0
		});
		byParent.set(meta.parentThreadId, list);
	}
	for (const list of byParent.values()) list.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
	subagentIndexCache.set(codexHome, {
		at: Date.now(),
		byParent
	});
	return byParent;
}
/**
* Summon-point linkage: codex parents record `spawn_agent` function calls whose
* `task_name` equals the child's agent_path tail (e.g. agent_path
* `/root/realtime_preemptive_slice/preemptive_review` ← task_name
* `preemptive_review`). Resolving it to the call id lets the GUI anchor the
* subagent to its summoning tool row.
*/
function spawnCallIdForChild(parentIr, agentPath) {
	const tail = agentPath?.split("/").filter(Boolean).pop();
	if (!tail) return void 0;
	for (const m of parentIr.messages) for (const b of m.content) {
		if (b.type !== "tool_use" || b.name !== "spawn_agent" || !b.id) continue;
		if (b.input?.task_name === tail) return b.id;
	}
}
/** Parse one parent's subagent subtree into MigratedSidechain[] (visited-set cycle guard). */
async function loadSubagentTree(parentId, parentIr, byParent, visited) {
	const out = [];
	for (const info of byParent.get(parentId) ?? []) {
		if (visited.has(info.threadId)) continue;
		visited.add(info.threadId);
		const child = await parseRolloutFile(info.path);
		const label = info.agentNickname ?? info.agentRole ?? info.agentPath?.split("/").filter(Boolean).pop();
		const nested = await loadSubagentTree(info.threadId, child, byParent, visited);
		out.push({
			agentId: info.threadId,
			kind: "subagent",
			...label ? { agentType: label } : {},
			parentMessageId: spawnCallIdForChild(parentIr, info.agentPath),
			messages: child.messages,
			...child.toolCalls?.length ? { toolCalls: child.toolCalls } : {},
			originSessionId: info.threadId,
			...child.title ? { title: child.title } : {},
			...child.createdAt ? { createdAt: child.createdAt } : {},
			...child.cwd ? { cwd: child.cwd } : {},
			...child.compaction?.length ? { compaction: child.compaction } : {},
			...child.unmappedEvents?.length ? { unmappedEvents: child.unmappedEvents } : {},
			...child.meta ? { meta: child.meta } : {},
			...nested.length ? { sidechains: nested } : {}
		});
	}
	return out;
}
/** Collect rollout files (thread id → newest mtime wins for revert variants). */ async function walkRollouts(dir, out, archived) {
	let entries;
	try {
		entries = await promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (!archived && e.name === "archived_sessions") continue;
			await walkRollouts(full, out, archived);
		} else if (e.isFile() && e.name.startsWith("rollout-")) {
			const parsed = parseRolloutFileName(e.name);
			if (!parsed) continue;
			const mtime = (await promises.stat(full).catch(() => null))?.mtimeMs ?? 0;
			const prev = out.get(parsed.threadId);
			if (prev && prev.mtime >= mtime) continue;
			out.set(parsed.threadId, {
				path: full,
				mtime,
				createdAt: parsed.createdAt,
				...archived ? { archived: true } : {}
			});
		}
	}
}
//#endregion
//#region ../core/dist/src/adapters/dsh/workspace.js
/**
* DSH workspace registration — makes an externally-written session visible
* in the Web GUI without restarting the harness.
*
* The GUI's workspace panel is NOT a live filesystem scan. It renders
* `~/.dsh/storages/workspace.json` → `workspaceDomainSpec` → `sessionIds[]`.
* The registry's `bootstrap` (history→workspace grouping) only runs once
* (`initialized:false → true`). Afterwards every new session must be
* registered via `workspaceRegistry.attachSession(id)` or its durable
* equivalent (the `sessionIds` array). A raw `fs.writeFile` to
* `~/.dsh/sessions/.../session.jsonl.zstd` is therefore invisible on refresh.
*
* This module performs the durable equivalent directly against the JSON
* storage file, atomically and idempotently. It is best-effort: callers
* should never fail a migration because the workspace file could not be
* touched (sandbox, concurrent writer, etc.).
*/
var workspace_exports = /* @__PURE__ */ __exportAll({ ensureWorkspaceRegistration: () => ensureWorkspaceRegistration });
/** Resolve the workspace.json path from a sessions root like `~/.dsh/sessions`. */
function workspaceJsonPath(sessionsRoot) {
	const dshHome = dirname(sessionsRoot);
	if (!dshHome || dshHome === sessionsRoot) return null;
	return join(dshHome, "storages", "workspace.json");
}
async function canonicalize(p) {
	try {
		return await realpath(p);
	} catch {
		return p;
	}
}
/** Atomically replace `path` with `data` (tmp+rename, POSIX fsync on dir). */
async function writeAtomic(path, data) {
	const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
	const handle = await promises.open(tmp, "wx", 384);
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await promises.rename(tmp, path);
}
/**
* Ensure `sessionId` is accounted in the workspace that owns `cwd`.
* If no workspace owns `cwd`, a new one is created (mirrors bootstrap's
* `createCanonical` naming: `basename(path)`).
*
* No-op when:
*  - `sessionsRoot` is not the default DSH sessions dir (hermetic tmp roots)
*  - the workspace file does not exist or is unreadable
*  - the caller already passed an explicit custom root (we detect via `isDefaultRoot`)
*/
async function ensureWorkspaceRegistration(sessionsRoot, cwd, sessionId, opts) {
	if (!cwd) return {
		registered: false,
		reason: "no cwd"
	};
	if (opts?.isDefaultRoot === false) return {
		registered: false,
		reason: "hermetic root"
	};
	const wsPath = workspaceJsonPath(sessionsRoot);
	if (!wsPath) return {
		registered: false,
		reason: "no workspace path"
	};
	let raw;
	try {
		raw = await promises.readFile(wsPath, "utf8");
	} catch (e) {
		return {
			registered: false,
			reason: `read workspace.json: ${String(e.message)}`
		};
	}
	let doc;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return {
			registered: false,
			reason: `parse workspace.json: ${String(e.message)}`
		};
	}
	if (!doc?.tables?.workspaces || !doc?.global) return {
		registered: false,
		reason: "unexpected workspace.json shape"
	};
	const canonical = await canonicalize(cwd);
	const lowerEq = (a, b) => a === b || a.toLowerCase() === b.toLowerCase();
	let ownerId;
	let ownerRec;
	for (const [id, rec] of Object.entries(doc.tables.workspaces)) if (lowerEq(rec.path, canonical)) {
		ownerId = id;
		ownerRec = rec;
		break;
	}
	const nowIso = (/* @__PURE__ */ new Date()).toISOString();
	if (ownerId && ownerRec) {
		if (Array.isArray(ownerRec.sessionIds) && ownerRec.sessionIds.includes(sessionId)) return {
			registered: false,
			reason: "already registered"
		};
		ownerRec.sessionIds = [sessionId, ...ownerRec.sessionIds ?? []];
		ownerRec.updatedAt = nowIso;
		if (Array.isArray(doc.global.archivedSessionIds)) {
			const idx = doc.global.archivedSessionIds.indexOf(sessionId);
			if (idx !== -1) doc.global.archivedSessionIds.splice(idx, 1);
		}
	} else {
		const newId = randomUUID();
		const rec = {
			path: canonical,
			title: basename(canonical) || canonical,
			sessionIds: [sessionId],
			createdAt: nowIso,
			updatedAt: nowIso
		};
		doc.tables.workspaces[newId] = rec;
		if (Array.isArray(doc.global.workspaceIds)) doc.global.workspaceIds.unshift(newId);
		else doc.global.workspaceIds = [newId];
		ownerId = newId;
	}
	if (doc.global.initialized !== true) doc.global.initialized = true;
	const nextRaw = `${JSON.stringify(doc, null, 2)}\n`;
	try {
		await writeAtomic(wsPath, nextRaw);
	} catch (e) {
		return {
			registered: false,
			reason: `write workspace.json: ${String(e.message)}`
		};
	}
	return { registered: true };
}
//#endregion
//#region ../core/dist/src/adapters/zcode/index.js
/**
* ZCode adapter — reads/writes the canonical `~/.zcode/cli/db/db.sqlite` (live WAL SQLite).
*
* Source-anchored from the engine bundle reverse-engineering in `docs/agents/zcode.md`:
*  - Authority is the SQLite store; there are NO per-session transcript files.
*    Three tables matter: `session` (metadata incl. `revert` JSON), `message`
*    (role-discriminated `data` JSON + per-session `sequence` 0..N-1), `part`
*    (type-discriminated `data` JSON + per-message `sequence`).
*  - Message order is `sequence` only — `parentID` is NOT a tree to walk
*    (multiple assistants share one parent; spec alignment pitfall #6).
*  - `session.revert` (conversation rewind): pruned messages stay physically in
*    the DB; the active branch is derived by the engine's `o0()` — this adapter
*    reimplements it, otherwise rewound conversations get migrated (pitfall #13).
*  - user messages are classified by `data.semantics` (D2 policy): only
*    `origin==='real_user'` is real input; compaction-summary user messages are
*    projected INTO messages[] (marked by `meta.zcode`, so write-back restores
*    their native shape) and registered in IR `compaction[]` with an
*    `anchorIndex` into messages[] (gap #3); todo_reminder/background_task
*    & co are model-only synthetics (→ extensions, never `messages[]`).
*  - a `tool` part fuses call+result in one row (4-state). It is split by
*    `callID` into IR `tool_use` + following role:'tool' `tool_result`;
*    `state.status==='error'` uses `state.error` (isError:true); pending/running
*    states are not projected into messages (a tool_use without result would
*    break provider replay) but ALL four states are recorded losslessly in the
*    IR `toolCalls` typed bucket and re-injected on write-back.
*    `state.input` may be a JSON string (older engine writes) or an object.
*  - reasoning parts carry their anthropic signature directly on the IR
*    thinking block (`signature`), so claude-target resume keeps signed
*    thinking (gap #1). Message-level native payload (semantics/cost/tokens/
*    time/anchor/contextSnapshot + every non-projected part row verbatim)
*    lives on `msg.meta.zcode` — attached to the message entity, never a
*    source-id side-table (gap #2); write-back consumes it to restore the
*    native rows exactly.
*  - `providerID` is the provider-registry id (uuid or `builtin:*`); the
*    readable name lives in `~/.zcode/v2/config.json` `provider.<id>.name` —
*    that file also contains apiKeys, so only `name` is ever read and raw ids
*    are kept in extensions (pitfall #2 + secret ban).
*  - subagent children: `sess_subagent_agent_<uuid>` rows with
*    `task_type='subagent_child'` + `parent_id` are the reliable cold link
*    (pitfall #12); sidecar `~/.zcode/cli/agents/<parent>/agent_<uuid>/metadata.json`
*    supplements agentId/systemPrompt/usage/parentToolUseId. Write-back
*    additionally rewrites the engine's launch-acknowledgement footer in the
*    Agent tool output (`agentId: agent_<uuid> …`) — the cold-read derivation
*    prefers that line over `state.metadata.agentId`, so a stale uuid would
*    re-bind the migrated part to the SOURCE child session.
*  - write-back is a direct 3-table INSERT (spec「构造可 resume 会话」):
*    `sess_<uuid>` / `msg_<base36>_<uuid>` / `part_<base36>_<uuid>` /
*    `call_<hex>`, contiguous sequences, ms timestamps, `version:'0.16.3'`,
*    `permission:'{"mode":"build"}'`, `slug=id`, `project_id=proj_<dir slug>`.
*    Verified against the engine's official `app-server --stdio` NDJSON path
*    (session/list + resume + messages + subagents) — see zcode.md round-trip.
*  - `part.data` fields are a superset of the bundle zod schemas (pitfall #8):
*    parsing is tolerant, unknown fields are preserved (in `meta.zcode.rawParts`
*    per message / extensions for whole dropped rows).
*  - IR `systemPrompt` is never read (engine injects it per agent profile at
*    runtime; only sidecar snapshots have it → extensions) and never written.
*
* Root semantics (mirrors the OpenCode adapter):
*  - `root` ending in `.sqlite`/`.db` → that exact file
*  - `root` a directory → `<root>/cli/db/db.sqlite` (a ZCODE_HOME-shaped tree)
*  - no root → `$ZCODE_SESSION_DB_PATH` / `$ZCODE_SESSION_DB` → `$ZCODE_HOME` → `~/.zcode`
*
* Safety: the live WAL store is opened read-only on read (with a physical
* db+wal+shm copy fallback). On write, when the target file does not exist and
* an explicit root/env override was given, the sandbox is bootstrapped from a
* consistent `VACUUM INTO` snapshot of the live db (keeps the engine's 18
* migrations); the default real location is never auto-created.
*/
const DB_REL = join("cli", "db", "db.sqlite");
/** Engine version the write-back shape was protocol-verified against (zcode.md round-trip). */
const ENGINE_VERSION = "0.16.3";
const DEFAULT_PERMISSION = "{\"mode\":\"build\"}";
function zcodeHome() {
	const env = process.env.ZCODE_HOME;
	if (env && env.trim()) return env.trim();
	const home = process.env.HOME || process.env.USERPROFILE || homedir();
	return join(home, ".zcode");
}
function isDbFilePath(t) {
	return t.endsWith(".sqlite") || t.endsWith(".db");
}
function resolveDbPath$1(root) {
	if (root && root.trim()) {
		const t = root.trim();
		if (isDbFilePath(t)) return t;
		return join(t, DB_REL);
	}
	const envDb = process.env.ZCODE_SESSION_DB_PATH || process.env.ZCODE_SESSION_DB;
	if (envDb && envDb.trim()) return envDb.trim();
	return join(zcodeHome(), DB_REL);
}
/** `<home>/v2/config.json` — provider registry (contains apiKeys: never dumped). */
function resolveConfigPath(root) {
	if (root && root.trim()) {
		const t = root.trim();
		if (isDbFilePath(t)) return join(dirname(dirname(dirname(t))), "v2", "config.json");
		return join(t, "v2", "config.json");
	}
	return join(zcodeHome(), "v2", "config.json");
}
function resolveAgentsRoot(root) {
	if (root && root.trim()) {
		const t = root.trim();
		if (isDbFilePath(t)) return join(dirname(dirname(dirname(t))), "cli", "agents");
		return join(t, "cli", "agents");
	}
	return join(zcodeHome(), "cli", "agents");
}
let __sqliteCtor$1;
async function getSqliteCtor$1() {
	if (__sqliteCtor$1 !== void 0) return __sqliteCtor$1;
	try {
		const Ctor = (await import("node:sqlite")).DatabaseSync;
		if (typeof Ctor === "function") {
			__sqliteCtor$1 = Ctor;
			return __sqliteCtor$1;
		}
	} catch {}
	__sqliteCtor$1 = null;
	return null;
}
function openDbSync$1(dbPath, readOnly) {
	const open = (Ctor, opts) => {
		try {
			return new Ctor(dbPath, opts);
		} catch {
			return null;
		}
	};
	if (__sqliteCtor$1) return open(__sqliteCtor$1, readOnly ? { readOnly: true } : {});
	try {
		const { createRequire } = __require("node:module");
		const Ctor = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
		if (typeof Ctor === "function") {
			__sqliteCtor$1 = Ctor;
			return open(__sqliteCtor$1, readOnly ? { readOnly: true } : {});
		}
	} catch {}
	try {
		const { createRequire } = __require("node:module");
		const Better = createRequire(import.meta.url)("better-sqlite3");
		if (typeof Better === "function") return open(Better, readOnly ? {
			readonly: true,
			fileMustExist: true
		} : {});
	} catch {}
	return null;
}
async function openDb$1(dbPath, readOnly) {
	const Ctor = await getSqliteCtor$1();
	if (Ctor) try {
		return new Ctor(dbPath, readOnly ? { readOnly: true } : {});
	} catch {}
	return openDbSync$1(dbPath, readOnly);
}
/**
* Open the live WAL store read-only. If a read-only handle is refused
* (locked shm / sandboxed volume), fall back to a consistent physical copy of
* db + `-wal` + `-shm` in a temp dir and open the copy (spec pitfall #10).
*/
async function openLiveReadOnly(dbPath) {
	const direct = await openDb$1(dbPath, true);
	if (direct) return {
		db: direct,
		dbPath
	};
	const copyDir = join(tmpdir(), `zcode-readonly-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
	try {
		await promises.mkdir(copyDir, { recursive: true });
		for (const suffix of [
			"",
			"-wal",
			"-shm"
		]) {
			const src = dbPath + suffix;
			if (!existsSync(src)) continue;
			await promises.copyFile(src, join(copyDir, "db.sqlite" + suffix));
		}
		const copyPath = join(copyDir, "db.sqlite");
		const db = await openDb$1(copyPath, true);
		if (db) return {
			db,
			dbPath: copyPath
		};
	} catch {}
	return null;
}
function tryParse(v) {
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return v;
	}
}
function parseJsonObject(raw) {
	const v = tryParse(raw);
	return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function base36(n) {
	return Math.max(0, Math.floor(n)).toString(36);
}
function freshCallId() {
	return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
/**
* `proj_<dir lowercased, non-alphanumeric runs → '-'>` (spec「构造可 resume
* 会话」). Runs collapse so `D:\proj` yields `proj_d-proj`, matching real rows.
*/
function zcodeProjectId(directory) {
	return "proj_" + directory.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
/** zcode profile name (`zcode-Explore`) → agent type (`Explore`). */
function agentTypeOf(agent) {
	if (!agent) return void 0;
	return agent.startsWith("zcode-") ? agent.slice(6) : agent;
}
function isSubagentToolName(name) {
	return name === "Agent" || name === "Task" || name === "subagent";
}
function looksLikeCallId(id) {
	return /^call_\w{4,}$/.test(id);
}
/**
* Provider-registry reader. Only `provider.<id>.name` is extracted — the file
* also holds `options.apiKey`, which must never be read out or logged.
*/
async function readProviderRegistry(configPath) {
	try {
		const raw = await promises.readFile(configPath, "utf8");
		const cfg = JSON.parse(raw);
		const out = {};
		for (const [id, p] of Object.entries(cfg.provider ?? {})) if (p && typeof p.name === "string") out[id] = p.name;
		return out;
	} catch {
		return {};
	}
}
var ZcodeAdapter = class {
	tool = "zcode";
	irVersion = "3.3";
	async parse(sessionId, root) {
		const dbPath = resolveDbPath$1(root);
		if (!dbPath || !existsSync(dbPath)) throw new Error(`Zcode: session db not found at ${dbPath ?? "<unresolved>"} (pass --src-root pointing at a ZCode home or the db.sqlite file)`);
		const opened = await openLiveReadOnly(dbPath);
		if (!opened) throw new Error(`Zcode: cannot open ${dbPath} read-only (live WAL locked and copy failed)`);
		try {
			return await parseFromDb$1(opened.db, sessionId, root);
		} finally {
			try {
				opened.db.close();
			} catch {}
		}
	}
	async listSessions(root) {
		const dbPath = resolveDbPath$1(root);
		if (!dbPath || !existsSync(dbPath)) return [];
		const opened = await openLiveReadOnly(dbPath);
		if (!opened) throw new Error(`Zcode: cannot open ${dbPath} read-only to list sessions (live WAL locked and copy failed) — aborting instead of returning an empty list`);
		try {
			return opened.db.prepare("SELECT id, title, time_created, directory FROM session WHERE parent_id IS NULL ORDER BY time_created DESC").all().map((r) => ({
				tool: "zcode",
				sessionId: String(r.id ?? ""),
				title: r.title ? String(r.title) : void 0,
				createdAt: typeof r.time_created === "number" ? r.time_created : void 0,
				cwd: r.directory ? String(r.directory) : void 0,
				sourcePath: dbPath ?? void 0
			}));
		} finally {
			try {
				opened.db.close();
			} catch {}
		}
	}
	async write(ir, opts) {
		validateSession(ir);
		const root = opts?.root;
		const targetCwd = opts?.targetCwd ?? ir.cwd ?? "";
		const newId = opts?.sessionId ?? `sess_${randomUUID()}`;
		const dbPath = resolveDbPath$1(root);
		if (!dbPath) throw new Error("Zcode: cannot resolve target db path (no root and no HOME)");
		const targetPinned = !!(root && root.trim()) || !!(process.env.ZCODE_SESSION_DB_PATH || process.env.ZCODE_SESSION_DB);
		if (!existsSync(dbPath)) {
			if (!targetPinned) throw new Error(`Zcode: target db ${dbPath} does not exist. Refusing to fabricate the real ZCode store — pass --dst-root <zcodeHome-shaped dir> (a sandbox copy is created) or snapshot the live db first.`);
			await promises.mkdir(dirname(dbPath), { recursive: true });
			const liveDb = join(zcodeHome(), DB_REL);
			if (existsSync(liveDb)) await snapshotLiveDb(liveDb, dbPath);
			else await createMinimalDb(dbPath);
		}
		const db = await openDb$1(dbPath, false);
		if (!db) throw new Error(`Zcode: no sqlite driver available to write ${dbPath} (need node:sqlite on Node ≥22 or better-sqlite3)`);
		try {
			ensureMinimalSchema(db);
			let paths;
			try {
				db.exec("BEGIN IMMEDIATE");
				paths = writeToDb$1(db, ir, newId, targetCwd, opts?.keepSynthetic ?? false);
				db.exec("COMMIT");
			} catch (e) {
				try {
					db.exec("ROLLBACK");
				} catch {}
				const msg = String(e?.message ?? e);
				if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) throw new Error(`Zcode: ${dbPath} is locked (SQLITE_BUSY) — the ZCode app is mid-write. Retry, or write to a sandbox copy via --dst-root.`);
				if (msg.includes("readonly database") || msg.includes("EPERM") || msg.includes("EACCES")) throw new Error(`Zcode: ${dbPath} is not writable in this sandbox (EPERM/readonly). Run the CLI outside the sandbox or use --dst-root <tmpDir>.`);
				throw e;
			}
			return {
				tool: "zcode",
				sessionId: newId,
				paths
			};
		} finally {
			try {
				db.close();
			} catch {}
		}
	}
	preview(session) {
		const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join("\n\n");
		if (!session.sidechains?.length) return main;
		return `${main}\n\n${session.sidechains.map((s) => `[sidechain: ${s.agentId} (${s.kind}${s.agentType ? ` / ${s.agentType}` : ""})]\n${s.messages.map((m) => blocksToText(m.content)).join("\n")}`).join("\n\n")}`;
	}
};
async function parseFromDb$1(db, sessionId, root) {
	const sessionRow = db.prepare("SELECT * FROM session WHERE id=?").get(sessionId);
	if (!sessionRow) throw new Error(`Zcode: session "${sessionId}" not found in db`);
	const ctx = {
		providerNames: await readProviderRegistry(resolveConfigPath(root)),
		agentsRoot: resolveAgentsRoot(root)
	};
	const messages = loadMessagesOrdered(db, sessionId);
	const partsByMessage = loadPartsByMessage$1(db, sessionId);
	const revert = parseJsonObject(sessionRow.revert);
	const trimmed = o0Trim(messages, revert);
	const irMessages = [];
	const providerIdMap = {};
	const syntheticMessages = [];
	const compactionParts = [];
	const summaryCandidates = [];
	const summaryAnchors = /* @__PURE__ */ new Map();
	const toolCalls = [];
	let lastModel;
	const ctx2 = {
		...ctx,
		providerIdMap
	};
	for (const m of trimmed.messages) {
		const exp = expandMessageRow(m, partsByMessage.get(m.id) ?? [], ctx2);
		if (exp.compaction) summaryAnchors.set(exp.compaction.sourceId, irMessages.length);
		irMessages.push(...exp.ir);
		if (exp.synthetic) syntheticMessages.push(exp.synthetic);
		if (exp.toolCalls) toolCalls.push(...exp.toolCalls);
		if (exp.compactionParts) compactionParts.push(...exp.compactionParts);
		if (exp.compaction?.summary) summaryCandidates.push({
			sourceId: exp.compaction.sourceId,
			summary: exp.compaction.summary
		});
		if (exp.ir[0]?.role === "assistant" && exp.meta?.modelID) lastModel = {
			providerID: exp.meta.providerID,
			modelID: exp.meta.modelID,
			variant: exp.meta.variant
		};
	}
	const tokensBeforeBySummaryId = /* @__PURE__ */ new Map();
	for (const cp of compactionParts) {
		const sumId = typeof cp.summaryMessageId === "string" ? cp.summaryMessageId : void 0;
		if (sumId && typeof cp.preCompactTokenCount === "number") tokensBeforeBySummaryId.set(sumId, cp.preCompactTokenCount);
	}
	const compactions = summaryCandidates.map((s) => ({
		summary: s.summary,
		...tokensBeforeBySummaryId.get(s.sourceId) !== void 0 ? { tokensBefore: tokensBeforeBySummaryId.get(s.sourceId) } : {},
		...summaryAnchors.has(s.sourceId) ? { anchorIndex: summaryAnchors.get(s.sourceId) } : {}
	}));
	const { sidechains, agentLinks, otherChildren, sidecarPrompts } = await buildSidechains(db, sessionId, ctx2);
	const ir = {
		schemaVersion: 2,
		originTool: "zcode",
		originSessionId: String(sessionRow.id ?? sessionId),
		messages: irMessages
	};
	if (sessionRow.title) ir.title = String(sessionRow.title);
	if (typeof sessionRow.time_created === "number") ir.createdAt = sessionRow.time_created;
	if (sessionRow.directory) ir.cwd = String(sessionRow.directory);
	if (lastModel?.modelID) ir.model = {
		...lastModel.providerID && providerIdMap[lastModel.providerID] ? { provider: providerIdMap[lastModel.providerID] } : {},
		id: lastModel.modelID,
		...lastModel.variant ? { variant: lastModel.variant } : {}
	};
	if (sidechains.length) ir.sidechains = sidechains;
	if (compactions.length) ir.compaction = compactions;
	if (toolCalls.length) ir.toolCalls = toolCalls;
	const extensions = {
		"zcode.session": {
			projectId: sessionRow.project_id ?? null,
			workspaceId: sessionRow.workspace_id ?? null,
			parentId: sessionRow.parent_id ?? null,
			slug: sessionRow.slug ?? null,
			path: sessionRow.path ?? null,
			version: sessionRow.version ?? null,
			permission: sessionRow.permission ?? null,
			taskType: sessionRow.task_type ?? null,
			titleSource: sessionRow.title_source ?? null,
			titleMessageId: sessionRow.title_message_id ?? null,
			timeUpdated: typeof sessionRow.time_updated === "number" ? sessionRow.time_updated : null,
			revertRaw: Object.keys(revert).length ? revert : null
		},
		"zcode.providers": providerIdMap
	};
	if (syntheticMessages.length) extensions["zcode.syntheticMessages"] = syntheticMessages;
	if (trimmed.pruned.length) extensions["zcode.prunedMessages"] = trimmed.pruned.map((m) => ({
		id: m.id,
		sequence: m.sequence,
		data: parseJsonObject(m.data)
	}));
	if (Object.keys(agentLinks).length) extensions["zcode.agentLinks"] = agentLinks;
	if (otherChildren.length) extensions["zcode.childSessions"] = otherChildren;
	if (Object.keys(sidecarPrompts).length) extensions["zcode.sidecars"] = sidecarPrompts;
	ir.extensions = extensions;
	return validateSession(ir);
}
function loadMessagesOrdered(db, sessionId) {
	return db.prepare("SELECT id, sequence, time_created, data FROM message WHERE session_id=? ORDER BY sequence IS NULL, sequence, time_created, rowid").all(sessionId).map((r) => ({
		id: String(r.id ?? ""),
		sequence: typeof r.sequence === "number" ? r.sequence : null,
		time_created: typeof r.time_created === "number" ? r.time_created : null,
		data: String(r.data ?? "{}")
	}));
}
function loadPartsByMessage$1(db, sessionId) {
	const rows = db.prepare("SELECT id, message_id, sequence, time_created, data FROM part WHERE session_id=? ORDER BY sequence IS NULL, sequence, time_created, rowid").all(sessionId);
	const out = /* @__PURE__ */ new Map();
	for (const r of rows) {
		const mid = String(r.message_id ?? "");
		if (!mid) continue;
		const list = out.get(mid) ?? [];
		list.push({
			id: String(r.id ?? ""),
			message_id: mid,
			sequence: typeof r.sequence === "number" ? r.sequence : null,
			time_created: typeof r.time_created === "number" ? r.time_created : null,
			data: String(r.data ?? "{}")
		});
		out.set(mid, list);
	}
	return out;
}
/**
* Engine `o0()` branch trim (zcode.md「rewind 与活跃分支」): the DB layer
* returns everything; the runtime slices the active branch from
* `session.revert`. Parameter mapping is the engine's own (`eDi`):
* `branchCutAfterMessageID` / `keptMessageIDs` / `targetMessageID` /
* `createdMessageID`. The persisted JSON carries `messageID`, but the engine
* only ever reads `createdMessageID` (an in-memory runtime field), so a
* persisted `messageID` is deliberately NOT consumed here — engine-exact.
* The appended tail is deduped against the base (whitelist ∩ after-cut is
* empty in practice; duplicate ids would corrupt the replay).
*/
function o0Trim(messages, revert) {
	const target = typeof revert.targetMessageID === "string" ? revert.targetMessageID : void 0;
	if (!target) return {
		messages,
		pruned: []
	};
	const byId = new Map(messages.map((m) => [m.id, m]));
	const keptIds = /* @__PURE__ */ new Set();
	const whitelist = Array.isArray(revert.keptMessageIDs) ? revert.keptMessageIDs.filter((x) => typeof x === "string") : void 0;
	let base;
	if (whitelist) base = whitelist.map((id) => byId.get(id)).filter((m) => !!m);
	else {
		const targetIdx = messages.findIndex((m) => m.id === target);
		base = targetIdx >= 0 ? messages.slice(0, targetIdx) : messages.slice();
	}
	for (const m of base) keptIds.add(m.id);
	const cut = typeof revert.branchCutAfterMessageID === "string" ? revert.branchCutAfterMessageID : void 0;
	const created = typeof revert.createdMessageID === "string" ? revert.createdMessageID : void 0;
	let tail = [];
	if (cut) {
		const cutIdx = messages.findIndex((m) => m.id === cut);
		if (cutIdx >= 0) tail = messages.slice(cutIdx + 1);
	} else if (created) {
		const createdIdx = messages.findIndex((m) => m.id === created);
		if (createdIdx >= 0) tail = messages.slice(createdIdx);
	}
	const merged = [...base];
	for (const m of tail) {
		if (keptIds.has(m.id)) continue;
		keptIds.add(m.id);
		merged.push(m);
	}
	return {
		messages: merged,
		pruned: messages.filter((m) => !keptIds.has(m.id))
	};
}
function classifyUserMessage(d) {
	const sem = d.semantics ?? {};
	if (d.summary !== void 0 || sem.kind === "compact_summary") return "compactSummary";
	if (sem.kind === "timeline_event" || sem.kind === "fork_notice") return "timelineOnly";
	if (d.synthetic === true || d.visibility === "model-only" || sem.uiVisibility === "hidden" && sem.transcriptVisibility === "hidden") return "synthetic";
	if (sem.origin === "real_user") return "realUserInput";
	if (sem.kind === "user_prompt" || sem.kind === "slash_command") return "realUserInput";
	if (!sem.origin && !sem.kind) {
		if (d.visibility === "model-only" || d.synthetic || d.source === "todo_reminder" || d.source === "background_task") return "synthetic";
		return "realUserInput";
	}
	return "synthetic";
}
/** Expand one native message row (+ its parts) into IR messages. */
function expandMessageRow(m, parts, ctx) {
	const data = parseJsonObject(m.data);
	const ts = data.time && typeof data.time.created === "number" ? data.time.created : m.time_created ?? void 0;
	if (data.role === "user") {
		const d = data;
		const cls = classifyUserMessage(d);
		if (cls === "compactSummary") {
			const { blocks, rawParts } = userPartsToBlocks(parts);
			const meta = zcodeMetaForUser(d);
			meta.sourceId = m.id;
			if (rawParts.length) meta.rawParts = rawParts;
			const body = typeof d.summary?.body === "string" ? d.summary.body : "";
			const content = blocks.length ? blocks : body ? [{
				type: "text",
				text: body
			}] : [];
			if (!content.length) return {
				ir: [],
				meta
			};
			const msg = {
				role: "user",
				content,
				seq: m.sequence ?? void 0,
				meta: { zcode: meta }
			};
			if (ts !== void 0) msg.timestamp = ts;
			return {
				ir: [msg],
				meta,
				compaction: {
					summary: body,
					sourceId: m.id
				}
			};
		}
		if (cls !== "realUserInput") return {
			ir: [],
			synthetic: {
				id: m.id,
				sequence: m.sequence,
				data: d
			}
		};
		const { blocks, rawParts } = userPartsToBlocks(parts);
		if (!blocks.length) return {
			ir: [],
			synthetic: {
				id: m.id,
				sequence: m.sequence,
				data: d
			}
		};
		const meta = zcodeMetaForUser(d);
		meta.sourceId = m.id;
		if (rawParts.length) meta.rawParts = rawParts;
		const msg = {
			role: "user",
			content: blocks,
			seq: m.sequence ?? void 0,
			meta: { zcode: meta }
		};
		if (ts !== void 0) msg.timestamp = ts;
		if (d.model?.modelID) {
			msg.model = String(d.model.modelID);
			if (d.model.providerID) msg.provider = rememberProviderName(d.model.providerID, ctx);
		}
		return {
			ir: [msg],
			meta
		};
	}
	if (data.role === "assistant") {
		const d = data;
		const { blocks, toolResults, meta, compactionParts, toolCalls, droppedToolState } = assistantPartsToBlocks(parts, d, {
			messageId: m.id,
			messageSequence: m.sequence ?? -1
		});
		if (!blocks.length) return {
			ir: [],
			meta,
			synthetic: {
				id: m.id,
				sequence: m.sequence,
				data: d
			},
			compactionParts,
			toolCalls,
			droppedToolState
		};
		meta.sourceId = m.id;
		const msg = {
			role: "assistant",
			content: blocks,
			seq: m.sequence ?? void 0,
			meta: { zcode: meta }
		};
		if (ts !== void 0) msg.timestamp = ts;
		if (d.modelID) msg.model = String(d.modelID);
		if (d.providerID) msg.provider = rememberProviderName(d.providerID, ctx);
		if (d.finish) msg.stopReason = String(d.finish);
		const out = [msg];
		if (toolResults.length) out.push({
			role: "tool",
			content: toolResults,
			seq: m.sequence ?? void 0,
			timestamp: ts
		});
		return {
			ir: out,
			meta,
			compactionParts,
			toolCalls,
			droppedToolState
		};
	}
	return {
		ir: [],
		synthetic: {
			id: m.id,
			sequence: m.sequence,
			data
		}
	};
}
/** Map a raw providerID to its registry name (fallback: the raw id itself). */
function rememberProviderName(providerId, ctx) {
	const name = ctx.providerNames[providerId];
	ctx.providerIdMap[providerId] = name ?? providerId;
	return name ?? providerId;
}
/** user message `data` → msg.meta.zcode payload (gap #2). */
function zcodeMetaForUser(d) {
	const meta = {};
	if (d.agent) meta.agent = d.agent;
	if (d.model?.providerID) meta.providerID = d.model.providerID;
	if (d.model?.modelID) meta.modelID = d.model.modelID;
	if (d.model?.variant) meta.variant = d.model.variant;
	if (d.contextSnapshot) meta.contextSnapshot = d.contextSnapshot;
	if (d.tools) meta.tools = d.tools;
	if (d.anchor) meta.anchor = d.anchor;
	if (d.metadata) meta.metadata = d.metadata;
	if (d.semantics) meta.semantics = d.semantics;
	if (d.summary) meta.summary = d.summary;
	if (d.synthetic !== void 0) meta.synthetic = d.synthetic === true;
	if (d.source) meta.source = d.source;
	if (d.visibility) meta.visibility = d.visibility;
	return meta;
}
/** Read back the zcode namespace of a message's meta (write side). */
function zcodeMetaOf(msg) {
	const z = msg.meta?.zcode;
	return z && typeof z === "object" && !Array.isArray(z) ? z : void 0;
}
/** Append meta.zcode.rawParts (verbatim non-projected part rows) to a part list. */
function appendRawParts(parts, zmeta, ts) {
	const raw = [...zmeta?.rawParts ?? []].sort((a, b) => (typeof a.sequence === "number" ? a.sequence : Number.MAX_SAFE_INTEGER) - (typeof b.sequence === "number" ? b.sequence : Number.MAX_SAFE_INTEGER));
	for (const rp of raw) {
		if (!rp.data || typeof rp.data !== "object" || Array.isArray(rp.data)) continue;
		parts.push({
			data: rp.data,
			ts
		});
	}
}
/**
* user message parts → IR blocks + rawParts, using the engine's own replay
* concatenation for the meaningful part types: text (non-ignored) → text,
* file → FileBlock (image attachments included — gap #4), agent →
* `[Selected agent: …]` (D2 layer rules) with the row kept in rawParts.
* Everything else is engine bookkeeping → rawParts verbatim.
*/
function userPartsToBlocks(parts) {
	const blocks = [];
	const rawParts = [];
	for (const p of parts) {
		const d = parseJsonObject(p.data);
		if (d.type === "text") {
			if (d.ignored === true || d.synthetic === true) continue;
			if (typeof d.text === "string" && d.text) blocks.push({
				type: "text",
				text: d.text
			});
		} else if (d.type === "file") {
			const file = { type: "file" };
			if (typeof d.filename === "string") file.filename = d.filename;
			else if (typeof d.name === "string") file.filename = d.name;
			if (typeof d.mime === "string") file.mediaType = d.mime;
			if (typeof d.url === "string") file.url = d.url;
			if (file.filename || file.mediaType || file.url) blocks.push(file);
			else rawParts.push({
				sequence: p.sequence,
				data: d
			});
		} else if (d.type === "agent") {
			blocks.push({
				type: "text",
				text: `[Selected agent: ${String(d.name ?? "agent")}]`
			});
			rawParts.push({
				sequence: p.sequence,
				data: d
			});
		} else rawParts.push({
			sequence: p.sequence,
			data: d
		});
	}
	return {
		blocks,
		rawParts
	};
}
/**
* assistant message parts → IR blocks. `tool` parts split by callID into a
* `tool_use` (kept on the assistant) + `tool_result` blocks (emitted as the
* following role:'tool' IR message). completed → output; error →
* state.error with isError:true; pending/running are NOT projected into
* messages (a tool_use without result would break provider replay after
* migration) but every invocation — all four states — is recorded losslessly
* in the `toolCalls` bucket with its source position.
*/
function assistantPartsToBlocks(parts, d, source) {
	const blocks = [];
	const toolResults = [];
	const meta = {};
	let compactionParts;
	let toolCalls;
	let droppedToolState;
	if (d.agent) meta.agent = d.agent;
	if (d.providerID) meta.providerID = d.providerID;
	if (d.modelID) meta.modelID = d.modelID;
	if (d.variant) meta.variant = d.variant;
	if (d.mode) meta.mode = d.mode;
	if (d.cost !== void 0) meta.cost = d.cost;
	if (d.tokens) meta.tokens = d.tokens;
	if (d.finish !== void 0) meta.finish = d.finish;
	if (d.time) meta.time = d.time;
	if (d.semantics) meta.semantics = d.semantics;
	if (d.error !== void 0) meta.raw = { error: d.error };
	for (const p of parts) {
		const pd = parseJsonObject(p.data);
		switch (pd.type) {
			case "text":
				if (pd.ignored === true || pd.synthetic === true) break;
				if (typeof pd.text === "string" && pd.text) blocks.push({
					type: "text",
					text: pd.text
				});
				break;
			case "reasoning": {
				const anth = parseJsonObject(parseJsonObject(pd.metadata).anthropic);
				const signature = typeof anth.signature === "string" ? anth.signature : void 0;
				const text = typeof pd.text === "string" ? pd.text : "";
				if (text || signature) blocks.push(signature ? {
					type: "thinking",
					thinking: text,
					signature
				} : {
					type: "thinking",
					thinking: text
				});
				break;
			}
			case "tool": {
				const tool = pd;
				const callId = String(tool.callID ?? "");
				const name = String(tool.tool ?? "tool");
				const state = tool.state ?? {};
				const status = state.status;
				if (callId) {
					toolCalls = toolCalls ?? [];
					toolCalls.push({
						callId,
						tool: name,
						status: status === "running" || status === "pending" || status === "error" ? status : "completed",
						...state.input !== void 0 ? { input: tryParse(state.input) } : {},
						...status === "error" ? { error: String(state.error ?? "tool call failed") } : { output: stringOutput(state.output) },
						...state.title ? { title: String(state.title) } : {},
						...state.metadata && Object.keys(state.metadata).length ? { metadata: state.metadata } : {},
						...state.time ? { time: state.time } : {},
						source: {
							messageId: source.messageId,
							messageSequence: source.messageSequence,
							partSequence: p.sequence ?? -1
						}
					});
				}
				if (status === "pending" || status === "running") {
					droppedToolState = `${status}:${name}:${callId}`;
					break;
				}
				if (!callId) break;
				blocks.push({
					type: "tool_use",
					id: callId,
					name,
					input: tryParse(state.input)
				});
				if (status === "error") toolResults.push({
					type: "tool_result",
					toolUseId: callId,
					content: String(state.error ?? "tool call failed"),
					isError: true
				});
				else toolResults.push({
					type: "tool_result",
					toolUseId: callId,
					content: stringOutput(state.output),
					isError: false
				});
				break;
			}
			case "compaction":
				compactionParts = compactionParts ?? [];
				compactionParts.push(pd);
				meta.rawParts = meta.rawParts ?? [];
				meta.rawParts.push({
					sequence: p.sequence,
					data: pd
				});
				break;
			default:
				meta.rawParts = meta.rawParts ?? [];
				meta.rawParts.push({
					sequence: p.sequence,
					data: pd
				});
		}
	}
	return {
		blocks,
		toolResults,
		meta,
		compactionParts,
		toolCalls,
		droppedToolState
	};
}
function stringOutput(v) {
	if (typeof v === "string") return v;
	if (v === void 0 || v === null) return "";
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
/**
* 读端下钻上限：真实代理树 2–3 层；损坏/手工数据里的 parent_id 深链或环
* 会让「每层一次 DB 查询」变成查询炸弹，16 层已远超任何真实嵌套深度。
*/
const SIDECHAIN_MAX_DEPTH = 16;
/**
* Top entry: builds the sidechain tree one level per DB query. The accumulators
* (agentLinks / otherChildren / sidecarPrompts) are flat across the whole walk —
* callIds and sidecar keys are globally unique, so level attribution is not
* needed and the write side's link matcher can find nested entries verbatim.
* 往返对称性（上轮审查 P0-3 附带说明）：孙代 session 行（parent_id=子代 id）
* 以前读不回来——写端递归落库了孙代但读端只查顶层一层。现在每层 sidechain
* 递归下钻，子代的 sidechains[] 里挂孙代，主 IR 重新反映完整委托树。
*/
async function buildSidechains(db, parentSessionId, ctx) {
	const acc = {
		agentLinks: {},
		otherChildren: [],
		sidecarPrompts: {}
	};
	return {
		sidechains: await buildSidechainLevel(db, parentSessionId, ctx, 0, /* @__PURE__ */ new Set([parentSessionId]), acc),
		agentLinks: acc.agentLinks,
		otherChildren: acc.otherChildren,
		sidecarPrompts: acc.sidecarPrompts
	};
}
/** One nesting level: children of parentSessionId → sidechains (+ their own levels). */
async function buildSidechainLevel(db, parentSessionId, ctx, depth, visited, acc) {
	if (depth >= SIDECHAIN_MAX_DEPTH) return [];
	const childRows = db.prepare("SELECT id, task_type, title FROM session WHERE parent_id=? ORDER BY time_created").all(parentSessionId);
	const sidechains = [];
	const usedCallIds = /* @__PURE__ */ new Set();
	const sidecars = await loadSidecars(ctx.agentsRoot, parentSessionId);
	for (const row of childRows) {
		const childId = String(row.id ?? "");
		const taskType = String(row.task_type ?? "");
		if (taskType !== "subagent_child") {
			acc.otherChildren.push({
				id: childId,
				taskType,
				title: row.title ? String(row.title) : null
			});
			continue;
		}
		const childMessages = loadMessagesOrdered(db, childId);
		const childParts = loadPartsByMessage$1(db, childId);
		const trimmed = o0Trim(childMessages, parseJsonObject(db.prepare("SELECT revert FROM session WHERE id=?").get(childId)?.revert));
		const irMessages = [];
		const childToolCalls = [];
		const childSynthetics = [];
		let agentType;
		for (const m of trimmed.messages) {
			const exp = expandMessageRow(m, childParts.get(m.id) ?? [], ctx);
			irMessages.push(...exp.ir);
			if (exp.toolCalls) childToolCalls.push(...exp.toolCalls);
			if (exp.synthetic) childSynthetics.push(exp.synthetic);
			if (!agentType) {
				const d = parseJsonObject(m.data);
				if (d.agent) agentType = agentTypeOf(d.agent);
			}
		}
		if (!irMessages.length && !childSynthetics.length) continue;
		const scUuid = childId.startsWith("sess_subagent_agent_") ? childId.slice(20) : childId;
		const sidecar = sidecars.get(`agent_${scUuid}`);
		if (!agentType && sidecar?.profileSnapshot?.name) agentType = agentTypeOf(sidecar.profileSnapshot.name);
		if (sidecar) acc.sidecarPrompts[`agent_${scUuid}`] = {
			...sidecar.profileSnapshot?.systemPrompt ? { systemPrompt: sidecar.profileSnapshot.systemPrompt } : {},
			...sidecar.profileId ? { profileId: sidecar.profileId } : {},
			...sidecar.status ? { status: sidecar.status } : {},
			...sidecar.usage ? { usage: sidecar.usage } : {},
			...sidecar.parentToolUseId ? { parentToolUseId: sidecar.parentToolUseId } : {}
		};
		let parentCallId = sidecar?.parentToolUseId ? String(sidecar.parentToolUseId) : void 0;
		if (parentCallId && !callIdExistsInSession(db, parentSessionId, parentCallId)) parentCallId = void 0;
		if (!parentCallId) {
			const prompt = firstUserText$1(irMessages);
			const fromPrompt = prompt ? findAgentCallByPrompt(db, parentSessionId, prompt) : void 0;
			if (fromPrompt) parentCallId = fromPrompt;
		}
		if (parentCallId) {
			usedCallIds.add(parentCallId);
			acc.agentLinks[parentCallId] = {
				childSessionId: childId,
				agentId: sidecar?.agentId ? String(sidecar.agentId) : `agent_${scUuid}`
			};
		}
		const nested = visited.has(childId) ? [] : (visited.add(childId), await buildSidechainLevel(db, childId, ctx, depth + 1, visited, acc));
		sidechains.push({
			agentId: childId,
			kind: "subagent",
			...agentType ? { agentType } : {},
			...parentCallId ? { parentMessageId: parentCallId } : {},
			messages: irMessages,
			...childToolCalls.length ? { toolCalls: childToolCalls } : {},
			...childSynthetics.length ? { meta: { "zcode.syntheticMessages": childSynthetics } } : {},
			...nested.length ? { sidechains: nested } : {}
		});
	}
	for (const [key, meta] of sidecars) if (meta.parentToolUseId && !usedCallIds.has(meta.parentToolUseId)) acc.agentLinks[meta.parentToolUseId] = {
		childSessionId: meta.childSessionId ?? `sess_subagent_${key}`,
		agentId: meta.agentId ?? key
	};
	return sidechains;
}
/** Load sidecar metadata.json files for one parent session (best-effort). */
async function loadSidecars(agentsRoot, parentSessionId) {
	const out = /* @__PURE__ */ new Map();
	const dir = join(agentsRoot, parentSessionId);
	let entries;
	try {
		entries = await promises.readdir(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (!name.startsWith("agent_")) continue;
		try {
			const raw = await promises.readFile(join(dir, name, "metadata.json"), "utf8");
			out.set(name, JSON.parse(raw));
		} catch {}
	}
	return out;
}
function callIdExistsInSession(db, sessionId, callId) {
	return !!db.prepare("SELECT 1 AS x FROM part WHERE session_id=? AND data LIKE ? LIMIT 1").get(sessionId, `%"callID":"${callId}"%`);
}
function findAgentCallByPrompt(db, parentSessionId, prompt) {
	if (prompt.length < 16) return void 0;
	const rows = db.prepare("SELECT data FROM part WHERE session_id=? AND data LIKE '%\"tool\":\"Agent\"%' LIMIT 50").all(parentSessionId);
	for (const r of rows) {
		const d = parseJsonObject(r.data);
		if (d.type !== "tool" || !isSubagentToolName(String(d.tool ?? ""))) continue;
		const input = parseJsonObject(tryParse(d.state?.input));
		const p = String(input.prompt ?? "");
		if (p && p === prompt) return String(d.callID ?? "");
	}
}
function firstUserText$1(messages) {
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
		if (text) return text;
	}
	return "";
}
/** Consistent snapshot of a live WAL db via SQLite's `VACUUM INTO`. */
async function snapshotLiveDb(srcPath, dstPath) {
	const src = await openDb$1(srcPath, true);
	if (!src) throw new Error(`Zcode: cannot snapshot live db ${srcPath} (no sqlite driver / locked)`);
	try {
		const escaped = `'${dstPath.replace(/'/g, "''")}'`;
		src.exec(`VACUUM INTO ${escaped}`);
	} finally {
		try {
			src.close();
		} catch {}
	}
}
/** Minimal session-store schema for fresh sandbox targets (hermetic tests). */
async function createMinimalDb(dbPath) {
	const db = await openDb$1(dbPath, false);
	if (!db) throw new Error(`Zcode: cannot bootstrap fresh db ${dbPath}`);
	try {
		ensureMinimalSchema(db);
	} finally {
		try {
			db.close();
		} catch {}
	}
}
function ensureMinimalSchema(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
    version TEXT NOT NULL, revert TEXT, permission TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    task_type TEXT NOT NULL, title_source TEXT NOT NULL)`);
	db.exec(`CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, sequence INTEGER)`);
	db.exec(`CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    data TEXT NOT NULL, sequence INTEGER)`);
	db.exec("CREATE INDEX IF NOT EXISTS message_session_seq ON message(session_id, sequence)");
	db.exec("CREATE INDEX IF NOT EXISTS part_message_seq ON part(message_id, sequence)");
}
function str(v) {
	return typeof v === "string" && v ? v : void 0;
}
function writeToDb$1(db, ir, newId, cwd, keepSynthetic = false) {
	const now = Date.now();
	const extensions = ir.extensions ?? {};
	const providers = extensions["zcode.providers"] ?? {};
	const agentLinks = extensions["zcode.agentLinks"] ?? {};
	const providerIds = {};
	for (const [raw, name] of Object.entries(providers)) if (typeof name === "string") providerIds[name] = raw;
	const ctx = {
		db,
		cwd,
		providerIds,
		agentLinks,
		callIdRemap: /* @__PURE__ */ new Map(),
		results: /* @__PURE__ */ new Map(),
		subagentSlots: [],
		usedChildIds: /* @__PURE__ */ new Set()
	};
	const pairedCallIds = /* @__PURE__ */ new Set();
	const collectResults = (messages) => {
		for (const msg of messages) for (const b of msg.content) if (b.type === "tool_use") pairedCallIds.add(b.id);
		for (const msg of messages) for (const b of msg.content) if (b.type === "tool_result" && b.toolUseId && pairedCallIds.has(b.toolUseId)) ctx.results.set(b.toolUseId, {
			content: b.content,
			isError: !!b.isError
		});
	};
	const collectSidechainResults = (sidechains) => {
		for (const sc of sidechains) {
			collectResults(sc.messages);
			collectSidechainResults(sc.sidechains ?? []);
		}
	};
	collectResults(ir.messages);
	collectSidechainResults(ir.sidechains ?? []);
	ctx.isOrphanResult = (toolUseId) => !toolUseId || !pairedCallIds.has(toolUseId);
	const slotBySidechain = /* @__PURE__ */ new Map();
	const scanAgentSlots = (messages, sidechains) => {
		const queue = [...sidechains];
		for (const msg of messages) for (const b of msg.content) {
			if (b.type !== "tool_use" || !isSubagentToolName(b.name)) continue;
			const callId = remapCallId(ctx, b.id);
			const slot = pickSidechainForCall(ctx, b, queue);
			if (slot) {
				ctx.subagentSlots.push({
					toolUseId: callId,
					childId: slot.childId,
					agentUuid: slot.agentUuid,
					sidechain: slot.sidechain
				});
				slotBySidechain.set(slot.sidechain, {
					toolUseId: callId,
					childId: slot.childId,
					agentUuid: slot.agentUuid
				});
			}
		}
	};
	scanAgentSlots(ir.messages, ir.sidechains ?? []);
	const createdAt = ir.createdAt && ir.createdAt > 0 ? ir.createdAt : now;
	const paths = [];
	const sessionExt = parseJsonObject(extensions["zcode.session"]);
	const sessionDefaults = {
		version: str(sessionExt.version) ?? ENGINE_VERSION,
		permission: str(sessionExt.permission) ?? DEFAULT_PERMISSION
	};
	insertSessionRow(db, {
		id: newId,
		parentId: null,
		directory: cwd,
		title: ir.title ?? "(migrated)",
		createdAt,
		updatedAt: now,
		taskType: "interactive",
		titleSource: "first_input",
		defaults: sessionDefaults
	});
	paths.push(`session:${newId}`);
	writeMessages$1(db, ir.messages, newId, ctx, createdAt, "zcode-agent", ir.toolCalls, keepSynthetic);
	const writeSessionTree = (sidechains, parentRowId) => {
		for (const sc of sidechains) {
			const claimed = slotBySidechain.get(sc);
			let childId;
			if (claimed) childId = claimed.childId;
			else {
				let identity = deriveChildIdentity(sc);
				for (let attempt = 0; attempt < 8 && (ctx.usedChildIds.has(identity.childId) || sessionIdExists(ctx.db, identity.childId)); attempt++) {
					const freshUuid = randomUUID();
					identity = {
						childId: `sess_subagent_agent_${freshUuid}`,
						agentUuid: freshUuid
					};
				}
				childId = identity.childId;
			}
			ctx.usedChildIds.add(childId);
			scanAgentSlots(sc.messages, sc.sidechains ?? []);
			const childAgent = sc.agentType ? `zcode-${sc.agentType}` : "zcode-agent";
			insertSessionRow(db, {
				id: childId,
				parentId: parentRowId,
				directory: cwd,
				title: sc.title ?? (firstUserText$1(sc.messages).split("\n")[0]?.slice(0, 120) || "(subagent)"),
				createdAt: sc.createdAt ?? createdAt,
				updatedAt: now,
				taskType: "subagent_child",
				titleSource: "first_input",
				defaults: sessionDefaults
			});
			paths.push(`session:${childId}`);
			writeMessages$1(db, sc.messages, childId, ctx, createdAt, childAgent, sc.toolCalls, keepSynthetic);
			writeSessionTree(sc.sidechains ?? [], childId);
		}
	};
	writeSessionTree(ir.sidechains ?? [], newId);
	return paths;
}
function remapCallId(ctx, foreignId) {
	const existing = ctx.callIdRemap.get(foreignId);
	if (existing) return existing;
	const fresh = freshCallId();
	ctx.callIdRemap.set(foreignId, fresh);
	return fresh;
}
function pickSidechainForCall(ctx, block, queue) {
	const chosen = matchByLink(ctx, block.id, queue) ?? matchByPrompt$1(block, queue) ?? queue[0];
	if (!chosen) return void 0;
	queue.splice(queue.indexOf(chosen), 1);
	let identity = deriveChildIdentity(chosen);
	for (let attempt = 0; attempt < 8 && (ctx.usedChildIds.has(identity.childId) || sessionIdExists(ctx.db, identity.childId)); attempt++) {
		const freshUuid = randomUUID();
		identity = {
			childId: `sess_subagent_agent_${freshUuid}`,
			agentUuid: freshUuid
		};
	}
	ctx.usedChildIds.add(identity.childId);
	return {
		...identity,
		sidechain: chosen
	};
}
function sessionIdExists(db, id) {
	return !!db.prepare("SELECT 1 AS x FROM session WHERE id=?").get(id);
}
function matchByLink(ctx, callId, queue) {
	const link = ctx.agentLinks[callId];
	if (!link) return void 0;
	return queue.find((s) => s.agentId === link.childSessionId || s.agentId === link.agentId);
}
function matchByPrompt$1(block, queue) {
	const input = block.input && typeof block.input === "object" ? block.input : {};
	const prompt = String(input.prompt ?? "");
	if (!prompt) return void 0;
	return queue.find((s) => firstUserText$1(s.messages) === prompt);
}
/** child session id follows `sess_subagent_agent_<uuid>`; agentId metadata = `agent_<same uuid>`. */
function deriveChildIdentity(sc) {
	let agentUuid;
	if (sc.agentId.startsWith("sess_subagent_agent_")) agentUuid = sc.agentId.slice(20);
	else if (sc.agentId.startsWith("agent_")) agentUuid = sc.agentId.slice(6);
	else agentUuid = randomUUID();
	return {
		childId: `sess_subagent_agent_${agentUuid}`,
		agentUuid
	};
}
function insertSessionRow(db, s) {
	const d = s.defaults ?? {};
	try {
		db.prepare("INSERT INTO session (id, parent_id, project_id, slug, directory, path, title, version, permission, time_created, time_updated, task_type, title_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(s.id, s.parentId, zcodeProjectId(s.directory || "/"), s.id, s.directory || "/", s.directory || "/", s.title, d.version ?? ENGINE_VERSION, d.permission ?? DEFAULT_PERMISSION, s.createdAt, s.updatedAt, s.taskType, s.titleSource);
	} catch (e) {
		if (String(e?.message ?? e).includes("UNIQUE")) throw new Error(`Zcode: session id ${s.id} already exists in the target db — pick a new --session-id / sandbox root instead of overwriting.`);
		throw e;
	}
}
/**
* IR messages → native message/part rows. Ordering is positional (message
* sequence 0..N-1, part sequence per message 0..M); tool_use/tool_result
* blocks are fused back into single 4-state tool parts — a matching
* `toolCalls` record (typed lossless bucket) restores the exact native state
* (status/title/metadata/time) and re-injects pending/running invocations
* that have no replayable block; ORPHAN tool_result blocks (call row gone)
* degrade to a `[tool result]` user text line instead of being dropped;
* IR `synthetic` messages are dropped by default (the engine owns its
* runtime context) and, with keepSynthetic, written as hidden
* system_reminder rows; IR system messages become hidden
* system_reminder user rows; role:'tool' messages carry no row of their own
* (results live in the tool parts).
*/
function writeMessages$1(db, messages, sessionId, ctx, baseTime, defaultAgent, toolCalls, keepSynthetic = false) {
	let sequence = 0;
	let prevId = null;
	let clock = baseTime;
	const recordByCallId = new Map((toolCalls ?? []).map((t) => [t.callId, t]));
	const nonReplayable = (toolCalls ?? []).filter((t) => t.status === "pending" || t.status === "running");
	for (const msg of messages) {
		clock += 1;
		const ts = msg.timestamp && msg.timestamp > 0 ? msg.timestamp : clock;
		const zmeta = zcodeMetaOf(msg);
		if (msg.role === "tool") continue;
		if (msg.synthetic === true && !zmeta?.semantics && !keepSynthetic) continue;
		if (msg.role === "user" || msg.role === "system" || msg.role === "developer") {
			const isSystem = (msg.role === "system" || msg.role === "developer") && !zmeta?.semantics;
			const isSummary = !isSystem && !!(zmeta?.summary || zmeta?.semantics?.kind === "compact_summary");
			const textBlocks = msg.content.filter((b) => b.type === "text");
			const fileBlocks = msg.content.filter((b) => b.type === "file");
			const orphanText = msg.content.filter((b) => b.type === "tool_result" && !!ctx.isOrphanResult?.(b.toolUseId)).map((b) => `[tool result] ${b.content}`).join("\n");
			const textContent = textBlocks.length ? textBlocks : [];
			if (!textContent.length && !fileBlocks.length && !isSummary && !orphanText) continue;
			const parts = textContent.map((b) => ({
				data: {
					type: "text",
					text: b.text,
					time: {
						start: ts,
						end: ts
					}
				},
				ts
			}));
			if (orphanText) parts.push({
				data: {
					type: "text",
					text: orphanText,
					time: {
						start: ts,
						end: ts
					}
				},
				ts
			});
			for (const b of fileBlocks) parts.push({
				data: {
					type: "file",
					...b.filename ? { filename: b.filename } : {},
					...b.mediaType ? { mime: b.mediaType } : {},
					...b.url ? { url: b.url } : {},
					...b.data ? { data: b.data } : {}
				},
				ts
			});
			appendRawParts(parts, zmeta, ts);
			const isSynthetic = msg.synthetic === true;
			const data = {
				role: "user",
				time: { created: ts },
				agent: zmeta?.agent ?? defaultAgent,
				semantics: zmeta?.semantics ? zmeta.semantics : isSystem || isSynthetic ? {
					origin: "system",
					kind: "system_reminder",
					uiVisibility: "hidden",
					providerVisibility: "visible",
					transcriptVisibility: "hidden"
				} : {
					origin: "real_user",
					kind: "user_prompt",
					uiVisibility: "visible",
					providerVisibility: "visible",
					transcriptVisibility: "visible"
				},
				anchor: zmeta?.anchor ?? {
					turnId: `turn_${randomUUID()}`,
					origin: isSystem || isSynthetic ? "system" : "realUser"
				}
			};
			if (isSummary || zmeta?.summary) data.summary = zmeta?.summary ?? { body: [...textContent, ...orphanText ? [{ text: orphanText }] : []].map((b) => b.text).join("\n") };
			if (zmeta?.contextSnapshot) data.contextSnapshot = zmeta.contextSnapshot;
			if (zmeta?.tools) data.tools = zmeta.tools;
			if (zmeta?.metadata) data.metadata = zmeta.metadata;
			if (zmeta?.synthetic) data.synthetic = true;
			if (zmeta?.source) data.source = zmeta.source;
			if (zmeta?.visibility) data.visibility = zmeta.visibility;
			if (isSynthetic) data.synthetic = true;
			if (!isSystem) {
				const model = zmeta?.modelID ? {
					modelID: zmeta.modelID,
					...zmeta.providerID ? { providerID: zmeta.providerID } : {},
					...zmeta.variant ? { variant: zmeta.variant } : {}
				} : resolveProviderModel(msg, ctx);
				if (model) data.model = {
					providerID: model.providerID,
					modelID: model.modelID,
					...model.variant ? { variant: model.variant } : {}
				};
			}
			const userId = insertMessageWithParts(db, sessionId, sequence, ts, data, parts);
			sequence += 1;
			prevId = userId;
			continue;
		}
		const toolUses = msg.content.filter((b) => b.type === "tool_use");
		const parts = [];
		for (const b of msg.content) if (b.type === "text") parts.push({
			data: {
				type: "text",
				text: b.text,
				time: {
					start: ts,
					end: ts
				}
			},
			ts
		});
		else if (b.type === "thinking") {
			const rdata = {
				type: "reasoning",
				text: b.thinking,
				time: {
					start: ts,
					end: ts
				}
			};
			if (b.signature) rdata.metadata = { anthropic: { signature: b.signature } };
			parts.push({
				data: rdata,
				ts
			});
		} else if (b.type === "file") parts.push({
			data: {
				type: "file",
				...b.filename ? { filename: b.filename } : {},
				...b.mediaType ? { mime: b.mediaType } : {},
				...b.url ? { url: b.url } : {},
				...b.data ? { data: b.data } : {}
			},
			ts
		});
		else if (b.type === "tool_use") {
			const callId = isSubagentToolName(b.name) ? remapCallId(ctx, b.id) : looksLikeCallId(b.id) ? b.id : remapCallId(ctx, b.id);
			const record = recordByCallId.get(b.id) ?? recordByCallId.get(callId);
			const result = ctx.results.get(b.id) ?? ctx.results.get(callId);
			const hasResult = result !== void 0 || record && record.status !== "pending" && record.status !== "running";
			const state = {
				status: hasResult ? record?.status ?? (result?.isError ? "error" : "completed") : "pending",
				input: record?.input !== void 0 ? record.input : b.input && typeof b.input === "object" ? b.input : tryParse(b.input),
				...hasResult ? { title: record?.title ?? b.name } : {},
				time: record?.time ?? {
					start: ts,
					end: ts + 1
				}
			};
			if (!hasResult) state.raw = "";
			else if (state.status === "error") state.error = record?.error ?? result?.content ?? "tool call failed";
			else state.output = record?.output ?? result?.content ?? "";
			const metadata = {
				schemaVersion: 1,
				...record?.metadata ?? {}
			};
			if (isSubagentToolName(b.name)) {
				const slot = ctx.subagentSlots.find((s) => s.toolUseId === callId);
				if (slot) {
					metadata.agentId = `agent_${slot.agentUuid}`;
					if (typeof state.output === "string" && state.output.includes("agentId:")) state.output = rewriteLaunchAck(state.output, slot.agentUuid);
				}
			}
			state.metadata = metadata;
			parts.push({
				data: {
					type: "tool",
					callID: callId,
					tool: b.name,
					state
				},
				ts
			});
		}
		const reinject = [];
		if (msg.seq !== void 0) for (const rec of nonReplayable) {
			if (rec.source?.messageSequence !== msg.seq) continue;
			const state = {
				status: rec.status,
				...rec.input !== void 0 ? { input: rec.input } : {},
				...rec.title ? { title: rec.title } : {},
				...rec.time ? { time: rec.time } : {},
				metadata: {
					schemaVersion: 1,
					...rec.metadata ?? {}
				}
			};
			reinject.push({
				seq: rec.source.partSequence,
				data: {
					type: "tool",
					callID: rec.callId,
					tool: rec.tool,
					state
				}
			});
		}
		for (const rp of zmeta?.rawParts ?? []) reinject.push({
			seq: typeof rp.sequence === "number" ? rp.sequence : Number.MAX_SAFE_INTEGER,
			data: rp.data
		});
		reinject.sort((a, b) => a.seq - b.seq);
		for (const r of reinject) parts.push({
			data: r.data,
			ts
		});
		if (!parts.length) continue;
		const ztime = zmeta?.time && typeof zmeta.time === "object" ? zmeta.time : void 0;
		const data = {
			role: "assistant",
			time: {
				created: typeof ztime?.created === "number" ? ztime.created : ts,
				completed: typeof ztime?.completed === "number" ? ztime.completed : ts + 1
			},
			mode: zmeta?.mode ?? "build",
			agent: zmeta?.agent ?? defaultAgent,
			path: {
				cwd: ctx.cwd,
				root: ctx.cwd
			},
			cost: typeof zmeta?.cost === "number" ? zmeta.cost : 0,
			tokens: zmeta?.tokens ?? {
				input: 0,
				output: 0,
				reasoning: 0,
				cache: {
					read: 0,
					write: 0
				}
			},
			finish: zmeta?.finish !== void 0 ? zmeta.finish : normalizeFinish(msg, toolUses.length > 0),
			semantics: zmeta?.semantics ?? {
				origin: "agent_runtime",
				kind: "assistant_response",
				uiVisibility: "visible",
				providerVisibility: "visible",
				transcriptVisibility: "visible"
			}
		};
		if (prevId) data.parentID = prevId;
		const model = zmeta?.modelID ? {
			modelID: zmeta.modelID,
			...zmeta.providerID ? { providerID: zmeta.providerID } : {}
		} : resolveProviderModel(msg, ctx);
		if (model) {
			data.modelID = model.modelID;
			if (model.providerID) data.providerID = model.providerID;
		}
		if (zmeta?.variant) data.variant = zmeta.variant;
		insertMessageWithParts(db, sessionId, sequence, ts, data, parts);
		sequence += 1;
	}
}
function insertMessageWithParts(db, sessionId, sequence, ts, data, parts) {
	const messageId = `msg_${base36(ts)}_${randomUUID()}`;
	db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(messageId, sessionId, ts, ts, JSON.stringify(data), sequence);
	let pIndex = 0;
	for (const p of parts) {
		db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(`part_${base36(p.ts)}_${randomUUID()}`, messageId, sessionId, p.ts, p.ts, JSON.stringify(p.data), pIndex);
		pIndex += 1;
	}
	return messageId;
}
/** Resolve {providerID, modelID, variant} for a message, tolerating missing info. */
function resolveProviderModel(msg, ctx) {
	if (!msg.model) return void 0;
	let providerId;
	if (msg.provider) {
		if (ctx.providerIds[msg.provider]) providerId = ctx.providerIds[msg.provider];
		else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.provider) || msg.provider.startsWith("builtin:")) providerId = msg.provider;
	}
	return {
		modelID: msg.model,
		...providerId ? { providerID: providerId } : {}
	};
}
/** Rewrite the launch-acknowledgement footer's agent id to the migrated child's uuid. */
function rewriteLaunchAck(output, agentUuid) {
	return output.replace(/(^|\n)agentId:\s*agent_[0-9a-fA-F-]+/g, (_m, p1) => `${p1}agentId: agent_${agentUuid}`).replace(/to:\s*['"]agent_[0-9a-fA-F-]+['"]/g, `to: 'agent_${agentUuid}'`);
}
function normalizeFinish(msg, hasToolUse) {
	const known = /* @__PURE__ */ new Set([
		"tool-calls",
		"stop",
		"completed",
		"failed"
	]);
	if (msg.stopReason && known.has(msg.stopReason)) return msg.stopReason;
	return hasToolUse ? "tool-calls" : "stop";
}
//#endregion
//#region ../core/dist/src/adapters/pi/index.js
/**
* Pi adapter — reads/writes `~/.pi/agent/sessions/--<path>--/<ts>_<uuid>.jsonl`.
*
* Rewritten 2026-09-02 against the pi-main 0.84.3 deep-dive contract
* (docs/agents/pi.md — binding). Highlights:
*  - Read side is ZERO-DROP (v3「除加密外零丢弃」): all ten v3 entry types
*    project into the IR (messages/compaction/branchSummaries/title/meta.pi.*).
*    The seven pi message roles all project explicitly (bashExecution/custom/
*    branchSummary/compactionSummary never fall through); assistant fields with
*    no IR slot ride `meta.pi.message` on the message entity.
*  - Leaf path = walk `parentId` from the LAST ENTRY in the file (pi's
*    `_buildIndex` semantics), not the last *message* entry; off-path message
*    entries group into sidechains by branch root.
*  - compaction/branch_summary are dual-carrier (anchor contract): bucket
*    entry + a synthetic user message in messages[] rendered with pi's native
*    prefix/suffix; `anchorIndex` ties them. Write-back consumes the bucket and
*    SKIPS the anchor message (no double write).
*  - Write side consumes ir.compaction/ir.branchSummaries into native entries.
*    Compaction `firstKeptEntryId` must point at an entry id that exists in the
*    file (a fabricated pointer degrades buildContextEntries to the tail); the
*    anchor message's own entry id is skipped. Cross-tool folded spans are
*    archived in full (选 3, pi.md §8.2 — never fabricate a cut point).
*  - System prompt: pi session files store no prompt text (runtime rebuilds
*    from SYSTEM.md/APPEND_SYSTEM.md/AGENTS.md, pi.md §9). Read side leaves
*    `ir.systemPrompt` empty; write side NEVER injects it (double-stack ban).
*  - v4 harness files (`kind:'header'` first line) are detected and refused
*    with an explicit "unsupported" error — never silently dropped or
*    half-parsed (pi.md §7). Legacy v1/v2 files get the same explicit refusal
*    (open in pi once to migrate, then re-export).
*  - IR shape additions (additive, namespace-internal optional fields — no
*    IR_VERSION bump per ir-protocol v3.3 precedent, shapes stay inside the
*    meta.pi namespace):
*    · `meta.pi.labels[].anchorIndex` — messages[] index of the entry the
*      label's targetId names. The write side mints fresh entry ids, so the
*      source id alone can never re-anchor a label; position is the pointer.
*    · `compaction[].meta.pi.firstKeptIndex` — messages[] index the native
*      cut point (firstKeptEntryId) maps to; write-back maps it to the new
*      entry id instead of synthesizing the compaction's parent (which
*      would shrink the active surface by one message).
*  - Red lines: read-only on source files (never pi's own `open` chain — it
*    rewrites old files in place); no unlink/rm/trash anywhere; writes go to a
*    brand-new file created exclusively (`wx`).
*/
const PI_CURRENT_VERSION = 3;
/** pi's own context renderings (messages.ts:11-24) — the anchor message text must be byte-faithful to what pi's convertToLlm produces. */
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `</summary>`;
function piProjectKey(cwd) {
	return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}
function generateId(existing) {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!existing.has(id)) return id;
	}
	return randomUUID().slice(0, 8);
}
function toEpochMs(iso) {
	if (typeof iso !== "string" || !iso) return void 0;
	const t = new Date(iso).getTime();
	return Number.isFinite(t) ? t : void 0;
}
function isRecord(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
var PiAdapter = class {
	tool = "pi";
	irVersion = "3.3";
	async parse(sessionId, root) {
		const sessionsDir = root ?? defaultPiSessionsDir();
		if (!sessionsDir) throw new Error("Pi: cannot resolve ~/.pi/agent/sessions");
		const path = await findPiFile(sessionsDir, sessionId);
		if (!path) throw new Error(`Pi: session "${sessionId}" not found under ${sessionsDir}`);
		return parsePiFile(path);
	}
	async write(ir, opts) {
		validateSession(ir);
		const sessionsDir = opts?.root ?? defaultPiSessionsDir();
		if (!sessionsDir) throw new Error("Pi: cannot resolve ~/.pi/agent/sessions");
		const cwd = opts?.targetCwd ?? ir.cwd ?? "";
		ir.systemPrompt;
		const newId = opts?.sessionId ?? randomUUID();
		const iso = new Date(ir.createdAt ?? Date.now()).toISOString();
		const fileTs = iso.replace(/[:.]/g, "-");
		const projectDir = join(sessionsDir, piProjectKey(cwd));
		await promises.mkdir(projectDir, { recursive: true });
		const filePath = join(projectDir, `${fileTs}_${newId}.jsonl`);
		const header = {
			type: "session",
			version: PI_CURRENT_VERSION,
			id: newId,
			timestamp: iso,
			cwd: cwd || ""
		};
		const piHeaderMeta = ir.meta?.pi;
		const parentSession = typeof piHeaderMeta?.header?.parentSession === "string" ? piHeaderMeta.header.parentSession : void 0;
		if (parentSession) header.parentSession = parentSession;
		const byId = /* @__PURE__ */ new Set();
		const lines = [JSON.stringify(header)];
		let parentId = null;
		const appendLine = (entry) => {
			lines.push(JSON.stringify(entry));
		};
		const nextId = () => {
			const id = generateId(byId);
			byId.add(id);
			return id;
		};
		const entryTimestamp = (t, fallback = ir.createdAt ?? Date.now()) => new Date(typeof t === "number" && Number.isFinite(t) ? t : fallback).toISOString();
		const compactionByAnchor = /* @__PURE__ */ new Map();
		for (const c of ir.compaction ?? []) if (typeof c.anchorIndex === "number") compactionByAnchor.set(c.anchorIndex, c);
		const branchByAnchor = /* @__PURE__ */ new Map();
		for (const bs of ir.branchSummaries ?? []) if (typeof bs.anchorIndex === "number") branchByAnchor.set(bs.anchorIndex, bs);
		const writeMessages = !ir.messages.some((m) => m.role === "assistant") ? [...ir.messages, {
			role: "assistant",
			content: [{
				type: "text",
				text: "(migrated session — continuation)"
			}]
		}] : ir.messages;
		const entryIdByMsgIdx = /* @__PURE__ */ new Map();
		for (const [msgIdx, msg] of writeMessages.entries()) {
			if (!(msg.meta?.pi)?.anchor) {
				const id = nextId();
				entryIdByMsgIdx.set(msgIdx, id);
				appendLine({
					type: "message",
					id,
					parentId,
					timestamp: entryTimestamp(msg.timestamp),
					message: piMessageFromMigrated(msg)
				});
				parentId = id;
			}
			const comp = compactionByAnchor.get(msgIdx);
			if (comp) {
				const cid = nextId();
				const cMeta = comp.meta;
				const nativeFirstKept = cMeta?.firstKeptIndex !== void 0 ? entryIdByMsgIdx.get(cMeta.firstKeptIndex) : void 0;
				appendLine({
					type: "compaction",
					id: cid,
					parentId,
					timestamp: cMeta?.entryTimestamp ?? entryTimestamp(msg.timestamp),
					summary: comp.summary,
					firstKeptEntryId: nativeFirstKept ?? parentId,
					tokensBefore: typeof comp.tokensBefore === "number" ? comp.tokensBefore : 0,
					...cMeta?.details !== void 0 ? { details: cMeta.details } : {},
					...cMeta?.usage !== void 0 ? { usage: cMeta.usage } : {},
					...cMeta?.fromHook !== void 0 ? { fromHook: cMeta.fromHook } : {}
				});
				parentId = cid;
			}
			const bs = branchByAnchor.get(msgIdx);
			if (bs) {
				const bid = nextId();
				const bMeta = bs.meta;
				appendLine({
					type: "branch_summary",
					id: bid,
					parentId,
					timestamp: bMeta?.entryTimestamp ?? entryTimestamp(msg.timestamp),
					fromId: bs.fromId,
					summary: bs.summary,
					...bMeta?.details !== void 0 ? { details: bMeta.details } : {},
					...bMeta?.usage !== void 0 ? { usage: bMeta.usage } : {},
					...bMeta?.fromHook !== void 0 ? { fromHook: bMeta.fromHook } : {}
				});
				parentId = bid;
			}
		}
		const settingsEvents = piHeaderMeta?.settingsEvents;
		let sessionInfoReplayed = false;
		if (Array.isArray(settingsEvents) && settingsEvents.length > 0) for (const ev of settingsEvents) {
			if (!isRecord(ev)) continue;
			const time = typeof ev.time === "number" ? ev.time : void 0;
			if (ev.type === "model_change" && typeof ev.provider === "string" && typeof ev.modelId === "string") {
				const id = nextId();
				appendLine({
					type: "model_change",
					id,
					parentId,
					timestamp: entryTimestamp(time),
					provider: ev.provider,
					modelId: ev.modelId
				});
				parentId = id;
			} else if (ev.type === "thinking_level_change" && typeof ev.thinkingLevel === "string") {
				const id = nextId();
				appendLine({
					type: "thinking_level_change",
					id,
					parentId,
					timestamp: entryTimestamp(time),
					thinkingLevel: ev.thinkingLevel
				});
				parentId = id;
			} else if (ev.type === "session_info") {
				const id = nextId();
				const name = typeof ev.name === "string" ? ev.name : "";
				appendLine({
					type: "session_info",
					id,
					parentId,
					timestamp: entryTimestamp(time),
					name
				});
				parentId = id;
				sessionInfoReplayed = true;
			}
		}
		else {
			if (ir.thinkingLevel) {
				const id = nextId();
				appendLine({
					type: "thinking_level_change",
					id,
					parentId,
					timestamp: entryTimestamp(void 0),
					thinkingLevel: ir.thinkingLevel
				});
				parentId = id;
			}
			if (ir.model?.provider || ir.model?.id) {
				const id = nextId();
				appendLine({
					type: "model_change",
					id,
					parentId,
					timestamp: entryTimestamp(void 0),
					provider: ir.model.provider ?? "unknown",
					modelId: ir.model.id ?? "unknown"
				});
				parentId = id;
			}
		}
		if (ir.sidechains?.length) {
			const mainFirstId = entryIdByMsgIdx.get(0) ?? null;
			for (const sc of ir.sidechains) {
				const scMeta = sc.meta?.pi;
				const scCompByAnchor = /* @__PURE__ */ new Map();
				for (const c of sc.compaction ?? []) if (typeof c.anchorIndex === "number") scCompByAnchor.set(c.anchorIndex, c);
				const scBranchByAnchor = /* @__PURE__ */ new Map();
				for (const bs of scMeta?.branchSummaries ?? []) if (typeof bs.anchorIndex === "number") scBranchByAnchor.set(bs.anchorIndex, bs);
				const scIdByPos = /* @__PURE__ */ new Map();
				if (!sc.messages.length) continue;
				let branchParent = mainFirstId;
				let branchLeaf = branchParent;
				for (const [pos, msg] of sc.messages.entries()) {
					if (!(msg.meta?.pi)?.anchor) {
						const bid = nextId();
						scIdByPos.set(pos, bid);
						appendLine({
							type: "message",
							id: bid,
							parentId: branchParent,
							timestamp: entryTimestamp(msg.timestamp),
							message: piMessageFromMigrated(msg)
						});
						branchParent = bid;
						branchLeaf = bid;
					}
					const comp = scCompByAnchor.get(pos);
					if (comp) {
						const cid = nextId();
						const cMeta = comp.meta;
						const nativeFirstKept = cMeta?.firstKeptIndex !== void 0 ? scIdByPos.get(cMeta.firstKeptIndex) : void 0;
						appendLine({
							type: "compaction",
							id: cid,
							parentId: branchParent,
							timestamp: cMeta?.entryTimestamp ?? entryTimestamp(msg.timestamp),
							summary: comp.summary,
							firstKeptEntryId: nativeFirstKept ?? branchParent,
							tokensBefore: typeof comp.tokensBefore === "number" ? comp.tokensBefore : 0,
							...cMeta?.details !== void 0 ? { details: cMeta.details } : {},
							...cMeta?.usage !== void 0 ? { usage: cMeta.usage } : {},
							...cMeta?.fromHook !== void 0 ? { fromHook: cMeta.fromHook } : {}
						});
						branchParent = cid;
						branchLeaf = cid;
					}
					const bs = scBranchByAnchor.get(pos);
					if (bs) {
						const bid2 = nextId();
						const bMeta = bs.meta;
						appendLine({
							type: "branch_summary",
							id: bid2,
							parentId: branchParent,
							timestamp: bMeta?.entryTimestamp ?? entryTimestamp(msg.timestamp),
							fromId: bs.fromId,
							summary: bs.summary,
							...bMeta?.details !== void 0 ? { details: bMeta.details } : {},
							...bMeta?.usage !== void 0 ? { usage: bMeta.usage } : {},
							...bMeta?.fromHook !== void 0 ? { fromHook: bMeta.fromHook } : {}
						});
						branchParent = bid2;
						branchLeaf = bid2;
					}
				}
				for (const ev of scMeta?.settingsEvents ?? []) {
					if (!isRecord(ev)) continue;
					const time = typeof ev.time === "number" ? ev.time : void 0;
					if (ev.type === "model_change" && typeof ev.provider === "string" && typeof ev.modelId === "string") {
						const id = nextId();
						appendLine({
							type: "model_change",
							id,
							parentId: branchParent,
							timestamp: entryTimestamp(time),
							provider: ev.provider,
							modelId: ev.modelId
						});
						branchParent = id;
						branchLeaf = id;
					} else if (ev.type === "thinking_level_change" && typeof ev.thinkingLevel === "string") {
						const id = nextId();
						appendLine({
							type: "thinking_level_change",
							id,
							parentId: branchParent,
							timestamp: entryTimestamp(time),
							thinkingLevel: ev.thinkingLevel
						});
						branchParent = id;
						branchLeaf = id;
					} else if (ev.type === "session_info" && typeof ev.name === "string") {
						const id = nextId();
						appendLine({
							type: "session_info",
							id,
							parentId: branchParent,
							timestamp: entryTimestamp(time),
							name: ev.name
						});
						branchParent = id;
						branchLeaf = id;
					}
				}
				for (const l of scMeta?.labels ?? []) {
					if (!isRecord(l) || typeof l.targetId !== "string") continue;
					const remap = l.anchorIndex !== void 0 ? scIdByPos.get(l.anchorIndex) : void 0;
					if (!remap) continue;
					const id = nextId();
					appendLine({
						type: "label",
						id,
						parentId: branchParent,
						timestamp: entryTimestamp(l.time),
						targetId: remap,
						label: typeof l.label === "string" && l.label ? l.label : null
					});
					branchParent = id;
					branchLeaf = id;
				}
				for (const ce of scMeta?.customEntries ?? []) {
					if (!isRecord(ce) || typeof ce.customType !== "string") continue;
					const id = nextId();
					appendLine({
						type: "custom",
						id,
						parentId: branchParent,
						timestamp: entryTimestamp(ce.time),
						customType: ce.customType,
						...ce.data !== void 0 ? { data: ce.data } : {}
					});
					branchParent = id;
					branchLeaf = id;
				}
				const sid = nextId();
				const summaryText = sc.agentType ? `sidechain ${sc.agentId} (${sc.agentType})` : `sidechain ${sc.agentId} (${sc.kind})`;
				appendLine({
					type: "branch_summary",
					id: sid,
					parentId: branchLeaf,
					timestamp: entryTimestamp(sc.createdAt),
					fromId: branchLeaf ?? sid,
					summary: summaryText
				});
			}
		}
		const labels = piHeaderMeta?.labels;
		if (Array.isArray(labels)) for (const l of labels) {
			if (!isRecord(l)) continue;
			const anchor = typeof l.anchorIndex === "number" ? entryIdByMsgIdx.get(l.anchorIndex) : void 0;
			if (!anchor) {
				if (typeof l.targetId === "string" && l.targetId) console.warn(`[pi write] label targeting entry ${l.targetId} has no anchorIndex mapping — kept in IR, not written (pi rejects dangling label targets)`);
				continue;
			}
			const id = nextId();
			const labelEntry = {
				type: "label",
				id,
				parentId,
				timestamp: entryTimestamp(l.time),
				targetId: anchor,
				label: void 0
			};
			labelEntry.label = typeof l.label === "string" && l.label ? l.label : null;
			appendLine(labelEntry);
			parentId = id;
		}
		const customEntries = piHeaderMeta?.customEntries;
		if (Array.isArray(customEntries)) for (const ce of customEntries) {
			if (!isRecord(ce) || typeof ce.customType !== "string") continue;
			const id = nextId();
			appendLine({
				type: "custom",
				id,
				parentId,
				timestamp: entryTimestamp(ce.time),
				customType: ce.customType,
				...ce.data !== void 0 ? { data: ce.data } : {}
			});
			parentId = id;
		}
		if (!sessionInfoReplayed) {
			if (ir.title) {
				const id = nextId();
				appendLine({
					type: "session_info",
					id,
					parentId,
					timestamp: entryTimestamp(void 0),
					name: ir.title
				});
				parentId = id;
			} else if (piHeaderMeta?.titleCleared === true) {
				const id = nextId();
				appendLine({
					type: "session_info",
					id,
					parentId,
					timestamp: entryTimestamp(void 0),
					name: ""
				});
				parentId = id;
			}
		}
		await promises.writeFile(filePath, lines.join("\n") + "\n", {
			encoding: "utf8",
			flag: "wx"
		});
		return {
			tool: "pi",
			sessionId: newId,
			paths: [filePath]
		};
	}
	async listSessions(root) {
		const sessionsDir = root ?? defaultPiSessionsDir();
		if (!sessionsDir) return [];
		const metas = [];
		let projects;
		try {
			projects = await promises.readdir(sessionsDir);
		} catch {
			return [];
		}
		for (const proj of projects) {
			const projDir = join(sessionsDir, proj);
			let entries;
			try {
				entries = await promises.readdir(projDir);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.endsWith(".jsonl")) continue;
				const full = join(projDir, name);
				try {
					const st = await promises.stat(full);
					const under = name.lastIndexOf("_");
					const sid = under >= 0 ? name.slice(under + 1, -6) : name.slice(0, -6);
					metas.push({
						tool: "pi",
						sessionId: sid,
						createdAt: st.mtimeMs,
						sourcePath: full
					});
				} catch {}
			}
		}
		return metas;
	}
	preview(session) {
		const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join("\n\n");
		if (!session.sidechains?.length) return main;
		return `${main}\n\n${session.sidechains.map((sc) => `[sidechain: ${sc.agentId} (${sc.kind})]\n${sc.messages.map((m) => blocksToText(m.content)).join("\n")}`).join("\n\n")}`;
	}
};
function defaultPiSessionsDir() {
	const override = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (override && override.trim()) return override.trim();
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir && agentDir.trim()) return join(agentDir.trim(), "sessions");
	const home = process.env.HOME || (process.env.USERPROFILE ?? null);
	if (!home) return null;
	return join(home, ".pi", "agent", "sessions");
}
async function findPiFile(sessionsDir, sessionId) {
	let projects;
	try {
		projects = await promises.readdir(sessionsDir);
	} catch {
		return null;
	}
	for (const proj of projects) {
		const projDir = join(sessionsDir, proj);
		let files;
		try {
			files = await promises.readdir(projDir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const under = f.lastIndexOf("_");
			if ((under >= 0 ? f.slice(under + 1, -6) : f.slice(0, -6)) === sessionId) return join(projDir, f);
		}
	}
	return null;
}
/**
* pi's context renderings of bash executions (messages.ts:82 bashExecutionToText)
* — the anchor/projection text must be identical to what pi itself feeds the LLM.
*/
function bashExecutionToText(msg) {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) text += `\`\`\`\n${msg.output}\n\`\`\``;
	else text += "(no output)";
	if (msg.cancelled) text += "\n\n(command cancelled)";
	else if (typeof msg.exitCode === "number" && msg.exitCode !== 0) text += `\n\nCommand exited with code ${msg.exitCode}`;
	if (msg.truncated && msg.fullOutputPath) text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	return text;
}
/**
* One pi message payload → IR. The seven pi roles each get an explicit branch
* (pi.md §3 — no fall-through):
*  - user/assistant fold via the shared block vocabulary (toolCall→tool_use,
*    message-level pairing ids restored on toolResult);
*  - bashExecution/custom → user rows (their native context shape) with the
*    full native payload preserved under meta.pi + synthetic:true;
*  - branchSummary/compactionSummary DO NOT project here — their entry-level
*    twins go through the anchor path (entryToAnchorMessage); a stray message
*    entry carrying one of these roles (hand-edited / extension-injected)
*    degrades to a user text row rather than being dropped.
*/
function piMessageToIr(raw, entryMeta) {
	const ts = typeof raw.timestamp === "number" ? raw.timestamp : void 0;
	const role = raw.role;
	if (role === "toolResult") {
		const inner = normalizeContent(Array.isArray(raw.content) ? raw.content : typeof raw.content === "string" ? [{
			type: "text",
			text: raw.content
		}] : []);
		const text = inner.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		const attachments = inner.filter((b) => b.type === "file");
		const block = {
			type: "tool_result",
			toolUseId: String(raw.toolCallId ?? ""),
			content: text,
			isError: raw.isError === true
		};
		if (attachments.length) block.attachments = attachments;
		const msg = {
			role: "tool",
			content: [block]
		};
		if (ts !== void 0) msg.timestamp = ts;
		const meta = {};
		if (typeof raw.toolName === "string" && raw.toolName) meta.toolName = raw.toolName;
		if (raw.details !== void 0) meta.details = raw.details;
		if (raw.usage !== void 0) meta.usage = raw.usage;
		if (raw.addedToolNames !== void 0) meta.addedToolNames = raw.addedToolNames;
		if (Object.keys(meta).length) msg.meta = { pi: meta };
		return msg;
	}
	if (role === "bashExecution") {
		const msg = {
			role: "user",
			content: [{
				type: "text",
				text: bashExecutionToText({
					command: String(raw.command ?? ""),
					output: String(raw.output ?? ""),
					exitCode: typeof raw.exitCode === "number" ? raw.exitCode : void 0,
					cancelled: raw.cancelled === true,
					truncated: raw.truncated === true,
					fullOutputPath: typeof raw.fullOutputPath === "string" ? raw.fullOutputPath : void 0
				})
			}]
		};
		if (ts !== void 0) msg.timestamp = ts;
		msg.synthetic = true;
		const bash = {};
		for (const key of [
			"command",
			"output",
			"exitCode",
			"cancelled",
			"truncated",
			"fullOutputPath",
			"excludeFromContext"
		]) if (raw[key] !== void 0) bash[key] = raw[key];
		msg.meta = { pi: { bash } };
		return msg;
	}
	if (role === "custom") {
		const content = normalizeContent((Array.isArray(raw.content) ? raw.content : typeof raw.content === "string" ? [{
			type: "text",
			text: raw.content
		}] : []).map(foldPiBlock));
		if (!content.length) return null;
		const msg = {
			role: "user",
			content
		};
		if (ts !== void 0) msg.timestamp = ts;
		msg.synthetic = true;
		const customMessage = {};
		if (typeof raw.customType === "string") customMessage.customType = raw.customType;
		if (raw.display !== void 0) customMessage.display = raw.display;
		if (raw.details !== void 0) customMessage.details = raw.details;
		msg.meta = { pi: { customMessage } };
		return msg;
	}
	if (role === "branchSummary" || role === "compactionSummary") {
		const summary = typeof raw.summary === "string" ? raw.summary : "";
		const msg = {
			role: "user",
			content: [{
				type: "text",
				text: role === "compactionSummary" ? COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX : BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX
			}]
		};
		if (ts !== void 0) msg.timestamp = ts;
		msg.synthetic = true;
		const stray = { kind: role };
		if (summary) stray.summary = summary;
		if (role === "compactionSummary" && typeof raw.tokensBefore === "number") stray.tokensBefore = raw.tokensBefore;
		msg.meta = { pi: { straySummary: stray } };
		return msg;
	}
	const irRole = role === "user" ? "user" : "assistant";
	const content = normalizeContent((Array.isArray(raw.content) ? raw.content : typeof raw.content === "string" ? [{
		type: "text",
		text: raw.content
	}] : []).map(foldPiBlock));
	if (!content.length && !entryMeta) return null;
	const msg = {
		role: irRole,
		content: content.length ? content : []
	};
	if (ts !== void 0) msg.timestamp = ts;
	if (typeof raw.provider === "string") msg.provider = raw.provider;
	if (typeof raw.model === "string") msg.model = raw.model;
	if (typeof raw.stopReason === "string") msg.stopReason = raw.stopReason;
	if (irRole === "assistant") {
		const native = {};
		for (const key of [
			"api",
			"responseModel",
			"responseId",
			"deferred",
			"errorMessage",
			"rawStopReason",
			"endTurn",
			"diagnostics",
			"usage"
		]) if (raw[key] !== void 0) native[key] = raw[key];
		if (Object.keys(native).length) msg.meta = { pi: { message: native } };
	}
	return msg;
}
/** pi {type:'toolCall', id, name, arguments} → generic tool_use block. */
function foldPiBlock(b) {
	if (typeof b === "object" && b !== null && !Array.isArray(b)) {
		const rec = b;
		if (rec.type === "toolCall") return {
			type: "tool_use",
			id: String(rec.id ?? ""),
			name: String(rec.name ?? "tool"),
			input: rec.arguments
		};
	}
	return b;
}
async function parsePiFile(path) {
	const rawLines = (await promises.readFile(path, "utf8")).split("\n");
	const entries = [];
	for (const line of rawLines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {}
	}
	const first = entries[0];
	if (!first || first.kind === "header") throw new Error(`Pi: "${path}" uses the v4 harness session format (kind:'header'), which is not supported yet — skipping explicitly`);
	if (!isRecord(first) || first.type !== "session") throw new Error(`Pi: "${path}" has no v3 session header as its first line — not a pi session file`);
	const header = first;
	const version = typeof header.version === "number" ? header.version : 1;
	if (version < PI_CURRENT_VERSION) throw new Error(`Pi: "${path}" is a legacy v${version} session file (current is v${PI_CURRENT_VERSION}) — not supported; open it in pi once to let pi migrate it in place, then re-export`);
	const sessionEntries = entries.slice(1).filter((e) => e.type !== "session");
	const cwd = header.cwd;
	const createdAt = toEpochMs(header.timestamp);
	const originSessionId = header.id;
	const byId = /* @__PURE__ */ new Map();
	for (const e of sessionEntries) if (e.id) byId.set(e.id, e);
	const leafId = sessionEntries.length ? sessionEntries[sessionEntries.length - 1].id ?? null : null;
	const leafPath = /* @__PURE__ */ new Set();
	{
		let cur = leafId ? byId.get(leafId) : void 0;
		while (cur?.id) {
			leafPath.add(cur.id);
			cur = cur.parentId ? byId.get(cur.parentId) : void 0;
		}
	}
	const mainPath = [];
	{
		const chain = [];
		let cur = leafId ? byId.get(leafId) : void 0;
		while (cur) {
			chain.push(cur);
			cur = cur.parentId ? byId.get(cur.parentId) : void 0;
		}
		chain.reverse();
		mainPath.push(...chain);
	}
	const entryIdToMsgIndex = /* @__PURE__ */ new Map();
	const messages = [];
	const compaction = [];
	const branchSummaries = [];
	const settingsEvents = [];
	const labels = [];
	const customEntries = [];
	let title;
	let titleCleared = false;
	let thinkingLevel;
	let model;
	const epochOf = (e) => {
		const msgTs = e.message?.timestamp;
		if (typeof msgTs === "number" && Number.isFinite(msgTs)) return msgTs;
		return toEpochMs(e.timestamp);
	};
	for (const e of mainPath) {
		const time = epochOf(e);
		switch (e.type) {
			case "message": {
				const raw = e.message;
				if (!isRecord(raw)) continue;
				const msg = piMessageToIr(raw, e);
				if (msg) {
					if (msg.timestamp === void 0) msg.timestamp = toEpochMs(e.timestamp);
					messages.push(msg);
					if (e.id) entryIdToMsgIndex.set(e.id, messages.length - 1);
					if (msg.role === "assistant" && msg.provider && msg.model) model = {
						provider: msg.provider,
						id: msg.model
					};
				}
				break;
			}
			case "compaction": {
				const summary = typeof e.summary === "string" ? e.summary : "";
				const anchorMsg = {
					role: "user",
					content: [{
						type: "text",
						text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX
					}],
					synthetic: true,
					meta: { pi: { anchor: {
						kind: "compaction",
						entryId: e.id
					} } }
				};
				if (time !== void 0) anchorMsg.timestamp = time;
				messages.push(anchorMsg);
				const meta = {
					entryId: e.id,
					timestamp: e.timestamp
				};
				if (e.details !== void 0) meta.details = e.details;
				if (e.usage !== void 0) meta.usage = e.usage;
				if (e.fromHook !== void 0) meta.fromHook = e.fromHook;
				const firstKeptIdRaw = typeof e.firstKeptEntryId === "string" ? e.firstKeptEntryId : void 0;
				const firstKeptIndex = firstKeptIdRaw !== void 0 ? entryIdToMsgIndex.get(firstKeptIdRaw) : void 0;
				if (firstKeptIndex !== void 0) meta.firstKeptIndex = firstKeptIndex;
				compaction.push({
					summary,
					tokensBefore: typeof e.tokensBefore === "number" ? e.tokensBefore : void 0,
					firstKeptId: typeof e.firstKeptEntryId === "string" ? e.firstKeptEntryId : void 0,
					anchorIndex: messages.length - 1,
					meta
				});
				break;
			}
			case "branch_summary": {
				const summary = typeof e.summary === "string" ? e.summary : "";
				const anchorMsg = {
					role: "user",
					content: [{
						type: "text",
						text: BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX
					}],
					synthetic: true,
					meta: { pi: { anchor: {
						kind: "branch_summary",
						entryId: e.id
					} } }
				};
				if (time !== void 0) anchorMsg.timestamp = time;
				messages.push(anchorMsg);
				const meta = {
					entryId: e.id,
					timestamp: e.timestamp
				};
				if (e.details !== void 0) meta.details = e.details;
				if (e.usage !== void 0) meta.usage = e.usage;
				if (e.fromHook !== void 0) meta.fromHook = e.fromHook;
				branchSummaries.push({
					fromId: typeof e.fromId === "string" ? e.fromId : "",
					summary,
					anchorIndex: messages.length - 1,
					time,
					meta
				});
				break;
			}
			case "custom_message": {
				const content = normalizeContent((Array.isArray(e.content) ? e.content : typeof e.content === "string" ? [{
					type: "text",
					text: e.content
				}] : []).map(foldPiBlock));
				if (content.length) {
					const msg = {
						role: "user",
						content,
						synthetic: true
					};
					if (time !== void 0) msg.timestamp = time;
					const customMessage = {};
					if (typeof e.customType === "string") customMessage.customType = e.customType;
					if (e.display !== void 0) customMessage.display = e.display;
					if (e.details !== void 0) customMessage.details = e.details;
					msg.meta = { pi: { customMessage } };
					messages.push(msg);
				}
				break;
			}
			case "model_change":
				model = {
					provider: e.provider,
					id: e.modelId ?? "unknown"
				};
				settingsEvents.push({
					type: "model_change",
					provider: e.provider,
					modelId: e.modelId,
					time
				});
				break;
			case "thinking_level_change":
				thinkingLevel = e.thinkingLevel;
				settingsEvents.push({
					type: "thinking_level_change",
					thinkingLevel: e.thinkingLevel,
					time
				});
				break;
			case "label": {
				const targetId = typeof e.targetId === "string" ? e.targetId : "";
				const anchorIndex = targetId ? entryIdToMsgIndex.get(targetId) : void 0;
				labels.push({
					targetId,
					...anchorIndex !== void 0 ? { anchorIndex } : {},
					label: typeof e.label === "string" && e.label ? e.label : void 0,
					time: toEpochMs(e.timestamp) ?? 0
				});
				break;
			}
			case "session_info": {
				const name = typeof e.name === "string" ? e.name.trim() : "";
				if (name) {
					title = name;
					titleCleared = false;
				} else {
					title = void 0;
					titleCleared = true;
				}
				settingsEvents.push({
					type: "session_info",
					name: e.name,
					time
				});
				break;
			}
			case "custom": customEntries.push({
				customType: typeof e.customType === "string" ? e.customType : "",
				data: e.data,
				time: toEpochMs(e.timestamp) ?? 0
			});
		}
	}
	const offPath = sessionEntries.filter((e) => !leafPath.has(e.id ?? ""));
	const sidechains = [];
	if (offPath.length) {
		const groups = /* @__PURE__ */ new Map();
		for (const e of offPath) {
			const eid = e.id ?? "";
			let anc = e;
			let branchRoot = eid;
			while (anc?.parentId) {
				const p = byId.get(anc.parentId);
				if (!p || leafPath.has(p.id ?? "")) break;
				anc = p;
				branchRoot = anc.id ?? branchRoot;
			}
			const g = groups.get(branchRoot) ?? [];
			g.push(e);
			groups.set(branchRoot, g);
		}
		for (const [rootId, group] of groups) {
			group.sort((a, b) => (toEpochMs(a.timestamp) ?? 0) - (toEpochMs(b.timestamp) ?? 0));
			const groupById = new Map(group.map((e) => [e.id ?? "", e]));
			const ordered = [];
			const visited = /* @__PURE__ */ new Set();
			const walk = (e) => {
				const eid = e.id ?? "";
				if (visited.has(eid)) return;
				visited.add(eid);
				ordered.push(e);
				for (const child of group) if (child.parentId === eid) walk(child);
			};
			for (const e of group) if (!e.parentId || !groupById.has(e.parentId)) walk(e);
			for (const e of group) walk(e);
			const msgs = [];
			const childSettings = [];
			const childLabels = [];
			const childCustom = [];
			const childCompactions = [];
			const childBranches = [];
			const childEntryIdToMsgIndex = /* @__PURE__ */ new Map();
			for (const e of ordered) {
				const time = epochOf(e);
				switch (e.type) {
					case "message": {
						const raw = e.message;
						if (!isRecord(raw)) continue;
						const msg = piMessageToIr(raw, e);
						if (msg) {
							if (msg.timestamp === void 0) msg.timestamp = toEpochMs(e.timestamp);
							msgs.push(msg);
							if (e.id) childEntryIdToMsgIndex.set(e.id, msgs.length - 1);
						}
						break;
					}
					case "compaction": {
						const summary = typeof e.summary === "string" ? e.summary : "";
						const anchorMsg = {
							role: "user",
							content: [{
								type: "text",
								text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX
							}],
							synthetic: true,
							meta: { pi: { anchor: {
								kind: "compaction",
								entryId: e.id
							} } }
						};
						if (time !== void 0) anchorMsg.timestamp = time;
						msgs.push(anchorMsg);
						const meta = {
							entryId: e.id,
							timestamp: e.timestamp
						};
						if (e.details !== void 0) meta.details = e.details;
						if (e.usage !== void 0) meta.usage = e.usage;
						if (e.fromHook !== void 0) meta.fromHook = e.fromHook;
						const fkRaw = typeof e.firstKeptEntryId === "string" ? e.firstKeptEntryId : void 0;
						const fkIndex = fkRaw !== void 0 ? childEntryIdToMsgIndex.get(fkRaw) : void 0;
						if (fkIndex !== void 0) meta.firstKeptIndex = fkIndex;
						childCompactions.push({
							summary,
							tokensBefore: typeof e.tokensBefore === "number" ? e.tokensBefore : void 0,
							firstKeptId: fkRaw,
							anchorIndex: msgs.length - 1,
							meta
						});
						break;
					}
					case "branch_summary": {
						const summary = typeof e.summary === "string" ? e.summary : "";
						const anchorMsg = {
							role: "user",
							content: [{
								type: "text",
								text: BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX
							}],
							synthetic: true,
							meta: { pi: { anchor: {
								kind: "branch_summary",
								entryId: e.id
							} } }
						};
						if (time !== void 0) anchorMsg.timestamp = time;
						msgs.push(anchorMsg);
						const meta = {
							entryId: e.id,
							timestamp: e.timestamp
						};
						if (e.details !== void 0) meta.details = e.details;
						if (e.usage !== void 0) meta.usage = e.usage;
						if (e.fromHook !== void 0) meta.fromHook = e.fromHook;
						childBranches.push({
							fromId: typeof e.fromId === "string" ? e.fromId : "",
							summary,
							anchorIndex: msgs.length - 1,
							time,
							meta
						});
						break;
					}
					case "custom_message": {
						const content = normalizeContent((Array.isArray(e.content) ? e.content : typeof e.content === "string" ? [{
							type: "text",
							text: e.content
						}] : []).map(foldPiBlock));
						if (content.length) {
							const msg = {
								role: "user",
								content,
								synthetic: true
							};
							if (time !== void 0) msg.timestamp = time;
							const customMessage = {};
							if (typeof e.customType === "string") customMessage.customType = e.customType;
							if (e.display !== void 0) customMessage.display = e.display;
							if (e.details !== void 0) customMessage.details = e.details;
							msg.meta = { pi: { customMessage } };
							msgs.push(msg);
						}
						break;
					}
					case "model_change":
						childSettings.push({
							type: "model_change",
							provider: e.provider,
							modelId: e.modelId,
							time
						});
						break;
					case "thinking_level_change":
						childSettings.push({
							type: "thinking_level_change",
							thinkingLevel: e.thinkingLevel,
							time
						});
						break;
					case "label":
						childLabels.push({
							targetId: typeof e.targetId === "string" ? e.targetId : "",
							...typeof e.targetId === "string" && e.targetId && childEntryIdToMsgIndex.has(e.targetId) ? { anchorIndex: childEntryIdToMsgIndex.get(e.targetId) } : {},
							label: typeof e.label === "string" && e.label ? e.label : void 0,
							time: toEpochMs(e.timestamp) ?? 0
						});
						break;
					case "custom":
						childCustom.push({
							customType: typeof e.customType === "string" ? e.customType : "",
							data: e.data,
							time: toEpochMs(e.timestamp) ?? 0
						});
						break;
					case "session_info": childSettings.push({
						type: "session_info",
						name: e.name,
						time
					});
				}
			}
			if (msgs.length) {
				const sc = {
					agentId: `pi-${rootId.slice(0, 8)}`,
					kind: "subagent",
					messages: msgs
				};
				const childMeta = {};
				if (childSettings.length) childMeta.settingsEvents = childSettings;
				if (childLabels.length) childMeta.labels = childLabels;
				if (childCustom.length) childMeta.customEntries = childCustom;
				if (Object.keys(childMeta).length) sc.meta = { pi: childMeta };
				if (childCompactions.length) sc.compaction = childCompactions;
				if (childBranches.length) {
					childMeta.branchSummaries = childBranches;
					sc.meta = { pi: childMeta };
				}
				sidechains.push(sc);
			} else if (childSettings.length || childLabels.length || childCustom.length || childCompactions.length || childBranches.length) {
				const childMeta = {};
				if (childSettings.length) childMeta.settingsEvents = childSettings;
				if (childLabels.length) childMeta.labels = childLabels;
				if (childCustom.length) childMeta.customEntries = childCustom;
				if (childCompactions.length) childMeta.compaction = childCompactions;
				if (childBranches.length) childMeta.branchSummaries = childBranches;
				const sc = {
					agentId: `pi-${rootId.slice(0, 8)}`,
					kind: "subagent",
					messages: [],
					meta: { pi: childMeta }
				};
				sidechains.push(sc);
			}
		}
	}
	const piSessionMeta = { header: { ...header } };
	if (settingsEvents.length) piSessionMeta.settingsEvents = settingsEvents;
	if (labels.length) piSessionMeta.labels = labels;
	if (customEntries.length) piSessionMeta.customEntries = customEntries;
	if (titleCleared) piSessionMeta.titleCleared = true;
	const ir = {
		schemaVersion: 2,
		originTool: "pi",
		originSessionId,
		cwd,
		createdAt,
		model,
		thinkingLevel,
		messages,
		meta: { pi: piSessionMeta }
	};
	if (title) ir.title = title;
	if (compaction.length) ir.compaction = compaction;
	if (branchSummaries.length) ir.branchSummaries = branchSummaries;
	if (sidechains.length) ir.sidechains = sidechains;
	return validateSession(ir);
}
function piMessageFromMigrated(msg) {
	const piMeta = msg.meta?.pi;
	const isToolResultCarrier = msg.role === "user" && msg.content.length > 0 && msg.content.every((b) => b.type === "tool_result");
	if (msg.role === "tool" || isToolResultCarrier) {
		const tr = msg.content.find((b) => b.type === "tool_result");
		const content = [];
		if (tr) {
			content.push({
				type: "text",
				text: tr.content
			});
			for (const att of tr.attachments ?? []) if (att.data) content.push({
				type: "image",
				data: att.data,
				mimeType: att.mediaType ?? "image/png"
			});
			else content.push({
				type: "text",
				text: `[file: ${att.filename ?? att.url ?? "attachment"}]`
			});
		}
		for (const b of msg.content) if (b.type === "text") content.push({
			type: "text",
			text: b.text
		});
		else if (b.type === "file" && b.data) content.push({
			type: "image",
			data: b.data,
			mimeType: b.mediaType ?? "image/png"
		});
		const out = {
			role: "toolResult",
			...tr ? { toolCallId: tr.toolUseId } : {},
			toolName: piMeta?.toolName ?? "tool",
			content: content.length ? content : [{
				type: "text",
				text: ""
			}],
			isError: tr?.isError ?? false,
			timestamp: msg.timestamp ?? Date.now()
		};
		if (piMeta?.details !== void 0) out.details = piMeta.details;
		if (piMeta?.usage !== void 0) out.usage = piMeta.usage;
		if (piMeta?.addedToolNames !== void 0) out.addedToolNames = piMeta.addedToolNames;
		return out;
	}
	if (msg.role === "user" && piMeta?.bash && isRecord(piMeta.bash)) {
		const bash = piMeta.bash;
		const out = {
			role: "bashExecution",
			command: typeof bash.command === "string" ? bash.command : "",
			output: typeof bash.output === "string" ? bash.output : "",
			exitCode: typeof bash.exitCode === "number" ? bash.exitCode : void 0,
			cancelled: bash.cancelled === true,
			truncated: bash.truncated === true,
			timestamp: msg.timestamp ?? Date.now()
		};
		if (typeof bash.fullOutputPath === "string") out.fullOutputPath = bash.fullOutputPath;
		if (bash.excludeFromContext === true) out.excludeFromContext = true;
		return out;
	}
	if (msg.role === "user" && piMeta?.customMessage && isRecord(piMeta.customMessage)) {
		const cm = piMeta.customMessage;
		const out = {
			role: "custom",
			customType: typeof cm.customType === "string" ? cm.customType : "unknown",
			content: msg.content.map((b) => {
				if (b.type === "file") {
					if (b.data) return {
						type: "image",
						data: b.data,
						mimeType: b.mediaType ?? "image/png"
					};
					return {
						type: "text",
						text: `[file: ${b.filename ?? b.url ?? "attachment"}]`
					};
				}
				if (b.type === "text") return {
					type: "text",
					text: b.text
				};
				return {
					type: "text",
					text: b.type === "thinking" ? b.thinking : b.type === "tool_use" ? `[tool_use: ${b.name}]` : b.content
				};
			}),
			display: cm.display !== false,
			timestamp: msg.timestamp ?? Date.now()
		};
		if (cm.details !== void 0) out.details = cm.details;
		return out;
	}
	if (msg.role === "system" || msg.role === "developer") return {
		role: "user",
		content: blocksToText(msg.content).trim(),
		timestamp: msg.timestamp ?? Date.now()
	};
	const role = msg.role;
	const content = msg.content.map((b) => {
		if (b.type === "text") return {
			type: "text",
			text: b.text
		};
		if (b.type === "thinking") return {
			type: "thinking",
			thinking: b.thinking
		};
		if (b.type === "tool_use") return {
			type: "toolCall",
			id: b.id,
			name: b.name,
			arguments: b.input
		};
		if (b.type === "tool_result") return {
			type: "text",
			text: b.content
		};
		return {
			type: "text",
			text: `[file: ${b.filename ?? b.url ?? b.mediaType ?? "attachment"}]`
		};
	});
	const out = {
		role,
		content: content.length === 1 && typeof content[0].text === "string" && msg.role === "user" ? content[0].text : content,
		timestamp: msg.timestamp ?? Date.now()
	};
	if (msg.provider) out.provider = msg.provider;
	if (msg.model) out.model = msg.model;
	if (msg.stopReason) out.stopReason = msg.stopReason;
	if (msg.role === "assistant" && piMeta?.message && isRecord(piMeta.message)) {
		for (const [k, v] of Object.entries(piMeta.message)) if (v !== void 0) out[k] = v;
	}
	return out;
}
//#endregion
//#region ../core/dist/src/adapters/opencode/index.js
/**
* OpenCode adapter — reads/writes the canonical `opencode.db` SQLite store.
*
* Source-anchored from `opencode-dev` + a REAL v1.18.21 store (sampled):
*  - DB path: packages/core/src/database/database.ts:43 `path()` — xdgData/opencode/opencode.db
*    with channel isolation + $OPENCODE_DB / $OPENCODE_TEST_HOME overrides (global.ts:18).
*  - Schema: in v1.18.21 stores the authority is `message` (envelope) + `part`
*    (content blocks); `session_message` exists but is EMPTY (verified). Newer
*    builds dual-write both via SessionProjector, so reading message/part
*    covers both eras.
*  - Task subagents are NATIVE CHILD SESSIONS: `session.parent_id = <parent>`,
*    `agent = subagent_type`, `title = "<description> (@<agent> subagent)"`;
*    the parent's task tool part links back via
*    `state.metadata = { parentSessionId, sessionId, model, truncated }` and
*    carries the final result wrapped in
*    `<task id="ses_…" state="completed|error"><task_result|task_error>…</…></task>`
*    (tool/task.ts renderOutput). The FULL intermediate process lives in the
*    child session's own message/part rows — never folded into the parent.
*    Some v1.18 stores shipped with `parent_id` NULL (backfillable from task
*    part metadata — see .db-rescue/); the parse side self-heals via metadata.
*  - Compaction: boundary = user row whose part list carries
*    `{type:'compaction', auto, tail_start_id?}`; the paired summary assistant
*    (`summary:true, mode:'compaction', agent:'compaction'`) parents to it.
*  - History: src/session/history.ts SessionHistory.load / loadForRunner (compaction-aware).
*
* This adapter:
*  - On parse: walks the session TREE — main session + every child session
*    row — into MigratedSession.messages + MigratedSidechain[] with the full
*    intermediate transcripts (never just prompt+output), unwraps task
*    outputs into tool_result content (raw wrapper kept as rawResult), and
*    projects compaction boundaries into ir.compaction.
*  - On write: transactional INSERT into project + session + message + part.
*    flatten=false (native, the same-tool default) rebuilds each sidechain as
*    a child session row and links the parent's task part via
*    state.metadata.sessionId; flatten=true (the cross-tool "展平为顶层消息"
*    default) folds sidechain transcripts into top-level messages.
*  - Tool parts map the NATIVE four-state union: completed (output/title/
*    metadata — output keeps even-empty real results), error (state.error ⇄
*    IR tool_result isError), pending (a call with NO result in the IR —
*    never fabricated as completed+'', which would drift on every re-parse).
*  - When no real opencode.db exists (tests with --root <tmp>`), falls back to a JSONL
*    mirror at `<root>/opencode-mirror/<sessionId>.jsonl` so tests remain hermetic and
*    do not require better-sqlite3.
*/
function resolveDbPath(root) {
	if (root && root.trim()) {
		const t = root.trim();
		if (t.endsWith(".db")) return t;
		return join(t, "opencode.db");
	}
	const envDb = process.env.OPENCODE_DB;
	if (envDb && envDb.trim()) {
		if (envDb === ":memory:" || envDb.startsWith("/")) return envDb;
		const xdg = xdgDataDir();
		return xdg ? join(xdg, "opencode", envDb) : null;
	}
	const xdg = xdgDataDir();
	if (!xdg) return null;
	return join(xdg, "opencode", "opencode.db");
}
function shouldUseDb(dbPath, rootExplicit) {
	if (!dbPath) return false;
	if (dbPath === ":memory:") return true;
	if (rootExplicit) return existsSync(dbPath);
	return existsSync(dbPath);
}
function xdgDataDir() {
	const testHome = process.env.OPENCODE_TEST_HOME;
	const home = testHome && testHome.trim() ? testHome.trim() : process.env.HOME || (process.env.USERPROFILE ?? null);
	if (!home) return null;
	if (process.platform === "darwin") return join(home, "Library", "Application Support");
	return join(home, ".local", "share");
}
let __sqliteCtor;
async function getSqliteCtor() {
	if (__sqliteCtor !== void 0) return __sqliteCtor;
	try {
		const Ctor = (await import("node:sqlite")).DatabaseSync;
		if (typeof Ctor === "function") {
			__sqliteCtor = Ctor;
			return __sqliteCtor;
		}
	} catch {}
	__sqliteCtor = null;
	return null;
}
function openDbSync(dbPath, opts) {
	const ctorOpts = opts ?? {};
	if (__sqliteCtor) try {
		return new __sqliteCtor(dbPath, ctorOpts);
	} catch {}
	try {
		const { createRequire } = __require("node:module");
		const Ctor = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
		if (typeof Ctor === "function") {
			__sqliteCtor = Ctor;
			return new __sqliteCtor(dbPath, ctorOpts);
		}
	} catch {}
	try {
		const { createRequire } = __require("node:module");
		const Better = createRequire(import.meta.url)("better-sqlite3");
		if (typeof Better === "function") return new Better(dbPath, ctorOpts);
	} catch {}
	return null;
}
async function openDb(dbPath, opts) {
	const Ctor = await getSqliteCtor();
	if (Ctor) try {
		return new Ctor(dbPath, opts ?? {});
	} catch {}
	return openDbSync(dbPath, opts);
}
var OpenCodeAdapter = class {
	tool = "opencode";
	irVersion = "3.3";
	async parse(sessionId, root) {
		const dbPath = resolveDbPath(root);
		const rootExplicit = !!(root && root.trim());
		if (shouldUseDb(dbPath, rootExplicit)) {
			const db = await openDb(dbPath, { readOnly: true });
			if (db) try {
				return parseFromDb(db, sessionId);
			} finally {
				try {
					db.close();
				} catch {}
			}
		}
		if (!rootExplicit && !dbPath) throw new Error("OpenCode: cannot resolve opencode.db (no HOME/USERPROFILE and no --src-root)");
		const mirrorDir = root ? join(root.endsWith(".db") ? dirname(root) : root, "opencode-mirror") : null;
		if (!mirrorDir) throw new Error(`OpenCode: cannot open opencode.db at ${dbPath ?? "<noresolve>"} (is the DB locked or missing sqlite driver?) and no mirror root is available`);
		const mirrorPath = join(mirrorDir, `${sessionId}.jsonl`);
		try {
			await promises.access(mirrorPath);
		} catch {
			throw new Error(`OpenCode: session "${sessionId}" not found (no db at ${dbPath ?? "<noresolve>"} and no mirror at ${mirrorPath})`);
		}
		return parseFromMirror(mirrorPath);
	}
	async write(ir, opts) {
		validateSession(ir);
		const root = opts?.root;
		const rootExplicit = !!(root && root.trim());
		const targetCwd = opts?.targetCwd ?? ir.cwd ?? "";
		const newId = opts?.sessionId ?? `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
		const flatten = opts?.flatten ?? true;
		const dbPath = resolveDbPath(root);
		if (shouldUseDb(dbPath, rootExplicit) && dbPath) {
			try {
				const { openSync, closeSync } = await import("node:fs");
				closeSync(openSync(dbPath, "r+"));
			} catch (e) {
				const code = e?.code ?? "";
				if (code === "EPERM" || code === "EACCES") throw new Error(`OpenCode: default DB is not writable in this sandbox (EPERM on r+ open of ${dbPath}). This is NOT an OpenCode lock — the DSH GUI sandbox blocked the write. Run the migration CLI outside the GUI sandbox (e.g. in a normal terminal: node packages/cli/dist/src/index.js migrate dsh <id> opencode --dst-root <tmp>) or add --dst-root <tmpDir> to write to a hermetic mirror for verification. If you need to write the real opencode.db, launch the CLI from a non-sandboxed shell.`);
			}
			const db = await openDb(dbPath);
			if (db) try {
				let probeFailed = null;
				try {
					db.exec("SAVEPOINT _sm_probe");
					const now = Date.now();
					db.prepare("INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, NULL)").run(`_sm_probe_${now}`, "/tmp/_sm_probe", now, now, "[]");
					db.exec("ROLLBACK TO SAVEPOINT _sm_probe");
					db.exec("RELEASE SAVEPOINT _sm_probe");
				} catch (e) {
					try {
						db.exec("ROLLBACK TO SAVEPOINT _sm_probe");
					} catch {}
					try {
						db.exec("RELEASE SAVEPOINT _sm_probe");
					} catch {}
					const msg = String(e?.message ?? e);
					if (msg.includes("readonly database") || msg.includes("EPERM")) probeFailed = e;
					else throw e;
				}
				if (probeFailed) throw new Error(`OpenCode: default DB is not writable (sqlite: ${probeFailed.message}). In the DSH GUI sandbox this surfaces as EPERM on r+ and sqlite readonly. Run the migration CLI outside the sandbox or use --dst-root <tmpDir> for a hermetic mirror. WP DB helpers are not applicable here (different sandbox domain).`);
				db.exec("BEGIN IMMEDIATE");
				let written;
				try {
					written = writeToDb(db, ir, newId, targetCwd, flatten, opts?.keepSynthetic ?? false);
					db.exec("COMMIT");
				} catch (e) {
					try {
						db.exec("ROLLBACK");
					} catch {}
					const msg = String(e?.message ?? e);
					if (msg.includes("SQLITE_BUSY") || msg.includes("database is locked")) throw new Error(`OpenCode: ${dbPath} is locked (SQLITE_BUSY) — another process (the opencode app?) is mid-write. Retry or write to a sandbox copy via --dst-root.`);
					throw e;
				}
				return {
					tool: "opencode",
					sessionId: written,
					paths: [dbPath ?? "<db>"]
				};
			} finally {
				try {
					db.close();
				} catch {}
			}
		}
		if (!rootExplicit) {
			const hint = dbPath ? `OpenCode: cannot open ${dbPath}` : "OpenCode: cannot resolve opencode.db";
			const busy = dbPath?.includes("opencode.db") ? "（若在 DSH 沙箱内运行，会因 EPERM 被拦；请在普通终端运行 CLI，或加 --dst-root <dir> 迁到临时目录验证）" : "";
			throw new Error(`${hint}：未找到可用的 sqlite 驱动或数据库被占用/不存在${busy}。可用 --dst-root <tmpDir> 迁到临时 mirror 验证，或检查 Node 版本是否 ≥22 且 sqlite 驱动可用。`);
		}
		const mirrorDir = join(root.endsWith(".db") ? dirname(root) : root, "opencode-mirror");
		await promises.mkdir(mirrorDir, { recursive: true });
		const mirrorPath = join(mirrorDir, `${newId}.jsonl`);
		await writeToMirror(mirrorPath, ir, newId, targetCwd, flatten);
		return {
			tool: "opencode",
			sessionId: newId,
			paths: [mirrorPath]
		};
	}
	async listSessions(root) {
		const dbPath = resolveDbPath(root);
		if (shouldUseDb(dbPath, !!(root && root.trim()))) {
			const db = await openDb(dbPath, { readOnly: true });
			if (!db) throw new Error(`OpenCode: cannot open ${dbPath} read-only to list sessions (no sqlite driver / locked — busy hint: close the opencode app or retry).`);
			try {
				return db.prepare("SELECT id, title, time_created, directory FROM session WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM session) ORDER BY time_created DESC").all().map((r) => ({
					tool: "opencode",
					sessionId: String(r.id ?? ""),
					title: r.title ? String(r.title) : void 0,
					createdAt: typeof r.time_created === "number" ? r.time_created : void 0,
					cwd: r.directory ? String(r.directory) : void 0,
					sourcePath: dbPath ?? void 0
				}));
			} finally {
				try {
					db.close();
				} catch {}
			}
		}
		const mirrorDir = root ? join(root.endsWith(".db") ? dirname(root) : root, "opencode-mirror") : null;
		if (!mirrorDir) return [];
		let entries;
		try {
			entries = await promises.readdir(mirrorDir);
		} catch {
			return [];
		}
		const out = [];
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			const sid = name.slice(0, -6);
			const full = join(mirrorDir, name);
			try {
				const st = await promises.stat(full);
				out.push({
					tool: "opencode",
					sessionId: sid,
					createdAt: st.mtimeMs,
					sourcePath: full
				});
			} catch {}
		}
		return out;
	}
	preview(session) {
		const main = session.messages.map((m) => `[${m.role}]\n${blocksToText(m.content)}`).join("\n\n");
		if (!session.sidechains?.length) return main;
		return `${main}\n\n${session.sidechains.map((s) => `[sidechain: ${s.agentId} (${s.kind})]\n${s.messages.map((m) => blocksToText(m.content)).join("\n")}`).join("\n\n")}`;
	}
};
/**
* DB row conventions — source-anchored from a REAL opencode v1.18.21 store:
*  - messages live in `message` (envelope) + `part` (content blocks);
*    `session_message` exists but is EMPTY in v1.18 stores.
*  - message data user:   {role:'user', time:{created}, agent:'build',
*                           model:{providerID, modelID}, summary:{diffs:[]}}
*  - message data assist: {parentID, role:'assistant', mode:'build', agent:'build',
*                           path:{cwd, root}, cost, tokens, modelID, providerID,
*                           time:{created, completed}, finish?}
*  - compaction: boundary user row with a `{type:'compaction', auto,
*    tail_start_id?}` part + assistant summary row `{summary:true,
*    mode:'compaction', agent:'compaction', parentID:<boundary>}`.
*  - task subagent: child session row (session.parent_id) + parent task part
*    `state.metadata = {parentSessionId, sessionId, model, truncated}`;
*    output wrapped `<task id=… state=…><task_result>…</task_result></task>`.
*  - part data types: text{text} | reasoning{text} | tool{tool,callID,
*    state:{status,input,output,title,metadata,time}} | step-start |
*    step-finish | patch | file{mime,filename,url} | compaction | ...
*  - sessions attach to project_id='global' (worktree '/') in practice;
*    per-directory projects exist too (worktree forward-slashed, vcs 'git',
*    sandboxes '[]', id 40-hex).
*  - tool results are NOT separate rows: the output lives inside the tool
*    part's state.output.
*/
const OPENCODE_APP_VERSION = "1.18.21";
function fwdSlash(p) {
	return p.replace(/\\/g, "/");
}
/**
* `session.path` is the cwd RELATIVE to the project worktree — NEVER the
* absolute directory (that lives in `session.directory`). The app writes it
* via `sessionPath(worktree, cwd)` = path.relative(worktree, cwd) with
* backslashes normalized to '/' (session.ts:171). cwd == worktree (the
* common case: the repo root is the cwd) ⇒ ''. Relative paths only appear
* when the cwd is nested inside a larger worktree — real-store samples:
* 987/1055 rows are '' (cwd == git worktree), the rest like
* 'codes/dshPlugins/cc-migrate' (worktree '/'). Sessions listing by subpath
* (`like(path, '<sub>/%')`, session.ts:967) would never match an absolute
* path, so writing `directory` here breaks the app's path scoping.
*/
function sessionPathColumn(worktree, cwd) {
	if (!isAbsolute(cwd) || !isAbsolute(worktree)) return "";
	const rel = relative(worktree, cwd);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "";
	return fwdSlash(rel);
}
/**
* The worktree the app would resolve this cwd to (real-store 1.18 shape):
* 1. a git repo root found by walking up for `.git` (hash-id projects are
*    born from git discovery — their worktree IS the git root; 203/210
*    git-project rows have path '' because cwd == that root);
* 2. otherwise the 'global' project (worktree '/') — every non-git
*    directory attaches there, and sessionPath('/', cwd) drops the drive
*    root (win32 path.relative behavior), producing rows like
*    'codes/dshPlugins/cc-migrate' (24 real rows sampled).
* `session.directory` stays the absolute cwd either way.
*/
function resolveWorktree(cwd) {
	let cur = cwd;
	for (let i = 0; i < 64 && cur; i++) {
		if (existsSync(join(cur, ".git"))) return cur;
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return "/";
}
/**
* Find the project row a migrated session should attach to.
* 1. The app's own project for this worktree (the common real case — the
*    directory has been opened in OpenCode before, so the row exists).
* 2. Otherwise the app's 'global' project (worktree '/') — every production
*    session row we sampled attaches there. Never fabricate a hash-style
*    project id: the app's id derivation is opaque and a mismatched id would
*    be orphaned from the app's project resolution.
*/
function resolveProjectRow(db, cwd) {
	const worktree = fwdSlash(cwd || "/");
	const found = db.prepare("SELECT id FROM project WHERE worktree = ? LIMIT 1").get(worktree);
	if (found?.id) return String(found.id);
	ensureGlobalProject(db);
	return "global";
}
function ensureGlobalProject(db) {
	const now = Date.now();
	db.prepare("INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color, time_created, time_updated, time_initialized, sandboxes, commands) VALUES ('global', '/', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, '[]', NULL)").run(now, now);
}
const SESSION_COLS = "id, parent_id, title, agent, time_created, directory";
function getSessionRow(db, id) {
	return db.prepare(`SELECT ${SESSION_COLS} FROM session WHERE id=?`).get(id);
}
function childSessionRows(db, parentId) {
	return db.prepare(`SELECT ${SESSION_COLS} FROM session WHERE parent_id=? ORDER BY time_created ASC, rowid ASC`).all(parentId);
}
function parseRowData(v) {
	if (typeof v === "string") try {
		return JSON.parse(v);
	} catch {
		return {};
	}
	return v ?? {};
}
function loadPartsByMessage(db, sessionId) {
	const partRows = db.prepare("SELECT message_id, data FROM part WHERE session_id=? ORDER BY rowid ASC").all(sessionId);
	const map = /* @__PURE__ */ new Map();
	for (const pr of partRows) {
		const d = parseRowData(pr.data);
		const key = String(pr.message_id ?? "");
		const list = map.get(key) ?? [];
		list.push(d);
		map.set(key, list);
	}
	return map;
}
/**
* Walk ONE session's message/part rows into IR messages, then recurse into
* its native sub-sessions as sidechains. Children come from
* `session.parent_id` plus self-healing via task part
* `state.metadata.sessionId` (v1.18 stores shipped with parent_id NULL —
* backfillable only from the task part metadata).
*/
function walkSession(db, sessionId, seen) {
	if (seen.has(sessionId)) return {
		messages: [],
		sidechains: [],
		compactions: []
	};
	seen.add(sessionId);
	const msgRows = db.prepare("SELECT id, data, time_created FROM message WHERE session_id=? ORDER BY time_created ASC, rowid ASC").all(sessionId);
	const partsByMessage = loadPartsByMessage(db, sessionId);
	const summaryRowByParent = /* @__PURE__ */ new Map();
	const summaryPartsByParent = /* @__PURE__ */ new Map();
	const summaryRowIds = /* @__PURE__ */ new Set();
	for (const r of msgRows) {
		const rowId = String(r.id ?? "");
		const d = parseRowData(r.data);
		if (d.summary === true && typeof d.parentID === "string" && d.parentID) {
			summaryRowIds.add(rowId);
			summaryRowByParent.set(d.parentID, rowId);
			summaryPartsByParent.set(d.parentID, partsByMessage.get(rowId) ?? []);
		}
	}
	const messages = [];
	const compactions = [];
	const taskLinks = /* @__PURE__ */ new Map();
	let model;
	for (const r of msgRows) {
		const rowId = String(r.id ?? "");
		const data = parseRowData(r.data);
		const role = String(data.role ?? "assistant");
		const ts = typeof r.time_created === "number" ? r.time_created : void 0;
		const parts = partsByMessage.get(rowId) ?? [];
		if (summaryRowIds.has(rowId)) continue;
		if (role === "user") {
			const compactionPart = parts.find((p) => p.type === "compaction");
			if (compactionPart) {
				const summaryText = (summaryPartsByParent.get(rowId) ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => String(p.text)).join("\n");
				const ocMeta = {
					auto: compactionPart.auto === true,
					boundaryMessageId: rowId
				};
				if (typeof compactionPart.tail_start_id === "string" && compactionPart.tail_start_id) ocMeta.tailStartId = compactionPart.tail_start_id;
				const summaryId = summaryRowByParent.get(rowId);
				if (summaryId) ocMeta.summaryMessageId = summaryId;
				if (summaryText) {
					messages.push({
						role: "user",
						content: [{
							type: "text",
							text: summaryText
						}],
						timestamp: ts
					});
					compactions.push({
						summary: summaryText,
						anchorIndex: messages.length - 1,
						meta: { opencode: ocMeta }
					});
				} else compactions.push({
					summary: "",
					meta: { opencode: ocMeta }
				});
			}
			const content = [];
			for (const p of parts) if (p.type === "text" && typeof p.text === "string") content.push({
				type: "text",
				text: p.text
			});
			else if (p.type === "file") {
				const f = fileFromPart(p);
				if (f) content.push(f);
			}
			if (content.length) messages.push({
				role: "user",
				content,
				timestamp: ts
			});
			continue;
		}
		if (!model && typeof data.modelID === "string") model = {
			id: data.modelID,
			provider: typeof data.providerID === "string" ? data.providerID : void 0
		};
		const content = [];
		const toolResults = [];
		for (const p of parts) if (p.type === "text" && typeof p.text === "string") content.push({
			type: "text",
			text: p.text
		});
		else if (p.type === "reasoning" && typeof p.text === "string") content.push({
			type: "thinking",
			thinking: p.text
		});
		else if (p.type === "file") {
			const f = fileFromPart(p);
			if (f) content.push(f);
		} else if (p.type === "tool") {
			const callID = String(p.callID ?? randomUUID());
			const state = p.state ?? {};
			const input = state.input ?? {};
			content.push({
				type: "tool_use",
				id: callID,
				name: String(p.tool ?? "tool"),
				input
			});
			const isTask = String(p.tool ?? "") === "task";
			if (isTask) {
				const meta = state.metadata ?? {};
				taskLinks.set(callID, {
					callId: callID,
					childRef: typeof meta.sessionId === "string" && meta.sessionId ? meta.sessionId : void 0,
					subagentType: typeof input.subagent_type === "string" ? input.subagent_type : void 0,
					parentMessageRowId: rowId
				});
			}
			if (state.output !== void 0 && state.output !== null) {
				const raw = typeof state.output === "string" ? state.output : JSON.stringify(state.output);
				const unwrapped = isTask ? unwrapTaskOutput(raw) : void 0;
				const block = {
					type: "tool_result",
					toolUseId: callID,
					content: unwrapped ? unwrapped.text : raw
				};
				if (unwrapped && unwrapped.text !== raw) block.rawResult = raw;
				toolResults.push({
					role: "tool",
					content: [block],
					timestamp: ts
				});
			} else if (typeof state.error === "string" && state.error) toolResults.push({
				role: "tool",
				content: [{
					type: "tool_result",
					toolUseId: callID,
					content: state.error,
					isError: true
				}],
				timestamp: ts
			});
		}
		if (content.length) {
			messages.push({
				role: "assistant",
				content,
				timestamp: ts,
				provider: typeof data.providerID === "string" ? data.providerID : void 0,
				model: typeof data.modelID === "string" ? data.modelID : void 0
			});
			messages.push(...toolResults);
		}
	}
	const sidechains = [];
	const linkByChild = /* @__PURE__ */ new Map();
	for (const link of taskLinks.values()) if (link.childRef && !linkByChild.has(link.childRef)) linkByChild.set(link.childRef, link);
	const childIds = [];
	const childSeen = /* @__PURE__ */ new Set();
	for (const row of childSessionRows(db, sessionId)) if (!childSeen.has(row.id)) {
		childSeen.add(row.id);
		childIds.push(row.id);
	}
	for (const childRef of linkByChild.keys()) {
		if (childSeen.has(childRef)) continue;
		if (getSessionRow(db, childRef)) {
			childSeen.add(childRef);
			childIds.push(childRef);
		}
	}
	for (const childId of childIds) {
		const row = getSessionRow(db, childId);
		if (!row) continue;
		const sub = walkSession(db, childId, seen);
		const link = linkByChild.get(childId);
		const ocMeta = { parentSessionId: sessionId };
		if (link) ocMeta.callId = link.callId;
		const sc = {
			agentId: childId,
			kind: "subagent",
			agentType: ((row.agent ? String(row.agent) : void 0) ?? link?.subagentType) || void 0,
			title: row.title ? String(row.title) : void 0,
			createdAt: typeof row.time_created === "number" ? row.time_created : void 0,
			parentMessageId: link?.parentMessageRowId,
			messages: sub.messages,
			meta: { opencode: ocMeta }
		};
		if (sub.sidechains.length) sc.sidechains = sub.sidechains;
		if (sub.compactions.length) sc.compaction = sub.compactions;
		sidechains.push(sc);
	}
	return {
		messages,
		sidechains,
		compactions,
		model
	};
}
function parseFromDb(db, sessionId) {
	let sessionRow;
	try {
		sessionRow = getSessionRow(db, sessionId);
	} catch {
		sessionRow = void 0;
	}
	if (!sessionRow) throw new Error(`OpenCode: session "${sessionId}" not found in opencode.db`);
	const seen = /* @__PURE__ */ new Set();
	const walk = walkSession(db, String(sessionRow.id ?? sessionId), seen);
	const ir = {
		schemaVersion: 2,
		originTool: "opencode",
		originSessionId: String(sessionRow.id ?? sessionId),
		title: sessionRow.title ? String(sessionRow.title) : void 0,
		createdAt: typeof sessionRow.time_created === "number" ? sessionRow.time_created : void 0,
		cwd: sessionRow.directory ? String(sessionRow.directory) : void 0,
		messages: walk.messages
	};
	if (walk.model) ir.model = walk.model;
	if (walk.compactions.length) ir.compaction = walk.compactions;
	if (walk.sidechains.length) ir.sidechains = walk.sidechains;
	return validateSession(ir);
}
const TASK_OUTPUT_RE = /^<task id="([^"]*)" state="([a-z]+)">\n<task_(result|error)>\n([\s\S]*)\n<\/task_\3>\n<\/task>$/;
function unwrapTaskOutput(raw) {
	if (!raw) return { text: "" };
	const m = TASK_OUTPUT_RE.exec(raw);
	if (!m) return { text: raw };
	return {
		text: m[4],
		taskId: m[1],
		isError: m[3] === "error"
	};
}
function wrapTaskOutput(taskId, text, isError) {
	const tag = isError ? "task_error" : "task_result";
	return `<task id="${taskId}" state="${isError ? "error" : "completed"}">\n<${tag}>\n${text}\n</${tag}>\n</task>`;
}
function fileFromPart(p) {
	const out = { type: "file" };
	if (typeof p.filename === "string" && p.filename) out.filename = p.filename;
	if (typeof p.mime === "string" && p.mime) out.mediaType = p.mime;
	if (typeof p.url === "string" && p.url) out.url = p.url;
	else if (typeof p.data === "string" && p.data) out.data = p.data;
	return out.filename || out.mediaType || out.url || out.data ? out : void 0;
}
/**
* The TUI dispatches tool parts by EXACT name (packages/tui
* routes/session/index.tsx `toolDisplays`) and renders per-tool components
* that read OpenCode's input keys. DSH uses Claude-style names/keys
* ("Read" + `file_path`), so without this mapping every read/write/edit part
* renders as a pending placeholder ("~ Reading file...").
*/
const OPENCODE_TOOL_NAMES = /* @__PURE__ */ new Set([
	"bash",
	"glob",
	"read",
	"grep",
	"webfetch",
	"websearch",
	"write",
	"edit",
	"task",
	"apply_patch",
	"todowrite",
	"question",
	"skill",
	"execute"
]);
const TOOL_NAME_MAP = {
	read: "read",
	write: "write",
	edit: "edit",
	multiedit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "glob",
	webfetch: "webfetch",
	websearch: "websearch",
	task: "task",
	todowrite: "todowrite",
	todo_write: "todowrite",
	todoread: "todoread",
	notebookedit: "edit",
	applypatch: "apply_patch"
};
/** Input key renames per tool (Claude-style -> OpenCode-style). */
const FILE_PATH_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"write",
	"edit"
]);
function mapToolPart(tool, input, output) {
	const lower = tool.toLowerCase();
	const name = TOOL_NAME_MAP[lower] ?? (OPENCODE_TOOL_NAMES.has(lower) ? lower : lower);
	const mapped = { ...input };
	if (FILE_PATH_TOOLS.has(name)) {
		if (typeof mapped.file_path === "string") {
			mapped.filePath = mapped.file_path;
			delete mapped.file_path;
		} else if (typeof mapped.path === "string" && name === "read" && typeof mapped.filePath !== "string") mapped.filePath = mapped.path;
	}
	const str = (v) => typeof v === "string" ? v : v === void 0 || v === null ? "" : String(v);
	const filePath = str(mapped.filePath ?? mapped.file_path);
	let title = name;
	const metadata = {};
	switch (name) {
		case "read":
			title = filePath;
			if (filePath) metadata.loaded = [filePath];
			break;
		case "write":
		case "edit":
			title = filePath;
			break;
		case "bash":
			title = str(mapped.command).slice(0, 200);
			if (output) metadata.output = output;
			break;
		case "grep":
		case "glob":
			title = str(mapped.pattern);
			break;
		case "webfetch":
			title = str(mapped.url);
			break;
		case "websearch":
			title = str(mapped.query);
			break;
		case "task":
			title = str(mapped.description);
			break;
		case "todowrite":
			title = "# Todos";
			if (Array.isArray(mapped.todos)) metadata.todos = mapped.todos;
			break;
		default: title = name;
	}
	if (!title) title = name;
	return {
		tool: name,
		input: mapped,
		metadata,
		title
	};
}
const zeroTokens = {
	total: 0,
	input: 0,
	output: 0,
	reasoning: 0,
	cache: {
		read: 0,
		write: 0
	}
};
function makeWriteShared(db, opts) {
	let partCounter = 0;
	const idRand = (n) => randomUUID().replace(/-/g, "").slice(0, n);
	const hexTime = (time) => time.toString(16).padStart(10, "0");
	return {
		db,
		now: opts.now,
		dir: opts.dir,
		path: {
			cwd: opts.dir,
			root: opts.dir
		},
		modelID: opts.modelID,
		providerID: opts.providerID,
		keepSynthetic: opts.keepSynthetic,
		snapshot: "0".repeat(40),
		newMsgId: (time) => `msg_${hexTime(time)}${idRand(14)}`,
		newPartId: (time) => `prt_${hexTime(time)}${String(partCounter++).padStart(4, "0")}${idRand(10)}`
	};
}
function filePartFromBlock(b) {
	const fp = { type: "file" };
	if (b.filename) fp.filename = b.filename;
	if (b.mediaType) fp.mime = b.mediaType;
	if (b.url) fp.url = b.url;
	else if (b.data) fp.url = `data:${b.mediaType ?? "application/octet-stream"};base64,${b.data}`;
	return fp;
}
/**
* Write an array of IR messages into ONE session's message/part rows.
* Shared by the main session and every reconstructed child session.
*/
function writeMessages(scope, sessionRowId, messages, opts = {}) {
	const { db, now, path, modelID, providerID, keepSynthetic, snapshot } = scope;
	const insertMessage = (id, time, data) => {
		db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(id, sessionRowId, time, now, JSON.stringify(data));
	};
	const insertPart = (messageId, data, time) => {
		db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(scope.newPartId(time), messageId, sessionRowId, time, now, JSON.stringify(data));
	};
	const pendingToolOutput = /* @__PURE__ */ new Map();
	const consumedToolMsgs = /* @__PURE__ */ new Set();
	messages.forEach((m, idx) => {
		if (m.role !== "tool") return;
		for (const b of m.content) if (b.type === "tool_result" && b.toolUseId) {
			const prev = pendingToolOutput.get(b.toolUseId);
			pendingToolOutput.set(b.toolUseId, prev ? {
				text: `${prev.text}\n${b.content}`,
				isError: prev.isError || b.isError,
				raw: prev.raw ?? b.rawResult
			} : {
				text: b.content,
				isError: b.isError,
				raw: b.rawResult
			});
			consumedToolMsgs.add(idx);
		}
	});
	const compactionByAnchor = /* @__PURE__ */ new Map();
	for (const c of opts.compaction ?? []) {
		if (typeof c.anchorIndex !== "number") continue;
		const anchor = messages[c.anchorIndex];
		if (!anchor) continue;
		const ocMeta = c.meta?.opencode;
		const anchorOc = anchor.meta?.opencode;
		const dshSource = anchor.meta?.dsh?.source;
		compactionByAnchor.set(c.anchorIndex, {
			summary: c.summary,
			auto: typeof ocMeta?.auto === "boolean" ? ocMeta.auto : typeof anchorOc?.auto === "boolean" ? anchorOc.auto : !(dshSource && typeof dshSource.sourceCommandId === "string")
		});
	}
	let currentUserId;
	messages.forEach((m, idx) => {
		if (consumedToolMsgs.has(idx) && m.role === "tool") return;
		const isCompactionAnchor = compactionByAnchor.has(idx);
		if (m.role === "system" && !isCompactionAnchor) return;
		if (m.synthetic && !keepSynthetic && !isCompactionAnchor) return;
		const time = m.timestamp ?? now;
		const id = scope.newMsgId(time);
		if (m.role === "user" || m.role === "developer") {
			if (compactionByAnchor.has(idx)) {
				const entry = compactionByAnchor.get(idx);
				insertMessage(id, time, {
					role: "user",
					time: { created: time },
					agent: "build",
					model: {
						providerID,
						modelID
					},
					summary: { diffs: [] }
				});
				insertPart(id, {
					type: "compaction",
					auto: entry.auto
				}, time);
				currentUserId = id;
				const summaryId = scope.newMsgId(time + 1);
				const summaryData = {
					parentID: id,
					role: "assistant",
					mode: "compaction",
					agent: "compaction",
					path,
					cost: 0,
					tokens: zeroTokens,
					modelID,
					providerID,
					time: {
						created: time + 1,
						completed: time + 1
					},
					finish: "stop",
					summary: true
				};
				insertMessage(summaryId, time + 1, summaryData);
				insertPart(summaryId, {
					type: "step-start",
					snapshot
				}, time + 1);
				insertPart(summaryId, {
					type: "text",
					text: entry.summary
				}, time + 1);
				insertPart(summaryId, {
					type: "step-finish",
					reason: "stop",
					snapshot,
					tokens: zeroTokens,
					cost: 0
				}, time + 1);
				return;
			}
			insertMessage(id, time, {
				role: "user",
				time: { created: time },
				agent: "build",
				model: {
					providerID,
					modelID
				},
				summary: { diffs: [] }
			});
			for (const b of m.content) if (b.type === "text") insertPart(id, {
				type: "text",
				text: b.text,
				ignored: m.synthetic ? true : void 0,
				synthetic: m.synthetic ? true : void 0
			}, time);
			else if (b.type === "file") insertPart(id, filePartFromBlock(b), time);
			currentUserId = id;
			return;
		}
		if (m.role === "tool") {
			const text = m.content.filter((b) => b.type === "tool_result").map((b) => b.content).join("\n");
			if (!text) return;
			insertMessage(id, time, {
				role: "user",
				time: { created: time },
				agent: "build",
				model: {
					providerID,
					modelID
				},
				summary: { diffs: [] }
			});
			insertPart(id, {
				type: "text",
				text: `[tool result] ${text}`
			}, time);
			return;
		}
		const hasToolCall = m.content.some((b) => b.type === "tool_use");
		const data = {
			...currentUserId ? { parentID: currentUserId } : {},
			role: "assistant",
			mode: "build",
			agent: "build",
			path,
			cost: 0,
			tokens: zeroTokens,
			modelID,
			providerID,
			time: {
				created: time,
				completed: time
			},
			finish: hasToolCall ? "tool-calls" : "stop"
		};
		insertMessage(id, time, data);
		insertPart(id, {
			type: "step-start",
			snapshot
		}, time);
		for (const b of m.content) if (b.type === "thinking") {
			const durMs = Math.min(6e5, Math.max(1e3, Math.round(b.thinking.length / 200) * 1e3));
			insertPart(id, {
				type: "reasoning",
				text: b.thinking,
				time: {
					start: time,
					end: time + durMs
				}
			}, time);
		} else if (b.type === "text") insertPart(id, {
			type: "text",
			text: b.text
		}, time);
		else if (b.type === "file") insertPart(id, filePartFromBlock(b), time);
		else if (b.type === "tool_use") {
			const outInfo = pendingToolOutput.get(b.id);
			const mappedTool = mapToolPart(b.name, b.input ?? {}, outInfo?.text);
			let output = outInfo?.text ?? "";
			let metadata = mappedTool.metadata;
			const isTask = mappedTool.tool === "task" || String(b.name).toLowerCase() === "task";
			let taskChildId;
			if (isTask) {
				const child = opts.resolveTask?.(b.id, mappedTool.input);
				if (child) {
					taskChildId = child.childId;
					metadata = {
						parentSessionId: sessionRowId,
						sessionId: child.childId,
						model: {
							modelID,
							providerID
						},
						truncated: false
					};
				}
			}
			let state;
			if (!outInfo) state = {
				status: "pending",
				input: mappedTool.input,
				raw: ""
			};
			else if (outInfo.isError) state = {
				status: "error",
				input: mappedTool.input,
				error: isTask && taskChildId ? wrapTaskOutput(taskChildId, unwrapTaskOutput(output).text, true) : output,
				...isTask && taskChildId ? { metadata } : {},
				time: {
					start: time,
					end: time
				}
			};
			else {
				if (isTask && taskChildId) output = wrapTaskOutput(taskChildId, unwrapTaskOutput(output).text, false);
				state = {
					status: "completed",
					title: mappedTool.title,
					input: mappedTool.input,
					output,
					metadata,
					time: {
						start: time,
						end: time
					}
				};
			}
			insertPart(id, {
				type: "tool",
				tool: mappedTool.tool,
				callID: b.id,
				state
			}, time);
		}
		insertPart(id, {
			type: "step-finish",
			reason: hasToolCall ? "tool-calls" : "stop",
			snapshot,
			tokens: zeroTokens,
			cost: 0
		}, time);
	});
}
/** Map a source subagent type onto OpenCode's lowercase agent vocabulary. */
function mapAgentType(agentType) {
	const t = (agentType ?? "").trim().toLowerCase();
	if (!t) return null;
	return t === "general-purpose" ? "general" : t;
}
function firstUserText(messages) {
	const u = messages.find((m) => m.role === "user");
	if (!u) return "";
	return u.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function matchByPrompt(input, queue) {
	const prompt = typeof input.prompt === "string" ? input.prompt : "";
	if (!prompt) return void 0;
	return queue.find((sc) => firstUserText(sc.messages) === prompt);
}
/**
* Write an IR session into the REAL v1.18 schema: project + session +
* message + part. No silent error swallowing — a failed insert throws.
*
* Sidechains (flatten=false, the hidden-semantics path): every sidechain
* becomes a native CHILD SESSION row (session.parent_id) whose transcript is
* written in full, and the matching task tool part in the parent gets
* state.metadata.sessionId pointing at it — the exact shape opencode's own
* task tool produces. Sidechains no task call claims are still written as
* standalone child sessions so the transcript survives. Matching order:
* meta.opencode.callId → agentId → first-user-prompt equality → FIFO (the
* zcode adapter's proven chain).
*/
function writeToDb(db, ir, newId, cwd, flatten, keepSynthetic) {
	const now = Date.now();
	const dir = fwdSlash(cwd || "/");
	ensureGlobalProject(db);
	const projectId = resolveProjectRow(db, dir);
	const pathCol = sessionPathColumn(resolveWorktree(cwd || "/"), cwd || "/");
	const scope = makeWriteShared(db, {
		now,
		dir,
		modelID: ir.model?.id ?? "glm-5.3-flash",
		providerID: ir.model?.provider ?? "opencode",
		keepSynthetic
	});
	const insertSessionRow = (p) => {
		const slug = `migrated-${p.id.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase()}`;
		db.prepare("INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title, version, share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission, agent, model, time_created, time_updated, time_compacting, time_archived) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, NULL, ?, ?, NULL, NULL)").run(p.id, projectId, p.parentId ?? null, slug, dir, pathCol, p.title, OPENCODE_APP_VERSION, p.agent ?? null, p.createdAt, now);
	};
	const freshSessionId = () => {
		for (let i = 0; i < 8; i++) {
			const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
			if (!db.prepare("SELECT 1 AS x FROM session WHERE id=?").get(id)) return id;
		}
		return `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}${now.toString(36)}`;
	};
	const created = /* @__PURE__ */ new Map();
	const buildMatcher = (sidechains, parentRowId) => {
		const queue = [...sidechains];
		const byKey = /* @__PURE__ */ new Map();
		for (const sc of queue) {
			const oc = sc.meta?.opencode;
			if (oc && typeof oc.callId === "string" && oc.callId) byKey.set(oc.callId, sc);
			if (sc.agentId) byKey.set(sc.agentId, sc);
		}
		const ensureChildSession = (sc) => {
			const have = created.get(sc);
			if (have) return have;
			const childId = freshSessionId();
			const firstTs = sc.messages.find((m) => typeof m.timestamp === "number" && m.timestamp)?.timestamp;
			insertSessionRow({
				id: childId,
				parentId: parentRowId,
				title: sc.title ?? (sc.agentType ? `${sc.agentType} (subagent)` : "subagent (migrated)"),
				agent: mapAgentType(sc.agentType),
				createdAt: sc.createdAt ?? firstTs ?? now
			});
			created.set(sc, childId);
			const nested = buildMatcher(sc.sidechains ?? [], childId);
			writeMessages(scope, childId, sc.messages, {
				compaction: sc.compaction,
				resolveTask: sc.sidechains?.length ? nested.resolve : void 0
			});
			nested.drain();
			return childId;
		};
		const resolve = (callId, input) => {
			const linked = byKey.get(callId);
			const sc = (linked && queue.includes(linked) ? linked : void 0) ?? matchByPrompt(input, queue) ?? queue[0];
			if (!sc) return void 0;
			const at = queue.indexOf(sc);
			if (at >= 0) queue.splice(at, 1);
			return { childId: ensureChildSession(sc) };
		};
		const drain = () => {
			while (queue.length) ensureChildSession(queue.shift());
		};
		return {
			resolve,
			drain
		};
	};
	insertSessionRow({
		id: newId,
		title: ir.title ?? "(migrated)",
		createdAt: ir.createdAt ?? now
	});
	if (flatten) {
		writeMessages(scope, newId, ir.messages, { compaction: ir.compaction });
		let t = now;
		for (const m of ir.messages) if (typeof m.timestamp === "number" && m.timestamp > t) t = m.timestamp;
		t += 1;
		for (const sc of ir.sidechains ?? []) writeMessages(scope, newId, sc.messages.map((m) => ({
			...m,
			timestamp: t++
		})), { compaction: sc.compaction });
	} else {
		const matcher = buildMatcher(ir.sidechains ?? [], newId);
		writeMessages(scope, newId, ir.messages, {
			compaction: ir.compaction,
			resolveTask: (ir.sidechains ?? []).length ? matcher.resolve : void 0
		});
		matcher.drain();
	}
	return newId;
}
const MIRROR_MESSAGE_ROLES = /* @__PURE__ */ new Set([
	"user",
	"assistant",
	"tool",
	"system",
	"developer"
]);
function opencodeMessageFromMigrated(msg) {
	return {
		type: MIRROR_MESSAGE_ROLES.has(msg.role) ? msg.role : "system",
		content: msg.content,
		timestamp: msg.timestamp
	};
}
async function parseFromMirror(mirrorPath) {
	const records = (await promises.readFile(mirrorPath, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
	const header = records.find((r) => r.type === "mirror-header");
	const msgs = records.filter((r) => r.type !== "mirror-header" && r.type !== "mirror-sidechain").map((r) => {
		return {
			role: MIRROR_MESSAGE_ROLES.has(String(r.type)) ? String(r.type) : "system",
			content: normalizeContent(Array.isArray(r.content) ? r.content : []),
			timestamp: typeof r.timestamp === "number" ? r.timestamp : void 0
		};
	});
	const scRecs = records.filter((r) => r.type === "mirror-sidechain");
	const sidechains = scRecs.length ? scRecs.map((r) => ({
		agentId: String(r.agentId ?? ""),
		kind: r.kind === "teammate" ? "teammate" : "subagent",
		agentType: r.agentType ? String(r.agentType) : void 0,
		messages: Array.isArray(r.messages) ? r.messages.map((m) => ({
			role: m.role ?? "assistant",
			content: normalizeContent(m.content),
			timestamp: m.timestamp
		})) : []
	})) : void 0;
	const ir = {
		schemaVersion: 2,
		originTool: "opencode",
		originSessionId: header?.id,
		cwd: header?.cwd,
		title: header?.title,
		createdAt: header?.createdAt,
		model: header?.model,
		messages: msgs
	};
	if (sidechains?.length) ir.sidechains = sidechains;
	return validateSession(ir);
}
/**
* The mirror is the lossless IR dump (sidechains stay sidechain records
* regardless of flatten) — flatten only changes native DB reconstruction.
*/
async function writeToMirror(mirrorPath, ir, newId, cwd, _flatten) {
	const header = {
		type: "mirror-header",
		id: newId,
		cwd,
		title: ir.title,
		createdAt: ir.createdAt ?? Date.now(),
		model: ir.model
	};
	const lines = [JSON.stringify(header)];
	for (const msg of ir.messages) lines.push(JSON.stringify(opencodeMessageFromMigrated(msg)));
	for (const sc of ir.sidechains ?? []) lines.push(JSON.stringify({
		type: "mirror-sidechain",
		agentId: sc.agentId,
		kind: sc.kind,
		agentType: sc.agentType,
		messages: sc.messages
	}));
	await promises.writeFile(mirrorPath, lines.join("\n") + "\n", "utf8");
}
//#endregion
//#region ../core/dist/src/index.js
var src_exports = /* @__PURE__ */ __exportAll({
	ClaudeAdapter: () => ClaudeAdapter,
	CodexAdapter: () => CodexAdapter,
	DIGEST_EXCERPT_CAP: () => 200,
	DIGEST_FIRST_USER_DEFAULT: () => 3,
	DSH_KNOWN_EVENT_TYPES: () => DSH_KNOWN_EVENT_TYPES,
	DshAdapter: () => DshAdapter,
	IR_VERSION: () => "3.3",
	MAX_SANITIZED_LENGTH: () => 200,
	blocksToText: () => blocksToText,
	buildIrFromEvents: () => buildIrFromEvents,
	builtinRegistry: () => builtinRegistry,
	compareIrVersions: () => compareIrVersions,
	createRegistry: () => createRegistry,
	defaultDshRoot: () => defaultDshRoot,
	fallbackIr: () => fallbackIr,
	irToEvents: () => irToEvents,
	isContentBlock: () => isContentBlock,
	isMigratedMessage: () => isMigratedMessage,
	listSessions: () => listSessions,
	normalizeContent: () => normalizeContent,
	previewSession: () => previewSession,
	readSource: () => readSource,
	summarizeIr: () => summarizeIr,
	validateSession: () => validateSession,
	writeTarget: () => writeTarget
});
/** Build a registry with all built-in adapters wired. */
function builtinRegistry() {
	const registry = createRegistry();
	registry.register(new DshAdapter());
	registry.register(new ClaudeAdapter());
	registry.register(new CodexAdapter());
	registry.register(new PiAdapter());
	registry.register(new OpenCodeAdapter());
	registry.register(new ZcodeAdapter());
	return registry;
}
//#endregion
//#region src/index.ts
/**
* cc-migrate CLI.
*
* Usage:
*   cc-migrate tools
*   cc-migrate list <tool> [--root <dir>] [--cwd <dir>] [--limit N] [--json]
*   cc-migrate preview <tool> <sessionId> [--root <dir>] [--json] [--messages K] [--lines N] [--full]
*   cc-migrate migrate <srcTool> <srcSessionId> <dstTool>
*                    [--src-root <dir>] [--dst-root <dir>] [--target-cwd <path>]
*                    [--keep-runtime-context] [--json]
*   cc-migrate skill install [--agent <id,id>|--all] [--dir <path>] [--json]
*   cc-migrate skill status [--json]
*   cc-migrate skill path
*   cc-migrate wizard [--src-root <dir>] [--dst-root <dir>]  # interactive
*   cc-migrate reconcile dsh [--root <dir>]  # fix workspace.json registration
*   cc-migrate verify dsh [--root <dir>] [sessionId]  # validate artifacts
*   cc-migrate demo      # dsh->dsh self round-trip
*   cc-migrate demo2     # claude<->dsh round-trip in a temp dir
*
* Agent-facing surface (the skill at skills/cc-migrate/SKILL.md teaches this):
* `--json` everywhere emits machine-readable output; `preview --json` is a
* strictly bounded digest (~1-2KB) so an agent can confirm "is this the
* session" without pulling a transcript into its context window; `list` caps
* at 50 items / 120-char titles unless `--limit 0` lifts the cap; `--cwd`
* filters a listing to one project.
*/
/** win32/darwin 路径大小写不敏感；posix 保留大小写。 */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";
function normPath(p) {
	const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
	return CASE_INSENSITIVE_PATHS ? unified.toLowerCase() : unified;
}
/** list 输出的标题体量上限：压平空白 + 截断（上下文预算：50 条 × ≤120 字符标题）。 */
const TITLE_CAP = 120;
function capTitle(title) {
	if (title === void 0) return void 0;
	const flat = title.replace(/\s+/g, " ").trim();
	return flat.length > TITLE_CAP ? `${flat.slice(0, 119)}…` : flat || void 0;
}
/** list 的默认条数上限（--limit 0 解除）。 */
const LIST_DEFAULT_LIMIT = 50;
function parseFlags(argv) {
	const f = {};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		const value = (name) => i + 1 < argv.length ? argv[++i] : void 0;
		if (tok === "--root") f.root = value("root");
		else if (tok === "--src-root") f.srcRoot = value("src-root");
		else if (tok === "--dst-root") f.dstRoot = value("dst-root");
		else if (tok === "--target-cwd") f.targetCwd = value("target-cwd");
		else if (tok === "--cwd") f.cwd = value("cwd");
		else if (tok === "--agent") f.agent = value("agent");
		else if (tok === "--dir") f.dir = value("dir");
		else if (tok === "--limit") {
			const n = Number.parseInt(value("limit") ?? "", 10);
			if (!Number.isFinite(n) || n < 0) {
				console.error("--limit expects a non-negative integer (0 = unlimited)");
				process.exit(1);
			}
			f.limit = n;
		} else if (tok === "--messages") {
			const n = Number.parseInt(value("messages") ?? "", 10);
			if (!Number.isFinite(n) || n < 0 || n > 20) {
				console.error("--messages expects an integer in 0..20");
				process.exit(1);
			}
			f.messages = n;
		} else if (tok === "--lines") {
			const n = Number.parseInt(value("lines") ?? "", 10);
			if (!Number.isFinite(n) || n <= 0) {
				console.error("--lines expects a positive integer");
				process.exit(1);
			}
			f.lines = n;
		} else if (tok === "--json") f.json = true;
		else if (tok === "--flatten") f.flatten = value("flatten") !== "false";
		else if (tok === "--no-flatten") f.flatten = false;
		else if (tok === "--keep-runtime-context") f.keepSynthetic = true;
		else if (tok === "--system-prompt") {
			const v = value("system-prompt");
			if (v !== "source" && v !== "target") {
				console.error(`--system-prompt must be "source" or "target", got "${v}"`);
				process.exit(1);
			}
			f.systemPromptSource = v;
		} else if (tok === "--full") f.full = true;
		else positionals.push(tok);
	}
	return {
		flags: f,
		positionals
	};
}
const SKILL_TARGETS = [
	{
		id: "agents",
		homeCandidates: [".agents"],
		skillDir: ".agents/skills",
		note: "跨工具共享 skill 根（ZCode/DSH/Claude 等都读）"
	},
	{
		id: "claude",
		homeCandidates: [".claude"],
		skillDir: ".claude/skills",
		note: "Claude Code 用户级 skills"
	},
	{
		id: "zcode",
		homeCandidates: [".zcode"],
		skillDir: ".zcode/skills",
		note: "ZCode 用户级 skills"
	},
	{
		id: "dsh",
		homeCandidates: [".dsh"],
		skillDir: ".dsh/skills",
		note: "DSH 用户级 skills（装了 cc-migrate 插件时其运行时 skill 优先生效）"
	},
	{
		id: "pi",
		homeCandidates: [".pi"],
		skillDir: ".pi/agent/skills",
		note: "pi 用户级 skills"
	},
	{
		id: "codex",
		homeCandidates: [".codex"],
		skillDir: ".codex/skills",
		note: "Codex CLI skills"
	},
	{
		id: "opencode",
		homeCandidates: [".config/opencode", ".opencode"],
		skillDir: ".config/opencode/skill",
		note: "OpenCode 全局 skill（目录名为单数）"
	}
];
const SKILL_NAME = "cc-migrate";
/** 随包分发的通用 SKILL.md。仓库布局（bundle/index.js → ../../skills）与
* npm 安装布局（node_modules/@cc-migrate/cli/bundle/index.js → ../skills）
* 深度不同 —— 依次探测两个候选。 */
function bundledSkillPath() {
	const here = import.meta.url;
	for (const rel of ["../../skills/cc-migrate/SKILL.md", "../skills/cc-migrate/SKILL.md"]) {
		const p = fileURLToPath(new URL(rel, here));
		if (existsSync(p)) return p;
	}
	return fileURLToPath(new URL("../skills/cc-migrate/SKILL.md", here));
}
function targetSkillDir(t) {
	return join(homedir(), t.skillDir, SKILL_NAME);
}
function runSkillInstall(flags, subArgs) {
	if (subArgs.length > 0) {
		console.error("usage: cc-migrate skill install [--agent <id,id>|--all] [--dir <path>] [--json]");
		process.exit(1);
	}
	const src = bundledSkillPath();
	if (!existsSync(src)) {
		console.error(`error: bundled SKILL.md missing at ${src} — reinstall the CLI package`);
		process.exit(1);
	}
	const rows = [];
	if (flags.dir) {
		const dir = isAbsolute(flags.dir) ? flags.dir : resolve(flags.dir);
		mkdirSync(dir, { recursive: true });
		const dest = join(dir, "SKILL.md");
		copyFileSync(src, dest);
		rows.push({
			id: "custom",
			action: "installed",
			path: dest
		});
	} else {
		let targets;
		if (flags.agent === "all" || flags.agent === void 0) {
			targets = SKILL_TARGETS.filter((t) => t.homeCandidates.some((h) => existsSync(join(homedir(), h))));
			if (flags.agent === void 0 && targets.length === 0) {
				console.error("error: no supported agent home detected (~/.claude ~/.zcode ~/.agents ~/.dsh ~/.pi ~/.codex ~/.config/opencode) — use --dir <path> or --agent <id>");
				process.exit(1);
			}
		} else {
			targets = [];
			for (const id of flags.agent.split(",").map((s) => s.trim()).filter(Boolean)) {
				const t = SKILL_TARGETS.find((x) => x.id === id);
				if (!t) {
					console.error(`unknown agent "${id}" — available: ${SKILL_TARGETS.map((x) => x.id).join(", ")}`);
					process.exit(1);
				}
				targets.push(t);
			}
		}
		for (const t of targets) {
			const dir = targetSkillDir(t);
			try {
				mkdirSync(dir, { recursive: true });
				copyFileSync(src, join(dir, "SKILL.md"));
				rows.push({
					id: t.id,
					action: "installed",
					path: join(dir, "SKILL.md")
				});
			} catch (e) {
				rows.push({
					id: t.id,
					action: "skipped",
					reason: e instanceof Error ? e.message : String(e)
				});
			}
		}
	}
	if (flags.json) {
		console.log(JSON.stringify({
			ok: true,
			source: src,
			results: rows
		}, null, 2));
		return;
	}
	console.log(`source: ${src}`);
	for (const r of rows) if (r.action === "installed") console.log(`installed ${r.id}: ${r.path}`);
	else console.log(`skipped  ${r.id}: ${r.reason ?? "unknown reason"}`);
}
function runSkillStatus(flags) {
	const src = bundledSkillPath();
	const rows = SKILL_TARGETS.map((t) => {
		const homeFound = t.homeCandidates.some((h) => existsSync(join(homedir(), h)));
		const path = targetSkillDir(t);
		return {
			id: t.id,
			homeFound,
			installed: existsSync(join(path, "SKILL.md")),
			path,
			note: t.note
		};
	});
	if (flags.json) {
		console.log(JSON.stringify({
			ok: true,
			source: existsSync(src) ? src : null,
			targets: rows
		}, null, 2));
		return;
	}
	console.log(`source: ${src}${existsSync(src) ? "" : "  (MISSING — reinstall the CLI package)"}`);
	for (const r of rows) {
		const state = r.installed ? "installed" : r.homeFound ? "not installed" : "agent not detected";
		console.log(`${state.padEnd(18)} ${r.id.padEnd(9)} ${r.path}`);
	}
	console.log("\ninstall: cc-migrate skill install [--agent <id>|--all] [--dir <path>]");
}
async function main(argv) {
	const { flags, positionals } = parseFlags(argv);
	const [cmd, ...args] = positionals;
	const [a, b, c] = args;
	const registry = builtinRegistry();
	/** registry.get with an agent-friendly unknown-tool error (usage + valid ids). */
	function resolveAdapter(reg, tool) {
		try {
			return reg.get(tool);
		} catch {
			console.error(`unknown tool "${tool}" — available: ${reg.tools().join(", ")}`);
			process.exit(1);
		}
	}
	switch (cmd) {
		case "tools":
			for (const t of registry.tools()) console.log(t);
			return;
		case "list": {
			if (!a) {
				console.error(`usage: cc-migrate list <tool> [--root <dir>] [--cwd <dir>] [--limit N] [--json]\n  tools: ${registry.tools().join(", ")}`);
				process.exit(1);
			}
			let metas = await listSessions(resolveAdapter(registry, a), flags.root ?? flags.srcRoot);
			if (flags.cwd) {
				const needle = normPath(flags.cwd);
				metas = metas.filter((m) => m.cwd !== void 0 && normPath(m.cwd) === needle);
			}
			metas = [...metas].sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0));
			const total = metas.length;
			const limit = flags.limit === void 0 ? LIST_DEFAULT_LIMIT : flags.limit;
			if (limit > 0) metas = metas.slice(0, limit);
			const capped = metas.map((m) => ({
				...m,
				...m.title !== void 0 ? { title: capTitle(m.title) } : {}
			}));
			if (flags.json) {
				console.log(JSON.stringify(capped, null, 2));
				return;
			}
			for (const m of capped) {
				const archived = m.archived ? "[archived] " : "";
				console.log(`${archived}${m.sessionId}\t${m.title ?? ""}\t${m.createdAt ? new Date(m.createdAt).toISOString() : ""}\t${m.sourcePath ?? ""}`);
			}
			if (limit > 0 && total > metas.length) console.error(`[list] 共 ${total} 条，已按默认上限显示 ${metas.length} 条 —— 用 --cwd 缩小范围或 --limit 0 看全部`);
			return;
		}
		case "preview": {
			if (!a || !b) {
				console.error("usage: cc-migrate preview <tool> <sessionId> [--json] [--messages K] [--lines N] [--full]");
				process.exit(1);
			}
			const adapter = resolveAdapter(registry, a);
			const ir = await readSource(registry, a, b, flags.root ?? flags.srcRoot);
			if (flags.json) {
				const digest = summarizeIr(ir, { ...flags.messages !== void 0 ? { firstUserMessages: flags.messages } : {} });
				console.log(JSON.stringify(digest, null, 2));
				return;
			}
			const text = previewSession(adapter, ir);
			const lines = text.split("\n");
			const HEAD = flags.lines ?? 120;
			if (flags.full || lines.length <= HEAD) {
				if (flags.full && lines.length > HEAD) console.error(`[preview] --full：共 ${lines.length} 行 / ${text.length} 字符 —— 注意上下文体量`);
				process.stdout.write(text);
				return;
			}
			for (const l of lines.slice(0, HEAD)) process.stdout.write(l + "\n");
			console.error(`\n[preview] 共 ${lines.length} 行，已显示前 ${HEAD} 行 —— agent 请改用 --json 摘要；--lines N 调行数；--full 全文`);
			return;
		}
		case "skill": {
			const sub = a;
			if (sub === "install") {
				runSkillInstall(flags, args.slice(1));
				return;
			}
			if (sub === "status") {
				runSkillStatus(flags);
				return;
			}
			if (sub === "path") {
				console.log(bundledSkillPath());
				return;
			}
			console.error("usage: cc-migrate skill <install|status|path> [--agent <id,id>|--all] [--dir <path>] [--json]");
			process.exit(1);
		}
		case "migrate": {
			if (!a || !b || !c) {
				console.error("usage: cc-migrate migrate <srcTool> <srcSessionId> <dstTool> [--json]");
				process.exit(1);
			}
			const ir = await readSource(registry, a, b, flags.root ?? flags.srcRoot);
			const adapter = resolveAdapter(registry, c);
			const disambiguateTitle = a === "dsh" && c === "dsh";
			const res = await writeTarget(adapter, ir, {
				root: flags.dstRoot,
				targetCwd: flags.targetCwd ?? ir.cwd,
				flatten: flags.flatten,
				keepSynthetic: flags.keepSynthetic,
				...flags.systemPromptSource ? { systemPromptSource: flags.systemPromptSource } : {},
				...disambiguateTitle ? { disambiguateTitle: true } : {}
			});
			if (flags.json) {
				console.log(JSON.stringify(res, null, 2));
				return;
			}
			console.log(`migrated ${a}:${b} -> ${c}:${res.sessionId}`);
			for (const p of res.paths) console.log(`  ${p}`);
			return;
		}
		case "reconcile":
			if (a === "dsh" || !a) {
				const { reconcileWorkspaces } = await import("@cc-migrate/core/workspace");
				const { defaultDshRoot } = await Promise.resolve().then(() => src_exports);
				const root = flags.root ?? flags.dstRoot ?? defaultDshRoot();
				if (!root) {
					console.error("cannot resolve DSH sessions root");
					process.exit(1);
				}
				const res = await reconcileWorkspaces(root);
				console.log(`reconciled ${res.scanned} sessions, registered ${res.registered} orphan(s), pruned ${res.pruned ?? 0} dangling`);
				if (res.errors?.length) for (const e of res.errors) console.error("  " + e);
				return;
			}
			console.error("usage: cc-migrate reconcile [dsh] [--root <dir>]");
			process.exit(1);
		case "verify":
			if (a === "dsh" || !a) {
				const { verifySessionById, verifyAllSessions } = await import("@cc-migrate/core/verify");
				const { defaultDshRoot } = await Promise.resolve().then(() => src_exports);
				const root = flags.root ?? flags.dstRoot ?? defaultDshRoot();
				const sid = b;
				const results = sid ? [await verifySessionById(sid, root)] : await verifyAllSessions(root);
				let failed = 0;
				for (const r of results) if (r.ok) {
					const s = r.stats;
					console.log(`OK   ${r.sessionId || "(root)"}  events=${s.events} assistant=${s.assistantMessages} text=${s.textBlocks} reasoning=${s.reasoningBlocks} toolCalls=${s.toolCalls} turns=${s.turns}`);
				} else {
					failed++;
					console.log(`FAIL ${r.sessionId || "(root)"}`);
					for (const issue of r.issues) {
						const at = [issue.line !== void 0 ? `line ${issue.line}` : null, issue.seq !== void 0 ? `seq ${issue.seq}` : null].filter(Boolean).join(", ");
						console.log(`     [${issue.check}]${at ? " " + at : ""}: ${issue.message}`);
					}
				}
				console.log(`verified ${results.length} session(s), ${failed} failing`);
				if (failed > 0) process.exit(1);
				return;
			}
			console.error("usage: cc-migrate verify [dsh] [--root <dir>] [sessionId]");
			process.exit(1);
		case "wizard":
		case "interactive":
		case "wiz": {
			const { runWizard } = await import("./wizard-DY3v8hKT.js");
			const { createInterface } = await import("node:readline");
			const rl = createInterface({
				input: process.stdin,
				output: process.stdout
			});
			const io = {
				print: (line) => console.log(line),
				question: (prompt) => new Promise((resolve) => rl.question(prompt, resolve)),
				close: () => rl.close()
			};
			const pre = {};
			if (flags.srcRoot ?? flags.root) pre.srcRoot = flags.srcRoot ?? flags.root;
			if (flags.dstRoot) pre.dstRoot = flags.dstRoot;
			if (flags.targetCwd) pre.targetCwd = flags.targetCwd;
			if (flags.flatten !== void 0) pre.flatten = flags.flatten;
			try {
				if (!await runWizard(io, {
					builtinRegistry,
					previewSession: (await Promise.resolve().then(() => src_exports)).previewSession,
					readSource: (await Promise.resolve().then(() => src_exports)).readSource,
					writeTarget: (await Promise.resolve().then(() => src_exports)).writeTarget,
					listSessions: (await Promise.resolve().then(() => src_exports)).listSessions
				}, pre)) process.exit(1);
			} finally {
				io.close();
			}
			return;
		}
		case "demo":
			await runDemo(registry);
			return;
		case "demo2":
			await runDemoClaude(registry);
			return;
		default:
			console.error(`usage: cc-migrate <tools|list|preview|migrate|verify|reconcile|wizard|demo|demo2> [...]
  tools: ${registry.tools().join(", ")}`);
			process.exit(1);
	}
}
async function runDemo(registry) {
	const { mkdtemp } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const ir = fallbackIr();
	const dsh = registry.get("dsh");
	console.log("--- demo: dsh -> dsh self round-trip (temp dir) ---");
	const tmp = await mkdtemp(join(tmpdir(), "sm-demo-"));
	const res = await writeTarget(dsh, ir, {
		root: tmp,
		targetCwd: process.cwd()
	});
	console.log("wrote:", res.paths);
	const back = await readSource(registry, "dsh", res.sessionId, tmp);
	console.log("round trip sessionId:", back.originSessionId);
	console.log("messages back:", back.messages.length);
	console.log("first msg role:", back.messages[0]?.role, "\ntext:", (back.messages[0]?.content[0])?.text);
}
async function runDemoClaude(registry) {
	const { mkdtemp } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	console.log("--- demo2: claude -> dsh -> claude round-trip (temp dirs) ---");
	const claudeRoot = await mkdtemp(join(tmpdir(), "sm-claude-"));
	const dshRoot = await mkdtemp(join(tmpdir(), "sm-dsh-"));
	const ir = fallbackIr();
	const w1 = await writeTarget(registry.get("claude"), ir, {
		root: claudeRoot,
		targetCwd: "D:\\demo\\proj"
	});
	console.log("claude wrote:", w1.paths[0]);
	const back1 = await readSource(registry, "claude", w1.sessionId, claudeRoot);
	console.log("claude->ir messages:", back1.messages.length, "sessionId:", back1.originSessionId);
	const w2 = await writeTarget(registry.get("dsh"), back1, {
		root: dshRoot,
		targetCwd: "D:\\demo\\proj"
	});
	console.log("dsh wrote:", w2.paths[0]);
	const back2 = await readSource(registry, "dsh", w2.sessionId, dshRoot);
	console.log("dsh->ir messages:", back2.messages.length);
	const t0 = ir.messages[0].content[0].text;
	const t2 = back2.messages[0].content[0].text;
	console.log("first msg preserved across claude->dsh loop:", t0 === t2);
}
main(process.argv.slice(2)).catch((e) => {
	console.error(e);
	process.exit(1);
});
//#endregion
export {};
