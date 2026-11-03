#!/usr/bin/env node
/**
 * Public no-auth MCP server lifecycle check.
 *
 * Proves the full add-and-use journey against a real third-party server that
 * requires no credentials: `kimchi mcp probe` connects over streamable HTTP,
 * lists the server's tools, and invokes one read-only tool through the live
 * session — TLS, headers, session handling, and the server's own protocol
 * implementation are all real, not the local fixture's.
 *
 * The default inventory is public information (DeepWiki, Cognition's free
 * no-auth service) and lives in this file; set MCP_LIVE_PUBLIC_SERVERS to
 * override it with a JSON array of entries:
 *
 *   [{ "name": "example", "url": "https://example/mcp",
 *      "tool": "some_read_tool", "args": { "query": "x" } }]
 *
 * A no-auth server must never open a browser — the recording driver counts
 * any open as a failure. Output is names, tool counts, and booleans only.
 * `--self-test` runs the pure assessment on canned inputs.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BINARY, countBrowserOpens, probeChildEnv, writeRecordingBrowserDriver } from "./mcp-live-support.mjs"

const DEFAULT_SERVERS = [
	{
		name: "deepwiki",
		url: "https://mcp.deepwiki.com/mcp",
		tool: "read_wiki_structure",
		args: { repoName: "expressjs/express" },
	},
]

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

// The temp HOME is removed in `finally` and from signal handlers.
let activeHomeDir = null
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		if (activeHomeDir !== null) rmSync(activeHomeDir, { recursive: true, force: true })
		process.exit(130)
	})

/**
 * Assess one public-server probe outcome. Failures marked transient
 * (the probe failing to complete at all) get a single retry from main.
 */
export function assessPublicProbe({ result, exit, browserOpens }) {
	const toolCount = Array.isArray(result?.tools) ? result.tools.length : 0
	const failures = []
	let transient = false
	if (result?.call && !result.call.ok) {
		// A requested tool call that failed exits 1 by contract; report the call
		// failure itself, not a spurious "did not complete" (and it is not
		// transient — a rejected tool call is deterministic).
		failures.push(`tool call failed: ${result.call.error}`)
	} else if (exit.timedOut) {
		failures.push("probe timed out after its budget")
		transient = true
	} else if (exit.code !== 0 || result === null) {
		failures.push(`probe did not complete (exit=${exit.code ?? exit.signal})`)
		transient = true
	}
	if (result?.error) failures.push(`probe error: ${result.error}`)
	if (!transient && toolCount === 0) failures.push("probe listed no tools")
	if (!transient && !result?.call) failures.push("probe made no tool call")
	if (result?.call?.ok && !result.call.content) failures.push("tool call returned empty content")
	if (browserOpens > 0) failures.push(`${browserOpens} browser open(s) — a no-auth server must never require one`)
	return { failures, toolCount, transient }
}

/** Run `kimchi mcp probe` with the entry's read tool call and return its parsed outcome. */
async function runProbe({ homeDir, binDir, entry, timeoutMs = 120_000 }) {
	const { urlLog } = writeRecordingBrowserDriver(binDir)
	const child = spawn(
		BINARY,
		["mcp", "probe", "--json", "--call", entry.tool, "--args", JSON.stringify(entry.args ?? {})],
		{
			env: probeChildEnv({ homeDir, binDir }),
			stdio: ["pipe", "pipe", "pipe"],
		},
	)
	const stdout = []
	const stderr = []
	child.stdout.on("data", (chunk) => stdout.push(String(chunk)))
	child.stderr.on("data", (chunk) => stderr.push(String(chunk)))
	child.stdin.end(`${JSON.stringify({ name: entry.name, server: { url: entry.url } })}\n`)
	const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })))
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
	}, timeoutMs)
	try {
		const exit = await exited
		let result
		try {
			result = JSON.parse(stdout.join("").trim())
		} catch {
			result = null
		}
		if (timedOut) exit.timedOut = true
		return { result, exit, childOutput: stderr.join(""), browserOpens: countBrowserOpens(urlLog) }
	} finally {
		clearTimeout(timer)
	}
}

/** Parse and validate the server list from the environment (or the defaults). */
export function parseServers(raw) {
	const entries = JSON.parse(raw)
	if (!Array.isArray(entries)) throw new Error("server list is not a JSON array")
	return entries.map((entry, index) => {
		const at = `entry ${index}`
		if (typeof entry?.name !== "string" || entry.name.length === 0)
			throw new Error(`${at}: name must be a non-empty string`)
		if (typeof entry?.url !== "string" || !entry.url.startsWith("https://"))
			throw new Error(`${at} (${entry.name}): url must be an https:// string`)
		if (typeof entry?.tool !== "string" || entry.tool.length === 0)
			throw new Error(`${at} (${entry.name}): tool must be a non-empty string`)
		return {
			name: entry.name,
			url: entry.url,
			tool: entry.tool,
			args: typeof entry?.args === "object" && entry.args !== null && !Array.isArray(entry.args) ? entry.args : {},
		}
	})
}

