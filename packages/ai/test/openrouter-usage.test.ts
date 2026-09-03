import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openrouterUsageProvider, setManagementKeyDiscovererForTests } from "../src/usage/openrouter";

const credential = { type: "api_key" as const, apiKey: "sk-or-test-secret" };
const MGMT = "sk-or-mgmt-test";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function analyticsRow(totalUsage: number, requests = 0, tokens = 0): unknown {
	return { data: { data: [{ total_usage: totalUsage, request_count: requests, tokens_total: tokens }] } };
}

const priorEnv = { ...process.env };

describe("OpenRouter authoritative spend", () => {
	beforeEach(() => {
		delete process.env.OPENROUTER_MGMT_KEY;
		delete process.env.OPENROUTER_MANAGEMENT_KEY;
		setManagementKeyDiscovererForTests(() => null);
	});

	afterEach(() => {
		process.env.OPENROUTER_MGMT_KEY = priorEnv.OPENROUTER_MGMT_KEY;
		process.env.OPENROUTER_MANAGEMENT_KEY = priorEnv.OPENROUTER_MANAGEMENT_KEY;
		setManagementKeyDiscovererForTests(() => null);
	});

	test("parses inference-key daily/weekly/monthly spend without pretending it is account-wide", async () => {
		const requests: string[] = [];
		const fetch = async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/api/v1/key")) {
				return jsonResponse({
					data: { usage_daily: 0.12, usage_weekly: 0.84, usage_monthly: 2.91, is_management_key: false },
				});
			}
			throw new Error(`unexpected ${url}`);
		};

		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{ fetch: fetch as unknown as typeof globalThis.fetch },
		);

		expect(requests).toEqual(["https://openrouter.ai/api/v1/key"]);
		expect(report?.actualSpend).toEqual({
			status: "partial",
			source: "openrouter-api",
			windows: [
				{ id: "1d", label: "1 day", amountUsd: 0.12, scope: "credential" },
				{ id: "7d", label: "7 days", amountUsd: 0.84, scope: "credential" },
				{ id: "monthly", label: "Monthly", amountUsd: 2.91, scope: "credential" },
			],
			notes: ["Account credit balance and account-wide analytics require OPENROUTER_MANAGEMENT_KEY."],
		});
		expect(report?.metadata?.scope).toBe("credential");
		expect(report?.metadata?.credentialRole).toBe("inference");
	});

	test("discovered management key upgrades inference-key report to account-wide analytics", async () => {
		setManagementKeyDiscovererForTests(() => MGMT);
		const requests: string[] = [];
		const fetch = async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/api/v1/key")) {
				return jsonResponse({ data: { usage_weekly: 2.91, is_management_key: false } });
			}
			if (url.endsWith("/api/v1/analytics/query")) {
				return jsonResponse(analyticsRow(1.58, 4303, 273_451_203));
			}
			if (url.endsWith("/api/v1/credits")) {
				return jsonResponse({ data: { total_credits: 65, total_usage: 58.63 } });
			}
			throw new Error(`unexpected ${url}`);
		};

		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{ fetch: fetch as unknown as typeof globalThis.fetch },
		);

		expect(requests.some(url => url.endsWith("/api/v1/analytics/query"))).toBe(true);
		const spend = report?.actualSpend;
		expect(spend?.status).toBe("available");
		expect(spend?.source).toBe("openrouter-analytics");
		expect(spend?.windows).toEqual([
			{ id: "1d", label: "1 day", amountUsd: 1.58, scope: "account" },
			{ id: "7d", label: "7 days", amountUsd: 1.58, scope: "account" },
			{ id: "monthly", label: "Monthly", amountUsd: 1.58, scope: "account" },
		]);
		expect(spend?.balanceUsd).toBeCloseTo(6.37, 5);
		expect(spend?.balanceScope).toBe("account");
		expect(spend?.notes?.some(note => note.includes("not account-wide"))).toBe(true);
		expect(spend?.notes?.some(note => note.includes("4.3k requests"))).toBe(true);
		expect(report?.metadata?.scope).toBe("account");
		expect(JSON.stringify(report)).not.toContain(MGMT);
		expect(JSON.stringify(report)).not.toContain(credential.apiKey);
	});

	test("management-key credential reports analytics windows plus credits balance", async () => {
		const mgmtCredential = { type: "api_key" as const, apiKey: MGMT };
		const fetch = async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/api/v1/key")) return jsonResponse({ data: { is_management_key: true } });
			if (url.endsWith("/api/v1/analytics/query")) return jsonResponse(analyticsRow(7.02));
			if (url.endsWith("/api/v1/credits")) {
				return jsonResponse({ data: { total_credits: 20, total_usage: 7.25 } });
			}
			throw new Error(`unexpected ${url}`);
		};

		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential: mgmtCredential },
			{ fetch: fetch as unknown as typeof globalThis.fetch },
		);

		const spend = report?.actualSpend;
		expect(spend?.status).toBe("available");
		expect(spend?.windows).toEqual([
			{ id: "1d", label: "1 day", amountUsd: 7.02, scope: "account" },
			{ id: "7d", label: "7 days", amountUsd: 7.02, scope: "account" },
			{ id: "monthly", label: "Monthly", amountUsd: 7.02, scope: "account" },
		]);
		expect(spend?.balanceUsd).toBe(12.75);
		expect(report?.metadata?.credentialRole).toBe("management");
	});

	test("analytics failure falls back to credential-scope spend without inventing account data", async () => {
		setManagementKeyDiscovererForTests(() => MGMT);
		const fetch = async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/api/v1/key")) {
				return jsonResponse({ data: { usage_weekly: 0.84, is_management_key: false } });
			}
			return jsonResponse({ error: "forbidden" }, 403);
		};

		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{ fetch: fetch as unknown as typeof globalThis.fetch },
		);

		const spend = report?.actualSpend;
		expect(spend?.windows?.every(window => window.scope === "credential")).toBe(true);
		expect(spend?.windows?.find(window => window.id === "7d")?.amountUsd).toBe(0.84);
		expect(spend?.balanceUsd).toBeUndefined();
	});

	test("classifies only official OpenRouter API-key credentials as supported", () => {
		expect(openrouterUsageProvider.supports?.({ provider: "openrouter", credential })).toBe(true);
		expect(
			openrouterUsageProvider.supports?.({
				provider: "openrouter",
				credential,
				baseUrl: "https://openrouter.ai/api/v1/cursor",
			}),
		).toBe(true);
		expect(openrouterUsageProvider.supports?.({ provider: "openrouter", credential: { type: "api_key" } })).toBe(
			false,
		);
		expect(
			openrouterUsageProvider.supports?.({
				provider: "openrouter",
				credential: { type: "oauth", accessToken: "oauth" },
			}),
		).toBe(false);
		expect(
			openrouterUsageProvider.supports?.({
				provider: "openrouter",
				credential,
				baseUrl: "https://example.com/v1",
			}),
		).toBe(false);
	});

	test("malformed or failed authoritative data stays unknown rather than becoming $0", async () => {
		const malformed = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{
				fetch: (async () =>
					jsonResponse({
						data: { usage_daily: "oops", is_management_key: false },
					})) as unknown as typeof globalThis.fetch,
			},
		);
		expect(malformed?.actualSpend?.status).toBe("unavailable");
		expect(malformed?.actualSpend?.windows).toBeUndefined();
		expect(malformed?.actualSpend?.balanceUsd).toBeUndefined();

		const failed = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{ fetch: (async () => jsonResponse({ error: "nope" }, 503)) as unknown as typeof globalThis.fetch },
		);
		expect(failed).toBeNull();
	});

	test("management-key credits failure does not become a zero balance", async () => {
		const fetch = async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/api/v1/key")) return jsonResponse({ data: { is_management_key: true } });
			return jsonResponse({ error: "forbidden" }, 403);
		};
		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{ fetch: fetch as unknown as typeof globalThis.fetch },
		);
		expect(report?.actualSpend?.status).toBe("unavailable");
		expect(report?.actualSpend?.balanceUsd).toBeUndefined();
	});

	test("never includes the credential secret in report metadata, notes, or raw data", async () => {
		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{
				fetch: (async () =>
					jsonResponse({
						data: { usage_daily: 0.1, is_management_key: false },
					})) as unknown as typeof globalThis.fetch,
			},
		);
		expect(JSON.stringify(report)).not.toContain(credential.apiKey);
	});
});
