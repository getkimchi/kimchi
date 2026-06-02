import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const reservedOAuthCallbackPorts = new Set<number>()

export interface KimchiTuiContext {
	cleanup(): void
	env: Record<string, string>
	program: {
		args: string[]
		file: string
	}
	repoDir: string
}

export interface SeedFermentOptions {
	id?: string
	name?: string
	phaseId?: string
	stepId?: string
}

export interface SeededFerment {
	id: string
	name: string
	phaseId: string
	stepId: string
}

export interface KimchiTuiOptions {
	apiKey?: string
	initialArgs?: string[]
	seedFerment?: SeedFermentOptions
}

export function createKimchiTuiContext(
	name: string,
	opts: KimchiTuiOptions = {},
): KimchiTuiContext {
	const root = join(tmpdir(), `kimchi-tui-${name}-${process.pid}`)
	const home = join(root, "home")
	const cwd = join(root, "repo")
	const configDir = join(home, ".config", "kimchi")
	const agentDir = join(configDir, "harness")

	rmSync(root, { recursive: true, force: true })
	mkdirSync(agentDir, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	writeFileSync(join(cwd, "README.md"), "# TUI smoke fixture\n", "utf-8")
	spawnSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" })
	const seededFerment = opts.seedFerment ? seedActiveFerment(cwd, opts.seedFerment) : undefined
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify(
			{
				migrationState: "done",
				onboarding: { hideSessionModeDialog: true, sessionModeWizardSeenAt: "2026-05-29T00:00:00.000Z" },
				skillPaths: [],
				telemetry: { enabled: false },
			},
			null,
			2,
		),
		"utf-8",
	)
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					"kimchi-dev": {
						api: "openai-completions",
						apiKey: "KIMCHI_API_KEY",
						authHeader: true,
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						models: [
							{
								contextWindow: 262144,
								cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
								id: "kimi-k2.5",
								input: ["text"],
								maxTokens: 262144,
								name: "Kimi K2.5",
								reasoning: true,
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
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				lastTerminalWarnings: { no_keyboard_protocol: "2999-01-01" },
				newlineHintDismissed: true,
				quietStartup: true,
				resources: { "plugins.mcp-apps": false },
				theme: "kimchi-minimal",
			},
			null,
			2,
		),
		"utf-8",
	)

	const initialArgs = opts.initialArgs?.map(shellQuote).join(" ") ?? ""
	const command = `cd ${shellQuote(cwd)} && exec ${shellQuote(BINARY_PATH)}${initialArgs ? ` ${initialArgs}` : ""}`
	const oauthCallbackPort = pickAvailablePort(name)
	const env: Record<string, string> = {
		HOME: home,
		KIMCHI_API_KEY: opts.apiKey ?? "tui-test-dummy",
		KIMCHI_NO_UPDATE_CHECK: "1",
		KIMCHI_PERMISSIONS: "yolo",
		KIMCHI_TELEMETRY_ENABLED: "0",
		MCP_OAUTH_CALLBACK_PORT: oauthCallbackPort,
		PATH: process.env.PATH ?? "",
		PI_PACKAGE_DIR: PACKAGE_DIR,
		TERM: "xterm-256color",
	}
	if (seededFerment) env.KIMCHI_ACTIVE_FERMENT = seededFerment.id
	const context = {
		cleanup: () => rmSync(root, { recursive: true, force: true }),
		env,
		program: {
			args: ["-lc", command],
			file: "bash",
		},
		repoDir: cwd,
	}
	process.on("exit", context.cleanup)
	return context
}

export function useKimchiTui(context: KimchiTuiContext): void {
	test.use({
		columns: 140,
		env: context.env,
		program: context.program,
		rows: 44,
	})
	test.afterAll(() => context.cleanup())
}

export async function waitForPrompt(terminal: Terminal): Promise<void> {
	await waitForView(
		terminal,
		(view) => view.includes("ask anything or type / for commands") || view.includes("What would you like to ferment?"),
		45_000,
	)
	await sleep(1_000)
	if (viewText(terminal).includes("What would you like to ferment?")) {
		terminal.keyEscape()
		await sleep(100)
		if (viewText(terminal).includes("What would you like to ferment?")) terminal.keyCtrlC()
		await waitForView(
			terminal,
			(view) => view.includes("ask anything or type / for commands") && !view.includes("What would you like to ferment?"),
			10_000,
		)
	}
	await sleep(500)
	if (viewText(terminal).includes("What would you like to ferment?")) {
		terminal.keyCtrlC()
		await waitForView(
			terminal,
			(view) => view.includes("ask anything or type / for commands") && !view.includes("What would you like to ferment?"),
			10_000,
		)
	}
	await sleep(500)
}

