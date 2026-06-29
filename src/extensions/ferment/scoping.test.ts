import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { runScopingFlow } from "./scoping.js"

function createRuntime(): { runtime: FermentRuntime; storage: FermentEventStore } {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-scoping-flow-test-")))
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
	}
	return { runtime, storage }
}

function makePi(): ExtensionAPI {
	let activeTools: string[] = []
	return {
		on: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => [{ name: "propose_ferment_scoping" }, { name: "list_ferments" }]),
		setActiveTools: vi.fn((names: string[]) => {
			activeTools = names
		}),
	} as unknown as ExtensionAPI
}

function makeCtx(inputResponses: (string | undefined)[]): ExtensionCommandContext {
	const inputMock = vi.fn()
	for (const response of inputResponses) {
		inputMock.mockResolvedValueOnce(response)
	}
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			input: inputMock,
		},
	} as unknown as ExtensionCommandContext
}

describe("attachPendingProposal", () => {
	it("replaces pending buffer wholesale — omitted fields become undefined", () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("Test")
		// Seed a full buffer
		runtime.setPendingScope(ferment.id, {
			goal: "old goal",
			successCriteria: ["old criteria"],
			constraints: ["old constraint"],
			assumptions: "old assumption",
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		// Replace with only goal+phases; other fields should be cleared
		const replaced = runtime.attachPendingProposal(ferment.id, {
			title: "New Title",
			goal: "new goal",
			phases: [{ name: "P2", goal: "Ship", steps: [{ description: "Deploy" }] }],
		})

		expect(replaced).toBe(true)
		const pending = runtime.getPendingScope(ferment.id)
		expect(pending?.title).toBe("New Title")
		expect(pending?.goal).toBe("new goal")
		expect(pending?.successCriteria).toEqual([])
		expect(pending?.constraints).toEqual([])
		expect(pending?.assumptions).toBeUndefined()
		expect(pending?.phases?.[0]?.name).toBe("P2")
	})

	it("returns false when no pending scope exists for the ferment", () => {
		const { runtime } = createRuntime()
		const result = runtime.attachPendingProposal("nonexistent-id", { goal: "g" })
		expect(result).toBe(false)
	})
})

describe("runScopingFlow", () => {
	it("single non-empty input → markScopingInteractive called + sendMessage fired with intent embedded in content", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx(["I want to build a login system"])

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(markSpy).toHaveBeenCalledWith(ferment.id)
		// Now sends 3 messages: breadcrumb + request + nudge
		expect(pi.sendMessage).toHaveBeenCalledTimes(3)
		const requestCall = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((call) => (call[0] as { customType?: string }).customType === "ferment_request")
		expect(requestCall?.[0]).toMatchObject({
			customType: "ferment_request",
			display: true,
			details: { intent: "I want to build a login system" },
		})
		const nudgeCall = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((call) => (call[0] as { customType?: string }).customType === "ferment_created_nudge")
		const msg = nudgeCall?.[0] as { content: { type: string; text: string }[] }
		const text = msg.content.map((c) => c.text).join("")
		expect(text).toContain("Task:\nScope a Ferment through a structured orient-interview-plan flow.")
		expect(text).toContain("Context:")
		expect(text).toContain("I want to build a login system")
		expect(text).toContain(`ferment_id "${ferment.id}"`)
		expect(text).toContain("Do NOT call create_ferment")
		// Orient-interview scoping sequence
		expect(text).toContain('<scoping_sequence required="true">')
		expect(text).toContain("STEP 1")
		expect(text).toContain("ORIENT")
		expect(text).toContain("STEP 2")
		expect(text).toContain("INTERVIEW")
		expect(text).toContain("iterative rounds")
		expect(text).toContain("STEP 3")
		expect(text).toContain("COMPLETION CRITERIA")
		expect(text).toContain("STEP 4")
		expect(text).toContain("DEEP EXPLORATION")
		expect(text).toContain("STEP 5")
		expect(text).toContain("PLAN")
		expect(text).toContain('subagent_type: "Explore"')
		expect(text).toContain("token_budget: 120000")
		expect(text).toContain("STEP 1 \u2014 ORIENT")
		expect(text).toContain("STEP 5 \u2014 PLAN")
		expect(text).toContain("Output contract:")
		expect(text).toContain("gates array is required")
		expect(text).toContain("exactly P1, P2, and P3")
		expect(text).toContain("Call propose_ferment_scoping")
	})

	it("prefers ctx.ui.editor for the free-form scoping prompt", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ui = {
			notify: vi.fn(),
			editor: vi.fn().mockResolvedValue("I want to build reports\nwith export tests"),
			input: vi.fn().mockResolvedValue("single-line fallback"),
		}
		const ctx = {
			hasUI: true,
			ui,
		} as unknown as ExtensionCommandContext

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(ui.editor).toHaveBeenCalledWith("What do you want to do?\nDescribe what you want to accomplish…", "")
		expect(ui.input).not.toHaveBeenCalled()
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_request",
				details: { intent: "I want to build reports\nwith export tests" },
			}),
			{ triggerTurn: false },
		)
	})

	it("undefined input (Esc) → no sendMessage, no markScopingInteractive, no pendingScope", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx([undefined])

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(markSpy).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(runtime.getPendingScope(ferment.id)).toBeUndefined()
	})

	it("empty string input → no sendMessage, no markScopingInteractive (rejected pre-LLM)", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx([""])

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(markSpy).not.toHaveBeenCalled()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("headless (no ctx.ui.input) → falls through to existing nudge path (sendMessage fired)", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		// Headless: ctx with no input function
		const ctx = {
			hasUI: false,
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext

		await runScopingFlow(ferment, pi, ctx, runtime)

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("pre-captured intent → does NOT call ctx.ui.input and proceeds directly to sendMessage", async () => {
		const { runtime, storage } = createRuntime()
		const ferment = storage.create("My Ferment")
		const pi = makePi()
		const ctx = makeCtx([])
		// biome-ignore lint/style/noNonNullAssertion: makeCtx always populates ctx.ui.input
		const inputSpy = vi.mocked(ctx.ui.input!)

		const markSpy = vi.spyOn(runtime, "markScopingInteractive")

		await runScopingFlow(ferment, pi, ctx, runtime, "Pre-captured intent text")

		expect(inputSpy).not.toHaveBeenCalled()
		expect(markSpy).toHaveBeenCalledWith(ferment.id)
		// Now sends 2 messages: breadcrumb + nudge
		expect(pi.sendMessage).toHaveBeenCalledTimes(2)
		expect(pi.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ customType: "ferment_request" }))
		const nudgeCall = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((call) => (call[0] as { customType?: string }).customType === "ferment_created_nudge")
		const msg = nudgeCall?.[0] as { content: { type: string; text: string }[] }
		const text = msg.content.map((c) => c.text).join("")
		expect(text).toContain("Pre-captured intent text")
	})
})

