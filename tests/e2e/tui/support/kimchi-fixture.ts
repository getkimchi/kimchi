import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Shell } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { fullText, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./assertions.js"
import { type StartFakeOllamaServerOptions, startFakeOllamaServer } from "./fake-ollama-server.js"
import {
	DEFAULT_MODEL,
	type FakeModel,
	type FakeOpenAiServer,
	type FakeResponseScript,
	type RecordedRequest,
	resolveModels,
	startFakeOpenAiServer,
} from "./fake-openai-server.js"
import { createMcpFixture, type McpFixture, type McpFixtureOptions } from "./mcp-fixture.js"

/** Shared terminal geometry/shell for every TUI e2e test. */
export const TUI_TEST_CONFIG = { shell: Shell.Bash, rows: 40, columns: 120 } as const

/** Prompt shown once the TUI is ready for input. */
export const PROMPT_READY = "ask anything or type / for commands"

// Env from run-tui-e2e.js, else derive from file location (stable regardless of cwd).
const REPO_ROOT = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: fileURLToPath(new URL("../../../../", import.meta.url))
const TUI_ARTIFACT_RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
/** `--debug` (run-tui-e2e.js) writes a readable artifact for every run, not just failures. */
const DEBUG_ARTIFACTS = process.env.KIMCHI_TUI_E2E_DEBUG === "1"

/** Provider key written into models.json and passed to the kimchi CLI; the two must agree. */
export const FAKE_PROVIDER = "fake"

export const BINARY_PATH = resolve(REPO_ROOT, "dist/bin/kimchi")
export const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")
const INITIAL_SURVEY_ID = "019e87cc-5033-0000-d9bd-5e6501640b6e"

export interface KimchiFixture {
	homeDir: string
	workDir: string
	agentDir: string
	fake: FakeOpenAiServer
	ollama?: { baseUrl: string; requests: RecordedRequest[] }
	/** Repository-owned MCP server configured for this session, when requested. */
	mcp?: McpFixture
	/** Value returned by the `seedHome` option, if used; else undefined. */
	seedResult?: unknown
	/** Env vars returned by `seedHome`, merged into the launched process env. */
	seedEnv: Record<string, string>
	providerId: string
	initialModel: string | false
	stop(): Promise<void>
}

export interface McpKimchiFixture extends KimchiFixture {
	mcp: McpFixture
}

export interface LaunchKimchiOptions {
	/** Resets the terminal and prints this marker after Kimchi exits, so a test can safely relaunch in the same PTY. */
	exitMarker?: string
}

export interface TuiScenarioTrace {
	step(label: string): void
}

interface TuiStepSnapshot {
	label: string
	at: string
	view: string
}

/** Result a `seedHome` hook may return to influence the launched process. */
export interface SeedHomeResult {
	/** Merged into the launched process env (alongside HOME, etc.). */
	env?: Record<string, string>
	/** Exposed on the fixture as `seedResult` for the test body to read. */
	data?: unknown
}

export interface CreateKimchiFixtureOptions {
	models?: FakeModel[]
	responses: FakeResponseScript[]
	routerResponses?: unknown[]
	/** Keep this one-based router request open until cancellation closes the connection. */
	stallRouterRequestNumber?: number
	/** Provider id written to models.json and used for the initial CLI selection. */
	providerId?: string
	/** Initial CLI model id. Set false to exercise the model saved in settings.json. */
	initialModel?: string | false
	creditsResponses?: unknown[]
	budgetResponses?: unknown[]
	/** `git init` the work dir so repo-checking flows (e.g. ferment) don't prompt to init one. */
	gitInit?: boolean
	/**
	 * Extra args appended to the binary command line after `--provider`/`--model`.
	 * Use for test-only flags like `--extension <path>` to load a custom extension
	 * without having to commit fixture data alongside the harness.
	 */
	extraArgs?: string[]
	/**
	 * Extra environment variables merged into the launched process env (alongside
	 * HOME, PI_PACKAGE_DIR, KIMCHI_PERMISSIONS, TERM). Used to seed e.g.
	 * `KIMCHI_ACTIVE_FERMENT` so session_start auto-resumes a pre-seeded draft
	 * without the model having to create one.
	 */
	env?: Record<string, string>
	/**
	 * Runs AFTER homeDir/workDir are created (and git init, if requested) but
	 * BEFORE kimchi is launched. Use to seed on-disk state (ferment event
	 * store, sidecar files) that the session must see at startup. Receives the
	 * resolved homeDir and workDir. May return `{ env, data }` where `env` is
	 * merged into the launched process env (e.g. `KIMCHI_ACTIVE_FERMENT`) and
	 * `data` is exposed on the fixture as `seedResult`. Returning a plain
	 * object without this shape is treated as `data` for back-compat.
	 */
	seedHome?: (homeDir: string, workDir: string) => SeedHomeResult | unknown
	/** When provided, start a fake Ollama server alongside the OpenAI fake. The
	 *  server handles startup model discovery (/api/tags + /api/show) and chat
	 *  completions (/v1/chat/completions) so the TUI E2E can run without a real
	 *  `ollama serve` running. */
	ollama?: StartFakeOllamaServerOptions
	/** Seed the isolated Kimchi home with a repository-owned MCP server. */
	mcp?: McpFixtureOptions
}

export type RunKimchiSessionOptions = CreateKimchiFixtureOptions & {
	artifactName: string
	/**
	 * Optional hook that runs AFTER launch but BEFORE the PROMPT_READY wait.
	 * Use to dismiss startup dialogs (e.g. a ferment resume dialog triggered
	 * by KIMCHI_ACTIVE_FERMENT) that would otherwise block PROMPT_READY.
	 * The hook receives the terminal so it can interact with the UI.
	 */
	beforeReady?: (terminal: Terminal) => Promise<void>
}

export async function createKimchiFixture(options: CreateKimchiFixtureOptions): Promise<KimchiFixture> {
	const fake = await startFakeOpenAiServer(options)
	const ollama = options.ollama ? await startFakeOllamaServer(options.ollama) : undefined
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-tui-home-"))
	const workDir = mkdtempSync(join(tmpdir(), "kimchi-tui-work-"))
	const providerId = options.providerId ?? FAKE_PROVIDER
	const initialModel = options.initialModel ?? DEFAULT_MODEL.slug
	let mcp: McpFixture | undefined
	// Tear down server + temp dirs if any setup step throws.
	try {
		if (options.gitInit) execFileSync("git", ["init", "-q"], { cwd: workDir })
		const configDir = join(homeDir, ".config", "kimchi")
		const agentDir = join(configDir, "harness")
		mkdirSync(agentDir, { recursive: true })

		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify(
				{
					apiKey: "fake",
					llmEndpoint: fake.baseUrl,
					skillPaths: [],
					migrationState: "done",
					onboarding: { hideSessionModeDialog: true },
					// Keep workflow specs focused on the feature under test; survey UI has unit coverage.
					surveys: { [INITIAL_SURVEY_ID]: { seenAt: "2026-01-01T00:00:00.000Z" } },
				},
				null,
				"\t",
			),
			"utf-8",
		)

		// Explicitly pin nothing so status line segments don't appear in the terminal during
		// E2E tests. Without this, readStatusLineConfig() would return DEFAULT_STATUS_LINE_PINNED
		// (context, agents, phase, usage) and change the terminal layout for every test.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ statusLine: { pinned: [] }, hideThinkingBlock: true }, null, "\t"),
			"utf-8",
		)

		writeModelsConfig(join(agentDir, "models.json"), fake.baseUrl, options.models, providerId)
		mcp = options.mcp ? await createMcpFixture(agentDir, options.mcp) : undefined

		const rawSeed = options.seedHome?.(homeDir, workDir)
		const seedIsResult =
			rawSeed !== null &&
			typeof rawSeed === "object" &&
			("env" in (rawSeed as SeedHomeResult) || "data" in (rawSeed as SeedHomeResult))
		const seedEnv = {
			KIMCHI_ROUTER_ENDPOINT: fake.baseUrl,
			...(mcp?.env ?? {}),
			...(seedIsResult ? ((rawSeed as SeedHomeResult).env ?? {}) : {}),
		}
		const seedResult = seedIsResult ? (rawSeed as SeedHomeResult).data : rawSeed

		return {
			homeDir,
			workDir,
			agentDir,
			fake,
			ollama: ollama ? { baseUrl: ollama.baseUrl, requests: ollama.requests } : undefined,
			mcp,
			seedResult,
			seedEnv,
			providerId,
			initialModel,
			async stop() {
				// Run all server stops even if one throws so no fixture process leaks.
				await fake.stop().catch(() => {})
				if (ollama) {
					await ollama.stop().catch(() => {})
				}
				await mcp?.stop().catch(() => {})
				rmSync(homeDir, { recursive: true, force: true })
				rmSync(workDir, { recursive: true, force: true })
			},
		}
	} catch (error) {
		await fake.stop().catch(() => {})
		if (ollama) {
			await ollama.stop().catch(() => {})
		}
		await mcp?.stop().catch(() => {})
		rmSync(homeDir, { recursive: true, force: true })
		rmSync(workDir, { recursive: true, force: true })
		throw error
	}
}

