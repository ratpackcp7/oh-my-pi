import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActualSpendReport, UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "../usage";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const KEY_PATH = "/api/v1/key";
const CREDITS_PATH = "/api/v1/credits";
const ANALYTICS_PATH = "/api/v1/analytics/query";

/**
 * Locate the account Management Key. Inference keys only see their own spend
 * (`/api/v1/key` `usage_weekly` is per-credential); account-wide windows need
 * the management key against the Analytics API.
 */
function findManagementKey(): string | null {
	const fromEnv =
		typeof process !== "undefined" &&
		(process.env.OPENROUTER_MGMT_KEY ?? process.env.OPENROUTER_MANAGEMENT_KEY)?.trim();
	if (fromEnv) return fromEnv;
	const candidates = [
		path.join(os.homedir(), "projects", "dashboard", ".env.local"),
		path.join(os.homedir(), "projects", "cp7-hub", ".env.local"),
		path.join(os.homedir(), ".hermes", ".env"),
		path.join(os.homedir(), "cp7-bridge", ".env"),
	];
	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const match = fs.readFileSync(candidate, "utf8").match(/^OPENROUTER_MGMT_KEY=(.+)$/m);
			if (match) return match[1].trim().replace(/^"|"$/g, "");
		} catch {
			// unreadable candidate — keep scanning
		}
	}
	return null;
}

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Query the account-wide Analytics API for a rolling window. */
async function queryAnalyticsWindow(
	ctx: UsageFetchContext,
	mgmtKey: string,
	durationMs: number,
	signal?: AbortSignal,
): Promise<{ amountUsd: number; requests?: number; tokens?: number } | null> {
	try {
		const now = Date.now();
		const response = await ctx.fetch(`${OPENROUTER_ORIGIN}${ANALYTICS_PATH}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${mgmtKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				metrics: ["total_usage", "request_count", "tokens_total"],
				time_range: { start: new Date(now - durationMs).toISOString(), end: new Date(now).toISOString() },
			}),
			signal,
		});
		if (!response.ok) return null;
		const payload = await readJson(response);
		const row =
			isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.data) ? payload.data.data[0] : null;
		if (!isRecord(row)) return null;
		const amountUsd = finiteNonNegative(row.total_usage);
		if (amountUsd === undefined) return null;
		return {
			amountUsd,
			requests: finiteNonNegative(row.request_count),
			tokens: finiteNonNegative(row.tokens_total),
		};
	} catch {
		return null;
	}
}

/**
 * Account-wide spend windows from the Analytics API. Returns null when the
 * management key is missing or every window query fails.
 */
async function accountSpendWindows(
	ctx: UsageFetchContext,
	mgmtKey: string,
	signal?: AbortSignal,
): Promise<{
	windows: Array<{ id: string; label: string; amountUsd: number; scope: "account" }>;
	note?: string;
} | null> {
	const dayMs = 24 * 60 * 60 * 1000;
	const specs = [
		{ id: "1d", label: "1 day", durationMs: dayMs },
		{ id: "7d", label: "7 days", durationMs: 7 * dayMs },
		{ id: "monthly", label: "Monthly", durationMs: 30 * dayMs },
	] as const;
	const results = await Promise.all(specs.map(spec => queryAnalyticsWindow(ctx, mgmtKey, spec.durationMs, signal)));
	const windows = specs.flatMap((spec, i) => {
		const result = results[i];
		return result ? [{ id: spec.id, label: spec.label, amountUsd: result.amountUsd, scope: "account" as const }] : [];
	});
	if (windows.length === 0) return null;
	const week = results[1];
	const note =
		week?.requests !== undefined && week?.tokens !== undefined
			? `7d activity: ${Math.round(week.requests / 100) / 10}k requests · ${Math.round(week.tokens / 1e6)}M tokens`
			: undefined;
	return { windows, note };
}

/**
 * Discoverer indirection keeps tests deterministic on hosts where a real
 * management key exists in the environment or well-known config files.
 */
let managementKeyDiscoverer: () => string | null = findManagementKey;

/** Test-only: replace the management-key discovery strategy. */
export function setManagementKeyDiscovererForTests(discover: () => string | null): void {
	managementKeyDiscoverer = discover;
}

function originFor(baseUrl: string | undefined): string | null {
	if (!baseUrl?.trim()) return OPENROUTER_ORIGIN;
	try {
		const url = new URL(baseUrl);
		return url.origin === OPENROUTER_ORIGIN ? url.origin : null;
	} catch {
		return null;
	}
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function parseKeySpend(payload: unknown): { actualSpend: ActualSpendReport; isManagementKey: boolean } {
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
	const isManagementKey = data?.is_management_key === true;
	if (isManagementKey) {
		return {
			isManagementKey: true,
			actualSpend: {
				status: "partial",
				source: "openrouter-api",
				notes: ["Management key supplies account billing scope; inference-key spend is reported separately."],
			},
		};
	}
	const fields = [
		["1d", "1 day", data?.usage_daily],
		["7d", "7 days", data?.usage_weekly],
		["monthly", "Monthly", data?.usage_monthly],
	] as const;
	const windows = fields.flatMap(([id, label, raw]) => {
		const amountUsd = finiteNonNegative(raw);
		return amountUsd === undefined ? [] : [{ id, label, amountUsd, scope: "credential" as const }];
	});
	if (windows.length === 0) {
		return {
			isManagementKey: false,
			actualSpend: {
				status: "unavailable",
				source: "openrouter-api",
				notes: ["OpenRouter returned no valid authoritative spend-window values."],
			},
		};
	}
	return {
		isManagementKey: false,
		actualSpend: {
			status: "partial",
			source: "openrouter-api",
			windows,
			notes: ["Account credit balance and account-wide analytics require OPENROUTER_MANAGEMENT_KEY."],
		},
	};
}

function addCredits(actualSpend: ActualSpendReport, payload: unknown): ActualSpendReport {
	const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
	const totalCredits = finiteNonNegative(data?.total_credits);
	const totalUsage = finiteNonNegative(data?.total_usage);
	if (totalCredits === undefined || totalUsage === undefined) {
		return {
			...actualSpend,
			status: actualSpend.windows?.length ? "partial" : "unavailable",
			notes: [...(actualSpend.notes ?? []), "OpenRouter credit balance response was malformed or incomplete."],
		};
	}
	// Preserve analytics windows if present; only fill the account balance.
	if (actualSpend.windows?.length) {
		return { ...actualSpend, status: "available", balanceUsd: totalCredits - totalUsage, balanceScope: "account" };
	}
	return {
		...actualSpend,
		status: "available",
		windows: [{ id: "total", label: "Account total usage", amountUsd: totalUsage, scope: "account" }],
		balanceUsd: totalCredits - totalUsage,
		balanceScope: "account",
	};
}

export const openrouterUsageProvider: UsageProvider = {
	id: "openrouter",
	supports: params =>
		params.provider === "openrouter" &&
		params.credential.type === "api_key" &&
		Boolean(params.credential.apiKey) &&
		originFor(params.baseUrl) !== null,
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.credential.type !== "api_key" || !params.credential.apiKey) return null;
		const origin = originFor(params.baseUrl);
		if (!origin) return null;
		const headers = { Authorization: `Bearer ${params.credential.apiKey}` };
		let keyResponse: Response;
		try {
			keyResponse = await ctx.fetch(`${origin}${KEY_PATH}`, { headers, signal: params.signal });
		} catch (error) {
			ctx.logger?.warn("OpenRouter authoritative spend fetch failed", { error: String(error) });
			return null;
		}
		if (!keyResponse.ok) {
			ctx.logger?.warn("OpenRouter authoritative spend endpoint returned an error", { status: keyResponse.status });
			return null;
		}
		const keyPayload = await readJson(keyResponse);
		const parsed = parseKeySpend(keyPayload);
		let actualSpend = parsed.actualSpend;
		let creditsPayload: unknown;
		// Account-wide analytics need the Management Key: the credential's own
		// key endpoint only reports spend for that single inference credential.
		const mgmtKey = parsed.isManagementKey ? params.credential.apiKey : managementKeyDiscoverer();
		if (mgmtKey) {
			const account = await accountSpendWindows(ctx, mgmtKey, params.signal);
			if (account) {
				const credentialNote =
					!parsed.isManagementKey && actualSpend.windows?.length
						? `This credential's own spend: ${(actualSpend.windows.find(w => w.id === "7d")?.amountUsd ?? 0).toFixed(2)} 7d (inference key, not account-wide).`
						: undefined;
				actualSpend = {
					status: "available",
					source: "openrouter-analytics",
					windows: account.windows,
					notes: [
						"Account-wide spend via OpenRouter Analytics API (Management Key).",
						...(credentialNote ? [credentialNote] : []),
						...(account.note ? [account.note] : []),
					],
				};
			}
		}
		if (mgmtKey) {
			try {
				const creditsResponse = await ctx.fetch(`${OPENROUTER_ORIGIN}${CREDITS_PATH}`, {
					headers: { Authorization: `Bearer ${mgmtKey}` },
					signal: params.signal,
				});
				if (creditsResponse.ok) {
					creditsPayload = await readJson(creditsResponse);
					actualSpend = addCredits(actualSpend, creditsPayload);
				} else if (!actualSpend.windows?.length) {
					actualSpend = {
						...actualSpend,
						status: "unavailable",
						notes: [
							...(actualSpend.notes ?? []),
							`OpenRouter account credits were unavailable (HTTP ${creditsResponse.status}).`,
						],
					};
				}
			} catch (error) {
				if (!actualSpend.windows?.length) {
					actualSpend = {
						...actualSpend,
						status: "unavailable",
						notes: [...(actualSpend.notes ?? []), "OpenRouter account credits could not be fetched."],
					};
				}
				ctx.logger?.warn("OpenRouter credits fetch failed", { error: String(error) });
			}
		}
		return {
			provider: "openrouter",
			fetchedAt: Date.now(),
			limits: [],
			actualSpend,
			metadata: {
				source: actualSpend.source,
				scope:
					actualSpend.windows?.some(w => w.scope === "account") || actualSpend.balanceScope === "account"
						? "account"
						: "credential",
				credentialRole: parsed.isManagementKey ? "management" : "inference",
			},
			raw: creditsPayload === undefined ? { key: keyPayload } : { key: keyPayload, credits: creditsPayload },
		};
	},
};
