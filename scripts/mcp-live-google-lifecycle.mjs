#!/usr/bin/env node
/**
 * Live Google OAuth renewal check.
 *
 * Proves, against a real Google-backed MCP server with a stored refresh
 * token, that an expired access token is renewed silently: the probe
 * reconnects and lists tools, no browser consent is opened, and the stored
 * token's expiry advances. This is the acceptance check for the two
 * user-visible criteria the hermetic suite cannot prove against Google
 * itself (silent renewal; no forced re-authentication after expiry).
 *
 * Provisioned through the environment:
 *   GOOGLE_MCP_TEST_CLIENT_ID       OAuth client id (public)
 *   GOOGLE_MCP_TEST_CLIENT_SECRET   OAuth client secret (secret)
 *   GOOGLE_MCP_TEST_REFRESH_TOKEN   a refresh token issued to the test
 *                                   account (secret; see
 *                                   docs/mcp-live-testing-setup.md)
 *   GOOGLE_MCP_TEST_SERVER          optional server URL (defaults to the
 *                                   Gmail MCP server)
 *   GOOGLE_MCP_TEST_ISSUER          optional expected issuer (defaults to
 *                                   Google's accounts issuer)
 *   GOOGLE_MCP_TEST_CALL_TOOL       optional read-only tool to invoke after
 *                                   renewal (defaults to list_labels)
 *   GOOGLE_MCP_TEST_CALL_ARGS       optional JSON object of its arguments
 *   GOOGLE_MCP_TEST_EXPECTED_SCOPE  optional scope the renewed credential
 *                                   must still carry
 *
 * The check runs two renewal cycles: the first proves the seeded (expired)
 * token renews silently and one real tool call returns data; the second
 * force-expires the refreshed token and proves the renewed credential itself
 * renews again — so a corrupted stored-credential rewrite cannot hide behind
 * the first refresh. The stored scope is asserted so a silently narrowed
 * grant fails here, not later when a tool stops working.
 *
 * The refresh token never appears in output: only booleans, tool counts,
 * and expiry timestamps are printed. The child's stderr is captured and,
 * on failure, printed only after redacting token-shaped values. The run
 * uses an isolated HOME and a file-backed credential store, so nothing
 * touches the OS keychain.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BINARY, countBrowserOpens, probeChildEnv, writeRecordingBrowserDriver } from "./mcp-live-support.mjs"

const SERVER_NAME = "gmail-live-check"
const DEFAULT_SERVER = "https://gmailmcp.googleapis.com/mcp/v1"
const DEFAULT_ISSUER = "https://accounts.google.com"
const DEFAULT_CALL_TOOL = "list_labels"

// The secret-bearing temp HOME is removed in `finally` on the normal path and
// from signal handlers so an interrupted run never leaves it in the tmpdir.
let activeHomeDir = null
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		if (activeHomeDir !== null) rmSync(activeHomeDir, { recursive: true, force: true })
		process.exit(130)
	})

/** File-backed keyring entry path for one server name (FileBackedTestEntry layout). */
function keyringEntryPath(keyringDir, serverName) {
	const account = `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`
	const key = createHash("sha256").update(`dev.kimchi.mcp.oauth\0${account}`, "utf8").digest("hex")
	return join(keyringDir, key)
}

/** Seed the stored OAuth credential for the server: expired access token + valid refresh token. */
function seedCredential(keyringDir, { serverUrl, issuer, clientId, clientSecret, refreshToken }) {
	mkdirSync(keyringDir, { recursive: true })
	const entry = {
		serverUrl,
		tokens: {
			accessToken: "kimchi-live-seed-expired-access-token",
			refreshToken,
			expiresAt: Math.floor(Date.now() / 1000) - 600,
			issuer,
		},
		clientInfo: {
			clientId,
			clientSecret,
			issuer,
			redirectUris: ["http://localhost:19876/callback", "http://127.0.0.1:19876/callback"],
		},
	}
	writeFileSync(keyringEntryPath(keyringDir, SERVER_NAME), JSON.stringify(entry), {
		encoding: "utf-8",
		mode: 0o600,
	})
}

