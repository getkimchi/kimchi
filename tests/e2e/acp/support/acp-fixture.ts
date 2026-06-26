// ACP integration test fixture. Spawns kimchi with `--mode acp`, returns a
// `ClientSideConnection` + recording client, and loads a throwaway extension
// so every test triggers the fire-and-forget UI surface during `session_start`.
// ACP speaks JSON-RPC over stdio — no node-pty like the TUI fixture.

import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import * as acp from "@agentclientprotocol/sdk"
import type { ClientSideConnection } from "@agentclientprotocol/sdk"
import {
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "../../tui/support/fake-openai-server.js"

const REPO_ROOT = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: fileURLToPath(new URL("../../../../", import.meta.url))

const BINARY_PATH = resolve(REPO_ROOT, "dist/bin/kimchi")
const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")
const TEST_EXTENSION_PATH = fileURLToPath(new URL("./test-ui-extension.js", import.meta.url))

/** Tool-call ID prefix used by `FakeOpenAiServer` when none is supplied. */
const FAKE_TOOL_CALL_ID = "call_fake"

/** Time to wait for kimchi to start and accept the first JSON-RPC frame. */
const STARTUP_TIMEOUT_MS = 30_000

/** Hard cap on a single `prompt()` round-trip so a regression can't hang CI. */
const PROMPT_TIMEOUT_MS = 60_000

export interface AcpFixture {
	homeDir: string
	workDir: string
	fake: FakeOpenAiServer
	proc: ChildProcess
	conn: ClientSideConnection
	client: RecordingClient
	/**
	 * Resolve on process exit. Pass `{ signal }` to abort the wait — used by
	 * `stop()` so a SIGKILL doesn't hang the teardown on the exit promise.
	 */
	waitForExit(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
	stop(): Promise<void>
}

export interface AcpFixtureOptions {
	responses: FakeResponseScript[]
	/**
	 * Extra capabilities merged on top of the always-present fs baseline.
	 * Defaults to `{}` (just the fs baseline — matches `verify-acp.mjs`).
	 */
	clientCapabilities?: acp.ClientCapabilities
	/**
	 * Override the `_meta` object advertised by the client. Use this to opt
	 * into the `_kimchi.dev/pi_*` extension namespace via per-method flags.
	 */
	clientMeta?: Record<string, unknown>
	/**
	 * Path to a JavaScript extension to drop into the harness's
	 * `extensions/` directory before spawning kimchi. Defaults to the
	 * bundled `test-ui-extension.js` (notifies + setStatus). Tests that
	 * need to drive `ctx.ui.confirm`/`select`/`input` should point this at
	 * a custom extension that exercises those calls.
	 */
	extensionPath?: string
}

export interface StartAcpFixtureOptions extends AcpFixtureOptions {
	artifactName: string
}

/** Bundle of every notification / request the client received, in arrival order. */
export class RecordingClient {
	readonly sessionUpdates: Array<{ sessionId: string; update: acp.SessionUpdate }> = []
	readonly extMethods: Array<{ method: string; params: unknown }> = []
	readonly extNotifications: Array<{ method: string; params: unknown }> = []
	readonly permissionRequests: acp.RequestPermissionRequest[] = []
	readonly elicitationRequests: Array<{ method: string; params: unknown }> = []

	private permissionResolver: ((response: acp.RequestPermissionResponse) => acp.RequestPermissionResponse) | null = null
	private elicitationResolver: ((response: acp.CreateElicitationResponse) => acp.CreateElicitationResponse) | null =
		null

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		this.sessionUpdates.push({ sessionId: params.sessionId, update: params.update })
	}

	async extMethod(method: string, params: unknown): Promise<Record<string, unknown>> {
		this.extMethods.push({ method, params })
		return {}
	}

	async extNotification(method: string, params: unknown): Promise<void> {
		this.extNotifications.push({ method, params })
	}

	async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		this.permissionRequests.push(params)
		// If a test hooked the next permission response, consume it once.
		if (this.permissionResolver) {
			const resolver = this.permissionResolver
			this.permissionResolver = null
			return resolver({ outcome: { outcome: "selected", optionId: "" } })
		}
		// Auto-approve the first allow_once option so the test scenario
		// can proceed through tool execution without manual intervention.
		const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0]
		return { outcome: { outcome: "selected", optionId: allow.optionId } }
	}

	async writeTextFile(): Promise<acp.WriteTextFileResponse> {
		return {}
	}

	async readTextFile(): Promise<acp.ReadTextFileResponse> {
		return { content: "" }
	}

	/**
	 * Elicitation handler — the terminal prompter in `permissionsExtension`
	 * calls `ctx.ui.confirm`, which routes through the ACP UI context's
	 * `unstable_createElicitation`. We accept with an empty content object
	 * by default; tests can override via `answerNextElicitationWith`.
	 */
	async unstable_createElicitation(params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
		this.elicitationRequests.push({ method: "elicitation/create", params })
		if (this.elicitationResolver) {
			const resolver = this.elicitationResolver
			this.elicitationResolver = null
			return resolver({ action: "accept", content: {} })
		}
		return { action: "accept", content: {} }
	}

	/** Hook the next elicitation request to resolve with the given answer. */
	answerNextElicitationWith(response: acp.CreateElicitationResponse): void {
		this.elicitationResolver = () => response
	}

	/**
	 * Hook the next permission request to resolve with the given outcome.
	 * If `optionId` is not supplied, the resolver picks the first option
	 * matching `kind` (e.g. "reject_once") so callers can express intent
	 * without knowing the synthesized option ids.
	 */
	answerNextPermissionWith(response: acp.RequestPermissionResponse | { kind: string }): void {
		this.permissionResolver = () => {
			if ("outcome" in response) return response
			// Find the matching option on the *most recently received* request.
			const req = this.permissionRequests[this.permissionRequests.length - 1]
			const opt = req?.options.find((o) => o.kind === response.kind) ?? req?.options[0]
			return { outcome: { outcome: "selected", optionId: opt?.optionId ?? "" } }
		}
	}

	/** All agent_message_chunk text chunks concatenated, per session. */
	agentTextBySession(): Map<string, string> {
		const map = new Map<string, string>()
		for (const { sessionId, update } of this.sessionUpdates) {
			const text = textOf(update)
			if (text !== undefined) {
				map.set(sessionId, (map.get(sessionId) ?? "") + text)
			}
		}
		return map
	}

	/** All agent_message_chunk texts that start with the `[ACP]` warning prefix. */
	acpWarnings(): string[] {
		const out: string[] = []
		for (const { update } of this.sessionUpdates) {
			const text = textOf(update)
			if (text?.startsWith("[ACP]")) {
				out.push(text)
			}
		}
		return out
	}

	/** True if the given wire method arrived as an extNotification. */
	hasNotification(method: string): boolean {
		return this.extNotifications.some((n) => n.method === method)
	}
}

