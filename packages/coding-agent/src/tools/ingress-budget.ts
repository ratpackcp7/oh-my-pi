/**
 * Parent-context ingress budget.
 *
 * A single ordinary tool result must not inject an arbitrarily large text blob
 * into the long-lived top-level session's transcript. This module is the one
 * central contract every wrapped tool goes through (see
 * {@link ../tools/output-meta.wrapToolWithMetaNotice}); tools do not reinvent
 * truncation or recovery logic.
 *
 * Design invariants:
 *
 * - **Parent-only.** Ephemeral subagent investigation contexts are left alone;
 *   bounding them would starve the workers whose whole job is bulk discovery.
 *   Gated on {@link AgentToolContext.agentKind}.
 * - **Evidence is never destroyed.** Every reduction carries an exact recovery
 *   route: a `path:start-end` selector for files, the same internal URL plus a
 *   line selector for `agent://`-style pointers, or an `artifact://` id for
 *   generated output. Source files are never copied into an artifact merely to
 *   keep them out of context — the file already is the durable evidence.
 * - **Semantics before bytes.** Structured payloads are replaced by a valid
 *   compact envelope rather than byte-sliced into malformed JSON, and failures
 *   keep head+tail diagnostics instead of losing the error tail.
 * - **No double accounting.** When the generic artifact spill already reduced a
 *   result and minted its artifact, that id is reused rather than saving the
 *   same bytes twice.
 */
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { getDefault, type Settings } from "../config/settings";
import { getLatestCompactionEntry } from "../session/session-context";
import { truncateHead, truncateMiddle, truncateTail } from "../session/streaming-output";
import type { OutputMeta, SourceMeta, TruncationMeta } from "./output-meta-types";

/**
 * Share of the budget spent on the head when a bounded body keeps both ends.
 * Failures are read tail-first (the exception and exit status live at the end),
 * so error shaping inverts this via {@link ERROR_HEAD_FRACTION}.
 */
const HEAD_FRACTION = 0.7;
const ERROR_HEAD_FRACTION = 0.35;

/**
 * Floor on the shaped body. A budget small enough to leave no usable excerpt
 * would turn every large result into a bare pointer, which measurably costs a
 * follow-up turn for evidence the model could have read once.
 */
const MIN_BODY_BYTES = 512;

/** Resolve the parent ingress budget in bytes. 0 (or negative) disables. */
export function resolveParentIngressBudgetBytes(settings: Settings | undefined): number {
	const kb = settings?.get("tools.parentIngressBudget") ?? getDefault("tools.parentIngressBudget");
	return kb > 0 ? Math.round(kb * 1024) : 0;
}

/** Text blocks of a tool result, joined the same way the provider serializes them. */
function collectText(content: readonly (TextContent | ImageContent)[]): string | undefined {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	if (parts.length === 0) return undefined;
	return parts.length === 1 ? parts[0] : parts.join("\n");
}

/** Replace every text block with one shaped block, preserving images in order. */
function withShapedText(
	content: readonly (TextContent | ImageContent)[],
	text: string,
): (TextContent | ImageContent)[] {
	const next: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (block.type !== "text") next.push(block);
	}
	next.push({ type: "text", text });
	return next;
}

/**
 * A JSON document, as opposed to text that merely starts with a brace. Only a
 * full successful parse counts: shaping a structured payload by bytes is the
 * exact corruption this check exists to prevent.
 */
function parseJsonPayload(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (trimmed.length < 2) return undefined;
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

/** 1-indexed line count of `text`, counting a trailing newline as a terminator. */
function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return text.charCodeAt(text.length - 1) === 10 ? lines - 1 : lines;
}

/**
 * Bound `text` to `budget`.
 *
 * `"head"` keeps a leading window, which is what evidence that stays paged at
 * its source needs: the next unread line follows the last line shown, so the
 * recovery selector is exact. `"middle"` keeps both ends and is for payloads
 * whose full bytes were externalized, where the elided region is recovered from
 * the artifact rather than by line arithmetic.
 */
function boundBody(text: string, budget: number, mode: "head" | "middle", headFraction = HEAD_FRACTION): string {
	if (mode === "head") return truncateHead(text, { maxBytes: budget }).content;
	const headBytes = Math.max(MIN_BODY_BYTES, Math.floor(budget * headFraction));
	if (budget - headBytes <= 0) return truncateTail(text, { maxBytes: budget }).content;
	return truncateMiddle(text, { maxBytes: budget, maxHeadBytes: headBytes }).content;
}

/**
 * Leading line-number prefix the read/summary/grep formatters stamp on each
 * line (`120:`, ` 120-134:`, `*120:`). Mirrors the hashline prefix the snapshot
 * store parses, and is the only reliable way to learn which FILE line a bounded
 * excerpt actually ended on: the excerpt's own line count is wrong for any read
 * that started at an offset.
 */
