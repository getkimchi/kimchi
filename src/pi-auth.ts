import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { lock } from "proper-lockfile"

const KIMCHI_PROVIDER = "kimchi-dev"
const KIMCHI_EXPERIMENTAL_PROVIDER = "kimchi-experimental"

function isKimchiProvider(providerId: string): boolean {
	return (
		providerId === KIMCHI_PROVIDER ||
		providerId.startsWith(`${KIMCHI_PROVIDER}/`) ||
		providerId === KIMCHI_EXPERIMENTAL_PROVIDER
	)
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
			chmodSync(authPath, 0o600)
			return
		}

		writeFileSync(authPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
		chmodSync(authPath, 0o600)
	} finally {
		await release()
	}
}
