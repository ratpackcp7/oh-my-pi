import type { ActualSpendReport, UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "../usage";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const KEY_PATH = "/api/v1/key";
const CREDITS_PATH = "/api/v1/credits";

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
		if (parsed.isManagementKey) {
			try {
				const creditsResponse = await ctx.fetch(`${origin}${CREDITS_PATH}`, { headers, signal: params.signal });
				if (creditsResponse.ok) {
					creditsPayload = await readJson(creditsResponse);
					actualSpend = addCredits(actualSpend, creditsPayload);
				} else {
					actualSpend = {
						...actualSpend,
						status: actualSpend.windows?.length ? "partial" : "unavailable",
						notes: [
							...(actualSpend.notes ?? []),
							`OpenRouter account credits were unavailable (HTTP ${creditsResponse.status}).`,
						],
					};
				}
			} catch (error) {
				actualSpend = {
					...actualSpend,
					status: actualSpend.windows?.length ? "partial" : "unavailable",
					notes: [...(actualSpend.notes ?? []), "OpenRouter account credits could not be fetched."],
				};
				ctx.logger?.warn("OpenRouter credits fetch failed", { error: String(error) });
			}
		}
		return {
			provider: "openrouter",
			fetchedAt: Date.now(),
			limits: [],
			actualSpend,
			metadata: {
				source: "openrouter-authoritative-spend",
				scope: parsed.isManagementKey ? "account" : "credential",
				credentialRole: parsed.isManagementKey ? "management" : "inference",
			},
			raw: creditsPayload === undefined ? { key: keyPayload } : { key: keyPayload, credits: creditsPayload },
		};
	},
};
