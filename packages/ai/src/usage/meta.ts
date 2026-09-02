import type {
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { parseIsoTimestamp, usageStatus, WEEK_MS } from "./shared";

const META_API_ORIGIN = "https://api.meta.ai";
const MINUTE_MS = 60_000;

export const META_SUBSCRIPTION_WINDOW_LIMIT_ID = "meta:subscription:window";
export const META_SUBSCRIPTION_WEEKLY_LIMIT_ID = "meta:subscription:weekly";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readPercentUsed(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

function readPositiveMinutes(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

function normalizePercentAmount(usedPercent: number): UsageAmount {
	const usedFraction = Math.min(usedPercent / 100, 1);
	const remainingFraction = Math.max(0, 1 - usedFraction);
	return {
		used: usedPercent,
		usedFraction,
		remainingFraction,
		unit: "percent",
	};
}

function buildSubscriptionWindowLimit(window: Record<string, unknown>): UsageLimit | null {
	const usedPercent = readPercentUsed(window.used_percent);
	const durationMins = readPositiveMinutes(window.window_duration_mins);
	const resetsAt = parseIsoTimestamp(window.resets_at);
	if (usedPercent === undefined || durationMins === undefined || resetsAt === undefined) return null;
	const amount = normalizePercentAmount(usedPercent);
	const durationMs = durationMins * MINUTE_MS;
	return {
		id: META_SUBSCRIPTION_WINDOW_LIMIT_ID,
		label: "Meta Muse Subscription Window",
		scope: {
			provider: "meta",
			windowId: `rolling-${durationMins}m`,
			shared: true,
		},
		window: {
			id: `rolling-${durationMins}m`,
			label: `${durationMins} Minute Rolling Window`,
			durationMs,
			resetsAt,
		},
		amount,
		status: usageStatus(amount.usedFraction),
	};
}

function buildSubscriptionWeeklyLimit(weekly: Record<string, unknown>): UsageLimit | null {
	const usedPercent = readPercentUsed(weekly.used_percent);
	const resetsAt = parseIsoTimestamp(weekly.resets_at);
	if (usedPercent === undefined || resetsAt === undefined) return null;
	const amount = normalizePercentAmount(usedPercent);
	return {
		id: META_SUBSCRIPTION_WEEKLY_LIMIT_ID,
		label: "Meta Muse Weekly Subscription",
		scope: {
			provider: "meta",
			windowId: "weekly",
			shared: true,
		},
		window: {
			id: "weekly",
			label: "Weekly",
			resetsAt,
		},
		amount,
		status: usageStatus(amount.usedFraction),
	};
}

function supportsMetaPaygApi(params: UsageFetchParams): boolean {
	if (params.provider !== "meta" || params.credential.type !== "api_key" || !params.credential.apiKey) return false;
	if (!params.baseUrl?.trim()) return true;
	try {
		return new URL(params.baseUrl).origin === META_API_ORIGIN;
	} catch {
		return false;
	}
}

function supportsMetaUsage(params: UsageFetchParams): boolean {
	if (params.provider !== "meta") return false;
	if (params.credential.type === "oauth") return true;
	return supportsMetaPaygApi(params);
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
		actualSpend: {
			status: "unavailable",
			source: "meta-api",
			notes: ["Authoritative Meta/Muse billing spend is not exposed by the current usage source."],
		},
		metadata: {
			source: "ratelimit-headers",
			scope: "team",
		},
	};
}

/**
 * Parse a `response.subscription_usage` SSE payload into normalized subscription limits.
 * Returns null for malformed snapshots (fail closed).
 */
export function parseMetaSubscriptionUsage(event: unknown, now = Date.now()): UsageReport | null {
	if (!isRecord(event)) return null;
	const windowRaw = event.window;
	const weeklyRaw = event.weekly;
	if (!isRecord(windowRaw) || !isRecord(weeklyRaw)) return null;
	const windowLimit = buildSubscriptionWindowLimit(windowRaw);
	const weeklyLimit = buildSubscriptionWeeklyLimit(weeklyRaw);
	if (!windowLimit || !weeklyLimit) return null;
	return {
		provider: "meta",
		fetchedAt: now,
		limits: [windowLimit, weeklyLimit],
		actualSpend: {
			status: "unavailable",
			source: "meta-subscription",
			notes: ["Authoritative Meta/Muse billing spend is not exposed by the subscription usage event."],
		},
		metadata: {
			source: "subscription-usage",
			scope: "subscription",
		},
	};
}

export const metaUsageProvider: UsageProvider = {
	id: "meta",
	parseRateLimitHeaders: parseMetaRateLimitHeaders,
	parseSubscriptionUsageEvent: parseMetaSubscriptionUsage,
	fetchUsage: async () => null,
	supports: supportsMetaUsage,
	retainLastGoodOnFailure: false,
	headerReportTtlMs: MINUTE_MS,
	pollingDisabled: true,
};

export const metaRankingStrategy: CredentialRankingStrategy = {
	findWindowLimits(report) {
		const subscriptionWindow = report.limits.find(limit => limit.id === META_SUBSCRIPTION_WINDOW_LIMIT_ID);
		const subscriptionWeekly = report.limits.find(limit => limit.id === META_SUBSCRIPTION_WEEKLY_LIMIT_ID);
		if (subscriptionWindow || subscriptionWeekly) {
			return { primary: subscriptionWindow, secondary: subscriptionWeekly };
		}
		return {
			primary: report.limits.find(limit => limit.id === "meta:tokens:1m"),
			secondary: report.limits.find(limit => limit.id === "meta:requests:1m"),
		};
	},
	scopeLimits: report => {
		const subscription = report.limits.filter(
			limit => limit.id === META_SUBSCRIPTION_WINDOW_LIMIT_ID || limit.id === META_SUBSCRIPTION_WEEKLY_LIMIT_ID,
		);
		if (subscription.length > 0) return subscription;
		return report.limits.filter(limit => limit.scope.provider === "meta" && limit.scope.shared === true);
	},
	windowDefaults: {
		primaryMs: MINUTE_MS,
		secondaryMs: WEEK_MS,
	},
};
