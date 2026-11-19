import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { lockSync } from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	clearCredentialStale,
	clearRefreshedCredentialStale,
	isAuthRejectedMessage,
	isCredentialStale,
	markCredentialStale,
	prepareCredentialForLogin,
	resetCredentialStalenessForTests,
} from "./credential-staleness.js"

describe("credential-staleness registry", () => {
	beforeEach(() => {
		resetCredentialStalenessForTests()
	})

	it("starts clean", () => {
		expect(isCredentialStale("some-key", "kimchi-dev")).toBe(false)
	})

	it("marks a specific key stale for a provider and reports it", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(true)
	})

	it("scopes staleness to the apiKey: a different key (re-login) is not stale", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		expect(isCredentialStale("fresh-key", "kimchi-dev")).toBe(false)
	})

	it("scopes provider-level staleness: a 401 on kimchi-dev poisons the provider even without a key", () => {
		markCredentialStale(undefined, "kimchi-dev")
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(true)
		// Provider mark can't name the key: any key reads stale until cleared.
		expect(isCredentialStale("fresh-key", "kimchi-dev")).toBe(true)
	})

	it("clearCredentialStale wipes both key-level and provider-level marks", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		markCredentialStale(undefined, "kimchi-dev")
		clearCredentialStale("kimchi-dev")
		expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(false)
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(false)
	})

	it("does not leak staleness across providers", () => {
		markCredentialStale(undefined, "kimchi-dev")
		expect(isCredentialStale(undefined, "other-provider")).toBe(false)
	})
})