// Extract the text of an agent_message_chunk, or undefined for any other
// SessionUpdate variant. TypeScript needs the explicit nested narrowing
// through the discriminated union.
function textOf(update: acp.SessionUpdate): string | undefined {
	if (update.sessionUpdate !== "agent_message_chunk") return undefined
	if (update.content.type !== "text") return undefined
	return update.content.text
}

export async function startAcpFixture(options: StartAcpFixtureOptions): Promise<AcpFixture> {
	const { artifactName, responses, clientCapabilities, clientMeta, extensionPath } = options
	const fake = await startFakeOpenAiServer({ responses })
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-acp-home-"))
	const workDir = mkdtempSync(join(tmpdir(), "kimchi-acp-work-"))

	let proc: ChildProcess | null = null
	const abort = new AbortController()

	const recordArtifact = (outcome: "pass" | "fail", error?: unknown) => {
		try {
			const path = join(REPO_ROOT, `${artifactName}.${outcome}.acp-e2e.log`)
			const sections = [
				"# Kimchi ACP E2E Artifact",
				[
					`name: ${artifactName}`,
					`outcome: ${outcome}`,
					`createdAt: ${new Date().toISOString()}`,
					`binary: ${BINARY_PATH}`,
					`homeDir: ${homeDir}`,
					`workDir: ${workDir}`,
					`fakeModelBaseUrl: ${fake.baseUrl}`,
					`fakeRequestCount: ${fake.requests.length}`,
				].join("\n"),
				error ? `## Error\n\n${formatError(error)}` : undefined,
				`## extMethod calls\n\n${formatJson(client?.extMethods ?? [])}`,
				`## extNotification calls\n\n${formatJson(client?.extNotifications ?? [])}`,
				`## sessionUpdate notifications\n\n${formatJson(client?.sessionUpdates ?? [])}`,
				`## permission requests\n\n${formatJson(client?.permissionRequests ?? [])}`,
				`## elicitation requests\n\n${formatJson(client?.elicitationRequests ?? [])}`,
			]
				.filter((s): s is string => Boolean(s))
				.join("\n\n")
			writeFileSync(path, sections, "utf-8")
			process.stderr.write(`[acp-e2e] wrote ${outcome} artifact: ${path}\n`)
		} catch (writeError) {
			process.stderr.write(`[acp-e2e] failed to write artifact: ${String(writeError)}\n`)
		}
	}

	let client: RecordingClient | null = null

	try {
		const configDir = join(homeDir, ".config", "kimchi")
		const agentDir = join(configDir, "harness")
		mkdirSync(join(agentDir, "extensions"), { recursive: true })

		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify(
				{
					apiKey: "fake",
					llmEndpoint: fake.baseUrl,
					skillPaths: [],
					migrationState: "done",
					onboarding: { hideSessionModeDialog: true },
				},
				null,
				"\t",
			),
			"utf-8",
		)

		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						fake: {
							baseUrl: `${fake.baseUrl}/openai/v1`,
							apiKey: "fake",
							api: "openai-completions",
							authHeader: true,
							headers: { "User-Agent": "kimchi/acp-e2e" },
							models: [
								{
									id: "basic",
									name: "Fake Basic",
									reasoning: false,
									input: ["text"],
									contextWindow: 64_000,
									maxTokens: 1024,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									provider: "openai",
								},
							],
						},
					},
				},
				null,
				"\t",
			),
			"utf-8",
		)

		// pi-coding-agent auto-loads `${agentDir}/extensions/*.js` on every session.
		const extPath = extensionPath ?? TEST_EXTENSION_PATH
		const extSource = readFileSync(extPath, "utf-8")
		writeFileSync(join(agentDir, "extensions", "test-ui-extension.js"), extSource, "utf-8")

		proc = spawn(BINARY_PATH, ["--mode", "acp"], {
			stdio: ["pipe", "pipe", "inherit"],
			env: {
				...process.env,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_DISABLE_BUILTIN_PROVIDERS: "1",
				PI_SKIP_VERSION_CHECK: "1",
			},
			cwd: workDir,
		})
		proc.on("error", (e) => {
			process.stderr.write(`[acp-e2e] spawn error: ${e}\n`)
			abort.abort()
		})

		// biome-ignore lint/style/noNonNullAssertion: <explanation>
		const writable = Writable.toWeb(proc.stdin!)
		// biome-ignore lint/style/noNonNullAssertion: <explanation>
		const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>
		client = new RecordingClient()
		const stream = acp.ndJsonStream(writable, readable)
		// biome-ignore lint/style/noNonNullAssertion: <explanation>
		const conn = new acp.ClientSideConnection(() => client!, stream)

		// If kimchi crashes on startup this rejects within the timeout.
		const initResult = await Promise.race([
			conn.initialize({
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: mergeCapabilities(clientCapabilities, clientMeta),
			}),
			delay(STARTUP_TIMEOUT_MS).then(() => {
				throw new Error(`initialize did not complete within ${STARTUP_TIMEOUT_MS}ms`)
			}),
		])
		process.stderr.write(
			`[acp-e2e] initialized protocolVersion=${initResult.protocolVersion} agentCapabilities=${JSON.stringify(initResult.agentCapabilities)}\n`,
		)

		const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
			proc?.once("exit", (code, signal) => resolveExit({ exitCode: code, signal }))
		})
		const waitForExit = () =>
			Promise.race([
				exitPromise,
				new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((_, reject) => {
					abort.signal.addEventListener("abort", () => reject(new Error("spawn aborted")))
				}),
			])

		return {
			homeDir,
			workDir,
			fake,
			proc,
			conn,
			client,
			waitForExit,
			async stop() {
				abort.abort()
				if (proc && proc.exitCode === null && proc.signalCode === null) {
					proc.kill("SIGTERM")
					await Promise.race([
						exitPromise,
						delay(3_000).then(() => {
							proc?.kill("SIGKILL")
						}),
					])
				}
				await fake.stop()
				rmSync(homeDir, { recursive: true, force: true })
				rmSync(workDir, { recursive: true, force: true })
			},
		}
	} catch (error) {
		recordArtifact("fail", error)
		if (proc && proc.exitCode === null) proc.kill("SIGKILL")
		await fake.stop().catch(() => {})
		rmSync(homeDir, { recursive: true, force: true })
		rmSync(workDir, { recursive: true, force: true })
		throw error
	}
}

function mergeCapabilities(
	override: acp.ClientCapabilities | undefined,
	clientMeta: Record<string, unknown> | undefined,
): acp.ClientCapabilities {
	// Baseline matches `verify-acp.mjs`: fs.read/write off. Tests layer
	// `override` on top. `_meta` nests inside `clientCapabilities` per ACP —
	// that's where `_meta["kimchi.dev"].pi_*` capability checks look for it.
	return {
		...override,
		fs: {
			readTextFile: false,
			writeTextFile: false,
			...(override?.fs ?? {}),
		},
		_meta: clientMeta ?? override?._meta,
	}
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, "\t")
}

function formatError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`
	return String(error)
}

export { FAKE_TOOL_CALL_ID, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS }
