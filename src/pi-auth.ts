import { randomUUID } from "node:crypto"
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { lock } from "proper-lockfile"
import { isKimchiProvider, KIMCHI_PROVIDER_ID } from "./kimchi-provider.js"

/**
 * chmod only when the mode is wrong. An unconditional chmod bumps auth.json's
 * ctime on every startup and, since the file is shared, forces every other
 * session's lock-free reader to reload.
 */
function ensureAuthFileMode(authPath: string): void {
	if ((statSync(authPath).mode & 0o777) !== 0o600) chmodSync(authPath, 0o600)
}

/**
 * Atomically write `content` to `path` (same-dir tmp, fsync, rename).
 * Readers are lock-free while writers only lock against writers, so a plain
 * truncate-then-write lets a reader observe a partial file; with rename they
 * only ever see the old or the new complete document.
 */
function writeFileAtomicSync(path: string, content: string, mode: number): void {
	// Resolve a symlinked auth.json so tmp+rename land beside the real file
	// and the link survives (a bare rename over the link would replace it with
	// a regular file).
	const target = existsSync(path) ? realpathSync(path) : path
	const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
	try {
		const fd = openSync(tmp, "w", mode)
		try {
			writeFileSync(fd, content, { encoding: "utf-8" })
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
		renameSync(tmp, target)
	} catch (error) {
		rmSync(tmp, { force: true })
		throw error
	}
}

/** Remove all Kimchi credentials from auth.json — kimchi-dev, kimchi-dev/*, kimchi-experimental. */
export async function clearPiAuth(authPath: string): Promise<void> {
	await syncPiAuth(authPath, "", "")
}

/**
 * Fan an OAuth credential out to every Kimchi-managed provider in models.json
 * (kimchi-dev + kimchi-dev/* sub-providers), mirroring how syncPiAuth fans out
 * API keys: sub-providers resolve auth per provider id, so each needs an
 * auth.json entry.
 *
 * Rotation safety: every fanned-out entry shares one refresh token. This is
 * only safe while the CAST AI Auth0 app does NOT rotate refresh tokens —
 * Auth0 rotation makes a refresh token single-use, and sibling entries
 * refreshing with the same token would kill each other (and trip reuse
 * detection). Step-1 registration must keep rotation OFF. When Auth0 rotation
 * is eventually wanted, replace fan-out with a single-entry credential +
 * parent-lookup resolution.
 */
export async function syncOAuthCredentialToKimchiProviders(
	authPath: string,
	modelsPath: string,
	credential: Record<string, unknown>,
): Promise<void> {
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
	const release = await lock(authPath, { realpath: false, retries: 10 })
	try {
		const authExists = existsSync(authPath)
		const credentials = authExists ? (JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>) : {}
		const nextCredentials = { ...credentials }

		const models = existsSync(modelsPath)
			? (JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers?: Record<string, unknown> })
			: { providers: {} }
		const kimchiProviderIds = new Set([
			KIMCHI_PROVIDER_ID,
			...Object.keys(models.providers ?? {}).filter(isKimchiProvider),
		])

		for (const providerId of kimchiProviderIds) {
			nextCredentials[providerId] = credential
		}

		if (authExists && isDeepStrictEqual(credentials, nextCredentials)) {
			ensureAuthFileMode(authPath)
			return
		}

		writeFileAtomicSync(authPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, 0o600)
		ensureAuthFileMode(authPath)
	} finally {
		await release()
	}
}

export async function syncPiAuth(authPath: string, modelsPath: string, apiKey: string): Promise<void> {
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
	const release = await lock(authPath, { realpath: false, retries: 10 })
	try {
		const authExists = existsSync(authPath)
		if (!apiKey && !authExists) return

		const credentials = authExists ? (JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>) : {}
		const nextCredentials = { ...credentials }
		for (const providerId of Object.keys(nextCredentials)) {
			if (isKimchiProvider(providerId)) delete nextCredentials[providerId]
		}

		if (apiKey) {
			if (!existsSync(modelsPath)) {
				throw new Error(`Models configuration is missing at ${modelsPath}`)
			}
			const models = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers?: Record<string, unknown>
			}
			for (const providerId of Object.keys(models.providers ?? {}).filter(isKimchiProvider)) {
				nextCredentials[providerId] = { type: "api_key", key: apiKey }
			}
		}

		if (authExists && isDeepStrictEqual(credentials, nextCredentials)) {
			ensureAuthFileMode(authPath)
			return
		}

		writeFileAtomicSync(authPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, 0o600)
		ensureAuthFileMode(authPath)
	} finally {
		await release()
	}
}
