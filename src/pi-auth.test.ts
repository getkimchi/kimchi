import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncPiAuth } from "./pi-auth.js"

const tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("syncPiAuth", () => {
	it("creates Pi auth storage on first run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))

		await syncPiAuth(authPath, modelsPath, "kimchi-key")

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
		})
	})

	it("stores the Kimchi key for every managed Pi provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				anthropic: { type: "api_key", key: "keep-me" },
				"kimchi-experimental": { type: "api_key", key: "old-kimchi-key" },
			}),
		)
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "kimchi-dev": {}, "kimchi-dev/openai": {}, "kimchi-experimental": {}, ollama: {} },
			}),
		)

		await syncPiAuth(authPath, modelsPath, "kimchi-key")

		const credentials = JSON.parse(readFileSync(authPath, "utf-8"))
		expect(credentials).toEqual({
			anthropic: { type: "api_key", key: "keep-me" },
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
			"kimchi-dev/openai": { type: "api_key", key: "kimchi-key" },
			"kimchi-experimental": { type: "api_key", key: "kimchi-key" },
		})
		expect(statSync(authPath).mode & 0o777).toBe(0o600)
	})

	it("removes stale Kimchi credentials when the key is cleared", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-pi-auth-"))
		tempDirs.push(dir)
		const authPath = join(dir, "auth.json")
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "old" },
				"kimchi-experimental": { type: "api_key", key: "old" },
				ollama: { type: "api_key", key: "keep" },
			}),
		)
		writeFileSync(modelsPath, JSON.stringify({ providers: { "kimchi-dev": {} } }))

		await syncPiAuth(authPath, modelsPath, "")

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			ollama: { type: "api_key", key: "keep" },
		})
	})
})