/** Read back the stored credential entry (null when absent or unparsable). */
function readStoredCredential(keyringDir) {
	try {
		return JSON.parse(readFileSync(keyringEntryPath(keyringDir, SERVER_NAME), "utf-8"))
	} catch {
		return null
	}
}

/** Force the stored credential's access token back into the past for a second renewal cycle. */
function forceExpiry(keyringDir) {
	const entry = readStoredCredential(keyringDir)
	if (!entry?.tokens) return false
	entry.tokens.expiresAt = Math.floor(Date.now() / 1000) - 600
	writeFileSync(keyringEntryPath(keyringDir, SERVER_NAME), JSON.stringify(entry), {
		encoding: "utf-8",
		mode: 0o600,
	})
	return true
}

/** Redact token-shaped values from child output before it reaches a (public) log. */
function redactChildOutput(text) {
	return text
		.replace(/"(access_token|refresh_token|client_secret|code|code_verifier)"\s*:\s*"[^"]*"/g, '"$1":"<redacted>"')
		.replace(/[A-Za-z0-9_-]{80,}/g, "<redacted>")
		.slice(-2_000)
}

/** Run `kimchi mcp probe` against the server and return its parsed result. */
async function runProbe({ homeDir, binDir, serverUrl, clientId, clientSecret, call, timeoutMs = 90_000 }) {
	const { urlLog } = writeRecordingBrowserDriver(binDir)
	const probeArgs = ["mcp", "probe", "--json"]
	if (call) {
		probeArgs.push("--call", call.tool)
		probeArgs.push("--args", JSON.stringify(call.args ?? {}))
	}
	const child = spawn(BINARY, probeArgs, {
		env: probeChildEnv({ homeDir, binDir }),
		stdio: ["pipe", "pipe", "pipe"],
	})
	const stdout = []
	const stderr = []
	child.stdout.on("data", (chunk) => stdout.push(String(chunk)))
	child.stderr.on("data", (chunk) => stderr.push(String(chunk)))
	child.stdin.end(
		`${JSON.stringify({ name: SERVER_NAME, server: { url: serverUrl, auth: "oauth", oauth: { clientId, clientSecret } } })}\n`,
	)
	const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })))
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
	}, timeoutMs)
	try {
		const outcome = await exited
		let result
		try {
			result = JSON.parse(stdout.join("").trim())
		} catch {
			result = null
		}
		if (timedOut) outcome.timedOut = true
		return {
			result,
			exit: outcome,
			childOutput: stderr.join(""),
			browserOpens: countBrowserOpens(urlLog),
		}
	} finally {
		clearTimeout(timer)
	}
}

/** Assess one renewal cycle: returns the failure list (empty = pass). */
function assessProbe(label, { result, exit, browserOpens }, keyringDir, { expectedScope, callRequested }) {
	const toolCount = Array.isArray(result?.tools) ? result.tools.length : 0
	const failures = []
	if (result?.call && !result.call.ok) failures.push(`tool call failed: ${result.call.error}`)
	else if (exit.timedOut) failures.push(`probe timed out after its budget`)
	else if (exit.code !== 0 || result === null)
		failures.push(`probe did not complete (exit=${exit.code ?? exit.signal})`)
	if (result?.error) failures.push(`probe error: ${result.error}`)
	if (toolCount === 0) failures.push("probe listed no tools")
	if (callRequested && result?.call?.ok && !result.call.content) failures.push("tool call returned empty content")
	if (browserOpens > 0) failures.push(`${browserOpens} browser consent(s) opened — renewal was not silent`)
	const stored = readStoredCredential(keyringDir)
	if (!stored?.tokens?.expiresAt) failures.push("stored credential has no expiry after the probe")
	else if (stored.tokens.expiresAt <= Date.now() / 1000 + 60)
		failures.push(`stored expiry did not advance past now (expiresAt=${stored.tokens.expiresAt})`)
	if (stored?.tokens?.accessToken === "kimchi-live-seed-expired-access-token")
		failures.push("stored access token is still the seeded expired value")
	if (!stored?.tokens?.scope) failures.push("stored credential has no scope after renewal")
	else if (expectedScope && !stored.tokens.scope.split(" ").includes(expectedScope))
		failures.push(`stored scope is missing ${expectedScope} (granted: ${stored.tokens.scope})`)
	console.log(
		`${label}: exit=${exit.code ?? exit.signal} tools=${toolCount} browserOpens=${browserOpens} ` +
			`call=${result?.call ? (result.call.ok ? "ok" : "failed") : "off"} storedExpiresAt=${stored?.tokens?.expiresAt ?? "absent"}`,
	)
	if (failures.length > 0 && toolCount > 0)
		console.error(`available tools: ${result.tools.map((tool) => tool.name).join(", ")}`)
	return failures
}

