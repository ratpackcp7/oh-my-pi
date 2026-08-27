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
	excludePools?: string[];
	preferPools?: string[];
	allowParentPool?: boolean;
	deadSelectors?: string[];
}

/** Generic external task linkage — opaque to vibe core. */
export interface VibeExternalMetadata {
	externalTaskId?: string;
	specPath?: string;
	policyHash?: string;
	policyRevision?: string;
	label?: string;
}

/** Custom-entry type tag for persisted Vibe lifecycle events. */
export const VIBE_LIFECYCLE_CUSTOM_TYPE = "vibe-session-lifecycle";
/** Current CP7 schema version for persisted Vibe lifecycle events. */
export const VIBE_LIFECYCLE_VERSION = 2;
/** Upstream/legacy schema version retained for backward compatibility. */
export const VIBE_LIFECYCLE_LEGACY_VERSION = 1;

export type VibeTombstoneReason = "explicit-kill" | "mode-exit" | "spawn-failed" | "unrecoverable";

export interface VibeLifecycleBase {
	version: typeof VIBE_LIFECYCLE_VERSION | typeof VIBE_LIFECYCLE_LEGACY_VERSION;
	id: string;
	ownerId: string;
	parentSessionId: string;
}

export interface VibeSpawnLifecycleEventV1 extends VibeLifecycleBase {
	version: typeof VIBE_LIFECYCLE_LEGACY_VERSION;
	action: "spawn";
	cli: VibeCli;
	agent: string;
	childSessionFile: string;
	createdAt: number;
}

export interface VibeSpawnLifecycleEventV2 extends VibeLifecycleBase {
	version: typeof VIBE_LIFECYCLE_VERSION;
	action: "spawn";
	cli?: VibeCli;
	role?: VibeRole;
	agent: string;
	childSessionFile: string;
	createdAt: number;
	modelOverride?: string | string[];
	modelRole?: string;
	intent?: VibeRoutingIntent;
	routing?: VibeRoutingOptions;
	metadata?: VibeExternalMetadata;
}

export type VibeSpawnLifecycleEvent = VibeSpawnLifecycleEventV1 | VibeSpawnLifecycleEventV2;

export interface VibeTurnLifecycleEvent extends VibeLifecycleBase {
	action: "turn-started" | "turn-settled";
	turn: number;
}

export interface VibeTombstoneLifecycleEvent extends VibeLifecycleBase {
	action: "tombstone";
	reason: VibeTombstoneReason;
}

export interface VibeTombstoneRevocationEvent extends VibeLifecycleBase {
	action: "tombstone-revoked";
	reason: "mode-exit";
}

export type VibeLifecycleEvent =
	| VibeSpawnLifecycleEvent
	| VibeTurnLifecycleEvent
	| VibeTombstoneLifecycleEvent
	| VibeTombstoneRevocationEvent;

