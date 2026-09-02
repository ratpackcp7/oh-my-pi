import { describe, expect, test } from "bun:test";
import { openrouterUsageProvider } from "../src/usage/openrouter";

const credential = { type: "api_key" as const, apiKey: "sk-or-test-secret" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenRouter authoritative spend", () => {
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

	test("management key reports account credits/balance separately from inference-key spend", async () => {
		const requests: string[] = [];
		const fetch = async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/api/v1/key")) return jsonResponse({ data: { is_management_key: true } });
			if (url.endsWith("/api/v1/credits")) {
				return jsonResponse({ data: { total_credits: 20, total_usage: 7.25 } });
			}
			throw new Error(`unexpected ${url}`);
		};

		const report = await openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential },
			{ fetch: fetch as unknown as typeof globalThis.fetch },
		);

		expect(requests).toEqual(["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/credits"]);
		expect(report?.actualSpend?.status).toBe("available");
		expect(report?.actualSpend?.windows).toEqual([
			{ id: "total", label: "Account total usage", amountUsd: 7.25, scope: "account" },
		]);
		expect(report?.actualSpend?.balanceUsd).toBe(12.75);
		expect(report?.actualSpend?.balanceScope).toBe("account");
		expect(report?.metadata?.scope).toBe("account");
		expect(report?.metadata?.credentialRole).toBe("management");
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
