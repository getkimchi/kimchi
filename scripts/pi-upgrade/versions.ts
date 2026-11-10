/** Raw `npm view <pkg> time --json`: version → ISO publish time, plus `created`/`modified`. */
export type NpmTimes = Record<string, string>

/** A version counts as settled once this long passed with no newer release. */
export const QUIET_MS = 2 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000
const STABLE = /^\d+\.\d+\.\d+$/

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number)
	const pb = b.split(".").map(Number)
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i]
	}
	return 0
}

function stableVersions(times: NpmTimes): string[] {
	return Object.keys(times)
		.filter((v) => STABLE.test(v))
		.sort(compareVersions)
}

/** Stable versions in `(from, to]`, ascending. */
export function versionsBetween(times: NpmTimes, from: string, to: string): string[] {
	return stableVersions(times).filter((v) => compareVersions(v, from) > 0 && compareVersions(v, to) <= 0)
}

/**
 * Newest version newer than `baseline` that was followed by `quietMs` without another release
 * (or, if it is the latest, has been out for `quietMs`). Fix releases shortly after a version
 * therefore move the target to the fix.
 */
export function selectTarget(
	times: NpmTimes,
	baseline: string,
	now: Date,
	quietMs = QUIET_MS,
): { target: string | null; chain: string[] } {
	const newer = stableVersions(times).filter((v) => compareVersions(v, baseline) > 0)
	for (let i = newer.length - 1; i >= 0; i--) {
		const published = Date.parse(times[newer[i]])
		const until = i + 1 < newer.length ? Date.parse(times[newer[i + 1]]) : now.getTime()
		if (until - published >= quietMs) {
			return { target: newer[i], chain: newer.slice(0, i + 1) }
		}
	}
	return { target: null, chain: [] }
}

export interface Behind {
	versions: number
	days: number
	lines: number
	latest: string
}

export function behind(times: NpmTimes, baseline: string, now: Date): Behind {
	const all = stableVersions(times)
	const latest = all[all.length - 1] ?? baseline
	const newer = all.filter((v) => compareVersions(v, baseline) > 0)
	const lines = new Set(newer.map((v) => v.split(".").slice(0, 2).join(".")))
	const baselinePublished = times[baseline] ? Date.parse(times[baseline]) : now.getTime()
	return {
		versions: newer.length,
		days: Math.floor((now.getTime() - baselinePublished) / DAY_MS),
		lines: lines.size,
		latest,
	}
}