// ═══════════════════════════════════════════════════════════════════════════════
// Worktree creation hook at scope-save time
// ═══════════════════════════════════════════════════════════════════════════════

const GIT_TIMEOUT = 10_000

function runGit(command: string, cwd: string): string {
	return execSync(command, {
		cwd,
		encoding: "utf-8",
		timeout: GIT_TIMEOUT,
		stdio: ["ignore", "pipe", "ignore"],
	}).trim()
}

function initTempRepo(): string {
	const dir = mkdtempSync(resolve(tmpdir(), "ferment-scoping-worktree-"))
	runGit("git init", dir)
	runGit("git config user.name Tester", dir)
	runGit("git config user.email tester@example.com", dir)
	writeFileSync(resolve(dir, "README.md"), "hello\n")
	runGit("git add README.md", dir)
	runGit("git commit -m initial", dir)
	return dir
}

function enableWorktreeConfig(repoRoot: string): void {
	const configDir = resolve(repoRoot, ".kimchi")
	mkdirSync(configDir, { recursive: true })
	writeFileSync(
		resolve(configDir, "config.json"),
		JSON.stringify({ ferments: { worktree: { enabled: true } } }, null, 2),
	)
}

function createRuntimeInRepo(repoRoot: string): { runtime: FermentRuntime; storage: FermentEventStore } {
	const storage = new FermentEventStore(resolve(repoRoot, ".kimchi", "ferments"))
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
	}
	return { runtime, storage }
}

function createFermentInRepo(storage: FermentEventStore, repoRoot: string, name: string) {
	const ferment = storage.create(name)
	// FermentStorage.create captures worktree from process.cwd(), which in tests
	// is the real project root. Pin the ferment to the temp repo instead.
	const commit = runGit("git rev-parse HEAD", repoRoot)
	const branch = runGit("git rev-parse --abbrev-ref HEAD", repoRoot)
	storage.updateWorktree(ferment.id, { path: repoRoot, branch, commit })
	return storage.get(ferment.id) ?? ferment
}

