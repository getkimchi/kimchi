import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type { RunOptions, RunResult } from "../agents/manager/agent-runner.js"
import { parseReviewTargetArgs } from "../review-targets/parser.js"
import { resolveReviewTarget } from "../review-targets/resolve.js"
import type { ExplicitReviewRequest } from "../review-targets/types.js"
import type { ReviewNetworkBoundary } from "./network-boundary.js"
import { ReviewRunner } from "./runner.js"

// This fixture isolates writer worktrees, not network enforcement. Inject its
// boundary explicitly so it behaves identically on macOS and restricted CI.
const testBoundary: ReviewNetworkBoundary = { kind: "sandbox-exec", wrap: (command) => command }

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

function refExists(root: string, ref: string): boolean {
	try {
		git(root, "rev-parse", "--verify", "--quiet", ref)
		return true
	} catch {
		return false
	}
}

async function branchTarget(root: string, contextDir: string) {
	const base = git(root, "rev-parse", "HEAD^")
	return resolveReviewTarget(parseReviewTargetArgs(["branch", "main", "--base", base]) as ExplicitReviewRequest, {
		root,
		contextDir,
	})
}

function completedRun(responseText: string): RunResult {
	return { responseText, session: {} as RunResult["session"], aborted: false, steered: false }
}

describe("review runner writer and worktree isolation", () => {
	let sandbox: string
	let repo: string
	let outputDir: string
	let runner: ReviewRunner | undefined

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "review-runner-panel-test-"))
		repo = join(sandbox, "repo")
		outputDir = join(sandbox, "review-output")
		mkdirSync(repo)
		git(repo, "init", "--initial-branch=main")
		git(repo, "config", "user.name", "Reviewer Test")
		git(repo, "config", "user.email", "review@localhost")
		writeFileSync(join(repo, "file.txt"), "base\n")
		git(repo, "add", "file.txt")
		git(repo, "commit", "-m", "base")
		writeFileSync(join(repo, "file.txt"), "head\n")
		git(repo, "add", "file.txt")
		git(repo, "commit", "-m", "head")
	})

	afterEach(async () => {
		await runner?.cleanup()
		vi.restoreAllMocks()
		rmSync(sandbox, { recursive: true, force: true })
	})

	it("runs same-path temporary tests concurrently and submits under each writer ID", async () => {
		const base = git(repo, "rev-parse", "HEAD^")
		const target = await resolveReviewTarget(
			parseReviewTargetArgs(["branch", "main", "--base", base]) as ExplicitReviewRequest,
			{
				root: repo,
				contextDir: join(sandbox, "review-context"),
			},
		)
		const spawns: Array<{
			cwd?: string
			isolated?: boolean
			isolatedConfig?: boolean
			signal?: AbortSignal
			writer: string
		}> = []
		runner = await ReviewRunner.create({
			ctx: createContext({ cwd: repo, hasUI: true }),
			pi: createExtensionApi().api,
			target,
			outputDir,
			rootDir: join(sandbox, "worktrees"),
			concurrency: 2,
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
			spawnAgent: async ({ prompt, options }): Promise<RunResult> => {
				const writer = prompt
				spawns.push({
					cwd: options.cwd,
					isolated: options.isolated,
					isolatedConfig: options.isolateProjectConfiguration,
					signal: options.signal,
					writer,
				})
				const child = createExtensionApi()
				for (const extension of options.extensionFactories ?? []) {
					if (typeof extension === "function") extension(child.api)
					else extension.factory(child.api)
				}
				const testPath = join(options.cwd ?? "", "focused.test.cjs")
				writeFileSync(testPath, `console.log(${JSON.stringify(writer)})`)
				// Make the two runs overlap after both have written the same relative path.
				await new Promise((resolve) => setTimeout(resolve, 30))
				const contexts = createToolContext({ cwd: options.cwd, hasUI: false })
				const bash = child.getRegisteredTool("bash")
				const bashResult = await bash.execute(
					`bash-${writer}`,
					{ command: "node focused.test.cjs" },
					options.signal,
					undefined,
					contexts,
				)
				expect(bashResult.isError).toBeUndefined()
				const summary = child.getRegisteredTool("submit_summary")
				const submitted = await summary.execute(
					`summary-${writer}`,
					{ body: `${writer} temporary test passed`, environment_gaps: [] },
					options.signal,
					undefined,
					contexts,
				)
				expect(submitted.details).toMatchObject({ accepted: true })
				return { responseText: writer, session: {} as RunResult["session"], aborted: false, steered: false }
			},
		})
		const [one, two] = await Promise.all([
			runner.spawnReviewer({ id: "spec", prompt: "spec", type: "General-Purpose" }),
			runner.spawnReviewer({ id: "security", prompt: "security", type: "General-Purpose" }),
		])
		expect(one.worktree.path).not.toBe(two.worktree.path)
		expect(readFileSync(join(one.worktree.path, "focused.test.cjs"), "utf8")).toContain("spec")
		expect(readFileSync(join(two.worktree.path, "focused.test.cjs"), "utf8")).toContain("security")
		expect(one.execution.records.at(-1)).toMatchObject({ status: "passed", network: "offline" })
		expect(two.execution.records.at(-1)).toMatchObject({ status: "passed", network: "offline" })
		expect(JSON.parse(readFileSync(join(outputDir, "summary", "spec.json"), "utf8"))).toMatchObject({
			writer: "spec",
			body: "spec temporary test passed",
		})
		expect(JSON.parse(readFileSync(join(outputDir, "summary", "security.json"), "utf8"))).toMatchObject({
			writer: "security",
			body: "security temporary test passed",
		})
		expect(existsSync(join(outputDir, "summary", "final.json"))).toBe(false)
		for (const spawn of spawns) {
			expect(spawn.isolated).toBe(true)
			expect(spawn.isolatedConfig).toBe(true)
			expect(spawn.signal).toBeDefined()
			expect(spawn.cwd).toBe(one.worktree.path === spawn.cwd ? one.worktree.path : two.worktree.path)
		}
	})

	it("writes durable session headers while every lens and verifier runs in its worktree", async () => {
		const target = await branchTarget(repo, join(sandbox, "review-context"))
		const parentSessionDir = join(sandbox, "parent-sessions")
		const parentSessionFile = join(parentSessionDir, "parent.jsonl")
		mkdirSync(parentSessionDir)
		writeFileSync(
			parentSessionFile,
			`${JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "01928374-5565-7abc-8def-123456789abc",
				timestamp: "2026-05-12T10:20:30.400Z",
				cwd: repo,
			})}\n`,
		)
		const ctx = createContext({
			cwd: repo,
			sessionManager: {
				getSessionDir: () => parentSessionDir,
				getSessionFile: () => parentSessionFile,
			},
		})
		const spawns: Array<{ writer: string; cwd?: string; sessionFile?: string; sessionDir?: string }> = []
		runner = await ReviewRunner.create({
			ctx,
			pi: createExtensionApi().api,
			target,
			outputDir,
			rootDir: join(sandbox, "worktrees"),
			concurrency: 2,
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
			spawnAgent: async ({ ctx: parentContext, options }): Promise<RunResult> => {
				expect(parentContext).toBe(ctx)
				const writer = options.description?.replace("Review writer ", "") ?? ""
				spawns.push({ writer, cwd: options.cwd, sessionFile: options.sessionFile, sessionDir: options.sessionDir })
				return completedRun(writer)
			},
		})

		const worktreePaths = [
			(await runner.spawnReviewer({ id: "spec", prompt: "spec" })).worktree.path,
			(await runner.spawnReviewer({ id: "standards", prompt: "standards" })).worktree.path,
			(await runner.spawnVerifier({ id: "reconciliation", prompt: "reconciliation" })).worktree.path,
		]

		expect(spawns.map((spawn) => spawn.writer)).toEqual(["spec", "standards", "reconciliation"])
		for (const [index, spawn] of spawns.entries()) {
			expect(spawn.cwd).toBe(worktreePaths[index])
			expect(spawn.sessionDir).toBe(parentSessionDir)
			expect(dirname(spawn.sessionFile ?? "")).toBe(parentSessionDir)
			const entries = readFileSync(spawn.sessionFile ?? "", "utf8")
				.trimEnd()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							type?: string
							parentSession?: string
							cwd?: string
							customType?: string
							data?: { type?: string }
						},
				)
			expect(entries).toHaveLength(2)
			expect(entries[0]).toMatchObject({ type: "session", parentSession: parentSessionFile, cwd: repo })
			expect(entries[1]).toMatchObject({
				type: "custom",
				customType: "kimchi:subagent-session",
				data: { type: `review:${spawn.writer}` },
			})
		}
	})

	it("passes no session paths when the parent has no session file", async () => {
		const target = await branchTarget(repo, join(sandbox, "review-context"))
		const parentSessionDir = join(sandbox, "in-memory-parent")
		mkdirSync(parentSessionDir)
		const received: RunOptions[] = []
		runner = await ReviewRunner.create({
			ctx: createContext({
				cwd: repo,
				sessionManager: { getSessionDir: () => parentSessionDir, getSessionFile: () => undefined },
			}),
			pi: createExtensionApi().api,
			target,
			outputDir,
			rootDir: join(sandbox, "worktrees"),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
			spawnAgent: async ({ options }): Promise<RunResult> => {
				received.push(options)
				return completedRun("done")
			},
		})

		await runner.spawnReviewer({ id: "spec", prompt: "spec" })
		await runner.spawnVerifier({ id: "reconciliation", prompt: "reconciliation" })

		expect(received).toHaveLength(2)
		for (const options of received) {
			expect(options).not.toHaveProperty("sessionFile")
			expect(options).not.toHaveProperty("sessionDir")
		}
		expect(readdirSync(parentSessionDir)).toEqual([])
	})

	it("passes no session paths when a fresh parent's allocated file is not flushed yet", async () => {
		const target = await branchTarget(repo, join(sandbox, "review-context"))
		const parentSessionDir = join(sandbox, "fresh-parent")
		const parentSessionFile = join(parentSessionDir, "allocated.jsonl")
		mkdirSync(parentSessionDir)
		const received: RunOptions[] = []
		runner = await ReviewRunner.create({
			ctx: createContext({
				cwd: repo,
				sessionManager: { getSessionDir: () => parentSessionDir, getSessionFile: () => parentSessionFile },
			}),
			pi: createExtensionApi().api,
			target,
			outputDir,
			rootDir: join(sandbox, "worktrees"),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
			spawnAgent: async ({ options }): Promise<RunResult> => {
				received.push(options)
				return completedRun("done")
			},
		})

		await expect(runner.spawnReviewer({ id: "spec", prompt: "spec" })).resolves.toMatchObject({
			responseText: "done",
		})
		expect(received).toHaveLength(1)
		expect(received[0]).not.toHaveProperty("sessionFile")
		expect(received[0]).not.toHaveProperty("sessionDir")
		expect(existsSync(parentSessionFile)).toBe(false)
		expect(readdirSync(parentSessionDir)).toEqual([])
	})

	it("continues in memory and logs when child session preparation fails", async () => {
		const target = await branchTarget(repo, join(sandbox, "review-context"))
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		let received: RunOptions | undefined
		const missingSessionDir = join(sandbox, "missing", "sessions")
		const parentSessionFile = join(sandbox, "parent.jsonl")
		writeFileSync(parentSessionFile, '{"type":"session"}\n')
		runner = await ReviewRunner.create({
			ctx: createContext({
				cwd: repo,
				sessionManager: {
					getSessionDir: () => missingSessionDir,
					getSessionFile: () => parentSessionFile,
				},
			}),
			pi: createExtensionApi().api,
			target,
			outputDir,
			rootDir: join(sandbox, "worktrees"),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
			spawnAgent: async ({ options }): Promise<RunResult> => {
				received = options
				return completedRun("continued")
			},
		})

		await expect(runner.spawnReviewer({ id: "spec", prompt: "spec" })).resolves.toMatchObject({
			responseText: "continued",
		})
		expect(received).not.toHaveProperty("sessionFile")
		expect(received).not.toHaveProperty("sessionDir")
		expect(warning).toHaveBeenCalledOnce()
		expect(warning).toHaveBeenCalledWith(expect.stringContaining("Continuing without a persisted transcript"))
	})

	it("rejects duplicate writer runs and finishes cancellation before worktree cleanup", async () => {
		const base = git(repo, "rev-parse", "HEAD^")
		const target = await resolveReviewTarget(
			parseReviewTargetArgs(["branch", "main", "--base", base]) as ExplicitReviewRequest,
			{
				root: repo,
				contextDir: join(sandbox, "review-context"),
			},
		)
		let started = () => {}
		const spawnStarted = new Promise<void>((resolve) => {
			started = resolve
		})
		let agentFinished = false
		let worktreePath = ""
		runner = await ReviewRunner.create({
			ctx: createContext({ cwd: repo }),
			pi: createExtensionApi().api,
			target,
			outputDir,
			rootDir: join(sandbox, "worktrees"),
			executionPolicy: { mode: "local", networkBoundary: testBoundary },
			spawnAgent: async ({ options }): Promise<RunResult> => {
				worktreePath = options.cwd ?? ""
				started()
				if (!options.signal) throw new Error("expected a cancellation signal")
				await new Promise<void>((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new Error("cancelled")), {
						once: true,
					})
				}).catch((error) => {
					agentFinished = true
					throw error
				})
				throw new Error("unreachable")
			},
		})
		const active = runner.spawnReviewer({ id: "spec", prompt: "spec" })
		await spawnStarted
		await expect(runner.spawnReviewer({ id: "spec", prompt: "duplicate" })).rejects.toThrow("already active")
		const cleanup = runner.cleanup()
		expect(runner.cleanup()).toBe(cleanup)
		await expect(active).rejects.toThrow()
		await cleanup
		expect(agentFinished).toBe(true)
		expect(existsSync(worktreePath)).toBe(false)
	})

	it("releases the target when runner validation fails before pool creation", async () => {
		writeFileSync(join(repo, "file.txt"), "working tree\n")
		const target = await resolveReviewTarget(parseReviewTargetArgs(["working-tree"]) as ExplicitReviewRequest, {
			root: repo,
			contextDir: join(sandbox, "review-context"),
		})
		const snapshotRef = target.scope.pinned.snapshotRef ?? ""
		expect(snapshotRef).not.toBe("")
		try {
			await expect(
				ReviewRunner.create({
					ctx: createContext({ cwd: repo }),
					pi: createExtensionApi().api,
					target,
					outputDir,
					rootDir: join(sandbox, "worktrees"),
					writerLimit: 0,
				}),
			).rejects.toThrow("Review writer limit")
			expect(refExists(repo, snapshotRef)).toBe(false)
		} finally {
			await target.cleanup()
		}
	})
})
