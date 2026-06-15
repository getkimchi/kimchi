import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Shell } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { STARTUP_TIMEOUT_MS, fullText, waitForText } from "./assertions.js"
import {
	DEFAULT_MODEL,
	type FakeModel,
	type FakeOpenAiServer,
	type FakeResponseScript,
	resolveModels,
	startFakeOpenAiServer,
} from "./fake-openai-server.js"

/** Shared terminal geometry/shell for every TUI e2e test. */
export const TUI_TEST_CONFIG = { shell: Shell.Bash, rows: 40, columns: 120 } as const

/** Prompt shown once the TUI is ready for input. */
export const PROMPT_READY = "ask anything or type / for commands"

const REPO_ROOT = resolve(process.env.KIMCHI_REPO_ROOT ?? "../../..")
const TUI_ARTIFACT_RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`

/** Provider key written into models.json and passed to the kimchi CLI; the two must agree. */
export const FAKE_PROVIDER = "fake"

export const BINARY_PATH = resolve(REPO_ROOT, "dist/bin/kimchi")
export const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")

export interface KimchiFixture {
	homeDir: string
	workDir: string
	agentDir: string
	fake: FakeOpenAiServer
	stop(): Promise<void>
}

interface CreateKimchiFixtureOptions {
	models?: FakeModel[]
	responses: FakeResponseScript[]
}

export async function createKimchiFixture(options: CreateKimchiFixtureOptions): Promise<KimchiFixture> {
	const fake = await startFakeOpenAiServer(options)
	const homeDir = mkdtempSync(join(tmpdir(), "kimchi-tui-home-"))
	const workDir = mkdtempSync(join(tmpdir(), "kimchi-tui-work-"))
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
		async stop() {
			await fake.stop()
			rmSync(homeDir, { recursive: true, force: true })
			rmSync(workDir, { recursive: true, force: true })
		},
	}
}

export function launchKimchi(terminal: Terminal, fixture: KimchiFixture): void {
	terminal.submit(
		[
			`cd ${sh(fixture.workDir)} &&`,
			"env",
			`HOME=${sh(fixture.homeDir)}`,
			`PI_PACKAGE_DIR=${sh(PACKAGE_DIR)}`,
			"TERM=xterm-256color",
			sh(BINARY_PATH),
			`--provider ${FAKE_PROVIDER}`,
			`--model ${DEFAULT_MODEL.slug}`,
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

/**
 * Run a TUI session end-to-end: create the fixture, launch kimchi, wait for the
 * ready prompt, run `body`, and always tear down — dumping the terminal to an
 * artifact if anything throws. Tests only supply their assertions.
 */
export async function runKimchiSession(
	terminal: Terminal,
	options: CreateKimchiFixtureOptions & { artifactName: string },
	body: (fixture: KimchiFixture) => Promise<void>,
): Promise<void> {
	const { artifactName, ...fixtureOptions } = options
	const fixture = await createKimchiFixture(fixtureOptions)
	try {
		launchKimchi(terminal, fixture)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })
		await body(fixture)
	} catch (error) {
		await writeTuiArtifact(artifactName, fullText(terminal))
		throw error
	} finally {
		await stopKimchi(terminal)
		await fixture.stop()
	}
}

export async function writeTuiArtifact(name: string, content: string): Promise<void> {
	const baseName = name.replace(/\.txt$/i, "")
	const path = join(REPO_ROOT, `${baseName}.${TUI_ARTIFACT_RUN_ID}.tui-e2e.txt`)
	writeFileSync(path, content, "utf-8")
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
