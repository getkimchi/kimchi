import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import type { RunResult } from "../agents/manager/agent-runner.js"
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
})
