import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "./error";
import type { Model } from "./types";

export const DEFAULT_OPENROUTER_ALLOWLIST_PATH = path.join(os.homedir(), ".config", "cp7", "openrouter-allowlist.json");

let policyPathOverride: string | undefined;
let approvedSelectorsOverride: Set<string> | undefined;

export const __openRouterAllowlistForTesting = {
	setPolicyPath(policyPath: string | undefined): void {
		policyPathOverride = policyPath;
		approvedSelectorsOverride = undefined;
	},
	setApprovedSelectors(selectors: string[] | Set<string> | undefined): void {
		approvedSelectorsOverride = selectors ? new Set(selectors) : undefined;
	},
	reset(): void {
		policyPathOverride = undefined;
		approvedSelectorsOverride = undefined;
	},
};

function resolvePolicyPath(): string {
	return policyPathOverride ?? DEFAULT_OPENROUTER_ALLOWLIST_PATH;
}

export function formatOpenRouterSelector(provider: string, modelId: string): string {
	if (modelId.startsWith(`${provider}/`)) return modelId;
	return `${provider}/${modelId}`;
}

function loadApprovedOpenRouterSelectors(): Set<string> {
	if (approvedSelectorsOverride !== undefined) {
		return approvedSelectorsOverride;
	}
	const policyPath = resolvePolicyPath();
	let raw: string;
	try {
		raw = fs.readFileSync(policyPath, "utf8");
	} catch {
		return new Set();
	}

	try {
		const parsed = JSON.parse(raw) as { schema_version?: unknown; approved_models?: unknown };
		if (typeof parsed !== "object" || parsed === null) return new Set();
		if (parsed.schema_version !== 1) return new Set();
		if (!Array.isArray(parsed.approved_models)) return new Set();
		if (!parsed.approved_models.every(entry => typeof entry === "string")) return new Set();
		return new Set<string>(parsed.approved_models);
	} catch {
		return new Set();
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

	const selector = formatOpenRouterSelector(model.provider, model.id);
	const approved = loadApprovedOpenRouterSelectors();
	if (!approved.has(selector)) {
		throw new AIError.ConfigurationError(
			`OpenRouter model ${selector} is not on the user allowlist at ${resolvePolicyPath()}. ` +
				"Add the exact selector to approved_models or choose a non-OpenRouter provider.",
		);
	}

	if (model.requestModelId) {
		const requestSelector = formatOpenRouterSelector(model.provider, model.requestModelId);
		if (!approved.has(requestSelector)) {
			throw new AIError.ConfigurationError(
				`OpenRouter model ${requestSelector} is not on the user allowlist at ${resolvePolicyPath()}. ` +
					"Add the exact selector to approved_models or choose a non-OpenRouter provider.",
			);
		}
	}
}
