import { describe, expect, test } from "bun:test";
import {
	evaluateHostMemoryPressure,
	getHostMemoryPressure,
	isMemoryIntensiveCommand,
	parseLinuxMeminfo,
} from "@oh-my-pi/pi-coding-agent/utils/host-memory-pressure";

const meminfo = (values: {
	memTotalKiB: number;
	memAvailableKiB: number;
	swapTotalKiB: number;
	swapFreeKiB: number;
}): string => `MemTotal:       ${values.memTotalKiB} kB
MemAvailable:   ${values.memAvailableKiB} kB
SwapTotal:      ${values.swapTotalKiB} kB
SwapFree:       ${values.swapFreeKiB} kB
`;

describe("host memory pressure guard", () => {
	test("blocks the incident pattern before another heavy checker starts", () => {
		const snapshot = parseLinuxMeminfo(
			meminfo({ memTotalKiB: 15_500_000, memAvailableKiB: 6_045_000, swapTotalKiB: 8_388_608, swapFreeKiB: 83_886 }),
		);
		expect(snapshot).toBeDefined();
		const pressure = evaluateHostMemoryPressure(snapshot!);
		expect(pressure.blocked).toBe(true);
		expect(pressure.reason).toContain("39% RAM available");
		expect(pressure.reason).toContain("1% swap free");
	});

	test("does not block the recovered state merely because old pages remain swapped out", () => {
		const snapshot = parseLinuxMeminfo(
			meminfo({
				memTotalKiB: 15_500_000,
				memAvailableKiB: 8_525_000,
				swapTotalKiB: 8_388_608,
				swapFreeKiB: 475_000,
			}),
		);
		expect(snapshot).toBeDefined();
		const pressure = evaluateHostMemoryPressure(snapshot!);
		expect(pressure.blocked).toBe(false);
		expect(pressure.memAvailableFraction).toBeGreaterThan(0.5);
	});

	test("blocks critically low RAM even when no swap is configured", () => {
		const snapshot = parseLinuxMeminfo(
			meminfo({ memTotalKiB: 10_000_000, memAvailableKiB: 900_000, swapTotalKiB: 0, swapFreeKiB: 0 }),
		);
		expect(snapshot).toBeDefined();
		expect(evaluateHostMemoryPressure(snapshot!).blocked).toBe(true);
	});

	test("fails open when live host memory cannot be read", async () => {
		const pressure = await getHostMemoryPressure({
			platform: "linux",
			readMeminfo: async () => {
				throw new Error("proc unavailable");
			},
		});
		expect(pressure).toBeUndefined();
	});

	test("recognizes commands that can fan out into the observed compiler workload", () => {
		expect(isMemoryIntensiveCommand("npm run typecheck")).toBe(true);
		expect(isMemoryIntensiveCommand("bun check")).toBe(true);
		expect(isMemoryIntensiveCommand("npx tsc --noEmit")).toBe(true);
		expect(isMemoryIntensiveCommand("biome check .")).toBe(true);
		expect(isMemoryIntensiveCommand("/repo/node_modules/.bin/tsgo -p tsconfig.json --noEmit")).toBe(true);
		expect(isMemoryIntensiveCommand("/usr/local/bin/bun run check")).toBe(true);
		expect(isMemoryIntensiveCommand("git status --short")).toBe(false);
	});
});
