#!/usr/bin/env bun
/**
 * Deterministic orchestration benchmark / metrics harness.
 *
 * Answers one question mechanically: for a given OMP session, how much context
 * did the *parent* pay for, how much of that arrived as delegated results, and
 * how much of it was the parent re-walking ground a subagent already covered.
 *
 * The parent model never reconstructs these numbers from logs. Everything is
 * extracted from the durable session JSONL that OMP already writes:
 *
 *   <sessionsRoot>/<cwd-slug>/<ts>_<sessionId>.jsonl         parent transcript
 *   <sessionsRoot>/<cwd-slug>/<ts>_<sessionId>/<Agent>.jsonl  child transcripts
 *
 * Subcommands:
 *   extract <sessionFile|sessionId>   emit OrchestrationMetrics JSON
 *   run --prompt-file <file> [...]    launch a fresh session, then extract
 *   compare <baseline.json> <candidate.json>
 *
 * `extractMetrics` is pure over in-memory transcript text so it can be unit
 * tested without touching disk or a provider.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import * as git from "../packages/coding-agent/src/utils/git";

/** Schema version of the emitted metrics record. Bump on any field change. */
export const METRICS_SCHEMA_VERSION = 1;

/** Tools whose results are bulk discovery payloads the parent could have delegated. */
export const DISCOVERY_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, ast_grep: true };

/** Tools whose results are delegated work products rather than raw discovery. */
export const DELEGATION_TOOLS: Record<string, true> = { task: true, hub: true };

/** `custom_message` entry types that inject delegated payload into parent context. */
export const DELEGATION_MESSAGE_TYPES: Record<string, true> = { "async-result": true, "irc:incoming": true };

/**
 * Inter-entry gap above which the transcript is treated as human idle time
 * rather than run time. Transcript span alone is useless for interactive
 * sessions — a two-hour session holding four minutes of work looks like two
 * hours. Harness-launched runs also report exact subprocess wall time.
 */
export const DEFAULT_IDLE_GAP_MS = 120_000;

/** Trailing `read` selectors that address a slice of a file, not a different file. */
const READ_SELECTOR = /^(?:raw|conflicts|[\d,\-+\s]+|raw:[\d,\-+\s]+|[\d,\-+\s]+:raw)$/;

/** Separator inside composite reread keys. Never occurs in a path or pattern. */
const KEY_SEP = "\u0000";

// ---------------------------------------------------------------------------
// Emitted record
// ---------------------------------------------------------------------------

export interface ChildMetrics {
	/** Agent name, taken from the child transcript basename. */
	agent: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	toolResultChars: number;
	modelDurationMs: number;
}

export interface RereadEntry {
	target: string;
	count: number;
	chars: number;
}

export interface OrchestrationMetrics {
	schema: number;
	session: {
		id: string | null;
		file: string;
		cwd: string | null;
		startedAt: string | null;
		lastEntryAt: string | null;
		model: string | null;
		provider: string | null;
	};
	parent: {
		/** Assistant messages, i.e. billed model requests. */
		turns: number;
		userPrompts: number;
		/** High-water mark of `contextSnapshot.promptTokens`. */
		peakContextTokens: number;
		finalContextTokens: number;
		/** All prompt-side tokens: fresh input + cache reads + cache writes. */
		inputTokens: number;
		/** Fresh (non-cached) input tokens only. */
		inputUncachedTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		outputTokens: number;
		reasoningTokens: number;
		totalTokens: number;
		/** Every tool result byte the parent paid to keep in context. */
		toolResultChars: number;
		compactions: number;
		/** Highest `tokensBefore` recorded by a compaction, 0 when none ran. */
		peakCompactionTokens: number;
	};
	delegation: {
		/**
		 * Delegated bytes *injected into parent context*, counting every delivery.
		 *
		 * This is a cost measure, not a unique-information measure. `hub jobs` and
		 * `hub wait` reprint a settled job's result on every call, so one job's
		 * payload can legitimately appear several times — and the parent paid for
		 * each copy, so each copy is counted. Read `channels` alongside it: a large
		 * `hub` figure spread over many calls is repeated polling, not one big
		 * delegated answer.
		 */
		delegatedResultChars: number;
		delegatedCalls: number;
		channels: Record<string, { calls: number; chars: number }>;
		children: ChildMetrics[];
		childTurns: number;
		childInputTokens: number;
		childOutputTokens: number;
	};
	rereads: {
		/** Parent discovery calls repeating a target the parent already fetched. */
		selfDuplicateCalls: number;
		selfDuplicateChars: number;
		/**
		 * Parent discovery calls that re-fetched a target a child had already
		 * fetched, counted only once the parent had actually received a delegated
		 * result. Concurrent parallel discovery is excluded: the parent cannot
		 * retrace work it had not yet been told about.
		 */
		afterDelegationCalls: number;
		afterDelegationChars: number;
		topTargets: RereadEntry[];
	};
	timing: {
		/** Sum of parent `assistant.duration`. */
		modelDurationMs: number;
		childModelDurationMs: number;
		/** Last minus first entry timestamp. Includes human idle time. */
		transcriptSpanMs: number;
		/** Transcript span with gaps above `idleGapMs` removed. */
		activeSpanMs: number;
		idleGapMs: number;
	};
	toolsByName: Record<string, { calls: number; resultChars: number }>;
	largestToolResult: { toolName: string; chars: number; target: string | null } | null;
	/** Lines the parser could not decode. Non-zero means the transcript is damaged. */
	malformedLines: number;
}