const VIBE_ROLES = new Set<VibeRole>(["scout", "utility", "implementer", "designer", "planner", "reviewer"]);
const VIBE_ROUTING_INTENTS = new Set<VibeRoutingIntent>([
	"default",
	"cheap",
	"normal",
	"strong",
	"vision",
	"large-context",
	"same-pool-ok",
]);

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** Parse one persisted lifecycle payload; `undefined` for foreign/malformed data. */
export function parseLifecycleEvent(value: unknown): VibeLifecycleEvent | undefined {
	const data = objectRecord(value);
	if (!data || (data.version !== VIBE_LIFECYCLE_VERSION && data.version !== VIBE_LIFECYCLE_LEGACY_VERSION)) {
		return undefined;
	}
	if (typeof data.id !== "string" || !data.id) return undefined;
	if (typeof data.ownerId !== "string" || !data.ownerId) return undefined;
	if (typeof data.parentSessionId !== "string" || !data.parentSessionId) return undefined;

	const base: VibeLifecycleBase = {
		version: data.version,
		id: data.id,
		ownerId: data.ownerId,
		parentSessionId: data.parentSessionId,
	};

	if (data.action === "spawn") {
		if (typeof data.agent !== "string" || typeof data.childSessionFile !== "string") return undefined;
		if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) return undefined;

		if (data.version === VIBE_LIFECYCLE_VERSION) {
			const cli = data.cli === "fast" || data.cli === "good" ? data.cli : undefined;
			const role =
				typeof data.role === "string" && VIBE_ROLES.has(data.role as VibeRole)
					? (data.role as VibeRole)
					: undefined;
			if (!cli && !role) return undefined;

			let modelOverride: string | string[] | undefined;
			if (Array.isArray(data.modelOverride)) {
				if (!data.modelOverride.every(value => typeof value === "string")) return undefined;
				modelOverride = data.modelOverride as string[];
			} else if (typeof data.modelOverride === "string") {
				modelOverride = [data.modelOverride];
			} else if (data.modelOverride !== undefined) {
				return undefined;
			}

			const modelRole = typeof data.modelRole === "string" ? data.modelRole : undefined;
			const intent =
				typeof data.intent === "string" && VIBE_ROUTING_INTENTS.has(data.intent as VibeRoutingIntent)
					? (data.intent as VibeRoutingIntent)
					: undefined;

			let routing: VibeRoutingOptions | undefined;
			if (data.routing !== undefined) {
				const raw = objectRecord(data.routing);
				if (!raw) return undefined;
				routing = {};
				if (Array.isArray(raw.excludePools))
					routing.excludePools = raw.excludePools.filter((v): v is string => typeof v === "string");
				if (Array.isArray(raw.preferPools))
					routing.preferPools = raw.preferPools.filter((v): v is string => typeof v === "string");
				if (typeof raw.allowParentPool === "boolean") routing.allowParentPool = raw.allowParentPool;
				if (Array.isArray(raw.deadSelectors))
					routing.deadSelectors = raw.deadSelectors.filter((v): v is string => typeof v === "string");
			}

			let metadata: VibeExternalMetadata | undefined;
			if (data.metadata !== undefined) {
				const raw = objectRecord(data.metadata);
				if (!raw) return undefined;
				metadata = {};
				if (typeof raw.externalTaskId === "string") metadata.externalTaskId = raw.externalTaskId;
				if (typeof raw.specPath === "string") metadata.specPath = raw.specPath;
				if (typeof raw.policyHash === "string") metadata.policyHash = raw.policyHash;
				if (typeof raw.policyRevision === "string") metadata.policyRevision = raw.policyRevision;
				if (typeof raw.label === "string") metadata.label = raw.label;
			}

			return {
				...base,
				version: VIBE_LIFECYCLE_VERSION,
				action: "spawn",
				cli,
				role,
				agent: data.agent,
				childSessionFile: data.childSessionFile,
				createdAt: data.createdAt,
				modelOverride,
				modelRole,
				intent,
				routing,
				metadata,
			};
		}

		const cli = data.cli === "fast" || data.cli === "good" ? data.cli : undefined;
		if (!cli) return undefined;
		return {
			...base,
			version: VIBE_LIFECYCLE_LEGACY_VERSION,
			action: "spawn",
			cli,
			agent: data.agent,
			childSessionFile: data.childSessionFile,
			createdAt: data.createdAt,
		};
	}

	if (data.action === "turn-started" || data.action === "turn-settled") {
		if (typeof data.turn !== "number" || !Number.isInteger(data.turn) || data.turn < 1) return undefined;
		return { ...base, action: data.action, turn: data.turn };
	}
	if (data.action === "tombstone") {
		const reason = data.reason;
		if (
			reason !== "explicit-kill" &&
			reason !== "mode-exit" &&
			reason !== "spawn-failed" &&
			reason !== "unrecoverable"
		) {
			return undefined;
		}
		return { ...base, action: "tombstone", reason };
	}
	if (data.action === "tombstone-revoked" && data.reason === "mode-exit") {
		return { ...base, action: "tombstone-revoked", reason: "mode-exit" };
	}
	return undefined;
}

/** Child ids claimed by valid Vibe spawn records from untrusted persisted JSON. */
export function persistedVibeChildIds(entries: Iterable<unknown>): Set<string> {
	const ids = new Set<string>();
	for (const value of entries) {
		const entry = objectRecord(value);
		if (entry?.type !== "custom" || entry.customType !== VIBE_LIFECYCLE_CUSTOM_TYPE) continue;
		const event = parseLifecycleEvent(entry.data);
		if (
			event?.action === "spawn" &&
			/^[A-Za-z0-9_-]+$/.test(event.id) &&
			event.childSessionFile === `${event.id}.jsonl`
		) {
			ids.add(event.id);
		}
	}
	return ids;
}
