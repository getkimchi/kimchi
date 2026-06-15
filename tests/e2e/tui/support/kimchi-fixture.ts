import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import {
	type FakeModel,
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "./fake-openai-server.js"

const REPO_ROOT = resolve(process.env.KIMCHI_REPO_ROOT ?? "../../..")

export const BINARY_PATH = resolve(REPO_ROOT, "dist/bin/kimchi")
export const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")
export const TUI_ARTIFACT_DIR = resolve(REPO_ROOT, "test-results/tui-e2e")

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
			"--provider fake",
			"--model basic",
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

export async function writeTuiArtifact(name: string, content: string): Promise<void> {
	const path = join(TUI_ARTIFACT_DIR, name)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content, "utf-8")
}

export function sh(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

function writeModelsConfig(path: string, baseUrl: string, models: FakeModel[] | undefined): void {
	const configuredModels = models && models.length > 0 ? models : [{ slug: "basic", displayName: "Fake Basic" }]
	writeFileSync(
		path,
		JSON.stringify(
			{
				providers: {
					fake: {
						baseUrl: `${baseUrl}/openai/v1`,
						apiKey: "fake",
						api: "openai-completions",
						authHeader: true,
						headers: { "User-Agent": "kimchi/tui-e2e" },
						models: configuredModels.map((model) => ({
							id: model.slug,
							name: model.displayName,
							reasoning: model.reasoning ?? false,
							input: model.input ?? ["text"],
							contextWindow: model.contextWindow ?? 8192,
							maxTokens: model.maxTokens ?? 1024,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							provider: model.provider ?? "openai",
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
