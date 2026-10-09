import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { fetchOrgPolicy, type OrgPolicy } from "./api/org-settings.js"

/**
 * Org-policy delivery (stale-while-revalidate):
 *
 * - The effective org policy is fetched once per API key and cached in
 *   ~/.config/kimchi/org-policy.json.
 * - On startup with a cache matching the current key, the cached policy is
 *   applied for the whole session and refreshed in the background; the
 *   refresh only updates the cache file so a policy change takes effect on
 *   the next launch. Without a usable cache the fetch blocks startup briefly
 *   (capped at ~1.5s per call) so the session starts under the right policy.
 * - Fetch outcomes: a resolved policy (including "no policy") overwrites the
 *   cache; auth failures (401/403/404) clear it (fail open); network errors
 *   keep the last known good policy.
 */
const ORG_POLICY_CACHE_PATH = resolve(homedir(), ".config", "kimchi", "org-policy.json")

interface OrgPolicyCacheFile {
	keyFingerprint: string
	orgId: string
	fetchedAt: number
	policy?: OrgPolicy
}

let currentPolicy: OrgPolicy | undefined
let currentOrgId: string | undefined

/** The effective org policy for the current session, if any. */
export function getOrgPolicy(): OrgPolicy | undefined {
	return currentPolicy
}

/** The organization the session policy was resolved for. */
export function getOrgPolicyOrgId(): string | undefined {
	return currentOrgId
}

function keyFingerprint(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex")
}

const KNOWN_USAGE_REPORTING = new Set(["USER_CHOICE", "FORCE_ON", "FORCE_OFF"])

/**
 * Validate a policy read from the cache file: a corrupted or future-format
 * cache must not impose bogus restrictions, so unknown values are dropped.
 * A cached allowed-modes set must enable at least one mode, mirroring the
 * platform-side constraint.
 */
function validateCachedPolicy(raw: unknown): OrgPolicy | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	const source = raw as Record<string, unknown>

	const policy: OrgPolicy = {}
	const modes = source.allowedPermissionModes
	if (modes !== null && typeof modes === "object" && !Array.isArray(modes)) {
		const modeFields = modes as Record<string, unknown>
		if (
			modeFields.plan === true ||
			modeFields.default === true ||
			modeFields.auto === true ||
			modeFields.yolo === true
		) {
			policy.allowedPermissionModes = {
				plan: modeFields.plan === true,
				default: modeFields.default === true,
				auto: modeFields.auto === true,
				yolo: modeFields.yolo === true,
			}
		}
	}
	if (typeof source.usageReporting === "string" && KNOWN_USAGE_REPORTING.has(source.usageReporting)) {
		policy.usageReporting = source.usageReporting as OrgPolicy["usageReporting"]
	}

	if (!policy.allowedPermissionModes && policy.usageReporting === undefined) return undefined
	return policy
}

function readCache(cachePath: string): OrgPolicyCacheFile | undefined {
	try {
		const raw = readFileSync(cachePath, "utf-8")
		const parsed: unknown = JSON.parse(raw)
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
		const candidate = parsed as Partial<OrgPolicyCacheFile>
		if (typeof candidate.keyFingerprint !== "string" || typeof candidate.orgId !== "string") return undefined
		return {
			keyFingerprint: candidate.keyFingerprint,
			orgId: candidate.orgId,
			fetchedAt: typeof candidate.fetchedAt === "number" ? candidate.fetchedAt : 0,
			policy: validateCachedPolicy(candidate.policy),
		}
	} catch {
		return undefined
	}
}

function writeCache(cachePath: string, cache: OrgPolicyCacheFile): void {
	try {
		mkdirSync(dirname(cachePath), { recursive: true })
		writeFileSync(cachePath, `${JSON.stringify(cache)}\n`)
	} catch {
		// The cache is best-effort; a read-only HOME must not break startup.
	}
}

function clearCache(cachePath: string): void {
	try {
		if (existsSync(cachePath)) rmSync(cachePath)
	} catch {
		// Best-effort, same as above.
	}
}

async function refresh(
	apiKey: string,
	cachePath: string,
	fetchImpl: typeof globalThis.fetch | undefined,
	updateHolder: boolean,
): Promise<void> {
	const outcome = await fetchOrgPolicy(apiKey, { fetch: fetchImpl })

	switch (outcome.kind) {
		case "policy": {
			// Background refreshes only update the cache: a session keeps the
			// policy it started with, and the new one applies next launch.
			if (updateHolder) {
				currentPolicy = outcome.policy
				currentOrgId = outcome.orgId
			}
			writeCache(cachePath, {
				keyFingerprint: keyFingerprint(apiKey),
				orgId: outcome.orgId,
				fetchedAt: Date.now(),
				policy: outcome.policy,
			})
			break
		}
		case "no-access": {
			if (updateHolder) {
				currentPolicy = undefined
				currentOrgId = undefined
			}
			clearCache(cachePath)
			break
		}
		case "unreachable": {
			// Keep the current holder state and the cache as-is.
			break
		}
	}
}

/**
 * Initialize the org policy for this session:
 *
 * - With a cache matching the current API key, the cached policy is applied
 *   to the in-memory holder and a background refresh updates only the cache
 *   file (the refreshed policy takes effect on the next launch).
 * - Without a usable cache, the fetch runs and is awaited so the session
 *   starts under the correct policy, then populates holder and cache.
 * - An empty API key means the session has no policy: the holder is cleared,
 *   but the cache file is kept so the next keyed run still starts warm.
 *
 * The returned promise resolves once the (possibly background) refresh has
 * settled; mainly useful for tests. An empty API key resolves immediately.
 */
export async function initOrgPolicy(
	apiKey: string,
	options?: { cachePath?: string; fetch?: typeof globalThis.fetch },
): Promise<void> {
	const cachePath = options?.cachePath ?? ORG_POLICY_CACHE_PATH

	if (!apiKey) {
		currentPolicy = undefined
		currentOrgId = undefined
		return
	}

	const fingerprint = keyFingerprint(apiKey)
	const cached = readCache(cachePath)
	if (cached?.keyFingerprint === fingerprint) {
		currentPolicy = cached.policy
		currentOrgId = cached.orgId
		// Background refresh: errors are swallowed by design (fail open).
		void refresh(apiKey, cachePath, options?.fetch, false).catch(() => {})
		return
	}

	await refresh(apiKey, cachePath, options?.fetch, true)
}

/** Reset the in-memory holder. Test-only. */
export function resetOrgPolicyForTests(): void {
	currentPolicy = undefined
	currentOrgId = undefined
}
