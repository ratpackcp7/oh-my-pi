import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const SYNTHETIC_META_KEY_A = "synthetic-meta-api-key-alpha-7f3c";
const SYNTHETIC_META_KEY_B = "synthetic-meta-api-key-bravo-9d2e";
const TOKEN = "meta-usage-limit-bearer";

function rateLimitHeaders(tokensRemaining: number): Record<string, string> {
	return {
		"x-ratelimit-limit-tokens": "1000",
		"x-ratelimit-remaining-tokens": String(tokensRemaining),
		"x-ratelimit-limit-requests": "100",
		"x-ratelimit-remaining-requests": "80",
	};
}

function metaReport(tokensRemaining: number, fetchedAt = Date.now()): UsageReport {
	return {
		provider: "meta",
		fetchedAt,
		limits: [
			{
				id: "meta:tokens:1m",
				label: "Meta Token Rate Limit",
				scope: { provider: "meta", windowId: "1m", shared: true },
				window: { id: "1m", label: "Per Minute", durationMs: 60_000 },
				amount: {
					used: 1000 - tokensRemaining,
					limit: 1000,
					remaining: tokensRemaining,
					usedFraction: (1000 - tokensRemaining) / 1000,
					remainingFraction: tokensRemaining / 1000,
					unit: "tokens",
				},
				status: tokensRemaining <= 0 ? "exhausted" : tokensRemaining / 1000 <= 0.1 ? "warning" : "ok",
			},
		],
		metadata: { source: "ratelimit-headers", scope: "team" },
	};
}

