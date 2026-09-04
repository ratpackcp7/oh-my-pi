import * as fs from "node:fs";
import * as AIError from "./error";
import type { Model } from "./types";

/** Host-owned policy file for Chris's local agent stack; not derived from HOME. */
export const CANONICAL_OPENROUTER_ALLOWLIST_PATH = "/home/chris/.config/cp7/openrouter-allowlist.json";

const OPENROUTER_PREFIX = "openrouter/";

export function formatOpenRouterSelector(provider: string, modelId: string): string {
	if (modelId.startsWith(`${provider}/`)) return modelId;
	return `${provider}/${modelId}`;
}

export function isValidApprovedOpenRouterSelector(entry: string): boolean {
	if (entry.length === 0) return false;
	if (entry !== entry.trim()) return false;
	if (!entry.startsWith(OPENROUTER_PREFIX)) return false;
	if (entry.length <= OPENROUTER_PREFIX.length) return false;
	return true;
}

/**
 * Parse schema v1 policy. Returns an empty set for valid deny-all (`approved_models: []`).
 * Returns null when the policy is malformed (callers treat that as deny-all).
 */
export function parseOpenRouterAllowlistPolicy(raw: string): Set<string> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as { schema_version?: unknown; approved_models?: unknown };
	if (record.schema_version !== 1) return null;
	if (!Array.isArray(record.approved_models)) return null;

	const approved = new Set<string>();
	for (const entry of record.approved_models) {
		if (!isValidApprovedOpenRouterSelector(entry)) return null;
		if (approved.has(entry)) return null;
		approved.add(entry);
	}
	return approved;
}

function resolvePolicyPathForEnforcement(): string {
	if (process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE === "1" && process.env.OMP_OPENROUTER_ALLOWLIST_PATH) {
		return process.env.OMP_OPENROUTER_ALLOWLIST_PATH;
	}
	return CANONICAL_OPENROUTER_ALLOWLIST_PATH;
}

export function loadApprovedOpenRouterSelectors(policyPath = resolvePolicyPathForEnforcement()): Set<string> {
	let raw: string;
	try {
		raw = fs.readFileSync(policyPath, "utf8");
	} catch {
		return new Set();
	}
	return parseOpenRouterAllowlistPolicy(raw) ?? new Set();
}

export function assertOpenRouterSelectorAllowlisted(selector: string, approved: Set<string>, policyPath: string): void {
	if (!approved.has(selector)) {
		throw new AIError.ConfigurationError(
			`OpenRouter model ${selector} is not on the user allowlist at ${policyPath}. ` +
				"Add the exact selector to approved_models or choose a non-OpenRouter provider.",
		);
	}
}

/**
 * Fail closed for `openrouter/*` selectors before credential lookup or network
 * dispatch. Non-OpenRouter providers are unaffected.
 */
export function assertOpenRouterAllowlisted(
	model: Pick<Model<never>, "provider" | "id"> & { requestModelId?: string },
): void {
	if (model.provider !== "openrouter") return;

	const policyPath = resolvePolicyPathForEnforcement();
	const approved = loadApprovedOpenRouterSelectors(policyPath);
	const selector = formatOpenRouterSelector(model.provider, model.id);
	assertOpenRouterSelectorAllowlisted(selector, approved, policyPath);

	if (model.requestModelId) {
		const requestSelector = formatOpenRouterSelector(model.provider, model.requestModelId);
		assertOpenRouterSelectorAllowlisted(requestSelector, approved, policyPath);
	}
}