export interface TranscriptInput {
	/** Absolute path, recorded for provenance and for naming child agents. */
	file: string;
	text: string;
}

export interface ExtractInput {
	parent: TranscriptInput;
	children?: readonly TranscriptInput[];
	idleGapMs?: number;
}

// ---------------------------------------------------------------------------
// Transcript decoding
// ---------------------------------------------------------------------------

/**
 * Shapes below describe only the fields this harness reads. Numeric fields stay
 * `unknown` because the transcript is persisted external data whose provider
 * payloads vary; `finiteNumber` proves each one at the point of use.
 */
interface RawUsage {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	reasoningTokens?: unknown;
	totalTokens?: unknown;
}

interface RawToolCall {
	type?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface RawMessage {
	role?: string;
	model?: unknown;
	provider?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	content?: unknown;
	usage?: RawUsage;
	contextSnapshot?: { promptTokens?: unknown };
	duration?: unknown;
	customType?: unknown;
}

interface RawEntry {
	type?: string;
	id?: unknown;
	timestamp?: unknown;
	cwd?: unknown;
	model?: unknown;
	message?: RawMessage;
	customType?: unknown;
	content?: unknown;
	tokensBefore?: unknown;
}

export interface DecodedTranscript {
	entries: RawEntry[];
	malformedLines: number;
}

/**
 * Decode a session JSONL body. Undecodable lines are counted rather than
 * thrown: a session truncated mid-write by a killed run is still worth
 * measuring, and silently dropping the damage would hide it.
 */
export function decodeTranscript(text: string): DecodedTranscript {
	const entries: RawEntry[] = [];
	let malformedLines = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			malformedLines++;
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			malformedLines++;
			continue;
		}
		// Checked above: a non-null, non-array object. Field reads below are all
		// re-narrowed, so the envelope assertion cannot launder a bad value.
		const entry: RawEntry = parsed;
		entries.push(entry);
	}
	return { entries, malformedLines };
}

/** Numeric field guard for persisted provider payloads. Absent/garbage reads as 0. */
function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Characters of a message payload, whether a bare string or a content-part array. */
function textChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (part === null || typeof part !== "object") continue;
		if (!("type" in part) || part.type !== "text") continue;
		if ("text" in part && typeof part.text === "string") total += part.text.length;
	}
	return total;
}

function toolCallsOf(message: RawMessage | undefined): RawToolCall[] {
	if (!Array.isArray(message?.content)) return [];
	const calls: RawToolCall[] = [];
	for (const part of message.content) {
		if (part === null || typeof part !== "object") continue;
		if (!("type" in part) || part.type !== "toolCall") continue;
		const name = "name" in part && typeof part.name === "string" ? part.name : undefined;
		const id = "id" in part && typeof part.id === "string" ? part.id : undefined;
		const args =
			"arguments" in part && part.arguments !== null && typeof part.arguments === "object"
				? part.arguments
				: undefined;
		calls.push({ type: "toolCall", id, name, arguments: args as Record<string, unknown> | undefined });
	}
	return calls;
}

