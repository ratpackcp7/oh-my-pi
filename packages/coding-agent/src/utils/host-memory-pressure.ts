const KIB = 1024;
const SEVERE_MEMORY_AVAILABLE_FRACTION = 0.1;
const LOW_SWAP_FREE_FRACTION = 0.05;
const SWAP_PRESSURE_MEMORY_AVAILABLE_FRACTION = 0.45;

export interface HostMemorySnapshot {
	memTotalBytes: number;
	memAvailableBytes: number;
	swapTotalBytes: number;
	swapFreeBytes: number;
}

export interface HostMemoryPressure {
	blocked: boolean;
	memAvailableFraction: number;
	swapFreeFraction: number;
	reason?: string;
}

/** Parse the Linux /proc/meminfo fields used by the heavy-work guard. */
export function parseLinuxMeminfo(text: string): HostMemorySnapshot | undefined {
	const values = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/u.exec(line.trim());
		if (!match) continue;
		values.set(match[1], Number(match[2]) * KIB);
	}
	const memTotalBytes = values.get("MemTotal");
	const memAvailableBytes = values.get("MemAvailable");
	const swapTotalBytes = values.get("SwapTotal");
	const swapFreeBytes = values.get("SwapFree");
	if (
		memTotalBytes === undefined ||
		memAvailableBytes === undefined ||
		swapTotalBytes === undefined ||
		swapFreeBytes === undefined ||
		memTotalBytes <= 0
	) {
		return undefined;
	}
	return { memTotalBytes, memAvailableBytes, swapTotalBytes, swapFreeBytes };
}

/**
 * Decide whether starting another memory-intensive checker is unsafe.
 *
 * Two incident-derived conditions block new heavy work:
 * - <=10% RAM available, even without swap; or
 * - <=5% swap free while RAM availability has also fallen to <=45%.
 *
 * High swap occupancy alone deliberately does not block work after recovery;
 * Linux may leave cold pages swapped out while plenty of RAM is available.
 */
export function evaluateHostMemoryPressure(snapshot: HostMemorySnapshot): HostMemoryPressure {
	const memAvailableFraction = Math.max(0, Math.min(1, snapshot.memAvailableBytes / snapshot.memTotalBytes));
	const swapFreeFraction =
		snapshot.swapTotalBytes > 0 ? Math.max(0, Math.min(1, snapshot.swapFreeBytes / snapshot.swapTotalBytes)) : 1;
	const severeMemoryPressure = memAvailableFraction <= SEVERE_MEMORY_AVAILABLE_FRACTION;
	const exhaustedSwapPressure =
		snapshot.swapTotalBytes > 0 &&
		swapFreeFraction <= LOW_SWAP_FREE_FRACTION &&
		memAvailableFraction <= SWAP_PRESSURE_MEMORY_AVAILABLE_FRACTION;
	const blocked = severeMemoryPressure || exhaustedSwapPressure;
	return {
		blocked,
		memAvailableFraction,
		swapFreeFraction,
		...(blocked
			? {
					reason: `host memory pressure: ${Math.round(memAvailableFraction * 100)}% RAM available, ${Math.round(
						swapFreeFraction * 100,
					)}% swap free`,
				}
			: {}),
	};
}

/** Read the live Linux host state. Unsupported/unreadable platforms fail open. */
export async function getHostMemoryPressure(options?: {
	platform?: NodeJS.Platform;
	readMeminfo?: () => Promise<string>;
}): Promise<HostMemoryPressure | undefined> {
	if (process.env.OMP_HOST_MEMORY_GUARD === "0") return undefined;
	const platform = options?.platform ?? process.platform;
	if (platform !== "linux") return undefined;
	try {
		const text = options?.readMeminfo ? await options.readMeminfo() : await Bun.file("/proc/meminfo").text();
		const snapshot = parseLinuxMeminfo(text);
		return snapshot ? evaluateHostMemoryPressure(snapshot) : undefined;
	} catch {
		return undefined;
	}
}

/** Commands likely to fan out into large compiler/linter/test processes. */
export function isMemoryIntensiveCommand(command: string): boolean {
	const normalized = command.toLowerCase();
	return (
		/(^|[\s;&|()])(?:[^\s;&|()]*\/)?(?:tsgo|tsc|vue-tsc|biome|pyright|basedpyright)(?=$|[\s;&|()])/u.test(
			normalized,
		) ||
		/(^|[\s;&|()])(?:[^\s;&|()]*\/)?(?:npx|bunx)\s+(?:--yes\s+)?(?:tsc|tsgo|vue-tsc|biome|pyright|basedpyright)(?=$|\s)/u.test(
			normalized,
		) ||
		/(^|[\s;&|()])(?:[^\s;&|()]*\/)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|check|build|test)(?=$|[\s;&|()])/u.test(
			normalized,
		) ||
		/(^|[\s;&|()])(?:[^\s;&|()]*\/)?cargo\s+(?:check|clippy|test)(?=$|[\s;&|()])/u.test(normalized) ||
		/(^|[\s;&|()])(?:[^\s;&|()]*\/)?go\s+(?:build|test)(?=$|[\s;&|()])/u.test(normalized)
	);
}

export async function memoryIntensiveCommandBlockReason(command: string): Promise<string | undefined> {
	if (!isMemoryIntensiveCommand(command)) return undefined;
	const pressure = await getHostMemoryPressure();
	return pressure?.blocked ? pressure.reason : undefined;
}
