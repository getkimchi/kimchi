/**
 * `kimchi mcp probe` — transient MCP server tool discovery.
 *
 * Reads a `{ name: string, server: ServerEntry }` JSON from stdin, connects
 * through an isolated upstream adapter instance, calls `tools/list`, prints
 * the result as JSON to stdout, and exits.
 *
 * The `name` field selects the OAuth token-store key. Before any OAuth
 * write, the probe checks whether an auth entry already exists under that
 * name for a *different* URL (e.g. the user edited the URL but kept the
 * name). If so, it probes under a throwaway `__probe_<uuid>` name and
 * cleans it up afterwards so the real server's stored tokens are never
 * overwritten. If no entry exists, the URL matches, or the entry is
 * residue from an incomplete OAuth flow (no serverUrl), the real name is
 * used — so a repeat probe of an already-authorized server finds stored
 * OAuth tokens and an interrupted flow completes on the correct entry.
 *
 * Used by Kimchi Desktop's MCP server configuration UI to populate a
 * multiselect dropdown of available tools when the user picks
 * "Expose selected tools".
 *
 * Usage:  kimchi mcp probe --json < server-config.json
 * Input:  { "name": "my-server", "server": { "command": "..." } }
 * Output: { "tools": [{ "name": "..." }], "needsAuth": false }
 * Exit:   0 on success (including needs-auth), 1 on error
 */

import type { ServerEntry } from "pi-mcp-adapter/types"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { verifyMcpKeyringRuntime } from "../extensions/mcp/keyring-require-bridge.js"
import { type ProbeResult, UpstreamMcpProbe } from "../extensions/mcp/probe.js"

/**
 * TypeBox schema for the probe stdin input.
 *
 * Validates the `{ name, server }` wrapper structurally:
 * - `name` must be a non-empty string with no path separators (`/`, `\`)
 *   or consecutive dots (`..`) — prevents path-traversal attacks.
 * - `server` accepts the full `ServerEntry` shape with `additionalProperties: true`
 *   since it is a rich config object.
 * - Top-level rejects unknown properties (`additionalProperties: false`).
 */
const ProbeInputSchema = Type.Object(
	{
		name: Type.String({
			minLength: 1,
			pattern: "^(?!.*\\.\\.)[^/\\\\]+$",
		}),
		server: Type.Object({}, { additionalProperties: true }),
	},
	{ additionalProperties: false },
)

export async function runMcp(args: string[]): Promise<number | undefined> {
	const subcommand = args[0]

	if (subcommand === "probe") {
		return runProbe(args.slice(1))
	}
	if (subcommand === "keyring-check") {
		return runKeyringCheck(args.slice(1))
	}

	// Future: `kimchi mcp list`, `kimchi mcp status`, etc.
	process.stderr.write(`Unknown mcp subcommand: ${subcommand ?? "(none)"}\n`)
	process.stderr.write("Usage: kimchi mcp probe --json < server-config.json\n")
	process.stderr.write("       kimchi mcp keyring-check --json\n")
	return 1
}

async function runKeyringCheck(args: string[]): Promise<number> {
	if (!args.includes("--json")) return emitError("--json flag is required", null)
	try {
		return emitJson({ ok: true, ...verifyMcpKeyringRuntime() }, 0)
	} catch (err) {
		return emitJson(
			{
				ok: false,
				platform: process.platform,
				arch: process.arch,
				error: err instanceof Error ? err.message : String(err),
			},
			1,
		)
	}
}

async function runProbe(args: string[]): Promise<number> {
	const json = args.includes("--json")

	if (!json) {
		return await emitError("--json flag is required", null)
	}

	// Read server config from stdin
	let input: string
	try {
		input = await readStdin()
	} catch (err) {
		return await emitError("Failed to read stdin", err)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(input)
	} catch (err) {
		return await emitError("Failed to parse JSON from stdin", err)
	}

	if (!Value.Check(ProbeInputSchema, parsed)) {
		const errors = Value.Errors(ProbeInputSchema, parsed)
		const first = errors[0]
		const fieldPath =
			first.instancePath || `/${(first.params as { requiredProperties?: string[] })?.requiredProperties?.[0] ?? ""}`
		return await emitError(`Invalid probe input: ${fieldPath} ${first.message}`, null)
	}

	const validated = parsed as { name: string; server: ServerEntry }
	const name = validated.name
	const definition = validated.server

	if (!definition.command && !definition.url) {
		return await emitError("Server config must have either 'command' or 'url'", null)
	}

	const timeoutMs = definition.url ? 60_000 : 15_000
	const timeoutMsg = definition.url
		? "Probe timed out after 60 seconds (including OAuth flow)"
		: "Probe timed out after 15 seconds"
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error(timeoutMsg)), timeoutMs)
	const probe = new UpstreamMcpProbe()
	try {
		const result = await probe.probeTools(name, definition, {
			authenticate: true,
			cwd: process.cwd(),
			signal: controller.signal,
		})
		if (controller.signal.aborted) throw controller.signal.reason
		if (result.error && !result.needsAuth) return await emitError(result.error, null)
		return await emitResult(result, 0)
	} catch (err) {
		return await emitError(err instanceof Error ? err.message : String(err), null)
	} finally {
		clearTimeout(timer)
	}
}

function readStdin(): Promise<string> {
	const STDIN_TIMEOUT_MS = 5000
	const STDIN_MAX_BYTES = 1024 * 1024 // 1 MB

	return new Promise((resolve, reject) => {
		// If stdin is a TTY, there is no piped input — reject immediately so the
		// process never blocks waiting for data that will never arrive.
		if (process.stdin.isTTY) {
			reject(new Error("No input on stdin — pipe a server config in"))
			return
		}

		let data = ""
		let timer: ReturnType<typeof setTimeout> | undefined

		const onData = (chunk: string) => {
			data += chunk
			if (Buffer.byteLength(data, "utf8") > STDIN_MAX_BYTES) {
				cleanup()
				reject(new Error("stdin input exceeded 1MB"))
			}
		}
		const onEnd = () => {
			cleanup()
			resolve(data)
		}
		const onError = (err: Error) => {
			cleanup()
			reject(err)
		}
		const cleanup = () => {
			if (timer) clearTimeout(timer)
			process.stdin.off("data", onData)
			process.stdin.off("end", onEnd)
			process.stdin.off("error", onError)
		}

		// Guard against a parent that opens the pipe but never closes it — the
		// timeout rejects so the probe cannot hang forever.
		timer = setTimeout(() => {
			cleanup()
			reject(new Error("Timed out after 5000ms waiting for stdin"))
		}, STDIN_TIMEOUT_MS)

		process.stdin.setEncoding("utf8")
		process.stdin.on("data", onData)
		process.stdin.on("end", onEnd)
		process.stdin.on("error", onError)
	})
}

function emitResult(result: ProbeResult, exitCode: number): Promise<number> {
	return emitJson(result, exitCode)
}

function emitJson(result: unknown, exitCode: number): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, (err) => {
			if (err) {
				reject(err)
			} else {
				resolve(exitCode)
			}
		})
	})
}

function emitError(message: string, err: unknown): Promise<number> {
	return emitResult(
		{
			tools: [],
			needsAuth: false,
			error: message + (err instanceof Error ? `: ${err.message}` : ""),
		},
		1,
	)
}