async function main() {
	const clientId = process.env.GOOGLE_MCP_TEST_CLIENT_ID
	const clientSecret = process.env.GOOGLE_MCP_TEST_CLIENT_SECRET
	const refreshToken = process.env.GOOGLE_MCP_TEST_REFRESH_TOKEN
	const serverUrl = process.env.GOOGLE_MCP_TEST_SERVER ?? DEFAULT_SERVER
	const issuer = process.env.GOOGLE_MCP_TEST_ISSUER ?? DEFAULT_ISSUER
	const expectedScope = process.env.GOOGLE_MCP_TEST_EXPECTED_SCOPE
	const callTool = process.env.GOOGLE_MCP_TEST_CALL_TOOL ?? DEFAULT_CALL_TOOL
	let callArgs = {}
	if (process.env.GOOGLE_MCP_TEST_CALL_ARGS !== undefined) {
		try {
			const parsed = JSON.parse(process.env.GOOGLE_MCP_TEST_CALL_ARGS)
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object")
			callArgs = parsed
		} catch {
			console.error("GOOGLE_MCP_TEST_CALL_ARGS must be a JSON object")
			return 1
		}
	}
	for (const [name, value] of [
		["GOOGLE_MCP_TEST_CLIENT_ID", clientId],
		["GOOGLE_MCP_TEST_CLIENT_SECRET", clientSecret],
		["GOOGLE_MCP_TEST_REFRESH_TOKEN", refreshToken],
	]) {
		if (!value) {
			console.error(`${name} is not set — no credentialed live check to run. See docs/mcp-live-testing-setup.md.`)
			return 1
		}
	}

	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-live-renewal-"))
	const keyringDir = join(homeDir, "mcp-keyring")
	const binDir = join(homeDir, "browser-bin")
	activeHomeDir = homeDir
	try {
		seedCredential(keyringDir, { serverUrl, issuer, clientId, clientSecret, refreshToken })
		const seeded = readStoredCredential(keyringDir)
		console.log(`seeded credential: server=${serverUrl} expiresAt=${seeded.tokens.expiresAt} (in the past)`)

		const call = { tool: callTool, args: callArgs }
		const first = await runProbe({ homeDir, binDir, serverUrl, clientId, clientSecret, call })
		const firstFailures = assessProbe("cycle-1", first, keyringDir, { expectedScope, callRequested: true })
		if (firstFailures.length > 0 && first.childOutput)
			console.error(`child output (redacted):\n${redactChildOutput(first.childOutput)}`)
		if (firstFailures.length > 0) {
			for (const failure of firstFailures) console.error(`FAIL ${failure}`)
			return 1
		}

		if (!forceExpiry(keyringDir)) {
			console.error("FAIL could not force the stored credential back into the past for the second cycle")
			return 1
		}
		console.log("forced the refreshed credential back into the past for the second renewal cycle")

		const second = await runProbe({ homeDir, binDir, serverUrl, clientId, clientSecret, call })
		const secondFailures = assessProbe("cycle-2", second, keyringDir, { expectedScope, callRequested: true })
		if (secondFailures.length > 0 && second.childOutput)
			console.error(`child output (redacted):\n${redactChildOutput(second.childOutput)}`)
		if (secondFailures.length > 0) {
			for (const failure of secondFailures) console.error(`FAIL ${failure}`)
			return 1
		}

		console.log(
			"PASS expired token renewed silently twice: tools listed, tool call returned data, no browser consent, expiry advanced, scope retained",
		)
		return 0
	} finally {
		activeHomeDir = null
		rmSync(homeDir, { recursive: true, force: true })
	}
}
main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error))
		process.exit(1)
	})
