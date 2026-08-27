/**
 * Vibe session lifecycle vocabulary: the persisted `vibe-session-lifecycle`
 * custom-entry schema and its parser.
 *
 * Deliberately a leaf module — it is consumed by persisted-roster scanning
 * ([`persistedVibeChildIds`] via `registry/persisted-agents`), which sits on
 * the internal-URL resolution path. Importing `vibe/runtime` from there would
 * drag the task executor and SDK into the render-utils module cycle.
 *
 * CP7 extends the upstream v1 spawn record with v2 role/routing metadata. Keep
 * both versions readable so existing sessions survive the upstream upgrade.
 */

/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";

/** Generic role-oriented worker identities (CP7-facing + vanilla). */
export type VibeRole = "scout" | "utility" | "implementer" | "designer" | "planner" | "reviewer";

/** Generic routing intent carried through vibe lifecycle. */
export type VibeRoutingIntent = "default" | "cheap" | "normal" | "strong" | "vision" | "large-context" | "same-pool-ok";

/** Generic routing constraints the caller may supply. */
export interface VibeRoutingOptions {
\texcludePools?: string[];
\tpreferPools?: string[];
\tallowParentPool?: boolean;
\tdeadSelectors?: string[];
}

/** Generic external task linkage — opaque to vibe core. */
export interface VibeExternalMetadata {
\texternalTaskId?: string;
\tspecPath?: string;
\tpolicyHash?: string;
\tpolicyRevision?: string;
\tlabel?: string;
}

/** Custom-entry type tag for persisted Vibe lifecycle events. */
export const VIBE_LIFECYCLE_CUSTOM_TYPE = "vibe-session-lifecycle";
/** Current CP7 schema version for persisted Vibe lifecycle events. */
export const VIBE_LIFECYCLE_VERSION = 2;
/** Upstream/legacy schema version retained for backward compatibility. */
export const VIBE_LIFECYCLE_LEGACY_VERSION = 1;

export type VibeTombstoneReason = "explicit-kill" | "mode-exit" | "spawn-failed" | "unrecoverable";

export interface VibeLifecycleBase {
\tversion: typeof VIBE_LIFECYCLE_VERSION | typeof VIBE_LIFECYCLE_LEGACY_VERSION;
\tid: string;
\townerId: string;
\tparentSessionId: string;
}

export interface VibeSpawnLifecycleEventV1 extends VibeLifecycleBase {
\tversion: typeof VIBE_LIFECYCLE_LEGACY_VERSION;
\taction: "spawn";
\tcli: VibeCli;
\tagent: string;
\tchildSessionFile: string;
\tcreatedAt: number;
}

export interface VibeSpawnLifecycleEventV2 extends VibeLifecycleBase {
\tversion: typeof VIBE_LIFECYCLE_VERSION;
\taction: "spawn";
\tcli?: VibeCli;
\trole?: VibeRole;
\tagent: string;
\tchildSessionFile: string;
\tcreatedAt: number;
\tmodelOverride?: string | string[];
\tmodelRole?: string;
\tintent?: VibeRoutingIntent;
\trouting?: VibeRoutingOptions;
\tmetadata?: VibeExternalMetadata;
}

export type VibeSpawnLifecycleEvent = VibeSpawnLifecycleEventV1 | VibeSpawnLifecycleEventV2;

export interface VibeTurnLifecycleEvent extends VibeLifecycleBase {
\taction: "turn-started" | "turn-settled";
\tturn: number;
}

export interface VibeTombstoneLifecycleEvent extends VibeLifecycleBase {
\taction: "tombstone";
\treason: VibeTombstoneReason;
}

export interface VibeTombstoneRevocationEvent extends VibeLifecycleBase {
\taction: "tombstone-revoked";
\treason: "mode-exit";
}

export type VibeLifecycleEvent =
\t| VibeSpawnLifecycleEvent
\t| VibeTurnLifecycleEvent
\t| VibeTombstoneLifecycleEvent
\t| VibeTombstoneRevocationEvent;

const VIBE_ROLES = new Set<VibeRole>(["scout", "utility", "implementer", "designer", "planner", "reviewer"]);
const VIBE_ROUTING_INTENTS = new Set<VibeRoutingIntent>([
\t"default",
\t"cheap",
\t"normal",
\t"strong",
\t"vision",
\t"large-context",
\t"same-pool-ok",
]);

