import { describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { formatActualSpendSection, formatEstimatedTokenValue } from "../src/cli/usage-cli";

const inferenceKeyReport: UsageReport = {
	provider: "openrouter",
	fetchedAt: 1,
	limits: [],
	metadata: { credentialRole: "inference" },
	actualSpend: {
		status: "partial",
		source: "openrouter-api",
		windows: [
			{ id: "1d", label: "1 day", amountUsd: 0.12, scope: "credential" },
			{ id: "7d", label: "7 days", amountUsd: 0.84, scope: "credential" },
			{ id: "monthly", label: "Monthly", amountUsd: 2.91, scope: "credential" },
		],
	},
};

const accountReport: UsageReport = {
	provider: "openrouter",
	fetchedAt: 1,
	limits: [],
	metadata: { credentialRole: "management" },
	actualSpend: {
		status: "available",
		source: "openrouter-api",
		windows: [{ id: "total", label: "Account total usage", amountUsd: 7.25, scope: "account" }],
		balanceUsd: 12.75,
		balanceScope: "account",
	},
};

describe("actual spend presentation", () => {
	test("keeps estimated session value separate from authoritative provider spend", () => {
		const actual = formatActualSpendSection([accountReport, inferenceKeyReport]);
		const estimated = formatEstimatedTokenValue(3.49);
		expect(actual).toContain("Actual spend");
		expect(actual).toContain("authoritative provider data");
		expect(actual).toContain("key 1: 1d $0.12 · 7d $0.84 · monthly $2.91");
		expect(actual).toContain("account: total $7.25 · account balance $12.75");
		expect(estimated).toContain("Estimated token value (session-local): $3.49");
		expect(estimated).toContain("if billed at configured token rates");
		expect(actual).not.toContain("$3.49");
	});

	test("Meta/Muse subscription data is included/subscription and actual dollars remain unavailable", () => {
		const meta: UsageReport = {
			provider: "meta",
			fetchedAt: 1,
			limits: [],
			metadata: { source: "subscription-usage" },
			actualSpend: {
				status: "unavailable",
				source: "meta-subscription",
				notes: ["No authoritative billing spend endpoint available."],
			},
		};
		const text = formatActualSpendSection([meta]);
		expect(text).toContain("included/subscription");
		expect(text).toContain("actual spend unavailable");
		expect(text).not.toContain("$0.00");
	});

	test("authoritative zero spend is shown as zero instead of unavailable", () => {
		const report: UsageReport = {
			provider: "openrouter",
			fetchedAt: 1,
			limits: [],
			actualSpend: {
				status: "partial",
				source: "openrouter-api",
				windows: [{ id: "1d", label: "1 day", amountUsd: 0, scope: "credential" }],
			},
		};
		const text = formatActualSpendSection([report]);
		expect(text).toContain("1d $0.00");
		expect(text).not.toContain("actual spend unavailable");
	});
});