describe("auth-broker Meta usage limit durability", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-meta-limit-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveApiKey("meta", SYNTHETIC_META_KEY_A);
		store.saveApiKey("meta", SYNTHETIC_META_KEY_B);
		storage = new AuthStorage(store);
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
	});

	test("client A ingest makes separate client B see Meta report via broker GET /v1/usage", async () => {
		const brokerClientA = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const remoteA = new RemoteAuthCredentialStore({
			client: brokerClientA,
			streamSnapshots: false,
		});
		await remoteA.refreshSnapshot();
		const credA = remoteA.listAuthCredentials("meta").find(entry => entry.credential.type === "api_key");
		expect(credA).toBeDefined();
		if (!credA || credA.credential.type !== "api_key") throw new Error("expected Meta API-key fixture");

		const storageA = new AuthStorage(remoteA);
		await storageA.reload();
		await storageA.getApiKey("meta", "session-a");
		const ingestSpy = vi.spyOn(brokerClientA, "ingestUsageLimitReport");
		expect(
			await storageA.ingestUsageHeaders("meta", rateLimitHeaders(800), { sessionId: "session-a" }),
		).toBe(true);
		expect(ingestSpy).toHaveBeenCalledTimes(1);
		const posted = ingestSpy.mock.calls[0]![0]!;
		expect(posted.credentialId).toBe(credA.id);
		expect(JSON.stringify(posted)).not.toContain(SYNTHETIC_META_KEY_A);
		expect(JSON.stringify(posted)).not.toContain(SYNTHETIC_META_KEY_B);
		remoteA.close();

		const brokerClientB = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const remoteB = new RemoteAuthCredentialStore({
			client: brokerClientB,
			streamSnapshots: false,
		});
		await remoteB.refreshSnapshot();
		const storageB = new AuthStorage(remoteB);
		await storageB.reload();
		const reports = await storageB.fetchUsageReports();
		expect(reports?.some(report => report.limits[0]?.amount.remainingFraction === 0.8)).toBe(true);
		const health = await storageB.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts.some(account => account.remainingFraction === 0.8)).toBe(true);
		remoteB.close();
		storageA.close();
		storageB.close();
	});

	test("rejects missing bearer, unknown credential id, provider mismatch, and raw payloads", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const credId = storage!.exportSnapshot().credentials[0]!.id;
		const report = metaReport(500);

		await expect(
			fetch(`${handle!.url}/v1/usage/limit-report`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credentialId: credId, report }),
			}),
		).resolves.toMatchObject({ status: 401 });

		await expect(
			client.ingestUsageLimitReport({ credentialId: 99_999, report }),
		).rejects.toBeInstanceOf(AuthBrokerError);

		await expect(
			client.ingestUsageLimitReport({
				credentialId: credId,
				report: { ...report, provider: "anthropic" },
			}),
		).rejects.toBeInstanceOf(AuthBrokerError);

		const rawResponse = await fetch(`${handle!.url}/v1/usage/limit-report`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ credentialId: credId, report: { ...report, raw: { secret: true } } }),
		});
		expect(rawResponse.status).toBe(400);
	});

	test("TTL expiry and credential isolation across two Meta API keys", async () => {
		let now = 1_900_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const brokerClientA = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const remoteA = new RemoteAuthCredentialStore({ client: brokerClientA, streamSnapshots: false });
		await remoteA.refreshSnapshot();
		const metaRows = remoteA.listAuthCredentials("meta");
		expect(metaRows).toHaveLength(2);

		const storageA = new AuthStorage(remoteA);
		await storageA.reload();
		const keyForSessionA = await storageA.getApiKey("meta", "session-a");
		const keyForSessionB = await storageA.getApiKey("meta", "session-b");
		expect(keyForSessionB).not.toBe(keyForSessionA);
		const credA = metaRows.find(
			entry => entry.credential.type === "api_key" && entry.credential.key === keyForSessionA,
		);
		const credB = metaRows.find(
			entry => entry.credential.type === "api_key" && entry.credential.key === keyForSessionB,
		);
		expect(credA).toBeDefined();
		expect(credB).toBeDefined();
		if (!credA || credA.credential.type !== "api_key") throw new Error("missing cred A");
		if (!credB || credB.credential.type !== "api_key") throw new Error("missing cred B");

		await storageA.ingestUsageHeaders("meta", rateLimitHeaders(200), { sessionId: "session-a" });
		await storageA.ingestUsageHeaders("meta", rateLimitHeaders(900), { sessionId: "session-b" });
		remoteA.close();

		const brokerClientB = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		const remoteB = new RemoteAuthCredentialStore({ client: brokerClientB, streamSnapshots: false });
		await remoteB.refreshSnapshot();
		const storageB = new AuthStorage(remoteB);
		await storageB.reload();
		let health = await storageB.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.accounts.find(account => account.credentialId === credA.id)?.remainingFraction).toBeCloseTo(0.2);
		expect(health.accounts.find(account => account.credentialId === credB.id)?.remainingFraction).toBeCloseTo(0.9);

		await clientReplaceReport(brokerClientB, credA.id, metaReport(750, now));
		health = await storageB.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.accounts.find(account => account.credentialId === credA.id)?.remainingFraction).toBeCloseTo(0.75);

		now += 60_001;
		health = await storageB.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.state).toBe("unknown");

		remoteB.close();
		storageA.close();
		storageB.close();
	});

	test("old broker 404 on limit-report does not break Meta header ingest", async () => {
		const brokerClient = new AuthBrokerClient({ url: handle!.url, token: TOKEN });
		vi.spyOn(brokerClient, "ingestUsageLimitReport").mockRejectedValue(
			new AuthBrokerError("missing", { status: 404 }),
		);
		const remote = new RemoteAuthCredentialStore({ client: brokerClient, streamSnapshots: false });
		await remote.refreshSnapshot();
		const storageClient = new AuthStorage(remote);
		await storageClient.reload();
		const selectedKey = await storageClient.getApiKey("meta", "session");
		expect(
			await storageClient.ingestUsageHeaders("meta", rateLimitHeaders(600), { sessionId: "session" }),
		).toBe(true);
		const peek = remote.peekCachedUsageReport("meta", {
			type: "api_key",
			key: selectedKey,
			source: "login",
		});
		expect(peek?.limits[0]?.amount.remainingFraction).toBeCloseTo(0.6);
		remote.close();
		storageClient.close();
	});
});

async function clientReplaceReport(client: AuthBrokerClient, credentialId: number, report: UsageReport): Promise<void> {
	const { raw: _raw, ...sanitized } = report;
	await client.ingestUsageLimitReport({ credentialId, report: sanitized });
}
