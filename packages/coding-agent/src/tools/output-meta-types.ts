/**
 * Shared output-meta types to break circular import between output-meta and ingress-budget.
 * Both modules need these types, but output-meta imports functions from ingress-budget,
 * and ingress-budget imports types from output-meta, creating a circular value+type dependency
 * that confuses tsgo's isolated type checking and leaks into unrelated files (e.g., eval test).
 * Extracting the pure types here breaks the cycle at the value level.
 */
export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	shownRange?: { start: number; end: number };
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	elidedBytes?: number;
	elidedLines?: number;
	artifactId?: string;
	nextOffset?: number;
}
export type SourceMeta = { type: "path"; value: string } | { type: "url"; value: string } | { type: "internal"; value: string };
export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}
export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	resultLimit?: { reached: number; suggestion: number };
	headLimit?: { reached: number; suggestion: number };
	columnTruncated?: { maxColumn: number };
}
export interface OutputMeta {
	truncation?: TruncationMeta;
	source?: SourceMeta;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
	ingress?: { shapedAs: "file" | "pointer" | "artifact" | "structured" | "duplicate" };
}
