import type { ActualSpendReport, UsageReport } from "@oh-my-pi/pi-ai";

function providerName(provider: string): string {
	switch (provider) {
		case "openrouter":
			return "OpenRouter";
		case "meta":
			return "Muse/Meta";
		case "anthropic":
			return "Anthropic";
		case "openai-codex":
			return "OpenAI Codex";
		default:
			return provider;
	}
}

function usd(amount: number): string {
	const digits = Math.abs(amount) > 0 && Math.abs(amount) < 0.01 ? 4 : 2;
	return `$${amount.toFixed(digits)}`;
}

export function formatEstimatedTokenValue(value: number): string {
	return `Estimated token value (session-local): ${usd(value)} — if billed at configured token rates; not provider account spend.`;
}

function formatSpendReport(spend: ActualSpendReport, subscription: boolean): string[] {
	const parts: string[] = [];
	if (subscription) parts.push("included/subscription");
	if (spend.windows?.length) {
		parts.push(spend.windows.map(window => `${window.id} ${usd(window.amountUsd)}`).join(" · "));
	}
	if (spend.balanceUsd !== undefined) {
		parts.push(`${spend.balanceScope === "account" ? "account " : ""}balance ${usd(spend.balanceUsd)}`);
	}
	if (!spend.windows?.length && spend.balanceUsd === undefined && spend.status === "unavailable") {
		parts.push("actual spend unavailable");
	}
	return parts;
}

/**
 * Render provider-authoritative money without combining credential, account,
 * subscription, or session-local scopes into a synthetic grand total.
 */
export function formatActualSpendSection(reports: UsageReport[]): string {
	const relevant = reports.filter(report => report.actualSpend || report.metadata?.source === "subscription-usage");
	if (relevant.length === 0) return "";

	const grouped = new Map<string, UsageReport[]>();
	for (const report of relevant) {
		const rows = grouped.get(report.provider) ?? [];
		rows.push(report);
		grouped.set(report.provider, rows);
	}

	const lines = ["Actual spend — authoritative provider data"];
	for (const [provider, providerReports] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`${providerName(provider)}:`);
		let keyIndex = 0;
		providerReports.forEach((report, index) => {
			const spend = report.actualSpend;
			const subscription = report.metadata?.source === "subscription-usage";
			const credentialRole = report.metadata?.credentialRole;
			const hasCredentialSpend = spend?.windows?.some(window => window.scope === "credential") ?? false;
			if (credentialRole === "inference" || (credentialRole !== "management" && hasCredentialSpend)) keyIndex += 1;
			const prefix =
				providerReports.length <= 1
					? "  "
					: credentialRole === "management" || (spend?.balanceUsd !== undefined && !spend.windows?.length)
						? "  account: "
						: credentialRole === "inference" || spend?.windows?.length
							? `  key ${keyIndex}: `
							: `  credential ${index + 1}: `;
			if (!spend) {
				lines.push(`${prefix}${subscription ? "included/subscription · " : ""}actual spend unavailable`);
				return;
			}
			const parts = formatSpendReport(spend, subscription);
			lines.push(`${prefix}${parts.join(" · ") || "actual spend unavailable"}`);
			for (const note of spend.notes ?? []) lines.push(`    ${note}`);
		});
	}
	return lines.join("\n");
}