export async function createMcpKimchiFixture(
	options: Omit<CreateKimchiFixtureOptions, "mcp"> & { mcp: McpFixtureOptions },
): Promise<McpKimchiFixture> {
	const fixture = await createKimchiFixture(options)
	assertMcpFixture(fixture)
	return fixture
}

export function launchKimchi(
	terminal: Terminal,
	fixture: KimchiFixture,
	extraArgs: string[] = [],
	extraEnv: Record<string, string> = {},
	options: LaunchKimchiOptions = {},
): void {
	// KIMCHI_PERMISSIONS=yolo skips every permission check (rules, denylist,
	// classifier, prompts) so tool calls execute without blocking on the TUI
	// permission prompt — no test driver is wired to answer it. TUI E2E
	// should not depend on permission UX; permission flows are covered by
	// unit tests in src/extensions/permissions/. Tests that deliberately
	// exercise the prompt UI should override via `extraArgs` (e.g. `--plan`).
	const envEntries = Object.entries(extraEnv).map(([key, value]) => `${key}=${sh(value)}`)
	const command = [
		`cd ${sh(fixture.workDir)} &&`,
		"env",
		`HOME=${sh(fixture.homeDir)}`,
		`PI_PACKAGE_DIR=${sh(PACKAGE_DIR)}`,
		"KIMCHI_PERMISSIONS=yolo",
		// Disable startup network hooks (self-update probe) so the
		// session boots without background HTTP or synchronous tar/exec
		// work. Keeps the TUI e2e hermetic and its timing deterministic.
		"KIMCHI_NO_UPDATE_CHECK=1",
		...((fixture.ollama ? [`OLLAMA_HOST=${sh(fixture.ollama.baseUrl)}`] : []) as string[]),
		...envEntries,
		"TERM=xterm-256color",
		sh(BINARY_PATH),
		...(fixture.initialModel === false
			? []
			: [`--provider ${sh(fixture.providerId)}`, `--model ${sh(fixture.initialModel)}`]),
		...extraArgs,
	].join(" ")
	const exitMarker = options.exitMarker ? `; printf '\\033c%s\\n' ${sh(options.exitMarker)}` : ""
	terminal.submit(`${command}${exitMarker}`)
}

