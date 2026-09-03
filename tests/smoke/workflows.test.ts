import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { RpcExtensionUIRequest, RpcResponse } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { type FakeOpenAiServer, startFakeOpenAiServer } from "../e2e/tui/support/fake-openai-server.js"
import { BINARY_PATH, PACKAGE_DIR } from "./harness.js"

interface RunEvent {
	readonly type: string
	readonly output?: unknown
}

interface WorkflowFixture {
	readonly workflowsDir: string
	readonly rpc: RpcProcess
}

interface RpcProcess {
	request(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse>
	getError(): string | undefined
	stop(): Promise<void>
}

interface PendingRpcRequest {
	resolve(response: RpcResponse): void
	reject(error: Error): void
}

const REQUEST_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 180_000
const originalCorepackHome = process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack")
const originalCacheHome =
	process.env.XDG_CACHE_HOME ??
	(process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"))
const pnpmStore = execFileSync("pnpm", ["store", "path"], { encoding: "utf8" }).trim()

let modelServer: FakeOpenAiServer

describe("bundled Kimchi Workflows extension", () => {
	beforeAll(async () => {
		modelServer = await startFakeOpenAiServer({ responses: [] })
	})

	afterAll(async () => {
		await modelServer.stop()
	})

	it("exposes and runs a function-only workflow without a separately installed extension package", {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		await createFixture(
			async (fixture) => {
				writeFileSync(
					join(fixture.workflowsDir, "bundled-smoke.workflow.ts"),
					`import { createStep, createWorkflow } from "@kimchi-dev/kimchi-workflows"

const greet = createStep({ name: "greet", run: async () => ({ message: "hello from the bundle" }) })

export default createWorkflow({ name: "bundled-smoke" }).then(greet).commit()
`,
					"utf8",
				)

				const commands = await fixture.rpc.request("get_commands")
				expect(commandNames(commands.data)).toContain("workflow")

				const run = await fixture.rpc.request("prompt", { message: "/workflow run bundled-smoke" })
				expect(run.success, run.error).toBe(true)
				const runsDir = join(fixture.workflowsDir, "runs")
				const eventFile = await waitFor(
					() => existsSync(runsDir) && readdirSync(runsDir).find((file) => file.startsWith("workflow-bundled-smoke-")),
					"the bundled workflow run file",
					fixture.rpc.getError,
				)
				const completed = await waitFor(
					() => readEvents(join(runsDir, eventFile)).find((event) => event.type === "run-completed"),
					"the bundled workflow to complete",
					fixture.rpc.getError,
				)
				expect(completed.output).toEqual({
					message: "hello from the bundle",
				})
				expect(
					modelServer.requests.some(
						(request) => request.method === "POST" && request.url.startsWith("/openai/v1/chat/completions"),
					),
				).toBe(false)
			},
			{ workflowsEnabled: true },
		)
	})

	it("does not register /workflow by default", { timeout: TEST_TIMEOUT_MS }, async () => {
		await createFixture(async (fixture) => {
			const commands = await fixture.rpc.request("get_commands")
			expect(commandNames(commands.data)).not.toContain("workflow")
		})
	})
})

async function createFixture(
	run: (fixture: WorkflowFixture) => Promise<void>,
	options: { readonly workflowsEnabled?: boolean } = {},
): Promise<void> {
	const { workflowsEnabled } = options
	const home = mkdtempSync(join(tmpdir(), "kimchi-workflows-smoke-home-"))
	const workDir = mkdtempSync(join(tmpdir(), "kimchi-workflows-smoke-work-"))
	const configDir = join(home, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	const workflowsDir = join(workDir, ".kimchi", "workflows")
	mkdirSync(agentDir, { recursive: true })
	mkdirSync(workflowsDir, { recursive: true })
	writeJson(join(configDir, "config.json"), {
		apiKey: "smoke-test",
		llmEndpoint: modelServer.baseUrl,
		skillPaths: [],
		migrationState: "done",
		onboarding: { hideSessionModeDialog: true },
	})
	writeJson(join(agentDir, "settings.json"), {
		quietStartup: true,
		hideThinkingBlock: true,
		...(workflowsEnabled === undefined ? {} : { resources: { "extensions.workflows": workflowsEnabled } }),
	})
	writeJson(join(agentDir, "models.json"), {
		providers: {
			fake: {
				baseUrl: `${modelServer.baseUrl}/openai/v1`,
				apiKey: "smoke-test",
				api: "openai-completions",
				authHeader: true,
				models: [
					{
						id: "basic",
						name: "Basic",
						reasoning: false,
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 1024,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						provider: "openai",
					},
				],
			},
		},
	})

	vi.stubEnv("HOME", home)
	vi.stubEnv("PI_PACKAGE_DIR", PACKAGE_DIR)
	vi.stubEnv("KIMCHI_API_KEY", "smoke-test")
	vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
	vi.stubEnv("KIMCHI_NO_UPDATE_CHECK", "1")
	vi.stubEnv("KIMCHI_PERMISSIONS", "yolo")
	vi.stubEnv("KIMCHI_RTK_AUTO_INSTALL", "0")
	vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "0")
	vi.stubEnv("PI_SKIP_VERSION_CHECK", "1")
	vi.stubEnv("COREPACK_HOME", originalCorepackHome)
	vi.stubEnv("XDG_CACHE_HOME", originalCacheHome)
	vi.stubEnv("npm_config_offline", undefined)
	vi.stubEnv("npm_config_prefer_offline", "true")
	vi.stubEnv("npm_config_store_dir", pnpmStore)
	vi.stubEnv("KIMCHI_WORKFLOWS_PACKAGE_DIR", undefined)
	let rpc: RpcProcess | undefined
	try {
		rpc = await startRpc(workDir)
		await run({ workflowsDir, rpc })
	} finally {
		await rpc?.stop()
		vi.unstubAllEnvs()
		rmSync(home, { recursive: true, force: true })
		rmSync(workDir, { recursive: true, force: true })
	}
}

/** Pi's exported RpcClient launches a Node script, so this narrow helper targets the compiled binary directly. */
async function startRpc(cwd: string): Promise<RpcProcess> {
	const child = spawn(BINARY_PATH, ["--provider", "fake", "--model", "basic", "--mode", "rpc", "--no-session"], {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	})
	let stderr = ""
	let nextId = 1
	child.stderr.setEncoding("utf8")
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk
	})
	const pendingRequests = new Map<string, PendingRpcRequest>()
	const errorNotifications: string[] = []
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
	void readRpcOutput()