/** Canned-input self-test for the pure assessment and parsing (no network, no binary). */
function selfTest() {
	const cases = []
	const expect = (label, actual, expected) =>
		cases.push({ label, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })

	expect(
		"healthy outcome passes",
		assessPublicProbe({
			result: { tools: [{ name: "read" }], call: { ok: true, error: null, content: "docs..." } },
			exit: { code: 0 },
			browserOpens: 0,
		}),
		{ failures: [], toolCount: 1, transient: false },
	)
	expect(
		"empty tool list fails",
		assessPublicProbe({
			result: { tools: [], call: { ok: true, error: null, content: "x" } },
			exit: { code: 0 },
			browserOpens: 0,
		}).failures,
		["probe listed no tools"],
	)
	expect(
		"failed tool call fails",
		assessPublicProbe({
			result: { tools: [{ name: "read" }], call: { ok: false, error: "no such tool", content: null } },
			exit: { code: 1 },
			browserOpens: 0,
		}).failures,
		["tool call failed: no such tool"],
	)
	expect(
		"empty tool-call content fails",
		assessPublicProbe({
			result: { tools: [{ name: "read" }], call: { ok: true, error: null, content: null } },
			exit: { code: 0 },
			browserOpens: 0,
		}).failures,
		["tool call returned empty content"],
	)
	expect(
		"a browser open on a no-auth server fails",
		assessPublicProbe({
			result: { tools: [{ name: "read" }], call: { ok: true, error: null, content: "x" } },
			exit: { code: 0 },
			browserOpens: 1,
		}).failures,
		["1 browser open(s) — a no-auth server must never require one"],
	)
	expect(
		"a probe that does not complete is transient",
		assessPublicProbe({ result: null, exit: { code: 1 }, browserOpens: 0 }),
		{ failures: ["probe did not complete (exit=1)"], toolCount: 0, transient: true },
	)
	expect(
		"a probe timeout is transient",
		assessPublicProbe({ result: null, exit: { code: null, signal: "SIGKILL", timedOut: true }, browserOpens: 0 })
			.transient,
		true,
	)
	expect(
		"server list parses and defaults args",
		parseServers(JSON.stringify([{ name: "a", url: "https://a.example/mcp", tool: "read" }])),
		[{ name: "a", url: "https://a.example/mcp", tool: "read", args: {} }],
	)
	const throwsMessage = (fn) => {
		try {
			fn()
			return "(no throw)"
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}
	expect(
		"server list rejects non-https urls",
		throwsMessage(() => parseServers(JSON.stringify([{ name: "a", url: "http://a.example/mcp", tool: "read" }]))),
		"entry 0 (a): url must be an https:// string",
	)

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

	let servers
	if (process.env.MCP_LIVE_PUBLIC_SERVERS !== undefined) {
		try {
			servers = parseServers(process.env.MCP_LIVE_PUBLIC_SERVERS)
		} catch (error) {
			console.error(`MCP_LIVE_PUBLIC_SERVERS is invalid: ${error instanceof Error ? error.message : String(error)}`)
			return 1
		}
	} else {
		servers = DEFAULT_SERVERS
	}

	let allOk = true
	for (const entry of servers) {
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-live-public-"))
		activeHomeDir = homeDir
		const binDir = join(homeDir, "browser-bin")
		try {
			let outcome = await runProbe({ homeDir, binDir, entry })
			let assessment = assessPublicProbe(outcome)
			if (assessment.failures.length > 0 && assessment.transient) {
				console.log(`${entry.name}: transient failure — retrying once`)
				await delay(2_000)
				outcome = await runProbe({ homeDir, binDir, entry })
				assessment = assessPublicProbe(outcome)
			}
			console.log(
				`${entry.name}: exit=${outcome.exit.code ?? outcome.exit.signal} tools=${assessment.toolCount} ` +
					`call=${outcome.result?.call ? (outcome.result.call.ok ? "ok" : "failed") : "off"} browserOpens=${outcome.browserOpens}`,
			)
			if (assessment.failures.length > 0) {
				allOk = false
				for (const failure of assessment.failures) console.error(`FAIL ${failure}`)
			} else {
				console.log(`PASS ${entry.name}`)
			}
		} finally {
			activeHomeDir = null
			rmSync(homeDir, { recursive: true, force: true })
		}
	}
	return allOk ? 0 : 1
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error))
		process.exit(1)
	})
