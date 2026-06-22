import { execFileSync } from "node:child_process"
import { appendFileSync, cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { fullText, viewText } from "./assertions.js"
import { BINARY_PATH, PACKAGE_DIR, sh, stopKimchi } from "./kimchi-fixture.js"

const DEFAULT_PROVIDER = "kimchi-dev"
const DEFAULT_MODEL = "kimi-k2.6"
const DEFAULT_BASE_URL = "https://llm.kimchi.dev/openai/v1"
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`

export interface LiveKimchiFixture {
	artifactDir: string
	homeDir: string
	workDir: string
	agentDir: string
	sessionDir: string
	eventLogPath: string
	terminalTranscriptPath: string
	provider: string
	model: string
	stop(): Promise<void>
}

export interface LiveArtifactOptions {
	name: string
	terminal: Terminal
	fixture: LiveKimchiFixture
	outcome: "pass" | "fail"
	error?: unknown
	notes?: unknown
}

export function createLiveKimchiFixture(name: string): LiveKimchiFixture {
	const artifactRoot = resolve(process.env.KIMCHI_TUI_LIVE_ARTIFACT_DIR ?? ".kimchi/evals/tui-live")
	const artifactDir = join(artifactRoot, `${name}-${RUN_ID}`)
	const homeDir = join(artifactDir, "home")
	const workDir = join(artifactDir, "work")
	const sessionDir = join(artifactDir, "sessions")
	const eventLogPath = join(artifactDir, "events.jsonl")
	const terminalTranscriptPath = join(artifactDir, "terminal-observations.jsonl")
	const configDir = join(homeDir, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	const provider =
		process.env.KIMCHI_TUI_LIVE_PROVIDER ?? parseProvider(process.env.KIMCHI_TUI_LIVE_MODEL) ?? DEFAULT_PROVIDER
	const model = parseModelId(process.env.KIMCHI_TUI_LIVE_MODEL) ?? DEFAULT_MODEL
	const baseUrl = process.env.KIMCHI_TUI_LIVE_BASE_URL ?? DEFAULT_BASE_URL

	mkdirSync(agentDir, { recursive: true })
	mkdirSync(workDir, { recursive: true })
	mkdirSync(sessionDir, { recursive: true })

	execFileSync("git", ["init", "-q"], { cwd: workDir })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify(
			{
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
		JSON.stringify(modelsConfig(provider, model, baseUrl), null, "\t"),
		"utf-8",
	)

	return {
		artifactDir,
		homeDir,
		workDir,
		agentDir,
		sessionDir,
		eventLogPath,
		terminalTranscriptPath,
		provider,
		model,
		async stop() {},
	}
}

export function appendLiveEvent(fixture: LiveKimchiFixture, event: Record<string, unknown>): void {
	appendFileSync(fixture.eventLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf-8")
}

export function appendLiveTerminalObservation(
	fixture: LiveKimchiFixture,
	terminal: Terminal,
	event: Record<string, unknown>,
): void {
	appendFileSync(
		fixture.terminalTranscriptPath,
		`${JSON.stringify({
			at: new Date().toISOString(),
			...event,
			viewable: viewText(terminal),
			full: fullText(terminal),
		})}\n`,
		"utf-8",
	)
}

export function launchLiveKimchi(terminal: Terminal, fixture: LiveKimchiFixture, extraArgs: string[] = []): void {
	const apiKey = process.env.KIMCHI_API_KEY
	if (!apiKey) throw new Error("KIMCHI_API_KEY is required for live TUI evals")
	terminal.submit(
		[
			`cd ${sh(fixture.workDir)} &&`,
			"env",
			`HOME=${sh(fixture.homeDir)}`,
			`PI_PACKAGE_DIR=${sh(PACKAGE_DIR)}`,
			`KIMCHI_API_KEY=${sh(apiKey)}`,
			"TERM=xterm-256color",
			sh(BINARY_PATH),
			`--session-dir ${sh(fixture.sessionDir)}`,
			`--provider ${sh(fixture.provider)}`,
			`--model ${sh(fixture.model)}`,
			...extraArgs,
		].join(" "),
	)
}

export async function stopLiveKimchi(terminal: Terminal, fixture: LiveKimchiFixture): Promise<void> {
	try {
		await stopKimchi(terminal)
	} finally {
		await fixture.stop()
	}
}

export function writeLiveArtifact(options: LiveArtifactOptions): string {
	const path = join(options.fixture.artifactDir, `${options.name}.${options.outcome}.tui-live.log`)
	writeFileSync(path, formatArtifact(options), "utf-8")
	process.stderr.write(`[tui-live] wrote ${options.outcome} artifact: ${path}\n`)
	return path
}

export function exportLatestSessionHtml(fixture: LiveKimchiFixture): string | undefined {
	const latest = latestJsonl(fixture.sessionDir)
	if (!latest) return undefined
	const outPath = join(fixture.artifactDir, `${basename(latest, ".jsonl")}.html`)
	try {
		execFileSync(BINARY_PATH, ["--export", latest, outPath], {
			env: {
				...process.env,
				HOME: fixture.homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: process.env.KIMCHI_API_KEY ?? "",
			},
			stdio: "ignore",
		})
		return outPath
	} catch (error) {
		writeFileSync(join(fixture.artifactDir, "export-error.txt"), formatError(error), "utf-8")
		return undefined
	}
}

export function snapshotWorkspace(fixture: LiveKimchiFixture): string {
	const outPath = join(fixture.artifactDir, "workspace")
	cpSync(fixture.workDir, outPath, {
		recursive: true,
		force: true,
		filter: (src) => !src.includes(`${fixture.workDir}/.git`),
	})
	return outPath
}

function parseProvider(ref: string | undefined): string | undefined {
	if (!ref?.includes("/")) return undefined
	return ref.split("/", 1)[0]
}

function parseModelId(ref: string | undefined): string | undefined {
	if (!ref) return undefined
	const slash = ref.indexOf("/")
	return slash === -1 ? ref : ref.slice(slash + 1)
}

function latestJsonl(dir: string): string | undefined {
	let latest: { path: string; mtimeMs: number } | undefined
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue
		const path = join(dir, name)
		const mtimeMs = statSync(path).mtimeMs
		if (!latest || mtimeMs > latest.mtimeMs) latest = { path, mtimeMs }
	}
	return latest?.path
}

function modelsConfig(provider: string, model: string, baseUrl: string): unknown {
	return {
		providers: {
			[provider]: {
				baseUrl,
				apiKey: "$KIMCHI_API_KEY",
				api: "openai-completions",
				authHeader: true,
				models: [
					{
						id: model,
						name: model,
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 262144,
						maxTokens: 262144,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}
}

function formatArtifact({ name, outcome, terminal, fixture, error, notes }: LiveArtifactOptions): string {
	return [
		"# Kimchi Live TUI Artifact",
		[
			`name: ${name}`,
			`outcome: ${outcome}`,
			`createdAt: ${new Date().toISOString()}`,
			`artifactDir: ${fixture.artifactDir}`,
			`homeDir: ${fixture.homeDir}`,
			`workDir: ${fixture.workDir}`,
			`sessionDir: ${fixture.sessionDir}`,
			`eventLogPath: ${fixture.eventLogPath}`,
			`terminalTranscriptPath: ${fixture.terminalTranscriptPath}`,
			`provider: ${fixture.provider}`,
			`model: ${fixture.model}`,
		].join("\n"),
		error ? `## Error\n\n${formatError(error)}` : undefined,
		notes ? `## Notes\n\n${JSON.stringify(notes, null, "\t")}` : undefined,
		`## Final Viewable Terminal\n\n${viewText(terminal)}`,
		`## Final Full Terminal Buffer\n\n${fullText(terminal)}`,
	]
		.filter((section): section is string => Boolean(section))
		.join("\n\n")
}

function formatError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`
	return String(error)
}
