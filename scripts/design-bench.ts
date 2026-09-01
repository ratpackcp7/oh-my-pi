#!/usr/bin/env bun
/**
 * Frontend-design benchmark: a thin wrapper around `orchestration-bench.ts`.
 *
 * One question, answered mechanically where mechanics are possible and honestly
 * where they are not: which model consistently produces the strongest frontend
 * design concepts from the same frozen requirements?
 *
 * Layering (v1):
 *   - session launch, telemetry, and control-drift primitives come from
 *     `orchestration-bench.ts` (`runBenchmark`, `BenchRun`, `controlDrift`);
 *   - this file adds only what design review needs: frozen benchmark
 *     definitions (fingerprinted), per-candidate isolated workspaces, blind
 *     candidate labels, visual-proof validation, a 100-point human rubric,
 *     and a comparison report that separates design score from efficiency.
 *
 * The subjective half of the score is always human. Nothing here pretends an
 * LLM judged a screenshot. What the wrapper *does* enforce mechanically:
 * identical prompt bytes, identical fixture bytes, isolated candidate
 * workspaces, blind labels, and honest run status (a run that exits 0 without
 * producing the required proofs is invalid, not a success).
 *
 * Subcommands:
 *   init <definition.json> --models a,b --repeat 2 --out <runRoot> [...]
 *   run <runRoot> [--only candidate-003]
 *   validate <runRoot>            re-verify proofs/statuses from disk
 *   candidates <runRoot> [--json] blind review index (no model identity)
 *   score <runRoot> <label> --file <score.json>
 *   report <runRoot> [--reveal]   blind report; --reveal adds model mapping
 *   reveal <runRoot>              print the candidate-to-model mapping
 *
 * Run roots live wherever the caller points `--out`; everything inside is
 * deterministic. `map.json` holds the label→model mapping and is the only
 * file blind subcommands never read. Do not open it while grading.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type BenchRun, controlDrift, decodeTranscript, runBenchmark } from "./orchestration-bench";

/** Schema version of emitted benchmark records. Bump on any field change. */
export const DESIGN_BENCH_SCHEMA = 1;

/** Repo root, for resolving definition-relative paths. */
const REPO_ROOT = path.resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Frozen benchmark definition / rubric
// ---------------------------------------------------------------------------

export interface DesignDefinition {
	id: string;
	version: number;
	title: string;
	description?: string;
	/** Repo-root-relative or absolute path to the frozen prompt file. */
	promptFile: string;
	/** Repo-root-relative or absolute path to the frozen rubric file. */
	rubricFile: string;
	/** Repo-root-relative or absolute path to the frozen fixture directory. */
	fixtureDir: string;
	/** Proof files (workspace-relative) every candidate must produce. */
	requiredProofs: string[];
	/** Declared viewport/theme contract, reported verbatim in run records. */
	proofViewport: Record<string, string | number>;
	/**
	 * Frozen tool/capability surface applied identically to every candidate.
	 * `configFiles` names OMP config files passed to every session; all other
	 * keys are recorded verbatim and compared for drift. Fingerprinted.
	 */
	capabilities?: Record<string, unknown>;
}

/** Key-order-independent JSON, so a reformatted-but-identical policy matches. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export interface DesignCriterion {
	id: string;
	name: string;
	/** Maximum points; a criterion score is legal in [0, weight]. */
	weight: number;
}

export interface DesignDeduction {
	id: string;
	description: string;
	/** Points subtracted when the reviewer flags this deduction. */
	points: number;
}

export interface DesignRubric {
	version: number;
	/** Must equal the sum of criterion weights. */
	total: number;
	criteria: DesignCriterion[];
	deductions: DesignDeduction[];
}

export async function loadJson<T>(file: string): Promise<T> {
	return (await Bun.file(file).json()) as T;
}

/** Resolve a definition path against the repo root unless already absolute. */
function resolveRepoPath(p: string): string {
	return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

/**
 * SHA-256 over a directory's file contents, path-sorted. Fixture files are
 * hashed as raw bytes so binary fixtures hash correctly too.
 */
export async function hashTree(dir: string): Promise<string> {
	const files: string[] = [];
	const walk = async (current: string, prefix: string): Promise<void> => {
		const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
			else files.push(rel);
		}
	};
	await walk(dir, "");
	const parts: string[] = [];
	for (const rel of files) {
		const bytes = new Uint8Array(await Bun.file(path.join(dir, rel)).arrayBuffer());
		parts.push(`${rel}:${Bun.SHA256.hash(bytes, "hex")}`);
	}
	return Bun.SHA256.hash(parts.join("\n"), "hex");
}

/**
 * Fingerprint of everything a comparison depends on besides the model: prompt
 * bytes, rubric bytes, fixture bytes, required proofs, and viewport contract.
 */