const LINE_NUMBER_PREFIX = /^[ *]?(\d+)(?:-(\d+))?:/;

/**
 * Highest source line number the bounded body displayed, or `undefined` when the
 * content is not line-numbered (a plain `agent://` markdown resource, say).
 */
function lastDisplayedLine(body: string): number | undefined {
	let last: number | undefined;
	for (const line of body.split("\n")) {
		const match = LINE_NUMBER_PREFIX.exec(line);
		if (!match) continue;
		const end = Number(match[2] ?? match[1]);
		if (Number.isFinite(end) && (last === undefined || end > last)) last = end;
	}
	return last;
}

/**
 * First source line the bounded excerpt did NOT show, or `undefined` when it
 * cannot be derived and must therefore not be guessed.
 *
 * Order matters, and every step needs a positive signal that lines are the
 * addressing unit:
 *
 * 1. Line numbers the excerpt itself displayed — exact, and the only correct
 *    answer once the excerpt was cut shorter than the result it came from.
 * 2. `shownRange.start` plus the excerpt's line count. `shownRange` is only ever
 *    produced by line-based truncation, so its presence *is* the signal, and the
 *    start offset is what makes a mid-file `:raw` read addressable.
 * 3. An untruncated internal pointer, which is plain text paged from line 1.
 *
 * Anything else — most importantly a SQLite table dump or other formatted
 * rendering, which shares `source.type === "path"` but pages by its own query
 * syntax — yields `undefined`. A line range there is not merely imprecise: fed
 * back to `read` it is consumed as a table name and the recovery call fails.
 */
function nextUnshownLine(
	kind: "file" | "pointer",
	body: string,
	truncation: TruncationMeta | undefined,
): number | undefined {
	const displayed = lastDisplayedLine(body);
	if (displayed !== undefined) return displayed + 1;
	const start = truncation?.shownRange?.start;
	if (start !== undefined) return start + countLines(body);
	if (truncation === undefined && kind === "pointer") return countLines(body) + 1;
	return undefined;
}

/**
 * Recovery instruction for evidence that stays where it already lives: a source
 * file, or a durable internal pointer. A concrete `:start-end` example is only
 * offered when {@link nextUnshownLine} can derive the resume line; otherwise we
 * name the source and let the model pick the selector its syntax defines.
 */
function selectorRecoveryNotice(
	kind: "file" | "pointer",
	sourceValue: string,
	totalLines: number,
	body: string,
	truncation: TruncationMeta | undefined,
): string {
	const nextStart = nextUnshownLine(kind, body, truncation);
	const identity =
		kind === "file" ? "The file on disk remains the source of truth" : "The pointer is durable and can be paged";
	const scale = totalLines > 0 ? ` (${totalLines.toLocaleString()} lines before reduction)` : "";
	const recovery =
		nextStart === undefined
			? `[Recover exact evidence by re-reading \`${sourceValue}\` with a narrower selector, using the selector syntax that source supports. Request only the region you need.]`
			: `[Recover exact evidence with a range selector, e.g. \`${sourceValue}:${nextStart}-${nextStart + 199}\`. Request only the ranges you need.]`;
	return ["", `[Parent ingress budget: this result was reduced${scale}. ${identity}.]`, recovery].join("\n");
}

/** Recovery instruction for generated output that had to be externalized. */
function artifactRecoveryNotice(artifactId: string | undefined, totalLines: number, totalBytes: number): string {
	const scale = `${totalLines.toLocaleString()} lines, ${totalBytes.toLocaleString()} bytes`;
	if (!artifactId) {
		return `\n[Parent ingress budget: this result was reduced (${scale}). Externalizing the full output failed, so re-run the command with a narrower scope to see the elided region.]`;
	}
	return [
		"",
		`[Parent ingress budget: this result was reduced (${scale}). Full output: artifact://${artifactId}]`,
		`[Read exact regions with a selector, e.g. \`artifact://${artifactId}:1-200\`.]`,
	].join("\n");
}

/**
 * Persist `text` and return its artifact id, or `undefined` when the session
 * cannot store it. A save failure must never convert a successful call into an
 * error, nor re-expose the full (context-blowing) output.
 */
