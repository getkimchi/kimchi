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
 * adapter's compiled dist modules, so each process has its own
 * credential-entry cache, exactly like production sessions. Note the
 * artifact nuance: the package's exports resolve "." to the TypeScript
 * sources, so the runtime loads the .ts files — the dist modules driven here
 * are mirrors that must be kept behaviorally identical (the patch pipeline
 * regenerates both; re-verify mirror parity at every patch edit). This test
 * process only orchestrates and asserts on exit codes and the fixture's
 * event log. (Vitest's transformed in-process copy of the modules is NOT
 * equivalent to the compiled dist and must not be asserted on.)
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

async function spawnFixture(
	options: { scenario?: string; behavior?: Record<string, unknown> } = {},
): Promise<FixtureHandle> {
	const tmpDir = mkdtempSync(join(tmpdir(), "oauth-rotation-"))
	const eventsPath = join(tmpDir, "events.jsonl")
	const child = spawn(process.execPath, [FIXTURE_SCRIPT], {
		env: {
			...process.env,
			KIMCHI_MCP_FIXTURE_TRANSPORT: "http",
			KIMCHI_MCP_FIXTURE_OAUTH: "1",
			KIMCHI_MCP_FIXTURE_SCENARIO: options.scenario ?? "oauth-rotating-refresh",
			KIMCHI_MCP_FIXTURE_EVENTS: eventsPath,
			...(options.behavior === undefined
				? {}
				: { KIMCHI_MCP_FIXTURE_BEHAVIOR: JSON.stringify(options.behavior) }),
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

function isRotatedGrant(event: FixtureEvent): boolean {
	return event.type === "oauth_token_issued" && event.grantType === "refresh_token" && event.rotated === true
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

	it("recovers when another session rotates the token during this session's in-flight grant", {
		timeout: 60_000,
	}, async () => {
		// The fixture parks the first refresh grant, so a concurrent session's
		// grant rotates the token while the parked one is in flight and the
		// parked grant is then rejected invalid_grant as stale.
		fixture = await spawnFixture({ behavior: { delayFirstRefreshGrantMs: 3_000 } })
		const serverName = "oauth-rotation-retry"
		const envOptions = { agentDir, fileKey }
		await seedViaRealFlow(serverName, fixture.serverUrl, envOptions)
		await waitUntilExpired(serverName, fixture.serverUrl)

		// Both children refresh concurrently. Whichever grant is parked loses
		// the rotation race and is rejected; it must recover from shared storage
		// (poll, retry with the rotated token) instead of a full browser re-auth.
		process.env.CHILD_ROTATE_DELAY_MS = "0"
		try {
			await Promise.all([
				refreshWithStaleCache(serverName, fixture.serverUrl, envOptions, "delayed-grant loser"),
				(async () => {
					await delay(600)
					await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "rotator")
				})(),
			])
		} finally {
			delete process.env.CHILD_ROTATE_DELAY_MS
		}

		const events = readEvents(fixture.eventsPath)
		const rejectionIndex = events.findIndex((event) => event.type === "oauth_refresh_rejected")
		expect(rejectionIndex, eventSummary(fixture.eventsPath)).toBeGreaterThanOrEqual(0)
		const rejection = events[rejectionIndex]
		// The rejected grant presented a retired token, not a malformed one.
		expect(rejection.stale, eventSummary(fixture.eventsPath)).toBe(true)
		expect(rejection.presented, eventSummary(fixture.eventsPath)).not.toBe(rejection.current)
		// The winning grant rotated the token before the rejection…
		expect(events.slice(0, rejectionIndex).filter(isRotatedGrant).length, eventSummary(fixture.eventsPath)).toBe(1)
		// …and the loser's retry landed a rotated grant after it.
		expect(events.slice(rejectionIndex + 1).filter(isRotatedGrant).length, eventSummary(fixture.eventsPath)).toBe(1)
		// No session fell back to a full browser re-auth: only the seed
		// exchanged an authorization code.
		expect(
			events.filter((event) => event.type === "oauth_token_issued" && event.grantType === "authorization_code").length,
			eventSummary(fixture.eventsPath),
		).toBe(1)
	})

	it("adopts the token another process rotated while this session's cache was stale", { timeout: 60_000 }, async () => {
		fixture = await spawnFixture()
		const serverName = "oauth-rotation-race"
		const envOptions = { agentDir, fileKey }
		await seedViaRealFlow(serverName, fixture.serverUrl, envOptions)

		// The stale-cache child warms its process cache with the current token,
		// then sleeps while the rotator refreshes and the server rotates the
		// token. On wake its cached token is retired: the invalidate-before-read
		// refresh leg must re-read shared storage, so its grant presents the
		// rotated token and is accepted — with no stale rejection at all.
		await Promise.all([
			refreshWithStaleCache(serverName, fixture.serverUrl, envOptions, "stale-cache adoption"),
			(async () => {
				await delay(2_000)
				await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "rotator")
			})(),
		])

		// A stale presentation would appear as a rejected grant; none may happen.
		expect(refreshRejections(fixture.eventsPath), eventSummary(fixture.eventsPath)).toEqual([])
		// Both refreshes were accepted, and each rotated the token.
		expect(
			refreshGrants(fixture.eventsPath).filter(isRotatedGrant).length,
			eventSummary(fixture.eventsPath),
		).toBe(2)
	})

	it("keeps retrying while the token keeps rotating under the recovering session", { timeout: 90_000 }, async () => {
		// Parks refresh grants #1 and #3: the loser's initial grant and its
		// first retry each lose a rotation race to a concurrent session, so
		// recovery must follow the chain (adopt T2, rejected, adopt T3) instead
		// of giving up after one retry.
		fixture = await spawnFixture({ behavior: { delayRefreshGrantsAt: [1, 3], delayRefreshGrantMs: 4_000 } })
		const serverName = "oauth-rotation-chain"
		const envOptions = { agentDir, fileKey }
		await seedViaRealFlow(serverName, fixture.serverUrl, envOptions)
		await waitUntilExpired(serverName, fixture.serverUrl)

		process.env.CHILD_ROTATE_DELAY_MS = "0"
		try {
			await Promise.all([
				refreshWithStaleCache(serverName, fixture.serverUrl, envOptions, "chained-rotation loser"),
				(async () => {
					await delay(600)
					await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "rotator-1")
				})(),
				(async () => {
					await delay(5_000)
					await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "rotator-2")
				})(),
			])
		} finally {
			delete process.env.CHILD_ROTATE_DELAY_MS
		}

		const rejections = refreshRejections(fixture.eventsPath)
		// Both of the loser's grants were rejected as stale.
		expect(rejections.length, eventSummary(fixture.eventsPath)).toBe(2)
		expect(rejections[0].stale, eventSummary(fixture.eventsPath)).toBe(true)
		expect(rejections[1].stale, eventSummary(fixture.eventsPath)).toBe(true)
		// The chain: the second rejection presented the token the first
		// rotation minted — the retry used the adopted token, not the original.
		expect(rejections[1].presented, eventSummary(fixture.eventsPath)).toBe(rejections[0].current)
		// Three rotations: rotator-1, rotator-2, and the loser's final retry.
		expect(
			refreshGrants(fixture.eventsPath).filter(isRotatedGrant).length,
			eventSummary(fixture.eventsPath),
		).toBe(3)
		// No session fell back to a full browser re-auth: only the seed
		// exchanged an authorization code.
		expect(
			readEvents(fixture.eventsPath).filter(
				(event) => event.type === "oauth_token_issued" && event.grantType === "authorization_code",
			).length,
			eventSummary(fixture.eventsPath),
		).toBe(1)
	})

	it("logs a distinguishable miss when a rejected grant has no rotation to adopt", { timeout: 60_000 }, async () => {
		// The revoked scenario rejects every refresh grant and rotates nothing,
		// so recovery must miss: the child fails, and its output carries the
		// distinct miss line instead of only a generic refresh failure.
		fixture = await spawnFixture({ scenario: "oauth-refresh-revoked" })
		const serverName = "oauth-rotation-miss"
		const envOptions = { agentDir, fileKey }
		await seedViaRealFlow(serverName, fixture.serverUrl, envOptions)
		await waitUntilExpired(serverName, fixture.serverUrl)

		let failure: Error | undefined
		try {
			await getTokensInChildProcess(serverName, fixture.serverUrl, envOptions, "revoked-refresh child")
		} catch (error) {
			failure = error as Error
		}
		expect(failure, "the child must fail: the token is revoked").toBeInstanceOf(Error)
		expect(
			failure?.message.includes("no rotated token appeared in shared storage; re-auth required"),
			String(failure?.message).slice(0, 500),
		).toBe(true)
	})
})