function entryMillis(entry: RawEntry): number {
	if (typeof entry.timestamp !== "string") return Number.NaN;
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// ---------------------------------------------------------------------------
// Reread targets
// ---------------------------------------------------------------------------

/**
 * Strip a trailing `read` line selector so `foo.ts:1-40` and `foo.ts:900-940`
 * collapse to one target. Re-reading a second slice of a file a subagent
 * already summarised is exactly the retracing this metric exists to catch, so
 * the slice is deliberately not part of the target identity.
 *
 * Internal URLs (`agent://Name`) and non-selector suffixes (`db.sqlite:users`)
 * are left intact — those address genuinely different resources.
 */
export function stripReadSelector(target: string): string {
	const colon = target.lastIndexOf(":");
	if (colon <= 0) return target;
	if (target.startsWith("//", colon + 1)) return target;
	const suffix = target.slice(colon + 1);
	if (suffix.length === 0 || !READ_SELECTOR.test(suffix)) return target;
	return target.slice(0, colon);
}

/**
 * Canonical identity of a discovery action, or `null` when the call is not a
 * discovery tool. Two calls sharing a key fetched the same material.
 */
export function discoveryTarget(
	toolName: string,
	args: Record<string, unknown> | undefined,
	cwd: string | null,
): string | null {
	if (DISCOVERY_TOOLS[toolName] !== true) return null;
	const rawPath = typeof args?.path === "string" ? args.path : "";
	let resolved = "";
	if (rawPath.length > 0) {
		const stripped = stripReadSelector(rawPath);
		if (stripped.includes("://") || !cwd) resolved = stripped;
		else resolved = path.isAbsolute(stripped) ? path.normalize(stripped) : path.normalize(path.join(cwd, stripped));
	}
	if (toolName === "read") return resolved.length === 0 ? null : `read${KEY_SEP}${resolved}`;
	if (toolName === "glob") return `glob${KEY_SEP}${resolved}`;
	if (toolName === "grep") {
		const pattern = typeof args?.pattern === "string" ? args.pattern : "";
		return `grep${KEY_SEP}${pattern}${KEY_SEP}${resolved}`;
	}
	const pattern = typeof args?.pat === "string" ? args.pat : "";
	return `ast_grep${KEY_SEP}${pattern}${KEY_SEP}${resolved}`;
}

/** Render a NUL-joined reread key as readable text for the report. */
function formatTarget(target: string): string {
	return target.split(KEY_SEP).filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface DiscoveryCall {
	target: string;
	at: number;
}

/**
 * Earliest time each discovery target was fetched in a transcript.
 *
 * Only finite timestamps are recorded. Storing `NaN` would permanently pin a
 * target — no later value can compare less than `NaN` — and every subsequent
 * parent read of it would be blamed on the child regardless of true order.
 */
function collectDiscoveryFirstSeen(entries: readonly RawEntry[], cwd: string | null): Map<string, number> {
	const seen = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const at = entryMillis(entry);
		if (!Number.isFinite(at)) continue;
		for (const call of toolCallsOf(entry.message)) {
			const target = discoveryTarget(call.name ?? "", call.arguments, cwd);
			if (!target) continue;
			const prior = seen.get(target);
			if (prior === undefined || at < prior) seen.set(target, at);
		}
	}
	return seen;
}

function summariseChild(input: TranscriptInput): { metrics: ChildMetrics; entries: RawEntry[] } {
	const { entries } = decodeTranscript(input.text);
	const metrics: ChildMetrics = {
		agent: path.basename(input.file, ".jsonl"),
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		toolResultChars: 0,
		modelDurationMs: 0,
	};
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "assistant") {
			metrics.turns++;
			metrics.inputTokens +=
				finiteNumber(message.usage?.input) +
				finiteNumber(message.usage?.cacheRead) +
				finiteNumber(message.usage?.cacheWrite);
			metrics.outputTokens += finiteNumber(message.usage?.output);
			metrics.modelDurationMs += finiteNumber(message.duration);
		} else if (message?.role === "toolResult") {
			metrics.toolResultChars += textChars(message.content);
		}
	}
	return { metrics, entries };
}

