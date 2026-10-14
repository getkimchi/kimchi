import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { fetchOrgPolicy, type OrgPolicy, parseResourcePolicyMap, parseResourcePolicyName } from "./api/org-settings.js"

/**
 * Org-policy delivery (fetch-first; the cache is only the offline fallback):
 *
 * - Every startup fetches the effective org policy for the API key BEFORE any
 *   cached policy is read, with a bounded wait: a resolved policy — including
 *   "no policy" — is applied for the whole session and written to
 *   ~/.config/kimchi/org-policy.json, overwriting whatever was on disk. A
 *   locally edited or stale cache therefore never survives an online launch.
 * - When the fetch cannot produce a fresh answer (offline, endpoint down,
 *   resolution denied), the session falls back to the last policy cached for
 *   this exact key and the cache file is left untouched.
 * - A key rejected on verify (401) clears the holder and wipes this key's
 *   cache (fail open, scoped to that key).
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
	// Same rules as the wire parser (shared walker): unknown policy values are
	// dropped, unknown resource ids are kept (they are inert — the store only
	// resolves ids it is asked about) so a newer platform's entries survive
	// the cache round trip.
	const resources = parseResourcePolicyMap(source.resources, parseResourcePolicyName)
	if (resources) policy.resources = resources

	if (!policy.allowedPermissionModes && policy.usageReporting === undefined && !policy.resources) return undefined
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

/**
 * Initialize the org policy for this session (see the delivery notes at the
 * top of the file). The fetch is always attempted first: a resolution
 * overwrites both the holder and the cache before either can be read, so
 * local edits or a stale cache lose to the platform's answer. Only a failed
 * fetch falls back to this key's cached policy.
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
	const outcome = await fetchOrgPolicy(apiKey, { fetch: options?.fetch })
	switch (outcome.kind) {
		case "policy":
			// Wire truth wins over anything on disk: the fresh policy replaces
			// the holder and the cache before either can be read.
			currentPolicy = outcome.policy
			currentOrgId = outcome.orgId
			writeCache(cachePath, {
				keyFingerprint: fingerprint,
				orgId: outcome.orgId,
				fetchedAt: Date.now(),
				policy: outcome.policy,
			})
			return
		case "revoked":
			// The key no longer verifies, so a cached policy for it can never
			// revalidate: drop both (fail open). The wipe is scoped to this key's
			// fingerprint so a cache written for another key — e.g. the user
			// switched keys — survives.
			currentPolicy = undefined
			currentOrgId = undefined
			if (readCache(cachePath)?.keyFingerprint === fingerprint) clearCache(cachePath)
			return
		case "no-access":
		case "unreachable": {
			// No fresh answer: fall back to the last policy cached for this
			// exact key (best-effort enforcement for the session). The cache
			// file is kept untouched.
			const cached = readCache(cachePath)
			if (cached?.keyFingerprint === fingerprint) {
				currentPolicy = cached.policy
				currentOrgId = cached.orgId
			} else {
				currentPolicy = undefined
				currentOrgId = undefined
			}
			return
		}
	}
}

/** Reset the in-memory holder. Test-only. */
export function resetOrgPolicyForTests(): void {
	currentPolicy = undefined
	currentOrgId = undefined
}
