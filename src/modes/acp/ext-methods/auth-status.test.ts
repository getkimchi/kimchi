import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearApiKey, writeApiKey } from "../../../config.js"
import { markCredentialStale, resetCredentialStalenessForTests } from "../../../credential-staleness.js"
import { type AuthStatusPaths, type AuthStatusResponse, handleAuthStatus } from "./auth-status.js"

// Integration-style handler tests against the real credential store:
// config.json (API key) and auth.json (OAuth credentials) on real temp
// files — no config.js mocks — so the persist→read linkage is exercised.
describe("handleAuthStatus", () => {
	let dir: string
	let configPath: string
	let paths: AuthStatusPaths

	beforeEach(() => {
		vi.stubEnv("KIMCHI_API_KEY", undefined)
		dir = mkdtempSync(join(tmpdir(), "kimchi-auth-status-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
		resetCredentialStalenessForTests()
		configPath = join(dir, "config.json")
		paths = {
			authPath: join(dir, "auth.json"),
			modelsPath: join(dir, "models.json"),
			configPath,
		}
	})

	afterEach(() => {
		resetCredentialStalenessForTests()
		vi.unstubAllEnvs()
		rmSync(dir, { recursive: true, force: true })
	})

	it("reports unauthenticated when neither store holds credentials", async () => {
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
	})

	it("reports authenticated when config.json holds an API key", async () => {
		writeApiKey("castai_v1_token", configPath)
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
	})

	it("keeps an observed API-key rejection after a process restart", async () => {
		writeApiKey("castai_v1_dead", configPath)
		markCredentialStale("castai_v1_dead", "kimchi-dev")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })

		await expect(authStatusInNewProcess(paths)).resolves.toEqual({ authenticated: false })
	})

	it("reports the environment override as authenticated without a saved login", async () => {
		vi.stubEnv("KIMCHI_API_KEY", "environment-key")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
	})

	it("reports unauthenticated again after the API key is cleared", async () => {
		writeApiKey("castai_v1_token", configPath)
		clearApiKey(configPath)
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
	})

	// Regression: the subscription OAuth login persists credentials only to
	// auth.json — it never writes config.json's apiKey — so an auth check
	// that reads only the config file reports authenticated: false for a
	// logged-in user. Seed the canonical OAuth credential shape
	// ({ type: "oauth", access, refresh, expires }) — malformed entries are
	// dropped by the credential reader.
	it("reports authenticated when only auth.json holds OAuth credentials", async () => {
		writeOAuthCredential("token")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
	})

	it("keeps an observed OAuth rejection after a process restart", async () => {
		writeOAuthCredential("dead-oauth-token")
		markCredentialStale(undefined, "kimchi-dev")
		markCredentialStale("dead-oauth-token", "kimchi-dev")
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })

		await expect(authStatusInNewProcess(paths)).resolves.toEqual({ authenticated: false })
	})

	it("does not apply a previous OAuth rejection to a new login", async () => {
		writeOAuthCredential("dead-oauth-token")
		markCredentialStale("dead-oauth-token", "kimchi-dev")

		writeOAuthCredential("fresh-oauth-token")
		await expect(authStatusInNewProcess(paths)).resolves.toEqual({ authenticated: true })
	})

	function authStatusInNewProcess(paths: AuthStatusPaths): Promise<AuthStatusResponse> {
		const tsxCli = fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url))
		const moduleUrl = new URL("./auth-status.ts", import.meta.url).href
		const source = `import { handleAuthStatus } from ${JSON.stringify(moduleUrl)};
handleAuthStatus(JSON.parse(process.argv[2])).then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});`
		const scriptPath = join(dir, "auth-status-restart.mts")
		writeFileSync(scriptPath, source)
		const child = spawn(process.execPath, [tsxCli, scriptPath, JSON.stringify(paths)], {
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk
		})
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk
		})
		return new Promise((resolve, reject) => {
			child.once("error", reject)
			child.once("close", (code) => {
				if (code !== 0) {
					reject(new Error(`restarted auth-status process exited ${code}: ${stderr}`))
					return
				}
				try {
					resolve(JSON.parse(stdout) as AuthStatusResponse)
				} catch (error) {
					reject(error)
				}
			})
		})
	}

	function writeOAuthCredential(access: string): void {
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": { type: "oauth", access, refresh: "refresh", expires: Date.now() + 3600_000 },
			}),
		)
	}
})