async function externalize(
	text: string,
	toolName: string,
	context: AgentToolContext | undefined,
): Promise<string | undefined> {
	const sessionManager = context?.sessionManager;
	if (!sessionManager) return undefined;
	try {
		return await sessionManager.saveArtifact(text, toolName);
	} catch (error) {
		logger.warn("Parent ingress budget: failed to externalize oversized tool result", {
			tool: toolName,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Compact envelope for an oversized structured payload. Stays valid JSON: the
 * caller's schema-shaped body is replaced wholesale rather than sliced, and the
 * top-level keys of an object payload (or length of an array) are reported so
 * the model can decide what to extract.
 */
function structuredEnvelope(payload: unknown, artifactId: string | undefined, totalBytes: number): string {
	const envelope: Record<string, unknown> = {
		ompIngress: "structured-output-externalized",
		reason: "exceeded parent ingress budget",
		totalBytes,
	};
	if (Array.isArray(payload)) {
		envelope.shape = "array";
		envelope.length = payload.length;
	} else if (payload && typeof payload === "object") {
		envelope.shape = "object";
		envelope.keys = Object.keys(payload as Record<string, unknown>);
	} else {
		envelope.shape = typeof payload;
	}
	if (artifactId) {
		envelope.full = `artifact://${artifactId}`;
		envelope.recover = `Read artifact://${artifactId} (supports :start-end and ?q= selectors) for the exact payload.`;
	} else {
		envelope.recover = "Externalizing the payload failed; re-request it with a narrower scope.";
	}
	return JSON.stringify(envelope, null, 2);
}

/** Build the truncation meta describing a parent-ingress reduction. */
function ingressTruncationMeta(
	existing: TruncationMeta | undefined,
	totalLines: number,
	totalBytes: number,
	body: string,
	budget: number,
	artifactId: string | undefined,
): TruncationMeta {
	const outputLines = countLines(body);
	return {
		direction: "middle",
		truncatedBy: "middle",
		totalLines,
		totalBytes,
		outputLines,
		outputBytes: Buffer.byteLength(body, "utf-8"),
		maxBytes: budget,
		elidedLines: Math.max(0, totalLines - outputLines),
		elidedBytes: Math.max(0, totalBytes - Buffer.byteLength(body, "utf-8")),
		artifactId: artifactId ?? existing?.artifactId,
		nextOffset: existing?.nextOffset,
	};
}

/**
 * Where a reduced result can be recovered from, for the dedupe notice and for
 * callers that want to describe the reduction without re-deriving it.
 */
function recoveryHintFor(source: SourceMeta | undefined, artifactId: string | undefined): string {
	if (source && (source.type === "path" || source.type === "internal")) {
		return `\`${source.value}\` with a line selector`;
	}
	if (artifactId) return `artifact://${artifactId}`;
	return "a narrower re-run of the same call";
}

/**
 * Reduce a tool result to the parent ingress budget.
 *
 * Returns the result unchanged when the session is a subagent, the budget is
 * disabled, or the payload already fits. Shaping picks the strategy the
 * payload's semantics demand — structured envelope, error diagnostics, file or
 * pointer selectors, or artifact externalization.
 */
export async function applyParentIngressBudget(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
): Promise<AgentToolResult> {
	if (context?.agentKind !== "main") return result;
	const budget = resolveParentIngressBudgetBytes(context?.settings);
	if (budget <= 0) return result;

	const fullText = collectText(result.content);
	if (fullText === undefined) return result;
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= budget) return result;

	const existingMeta: OutputMeta | undefined = result.details?.meta;
	const source = existingMeta?.source;
	const totalLines = countLines(fullText);

	// `artifact://` reads are already a page of durable evidence. Re-reducing
	// them would bound a deliberate, explicitly-selected recovery read — the one
	// call the model makes precisely to see exact bytes.
	if (toolName === "read" && source?.type === "internal" && source.value.startsWith("artifact://")) {
		return result;
	}

	let body: string;
	let shapedAs: NonNullable<OutputMeta["ingress"]>["shapedAs"];
	let artifactId: string | undefined = existingMeta?.truncation?.artifactId;

	const structured = parseJsonPayload(fullText);
	if (structured !== undefined) {
		// Structured payloads must stay parseable. Externalize and emit a valid
		// compact envelope rather than slicing bytes out of a JSON document.
		artifactId ??= await externalize(fullText, toolName, context);
		body = structuredEnvelope(structured, artifactId, totalBytes);
		shapedAs = "structured";
	} else if (result.isError === true) {
		// Failures keep both ends: the invocation context at the head and the
		// exception, exit status, and stack at the tail.
		const bounded = boundBody(fullText, budget, "middle", ERROR_HEAD_FRACTION);
		artifactId ??= await externalize(fullText, toolName, context);
		body = bounded + artifactRecoveryNotice(artifactId, totalLines, totalBytes);
		shapedAs = "artifact";
	} else if (source?.type === "path") {
		// The file is its own durable evidence. Copying it into an artifact would
		// duplicate the repository into session storage for no recovery benefit.
		// Head-only so the recovery selector names the true next unread line.
		const bounded = boundBody(fullText, budget, "head");
		body = bounded + selectorRecoveryNotice("file", source.value, totalLines, bounded, existingMeta?.truncation);
		shapedAs = "file";
	} else if (source?.type === "internal") {
		// `agent://`, `memory://`, `skill://` … are already durable pointers that
		// accept the same line selectors as a file.
		const bounded = boundBody(fullText, budget, "head");
		body = bounded + selectorRecoveryNotice("pointer", source.value, totalLines, bounded, existingMeta?.truncation);
		shapedAs = "pointer";
	} else {
		// Generated output (bash, grep aggregations, MCP, extension tools): the
		// bytes exist nowhere else, so they must be externalized before reduction.
		const bounded = boundBody(fullText, budget, "middle");
		artifactId ??= await externalize(fullText, toolName, context);
		body = bounded + artifactRecoveryNotice(artifactId, totalLines, totalBytes);
		shapedAs = "artifact";
	}

	const truncation = ingressTruncationMeta(existingMeta?.truncation, totalLines, totalBytes, body, budget, artifactId);
	const meta: OutputMeta = { ...(existingMeta ?? {}), truncation, ingress: { shapedAs } };
	return {
		...result,
		content: withShapedText(result.content, body),
		details: { ...(result.details ?? {}), meta },
	};
}

/**
 * Suppress a large payload the active parent context already holds verbatim.
 *
 * "Already holds" is decided against the live branch, not a side ledger, and a
 * prior `toolResult` counts only when it is genuinely still being sent to the
 * model. Two independent mechanisms remove content, and both must be honoured:
 *
 * - **Pruning / shake** blanks a result in place and stamps `prunedAt`.
 * - **Compaction** leaves the entry untouched but moves the context window
 *   forward, so everything before {@link CompactionEntry.firstKeptEntryId} is
 *   summarized away and never sent again — with no `prunedAt` to show for it.
 *
 * Missing the second one would tell the model to "scroll back" to evidence that
 * no longer exists in its context while discarding the fresh copy, so the scan
 * starts at the latest compaction boundary rather than at the root.
 *
 * Identity is full-text equality of the model-facing text, so any source change
 * — a different revision, a different range, one edited line — produces a
 * different payload and is never falsely deduplicated.
 *
 * Runs before {@link applyParentIngressBudget} and only for payloads that would
 * otherwise be shaped: a small result is cheaper to repeat than to explain.
 */
export function suppressDuplicateIngress(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
): AgentToolResult {
	if (context?.agentKind !== "main") return result;
	const sessionManager = context?.sessionManager;
	if (!sessionManager) return result;
	const budget = resolveParentIngressBudgetBytes(context?.settings);
	if (budget <= 0) return result;

	const fullText = collectText(result.content);
	if (fullText === undefined) return result;
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= budget) return result;

	const branch = sessionManager.getBranch();
	// Everything at or before the boundary was replaced by a summary.
	const compaction = getLatestCompactionEntry(branch);
	const firstKeptIndex = compaction ? branch.findIndex(entry => entry.id === compaction.firstKeptEntryId) : 0;
	const inContext = firstKeptIndex > 0 ? branch.slice(firstKeptIndex) : branch;

	let priorToolCallId: string | undefined;
	for (const entry of inContext) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (message.toolName !== toolName) continue;
		if (message.prunedAt !== undefined) continue;
		// Length first: comparing megabytes of text across a long branch is the
		// cost this prefilter exists to avoid.
		const priorText = collectText(message.content);
		if (priorText === undefined || priorText.length !== fullText.length) continue;
		if (priorText !== fullText) continue;
		priorToolCallId = message.toolCallId;
		break;
	}
	if (priorToolCallId === undefined) return result;

	const existingMeta: OutputMeta | undefined = result.details?.meta;
	const notice = duplicateIngressNotice(
		toolName,
		priorToolCallId,
		existingMeta?.source,
		existingMeta?.truncation?.artifactId,
		countLines(fullText),
		totalBytes,
	);
	const meta: OutputMeta = { ...(existingMeta ?? {}), ingress: { shapedAs: "duplicate" } };
	return {
		...result,
		content: withShapedText(result.content, notice),
		details: { ...(result.details ?? {}), meta },
	};
}

/**
 * Compact stand-in for a payload the active parent context already holds.
 * Kept beside the shaping strategies so the notice cites the same recovery
 * routes they mint.
 */
function duplicateIngressNotice(
	toolName: string,
	priorToolCallId: string,
	source: SourceMeta | undefined,
	artifactId: string | undefined,
	totalLines: number,
	totalBytes: number,
): string {
	return [
		`[Parent ingress budget: identical \`${toolName}\` output is already in this conversation (tool call ${priorToolCallId}); it is not repeated here.]`,
		`[Unchanged content: ${totalLines.toLocaleString()} lines, ${totalBytes.toLocaleString()} bytes. Scroll back for the body, or re-read ${recoveryHintFor(source, artifactId)} to page a specific region.]`,
	].join("\n");
}