describe("worktree", () => {
	const tempDirs: string[] = []

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true })
		}
		tempDirs.length = 0
	})

	function tempRepo(): string {
		const dir = initTempRepo()
		tempDirs.push(dir)
		return dir
	}

	function readEvents(storage: FermentEventStore, fermentId: string): Array<{ type?: string; payload?: unknown }> {
		// The event store writes to <fermentId>.events.jsonl inside its dir.
		// Reach through the private-ish storage dir using a known file path.
		const dir = resolve(tmpdir())
		for (const tempDir of tempDirs) {
			const eventsPath = resolve(tempDir, ".kimchi", "ferments", `${fermentId}.events.jsonl`)
			try {
				return readFileSync(eventsPath, "utf-8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line) as { type?: string; payload?: unknown })
			} catch {
				// try next temp dir
			}
		}
		return []
	}

	it("creates a dedicated worktree when worktree isolation is enabled", () => {
		const repoRoot = tempRepo()
		enableWorktreeConfig(repoRoot)
		const { runtime, storage } = createRuntimeInRepo(repoRoot)
		const ferment = createFermentInRepo(storage, repoRoot, "Worktree On")
		runtime.setPendingScope(ferment.id, {
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", undefined)

		expect(result.ok).toBe(true)
		const scoped = result.ok ? result.outcome.ferment : undefined
		const saved = storage.get(ferment.id)
		const shortId = ferment.id.slice(0, 8)
		const expectedPath = resolve(repoRoot, ".worktrees", `ferment-${shortId}`)
		const expectedBranch = `ferment/${shortId}`

		expect(scoped?.worktree.path).toBe(expectedPath)
		expect(scoped?.worktree.branch).toBe(expectedBranch)
		expect(saved?.worktree.path).toBe(expectedPath)
		expect(saved?.worktree.branch).toBe(expectedBranch)
		expect(saved?.worktree.commit).toBeDefined()

		const worktrees = runGit("git worktree list --porcelain", repoRoot)
		expect(worktrees).toContain(expectedPath)

		const decisions = saved?.decisions ?? []
		expect(decisions.some((d) => d.title === "Created ferment worktree")).toBe(true)

		const events = readEvents(storage, ferment.id)
		expect(events.some((e) => e.type === "worktree_updated")).toBe(true)
		expect(events.some((e) => e.type === "decision_added")).toBe(true)
	})

	it("does not create a worktree when worktree isolation is disabled", () => {
		const repoRoot = tempRepo()
		// No project config; readWorktreeEnabled defaults to false.
		const { runtime, storage } = createRuntimeInRepo(repoRoot)
		const ferment = createFermentInRepo(storage, repoRoot, "Worktree Off")
		runtime.setPendingScope(ferment.id, {
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", undefined)

		expect(result.ok).toBe(true)
		const saved = storage.get(ferment.id)
		expect(saved?.worktree.path).toBe(repoRoot)
		expect(saved?.worktree.branch).toMatch(/^master|main$/)

		const worktrees = runGit("git worktree list --porcelain", repoRoot)
		expect(worktrees).not.toContain(resolve(repoRoot, ".worktrees"))
	})

	it("skips worktree creation when already inside a linked worktree", () => {
		const repoRoot = tempRepo()
		enableWorktreeConfig(repoRoot)
		// Pre-create a linked worktree and treat it as the agent cwd.
		const existingWorktree = resolve(repoRoot, ".worktrees", "existing")
		runGit(`git worktree add -b existing/branch ${JSON.stringify(existingWorktree)} HEAD`, repoRoot)
		const { runtime, storage } = createRuntimeInRepo(repoRoot)
		const ferment = createFermentInRepo(storage, repoRoot, "Already In Worktree")
		runtime.setPendingScope(ferment.id, {
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const originalCwd = process.cwd()
		try {
			process.chdir(existingWorktree)
			const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", undefined)

			expect(result.ok).toBe(true)
			const saved = storage.get(ferment.id)
			expect(saved?.worktree.path).toBe(repoRoot)
			// Only the pre-existing linked worktree should exist.
			const worktrees = runGit("git worktree list --porcelain", repoRoot)
			const fermentWorktree = resolve(repoRoot, ".worktrees", `ferment-${ferment.id.slice(0, 8)}`)
			expect(worktrees).not.toContain(fermentWorktree)
		} finally {
			process.chdir(originalCwd)
		}
	})

	it("does not create a worktree for legacy ferments that lack a branch", () => {
		const repoRoot = tempRepo()
		enableWorktreeConfig(repoRoot)
		const { runtime, storage } = createRuntimeInRepo(repoRoot)
		const ferment = createFermentInRepo(storage, repoRoot, "Legacy")
		// Simulate legacy snapshot: path only, no branch/commit.
		storage.updateWorktree(ferment.id, { path: repoRoot })
		runtime.setPendingScope(ferment.id, {
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "P1", goal: "Build", steps: [{ description: "Do it" }] }],
		})

		const result = confirmPendingScope(runtime, ferment.id, undefined, "turn_end", undefined)

		expect(result.ok).toBe(true)
		const saved = storage.get(ferment.id)
		expect(saved?.worktree.path).toBe(repoRoot)
		expect(saved?.worktree.branch).toBeUndefined()
		const worktrees = runGit("git worktree list --porcelain", repoRoot)
		expect(worktrees).not.toContain(resolve(repoRoot, ".worktrees"))
	})
})
