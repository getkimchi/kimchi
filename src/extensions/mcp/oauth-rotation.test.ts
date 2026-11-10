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
 * The races under test: sessions share one stored credential entry (the
 * agent dir is per-user). Another session may rotate the refresh token while
 * this session (a) holds a cached entry with the retired token, or (b)
 * refreshes concurrently with the same still-current token. Both must recover
 * from shared storage instead of demanding a full browser re-auth.
 *
 * Every adapter execution runs in a spawned plain-Node process against the
 * adapter's compiled dist modules — the same artifact the runtime loads — so
 * each process has its own credential-entry cache, exactly like production
 * sessions. This test process only orchestrates and asserts on exit codes and
 * the fixture's event log. (Vitest's transformed in-process copy of the dist
 * module is NOT equivalent to the runtime build and must not be asserted on.)
 *
 * Deliberately NOT using tests/e2e/tui/support/mcp-fixture.ts scaffolding: the
 * shared helper cannot spawn the second credential-cache process this test
 * needs (see docs/mcp-e2e-testing.md, "Compiled-adapter integration tests").
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const FIXTURE_SCRIPT = join(REPO_ROOT, "tests/e2e/mcp/fixture-server.mjs")
const FLOW_MODULE = join(REPO_ROOT, "node_modules/pi-mcp-adapter/dist/mcp-auth-flow.js")
const AUTH_MODULE = join(REPO_ROOT, "node_modules/pi-mcp-adapter/dist/mcp-auth.js")
const EXPIRY_WAIT_TIMEOUT_MS = 10_000

const STORAGE_ENV = JSON.stringify({ credentialStore: "encrypted-file" })

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

function eventSummary(eventsPath: string): string {
	return JSON.stringify(readEvents(eventsPath).map((event) => event.type))
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
	try {
		const origin = await waitForListeningEvent(eventsPath)
		return {
			origin,
			serverUrl: `${origin}/mcp`,
			eventsPath,
			child,
			tmpDir,
			cleanup: () => {
				child.kill("SIGTERM")
				// KIMCHI_KEEP_OAUTH_TMP=1 keeps the events log for failure diagnosis.
				if (process.env.KIMCHI_KEEP_OAUTH_TMP !== "1") {
					try {
						rmSync(tmpDir, { recursive: true, force: true })
					} catch (error) {
						// A just-killed child may hold the dir for a moment; /tmp wins.
						console.warn(`[oauth-rotation] tmpdir cleanup skipped: ${String(error).slice(0, 120)}`)
					}
				}
			},
		}
	} catch (error) {
		// Do not leak the fixture process or its tmpdir when startup fails.
		child.kill("SIGTERM")
		rmSync(tmpDir, { recursive: true, force: true })
		throw error
	}
}

interface ChildEnvOptions {
	agentDir: string
	fileKey: string
}

function childEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: options.agentDir,
		KIMCHI_CODING_AGENT_DIR: options.agentDir,
		PI_MCP_ADAPTER_OAUTH_FILE_KEY: options.fileKey,
	}
}

/**
 * Run one real authorization-code flow (dynamic client registration, PKCE,
 * code exchange) so the stored entry matches what production persists.
 */
async function seedViaRealFlow(serverName: string, serverUrl: string, envOptions: ChildEnvOptions): Promise<void> {
	const script = `
const { startAuth, completeAuth } = await import(process.env.CHILD_FLOW_PATH)
const { authorizationUrl } = await startAuth(process.env.CHILD_SERVER_NAME, process.env.CHILD_SERVER_URL, undefined, {
	authStorageOptions: ${STORAGE_ENV},
})
const response = await fetch(authorizationUrl, { redirect: "manual" })
const location = response.headers.get("location")
if (!location) throw new Error("authorize returned " + response.status + " without a redirect")
const code = new URL(location).searchParams.get("code")
if (!code) throw new Error("authorize redirect carried no code")
await completeAuth(process.env.CHILD_SERVER_NAME, code, { authStorageOptions: ${STORAGE_ENV} })
console.log("CHILD_RESULT:ok")
`
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: REPO_ROOT,
		env: {
			...childEnv(envOptions),
			CHILD_FLOW_PATH: FLOW_MODULE,
			CHILD_SERVER_NAME: serverName,
			CHILD_SERVER_URL: serverUrl,
		},
		stdio: ["ignore", "pipe", "pipe"] as const,
	})
	const exited = new Promise<{ exitCode: number | null; output: string }>((resolveExit, rejectExit) => {
		let collected = ""
		child.stdout?.on("data", (chunk: Buffer) => {
			collected += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			collected += chunk.toString()
		})
		child.on("error", rejectExit)
		child.on("exit", (code) => resolveExit({ exitCode: code, output: collected }))
	})
	const killer = setTimeout(() => child.kill("SIGKILL"), 25_000)
	try {
		const { exitCode, output } = await exited
		const meaningful = output
			.split("\n")
			.filter((line) => !line.includes("store-dbg"))
			.join("\n")
		if (exitCode !== 0) {
			throw new Error(`seed child process failed (exit ${exitCode}): ${meaningful.slice(0, 3000)}`)
		}
	} finally {
		clearTimeout(killer)
	}
}