export async function loadSeededFermentWithoutResume(terminal: Terminal, fermentName: string): Promise<void> {
	await expectVisible(terminal, `Active ferment "${fermentName}"`, 45_000)
	await expectVisible(terminal, "Leave paused", 45_000)
	terminal.keyDown()
	terminal.keyPress(Key.Enter)
	await sleep(500)
}

export function assertPersistedFermentStepTodos(
	context: KimchiTuiContext,
	ferment: SeededFerment,
	expected: {
		blocked?: number
		completed?: number
		contentIncludes?: string
		inProgress?: number
		pending?: number
		total: number
	},
): void {
	const filePath = join(context.repoDir, ".kimchi", "ferments", ferment.id, "todos.json")
	if (!existsSync(filePath)) throw new Error(`Expected persisted Ferment todos at ${filePath}`)
	const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
		byScope?: Record<string, { nextId?: number; todos?: Array<{ content?: string; id?: number; status?: string }> }>
	}
	const byScope = parsed.byScope ?? {}
	const stepScopeKey = ["ferment_step", ferment.id, ferment.phaseId, ferment.stepId]
		.map((part) => encodeURIComponent(part))
		.join(":")
	const scopeKeys = Object.keys(byScope).sort()
	if (scopeKeys.length !== 1 || scopeKeys[0] !== stepScopeKey) {
		throw new Error(`Expected only ${stepScopeKey}; got ${scopeKeys.join(", ") || "(none)"}`)
	}

	const entry = byScope[stepScopeKey]
	const todos = entry?.todos ?? []
	if (todos.length !== expected.total) throw new Error(`Expected ${expected.total} todos; got ${todos.length}`)
	if (entry?.nextId !== expected.total + 1) throw new Error(`Expected nextId ${expected.total + 1}; got ${entry?.nextId}`)
	if (new Set(todos.map((todo) => todo.id)).size !== todos.length) throw new Error("Expected persisted todo ids to be unique")
	if (todos.some((todo) => typeof todo.content !== "string" || todo.content.trim() === "")) {
		throw new Error("Expected every persisted todo to have non-empty content")
	}
	if (expected.contentIncludes && !todos.some((todo) => todo.content?.includes(expected.contentIncludes))) {
		throw new Error(`Expected persisted todos to include content containing "${expected.contentIncludes}"`)
	}

	const counts = todos.reduce(
		(acc, todo) => {
			if (todo.status === "pending") acc.pending += 1
			else if (todo.status === "in_progress") acc.inProgress += 1
			else if (todo.status === "blocked") acc.blocked += 1
			else if (todo.status === "completed") acc.completed += 1
			else throw new Error(`Unexpected todo status "${todo.status}"`)
			return acc
		},
		{ blocked: 0, completed: 0, inProgress: 0, pending: 0 },
	)
	for (const key of ["blocked", "completed", "inProgress", "pending"] as const) {
		const value = expected[key]
		if (value !== undefined && counts[key] !== value) throw new Error(`Expected ${key}=${value}; got ${counts[key]}`)
	}
}

export function assertSeededFermentStepStillRunning(
	context: KimchiTuiContext,
	ferment: SeededFerment,
): void {
	const filePath = join(context.repoDir, ".kimchi", "ferments", `${ferment.id}.json`)
	const snapshot = JSON.parse(readFileSync(filePath, "utf-8")) as {
		activePhaseId?: string
		phases?: Array<{ id?: string; status?: string; steps?: Array<{ id?: string; status?: string }> }>
		status?: string
	}
	const activePhase = snapshot.phases?.find((phase) => phase.id === ferment.phaseId)
	const activeStep = activePhase?.steps?.find((step) => step.id === ferment.stepId)
	if (snapshot.status !== "running") throw new Error(`Expected Ferment status running; got ${snapshot.status}`)
	if (snapshot.activePhaseId !== ferment.phaseId) {
		throw new Error(`Expected activePhaseId ${ferment.phaseId}; got ${snapshot.activePhaseId}`)
	}
	if (activePhase?.status !== "active") throw new Error(`Expected active phase status active; got ${activePhase?.status}`)
	if (activeStep?.status !== "running") throw new Error(`Expected active step status running; got ${activeStep?.status}`)
}

