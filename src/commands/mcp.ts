/**
 * `kimchi mcp probe` — transient MCP server tool discovery.
 *
 * Reads a `{ name: string, server: ServerEntry }` JSON from stdin,
 * connects to the server using a throwaway {@link McpServerManager}
 * connection, calls `tools/list`, prints the result as JSON to stdout,
 * and exits.
 *
 * The `name` field selects the OAuth token-store key. Before any OAuth
 * write, the probe checks whether an auth entry already exists under that
 * name for a *different* URL (e.g. the user edited the URL but kept the
 * name). If so, it probes under a throwaway `__probe_<uuid>` name and
 * cleans it up afterwards so the real server's stored tokens are never
 * overwritten. If no entry exists or the URL matches, the real name is used
 * so a repeat probe of an already-authorized server finds stored OAuth
 * tokens and skips the browser flow.
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

import { randomUUID } from "node:crypto"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { getAuthEntry, removeAuthEntry } from "../extensions/mcp-adapter/mcp-auth.js"
import { authenticate, supportsOAuth } from "../extensions/mcp-adapter/mcp-auth-flow.js"
import { McpServerManager } from "../extensions/mcp-adapter/server-manager.js"
import type { McpTool, ServerEntry } from "../extensions/mcp-adapter/types.js"

type ProbeTool = Pick<McpTool, "name" | "title" | "description">

interface ProbeResult {
	tools: ProbeTool[]
	needsAuth: boolean
	error: string | null
}

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

	// Future: `kimchi mcp list`, `kimchi mcp status`, etc.
	process.stderr.write(`Unknown mcp subcommand: ${subcommand ?? "(none)"}\n`)
	process.stderr.write("Usage: kimchi mcp probe --json < server-config.json\n")
	return 1
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

	// Non-OAuth servers: 15 second timeout.
	// OAuth-capable servers that need auth: 60 second timeout (browser redirect + callback).
	const isOAuthCapable = supportsOAuth(definition)
	const timeoutMs = isOAuthCapable ? 60_000 : 15_000
	const timeoutMsg = isOAuthCapable
		? "Probe timed out after 60 seconds (including OAuth flow)"
		: "Probe timed out after 15 seconds"

	// Guard against URL mismatch in the OAuth token store. The token store is
	// keyed by server name, so probing a server whose URL was edited (but whose
	// name stayed the same) would otherwise overwrite the real server's stored
	// credentials. See {@link resolveProbeName} for the decision rules.
	const probeName = resolveProbeName(name, definition)
	const usedThrowaway = probeName !== name

	const manager = new McpServerManager()
	try {
		// Use `probeName` (the real name or a throwaway) so the token-store key
		// is shared between the initial probe, authenticate(), and the retry.
		// A repeat probe of an already-authorized server finds stored OAuth
		// tokens on the first call and skips the browser flow entirely.
		let result = await withTimeout(manager.probeTools(probeName, definition), timeoutMs, timeoutMsg)
		// probeTools returns errors inline via `result.error` (it does not throw
		// on connect/tools failures) — surface those as exit-1 failures so the UI
		// can display them, preserving the pre-unification contract.
		if (result.error) {
			return await emitError(result.error, null)
		}

		// If the server needs auth and OAuth is supported, attempt the full
		// OAuth flow (browser redirect + callback) then retry the probe.
		if (result.needsAuth && isOAuthCapable && definition.url) {
			try {
				await withTimeout(authenticate(probeName, definition.url, definition), timeoutMs, "OAuth flow timed out")
			} catch (err) {
				// Auth failed or timed out — return needsAuth: true with the real
				// error message so the UI can display it. Exit 0 because the probe
				// ran successfully; the user just needs to authorize.
				const message = err instanceof Error ? err.message : String(err)
				return await emitResult({ tools: [], needsAuth: true, error: message }, 0)
			}

			// Retry probe after successful auth, reusing the same name so the
			// token store has the credentials.
			result = await withTimeout(manager.probeTools(probeName, definition), timeoutMs, timeoutMsg)
			if (result.error) {
				return await emitError(result.error, null)
			}
		}

		const output: ProbeResult = {
			tools: result.tools.map((t) => ({
				name: t.name,
				title: t.title,
				description: t.description,
			})),
			needsAuth: result.needsAuth,
			error: null,
		}
		return await emitResult(output, 0)
	} catch (err) {
		return await emitError(err instanceof Error ? err.message : String(err), null)
	} finally {
		await manager.closeAll().catch(() => {})
		// Clean up throwaway probe credentials so the token store never
		// accumulates `__probe_*` entries. Never called for the real name —
		// real credentials must survive the probe.
		if (usedThrowaway) {
			removeAuthEntry(probeName)
		}
	}
}

/**
 * Decide which name to use as the OAuth token-store key during a probe.
 *
 * The token store is keyed by server name. If an auth entry already exists
 * under `name` for a *different* URL — e.g. the user edited the server's URL
 * but kept the name — probing with the real name would overwrite the real
 * server's stored credentials. To avoid that, fall back to a throwaway
 * `__probe_<uuid>` name whenever the stored URL does not match the probe's
 * URL; the caller cleans it up with {@link removeAuthEntry} in its `finally`.
 *
 * When no entry exists (new server) or the URL matches (repeat probe of an
 * authorized server), the real name is used so that stored tokens are found
 * and OAuth is skipped on repeat probes.
 */
function resolveProbeName(name: string, definition: ServerEntry): string {
	const existing = getAuthEntry(name)
	// No stored entry: new server — use the real name so the first probe
	// persists tokens under it and a repeat probe finds them.
	if (!existing) return name
	// URL matches: repeat probe of an authorized server — reuse the name so
	// stored tokens are found and the browser flow is skipped.
	if (existing.serverUrl === definition.url) return name
	// Entry exists for a different URL — isolate the probe's credentials under
	// a throwaway name so the real server's tokens are never overwritten.
	return `__probe_${randomUUID()}`
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timerPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms)
	})
	// Attach a no-op catch to the original promise so that if it rejects
	// after the timer wins the race, the rejection is not unhandled.
	promise.catch(() => {})
	return Promise.race([promise, timerPromise]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

function emitResult(result: ProbeResult, exitCode: number): Promise<number> {
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
