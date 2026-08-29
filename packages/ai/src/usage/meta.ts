import type {
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { usageStatus } from "./shared";

const META_API_ORIGIN = "https://api.meta.ai";
const MINUTE_MS = 60_000;

function parseNonNegativeHeader(headers: Record<string, string>, name: string): number | undefined {
	const raw = headers[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function buildRateLimit(headers: Record<string, string>, kind: "tokens" | "requests"): UsageLimit | null {
	const limit = parseNonNegativeHeader(headers, `x-ratelimit-limit-${kind}`);
	const reportedRemaining = parseNonNegativeHeader(headers, `x-ratelimit-remaining-${kind}`);
	if (limit === undefined || limit <= 0 || reportedRemaining === undefined) return null;

	const remaining = Math.min(reportedRemaining, limit);
	const used = Math.max(0, limit - remaining);
	const remainingFraction = remaining / limit;
	const usedFraction = 1 - remainingFraction;
	const amount: UsageAmount = {
		used,
		limit,
		remaining,
		usedFraction,
		remainingFraction,
		unit: kind,
	};
	const noun = kind === "tokens" ? "Token" : "Request";
	return {
		id: `meta:${kind}:1m`,
		label: `Meta ${noun} Rate Limit`,
		scope: {
			provider: "meta",
			windowId: "1m",
			shared: true,
		},
		window: {
			id: "1m",
			label: "Per Minute",
			durationMs: MINUTE_MS,
		},
		amount,
		status: usageStatus(usedFraction),
	};
}

function supportsMetaApi(params: UsageFetchParams): boolean {
	if (params.provider !== "meta" || params.credential.type !== "api_key" || !params.credential.apiKey) return false;
	if (!params.baseUrl?.trim()) return true;
	try {
		return new URL(params.baseUrl).origin === META_API_ORIGIN;
	} catch {
		return false;
	}
}

/** Parse Meta Model API's provider-authoritative, per-team RPM/TPM response headers. */
export function parseMetaRateLimitHeaders(headers: Record<string, string>, now = Date.now()): UsageReport | null {
	const limits = [buildRateLimit(headers, "tokens"), buildRateLimit(headers, "requests")].filter(
		(limit): limit is UsageLimit => limit !== null,
	);
	if (limits.length === 0) return null;
	return {
		provider: "meta",
		fetchedAt: now,
		limits,
		metadata: {
			source: "ratelimit-headers",
			scope: "team",
		},
	};
}

export const metaUsageProvider: UsageProvider = {
	id: "meta",
	parseRateLimitHeaders: parseMetaRateLimitHeaders,
	fetchUsage: async () => null,
	supports: supportsMetaApi,
	retainLastGoodOnFailure: false,
	headerReportTtlMs: MINUTE_MS,
	pollingDisabled: true,
};

export const metaRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		return {
			primary: report.limits.find(limit => limit.id === "meta:tokens:1m"),
			secondary: report.limits.find(limit => limit.id === "meta:requests:1m"),
		};
	},
	scopeLimits: report => report.limits.filter(limit => limit.scope.provider === "meta" && limit.scope.shared === true),
	windowDefaults: {
		primaryMs: MINUTE_MS,
		secondaryMs: MINUTE_MS,
	},
};
