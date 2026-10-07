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
 *   applied immediately and refreshed in the background (takes effect on the
 *   next launch). Without a usable cache the fetch blocks startup briefly
 *   (capped at 1.5s) so the session starts under the right policy.
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

/** The organization the cached policy was fetched for. */
export function getOrgPolicyOrgId(): string | undefined {
	return currentOrgId
}

function keyFingerprint(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex")
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
			policy: candidate.policy,
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

async function refresh(apiKey: string, cachePath: string, fetchImpl?: typeof globalThis.fetch): Promise<void> {
	const outcome = await fetchOrgPolicy(apiKey, { fetch: fetchImpl })

	switch (outcome.kind) {
		case "policy": {
			currentPolicy = outcome.policy
			currentOrgId = outcome.orgId
			writeCache(cachePath, {
				keyFingerprint: keyFingerprint(apiKey),
				orgId: outcome.orgId,
				fetchedAt: Date.now(),
				policy: outcome.policy,
			})
			break
		}
		case "no-access": {
			currentPolicy = undefined
			currentOrgId = undefined
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
 * Initialize the org policy for this session. With a cache matching the
 * current API key the cached policy is applied synchronously and refreshed in
 * the background; otherwise the fetch runs (and is awaited) so the session
 * starts under the correct policy. An empty API key clears all state without
 * any network access.
 *
 * Returns the promise backing the (possibly background) refresh, mainly for
 * tests.
 */
export async function initOrgPolicy(
	apiKey: string,
	options?: { cachePath?: string; fetch?: typeof globalThis.fetch },
): Promise<void> {
	const cachePath = options?.cachePath ?? ORG_POLICY_CACHE_PATH

	if (!apiKey) {
		currentPolicy = undefined
		currentOrgId = undefined
		clearCache(cachePath)
		return Promise.resolve()
	}

	const fingerprint = keyFingerprint(apiKey)
	const cached = readCache(cachePath)
	if (cached?.keyFingerprint === fingerprint) {
		currentPolicy = cached.policy
		currentOrgId = cached.orgId
		// Refresh in the background: a policy change applies on the next
		// launch. Errors are swallowed by design (fail open).
		void refresh(apiKey, cachePath, options?.fetch).catch(() => {})
		return
	}

	await refresh(apiKey, cachePath, options?.fetch)
}

/** Reset the in-memory holder. Test-only. */
export function resetOrgPolicyForTests(): void {
	currentPolicy = undefined
	currentOrgId = undefined
}