export async function benchmarkFingerprint(
	def: DesignDefinition,
	resolved: {
		promptFile: string;
		rubricFile: string;
		fixtureDir: string;
	},
): Promise<{ promptSha256: string; rubricSha256: string; fixtureSha256: string; benchmarkSha256: string }> {
	const promptSha256 = Bun.SHA256.hash(await Bun.file(resolved.promptFile).arrayBuffer(), "hex");
	const rubricSha256 = Bun.SHA256.hash(await Bun.file(resolved.rubricFile).arrayBuffer(), "hex");
	const fixtureSha256 = await hashTree(resolved.fixtureDir);
	const identity = {
		id: def.id,
		version: def.version,
		promptSha256,
		rubricSha256,
		fixtureSha256,
		requiredProofs: def.requiredProofs,
		proofViewport: def.proofViewport,
		capabilities: canonicalJson(def.capabilities ?? {}),
	};
	const benchmarkSha256 = Bun.SHA256.hash(JSON.stringify(identity), "hex");
	return { promptSha256, rubricSha256, fixtureSha256, benchmarkSha256 };
}

// ---------------------------------------------------------------------------
// Rubric and score validation
// ---------------------------------------------------------------------------

export function validateRubric(rubric: DesignRubric): void {
	const sum = rubric.criteria.reduce((acc, criterion) => acc + criterion.weight, 0);
	if (rubric.total !== sum) {
		throw new Error(`rubric total ${rubric.total} != sum of criterion weights ${sum}`);
	}
	if (rubric.criteria.some(criterion => criterion.weight <= 0)) {
		throw new Error("every criterion weight must be positive");
	}
	const ids = new Set<string>();
	for (const criterion of rubric.criteria) {
		if (ids.has(criterion.id)) throw new Error(`duplicate criterion id: ${criterion.id}`);
		ids.add(criterion.id);
	}
	const deductionIds = new Set<string>();
	for (const deduction of rubric.deductions) {
		if (deductionIds.has(deduction.id)) throw new Error(`duplicate deduction id: ${deduction.id}`);
		if (deduction.points <= 0) throw new Error(`deduction ${deduction.id} points must be positive`);
		deductionIds.add(deduction.id);
	}
}

export interface ScoreInput {
	scores: Record<string, number>;
	deductions?: string[];
	note?: string;
	reviewer?: string;
}

/**
 * Validate a reviewer's raw score input against the rubric and return the
 * clamped total. Throws on any illegal value: missing criterion, non-numeric
 * score, score outside [0, weight], or unknown deduction id (F7).
 */
export function validateScoreInput(input: ScoreInput, rubric: DesignRubric): number {
	const ids = rubric.criteria
		.map(criterion => criterion.id)
		.sort()
		.join(",");
	const given = Object.keys(input.scores).sort().join(",");
	if (given !== ids) {
		throw new Error(`score keys must be exactly the rubric criteria (${ids}), got (${given})`);
	}
	for (const criterion of rubric.criteria) {
		const value = input.scores[criterion.id];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`criterion ${criterion.id} needs a finite number`);
		}
		if (value < 0 || value > criterion.weight) {
			throw new Error(`criterion ${criterion.id} score ${value} outside legal range [0, ${criterion.weight}]`);
		}
	}
	const known = new Set(rubric.deductions.map(deduction => deduction.id));
	for (const id of input.deductions ?? []) {
		if (!known.has(id)) throw new Error(`unknown deduction id: ${id}`);
	}
	const gross = rubric.criteria.reduce((acc, criterion) => acc + input.scores[criterion.id], 0);
	const penalty = rubric.deductions
		.filter(deduction => (input.deductions ?? []).includes(deduction.id))
		.reduce((acc, deduction) => acc + deduction.points, 0);
	return Math.max(0, gross - penalty);
}

/** Success line for the score command; the denominator always comes from the rubric. */
export function formatScoreResult(label: string, total: number, rubricTotal: number, file: string): string {
	return `recorded score for ${label}: total ${total}/${rubricTotal} → ${file}\n`;
}

export interface CandidateScore {
	candidate: string;
	scores: Record<string, number>;
	deductions: string[];
	note: string;
	reviewer: string;
	timestamp: string;
	total: number;
}

// ---------------------------------------------------------------------------
// Blind labeling
// ---------------------------------------------------------------------------

export interface BlindEntry {
	label: string;
	model: string;
	runIndex: number;
}

export interface BlindMap {
	seed: number;
	entries: BlindEntry[];
}

export interface RunManifest {
	schema: number;
	benchmarkId: string;
	benchmarkVersion: number;
	benchmarkSha256: string;
	definitionFile: string;
	promptFile: string;
	rubricFile: string;
	rubricSha256: string;
	fixtureDir: string;
	fixtureSha256: string;
	requiredProofs: string[];
	proofViewport: Record<string, string | number>;
	models: string[];
	repeat: number;
	seed: number;
	thinking: string | null;
	timeoutMs: number;
	/** Canonical frozen tool/capability surface, identical for every candidate. */
	capabilities: string;
	/** OMP config files enforcing that surface, resolved absolute. */
	configFiles: string[];
	createdAt: string;
	candidates: { label: string; runIndex: number; status: RunStatus }[];
}