function objectRecord(value: unknown): Record<string, unknown> | undefined {
\tif (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
\treturn value as Record<string, unknown>;
}

/** Parse one persisted lifecycle payload; `undefined` for foreign/malformed data. */
export function parseLifecycleEvent(value: unknown): VibeLifecycleEvent | undefined {
\tconst data = objectRecord(value);
\tif (!data || (data.version !== VIBE_LIFECYCLE_VERSION && data.version !== VIBE_LIFECYCLE_LEGACY_VERSION)) {
\t\treturn undefined;
\t}
\tif (typeof data.id !== "string" || !data.id) return undefined;
\tif (typeof data.ownerId !== "string" || !data.ownerId) return undefined;
\tif (typeof data.parentSessionId !== "string" || !data.parentSessionId) return undefined;

\tconst base: VibeLifecycleBase = {
\t\tversion: data.version,
\t\tid: data.id,
\t\townerId: data.ownerId,
\t\tparentSessionId: data.parentSessionId,
\t};

\tif (data.action === "spawn") {
\t\tif (typeof data.agent !== "string" || typeof data.childSessionFile !== "string") return undefined;
\t\tif (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) return undefined;

\t\tif (data.version === VIBE_LIFECYCLE_VERSION) {
\t\t\tconst cli = data.cli === "fast" || data.cli === "good" ? data.cli : undefined;
\t\t\tconst role = typeof data.role === "string" && VIBE_ROLES.has(data.role as VibeRole) ? (data.role as VibeRole) : undefined;
\t\t\tif (!cli && !role) return undefined;

\t\t\tlet modelOverride: string | string[] | undefined;
\t\t\tif (Array.isArray(data.modelOverride)) {
\t\t\t\tif (!data.modelOverride.every(value => typeof value === "string")) return undefined;
\t\t\t\tmodelOverride = data.modelOverride as string[];
\t\t\t} else if (typeof data.modelOverride === "string") {
\t\t\t\tmodelOverride = [data.modelOverride];
\t\t\t} else if (data.modelOverride !== undefined) {
\t\t\t\treturn undefined;
\t\t\t}

\t\t\tconst modelRole = typeof data.modelRole === "string" ? data.modelRole : undefined;
\t\t\tconst intent =
\t\t\t\ttypeof data.intent === "string" && VIBE_ROUTING_INTENTS.has(data.intent as VibeRoutingIntent)
\t\t\t\t\t? (data.intent as VibeRoutingIntent)
\t\t\t\t\t: undefined;

\t\t\tlet routing: VibeRoutingOptions | undefined;
\t\t\tif (data.routing !== undefined) {
\t\t\t\tconst raw = objectRecord(data.routing);
\t\t\t\tif (!raw) return undefined;
\t\t\t\trouting = {};
\t\t\t\tif (Array.isArray(raw.excludePools)) routing.excludePools = raw.excludePools.filter((v): v is string => typeof v === "string");
\t\t\t\tif (Array.isArray(raw.preferPools)) routing.preferPools = raw.preferPools.filter((v): v is string => typeof v === "string");
\t\t\t\tif (typeof raw.allowParentPool === "boolean") routing.allowParentPool = raw.allowParentPool;
\t\t\t\tif (Array.isArray(raw.deadSelectors)) routing.deadSelectors = raw.deadSelectors.filter((v): v is string => typeof v === "string");
\t\t\t}

\t\t\tlet metadata: VibeExternalMetadata | undefined;
\t\t\tif (data.metadata !== undefined) {
\t\t\t\tconst raw = objectRecord(data.metadata);
\t\t\t\tif (!raw) return undefined;
\t\t\t\tmetadata = {};
\t\t\t\tif (typeof raw.externalTaskId === "string") metadata.externalTaskId = raw.externalTaskId;
\t\t\t\tif (typeof raw.specPath === "string") metadata.specPath = raw.specPath;
\t\t\t\tif (typeof raw.policyHash === "string") metadata.policyHash = raw.policyHash;
\t\t\t\tif (typeof raw.policyRevision === "string") metadata.policyRevision = raw.policyRevision;
\t\t\t\tif (typeof raw.label === "string") metadata.label = raw.label;
\t\t\t}

\t\t\treturn {
\t\t\t\t...base,
\t\t\t\tversion: VIBE_LIFECYCLE_VERSION,
\t\t\t\taction: "spawn",
\t\t\t\tcli,
\t\t\t\trole,
\t\t\t\tagent: data.agent,
\t\t\t\tchildSessionFile: data.childSessionFile,
\t\t\t\tcreatedAt: data.createdAt,
\t\t\t\tmodelOverride,
\t\t\t\tmodelRole,
\t\t\t\tintent,
\t\t\t\trouting,
\t\t\t\tmetadata,
\t\t\t};
\t\t}

\t\tconst cli = data.cli === "fast" || data.cli === "good" ? data.cli : undefined;
\t\tif (!cli) return undefined;
\t\treturn {
\t\t\t...base,
\t\t\tversion: VIBE_LIFECYCLE_LEGACY_VERSION,
\t\t\taction: "spawn",
\t\t\tcli,
\t\t\tagent: data.agent,
\t\t\tchildSessionFile: data.childSessionFile,
\t\t\tcreatedAt: data.createdAt,
\t\t};
\t}

\tif (data.action === "turn-started" || data.action === "turn-settled") {
\t\tif (typeof data.turn !== "number" || !Number.isInteger(data.turn) || data.turn < 1) return undefined;
\t\treturn { ...base, action: data.action, turn: data.turn };
\t}
\tif (data.action === "tombstone") {
\t\tconst reason = data.reason;
\t\tif (
\t\t\treason !== "explicit-kill" &&
\t\t\treason !== "mode-exit" &&
\t\t\treason !== "spawn-failed" &&
\t\t\treason !== "unrecoverable"
\t\t) {
\t\t\treturn undefined;
\t\t}
\t\treturn { ...base, action: "tombstone", reason };
\t}
\tif (data.action === "tombstone-revoked" && data.reason === "mode-exit") {
\t\treturn { ...base, action: "tombstone-revoked", reason: "mode-exit" };
\t}
\treturn undefined;
}

/** Child ids claimed by valid Vibe spawn records from untrusted persisted JSON. */
export function persistedVibeChildIds(entries: Iterable<unknown>): Set<string> {
\tconst ids = new Set<string>();
\tfor (const value of entries) {
\t\tconst entry = objectRecord(value);
\t\tif (entry?.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
\t\tconst event = parseLifecycleEvent(entry.data);
\t\tif (
\t\t\tevent?.action === "spawn" &&
\t\t\t/^[A-Za-z0-9_-]+$/.test(event.id) &&
\t\t\tevent.childSessionFile === `${event.id}.jsonl`
\t\t) {
\t\t\tids.add(event.id);
\t\t}
\t}
\treturn ids;
}
