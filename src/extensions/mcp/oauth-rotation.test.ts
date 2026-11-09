import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * OAuth refresh-token rotation against the MCP fixture server
 * (scenario `oauth-rotating-refresh`: every accepted refresh grant retires the
 * presented token and mints a new one; retired tokens are rejected with the
 * invalid_grant description the production server sends).
 *
 * The race under test: two sessions share one stored credential entry (the
 * agent dir is per-user). Session A refreshes first and the server rotates the
 * refresh token; session B still holds a cached entry with the retired token.
 * B's refresh grant must use the current token from shared storage — not the
 * retired one — or B needlessly demands a full browser re-auth.
 *
 * Everything runs through one compiled adapter module graph, matching
 * production's single per-process credential-entry cache. Store-side truth
 * after the other session rotates is observed via the fixture's event log and
 * the rotating child's exit status, never through this process's cache.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const FIXTURE_SCRIPT = join(REPO_ROOT, "tests/e2e/mcp/fixture-server.mjs")
// The adapter's auth-flow orchestration is not on the package's public
// subpaths; the test drives the same compiled modules the adapter runs.
const FLOW_MODULE = "../../../node_modules/pi-mcp-adapter/dist/mcp-auth-flow.js" as const
const AUTH_MODULE = "../../../node_modules/pi-mcp-adapter/dist/mcp-auth.js" as const

const STORAGE = { credentialStore: "encrypted-file" } as const

interface FixtureHandle {
	origin: string
	serverUrl: string
	eventsPath: string
	child: ChildProcess
	tmpDir: string
	cleanup: () => void
}

type FixtureEvent = Record<string, unknown> & { type: string }

function readEvents(eventsPath: string): FixtureEvent[] {
	if (!existsSync(eventsPath)) return []
	return readFileSync(eventsPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FixtureEvent)
}

async function waitForListeningEvent(eventsPath: string): Promise<string> {
	const deadline = Date.now() + 10_000
	while (Date.now() < deadline) {
		const listening = readEvents(eventsPath).find((event) => event.type === "http_listening")
		if (listening) {
			const url = listening.url
			if (typeof url === "string") return new URL(url).origin
		}
		await delay(100)
	}
	throw new Error(`fixture never reported http_listening (events at ${eventsPath})`)
}

async function spawnFixture(): Promise<FixtureHandle> {
	const tmpDir = mkdtempSync(join(tmpdir(), "oauth-rotation-"))
	const eventsPath = join(tmpDir, "events.jsonl")
	const child = spawn(process.execPath, [FIXTURE_SCRIPT], {
		env: {
			...process.env,
			KIMCHI_MCP_FIXTURE_TRANSPORT: "http",
			KIMCHI_MCP_FIXTURE_OAUTH: "1",
			KIMCHI_MCP_FIXTURE_SCENARIO: "oauth-rotating-refresh",
			KIMCHI_MCP_FIXTURE_EVENTS: eventsPath,
		},
		stdio: "ignore",
	})
	const origin = await waitForListeningEvent(eventsPath)
	return {
		origin,
		serverUrl: `${origin}/mcp`,
		eventsPath,
		child,
		tmpDir,
		cleanup: () => {
			child.kill("SIGTERM")
			rmSync(tmpDir, { recursive: true, force: true })
		},
	}
}

/** Run one real authorization-code flow so the stored entry matches production. */
async function seedViaRealFlow(serverName: string, serverUrl: string, storage: typeof STORAGE): Promise<void> {
	const { startAuth, completeAuth } = await import(FLOW_MODULE)
	const { authorizationUrl } = await startAuth(serverName, serverUrl, undefined, { authStorageOptions: storage })
	const response = await fetch(authorizationUrl, { redirect: "manual" })
	const location = response.headers.get("location")
	if (!location) throw new Error(`authorize returned ${response.status} without a redirect`)
	const code = new URL(location).searchParams.get("code")
	if (!code) throw new Error(`authorize redirect carried no code: ${location}`)
	await completeAuth(serverName, code, { authStorageOptions: storage })
}

/** Spawn a second process (a separate credential-entry cache) that refreshes the shared token. */
async function rotateInOtherProcess(
	serverName: string,
	serverUrl: string,
	agentDir: string,
	fileKey: string,
): Promise<void> {
	// Plain node cannot load the package's TypeScript sources under node_modules,
	// so the child imports the compiled auth-flow module directly.
	const flowPath = join(REPO_ROOT, "node_modules/pi-mcp-adapter/dist/mcp-auth-flow.js")
	const script = `
const { getValidToken } = await import(process.env.CHILD_FLOW_PATH)
const tokens = await getValidToken(process.env.CHILD_SERVER_NAME, process.env.CHILD_SERVER_URL, {
	authStorageOptions: { credentialStore: "encrypted-file" },
})
console.log("CHILD_RESULT:" + JSON.stringify({ ok: tokens !== undefined }))
process.exit(tokens !== undefined ? 0 : 1)
`
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			CHILD_SERVER_NAME: serverName,
			CHILD_SERVER_URL: serverUrl,
			CHILD_FLOW_PATH: flowPath,
			PI_CODING_AGENT_DIR: agentDir,
			KIMCHI_CODING_AGENT_DIR: agentDir,
			PI_MCP_ADAPTER_OAUTH_FILE_KEY: fileKey,
		},
		stdio: ["ignore", "pipe", "pipe"] as const,
	})
	const { exitCode, output } = await new Promise<{ exitCode: number | null; output: string }>(
		(resolveExit, rejectExit) => {
			let collected = ""
			child.stdout?.on("data", (chunk: Buffer) => {
				collected += chunk.toString()
			})
			child.stderr?.on("data", (chunk: Buffer) => {
				collected += chunk.toString()
			})
			child.on("error", rejectExit)
			child.on("exit", (code) => resolveExit({ exitCode: code, output: collected }))
		},
	)
	if (exitCode !== 0) {
		throw new Error(`rotation child process failed (exit ${exitCode}): ${output.slice(0, 2000)}`)
	}
}

