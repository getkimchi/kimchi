import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearApiKey, writeApiKey } from "../../../config.js"
import {
	isCredentialStale,
	markCredentialStale,
	resetCredentialStalenessForTests,
} from "../../../credential-staleness.js"
import { KIMCHI_PROVIDER_ID } from "../../../kimchi-provider.js"
import { type AuthStatusPaths, type AuthStatusResponse, handleAuthStatus } from "./auth-status.js"
import { fakeOAuthDeps } from "./oauth-test-utils.js"

type TokenResponder = (params: URLSearchParams) => { status: number; body: Record<string, unknown> }

const itStorePermissions = process.platform === "win32" || process.geteuid?.() === 0 ? it.skip : it

// Integration-style handler tests against the real credential store:
// config.json (API key) and auth.json (OAuth credentials) on real temp
// files — no config.js mocks — so the persist→read linkage is exercised.
describe("handleAuthStatus", () => {
	let dir: string
	let configPath: string
	let paths: AuthStatusPaths
	let tokenServer: ReturnType<typeof createServer> | undefined
	let tokenRequests: URLSearchParams[]

	beforeEach(() => {
		tokenServer = undefined
		tokenRequests = []
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

	afterEach(async () => {
		if (tokenServer) {
			tokenServer.closeAllConnections()
			await new Promise<void>((resolve) => tokenServer?.close(() => resolve()))
		}
		chmodSync(dir, 0o700)
		if (existsSync(paths.authPath)) chmodSync(paths.authPath, 0o600)
		resetCredentialStalenessForTests()
		vi.unstubAllEnvs()
		rmSync(dir, { recursive: true, force: true })
	})

	it("reports unauthenticated when neither store holds credentials", async () => {
		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
	})

	it("reports authenticated when config.json holds an API key without resolving OAuth", async () => {
		writeApiKey("castai_v1_token", configPath)
		writeOAuthCredential("expiring-token", { expires: Date.now() + 60_000 })
		const deps = fakeOAuthDeps()
		await expect(handleAuthStatus(paths, deps)).resolves.toEqual({ authenticated: true })
		expect(deps.refreshCalls).toHaveLength(0)
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

	it("refreshes an expiring OAuth credential once and persists it before reporting authenticated", async () => {
		const tokenUrl = await startTokenEndpoint(() => ({
			status: 200,
			body: { access_token: "refreshed-token", expires_in: 3600 },
		}))
		writeOAuthCredential("expiring-token", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})

		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: true })
		expect(tokenRequests).toHaveLength(1)
		expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token")
		expect(tokenRequests[0]?.get("refresh_token")).toBe("refresh")
		expect(tokenRequests[0]?.get("client_id")).toBe("fake-client")
		const persisted = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
		expect(persisted[KIMCHI_PROVIDER_ID]).toMatchObject({ access: "refreshed-token", refresh: "refresh" })
		expect(persisted[KIMCHI_PROVIDER_ID]?.expires).toBeGreaterThan(Date.now() + 50 * 60_000)
	})

	it("does not refresh an OAuth credential outside the five-minute window", async () => {
		writeOAuthCredential("fresh-token")
		const deps = fakeOAuthDeps()
		await expect(handleAuthStatus(paths, deps)).resolves.toEqual({ authenticated: true })
		expect(deps.refreshCalls).toHaveLength(0)
	})

	it("reports unauthenticated when the issuer definitively rejects the refresh grant", async () => {
		const tokenUrl = await startTokenEndpoint(() => ({
			status: 400,
			body: { error: "invalid_grant", error_description: "refresh token revoked" },
		}))
		writeOAuthCredential("revoked-token", {
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
		})

		await expect(handleAuthStatus(paths)).resolves.toEqual({ authenticated: false })
		expect(tokenRequests).toHaveLength(1)
		expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token")
		expect(isCredentialStale("revoked-token", KIMCHI_PROVIDER_ID)).toBe(true)
	})

	it.each([
		"offline",
		"timeout",
		"issuer returned 500",
	])("rejects rather than signing out after a transient refresh failure: %s", async (failure) => {
		writeOAuthCredential("expiring-token", { expires: Date.now() + 60_000 })
		const deps = fakeOAuthDeps(() => {
			throw new Error(failure)
		})

		await expect(handleAuthStatus(paths, deps)).rejects.toMatchObject({ code: "oauth" })
		expect(isCredentialStale("expiring-token", KIMCHI_PROVIDER_ID)).toBe(false)
	})

	it("reports credential-store read failures instead of credential presence", async () => {
		writeFileSync(paths.authPath, "{corrupt")
		await expect(handleAuthStatus(paths, fakeOAuthDeps())).rejects.toMatchObject({ code: "auth" })
	})

	itStorePermissions("rejects when a refreshed credential cannot be persisted", async () => {
		writeOAuthCredential("expiring-token", { expires: Date.now() + 60_000 })
		const original = readFileSync(paths.authPath, "utf-8")
		const deps = fakeOAuthDeps((credential) => {
			chmodSync(paths.authPath, 0o400)
			chmodSync(dir, 0o500)
			return { ...credential, access: "must-not-be-used", expires: Date.now() + 3600_000 }
		})

		try {
			await expect(handleAuthStatus(paths, deps)).rejects.toMatchObject({ code: "auth" })
		} finally {
			chmodSync(dir, 0o700)
			chmodSync(paths.authPath, 0o600)
		}
		expect(readFileSync(paths.authPath, "utf-8")).toBe(original)
	})

	it("coalesces concurrent reads into one coherent persisted refresh", async () => {
		writeOAuthCredential("expiring-token", { expires: Date.now() + 60_000 })
		let finishRefresh!: () => void
		const refreshDelay = new Promise<void>((resolve) => {
			finishRefresh = resolve
		})
		const nextExpiry = Date.now() + 3600_000
		const deps = fakeOAuthDeps(async (credential) => {
			await refreshDelay
			return { ...credential, access: "refreshed-token", refresh: "rotated-refresh", expires: nextExpiry }
		})

		const first = handleAuthStatus(paths, deps)
		await vi.waitFor(() => expect(deps.refreshCalls).toHaveLength(1))
		const second = handleAuthStatus(paths, deps)
		finishRefresh()

		await expect(Promise.all([first, second])).resolves.toEqual([{ authenticated: true }, { authenticated: true }])
		expect(deps.refreshCalls).toHaveLength(1)
		const persisted = JSON.parse(readFileSync(paths.authPath, "utf-8")) as Record<string, Record<string, unknown>>
		expect(persisted[KIMCHI_PROVIDER_ID]).toMatchObject({
			access: "refreshed-token",
			refresh: "rotated-refresh",
			expires: nextExpiry,
		})
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

	async function startTokenEndpoint(respond: TokenResponder): Promise<string> {
		const server = createServer((request, response) => {
			if (request.method !== "POST") {
				response.writeHead(404).end()
				return
			}
			let body = ""
			request.setEncoding("utf-8")
			request.on("data", (chunk: string) => {
				body += chunk
			})
			request.on("end", () => {
				const params = new URLSearchParams(body)
				tokenRequests.push(params)
				const result = respond(params)
				response.writeHead(result.status, { "content-type": "application/json" })
				response.end(JSON.stringify(result.body))
			})
		})
		tokenServer = server
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", resolve)
		})
		const address = server.address() as AddressInfo
		return `http://127.0.0.1:${address.port}/oauth/token`
	}

	function writeOAuthCredential(access: string, overrides: Record<string, unknown> = {}): void {
		writeFileSync(
			paths.authPath,
			JSON.stringify({
				"kimchi-dev": {
					type: "oauth",
					access,
					refresh: "refresh",
					expires: Date.now() + 3600_000,
					...overrides,
				},
			}),
		)
	}
})