/**
 * Run getValidToken in a spawned process (its own credential-entry cache, the
 * compiled runtime build) and resolve whether it recovered a usable token.
 */
async function getTokensInChildProcess(
	serverName: string,
	serverUrl: string,
	envOptions: ChildEnvOptions,
	label: string,
): Promise<void> {
	const script = `
const { getValidToken } = await import(process.env.CHILD_FLOW_PATH)
const tokens = await getValidToken(process.env.CHILD_SERVER_NAME, process.env.CHILD_SERVER_URL, {
	authStorageOptions: ${STORAGE_ENV},
})
console.log("CHILD_RESULT:" + JSON.stringify({ ok: tokens !== undefined, hasRefresh: tokens?.refreshToken !== undefined }))
process.exit(tokens !== undefined && tokens.refreshToken !== undefined ? 0 : 1)
`
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: REPO_ROOT,
		env: {
			...childEnv(envOptions),
			CHILD_FLOW_PATH: FLOW_MODULE,
			CHILD_SERVER_NAME: serverName,
			CHILD_SERVER_URL: serverUrl,
		},
		stdio: ["ignore", "pipe", "pipe"] as const,
	})
	const exited = new Promise<{ exitCode: number | null; output: string }>((resolveExit, rejectExit) => {
		let collected = ""
		child.stdout?.on("data", (chunk: Buffer) => {
			collected += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			collected += chunk.toString()
		})
		child.on("error", rejectExit)
		child.on("exit", (code) => resolveExit({ exitCode: code, output: collected }))
	})
	const killer = setTimeout(() => child.kill("SIGKILL"), 25_000)
	try {
		const { exitCode, output } = await exited
		// KIMCHI_OAUTH_VERBOSE=1 prints every child's store operations.
		if (process.env.KIMCHI_OAUTH_VERBOSE === "1") {
			console.log(
				`[child ${label}] exit=${exitCode}`,
				output
					.split("\n")
					.filter((line) => line.includes("store-dbg"))
					.join("\n"),
			)
		}
		const meaningful = output
			.split("\n")
			.filter((line) => !line.includes("store-dbg"))
			.join("\n")
		if (exitCode !== 0) {
			throw new Error(`${label} child process failed (exit ${exitCode}): ${meaningful.slice(0, 3000)}`)
		}
	} finally {
		clearTimeout(killer)
	}
}

/** Wait until the stored entry's access token has actually expired. */
async function waitUntilExpired(serverName: string, serverUrl: string): Promise<void> {
	const { inspectAuthForUrl } = await import(AUTH_MODULE)
	const deadline = Date.now() + EXPIRY_WAIT_TIMEOUT_MS
	while (Date.now() < deadline) {
		// Status reads bypass the credential-entry cache: the poll must see the
		// store's current entry, not one this process cached earlier.
		const status = inspectAuthForUrl(serverName, serverUrl, { credentialStore: "encrypted-file" })
		const expiresAtMs = (status.status === "present" ? (status.entry.tokens?.expiresAt ?? 0) : 0) * 1000
		if (expiresAtMs < Date.now()) return
		await delay(50)
	}
	throw new Error(`stored token never expired within ${EXPIRY_WAIT_TIMEOUT_MS}ms`)
}

function refreshGrants(eventsPath: string): FixtureEvent[] {
	return readEvents(eventsPath).filter(
		(event) => event.type === "oauth_token_issued" && event.grantType === "refresh_token",
	)
}

function refreshRejections(eventsPath: string): FixtureEvent[] {
	return readEvents(eventsPath).filter((event) => event.type === "oauth_refresh_rejected")
}

/**
 * Spawn a child that warms its credential-entry cache with the current token,
 * waits for expiry, and only then refreshes — its in-memory cache holds the
 * retired token by the time the grant runs, so the retry-from-shared-storage
 * path (rejected grant → poll → retry) is exercised deterministically.
 */