export async function expectVisible(terminal: Terminal, text: string | RegExp, timeout = 10_000): Promise<void> {
	await expect(terminal.getByText(text, { strict: false })).toBeVisible({ timeout })
}

export async function expectHidden(terminal: Terminal, text: string | RegExp, timeout = 2_000): Promise<void> {
	await expect(terminal.getByText(text, { strict: false })).not.toBeVisible({ timeout })
}

export async function typeAndSubmit(terminal: Terminal, text: string): Promise<void> {
	await typeText(terminal, text)
	terminal.keyPress(Key.Enter)
}

async function typeText(terminal: Terminal, text: string): Promise<void> {
	for (const char of text) {
		terminal.write(char)
		await sleep(5)
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function viewText(terminal: Terminal): string {
	return terminal
		.getViewableBuffer()
		.map((row) => row.join("").trimEnd())
		.join("\n")
}

async function waitForView(terminal: Terminal, predicate: (view: string) => boolean, timeout: number): Promise<void> {
	const startedAt = Date.now()
	for (;;) {
		const view = viewText(terminal)
		if (predicate(view)) return
		if (Date.now() - startedAt > timeout) {
			throw new Error(`Timed out waiting for terminal view after ${timeout}ms.\n${view}`)
		}
		await sleep(50)
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

function seedActiveFerment(cwd: string, seed: SeedFermentOptions): SeededFerment {
	const id = seed.id ?? "ferment-tui-seed"
	const name = seed.name ?? "Seeded TUI ferment"
	const phaseId = seed.phaseId ?? "phase-1"
	const stepId = seed.stepId ?? "step-1"
	const now = "2026-05-29T00:00:00.000Z"
	const ferment = {
		id,
		name,
		description: "Seeded active Ferment for TUI smoke assertions.",
		goal: "Verify Ferment tactical todos in the TUI.",
		successCriteria: "The tactical todo overlay renders for the active Ferment step.",
		constraints: [],
		status: "running",
		activePhaseId: phaseId,
		worktree: { path: cwd },
		scoping: {
			goal: { answer: "Verify Ferment tactical todos in the TUI.", confirmedAt: now },
			criteria: { answer: "The tactical todo overlay renders for the active Ferment step.", confirmedAt: now },
			constraints: { answer: "None.", confirmedAt: now },
			phases: { answer: "Use one verification phase.", confirmedAt: now },
		},
		phases: [
			{
				id: phaseId,
				index: 1,
				name: "Verification",
				goal: "Verify scoped todos.",
				status: "active",
				startedAt: now,
				steps: [
					{
						id: stepId,
						index: 1,
						description: "Check tactical todo overlay.",
						status: "running",
						startedAt: now,
					},
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	}
	const fermentsDir = join(cwd, ".kimchi", "ferments")
	mkdirSync(fermentsDir, { recursive: true })
	writeFileSync(join(fermentsDir, `${id}.json`), `${JSON.stringify(ferment, null, 2)}\n`, "utf-8")
	return { id, name, phaseId, stepId }
}

function pickAvailablePort(name: string): string {
	const hash = [...name].reduce((acc, char) => (acc * 33 + char.charCodeAt(0)) % 10_000, 0)
	for (let attempt = 0; attempt < 100; attempt++) {
		const port = 45_000 + ((hash + attempt) % 10_000)
		if (!reservedOAuthCallbackPorts.has(port) && isPortAvailable(port)) {
			reservedOAuthCallbackPorts.add(port)
			return String(port)
		}
	}
	const fallbackPort = 55_000 + (hash % 1_000)
	reservedOAuthCallbackPorts.add(fallbackPort)
	return String(fallbackPort)
}

function isPortAvailable(port: number): boolean {
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			"const net=require('node:net');const port=Number(process.argv[1]);const server=net.createServer();server.once('error',()=>process.exit(1));server.listen(port,'127.0.0.1',()=>server.close(()=>process.exit(0)));",
			String(port),
		],
		{ stdio: "ignore" },
	)
	return result.status === 0
}