	const rpc: RpcProcess = {
		request(type, fields = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
			const id = `workflows-smoke-${nextId++}`
			return new Promise<RpcResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					pendingRequests.delete(id)
					reject(new Error(`Kimchi RPC ${type} timed out${rpcDiagnostics()}`))
				}, timeoutMs)
				pendingRequests.set(id, {
					resolve: (response) => {
						clearTimeout(timer)
						resolve(response)
					},
					reject: (error) => {
						clearTimeout(timer)
						reject(error)
					},
				})
				try {
					child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
				} catch (error) {
					pendingRequests.delete(id)
					clearTimeout(timer)
					reject(error instanceof Error ? error : new Error(String(error)))
				}
			})
		},
		getError: () => errorNotifications.at(-1),
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return
			child.kill("SIGTERM")
			const graceful = await Promise.race([
				exited.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
			])
			if (!graceful && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL")
				await exited
			}
		},
	}

	async function readRpcOutput(): Promise<void> {
		try {
			for await (const line of createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })) {
				let value: unknown
				try {
					value = JSON.parse(line)
				} catch (error) {
					throw new Error(`Kimchi RPC emitted non-JSON stdout: ${line}`, { cause: error })
				}
				if (isRpcResponse(value) && value.id) {
					const pending = pendingRequests.get(value.id)
					if (pending) {
						pendingRequests.delete(value.id)
						pending.resolve(value)
					}
				} else if (isRpcErrorNotification(value)) {
					errorNotifications.push(value.message)
				}
			}
			throw new Error(`Kimchi RPC stdout closed${rpcDiagnostics()}`)
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error))
			for (const pending of pendingRequests.values()) pending.reject(failure)
			pendingRequests.clear()
		}
	}

	function rpcDiagnostics(): string {
		const errors = errorNotifications.length > 0 ? `\n${errorNotifications.join("\n")}` : ""
		return `${errors}${stderr ? `\n${stderr}` : ""}`
	}

	try {
		const ready = await rpc.request("get_state", {}, 30_000)
		if (!ready.success) throw new Error(ready.error ?? "Kimchi RPC startup failed")
		return rpc
	} catch (error) {
		await rpc.stop()
		throw error
	}
}

async function waitFor<T>(
	check: () => T | false | undefined,
	label: string,
	getError?: () => string | undefined,
): Promise<T> {
	const deadline = Date.now() + REQUEST_TIMEOUT_MS
	while (Date.now() < deadline) {
		const error = getError?.()
		if (error) throw new Error(`Failed waiting for ${label}: ${error}`)
		const value = check()
		if (value !== false && value !== undefined) return value
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Timed out waiting for ${label}`)
}

function isRpcErrorNotification(
	value: unknown,
): value is Extract<RpcExtensionUIRequest, { readonly method: "notify" }> {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "extension_ui_request" &&
		"method" in value &&
		value.method === "notify" &&
		"notifyType" in value &&
		value.notifyType === "error" &&
		"message" in value &&
		typeof value.message === "string"
	)
}

function isRpcResponse(value: unknown): value is RpcResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "response" &&
		"command" in value &&
		typeof value.command === "string" &&
		"success" in value &&
		typeof value.success === "boolean"
	)
}

function commandNames(data: unknown): string[] {
	if (!data || typeof data !== "object" || !("commands" in data) || !Array.isArray(data.commands)) return []
	return data.commands.flatMap((command) =>
		command && typeof command === "object" && "name" in command && typeof command.name === "string"
			? [command.name]
			: [],
	)
}

function readEvents(filePath: string): RunEvent[] {
	return readFileSync(filePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RunEvent)
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}