/** Extract the full metrics record from already-loaded transcript text. */
export function extractMetrics(input: ExtractInput): OrchestrationMetrics {
	const idleGapMs = input.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
	const { entries, malformedLines } = decodeTranscript(input.parent.text);

	const header = entries.find(entry => entry.type === "session");
	const cwd = typeof header?.cwd === "string" ? header.cwd : null;

	// Children first: the reread metric needs to know what they already covered.
	const children: ChildMetrics[] = [];
	const childFirstSeen = new Map<string, number>();
	for (const child of input.children ?? []) {
		const { metrics, entries: childEntries } = summariseChild(child);
		children.push(metrics);
		for (const [target, at] of collectDiscoveryFirstSeen(childEntries, cwd)) {
			const prior = childFirstSeen.get(target);
			if (prior === undefined || (Number.isFinite(at) && at < prior)) childFirstSeen.set(target, at);
		}
	}
	children.sort((a, b) => a.agent.localeCompare(b.agent));

	const parent = {
		turns: 0,
		userPrompts: 0,
		peakContextTokens: 0,
		finalContextTokens: 0,
		inputTokens: 0,
		inputUncachedTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		toolResultChars: 0,
		compactions: 0,
		peakCompactionTokens: 0,
	};
	const channels: Record<string, { calls: number; chars: number }> = {};
	const toolsByName: Record<string, { calls: number; resultChars: number }> = {};
	let model: string | null = null;
	let provider: string | null = null;
	let modelDurationMs = 0;
	let delegatedResultChars = 0;
	let delegatedCalls = 0;
	let largestToolResult: OrchestrationMetrics["largestToolResult"] = null;

	/** Tool call id -> emitting tool and its discovery target, for result attribution. */
	const callIndex = new Map<string, { name: string; target: string | null }>();
	const resultCharsByCallId = new Map<string, number>();
	const discoveryCalls: DiscoveryCall[] = [];

	let firstMillis = Number.NaN;
	let lastMillis = Number.NaN;
	let previousMillis = Number.NaN;
	let activeSpanMs = 0;
	let lastEntryAt: string | null = null;

	/**
	 * Earliest delegated delivery the parent actually received. A parent can only
	 * be accused of retracing material it already had, so this gates the
	 * after-delegation reread metric.
	 */
	let firstDeliveryMillis = Number.NaN;

	const bumpChannel = (name: string, chars: number, deliveredAt: number): void => {
		channels[name] ??= { calls: 0, chars: 0 };
		channels[name].calls++;
		channels[name].chars += chars;
		delegatedResultChars += chars;
		delegatedCalls++;
		if (Number.isFinite(deliveredAt) && !Number.isFinite(firstDeliveryMillis)) firstDeliveryMillis = deliveredAt;
	};

	for (const entry of entries) {
		const at = entryMillis(entry);
		if (Number.isFinite(at)) {
			if (!Number.isFinite(firstMillis)) firstMillis = at;
			lastMillis = at;
			if (typeof entry.timestamp === "string") lastEntryAt = entry.timestamp;
			if (Number.isFinite(previousMillis)) {
				const gap = at - previousMillis;
				if (gap > 0 && gap <= idleGapMs) activeSpanMs += gap;
			}
			previousMillis = at;
		}

		if (entry.type === "model_change" && typeof entry.model === "string") model ??= entry.model;

		if (entry.type === "compaction") {
			parent.compactions++;
			parent.peakCompactionTokens = Math.max(parent.peakCompactionTokens, finiteNumber(entry.tokensBefore));
			continue;
		}

		if (entry.type === "custom_message") {
			const kind = typeof entry.customType === "string" ? entry.customType : undefined;
			if (kind && DELEGATION_MESSAGE_TYPES[kind] === true) bumpChannel(kind, textChars(entry.content), at);
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message) continue;

		if (message.role === "user") {
			parent.userPrompts++;
			continue;
		}

		if (message.role === "assistant") {
			parent.turns++;
			if (typeof message.model === "string") model ??= message.model;
			if (typeof message.provider === "string") provider ??= message.provider;
			const usage = message.usage;
			parent.inputUncachedTokens += finiteNumber(usage?.input);
			parent.cacheReadTokens += finiteNumber(usage?.cacheRead);
			parent.cacheWriteTokens += finiteNumber(usage?.cacheWrite);
			parent.outputTokens += finiteNumber(usage?.output);
			parent.reasoningTokens += finiteNumber(usage?.reasoningTokens);
			parent.totalTokens += finiteNumber(usage?.totalTokens);
			modelDurationMs += finiteNumber(message.duration);
			const promptTokens = finiteNumber(message.contextSnapshot?.promptTokens);
			if (promptTokens > 0) {
				parent.peakContextTokens = Math.max(parent.peakContextTokens, promptTokens);
				parent.finalContextTokens = promptTokens;
			}
			for (const call of toolCallsOf(message)) {
				const name = call.name ?? "";
				const target = discoveryTarget(name, call.arguments, cwd);
				if (call.id) callIndex.set(call.id, { name, target });
				toolsByName[name] ??= { calls: 0, resultChars: 0 };
				toolsByName[name].calls++;
				if (target) discoveryCalls.push({ target, at });
			}
			continue;
		}

		if (message.role === "toolResult") {
			const chars = textChars(message.content);
			const callId = typeof message.toolCallId === "string" ? message.toolCallId : null;
			const indexed = callId ? callIndex.get(callId) : undefined;
			const name = typeof message.toolName === "string" ? message.toolName : (indexed?.name ?? "");
			parent.toolResultChars += chars;
			toolsByName[name] ??= { calls: 0, resultChars: 0 };
			toolsByName[name].resultChars += chars;
			if (callId) resultCharsByCallId.set(callId, chars);
			if (DELEGATION_TOOLS[name] === true) bumpChannel(name, chars, at);
			if (!largestToolResult || chars > largestToolResult.chars) {
				largestToolResult = {
					toolName: name,
					chars,
					target: indexed?.target ? formatTarget(indexed.target) : null,
				};
			}
		}
	}

	parent.inputTokens = parent.inputUncachedTokens + parent.cacheReadTokens + parent.cacheWriteTokens;

	const charsByTarget = new Map<string, number>();
	for (const [callId, call] of callIndex) {
		if (!call.target) continue;
		charsByTarget.set(call.target, (charsByTarget.get(call.target) ?? 0) + (resultCharsByCallId.get(callId) ?? 0));
	}

	return {
		schema: METRICS_SCHEMA_VERSION,
		session: {
			id: typeof header?.id === "string" ? header.id : null,
			file: input.parent.file,
			cwd,
			startedAt: typeof header?.timestamp === "string" ? header.timestamp : null,
			lastEntryAt,
			model,
			provider,
		},
		parent,
		delegation: {
			delegatedResultChars,
			delegatedCalls,
			channels,
			children,
			childTurns: children.reduce((sum, child) => sum + child.turns, 0),
			childInputTokens: children.reduce((sum, child) => sum + child.inputTokens, 0),
			childOutputTokens: children.reduce((sum, child) => sum + child.outputTokens, 0),
		},
		rereads: computeRereads(discoveryCalls, childFirstSeen, charsByTarget, firstDeliveryMillis),
		timing: {
			modelDurationMs,
			childModelDurationMs: children.reduce((sum, child) => sum + child.modelDurationMs, 0),
			transcriptSpanMs: Number.isFinite(firstMillis) && Number.isFinite(lastMillis) ? lastMillis - firstMillis : 0,
			activeSpanMs,
			idleGapMs,
		},
		toolsByName,
		largestToolResult,
		malformedLines,
	};
}

