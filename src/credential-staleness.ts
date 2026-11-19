// Registry of credentials observed 401-rejected, so presence-based auth
// surfaces can report validity, not just existence. On-disk store
// (config.json apiKey, auth.json) answers "credential present?", never
// "does it still work"; a dead key shows logged in until a request fails.
//
// Mark on observed 401 (refresh: updateModelsConfig — models.ts; turns:
// prompt() — modes/acp/server.ts), clear on authenticated success, read in
// handleAuthStatus — ext-methods/auth-status.ts. Keyed rejections persist in
// credential-rejections.json beside the shared credential store so an ACP
// process restart cannot make an already-observed dead credential look alive.
// Only SHA-256 fingerprints cross the process boundary, never raw tokens.
//
// flow.ts imports models.ts and models.ts imports this module, so persistence
// uses only low-level utilities rather than importing auth/login flow back.

import { createHash } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { lockSync } from "proper-lockfile"
import { writeJson } from "./config/json.js"

const CREDENTIAL_REJECTIONS_FILENAME = "credential-rejections.json"

type PersistentRejections = {
	version: 1
	providers: Record<string, string[]>
}

// Production has exactly one authoritative sidecar location. The optional
// overrides on public functions below are storage-test injection, not alternate
// credential layouts; this prevents writers and readers from deriving separate
// state files from models.json, auth.json, and the environment.
function defaultRejectionsPath(): string | undefined {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	return agentDir ? join(agentDir, CREDENTIAL_REJECTIONS_FILENAME) : undefined
}

function rejectionsPath(statePath?: string): string | undefined {
	return statePath ?? defaultRejectionsPath()
}

function fingerprint(apiKey: string): string {
	return createHash("sha256").update(apiKey, "utf8").digest("hex")
}

function readPersistentRejections(path: string, forUpdate = false): PersistentRejections {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
		if (!parsed || typeof parsed !== "object") return { version: 1, providers: {} }
		const document = parsed as { version?: unknown; providers?: unknown }
		if (document.version !== 1) {
			// Reads ignore newer formats, but an older binary must never silently
			// replace their fields with an empty v1 document during an update.
			if (forUpdate) throw new Error("unsupported credential-rejections.json version")
			return { version: 1, providers: {} }
		}
		const providers = document.providers
		if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
			return { version: 1, providers: {} }
		}
		const validProviders: Record<string, string[]> = {}
		for (const [providerId, values] of Object.entries(providers)) {
			if (Array.isArray(values)) validProviders[providerId] = values.filter((value) => typeof value === "string")
		}
		return { version: 1, providers: validProviders }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
			return { version: 1, providers: {} }
		}
		throw error
	}
}

function waitForLockRetry(delayMs: number): void {
	// proper-lockfile's sync API has no retry option. Keep the existing
	// synchronous call sites and back off between lock attempts.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}

function updatePersistentRejections(path: string, update: (state: PersistentRejections) => PersistentRejections): void {
	// Successful turns clear credentials constantly. Avoid creating or locking
	// a sidecar when the current state would not change. Repeat the read and
	// update under the lock below for any write that is actually necessary.
	const initialState = readPersistentRejections(path, true)
	if (update(initialState) === initialState) return
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	closeSync(openSync(path, "a", 0o600))
	let release: (() => void) | undefined
	const retryStartedAt = Date.now()
	let retryDelayMs = 10
	while (!release) {
		try {
			release = lockSync(path, { realpath: false, stale: 30_000 })
		} catch (error) {
			const remainingMs = 35_000 - (Date.now() - retryStartedAt)
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || remainingMs <= 0) throw error
			// Outlast proper-lockfile's 30s stale threshold before giving up; a
			// bounded retry cannot mask the original 401 forever, but ordinary
			// contention must not silently lose the restart-protection mark.
			waitForLockRetry(Math.min(retryDelayMs, remainingMs))
			retryDelayMs = Math.min(retryDelayMs * 2, 250)
		}
	}
	try {
		const currentState = readPersistentRejections(path, true)
		const nextState = update(currentState)
		if (nextState !== currentState) writeJson(path, nextState)
	} finally {
		release?.()
	}
}

function persistRejection(apiKey: string, providerId: string, statePath?: string): void {
	const path = rejectionsPath(statePath)
	if (!path) return
	const rejectedFingerprint = fingerprint(apiKey)
	try {
		updatePersistentRejections(resolve(path), (state) => {
			const rejected = state.providers[providerId] ?? []
			if (rejected.includes(rejectedFingerprint)) return state
			return { ...state, providers: { ...state.providers, [providerId]: [...rejected, rejectedFingerprint] } }
		})
	} catch (error) {
		// Persistence must not mask the original 401. The in-memory mark still
		// protects this process; the next successful mark can retry the sidecar.
		console.warn("[credential-staleness] could not persist rejected credential fingerprint", error)
	}
}

/**
 * True when error text unambiguously means credential rejection. pi exposes
 * errorMessage text, not status codes — detection keys off text. Tight on
 * purpose: a false positive logs a healthy user out; a false negative
 * degrades to the old presence-only behaviour.
 */