describe("persistent credential rejections", () => {
	let dir: string
	let statePath: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-credential-rejections-"))
		statePath = join(dir, "credential-rejections.json")
		resetCredentialStalenessForTests()
		vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("persists only fingerprints and recognizes only the rejected credential after a reset", () => {
		const rejectedToken = "raw-token-that-must-never-be-persisted"
		markCredentialStale(rejectedToken, "kimchi-dev", statePath)

		const serialized = readFileSync(statePath, "utf8")
		expect(serialized).not.toContain(rejectedToken)
		expect(serialized).toMatch(/"[a-f0-9]{64}"/)

		resetCredentialStalenessForTests()
		expect(isCredentialStale(rejectedToken, "kimchi-dev", statePath)).toBe(true)
		expect(isCredentialStale("genuinely-new-token", "kimchi-dev", statePath)).toBe(false)
	})

	it("persists an authenticated-success clear without clearing other providers", () => {
		markCredentialStale("dead-key", "kimchi-dev", statePath)
		markCredentialStale("other-key", "other-provider", statePath)

		clearCredentialStale("kimchi-dev", statePath)
		resetCredentialStalenessForTests()

		expect(isCredentialStale("dead-key", "kimchi-dev", statePath)).toBe(false)
		expect(isCredentialStale("other-key", "other-provider", statePath)).toBe(true)
	})

	it("clears only rotated OAuth values after a persisted refresh", () => {
		markCredentialStale("old-oauth-token", "kimchi-dev", statePath)
		markCredentialStale("new-oauth-token", "kimchi-dev", statePath)
		markCredentialStale("unrelated-api-key", "kimchi-dev", statePath)
		markCredentialStale(undefined, "kimchi-dev")

		clearRefreshedCredentialStale("old-oauth-token", "new-oauth-token", "kimchi-dev", statePath)
		resetCredentialStalenessForTests()

		expect(isCredentialStale(undefined, "kimchi-dev", statePath)).toBe(false)
		expect(isCredentialStale("old-oauth-token", "kimchi-dev", statePath)).toBe(false)
		expect(isCredentialStale("new-oauth-token", "kimchi-dev", statePath)).toBe(false)
		expect(isCredentialStale("unrelated-api-key", "kimchi-dev", statePath)).toBe(true)
	})

	it("retains only the presented credential's persisted rejection when preparing a repeated login", () => {
		markCredentialStale("repeated-token", "kimchi-dev", statePath)
		markCredentialStale("replaced-token", "kimchi-dev", statePath)
		markCredentialStale(undefined, "kimchi-dev")

		prepareCredentialForLogin("repeated-token", "kimchi-dev", statePath)

		expect(isCredentialStale("repeated-token", "kimchi-dev", statePath)).toBe(true)
		expect(isCredentialStale("replaced-token", "kimchi-dev", statePath)).toBe(false)
		expect(isCredentialStale(undefined, "kimchi-dev", statePath)).toBe(false)
		resetCredentialStalenessForTests()
		expect(isCredentialStale("repeated-token", "kimchi-dev", statePath)).toBe(true)
		expect(isCredentialStale("replaced-token", "kimchi-dev", statePath)).toBe(false)
	})

	it("ignores unknown sidecar versions instead of reinterpreting them as v1", () => {
		const rejectedToken = "token-from-a-future-format"
		writeFileSync(
			statePath,
			JSON.stringify({
				version: 2,
				providers: { "kimchi-dev": [createHash("sha256").update(rejectedToken).digest("hex")] },
			}),
		)

		expect(isCredentialStale(rejectedToken, "kimchi-dev", statePath)).toBe(false)
	})

	it.each(["mark", "clear"])("preserves an unsupported-version sidecar during %s", (operation) => {
		const original = `${JSON.stringify({
			version: 2,
			providers: { "kimchi-dev": ["future-fingerprint"] },
			futureState: { rotateAfter: "later" },
		})}\n`
		writeFileSync(statePath, original)

		if (operation === "mark") markCredentialStale("new-key", "kimchi-dev", statePath)
		else clearCredentialStale("kimchi-dev", statePath)

		expect(readFileSync(statePath, "utf8")).toBe(original)
	})

	it("does not create a missing sidecar or rewrite when there is no rejection to clear", () => {
		clearCredentialStale("kimchi-dev", statePath)
		expect(existsSync(statePath)).toBe(false)

		markCredentialStale("other-key", "other-provider", statePath)
		const original = readFileSync(statePath, "utf8")
		const mtimeNs = statSync(statePath, { bigint: true }).mtimeNs
		clearCredentialStale("kimchi-dev", statePath)

		expect(readFileSync(statePath, "utf8")).toBe(original)
		expect(statSync(statePath, { bigint: true }).mtimeNs).toBe(mtimeNs)
	})

	it("keeps the sidecar owner-only across atomic rewrites", () => {
		if (process.platform === "win32") return
		markCredentialStale("first-key", "kimchi-dev", statePath)
		markCredentialStale("second-key", "kimchi-dev", statePath)

		expect(statSync(statePath).mode & 0o777).toBe(0o600)
	})

	it("retains a rejection when lock contention lasts longer than 500ms", async () => {
		const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
		const moduleUrl = new URL("./credential-staleness.ts", import.meta.url).href
		const source = `import { markCredentialStale } from ${JSON.stringify(moduleUrl)};
process.stdout.write("ready");
markCredentialStale("contended-key", "kimchi-dev", process.argv[1]);`
		markCredentialStale("seed-key", "kimchi-dev", statePath)
		const release = lockSync(statePath, { realpath: false })
		const child = spawn(process.execPath, [tsxCli, "-e", source, statePath], { stdio: ["ignore", "pipe", "pipe"] })
		const ready = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()))
		let stderr = ""
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk
		})
		const completed = new Promise<void>((resolve, reject) => {
			child.once("error", reject)
			child.once("close", (code) => {
				if (code === 0) resolve()
				else reject(new Error(`contended writer exited ${code}: ${stderr}`))
			})
		})

		await ready
		await delay(750)
		release()
		await completed

		resetCredentialStalenessForTests()
		expect(isCredentialStale("contended-key", "kimchi-dev", statePath)).toBe(true)
	})

	it("serializes concurrent process updates without losing rejected fingerprints", async () => {
		const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
		const moduleUrl = new URL("./credential-staleness.ts", import.meta.url).href
		const source = `import { markCredentialStale } from ${JSON.stringify(moduleUrl)};
const statePath = process.argv[1];
const worker = process.argv[2];
for (let i = 0; i < 10; i++) markCredentialStale(worker + "-" + i, "kimchi-dev", statePath);`

		const writers = Array.from({ length: 4 }, (_, worker) => {
			const child = spawn(process.execPath, [tsxCli, "-e", source, statePath, `writer-${worker}`], {
				stdio: ["ignore", "pipe", "pipe"],
			})
			let stderr = ""
			child.stderr.setEncoding("utf8")
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk
			})
			return new Promise<void>((resolve, reject) => {
				child.once("error", reject)
				child.once("close", (code) => {
					if (code === 0) resolve()
					else reject(new Error(`rejection writer ${worker} exited ${code}: ${stderr}`))
				})
			})
		})
		await Promise.all(writers)

		resetCredentialStalenessForTests()
		for (let worker = 0; worker < 4; worker++) {
			for (let i = 0; i < 10; i++) {
				expect(isCredentialStale(`writer-${worker}-${i}`, "kimchi-dev", statePath)).toBe(true)
			}
		}
	}, 15_000)
})

describe("isAuthRejectedMessage", () => {
	it.each([
		"Failed to fetch models: 401 Unauthorized",
		"Request failed with status code 401: Unauthorized",
		"invalid api key provided",
		"invalid token",
		"expired token",
		"unauthenticated request",
	])("detects auth-class error text: %s", (message) => {
		expect(isAuthRejectedMessage(message)).toBe(true)
	})

	it.each([
		"Failed to fetch models: 500 Internal Server Error",
		"rate limited, retry in 30s",
		"network down",
		// Substrings must not trigger: prose mentioning "key" is not a rejection.
		"keybinding conflict detected",
	])("does not flag non-auth errors: %s", (message) => {
		expect(isAuthRejectedMessage(message)).toBe(false)
	})
})