function computeRereads(
	calls: readonly DiscoveryCall[],
	childFirstSeen: ReadonlyMap<string, number>,
	charsByTarget: ReadonlyMap<string, number>,
	firstDeliveryMillis: number,
): OrchestrationMetrics["rereads"] {
	const totalCallsByTarget = new Map<string, number>();
	for (const call of calls) totalCallsByTarget.set(call.target, (totalCallsByTarget.get(call.target) ?? 0) + 1);

	const counts = new Map<string, number>();
	let selfDuplicateCalls = 0;
	let selfDuplicateChars = 0;
	let afterDelegationCalls = 0;
	let afterDelegationChars = 0;

	for (const call of calls) {
		// A target's bytes split evenly across its calls: charging the whole
		// payload to every repeat would also condemn the first, legitimate fetch.
		const totalCalls = totalCallsByTarget.get(call.target) ?? 1;
		const share = Math.round((charsByTarget.get(call.target) ?? 0) / totalCalls);
		const priorCount = counts.get(call.target) ?? 0;
		counts.set(call.target, priorCount + 1);
		if (priorCount > 0) {
			selfDuplicateCalls++;
			selfDuplicateChars += share;
		}
		// Retracing requires three things to be true and provable: the parent had
		// already received *some* delegated result, a child had already fetched
		// this exact target, and both instants are known. Concurrent dispatch —
		// where a child fetches something at the same moment the parent does, with
		// nothing delivered yet — is not retracing: the parent could not have
		// known. Unknown ordering is never charged to the parent.
		const childAt = childFirstSeen.get(call.target);
		const hadDelivery = Number.isFinite(firstDeliveryMillis) && firstDeliveryMillis < call.at;
		if (hadDelivery && childAt !== undefined && Number.isFinite(call.at) && childAt < call.at) {
			afterDelegationCalls++;
			afterDelegationChars += share;
		}
	}

	const topTargets = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([target, count]) => ({ target: formatTarget(target), count, chars: charsByTarget.get(target) ?? 0 }))
		.sort((a, b) => b.count - a.count || b.chars - a.chars || a.target.localeCompare(b.target))
		.slice(0, 10);

	return { selfDuplicateCalls, selfDuplicateChars, afterDelegationCalls, afterDelegationChars, topTargets };
}