export interface KimchiSessionController {
	start(): Promise<void>
	turn(prompt: string, expectedText: string, options?: { timeoutMs?: number }): Promise<void>
	restart(): Promise<void>
	quit(): Promise<void>
}

export function createKimchiSessionController(
	terminal: Terminal,
	fixture: KimchiFixture,
	options: { extraArgs?: string[]; extraEnv?: Record<string, string> } = {},
): KimchiSessionController {
	let running = false
	let exitMarker = ""
	let launchNumber = 0
	const extraArgs = options.extraArgs ?? []
	const extraEnv = options.extraEnv ?? fixture.seedEnv

	const start = async () => {
		if (running) throw new Error("Kimchi session is already running")
		launchNumber += 1
		exitMarker = `KIMCHI_E2E_EXIT_${process.pid}_${launchNumber}`
		launchKimchi(terminal, fixture, extraArgs, extraEnv, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		running = true
	}

	const quit = async () => {
		if (!running) return
		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		running = false
	}

	return {
		start,
		async turn(prompt, expectedText, turnOptions = {}) {
			if (!running) throw new Error("Kimchi session is not running")
			terminal.submit(prompt)
			await waitForText(terminal, expectedText, {
				timeoutMs: turnOptions.timeoutMs ?? STREAM_TIMEOUT_MS,
			})
		},
		async restart() {
			await quit()
			await start()
		},
		quit,
	}
}

export async function stopKimchi(terminal: Terminal): Promise<void> {
	const exit = new Promise<{ exitCode: number; signal?: number }>((resolveExit) => terminal.onExit(resolveExit))
	terminal.keyCtrlC(2)
	const timeout = new Promise<undefined>((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), 1_000))
	const result = await Promise.race([exit, timeout])
	if (!result) terminal.kill()
}