/** FNV-1a over a string, for turning any seed string into a 32-bit seed. */
export function seedFromString(text: string): number {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/** Deterministic mulberry32 PRNG so the same seed reproduces the same shuffle. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Expand models × repeats, shuffle with a seeded PRNG, and assign anonymous
 * labels. The shuffle exists so label order does not trivially reveal the
 * configured model order; the same seed always reproduces the same mapping
 * (F4's uniqueness comes from the label numbering itself).
 */
export function blindAssign(models: readonly string[], repeat: number, seed: number): BlindEntry[] {
	const expanded: { model: string; runIndex: number }[] = [];
	for (let runIndex = 1; runIndex <= repeat; runIndex++) {
		for (const model of models) expanded.push({ model, runIndex });
	}
	const rng = mulberry32(seed);
	for (let i = expanded.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[expanded[i], expanded[j]] = [expanded[j], expanded[i]];
	}
	return expanded.map((entry, index) => ({
		label: `candidate-${String(index + 1).padStart(3, "0")}`,
		model: entry.model,
		runIndex: entry.runIndex,
	}));
}

/** Filesystem-safe rendering of a model selector (recorded, never used in blind paths). */
export function sanitizeSelector(selector: string): string {
	return selector.replace(/[^A-Za-z0-9._-]/g, "_");
}

// ---------------------------------------------------------------------------
// Candidate records
// ---------------------------------------------------------------------------

export type RunStatus = "pending" | "success" | "partial" | "failed" | "timeout" | "invalid";

export interface ProofCheck {
	ok: boolean;
	missing: string[];
}

export interface CandidateRecord {
	schema: number;
	label: string;
	runIndex: number;
	modelSelector: string;
	/** Model identity actually executed, as recorded by the session transcript. */
	modelNormalized: string | null;
	benchmarkSha256: string;
	promptSha256: string;
	fixtureSha256: string;
	thinking: string | null;
	/** Canonical frozen tool/capability surface for this run (drift-checked). */
	capabilities: string;
	requiredProofs: string[];
	status: RunStatus;
	failureReason: string | null;
	startedAt: string;
	endedAt: string | null;
	wallClockMs: number | null;
	transcript: string | null;
	finalOutput: string | null;
	proofCheck: ProofCheck | null;
	bench: BenchRun | null;
}

export interface DriftEntry {
	key: string;
	values: string[];
}

/**
 * Control drift across candidate records, reusing orchestration-bench's
 * `controlDrift` semantics over the run controls (with cwd deliberately
 * excluded: every candidate gets its own isolated workspace by design, and
 * content equality is instead enforced via `fixtureSha256`). Extra
 * design-layer controls — fixture, benchmark fingerprint, thinking level —
 * are compared on top, so this is strictly stronger than the base check.
 * Model identity is the one allowed variable and is never a drift key.
 */
export function designDrift(records: readonly CandidateRecord[]): DriftEntry[] {
	const withBench = records.filter(record => record.bench !== null);
	const drift = new Map<string, Set<string>>();
	const add = (key: string, value: string | null | undefined): void => {
		if (value === null || value === undefined) return;
		let set = drift.get(key);
		if (!set) {
			set = new Set<string>();
			drift.set(key, set);
		}
		set.add(value);
	};

	// Reuse the base control comparison: normalize cwd to a constant (isolation
	// mandates per-candidate paths), then pairwise-compare against the first.
	if (withBench.length > 1) {
		const controls = withBench.map(record => ({ ...record.bench!.control, cwd: "<isolated-workspace>" }));
		const controlValue = (control: BenchRun["control"], key: string): string | null => {
			if (key === "promptSha256") return control.promptSha256;
			if (key === "gitHead") return control.gitHead;
			if (key === "worktreeSha256") return control.worktreeSha256;
			if (key === "harnessSha256") return control.harnessSha256;
			return null; // cwd: excluded by normalization above
		};
		for (let index = 1; index < controls.length; index++) {
			for (const key of controlDrift(controls[0], controls[index])) {
				add(key, controlValue(withBench[0].bench!.control, key));
				add(key, controlValue(withBench[index].bench!.control, key));
			}
		}
	}

	for (const record of records) {
		add("fixtureSha256", record.fixtureSha256);
		add("benchmarkSha256", record.benchmarkSha256);
		add("thinking", record.thinking);
		add("capabilities", record.capabilities);
	}

	return [...drift.entries()]
		.filter(([, values]) => values.size > 1)
		.map(([key, values]) => ({ key, values: [...values].sort() }))
		.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Classify a completed run honestly (F3, F6). Exit 0 without the required
 * proofs is `invalid` — never a success — and a timeout is recognized from
 * measured wall time against the configured cap.
 */
export function classifyOutcome(
	bench: BenchRun | null,
	proofCheck: ProofCheck | null,
	wallClockMs: number,
	timeoutMs: number,
): { status: RunStatus; failureReason: string | null } {
	if (!bench) return { status: "failed", failureReason: "no bench run was produced" };
	if (bench.process.exitCode !== 0) {
		if (wallClockMs >= timeoutMs - 250) {
			return { status: "timeout", failureReason: `killed at ${timeoutMs}ms timeout` };
		}
		return {
			status: "failed",
			failureReason: `exit code ${bench.process.exitCode}${bench.process.stderrTail.length > 0 ? `: ${bench.process.stderrTail.slice(-300)}` : ""}`,
		};
	}
	if (bench.error) return { status: "partial", failureReason: bench.error };
	if (!proofCheck) return { status: "partial", failureReason: "proof validation did not run" };
	if (!proofCheck.ok) {
		return { status: "invalid", failureReason: `missing required proofs: ${proofCheck.missing.join(", ")}` };
	}
	if (!bench.metrics) return { status: "partial", failureReason: "transcript attribution failed" };
	return { status: "success", failureReason: null };
}

/** A candidate is review-ready only when its run succeeded and proofs verified. */
export function reviewReady(record: CandidateRecord): boolean {
	return record.status === "success" && record.proofCheck !== null && record.proofCheck.ok;
}

/**
 * Proof files a candidate produced beyond the required set (extra artifacts
 * are reported, not judged).
 */
export async function checkProofs(workspace: string, required: readonly string[]): Promise<ProofCheck> {
	const missing: string[] = [];
	for (const rel of required) {
		if (!(await Bun.file(path.join(workspace, rel)).exists())) missing.push(rel);
	}
	return { ok: missing.length === 0, missing };
}

/** Text content of a message payload, joined (opposite of a chars-only count). */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part === null || typeof part !== "object") continue;
		if (!("type" in part) || part.type !== "text") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/** Final assistant text from a transcript body — the candidate's closing answer. */
export function extractFinalOutput(transcriptText: string): string | null {
	const { entries } = decodeTranscript(transcriptText);
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = textOf(entry.message.content);
		return text.length > 0 ? text : null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Blind review surfaces
// ---------------------------------------------------------------------------

export interface ReviewRow {
	label: string;
	status: RunStatus;
	reviewReady: boolean;
	proofs: string[];
	elapsedMs: number | null;
}

/**
 * The blind review index: everything a human grader may see. Deliberately
 * excludes model identity, failure text, and transcript paths — those stay in
 * the candidate record and are only exposed via `report --reveal` / `reveal`.
 */
export function reviewIndex(records: readonly CandidateRecord[]): ReviewRow[] {
	return records.map(record => ({
		label: record.label,
		status: record.status,
		reviewReady: reviewReady(record),
		proofs: record.requiredProofs.map(rel => path.join(record.label, "workspace", rel)),
		elapsedMs: record.wallClockMs,
	}));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface ModelAggregate {
	model: string;
	runLabels: string[];
	runs: number;
	validRuns: number;
	ungraded: number;
	failed: number;
	invalid: number;
	timeout: number;
	partial: number;
	/** Valid graded run totals. */
	totals: number[];
	mean: number | null;
	median: number | null;
	best: number | null;
	worst: number | null;
	criterionMeans: Record<string, number | null>;
	/** Efficiency metrics, summed over runs that produced telemetry. */
	totalTokens: number;
	outputTokens: number;
	wallClockMs: number;
	modelDurationMs: number;
}

function mean(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-model aggregation after grading (F8, F9). Individual runs stay separate
 * (`runLabels`, `totals`); model-level stats aggregate only valid graded runs
 * so a failed or ungraded run can never launder into the mean.
 */
export function aggregateByModel(
	records: readonly CandidateRecord[],
	scores: ReadonlyMap<string, CandidateScore>,
	map: BlindMap,
	rubric: DesignRubric,
): ModelAggregate[] {
	const byModel = new Map<string, CandidateRecord[]>();
	for (const entry of map.entries) {
		const record = records.find(candidate => candidate.label === entry.label);
		if (!record) continue;
		let list = byModel.get(entry.model);
		if (!list) {
			list = [];
			byModel.set(entry.model, list);
		}
		list.push(record);
	}
	const aggregates: ModelAggregate[] = [];
	for (const [model, list] of byModel) {
		const totals: number[] = [];
		const criterionScores = new Map<string, number[]>();
		let ungraded = 0;
		let failed = 0;
		let invalid = 0;
		let timeout = 0;
		let partial = 0;
		let totalTokens = 0;
		let outputTokens = 0;
		let wallClockMs = 0;
		let modelDurationMs = 0;
		for (const record of list) {
			if (record.bench?.metrics) {
				totalTokens += record.bench.metrics.parent.totalTokens;
				outputTokens += record.bench.metrics.parent.outputTokens;
				wallClockMs += record.bench.process.wallClockMs;
				modelDurationMs += record.bench.metrics.timing.modelDurationMs;
			}
			if (record.status === "success") {
				const score = scores.get(record.label);
				if (!score) {
					ungraded++;
					continue;
				}
				totals.push(score.total);
				for (const criterion of rubric.criteria) {
					const value = score.scores[criterion.id] ?? 0;
					const list2 = criterionScores.get(criterion.id) ?? [];
					list2.push(value);
					criterionScores.set(criterion.id, list2);
				}
			} else if (record.status === "failed") failed++;
			else if (record.status === "timeout") timeout++;
			else if (record.status === "invalid") invalid++;
			else if (record.status === "partial") partial++;
		}
		const criterionMeans: Record<string, number | null> = {};
		for (const criterion of rubric.criteria) {
			criterionMeans[criterion.id] = mean(criterionScores.get(criterion.id) ?? []);
		}
		aggregates.push({
			model,
			runLabels: list.map(record => record.label),
			runs: list.length,
			validRuns: totals.length,
			ungraded,
			failed,
			invalid,
			timeout,
			partial,
			totals,
			mean: mean(totals),
			median: median(totals),
			best: totals.length > 0 ? Math.max(...totals) : null,
			worst: totals.length > 0 ? Math.min(...totals) : null,
			criterionMeans,
			totalTokens,
			outputTokens,
			wallClockMs,
			modelDurationMs,
		});
	}
	return aggregates.sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1) || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export interface ReportInput {
	manifest: RunManifest;
	records: readonly CandidateRecord[];
	scores: ReadonlyMap<string, CandidateScore>;
	rubric: DesignRubric;
	map: BlindMap | null;
	reveal: boolean;
}

const nf = (value: number | null, digits = 1): string => (value === null ? "—" : value.toFixed(digits));

/**
 * Human-readable comparison report. Blind mode (reveal=false) never contains
 * model identity (F5); reveal mode adds the mapping and per-model aggregation.
 * Design-quality scores and efficiency metrics are always separate sections —
 * lower token usage never compensates for ugly design.
 */
export function renderReport(input: ReportInput): string {
	const { manifest, records, scores, rubric, map, reveal } = input;
	const lines: string[] = [];
	lines.push(`# Design benchmark report — ${manifest.benchmarkId} v${manifest.benchmarkVersion}`);
	lines.push("");
	lines.push(`- benchmark fingerprint: \`${manifest.benchmarkSha256}\``);
	lines.push(`- fixture fingerprint: \`${manifest.fixtureSha256}\``);
	lines.push(
		`- candidates configured: ${manifest.candidates.length} (models: ${manifest.models.length}, repeat: ${manifest.repeat})`,
	);
	lines.push(`- required proofs: ${manifest.requiredProofs.join(", ")}`);
	lines.push("");

	const drift = designDrift(records);
	lines.push("## Control drift");
	lines.push("");
	if (drift.length === 0) lines.push("None — model identity is the only varying control.");
	else for (const entry of drift) lines.push(`- **${entry.key}**: ${entry.values.join(" | ")}`);
	lines.push("");

	lines.push("## Candidates (design quality)");
	lines.push("");
	lines.push("| Candidate | Status | Review-ready | Design score | Proof paths |");
	lines.push("|---|---|---|---|---|");
	for (const record of records) {
		const score = scores.get(record.label);
		const graded = score ? score.total.toFixed(0) : record.status === "success" ? "**ungraded**" : "—";
		const proofs = record.requiredProofs.map(rel => `\`${record.label}/workspace/${rel}\``).join("<br>");
		lines.push(
			`| ${record.label} | ${record.status} | ${reviewReady(record) ? "yes" : "no"} | ${graded} | ${proofs} |`,
		);
	}
	lines.push("");
	lines.push("Ungraded means the run succeeded but no rubric score has been recorded yet — it is not a zero.");

	if (reveal && map) {
		const aggregates = aggregateByModel(records, scores, map, rubric);
		lines.push("");
		lines.push("## Models (after reveal)");
		lines.push("");
		lines.push("| Candidate | Model |");
		lines.push("|---|---|");
		for (const entry of map.entries) lines.push(`| ${entry.label} | \`${sanitizeSelector(entry.model)}\` |`);
		lines.push("");
		lines.push("## Per-model aggregation");
		lines.push("");
		for (const aggregate of aggregates) {
			lines.push(`### \`${sanitizeSelector(aggregate.model)}\``);
			lines.push("");
			lines.push(
				`- runs: ${aggregate.runs} (valid graded: ${aggregate.validRuns}, ungraded: ${aggregate.ungraded}, failed: ${aggregate.failed}, timeout: ${aggregate.timeout}, invalid: ${aggregate.invalid}, partial: ${aggregate.partial})`,
			);
			lines.push(
				`- design score: mean ${nf(aggregate.mean)} / median ${nf(aggregate.median)} / best ${nf(aggregate.best, 0)} / worst ${nf(aggregate.worst, 0)} of ${rubric.total}`,
			);
			lines.push(
				`- individual run totals: ${aggregate.totals.length > 0 ? aggregate.totals.map(t => t.toFixed(0)).join(", ") : "—"}`,
			);
			const perCriterion = rubric.criteria
				.map(criterion => `${criterion.id} ${nf(aggregate.criterionMeans[criterion.id])}/${criterion.weight}`)
				.join(", ");
			lines.push(`- by criterion: ${perCriterion}`);
			lines.push("");
			lines.push("### Efficiency (reported separately — does not affect design score)");
			lines.push("");
			lines.push(
				`- tokens: total ${aggregate.totalTokens}, output ${aggregate.outputTokens} · wall clock ${aggregate.wallClockMs}ms · model time ${aggregate.modelDurationMs}ms`,
			);
			lines.push("");
		}
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Run-root file layout
// ---------------------------------------------------------------------------

export const MANIFEST_FILE = "manifest.json";
export const MAP_FILE = "map.json";
const RECORDS_DIR = "records";
const SCORES_DIR = "scores";
const CANDIDATES_DIR = "candidates";

function candidateDir(runRoot: string, label: string): string {
	return path.join(runRoot, CANDIDATES_DIR, label);
}

function recordFile(runRoot: string, label: string): string {
	return path.join(runRoot, RECORDS_DIR, `${label}.json`);
}

function scoreFile(runRoot: string, label: string): string {
	return path.join(runRoot, SCORES_DIR, `${label}.json`);
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await Bun.write(file, `${JSON.stringify(value, null, "\t")}\n`);
}

async function loadManifest(runRoot: string): Promise<RunManifest> {
	return loadJson<RunManifest>(path.join(runRoot, MANIFEST_FILE));
}

async function loadMap(runRoot: string): Promise<BlindMap> {
	return loadJson<BlindMap>(path.join(runRoot, MAP_FILE));
}

async function loadRecords(runRoot: string, manifest: RunManifest): Promise<CandidateRecord[]> {
	const records: CandidateRecord[] = [];
	for (const candidate of manifest.candidates) {
		try {
			records.push(await loadJson<CandidateRecord>(recordFile(runRoot, candidate.label)));
		} catch {
			records.push({
				schema: DESIGN_BENCH_SCHEMA,
				label: candidate.label,
				runIndex: candidate.runIndex,
				modelSelector: "(not run)",
				modelNormalized: null,
				benchmarkSha256: manifest.benchmarkSha256,
				promptSha256: "",
				fixtureSha256: manifest.fixtureSha256,
				thinking: manifest.thinking,
				capabilities: manifest.capabilities,
				requiredProofs: manifest.requiredProofs,
				status: "pending",
				failureReason: null,
				startedAt: manifest.createdAt,
				endedAt: null,
				wallClockMs: null,
				transcript: null,
				finalOutput: null,
				proofCheck: null,
				bench: null,
			});
		}
	}
	return records;
}

async function loadScores(runRoot: string, manifest: RunManifest): Promise<Map<string, CandidateScore>> {
	const scores = new Map<string, CandidateScore>();
	for (const candidate of manifest.candidates) {
		try {
			scores.set(candidate.label, await loadJson<CandidateScore>(scoreFile(runRoot, candidate.label)));
		} catch {
			// Ungraded — intentionally not an error (F8).
		}
	}
	return scores;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
}

function positionals(args: readonly string[]): string[] {
	return args.filter((arg, index) => !arg.startsWith("--") && (index === 0 || args[index - 1].charCodeAt(0) !== 45));
}

const USAGE = `design-bench — frontend-design benchmark over orchestration-bench

  init <definition.json> --models <m1,m2> --repeat <n> --out <runRoot>
       [--seed <n|string>] [--thinking <level>] [--timeout-ms <ms>]
  run <runRoot> [--only <label>]
  validate <runRoot>
  candidates <runRoot> [--json]
  score <runRoot> <label> --file <score.json>
  report <runRoot> [--reveal]
  reveal <runRoot>
`;

async function cmdInit(argv: readonly string[]): Promise<number> {
	const [definitionPath] = positionals(argv);
	const modelsArg = flag(argv, "models");
	const outArg = flag(argv, "out");
	if (!definitionPath || !modelsArg || !outArg) {
		process.stderr.write(USAGE);
		return 1;
	}
	const repeat = Number(flag(argv, "repeat") ?? "1");
	if (!Number.isInteger(repeat) || repeat < 1) {
		process.stderr.write("--repeat must be a positive integer\n");
		return 1;
	}
	const timeoutMs = Number(flag(argv, "timeout-ms") ?? 30 * 60 * 1000);
	if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000) {
		process.stderr.write("--timeout-ms must be an integer >= 60000\n");
		return 1;
	}
	const seedArg = flag(argv, "seed") ?? String(Date.now());
	const seed = /^\d+$/.test(seedArg) ? Number(seedArg) : seedFromString(seedArg);
	const thinking = flag(argv, "thinking") ?? null;

	const def = await loadJson<DesignDefinition>(path.resolve(definitionPath));
	// Config files freeze the tool/capability surface; a missing file would
	// silently vary that surface between candidates, so fail loudly here.
	const configFiles: string[] = [];
	for (const configFile of (def.capabilities?.configFiles as string[] | undefined) ?? []) {
		const resolvedConfig = resolveRepoPath(configFile);
		if (!(await Bun.file(resolvedConfig).exists())) {
			process.stderr.write(`capability config file not found: ${resolvedConfig}\n`);
			return 1;
		}
		configFiles.push(resolvedConfig);
	}
	const resolved = {
		promptFile: resolveRepoPath(def.promptFile),
		rubricFile: resolveRepoPath(def.rubricFile),
		fixtureDir: resolveRepoPath(def.fixtureDir),
	};
	const rubric = await loadJson<DesignRubric>(resolved.rubricFile);
	validateRubric(rubric);
	const fingerprint = await benchmarkFingerprint(def, resolved);
	const models = modelsArg
		.split(",")
		.map(model => model.trim())
		.filter(model => model.length > 0);
	if (models.length === 0) {
		process.stderr.write("--models must name at least one model selector\n");
		return 1;
	}
	const entries = blindAssign(models, repeat, seed);
	const manifest: RunManifest = {
		schema: DESIGN_BENCH_SCHEMA,
		benchmarkId: def.id,
		benchmarkVersion: def.version,
		benchmarkSha256: fingerprint.benchmarkSha256,
		definitionFile: path.resolve(definitionPath),
		promptFile: resolved.promptFile,
		rubricFile: resolved.rubricFile,
		rubricSha256: fingerprint.rubricSha256,
		fixtureDir: resolved.fixtureDir,
		fixtureSha256: fingerprint.fixtureSha256,
		requiredProofs: def.requiredProofs,
		proofViewport: def.proofViewport,
		models,
		repeat,
		seed,
		thinking,
		timeoutMs,
		capabilities: canonicalJson(def.capabilities ?? {}),
		configFiles,
		createdAt: new Date().toISOString(),
		candidates: entries.map(entry => ({
			label: entry.label,
			runIndex: entry.runIndex,
			status: "pending" as RunStatus,
		})),
	};
	await fs.mkdir(outArg, { recursive: true });
	await fs.mkdir(path.join(outArg, RECORDS_DIR), { recursive: true });
	await fs.mkdir(path.join(outArg, SCORES_DIR), { recursive: true });
	await writeJson(path.join(outArg, MANIFEST_FILE), manifest);
	await writeJson(path.join(outArg, MAP_FILE), { schema: DESIGN_BENCH_SCHEMA, seed, entries });
	process.stdout.write(
		`initialized ${manifest.candidates.length} candidates (${models.length} models × ${repeat}) in ${outArg}\n` +
			`benchmark fingerprint ${fingerprint.benchmarkSha256}\n` +
			`blind mapping in ${path.join(outArg, MAP_FILE)} — do not open while grading\n`,
	);
	return 0;
}

/** Copy the frozen fixture into a candidate workspace (fresh on every run). */
async function seedWorkspace(fixtureDir: string, workspace: string): Promise<void> {
	await fs.rm(workspace, { recursive: true, force: true });
	await fs.mkdir(path.dirname(workspace), { recursive: true });
	await fs.cp(fixtureDir, workspace, { recursive: true });
}

async function runCandidate(runRoot: string, manifest: RunManifest, entry: BlindEntry): Promise<CandidateRecord> {
	const workspace = path.join(candidateDir(runRoot, entry.label), "workspace");
	await seedWorkspace(manifest.fixtureDir, workspace);
	const startedAt = new Date().toISOString();
	const bench = await runBenchmark({
		promptFile: manifest.promptFile,
		cwd: workspace,
		model: entry.model,
		thinking: manifest.thinking ?? undefined,
		configFiles: manifest.configFiles.length > 0 ? manifest.configFiles : undefined,
		timeoutMs: manifest.timeoutMs,
		label: entry.label,
	});
	const endedAt = new Date().toISOString();
	const transcript = bench.metrics?.session.file ?? null;
	let finalOutput: string | null = null;
	if (transcript) {
		try {
			finalOutput = extractFinalOutput(await Bun.file(transcript).text());
		} catch {
			finalOutput = null;
		}
	}
	const proofCheck = await checkProofs(workspace, manifest.requiredProofs);
	const { status, failureReason } = classifyOutcome(bench, proofCheck, bench.process.wallClockMs, manifest.timeoutMs);
	const record: CandidateRecord = {
		schema: DESIGN_BENCH_SCHEMA,
		label: entry.label,
		runIndex: entry.runIndex,
		modelSelector: entry.model,
		modelNormalized: bench.metrics?.session.model ?? null,
		benchmarkSha256: manifest.benchmarkSha256,
		promptSha256: bench.control.promptSha256,
		fixtureSha256: manifest.fixtureSha256,
		thinking: manifest.thinking,
		capabilities: manifest.capabilities,
		requiredProofs: manifest.requiredProofs,
		status,
		failureReason,
		startedAt,
		endedAt,
		wallClockMs: bench.process.wallClockMs,
		transcript,
		finalOutput,
		proofCheck,
		bench,
	};
	await writeJson(recordFile(runRoot, entry.label), record);
	return record;
}

async function cmdRun(argv: readonly string[]): Promise<number> {
	const [runRoot] = positionals(argv);
	if (!runRoot) {
		process.stderr.write(USAGE);
		return 1;
	}
	const only = flag(argv, "only");
	const manifest = await loadManifest(runRoot);
	const map = await loadMap(runRoot);
	const entries = only ? map.entries.filter(entry => entry.label === only) : map.entries;
	if (only && entries.length === 0) {
		process.stderr.write(`unknown candidate label: ${only}\n`);
		return 1;
	}
	let notReady = 0;
	for (const entry of entries) {
		const record = await runCandidate(runRoot, manifest, entry);
		process.stderr.write(
			`${entry.label}: ${record.status}${record.failureReason ? ` — ${record.failureReason}` : ""}\n`,
		);
		if (record.status !== "success") notReady++;
	}
	// Refresh manifest statuses from disk so an interrupted run resumes cleanly.
	const records = await loadRecords(runRoot, manifest);
	manifest.candidates = manifest.candidates.map(candidate => ({
		...candidate,
		status: records.find(record => record.label === candidate.label)?.status ?? "pending",
	}));
	await writeJson(path.join(runRoot, MANIFEST_FILE), manifest);
	return notReady === 0 ? 0 : 1;
}

/**
 * Re-verify proofs and statuses from disk without re-running any session.
 * A record whose proofs vanished downgrades to `invalid` (F3/F6 honesty).
 */
async function cmdValidate(argv: readonly string[]): Promise<number> {
	const [runRoot] = positionals(argv);
	if (!runRoot) {
		process.stderr.write(USAGE);
		return 1;
	}
	const manifest = await loadManifest(runRoot);
	const records = await loadRecords(runRoot, manifest);
	let notReady = 0;
	for (const record of records) {
		if (record.bench === null) continue;
		const workspace = path.join(candidateDir(runRoot, record.label), "workspace");
		const proofCheck = await checkProofs(workspace, manifest.requiredProofs);
		const outcome = classifyOutcome(record.bench, proofCheck, record.wallClockMs ?? 0, manifest.timeoutMs);
		if (outcome.status !== record.status || proofCheck.ok !== record.proofCheck?.ok) {
			record.status = outcome.status;
			record.failureReason = outcome.failureReason;
			record.proofCheck = proofCheck;
			await writeJson(recordFile(runRoot, record.label), record);
		}
		if (!reviewReady(record)) notReady++;
	}
	process.stdout.write(`validated ${records.length} candidates; ${notReady} not review-ready\n`);
	return notReady === 0 ? 0 : 1;
}

async function cmdCandidates(argv: readonly string[]): Promise<number> {
	const [runRoot] = positionals(argv);
	if (!runRoot) {
		process.stderr.write(USAGE);
		return 1;
	}
	const manifest = await loadManifest(runRoot);
	const records = await loadRecords(runRoot, manifest);
	const rows = reviewIndex(records);
	if (argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(rows, null, "\t")}\n`);
		return 0;
	}
	for (const row of rows) {
		process.stdout.write(
			`${row.label}  status=${row.status}  review-ready=${row.reviewReady ? "yes" : "no"}  elapsed=${row.elapsedMs ?? "—"}ms\n` +
				`${row.proofs.map(proof => `  ${path.join(runRoot, "candidates", proof)}`).join("\n")}\n`,
		);
	}
	return 0;
}

async function cmdScore(argv: readonly string[]): Promise<number> {
	const [runRoot, label] = positionals(argv);
	const scorePath = flag(argv, "file");
	if (!runRoot || !label || !scorePath) {
		process.stderr.write(USAGE);
		return 1;
	}
	const manifest = await loadManifest(runRoot);
	if (!manifest.candidates.some(candidate => candidate.label === label)) {
		process.stderr.write(`unknown candidate label: ${label}\n`);
		return 1;
	}
	const rubric = await loadJson<DesignRubric>(manifest.rubricFile);
	const input = await loadJson<ScoreInput>(path.resolve(scorePath));
	let total: number;
	try {
		total = validateScoreInput(input, rubric);
	} catch (err) {
		process.stderr.write(`invalid score: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
	const score: CandidateScore = {
		candidate: label,
		scores: input.scores,
		deductions: input.deductions ?? [],
		note: input.note ?? "",
		reviewer: input.reviewer ?? "unknown",
		timestamp: new Date().toISOString(),
		total,
	};
	await writeJson(scoreFile(runRoot, label), score);
	process.stdout.write(formatScoreResult(label, total, rubric.total, scoreFile(runRoot, label)));
	return 0;
}

async function cmdReport(argv: readonly string[]): Promise<number> {
	const [runRoot] = positionals(argv);
	if (!runRoot) {
		process.stderr.write(USAGE);
		return 1;
	}
	const reveal = argv.includes("--reveal");
	const manifest = await loadManifest(runRoot);
	const records = await loadRecords(runRoot, manifest);
	const scores = await loadScores(runRoot, manifest);
	const rubric = await loadJson<DesignRubric>(manifest.rubricFile);
	const map = reveal ? await loadMap(runRoot) : null;
	const markdown = renderReport({ manifest, records, scores, rubric, map, reveal });
	await Bun.write(path.join(runRoot, "report.md"), markdown);
	await writeJson(path.join(runRoot, "report.json"), {
		schema: DESIGN_BENCH_SCHEMA,
		benchmarkId: manifest.benchmarkId,
		benchmarkVersion: manifest.benchmarkVersion,
		benchmarkSha256: manifest.benchmarkSha256,
		fixtureSha256: manifest.fixtureSha256,
		reveal,
		controlDrift: designDrift(records),
		candidates: reviewIndex(records),
		scores: [...scores.values()],
		models: reveal && map ? aggregateByModel(records, scores, map, rubric) : undefined,
	});
	process.stdout.write(`wrote ${path.join(runRoot, "report.md")}${reveal ? " (revealed)" : " (blind)"}\n`);
	return 0;
}

async function cmdReveal(argv: readonly string[]): Promise<number> {
	const [runRoot] = positionals(argv);
	if (!runRoot) {
		process.stderr.write(USAGE);
		return 1;
	}
	const map = await loadMap(runRoot);
	for (const entry of map.entries) {
		process.stdout.write(`${entry.label} → ${entry.model} (repeat ${entry.runIndex})\n`);
	}
	return 0;
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "--help" || command === "-h") {
		process.stdout.write(USAGE);
		return command ? 0 : 1;
	}
	if (command === "init") return cmdInit(rest);
	if (command === "run") return cmdRun(rest);
	if (command === "validate") return cmdValidate(rest);
	if (command === "candidates") return cmdCandidates(rest);
	if (command === "score") return cmdScore(rest);
	if (command === "report") return cmdReport(rest);
	if (command === "reveal") return cmdReveal(rest);
	process.stderr.write(`unknown command: ${command}\n${USAGE}`);
	return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
