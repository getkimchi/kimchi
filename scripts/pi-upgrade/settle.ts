import { execFileSync } from "node:child_process"
import { PI_PACKAGE, type RunConfig, writeJson } from "./config.ts"
import { type Behind, behind, type NpmTimes, selectTarget, versionsBetween } from "./versions.ts"

export interface SettleResult {
	baseline: string
	target: string | null
	/** Every stable version in `(baseline, target]`, ascending. */
	chain: string[]
	behind: Behind
	forced: boolean
}

export function fetchNpmTimes(): NpmTimes {
	return JSON.parse(execFileSync("npm", ["view", PI_PACKAGE, "time", "--json"], { encoding: "utf8" }))
}

export function settle(cfg: RunConfig, times: NpmTimes): SettleResult {
	if (cfg.forced && cfg.target) {
		return {
			baseline: cfg.baseline,
			target: cfg.target,
			chain: versionsBetween(times, cfg.baseline, cfg.target),
			behind: behind(times, cfg.baseline, cfg.now),
			forced: true,
		}
	}
	const { target, chain } = selectTarget(times, cfg.baseline, cfg.now)
	return { baseline: cfg.baseline, target, chain, behind: behind(times, cfg.baseline, cfg.now), forced: false }
}

export async function runSettle(cfg: RunConfig): Promise<SettleResult> {
	const result = settle(cfg, fetchNpmTimes())
	writeJson(cfg, "settle", result)
	return result
}