/** Create fixture, launch kimchi, wait for ready, run `body`, always tear down (artifact on throw). */
export async function runKimchiSession(
	terminal: Terminal,
	options: RunKimchiSessionOptions,
	body: (fixture: KimchiFixture, trace: TuiScenarioTrace) => Promise<void>,
): Promise<void> {
	const { artifactName, beforeReady, ...fixtureOptions } = options
	const fixture = await createKimchiFixture(fixtureOptions)
	let artifactWritten = false
	const steps: TuiStepSnapshot[] = []
	const trace: TuiScenarioTrace = {
		step(label) {
			steps.push({ label, at: new Date().toISOString(), view: viewText(terminal) })
		},
	}

	try {
		launchKimchi(terminal, fixture, fixtureOptions.extraArgs ?? [], { ...fixtureOptions.env, ...fixture.seedEnv })
		if (beforeReady) await beforeReady(terminal)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })
		trace.step("ready prompt visible")
		await body(fixture, trace)
		trace.step("scenario body completed")
	} catch (error) {
		// Set first so a throw in writeTuiArtifact can't trigger a "pass" artifact or mask the error.
		artifactWritten = true
		try {
			await writeTuiArtifact({ name: artifactName, outcome: "fail", terminal, fixture, steps, error })
		} catch (writeError) {
			process.stderr.write(`[tui-e2e] failed to write fail artifact: ${String(writeError)}\n`)
		}
		throw error
	} finally {
		if (DEBUG_ARTIFACTS && !artifactWritten) {
			try {
				await writeTuiArtifact({ name: artifactName, outcome: "pass", terminal, fixture, steps })
			} catch (writeError) {
				process.stderr.write(`[tui-e2e] failed to write pass artifact: ${String(writeError)}\n`)
			}
		}
		// Run both teardowns even if one throws.
		try {
			await stopKimchi(terminal)
		} catch (stopError) {
			process.stderr.write(`[tui-e2e] stopKimchi failed: ${String(stopError)}\n`)
		}
		try {
			await fixture.stop()
		} catch (stopError) {
			process.stderr.write(`[tui-e2e] fixture.stop failed: ${String(stopError)}\n`)
		}
	}
}

function assertMcpFixture(fixture: KimchiFixture): asserts fixture is McpKimchiFixture {
	if (!fixture.mcp) throw new Error("MCP test fixture was requested but not created")
}

export async function runMcpKimchiSession(
	terminal: Terminal,
	options: Omit<RunKimchiSessionOptions, "mcp"> & { mcp: McpFixtureOptions },
	body: (fixture: McpKimchiFixture, trace: TuiScenarioTrace) => Promise<void>,
): Promise<void> {
	await runKimchiSession(terminal, options, async (fixture, trace) => {
		assertMcpFixture(fixture)
		await body(fixture, trace)
	})
}