// ---------------------------------------------------------------------------
// Disk loading
// ---------------------------------------------------------------------------

/** Load a parent transcript plus every child transcript in its artifacts dir. */
export async function loadSessionBundle(sessionFile: string): Promise<ExtractInput> {
	const absolute = path.resolve(sessionFile);
	const text = await Bun.file(absolute).text();
	const artifactsDir = absolute.replace(/\.jsonl$/, "");
	const children: TranscriptInput[] = [];
	let names: string[] = [];
	try {
		names = await fs.readdir(artifactsDir);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	for (const name of names.sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const childPath = path.join(artifactsDir, name);
		children.push({ file: childPath, text: await Bun.file(childPath).text() });
	}
	return { parent: { file: absolute, text }, children };
}

/** Resolve a session id to its transcript path by scanning the sessions root. */
export async function findSessionFile(sessionId: string, sessionsRoot: string = getSessionsDir()): Promise<string> {
	const suffix = `_${sessionId}.jsonl`;
	for (const folder of await fs.readdir(sessionsRoot, { withFileTypes: true })) {
		if (!folder.isDirectory()) continue;
		const dir = path.join(sessionsRoot, folder.name);
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		const hit = names.find(name => name.endsWith(suffix));
		if (hit) return path.join(dir, hit);
	}
	throw new Error(`no session transcript found for id ${sessionId} under ${sessionsRoot}`);
}

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

/**
 * Everything that must be identical between two runs for their metrics to be
 * comparable. A model comparison is only valid when two run records differ in
 * `model` alone — {@link controlDrift} enforces exactly that.
 */
export interface BenchControl {
	label: string;
	model: string | null;
	cwd: string;
	promptFile: string;
	promptSha256: string;
	promptChars: number;
	gitHead: string | null;
	/** Fingerprint of `git status --porcelain=v1`, proving the tree did not move. */
	worktreeSha256: string | null;
	harnessSha256: string;
	startedAt: string;
}

export interface BenchRun {
	schema: number;
	control: BenchControl;
	process: {
		exitCode: number | null;
		/** Measured by the harness around the subprocess: no idle contamination. */
		wallClockMs: number;
		stderrTail: string;
	};
	metrics: OrchestrationMetrics | null;
	error: string | null;
}

export interface RunOptions {
	promptFile: string;
	cwd: string;
	model?: string;
	label?: string;
	sessionsRoot?: string;
	timeoutMs?: number;
}

const CLI_ENTRY = path.join(import.meta.dir, "..", "packages", "coding-agent", "src", "cli.ts");

/**
 * Launch a fresh OMP session that runs one prompt and exits, then extract its
 * metrics. The session id comes from the `--mode json` header line, so the
 * harness never has to guess which transcript belongs to this run.
 */
export async function runBenchmark(options: RunOptions): Promise<BenchRun> {
	const promptFile = path.resolve(options.promptFile);
	const prompt = await Bun.file(promptFile).text();
	const cwd = path.resolve(options.cwd);
	let gitHead: string | null = null;
	let worktreeSha256: string | null = null;
	try {
		gitHead = await git.head.sha(cwd);
		worktreeSha256 = Bun.SHA256.hash(await git.status(cwd, { porcelainV1: true }), "hex");
	} catch {
		// Not a git worktree, or git unavailable: control block records nulls.
	}
	const control: BenchControl = {
		label: options.label ?? path.basename(promptFile, ".md"),
		model: options.model ?? null,
		cwd,
		promptFile,
		promptSha256: Bun.SHA256.hash(prompt, "hex"),
		promptChars: prompt.length,
		gitHead,
		worktreeSha256,
		harnessSha256: Bun.SHA256.hash(await Bun.file(import.meta.path).arrayBuffer(), "hex"),
		startedAt: new Date().toISOString(),
	};

	const args = [CLI_ENTRY, "--cwd", cwd, "--mode", "json"];
	if (options.model) args.push("--model", options.model);
	args.push(prompt);

	const started = Bun.nanoseconds();
	const child = Bun.spawn(["bun", ...args], {
		cwd,
		env: { ...process.env, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30 * 60 * 1000);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout as ReadableStream<Uint8Array>).text(),
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
		child.exited,
	]);
	clearTimeout(timer);

	const run: BenchRun = {
		schema: METRICS_SCHEMA_VERSION,
		control,
		process: {
			exitCode,
			wallClockMs: Math.round((Bun.nanoseconds() - started) / 1e6),
			stderrTail: stderr.trim().slice(-2000),
		},
		metrics: null,
		error: null,
	};

	const sessionId = extractSessionId(stdout);
	if (!sessionId) {
		run.error = "session header missing from stdout; cannot attribute metrics to a transcript";
		return run;
	}
	try {
		const file = await findSessionFile(sessionId, options.sessionsRoot);
		run.metrics = extractMetrics(await loadSessionBundle(file));
	} catch (err) {
		run.error = err instanceof Error ? err.message : String(err);
	}
	return run;
}

