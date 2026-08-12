import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
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
		if (!apiKey && !existsSync(authPath)) return
		if (!existsSync(authPath)) writeFileSync(authPath, "{}\n", { encoding: "utf-8", mode: 0o600 })
		const credentials = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>
		for (const providerId of Object.keys(credentials)) {
			if (isKimchiProvider(providerId)) delete credentials[providerId]
		}

		if (apiKey) {
			const models = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers?: Record<string, unknown>
			}
			for (const providerId of Object.keys(models.providers ?? {}).filter(isKimchiProvider)) {
				credentials[providerId] = { type: "api_key", key: apiKey }
			}
		}

		writeFileSync(authPath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
		chmodSync(authPath, 0o600)
	} finally {
		await release()
	}
}
