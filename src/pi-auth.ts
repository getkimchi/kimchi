import { randomUUID } from "node:crypto"
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { lock } from "proper-lockfile"
import { isKimchiProvider } from "./kimchi-provider.js"

/**
 * chmod only when the mode is actually wrong. An unconditional chmod rewrites
 * auth.json's ctime on every startup — auth.json is shared by all kimchi
 * processes, so each bump forces every other running session to re-read the
 * file (revision check includes ctime) and arms the readLatestData race fixed
 * by the Auth-storage reload unwrap patch.
 */
function ensureAuthFileMode(authPath: string): void {
	if ((statSync(authPath).mode & 0o777) !== 0o600) chmodSync(authPath, 0o600)
}

/**
 * Write `content` to `path` atomically (same-directory temp file, fsync,
 * rename). auth.json readers are lock-free (see the Auth-storage lock-free
 * reads patch) while writers only lock against other writers, so a plain
 * truncate-then-writeFileSync lets a concurrent reader observe an empty or
 * partial file — surfacing as request-time credential loss against models.json's
 * $KIMCHI_API_KEY template. With rename, readers only ever see the old or the
 * new complete document.
 */
function writeFileAtomicSync(path: string, content: string, mode: number): void {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
	try {
		const fd = openSync(tmp, "w", mode)
		try {
			writeFileSync(fd, content, { encoding: "utf-8" })
			fsyncSync(fd)
		} finally {
			closeSync(fd)
		}
		renameSync(tmp, path)
	} catch (error) {
		rmSync(tmp, { force: true })
		throw error
	}
}

/** Remove all Kimchi credentials from auth.json — kimchi-dev, kimchi-dev/*, kimchi-experimental. */
export async function clearPiAuth(authPath: string): Promise<void> {
	await syncPiAuth(authPath, "", "")
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