/** Read the session id from the `{"type":"session"}` header line of stdout. */
export function extractSessionId(stdout: string): string | null {
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		if (!("type" in parsed) || parsed.type !== "session") continue;
		if ("id" in parsed && typeof parsed.id === "string") return parsed.id;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface ComparisonRow {
	metric: string;
	baseline: number;
	candidate: number;
	deltaPercent: number | null;
}

/** Metrics that decide the parent-context efficiency and performance gates. */
export const COMPARED_METRICS: ReadonlyArray<{ metric: string; pick: (run: BenchRun) => number }> = [
	{ metric: "parent.peakContextTokens", pick: run => run.metrics?.parent.peakContextTokens ?? 0 },
	{ metric: "parent.inputTokens", pick: run => run.metrics?.parent.inputTokens ?? 0 },
	{ metric: "parent.outputTokens", pick: run => run.metrics?.parent.outputTokens ?? 0 },
	{ metric: "parent.toolResultChars", pick: run => run.metrics?.parent.toolResultChars ?? 0 },
	{ metric: "parent.turns", pick: run => run.metrics?.parent.turns ?? 0 },
	{ metric: "delegation.delegatedResultChars", pick: run => run.metrics?.delegation.delegatedResultChars ?? 0 },
	{ metric: "rereads.selfDuplicateCalls", pick: run => run.metrics?.rereads.selfDuplicateCalls ?? 0 },
	{ metric: "rereads.afterDelegationCalls", pick: run => run.metrics?.rereads.afterDelegationCalls ?? 0 },
	{ metric: "timing.modelDurationMs", pick: run => run.metrics?.timing.modelDurationMs ?? 0 },
	{ metric: "process.wallClockMs", pick: run => run.process.wallClockMs },
];

export function compareRuns(baseline: BenchRun, candidate: BenchRun): ComparisonRow[] {
	return COMPARED_METRICS.map(({ metric, pick }) => {
		const before = pick(baseline);
		const after = pick(candidate);
		return {
			metric,
			baseline: before,
			candidate: after,
			deltaPercent: before === 0 ? null : ((after - before) / before) * 100,
		};
	});
}

/** Control keys that must match for a comparison to isolate the model variable. */
export function controlDrift(baseline: BenchControl, candidate: BenchControl): string[] {
	const drift: string[] = [];
	if (baseline.promptSha256 !== candidate.promptSha256) drift.push("promptSha256");
	if (baseline.cwd !== candidate.cwd) drift.push("cwd");
	if (baseline.gitHead !== candidate.gitHead) drift.push("gitHead");
	if (baseline.worktreeSha256 !== candidate.worktreeSha256) drift.push("worktreeSha256");
	if (baseline.harnessSha256 !== candidate.harnessSha256) drift.push("harnessSha256");
	return drift;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `orchestration-bench — deterministic parent-context metrics

  extract <sessionFile|sessionId> [--idle-gap <ms>] [--out <file>]
  run --prompt-file <file> [--cwd <dir>] [--model <selector>]
      [--label <name>] [--repeat <n>] [--out <file>]
  compare <baseline.json> <candidate.json> [--out <file>]
`;

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Repeat count, or `null` when the value is not a positive integer. A typo used
 * to become `NaN`, which ran zero benchmarks and still exited 0 — a scripted
 * caller would record that as a successful measurement of nothing.
 */
export function parseRepeat(value: string | undefined): number | null {
	if (value === undefined) return 1;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return null;
	return parsed;
}

async function emit(value: unknown, out: string | undefined): Promise<void> {
	const json = `${JSON.stringify(value, null, 2)}\n`;
	if (!out) {
		process.stdout.write(json);
		return;
	}
	await Bun.write(out, json);
	process.stdout.write(`wrote ${out}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "-h") {
		process.stdout.write(USAGE);
		return command ? 0 : 1;
	}

	if (command === "extract") {
		const target = rest.find(arg => !arg.startsWith("--"));
		if (!target) {
			process.stderr.write("extract requires a session file or session id\n");
			return 1;
		}
		const file = target.endsWith(".jsonl") ? path.resolve(target) : await findSessionFile(target);
		const idleGap = flag(rest, "idle-gap");
		const bundle = await loadSessionBundle(file);
		await emit(extractMetrics({ ...bundle, idleGapMs: idleGap ? Number(idleGap) : undefined }), flag(rest, "out"));
		return 0;
	}

	if (command === "run") {
		const promptFile = flag(rest, "prompt-file");
		if (!promptFile) {
			process.stderr.write("run requires --prompt-file\n");
			return 1;
		}
		const repeat = parseRepeat(flag(rest, "repeat"));
		if (repeat === null) {
			process.stderr.write("--repeat must be a positive integer\n");
			return 1;
		}
		const runs: BenchRun[] = [];
		for (let index = 0; index < repeat; index++) {
			process.stderr.write(`run ${index + 1}/${repeat}...\n`);
			runs.push(
				await runBenchmark({
					promptFile,
					cwd: flag(rest, "cwd") ?? process.cwd(),
					model: flag(rest, "model"),
					label: flag(rest, "label"),
				}),
			);
		}
		await emit(repeat === 1 ? runs[0] : runs, flag(rest, "out"));
		return runs.every(run => run.error === null && run.process.exitCode === 0) ? 0 : 1;
	}

	if (command === "compare") {
		const [baselineFile, candidateFile] = rest.filter(arg => !arg.startsWith("--"));
		if (!baselineFile || !candidateFile) {
			process.stderr.write("compare requires two run JSON files\n");
			return 1;
		}
		// Both files are this harness's own `run` output; shape is ours, not external.
		const baseline: BenchRun = await Bun.file(baselineFile).json();
		const candidate: BenchRun = await Bun.file(candidateFile).json();
		const drift = controlDrift(baseline.control, candidate.control);
		await emit(
			{
				baselineLabel: baseline.control.label,
				candidateLabel: candidate.control.label,
				baselineModel: baseline.control.model,
				candidateModel: candidate.control.model,
				controlDrift: drift,
				valid: drift.length === 0,
				rows: compareRuns(baseline, candidate),
			},
			flag(rest, "out"),
		);
		return drift.length === 0 ? 0 : 1;
	}

	process.stderr.write(`unknown command: ${command}\n${USAGE}`);
	return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