export async function runRestartableMcpKimchiSession(
	terminal: Terminal,
	options: Omit<RunKimchiSessionOptions, "beforeReady" | "mcp"> & { mcp: McpFixtureOptions },
	body: (fixture: McpKimchiFixture, session: KimchiSessionController, trace: TuiScenarioTrace) => Promise<void>,
): Promise<void> {
	const { artifactName, ...fixtureOptions } = options
	const fixture = await createMcpKimchiFixture(fixtureOptions)
	const session = createKimchiSessionController(terminal, fixture, {
		extraArgs: fixtureOptions.extraArgs,
		extraEnv: { ...fixtureOptions.env, ...fixture.seedEnv },
	})
	let artifactWritten = false
	const steps: TuiStepSnapshot[] = []
	const trace: TuiScenarioTrace = {
		step(label) {
			steps.push({ label, at: new Date().toISOString(), view: viewText(terminal) })
		},
	}

	try {
		await session.start()
		trace.step("ready prompt visible")
		await body(fixture, session, trace)
		trace.step("scenario body completed")
	} catch (error) {
		artifactWritten = true
		try {
			await writeTuiArtifact({ name: artifactName, outcome: "fail", terminal, fixture, steps, error })
		} catch (writeError) {
			process.stderr.write(`[tui-e2e] failed to write fail artifact: ${String(writeError)}\n`)
		}
		throw error
	} finally {
		if (DEBUG_ARTIFACTS && !artifactWritten) {
			await writeTuiArtifact({ name: artifactName, outcome: "pass", terminal, fixture, steps }).catch((writeError) => {
				process.stderr.write(`[tui-e2e] failed to write pass artifact: ${String(writeError)}\n`)
			})
		}
		await session.quit().catch(() => {})
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
}

interface WriteTuiArtifactOptions {
	name: string
	outcome: "pass" | "fail"
	terminal: Terminal
	fixture: KimchiFixture
	steps: TuiStepSnapshot[]
	error?: unknown
}

export async function writeTuiArtifact(options: WriteTuiArtifactOptions): Promise<void> {
	const { name, outcome } = options
	const baseName = name.replace(/\.(log|txt)$/i, "")
	const path = join(REPO_ROOT, `${baseName}.${outcome}.${TUI_ARTIFACT_RUN_ID}.tui-e2e.log`)
	writeFileSync(path, formatTuiArtifact(options), "utf-8")
	process.stderr.write(`[tui-e2e] wrote ${outcome} artifact: ${path}\n`)
}

export function sh(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

function writeModelsConfig(path: string, baseUrl: string, models: FakeModel[] | undefined, providerId: string): void {
	writeFileSync(
		path,
		JSON.stringify(
			{
				providers: {
					[providerId]: {
						baseUrl: `${baseUrl}/openai/v1`,
						apiKey: "fake",
						api: "openai-completions",
						authHeader: true,
						headers: { "User-Agent": "kimchi/tui-e2e" },
						models: resolveModels(models).map((model) => ({
							id: model.slug,
							name: model.displayName,
							reasoning: model.reasoning,
							input: model.input,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							provider: model.provider,
						})),
					},
				},
			},
			null,
			"\t",
		),
		"utf-8",
	)
}

function formatTuiArtifact({ name, outcome, terminal, fixture, steps, error }: WriteTuiArtifactOptions): string {
	return [
		"# Kimchi TUI E2E Artifact",
		[
			`name: ${name}`,
			`outcome: ${outcome}`,
			`runId: ${TUI_ARTIFACT_RUN_ID}`,
			`createdAt: ${new Date().toISOString()}`,
			`terminal: ${TUI_TEST_CONFIG.columns}x${TUI_TEST_CONFIG.rows}`,
			`binary: ${BINARY_PATH}`,
			`packageDir: ${PACKAGE_DIR}`,
			`homeDir: ${fixture.homeDir}`,
			`workDir: ${fixture.workDir}`,
			`fakeModelBaseUrl: ${fixture.fake.baseUrl}`,
			`fakeRequestCount: ${fixture.fake.requests.length}`,
		].join("\n"),
		error ? `## Error\n\n${formatError(error)}` : undefined,
		`## Scenario Steps\n\n${formatSteps(steps)}`,
		`## Fake OpenAI Requests\n\n${formatJson(fixture.fake.requests)}`,
		`## Final Viewable Terminal\n\n${viewText(terminal)}`,
		`## Final Full Terminal Buffer\n\n${fullText(terminal)}`,
	]
		.filter((section): section is string => Boolean(section))
		.join("\n\n")
}

function formatSteps(steps: TuiStepSnapshot[]): string {
	if (steps.length === 0) return "(none)"
	return steps.map((step, index) => `### ${index + 1}. ${step.label}\n\nat: ${step.at}\n\n${step.view}`).join("\n\n")
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, "\t")
}

function formatError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`
	return String(error)
}