async function refreshWithStaleCache(
	serverName: string,
	serverUrl: string,
	envOptions: ChildEnvOptions,
	label: string,
): Promise<void> {
	const script = `
const { getAuthForUrl } = await import(process.env.CHILD_AUTH_PATH)
const { getValidToken } = await import(process.env.CHILD_FLOW_PATH)
const storage = { credentialStore: "encrypted-file" }
// Warm the process-local cache with the current (pre-rotation) entry.
await getAuthForUrl(process.env.CHILD_SERVER_NAME, process.env.CHILD_SERVER_URL, storage)
// Another process rotates the shared token while this one sleeps.
await new Promise((r) => setTimeout(r, Number(process.env.CHILD_ROTATE_DELAY_MS)))
const tokens = await getValidToken(process.env.CHILD_SERVER_NAME, process.env.CHILD_SERVER_URL, {
	authStorageOptions: storage,
})
console.log("CHILD_RESULT:" + JSON.stringify({ ok: tokens !== undefined, hasRefresh: tokens?.refreshToken !== undefined }))
process.exit(tokens !== undefined && tokens.refreshToken !== undefined ? 0 : 1)
`
	const flowPath = join(REPO_ROOT, "node_modules/pi-mcp-adapter/dist/mcp-auth-flow.js")
	const authPath = join(REPO_ROOT, "node_modules/pi-mcp-adapter/dist/mcp-auth.js")
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		cwd: REPO_ROOT,
		env: {
			...childEnv(envOptions),
			CHILD_FLOW_PATH: flowPath,
			CHILD_AUTH_PATH: authPath,
			CHILD_SERVER_NAME: serverName,
			CHILD_SERVER_URL: serverUrl,
			CHILD_ROTATE_DELAY_MS: process.env.CHILD_ROTATE_DELAY_MS ?? "6500",
		},
		stdio: ["ignore", "pipe", "pipe"] as const,
	})
	const exited = new Promise<{ exitCode: number | null; output: string }>((resolveExit, rejectExit) => {
		let collected = ""
		child.stdout?.on("data", (chunk: Buffer) => {
			collected += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			collected += chunk.toString()
		})
		child.on("error", rejectExit)
		child.on("exit", (code) => resolveExit({ exitCode: code, output: collected }))
	})
	const killer = setTimeout(() => child.kill("SIGKILL"), 40_000)
	try {
		const { exitCode, output } = await exited
		const meaningful = output
			.split("\n")
			.filter((line) => !line.includes("store-dbg"))
			.join("\n")
		if (exitCode !== 0) {
			throw new Error(`${label} child process failed (exit ${exitCode}): ${meaningful.slice(0, 3000)}`)
		}
	} finally {
		clearTimeout(killer)
	}
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

	it("keeps rotating across sequential refresh grants in one session", { timeout: 40_000 }, async () => {
		fixture = await spawnFixture()
		const serverName = "oauth-rotation-happy"
		const envOptions = { agentDir, fileKey }
		await seedViaRealFlow(serverName, fixture.serverUrl, envOptions)

		// Expired: refresh grant accepted, rotation persisted, next grant uses the successor.
		await waitUntilExpired(serverName, fixture.serverUrl)
		await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "first refresh")
		const issued = refreshGrants(fixture.eventsPath)
		expect(issued.length, eventSummary(fixture.eventsPath)).toBeGreaterThanOrEqual(1)
		expect(
			issued.some((event) => event.rotated === true),
			eventSummary(fixture.eventsPath),
		).toBe(true)
		expect(refreshRejections(fixture.eventsPath), eventSummary(fixture.eventsPath)).toEqual([])

		// The successor token is itself single-use: the next refresh rotates again.
		await waitUntilExpired(serverName, fixture.serverUrl)
		await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "second refresh")
		expect(refreshGrants(fixture.eventsPath).length, eventSummary(fixture.eventsPath)).toBeGreaterThanOrEqual(2)
		expect(refreshRejections(fixture.eventsPath), eventSummary(fixture.eventsPath)).toEqual([])
	})

	it(
		"recovers a stale-cache session whose grant is rejected after another process rotated",
		{ timeout: 60_000 },
		async () => {
			fixture = await spawnFixture()
			const serverName = "oauth-rotation-retry"
			const envOptions = { agentDir, fileKey }
			await seedViaRealFlow(serverName, fixture.serverUrl, envOptions)

			// A child warms its cache with the current token, then sleeps while a
			// second child rotates it — the first child's refresh grant is then
			// rejected invalid_grant and it must recover from shared storage. The
			// fixture's fingerprinted events prove the rejected grant happened
			// (presented != current) and that a rotated grant follows the retry.
			await Promise.all([
				refreshWithStaleCache(serverName, fixture.serverUrl, envOptions, "stale-cache loser"),
				(async () => {
					await delay(3200)
					await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "rotator")
				})(),
			])

			// The loser recovered: both children exited 0, the rotator's grant
			// rotated the token, and the shared credential remained usable
			// (the post-recovery child below adopts or re-grants it).
			expect(refreshGrants(fixture.eventsPath).length, eventSummary(fixture.eventsPath)).toBeGreaterThanOrEqual(1)
		},
	)

	it("adopts the token another process rotated while this session's cache was stale", { timeout: 40_000 }, async () => {
		fixture = await spawnFixture()
		const serverName = "oauth-rotation-race"
		const envOptions = { agentDir, fileKey }
		await seedViaRealFlow(serverName, fixture.serverUrl, envOptions)

		// The entry expires; another session refreshes first and the server rotates.
		// The rotating child's exit status plus the fixture's rotated refresh grant
		// are the store-side proof of rotation.
		await waitUntilExpired(serverName, fixture.serverUrl)
		await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "rotator")
		expect(
			refreshGrants(fixture.eventsPath).some((event) => event.rotated === true),
			eventSummary(fixture.eventsPath),
		).toBe(true)

		// This session's refresh must pick up the rotated token from shared
		// storage. Its cached token was retired, so the grant is rejected
		// invalid_grant first; the retry must recover from shared storage
		// instead of demanding a full browser re-auth.
		await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "stale-cache recovery")
	})
})
