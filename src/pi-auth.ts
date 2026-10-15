import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
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

		writeFileSync(authPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
		ensureAuthFileMode(authPath)
	} finally {
		await release()
	}
}
