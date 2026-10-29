#!/usr/bin/env node
/**
 * Live MCP OAuth authorize-URL check.
 *
 * Verifies, against real OAuth providers, the authorize request the built
 * binary constructs: the redirect-URI class the client registers or sends,
 * Google-style offline-access parameters, and that the provider answers with
 * a sign-in/consent page rather than an OAuth error.
 *
 * The provider inventory is deliberately not in this repository. Entries
 * come from the MCP_LIVE_PROVIDERS environment variable (JSON array):
 *
 *   [{ "name": "example-fixed",  "url": "https://example/mcp",
 *      "clientId": "public-client-id", "redirectUriPrefix": "http://localhost:",
 *      "google": true },
 *    { "name": "example-dcr",    "url": "https://example/mcp",
 *      "redirectUriPrefix": "http://127.0.0.1:" }]
 *
 * `clientId` present → fixed-client flow (stored-redirect/localhost default);
 * absent → dynamic client registration (loopback IP literal). Optional
 * `redirectUri` (a configured redirect, e.g. a hosted callback) and `scope`
 * pass straight through to the probe's OAuth config. `google: true`
 * additionally expects access_type=offline and prompt=consent on the URL.
 *
 * Entry names appear in this script's output; if the inventory itself is
 * sensitive, choose non-revealing names. Authorize URLs (which carry client
 * ids) are checked and then dropped — they never reach the output matrix or
 * the log: the probe child's stderr is captured and echoed only URL-redacted,
 * and failure strings carry check names, not URLs.
 *
 * Runs without the variable print a notice and exit 0. `--self-test` runs
 * the pure checks on canned inputs.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
	BINARY,
	probeChildEnv,
	REPO_ROOT,
	redirectUriMatchesClass,
	writeRecordingBrowserDriver,
} from "./mcp-live-support.mjs"

const PROVIDERS_ENV = "MCP_LIVE_PROVIDERS"

/** Strip http(s) URLs from text — they carry client ids and provider hosts from the inventory. */
function redactText(text) {
	return text.replace(/https?:\/\/[^\s"'>\]]+/g, "<redacted-url>")
}

/** OAuth error markers a provider's answer page must not contain. */
const PROVIDER_ERROR_MARKERS = [
	"redirect_uri_mismatch",
	"invalid_request",
	"invalid_client",
	"invalid_scope",
	"not registered for this client",
]

/**
 * Validate one captured authorize URL against the provider entry's contract.
 * Returns the list of failures (empty = pass).
 */
export function checkAuthorizeUrl(rawUrl, entry) {
	const failures = []
	let url
	try {
		url = new URL(rawUrl)
	} catch {
		return ["authorize URL is not parseable"]
	}
	const redirectUri = url.searchParams.get("redirect_uri")
	if (!redirectUri) failures.push("authorize URL has no redirect_uri parameter")
	else if (!redirectUriMatchesClass(redirectUri, entry.redirectUriPrefix))
		failures.push(
			`redirect_uri does not match the expected class (${redirectClassMismatch(redirectUri, entry.redirectUriPrefix)})`,
		)
	if (!url.searchParams.get("state")) failures.push("authorize URL has no state parameter")
	const challenge = url.searchParams.get("code_challenge")
	if (!challenge) failures.push("authorize URL has no PKCE code_challenge")
	else if (url.searchParams.get("code_challenge_method") !== "S256")
		failures.push("PKCE code_challenge_method is not S256")
	if (entry.google) {
		if (url.searchParams.get("access_type") !== "offline")
			failures.push("Google-style endpoint: authorize URL has no access_type=offline")
		if (url.searchParams.get("prompt") !== "consent")
			failures.push("Google-style endpoint: authorize URL has no prompt=consent")
	}
	return failures
}

/**
 * Describe why a redirect URI missed its expected class without echoing either
 * URL — the prefix and the actual redirect both derive from the inventory.
 */
function redirectClassMismatch(redirectUri, redirectUriPrefix) {
	let actual
	let expected
	try {
		actual = new URL(redirectUri)
		expected = new URL(redirectUriPrefix)
	} catch {
		return "unparseable redirect_uri"
	}
	if (actual.protocol !== expected.protocol) return "scheme mismatch"
	if (actual.hostname !== expected.hostname) return "host mismatch"
	if (expected.port !== "" && actual.port !== expected.port) return "port mismatch"
	return "class mismatch"
}

/**
 * Check the provider's direct answer to the authorize URL (no sign-in).
 * `transient` marks network errors and 5xx responses — the entry retries once.
 */
export function checkProviderAnswer(answer, baseUrl) {
	const { status, location, body } = answer
	if (answer.networkError !== undefined)
		return { failures: [`network error: ${redactText(answer.networkError)}`], transient: true }
	if (status >= 500) return { failures: [`provider answered HTTP ${status}`], transient: true }
	if (status >= 400) {
		const marker = PROVIDER_ERROR_MARKERS.find((candidate) => (body ?? "").toLowerCase().includes(candidate))
		return { failures: [`provider answered HTTP ${status}${marker ? ` (${marker})` : ""}`], transient: false }
	}
	if (status >= 300) {
		if (!location) return { failures: ["provider redirect has no Location header"], transient: false }
		const redirectUrl = new URL(location, baseUrl)
		const error = redirectUrl.searchParams.get("error")
		if (error) return { failures: [`provider redirect carries error=${error}`], transient: false }
		return { failures: [], transient: false }
	}
	const marker = PROVIDER_ERROR_MARKERS.find((candidate) => (body ?? "").toLowerCase().includes(candidate))
	if (marker) return { failures: [`provider answer page contains ${marker}`], transient: false }
	return { failures: [], transient: false }
}

/** GET the authorize URL without following into a sign-in, with a bounded body read. */
async function fetchProviderAnswer(url) {
	try {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
			headers: { "user-agent": "kimchi-live-probe/1.0" },
		})
		const location = response.headers.get("location") ?? undefined
		let body
		if (!location) body = (await response.text()).slice(0, 65_536)
		return { status: response.status, location, body }
	} catch (error) {
		return { networkError: error instanceof Error ? error.message : String(error) }
	}
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

/**
 * Run `kimchi mcp probe` for one entry until the browser driver records the
 * authorize URL, then stop the probe. Returns the recorded URL.
 */
export async function captureAuthorizeUrl(entry, options = {}) {
	const { timeoutMs = 45_000 } = options
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-live-probe-"))
	const binDir = join(homeDir, "browser-bin")
	const { urlLog } = writeRecordingBrowserDriver(binDir)
	const oauth = entry.clientId ? { clientId: entry.clientId } : {}
	if (entry.redirectUri !== undefined) oauth.redirectUri = entry.redirectUri
	if (entry.scope !== undefined) oauth.scope = entry.scope
	const server = {
		url: entry.url,
		auth: "oauth",
		oauth,
	}
	const child = spawn(BINARY, ["mcp", "probe", "--json"], {
		env: probeChildEnv({ homeDir, binDir }),
		stdio: ["pipe", "pipe", "pipe"],
	})
	const stdout = []
	child.stdout.on("data", (chunk) => stdout.push(String(chunk)))
	// The probe's OAuth diagnostics — including the authorize URL — go to stderr.
	// Echo them URL-redacted so the inventory (hosts, client ids) never reaches
	// the log; line-buffer so a URL split across chunks cannot slip through.
	let stderrTail = ""
	const flushStderrTail = () => {
		if (stderrTail.length > 0) {
			process.stderr.write(`${redactText(stderrTail)}\n`)
			stderrTail = ""
		}
	}
	child.stderr.on("data", (chunk) => {
		stderrTail += String(chunk)
		const lines = stderrTail.split("\n")
		stderrTail = lines.pop() ?? ""
		for (const line of lines) process.stderr.write(`${redactText(line)}\n`)
	})
	child.stdin.end(`${JSON.stringify({ name: "live-probe", server })}\n`)
	let exitState = null
	const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })))
	exited.then((state) => {
		exitState = state
		flushStderrTail()
	})
	const stop = async () => {
		if (exitState === null) {
			child.kill("SIGTERM")
			const graceful = await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])
			if (!graceful) child.kill("SIGKILL")
			await exited
		}
	}
	try {
		const startedAt = Date.now()
		while (Date.now() - startedAt < timeoutMs) {
			if (exitState !== null) {
				// Redacted probe output goes to the log only — never the matrix.
				const tail = redactText(stdout.join("").slice(-500)).trim()
				if (tail) console.error(`probe output: ${tail}`)
				throw new Error(`probe exited (code=${exitState.code} signal=${exitState.signal}) before opening a browser`)
			}
			try {
				const lines = readFileSync(urlLog, "utf-8").split("\n").filter(Boolean)
				const recorded = lines.map((line) => JSON.parse(line).target)
				if (recorded.length > 0) return recorded[recorded.length - 1]
			} catch {
				// No URL recorded yet (or a torn line mid-append); poll again.
			}
			await delay(250)
		}
		throw new Error(`timed out after ${timeoutMs}ms waiting for an authorize URL`)
	} finally {
		await stop()
		rmSync(homeDir, { recursive: true, force: true })
	}
}