const AUTH_REJECTED_TEXT =
	/\b401\b|unauthorized|unauthenticated|invalid (api[- ]?key|token|credentials?)|expired (token|credentials?)/i

export function isAuthRejectedMessage(message: string | undefined): boolean {
	return message !== undefined && AUTH_REJECTED_TEXT.test(message)
}

type ProviderStaleness = {
	/** The failing call could not be attributed to one key. */
	providerStale: boolean
	/** Fingerprints of keys individually observed rejected. */
	staleKeys: Set<string>
}

const stalenessByProvider = new Map<string, ProviderStaleness>()

function providerEntry(providerId: string): ProviderStaleness {
	let entry = stalenessByProvider.get(providerId)
	if (!entry) {
		entry = { providerStale: false, staleKeys: new Set() }
		stalenessByProvider.set(providerId, entry)
	}
	return entry
}

/** Mark a rejection: by apiKey when known, else provider-wide for this process. */
export function markCredentialStale(apiKey: string | undefined, providerId: string, statePath?: string): void {
	const entry = providerEntry(providerId)
	if (apiKey !== undefined && apiKey.length > 0) {
		entry.staleKeys.add(fingerprint(apiKey))
		persistRejection(apiKey, providerId, statePath)
	} else {
		// Without the rejected credential there is no safe persistent value: a
		// provider-wide disk flag would also reject a genuinely new login.
		entry.providerStale = true
	}
}

function clearPersistentRejection(
	providerId: string,
	statePath: string | undefined,
	retainedFingerprint?: string,
	clearedFingerprints?: ReadonlySet<string>,
): void {
	const path = rejectionsPath(statePath)
	if (!path) return
	try {
		updatePersistentRejections(resolve(path), (state) => {
			if (!(providerId in state.providers)) return state
			const rejected = state.providers[providerId]
			const retained =
				retainedFingerprint !== undefined
					? rejected.filter((value) => value === retainedFingerprint)
					: clearedFingerprints !== undefined
						? rejected.filter((value) => !clearedFingerprints.has(value))
						: []
			if (
				(retainedFingerprint !== undefined || clearedFingerprints !== undefined) &&
				retained.length === rejected.length
			) {
				return state
			}
			const providers = { ...state.providers }
			if (retained.length > 0) providers[providerId] = retained
			else delete providers[providerId]
			return { ...state, providers }
		})
	} catch (error) {
		console.warn("[credential-staleness] could not clear rejected credential fingerprints", error)
	}
}

/** Authenticated success (refresh, fresh login) means credentials work again. */
export function clearCredentialStale(providerId: string, statePath?: string): void {
	stalenessByProvider.delete(providerId)
	clearPersistentRejection(providerId, statePath)
}

/** A persisted refresh retires anonymous/provider state and only the rotated OAuth values. */
export function clearRefreshedCredentialStale(
	previousApiKey: string | undefined,
	apiKey: string,
	providerId: string,
	statePath?: string,
): void {
	const clearedFingerprints = new Set([previousApiKey, apiKey].filter((value) => value !== undefined).map(fingerprint))
	const entry = stalenessByProvider.get(providerId)
	if (entry) {
		entry.providerStale = false
		for (const value of clearedFingerprints) entry.staleKeys.delete(value)
		if (entry.staleKeys.size === 0) stalenessByProvider.delete(providerId)
	}
	clearPersistentRejection(providerId, statePath, undefined, clearedFingerprints)
}

/** Start a login without turning an unverified cached refresh into success.
 * Anonymous and replaced-credential marks are obsolete, but a repeated
 * credential must retain its observed rejection until authenticated success.
 */
export function prepareCredentialForLogin(apiKey: string, providerId: string, statePath?: string): void {
	const retainedFingerprint = fingerprint(apiKey)
	const entry = stalenessByProvider.get(providerId)
	stalenessByProvider.delete(providerId)
	if (entry?.staleKeys.has(retainedFingerprint)) providerEntry(providerId).staleKeys.add(retainedFingerprint)
	clearPersistentRejection(providerId, statePath, retainedFingerprint)
}

/**
 * Key mark blames that one key; provider mark blames every key for the
 * provider — readers can't tell which key 401'd, so a fresh key counts as
 * stale until clearCredentialStale runs (refresh / re-login).
 */
export function isCredentialStale(apiKey: string | undefined, providerId: string, statePath?: string): boolean {
	const entry = stalenessByProvider.get(providerId)
	if (entry?.providerStale) return true
	if (apiKey === undefined || apiKey.length === 0) return false
	const rejectedFingerprint = fingerprint(apiKey)
	if (entry?.staleKeys.has(rejectedFingerprint)) return true
	const path = rejectionsPath(statePath)
	if (!path) return false
	try {
		return readPersistentRejections(resolve(path)).providers[providerId]?.includes(rejectedFingerprint) ?? false
	} catch {
		// Preserve the old presence-based behaviour if the auxiliary sidecar is
		// unreadable; this must never turn an I/O problem into a sign-out.
		return false
	}
}

export function resetCredentialStalenessForTests(): void {
	stalenessByProvider.clear()
}
