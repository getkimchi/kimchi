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

/** Redact token-shaped values from child output before it reaches a (public) log. */
function redactChildOutput(text) {
	return text
		.replace(/"(access_token|refresh_token|client_secret|code|code_verifier)"\s*:\s*"[^"]*"/g, '"$1":"<redacted>"')
		.replace(/[A-Za-z0-9_-]{80,}/g, "<redacted>")
		.slice(-2_000)
}

/** Run `kimchi mcp probe` against the server and return its parsed result. */
async function runProbe({ homeDir, binDir, serverUrl, clientId, timeoutMs = 90_000 }) {
	const { urlLog } = writeRecordingBrowserDriver(binDir)
	const child = spawn(BINARY, ["mcp", "probe", "--json"], {
		env: probeChildEnv({ homeDir, binDir }),
		stdio: ["pipe", "pipe", "pipe"],
	})
	const stdout = []
	const stderr = []
	child.stdout.on("data", (chunk) => stdout.push(String(chunk)))
	child.stderr.on("data", (chunk) => stderr.push(String(chunk)))
	child.stdin.end(
		`${JSON.stringify({ name: SERVER_NAME, server: { url: serverUrl, auth: "oauth", oauth: { clientId } } })}\n`,
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

async function main() {
	const clientId = process.env.GOOGLE_MCP_TEST_CLIENT_ID
	const clientSecret = process.env.GOOGLE_MCP_TEST_CLIENT_SECRET
	const refreshToken = process.env.GOOGLE_MCP_TEST_REFRESH_TOKEN
	const serverUrl = process.env.GOOGLE_MCP_TEST_SERVER ?? DEFAULT_SERVER
	const issuer = process.env.GOOGLE_MCP_TEST_ISSUER ?? DEFAULT_ISSUER
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
	try {
		seedCredential(keyringDir, { serverUrl, issuer, clientId, clientSecret, refreshToken })
		const seeded = readStoredCredential(keyringDir)
		console.log(`seeded credential: server=${serverUrl} expiresAt=${seeded.tokens.expiresAt} (in the past)`)

		const { result, exit, childOutput, browserOpens } = await runProbe({ homeDir, binDir, serverUrl, clientId })
		const toolCount = Array.isArray(result?.tools) ? result.tools.length : 0
		const failures = []
		if (exit.timedOut) failures.push(`probe timed out after its budget`)
		else if (exit.code !== 0 || result === null)
			failures.push(`probe did not complete (exit=${exit.code ?? exit.signal})`)
		if (result?.error) failures.push(`probe error: ${result.error}`)
		if (toolCount === 0) failures.push("probe listed no tools")
		if (browserOpens > 0) failures.push(`${browserOpens} browser consent(s) opened — renewal was not silent`)
		const stored = readStoredCredential(keyringDir)
		if (!stored?.tokens?.expiresAt) failures.push("stored credential has no expiry after the probe")
		else if (stored.tokens.expiresAt <= Date.now() / 1000 + 60)
			failures.push(`stored expiry did not advance past now (expiresAt=${stored.tokens.expiresAt})`)
		if (stored?.tokens?.accessToken === "kimchi-live-seed-expired-access-token")
			failures.push("stored access token is still the seeded expired value")

		console.log(
			`probe: exit=${exit.code ?? exit.signal} tools=${toolCount} browserOpens=${browserOpens} ` +
				`storedExpiresAt=${stored?.tokens?.expiresAt ?? "absent"}`,
		)
		if (failures.length > 0 && childOutput) console.error(`child output (redacted):\n${redactChildOutput(childOutput)}`)
		if (failures.length > 0) {
			for (const failure of failures) console.error(`FAIL ${failure}`)
			return 1
		}
		console.log("PASS expired token renewed silently: tools listed, no browser consent, expiry advanced")
		return 0
	} finally {
		rmSync(homeDir, { recursive: true, force: true })
	}
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error))
		process.exit(1)
	})
