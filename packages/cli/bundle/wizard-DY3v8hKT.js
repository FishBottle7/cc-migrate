//#region src/wizard.ts
const TOOLS = [
	"dsh",
	"claude",
	"codex",
	"pi",
	"opencode",
	"zcode"
];
/** Resolve default roots for display. */
function defaultRootFor(tool) {
	switch (tool) {
		case "dsh": return "~/.dsh/sessions";
		case "claude": return "~/.claude/projects";
		case "codex": return "~/.codex/sessions";
		case "pi": return "~/.pi/agent/sessions";
		case "opencode": return "~/.local/share/opencode/opencode.db";
		case "zcode": return "~/.zcode/cli/db/db.sqlite";
		default: return "";
	}
}
/** Filter metas by substring (case-insensitive) on id/title/cwd/path. */
function filterMetas(metas, query) {
	const q = query.trim().toLowerCase();
	if (!q) return metas;
	return metas.filter((m) => String(m.sessionId).toLowerCase().includes(q) || String(m.title ?? "").toLowerCase().includes(q) || String(m.cwd ?? "").toLowerCase().includes(q) || String(m.sourcePath ?? "").toLowerCase().includes(q));
}
/** Parse a 1-based selection input (supports "3" or "3 " plus aliases like "q" for quit). */
function parseSelection(input, max) {
	const raw = input.trim();
	if (!raw) return {
		kind: "filter",
		query: ""
	};
	if (/^(q|quit|exit)$/i.test(raw)) return { kind: "quit" };
	if (/^f\s+/i.test(raw) || raw.startsWith("/")) return {
		kind: "filter",
		query: raw.startsWith("/") ? raw.slice(1) : raw.slice(1).trim()
	};
	const n = Number(raw);
	if (Number.isInteger(n) && n >= 1 && n <= max) return {
		kind: "select",
		index: n - 1
	};
	return {
		kind: "filter",
		query: raw
	};
}
/** Format a meta for display in the picker list. */
function formatMetaLine(idx, m) {
	const iso = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 19).replace("T", " ") : "—";
	const tail = [m.title ? truncate(m.title, 40) : "", m.cwd ? truncate(m.cwd, 32) : ""].filter(Boolean).join(" | ");
	return `${String(idx + 1).padStart(3)}. ${m.sessionId}  ${iso}${tail ? "  " + tail : ""}`;
}
function truncate(s, n) {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
/**
* Totally pure ordering: sort metas newest-first then promptUuid-ish.
* Mirrors typical gallery UX without touching adapters.
*/
function sortMetas(metas) {
	return [...metas].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
async function tryFilterDshTopLevel(metas) {
	const topLevel = [];
	for (const m of metas) {
		const p = m.sourcePath;
		if (!p) {
			topLevel.push(m);
			continue;
		}
		try {
			const { readFile } = await import("node:fs/promises");
			const buf = await readFile(p);
			let plain;
			try {
				const { zstdDecompressSync } = await import("node:zlib");
				const magic = Buffer.from([
					40,
					181,
					47,
					253
				]);
				const anchors = [];
				let pos = 0;
				for (;;) {
					const found = buf.indexOf(magic, pos);
					if (found === -1) break;
					anchors.push(found);
					pos = found + 4;
				}
				let acc = Buffer.alloc(0);
				for (let i = 0; i < anchors.length; i++) {
					const start = anchors[i];
					const end = i + 1 < anchors.length ? anchors[i + 1] : buf.length;
					acc = Buffer.concat([acc, zstdDecompressSync(buf.subarray(start, end))]);
				}
				plain = acc.toString("utf8");
			} catch {
				plain = buf.toString("utf8");
			}
			const first = plain.split("\n").find((l) => l.trim());
			if (!first) {
				topLevel.push(m);
				continue;
			}
			if (!JSON.parse(first).parentSession) topLevel.push(m);
		} catch {
			topLevel.push(m);
		}
	}
	return topLevel;
}
/**
* Run the wizard with given IO + deps. The outer `wizard` CLI command wires
* this to a real readline IO and real core deps.
*/
async function runWizard(io, deps, pre) {
	const registry = deps.builtinRegistry();
	let srcTool = pre?.srcTool;
	if (!srcTool) {
		io.print("");
		io.print("== cc-migrate wizard ==");
		io.print(`源工具 (source): ${TOOLS.join(" / ")}  [默认 dsh]`);
		const ans = (await io.question("源工具 > ")).trim().toLowerCase() || "dsh";
		if (!TOOLS.includes(ans)) {
			io.print(`未知工具: ${ans}，可选: ${TOOLS.join(", ")}`);
			return null;
		}
		srcTool = ans;
	}
	let srcRoot = pre?.srcRoot;
	if (srcRoot === void 0 && !pre?.srcTool) {
		const def = defaultRootFor(srcTool);
		const ans = (await io.question(`源目录 (默认 ${def}，回车跳过) > `)).trim();
		if (ans) srcRoot = ans;
	}
	let sessionId = pre?.sessionId;
	let pickedMeta;
	if (!sessionId) {
		const adapter = registry.get(srcTool);
		io.print(`\n正在扫描 ${srcTool}${srcRoot ? ` @ ${srcRoot}` : ""} ...`);
		let metas = await deps.listSessions(adapter, srcRoot);
		metas = sortMetas(metas);
		if (srcTool === "dsh" && metas.length > 1) {
			const topLevel = await tryFilterDshTopLevel(metas);
			if (topLevel.length > 0 && topLevel.length < metas.length) {
				io.print(`（已隐藏 ${metas.length - topLevel.length} 个子代理会话，仅显示顶层会话）`);
				metas = topLevel;
			}
		}
		if (metas.length === 0) {
			io.print("未找到任何会话。可用 --src-root 指定目录，或先用 `list` 检查。");
			return null;
		}
		let filtered = metas;
		let filterQuery = "";
		for (;;) {
			const page = filtered.slice(0, 50);
			io.print("");
			io.print(`找到 ${metas.length} 个会话${filterQuery ? `，过滤 "${filterQuery}" 后 ${filtered.length} 个` : ""}（仅显示前 ${page.length} 个）：`);
			for (let i = 0; i < page.length; i++) io.print(formatMetaLine(i, page[i]));
			if (filtered.length > page.length) io.print(`  ... 还有 ${filtered.length - page.length} 个，输入过滤词缩小范围`);
			io.print("");
			io.print("输入编号选择会话；输入文字过滤；`/` 前缀或 `f <词>` 也可过滤；`q` 退出");
			const sel = parseSelection(await io.question("选择 > "), filtered.length);
			if (sel.kind === "quit") return null;
			if (sel.kind === "select") {
				pickedMeta = filtered[sel.index];
				sessionId = pickedMeta.sessionId;
				break;
			}
			const q = (sel.query ?? "").trim();
			filterQuery = q;
			filtered = filterMetas(metas, q);
			if (filtered.length === 0) {
				io.print(`无匹配 "${q}"，回车显示全部或输入其他关键词`);
				const again = await io.question("过滤 > ");
				if (!again.trim()) {
					filtered = metas;
					filterQuery = "";
				} else filtered = filterMetas(metas, again);
			}
		}
		if (pickedMeta || sessionId) {
			const sid = sessionId;
			io.print(`\n—— 预览 ${srcTool}:${sid} ——`);
			try {
				const ir = await deps.readSource(registry, srcTool, sid, srcRoot);
				const adapter = registry.get(srcTool);
				const lines = deps.previewSession(adapter, ir).split("\n");
				const head = lines.slice(0, 80).join("\n");
				io.print(head);
				if (lines.length > 80) io.print(`\n... 还有 ${lines.length - 80} 行（完整内容在迁移后仍保留）`);
			} catch (e) {
				io.print(`预览失败: ${String(e?.message ?? e)}`);
			}
			const ok = (await io.question("\n使用该会话继续？ [Y/n] > ")).trim().toLowerCase();
			if (ok === "n" || ok === "no") return null;
		}
	}
	let dstTool = pre?.dstTool;
	if (!dstTool) {
		io.print(`\n目标工具 (target): ${TOOLS.join(" / ")}  [默认 dsh]`);
		const ans = (await io.question("目标工具 > ")).trim().toLowerCase() || "dsh";
		if (!TOOLS.includes(ans)) {
			io.print(`未知工具: ${ans}`);
			return null;
		}
		dstTool = ans;
	}
	let dstRoot = pre?.dstRoot;
	if (dstRoot === void 0 && !pre?.dstTool) {
		const def = defaultRootFor(dstTool);
		const ans = (await io.question(`目标目录 (默认 ${def}，回车跳过) > `)).trim();
		if (ans) dstRoot = ans;
	}
	let targetCwd = pre?.targetCwd;
	if (targetCwd === void 0 && !pre?.targetCwd) {
		const hint = pickedMeta?.cwd ? ` (源 cwd: ${pickedMeta.cwd})` : "";
		const ans = (await io.question(`目标 cwd${hint}（回车沿用源 cwd）> `)).trim();
		if (ans) targetCwd = ans;
	}
	let cachedIr = null;
	let flatten = pre?.flatten;
	if (flatten === void 0 && (srcTool === "opencode" || dstTool === "opencode" || srcTool === "zcode" || dstTool === "zcode")) {
		try {
			cachedIr = await deps.readSource(registry, srcTool, sessionId, srcRoot);
		} catch {
			cachedIr = null;
		}
		const hasSidechains = !!(cachedIr && typeof cachedIr === "object" && Array.isArray(cachedIr.sidechains) && cachedIr.sidechains.length > 0);
		const sidechainTool = srcTool === "opencode" || srcTool === "zcode" ? srcTool : void 0;
		if (sidechainTool !== void 0 ? true : hasSidechains) {
			let prompt;
			if (sidechainTool === "zcode" && dstTool !== "zcode") prompt = "检测到 ZCode subagent 旁链，是否展平为目标工具的独立旁链（Y=可直接续聊）？ [Y/n] > ";
			else if (sidechainTool === "opencode" && dstTool !== "opencode") prompt = "检测到 OpenCode hidden task，是否展平为目标工具的独立旁链（Y=可直接续聊）？ [Y/n] > ";
			else if (dstTool === "zcode" && srcTool !== "zcode") prompt = "目标为 ZCode，是否将旁链写成 subagent_child 子会话（N，保留隐藏语义）还是展平为顶层消息（Y）？ [Y/n，默认 N] > ";
			else if (dstTool === "opencode" && srcTool !== "opencode") prompt = "目标为 OpenCode，是否将旁链展平为顶层消息（Y）还是压回 task 工具块（N，保留隐藏语义）？ [Y/n，默认 Y] > ";
			else prompt = "同工具间迁移，是否保持旁链嵌套（N）还是展平（Y）？ [Y/n，默认 N] > ";
			const ans = (await io.question(prompt)).trim().toLowerCase();
			flatten = !(ans === "n" || ans === "no");
		}
	}
	io.print("\n—— 即将执行 ——");
	io.print(`  ${srcTool}:${sessionId}  →  ${dstTool}${dstRoot ? ` @ ${dstRoot}` : ""}${targetCwd ? ` (cwd=${targetCwd})` : ""}${flatten !== void 0 ? `  [flatten=${flatten}]` : ""}`);
	const confirm = (await io.question("确认迁移？ [Y/n] > ")).trim().toLowerCase();
	if (confirm === "n" || confirm === "no") {
		io.print("已取消。");
		return null;
	}
	const ir = cachedIr ?? await deps.readSource(registry, srcTool, sessionId, srcRoot);
	const dstAdapter = registry.get(dstTool);
	const disambiguateTitle = srcTool === "dsh" && dstTool === "dsh";
	const res = await deps.writeTarget(dstAdapter, ir, {
		root: dstRoot,
		targetCwd: targetCwd ?? ir.cwd,
		flatten,
		...disambiguateTitle ? { disambiguateTitle: true } : {}
	});
	io.print(`\n已迁移 ${srcTool}:${sessionId} → ${dstTool}:${res.sessionId}`);
	for (const p of res.paths) io.print(`  ${p}`);
	return res;
}
//#endregion
export { runWizard };
