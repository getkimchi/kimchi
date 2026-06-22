import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Shell } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { STARTUP_TIMEOUT_MS, fullText, viewText, waitForText } from "./assertions.js"
import {
	DEFAULT_MODEL,
	type FakeModel,
	type FakeOpenAiServer,
	type FakeResponseScript,
	type RecordedRequest,
	resolveModels,
	startFakeOpenAiServer,
} from "./fake-openai-server.js"
import {
	type FakeOllamaModel,
	type FakeOllamaServer,
	type StartFakeOllamaServerOptions,
	startFakeOllamaServer,
} from "./fake-ollama-server.js"

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
	stop(): Promise<void>
}

export interface TuiScenarioTrace {
	step(label: string): void
}

interface TuiStepSnapshot {
	label: string
	at: string
	view: string
}

interface CreateKimchiFixtureOptions {
	models?: FakeModel[]
	responses: FakeResponseScript[]
	/** `git init` the work dir so repo-checking flows (e.g. ferment) don't prompt to init one. */
	gitInit?: boolean
	/**
	 * Extra args appended to the binary command line after `--provider`/`--model`.
	 * Use for test-only flags like `--extension <path>` to load a custom extension
	 * without having to commit fixture data alongside the harness.
	 */
	extraArgs?: string[]
	/** When provided, start a fake Ollama server alongside the OpenAI fake. The
	 *  server handles startup model discovery (/api/tags + /api/show) and chat
	 *  completions (/v1/chat/completions) so the TUI E2E can run without a real
	 *  `ollama serve` running. */
	ollama?: StartFakeOllamaServerOptions
}

export async function createKimchiFixture(options: CreateKimchiFixtureOptions): Promise<KimchiFixture> {
	const fake = await startFakeOpenAiServer(options)
	const ollama = options.ollama ? await startFakeOllamaServer(options.ollama) : undefined
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-tui-home-"))
	const workDir = mkdtempSync(join(tmpdir(), "kimchi-tui-work-"))
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

		writeModelsConfig(join(agentDir, "models.json"), fake.baseUrl, options.models)

		return {
			homeDir,
			workDir,
			agentDir,
			fake,
			ollama: ollama ? { baseUrl: ollama.baseUrl, requests: ollama.requests } : undefined,
			async stop() {
				// Run both server stops even if one throws, so a failing OpenAI
				// fake doesn't leak an Ollama fake listening on a port.
				await fake.stop().catch(() => {})
				if (ollama) {
					await ollama.stop().catch(() => {})
				}
				rmSync(homeDir, { recursive: true, force: true })
				rmSync(workDir, { recursive: true, force: true })
			},
		}
	} catch (error) {
		await fake.stop().catch(() => {})
		if (ollama) {
			await ollama.stop().catch(() => {})
		}
		rmSync(homeDir, { recursive: true, force: true })
		rmSync(workDir, { recursive: true, force: true })
		throw error
	}
}

export function launchKimchi(terminal: Terminal, fixture: KimchiFixture, extraArgs: string[] = []): void {
	terminal.submit(
		[
			`cd ${sh(fixture.workDir)} &&`,
			"env",
			`HOME=${sh(fixture.homeDir)}`,
			`PI_PACKAGE_DIR=${sh(PACKAGE_DIR)}`,
			...((fixture.ollama ? [`OLLAMA_HOST=${sh(fixture.ollama.baseUrl)}`] : []) as string[]),
			"TERM=xterm-256color",
			sh(BINARY_PATH),
			`--provider ${FAKE_PROVIDER}`,
			`--model ${DEFAULT_MODEL.slug}`,
			...extraArgs,
		].join(" "),
	)
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
	options: CreateKimchiFixtureOptions & { artifactName: string },
	body: (fixture: KimchiFixture, trace: TuiScenarioTrace) => Promise<void>,
): Promise<void> {
	const { artifactName, ...fixtureOptions } = options
	const fixture = await createKimchiFixture(fixtureOptions)
	let artifactWritten = false
	const steps: TuiStepSnapshot[] = []
	const trace: TuiScenarioTrace = {
		step(label) {
			steps.push({ label, at: new Date().toISOString(), view: viewText(terminal) })
		},
	}

	try {
		launchKimchi(terminal, fixture, fixtureOptions.extraArgs ?? [])
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

function writeModelsConfig(path: string, baseUrl: string, models: FakeModel[] | undefined): void {
	writeFileSync(
		path,
		JSON.stringify(
			{
				providers: {
					[FAKE_PROVIDER]: {
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