/** Run one provider entry: capture the URL, check it, check the provider's answer. */
export async function runProviderEntry(entry) {
	const result = { name: entry.name, ok: false, checks: {} }
	try {
		const url = await captureAuthorizeUrl(entry)
		const urlFailures = checkAuthorizeUrl(url, entry)
		result.checks.authorizeUrl = urlFailures.length === 0 ? "pass" : urlFailures
		if (urlFailures.length > 0) return result
		const answer = await fetchProviderAnswer(url)
		result.status = answer.networkError === undefined ? answer.status : "network-error"
		const { failures, transient } = checkProviderAnswer(answer, url)
		result.checks.providerAnswer = failures.length === 0 ? "pass" : failures
		result.ok = failures.length === 0
		if (transient) result.transient = true
		return result
	} catch (error) {
		result.error = redactText(error instanceof Error ? error.message : String(error))
		return result
	}
}

/** Parse and validate the provider list from the environment. */
export function parseProviders(raw) {
	const entries = JSON.parse(raw)
	if (!Array.isArray(entries)) throw new Error("provider list is not a JSON array")
	return entries.map((entry, index) => {
		const at = `entry ${index}`
		if (typeof entry?.name !== "string" || entry.name.length === 0)
			throw new Error(`${at}: name must be a non-empty string`)
		const loopbackHttp = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(entry?.url ?? "")
		if (typeof entry?.url !== "string" || !(entry.url.startsWith("https://") || loopbackHttp))
			throw new Error(`${at} (${entry.name}): url must be an https:// string (http is only allowed for loopback hosts)`)
		if (typeof entry?.redirectUriPrefix !== "string" || entry.redirectUriPrefix.length === 0)
			throw new Error(`${at} (${entry.name}): redirectUriPrefix must be a non-empty string`)
		if (
			entry?.redirectUri !== undefined &&
			!(typeof entry?.redirectUri === "string" && /^https?:\/\//.test(entry.redirectUri))
		)
			throw new Error(`${at} (${entry.name}): redirectUri must be an http(s) string when present`)
		if (entry?.scope !== undefined && typeof entry?.scope !== "string")
			throw new Error(`${at} (${entry.name}): scope must be a string when present`)
		return {
			name: entry.name,
			url: entry.url,
			clientId: typeof entry?.clientId === "string" ? entry.clientId : undefined,
			redirectUriPrefix: entry.redirectUriPrefix,
			...(entry?.redirectUri !== undefined ? { redirectUri: entry.redirectUri } : {}),
			...(entry?.scope !== undefined ? { scope: entry.scope } : {}),
			google: entry?.google === true,
		}
	})
}

/** Canned-input self-test for the pure checks (no network, no binary). */
function selfTest() {
	const cases = []
	const expect = (label, actual, expected) =>
		cases.push({ label, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })

	const googleEntry = { name: "g", url: "https://example/mcp", redirectUriPrefix: "http://localhost:", google: true }
	const okUrl =
		"https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A19876%2Fcallback" +
		"&state=abc&code_challenge=xyz&code_challenge_method=S256&access_type=offline&prompt=consent"
	expect("google authorize URL passes", checkAuthorizeUrl(okUrl, googleEntry), [])
	expect(
		"google URL without offline params fails",
		checkAuthorizeUrl(okUrl.replace("&access_type=offline&prompt=consent", ""), googleEntry).filter(
			(failure) => failure.includes("access_type") || failure.includes("prompt"),
		),
		[
			"Google-style endpoint: authorize URL has no access_type=offline",
			"Google-style endpoint: authorize URL has no prompt=consent",
		],
	)
	expect(
		"wrong redirect class fails",
		checkAuthorizeUrl(okUrl, { ...googleEntry, redirectUriPrefix: "http://127.0.0.1:" }).filter((failure) =>
			failure.includes("redirect_uri"),
		),
		["redirect_uri does not match the expected class (host mismatch)"],
	)
	expect(
		"partial port prefix does not over-match",
		checkAuthorizeUrl(okUrl, { ...googleEntry, redirectUriPrefix: "http://localhost:198" }).filter((failure) =>
			failure.includes("redirect_uri"),
		),
		["redirect_uri does not match the expected class (port mismatch)"],
	)
	expect(
		"unpinned port accepts any port",
		redirectUriMatchesClass("http://localhost:59123/callback", "http://localhost:"),
		true,
	)
	expect(
		"pinned port must match exactly",
		redirectUriMatchesClass("http://localhost:19876/callback", "http://localhost:198"),
		false,
	)
	expect(
		"scheme must match",
		redirectUriMatchesClass("https://localhost:19876/callback", "http://localhost:19876"),
		false,
	)
	expect("host must match", redirectUriMatchesClass("http://127.0.0.1:19876/callback", "http://localhost:19876"), false)
	expect(
		"missing PKCE fails",
		checkAuthorizeUrl(okUrl.replace("&code_challenge=xyz&code_challenge_method=S256", ""), googleEntry),
		["authorize URL has no PKCE code_challenge"],
	)

	expect(
		"sign-in redirect passes",
		checkProviderAnswer({ status: 302, location: "https://provider/signin?next=x" }, "https://as.example/authorize"),
		{
			failures: [],
			transient: false,
		},
	)
	expect(
		"relative redirect resolves against the request URL",
		checkProviderAnswer({ status: 302, location: "/login?next=x" }, "https://as.example/authorize"),
		{ failures: [], transient: false },
	)
	expect(
		"relative redirect error fails",
		checkProviderAnswer({ status: 302, location: "/err?error=invalid_client" }, "https://as.example/authorize"),
		{ failures: ["provider redirect carries error=invalid_client"], transient: false },
	)
	expect(
		"redirect error fails",
		checkProviderAnswer({ status: 302, location: "https://provider/error?error=redirect_uri_mismatch" }),
		{ failures: ["provider redirect carries error=redirect_uri_mismatch"], transient: false },
	)
	expect("consent page passes", checkProviderAnswer({ status: 200, body: "<html>Sign in to continue</html>" }), {
		failures: [],
		transient: false,
	})
	expect(
		"error page marker fails",
		checkProviderAnswer({ status: 400, body: "<html>Error 400: redirect_uri_mismatch</html>" }),
		{ failures: ["provider answered HTTP 400 (redirect_uri_mismatch)"], transient: false },
	)
	expect(
		"unregistered client copy fails",
		checkProviderAnswer({ status: 200, body: "Invalid redirect_uri: not registered for this client" }),
		{
			failures: ["provider answer page contains not registered for this client"],
			transient: false,
		},
	)
	expect(
		"redaction strips URLs from text",
		redactText("see https://as.example/auth?client_id=secret now"),
		"see <redacted-url> now",
	)
	expect("5xx is transient", checkProviderAnswer({ status: 503, body: "" }), {
		failures: ["provider answered HTTP 503"],
		transient: true,
	})
	expect("network error is transient", checkProviderAnswer({ networkError: "fetch failed" }), {
		failures: ["network error: fetch failed"],
		transient: true,
	})

	const failed = cases.filter((testCase) => !testCase.pass)
	for (const testCase of failed)
		console.error(
			`FAIL ${testCase.label}\n  actual:   ${JSON.stringify(testCase.actual)}\n  expected: ${JSON.stringify(testCase.expected)}`,
		)
	console.log(`self-test: ${cases.length - failed.length}/${cases.length} checks passed`)
	return failed.length === 0
}

async function main() {
	if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1)

	const raw = process.env[PROVIDERS_ENV]
	if (!raw) {
		console.log(`${PROVIDERS_ENV} is not set — no live provider inventory to check. Nothing to do.`)
		return 0
	}
	let providers
	try {
		providers = parseProviders(raw)
	} catch (error) {
		console.error(`${PROVIDERS_ENV} is invalid: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
	if (providers.length === 0) {
		console.log(`${PROVIDERS_ENV} is empty — no live provider inventory to check. Nothing to do.`)
		return 0
	}

	const matrix = []
	for (const entry of providers) {
		let result = await runProviderEntry(entry)
		if (!result.ok && result.transient) {
			console.log(`${entry.name}: transient failure — retrying once`)
			await delay(2_000)
			result = await runProviderEntry(entry)
		}
		const { transient, ...entryResult } = result
		matrix.push(entryResult)
		if (result.error) console.error(`${entry.name}: ${result.error}`)
		console.log(`${result.ok ? "PASS" : "FAIL"} ${entry.name}`)
	}
	// Sanitized by contract: entry names and check results only — no URLs, no
	// raw probe output (both would publish the inventory this check keeps in a secret).
	const matrixPath = resolve(REPO_ROOT, "mcp-live-probe-matrix.json")
	writeFileSync(matrixPath, `${JSON.stringify({ checkedAt: new Date().toISOString(), results: matrix }, null, "\t")}\n`)
	console.log(`matrix written to ${matrixPath}`)
	return matrix.every((entryResult) => entryResult.ok) ? 0 : 1
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error))
		process.exit(1)
	})