function refreshGrants(eventsPath: string): FixtureEvent[] {
	return readEvents(eventsPath).filter(
		(event) => event.type === "oauth_token_issued" && event.grantType === "refresh_token",
	)
}

function refreshRejections(eventsPath: string): FixtureEvent[] {
	return readEvents(eventsPath).filter((event) => event.type === "oauth_refresh_rejected")
}

describe("MCP OAuth refresh-token rotation", () => {
	let fixture: FixtureHandle | undefined
	let agentDir: string
	let fileKey: string
	const savedEnv: Record<string, string | undefined> = {}

	beforeEach(() => {
		const tmpDir = mkdtempSync(join(tmpdir(), "oauth-rotation-agent-"))
		agentDir = join(tmpDir, "agent")
		fileKey = randomBytes(32).toString("base64")
		for (const key of ["PI_CODING_AGENT_DIR", "KIMCHI_CODING_AGENT_DIR", "PI_MCP_ADAPTER_OAUTH_FILE_KEY"]) {
			savedEnv[key] = process.env[key]
		}
		process.env.PI_CODING_AGENT_DIR = agentDir
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = fileKey
	})

	afterEach(() => {
		fixture?.cleanup()
		fixture = undefined
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	})

	it("keeps rotating across sequential refresh grants in one session", { timeout: 30_000 }, async () => {
		fixture = await spawnFixture()
		const serverName = "oauth-rotation-happy"
		const { getValidToken } = await import(FLOW_MODULE)
		const { getAuthForUrl } = await import(AUTH_MODULE)
		await seedViaRealFlow(serverName, fixture.serverUrl, STORAGE)
		const seeded = await getAuthForUrl(serverName, fixture.serverUrl, STORAGE)
		expect(seeded?.tokens?.refreshToken).toBeDefined()

		// Expired: refresh grant accepted, rotation persisted, next grant uses the successor.
		await delay(1_200)
		const firstRotation = await getValidToken(serverName, fixture.serverUrl, { authStorageOptions: STORAGE })
		expect(firstRotation).toBeDefined()
		expect(firstRotation?.refreshToken).toBeDefined()
		expect(firstRotation?.refreshToken).not.toBe(seeded?.tokens?.refreshToken)
		const issued = refreshGrants(fixture.eventsPath)
		expect(issued).toHaveLength(1)
		expect(issued[0]?.rotated).toBe(true)

		// The successor token is itself single-use: the next refresh rotates again.
		await delay(1_200)
		const secondRotation = await getValidToken(serverName, fixture.serverUrl, { authStorageOptions: STORAGE })
		expect(secondRotation).toBeDefined()
		expect(secondRotation?.refreshToken).not.toBe(firstRotation?.refreshToken)
		expect(refreshGrants(fixture.eventsPath)).toHaveLength(2)
		expect(refreshRejections(fixture.eventsPath)).toEqual([])
	})

	it("adopts the token another process rotated into shared storage instead of demanding re-auth", {
		timeout: 30_000,
	}, async () => {
		fixture = await spawnFixture()
		const serverName = "oauth-rotation-race"
		const { getValidToken } = await import(FLOW_MODULE)
		await seedViaRealFlow(serverName, fixture.serverUrl, STORAGE)

		// The entry expires; another session refreshes first and the server rotates.
		// The child's exit status plus the fixture's rotated refresh grant are the
		// store-side proof of rotation.
		await delay(1_200)
		await rotateInOtherProcess(serverName, fixture.serverUrl, agentDir, fileKey)
		const issued = refreshGrants(fixture.eventsPath)
		expect(issued).toHaveLength(1)
		expect(issued[0]?.rotated).toBe(true)

		// This session's refresh must pick up the rotated token from shared storage.
		// Falling back to this process's cached retired token would be rejected
		// invalid_grant and push the session into a full browser re-auth.
		const adopted = await getValidToken(serverName, fixture.serverUrl, { authStorageOptions: STORAGE })
		expect(adopted).not.toBeNull()
		expect(adopted?.refreshToken).toBeDefined()
		expect(refreshRejections(fixture.eventsPath)).toEqual([])
	})
})
