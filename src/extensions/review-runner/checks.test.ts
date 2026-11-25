import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { DEFAULT_CONFIG } from "../permissions/constants.js"
import { createWorkerPermissionsExtension } from "../permissions/index.js"
import { registerParentSurface, unregisterParentSurface } from "../permissions/parent-surface-registry.js"
import { registerPermissionPolicySource } from "../permissions/policy-source-registry.js"
import type { PermissionRequest } from "../permissions/prompter.js"
import { parseRules } from "../permissions/rules.js"
import type { Rule } from "../permissions/types.js"
import { parseReviewTargetArgs } from "../review-targets/parser.js"
import { resolveReviewTarget } from "../review-targets/resolve.js"
import type { ExplicitReviewRequest, ResolvedReviewTarget } from "../review-targets/types.js"
import type { ReviewCheckDefinition } from "./check-config.js"
import { ReviewCheckQueue, ReviewCheckStateError } from "./checks.js"
import { createReviewExecutionController } from "./execution.js"
import type { ReviewNetworkBoundary } from "./network-boundary.js"
import { registerReviewChildTools } from "./tools.js"
import type { ReviewWorktree, ReviewWorktreePool } from "./types.js"
import { createReviewWorktreePool } from "./worktrees.js"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

const testBoundary: ReviewNetworkBoundary = { kind: "sandbox-exec", wrap: (command) => command }

function requesterWorktree(root: string, id: string): ReviewWorktree {
	return {
		id,
		kind: "reviewer",
		revision: "head",
		path: join(root, id),
		pinnedSha: "a".repeat(40),
		scratchDir: "",
		buildDir: "",
		cacheDir: "",
		homeDir: "",
		env: {},
	}
}

describe("shared routine review checks", () => {
	let sandbox: string
	let repo: string
	let outputDir: string
	let baseSha: string
	let target: ResolvedReviewTarget
	let pool: ReviewWorktreePool
	let queue: ReviewCheckQueue
	let policyCleanups: Array<() => void> = []

	beforeEach(() => {
		policyCleanups = []
		sandbox = mkdtempSync(join(tmpdir(), "review-checks-test-"))
		repo = join(sandbox, "repo")
		outputDir = join(sandbox, "review-output")
		mkdirSync(repo)
		git(repo, "init", "--initial-branch=main")
		git(repo, "config", "user.name", "Reviewer Test")
		git(repo, "config", "user.email", "review@localhost")
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ name: "check-fixture", type: "commonjs", scripts: { test: "node check.cjs" } }),
		)
		writeFileSync(join(repo, "value.json"), JSON.stringify({ value: "base" }))
		writeFileSync(
			join(repo, "check.cjs"),
			`const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.env.TMPDIR, 'runs'), 'run\\n');
console.log(require('./value.json').value)`,
		)
		writeFileSync(
			join(repo, "failure.cjs"),
			`const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.env.TMPDIR, 'runs'), 'failure\\n');
console.error('routine failure'); process.exit(4)`,
		)
		writeFileSync(join(repo, "upcoming.cjs"), "console.log('must not run in wrap-up')")
		writeFileSync(join(repo, "focused.cjs"), "console.log('private focused result')")
		git(repo, "add", "--all")
		git(repo, "commit", "-m", "base")
		baseSha = git(repo, "rev-parse", "HEAD")
		writeFileSync(join(repo, "value.json"), JSON.stringify({ value: "head" }))
		git(repo, "add", "value.json")
		git(repo, "commit", "-m", "head")
	})

	afterEach(async () => {
		for (const cleanup of policyCleanups) cleanup()
		await queue?.dispose()
		await pool?.cleanup()
		rmSync(sandbox, { recursive: true, force: true })
	})

	const definitions: ReviewCheckDefinition[] = [
		{
			id: "test",
			command: "node check.cjs",
			cwd: ".",
			kind: "test",
			builds: true,
			toolchain: "node-test",
			dependencies: ["value.json"],
		},
		{
			id: "failure",
			command: "node failure.cjs",
			cwd: ".",
			kind: "other",
			builds: false,
			toolchain: "node-test",
			dependencies: ["package.json"],
		},
		{
			id: "upcoming",
			command: "node upcoming.cjs",
			cwd: ".",
			kind: "other",
			builds: false,
			toolchain: "node-test",
			dependencies: ["package.json"],
		},
	]

	async function setup(
		checkDefinitions: ReviewCheckDefinition[] | null = definitions,
		contextMode: "tui" | "print" = "tui",
	) {
		target = await resolveReviewTarget(
			parseReviewTargetArgs(["branch", "main", "--base", baseSha]) as ExplicitReviewRequest,
			{
				root: repo,
				contextDir: join(sandbox, "review-context"),
			},
		)
		pool = await createReviewWorktreePool({ target, outputDir, rootDir: join(sandbox, "worktrees"), concurrency: 2 })
		queue = await ReviewCheckQueue.create({
			scope: target.scope,
			worktrees: pool,
			outputDir,
			...(checkDefinitions === null ? {} : { definitions: checkDefinitions }),
		})
		return createContext({ cwd: repo, mode: contextMode, hasUI: contextMode === "tui" })
	}

	function controller(id: string, mode: "local" | "headless" = "local") {
		return createReviewExecutionController({
			mode,
			worktree: requesterWorktree(sandbox, id),
			networkBoundary: testBoundary,
		})
	}

	function runCount(worktree: ReviewWorktree): number {
		const path = join(worktree.scratchDir, "runs")
		return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0
	}

	function deferred() {
		let resolve!: () => void
		const promise = new Promise<void>((resolvePromise) => {
			resolve = resolvePromise
		})
		return { promise, resolve }
	}

	it.each([
		{ caseName: "invalid JSON", contents: "{not-json", detail: "valid JSON" },
		{
			caseName: "unsupported schema",
			contents: JSON.stringify({ schema_version: "review-check-state/v2", checks: [] }),
			detail: "unsupported schema",
		},
	])("fails closed with a structured error for $caseName", async ({ contents, detail }) => {
		const statePath = join(outputDir, "state", "routine-checks.json")
		mkdirSync(join(outputDir, "state"), { recursive: true })
		writeFileSync(statePath, contents)

		const error: unknown = await setup([]).then(
			() => {
				throw new Error("Invalid review state unexpectedly loaded.")
			},
			(cause: unknown) => cause,
		)

		if (!(error instanceof ReviewCheckStateError)) throw error
		expect(error).toMatchObject({
			name: "ReviewCheckStateError",
			code: "review_check_state_invalid",
			statePath,
		})
		expect(error.message).toContain(statePath)
		expect(error.message).toContain(detail)
		expect(error.message).toContain("move it aside")
		expect(readFileSync(statePath, "utf8")).toBe(contents)
	})

	it("marks reviewed-tree discovery separately from injected checks and does not infer builds", async () => {
		await setup(null)
		const discovered = await queue.request({
			id: "test",
			requestedBy: "discovery",
			controller: controller("discovery"),
		})
		expect(discovered).toMatchObject({ definitionSource: "reviewed-tree", status: "passed", satisfiesBuild: false })
	})

	it("joins reviewers and verifier, reuses failures, separates base/head, and does no wrap-up rerun", async () => {
		const ctx = await setup()
		const requesters = [controller("spec"), controller("standards"), controller("verifier")]
		const successful = await Promise.all(
			requesters.map((requestController, index) =>
				queue.request({
					id: "test",
					requestedBy: index === 2 ? "verifier" : `reviewer-${index}`,
					controller: requestController,
				}),
			),
		)
		expect(successful[0]).toMatchObject({
			definitionSource: "coordinator",
			status: "passed",
			exitCode: 0,
			satisfiesBuild: true,
			network: "offline",
		})
		expect(successful[0].output).toContain("head")
		expect(successful[1]).toBe(successful[0])
		expect(successful[2]).toBe(successful[0])
		const headWorktree = await pool.getWorktree("routine-head", { kind: "checks" })
		expect(runCount(headWorktree)).toBe(1)
		expect(await queue.request({ id: "test", requestedBy: "later", controller: requesters[0] })).toBe(successful[0])
		expect(runCount(headWorktree)).toBe(1)

		const failing = await Promise.all(
			requesters.map((requestController, index) =>
				queue.request({ id: "failure", requestedBy: `failure-${index}`, controller: requestController }),
			),
		)
		expect(failing[0]).toMatchObject({ status: "failed", exitCode: 4, satisfiesBuild: false })
		expect(failing[0].output).toContain("routine failure")
		expect(failing[1]).toBe(failing[0])
		expect(failing[2]).toBe(failing[0])
		expect(runCount(headWorktree)).toBe(2)

		const base = await queue.request({ id: "test", requestedBy: "base", controller: requesters[0], revision: "base" })
		expect(base.output).toContain("base")
		expect(base.key).not.toBe(successful[0].key)
		expect(base.pinnedTree).not.toBe(successful[0].pinnedTree)
		expect(base.status).toBe("passed")

		queue.beginWrapUp()
		expect(await queue.request({ id: "test", requestedBy: "wrap", controller: requesters[0] })).toBe(successful[0])
		const notRun = await queue.request({ id: "upcoming", requestedBy: "wrap", controller: requesters[0] })
		expect(notRun).toMatchObject({ status: "blocked", output: expect.stringContaining("wrap-up") })
		expect(runCount(headWorktree)).toBe(2)
		const state = JSON.parse(readFileSync(join(outputDir, "state", "routine-checks.json"), "utf8"))
		expect(state.schema_version).toBe("review-check-state/v1")
		expect(state.checks).toHaveLength(3)
		expect(
			state.checks.every(
				(result: { command: string; elapsedMs: number; output: string }) =>
					result.command && result.output && result.elapsedMs >= 0,
			),
		).toBe(true)

		const privateWorktree = await pool.getWorktree("private-spec")
		const privateController = createReviewExecutionController({
			mode: "local",
			worktree: privateWorktree,
			networkBoundary: testBoundary,
		})
		const child = createExtensionApi()
		registerReviewChildTools(child.api, {
			controller: privateController,
			worktrees: pool,
			checks: queue,
			writer: "spec",
		})
		const focused = await child
			.getRegisteredTool("run_review_command")
			.execute(
				"focused",
				{ command: "node focused.cjs" },
				undefined,
				undefined,
				createToolContext({ cwd: privateWorktree.path }),
			)
		expect(focused.details).toMatchObject({ status: "passed", worktree: privateWorktree.path })
		expect(existsSync(join(repo, "post-checkout-ran"))).toBe(false)
		expect(ctx.cwd).toBe(repo)
	})

	it("uses one approved online rerun for all requesters after visible offline failure", async () => {
		writeFileSync(
			join(repo, "online.cjs"),
			`const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(path.join(process.env.TMPDIR, 'runs'), 'online-check\\n');
if (process.env.npm_config_offline === 'true') { console.error('registry required'); process.exit(8) }
fs.writeFileSync('installed', 'yes')`,
		)
		git(repo, "add", "online.cjs")
		git(repo, "commit", "-m", "add network fixture")
		const onlineDefinition: ReviewCheckDefinition = {
			id: "online",
			command: "node online.cjs",
			cwd: ".",
			kind: "other",
			builds: false,
			toolchain: "node-test",
			dependencies: ["package.json"],
		}
		await setup([onlineDefinition])
		const requesters = [controller("one"), controller("two"), controller("verifier")]
		const approvals = requesters.map((requestController) => {
			const approval = vi.fn(async () => "approved" as const)
			requestController.bindApprover(approval)
			return approval
		})
		const offline = await queue.request({ id: "online", requestedBy: "one", controller: requesters[0] })
		expect(offline).toMatchObject({ status: "failed", exitCode: 8, network: "offline" })
		expect(offline.output).toContain("registry required")
		const worktree = await pool.getWorktree("routine-head", { kind: "checks" })
		expect(existsSync(join(worktree.path, "installed"))).toBe(false)
		const online = await Promise.all(
			requesters.map((requestController, index) =>
				queue.request({ id: "online", requestedBy: `online-${index}`, controller: requestController, online: true }),
			),
		)
		expect(online[0]).toMatchObject({ status: "passed", network: "approved-online", approval: "approved" })
		expect(online[1]).toBe(online[0])
		expect(online[2]).toBe(online[0])
		expect(online[0].key).not.toBe(offline.key)
		expect(readFileSync(join(worktree.path, "installed"), "utf8")).toBe("yes")
		expect(approvals.reduce((count, approval) => count + approval.mock.calls.length, 0)).toBe(1)
		expect(runCount(worktree)).toBe(2)
		await queue.request({ id: "online", requestedBy: "later", controller: requesters[0], online: true })
		expect(runCount(worktree)).toBe(2)
	})

	it("records a blocked sandbox install headlessly without an offline profile or declined approval", async () => {
		await setup(
			[
				{
					id: "install",
					command: "npm install",
					cwd: ".",
					kind: "other",
					builds: false,
					toolchain: "node-test",
					dependencies: ["package.json"],
				},
			],
			"print",
		)
		const worktree = await pool.getWorktree("routine-head", { kind: "checks" })
		const bin = join(worktree.cacheDir, "bin")
		mkdirSync(bin, { recursive: true })
		writeFileSync(join(bin, "npm"), "#!/bin/sh\nprintf 'offline=%s\\n' \"${npm_config_offline-unset}\"\nexit 17\n")
		chmodSync(join(bin, "npm"), 0o755)
		worktree.env.PATH = `${bin}:${process.env.PATH ?? ""}`
		const headless = controller("headless", "headless")
		const approve = vi.fn(async () => "approved" as const)
		headless.bindApprover(approve)
		const result = await queue.request({ id: "install", requestedBy: "headless", controller: headless })
		expect(result).toMatchObject({ status: "failed", exitCode: 17, network: "sandbox", approval: "not-requested" })
		expect(result.output).toContain("offline=unset")
		expect(approve).not.toHaveBeenCalled()
	})

	it.each([
		["lint", "test"],
		["test", "lint"],
	])("preserves build semantics in both request orders, concurrent and sequential (%s first)", async (firstId, secondId) => {
		await setup([
			{
				id: "test",
				command: "node check.cjs",
				cwd: ".",
				kind: "test",
				builds: true,
				toolchain: "node-test",
				dependencies: ["value.json"],
			},
			{
				id: "lint",
				command: "node check.cjs",
				cwd: ".",
				kind: "other",
				builds: false,
				toolchain: "node-test",
				dependencies: ["value.json"],
			},
		])
		const runner = controller("semantic")
		const [first, second] = await Promise.all([
			queue.request({ id: firstId, requestedBy: "first", controller: runner }),
			queue.request({ id: secondId, requestedBy: "second", controller: runner }),
		])
		expect(first.id).toBe(firstId)
		expect(second.id).toBe(secondId)
		expect(first.satisfiesBuild).toBe(firstId === "test")
		expect(second.satisfiesBuild).toBe(secondId === "test")
		const worktree = await pool.getWorktree("routine-head", { kind: "checks" })
		expect(runCount(worktree)).toBe(1)
		const firstAgain = await queue.request({ id: firstId, requestedBy: "again-first", controller: runner })
		const secondAgain = await queue.request({ id: secondId, requestedBy: "again-second", controller: runner })
		expect(firstAgain.satisfiesBuild).toBe(firstId === "test")
		expect(secondAgain.satisfiesBuild).toBe(secondId === "test")
		expect(runCount(worktree)).toBe(1)
	})

	it("always projects same-ID builds flags from the current definition", async () => {
		const base = {
			id: "test",
			command: "node check.cjs",
			cwd: ".",
			kind: "test" as const,
			toolchain: "node-test",
			dependencies: ["value.json"],
		}
		await setup([{ ...base, builds: false }])
		const runner = controller("resume")
		const first = await queue.request({ id: "test", requestedBy: "first", controller: runner })
		expect(first).toMatchObject({ status: "passed", satisfiesBuild: false })
		const resumedQueue = await ReviewCheckQueue.create({
			scope: target.scope,
			worktrees: pool,
			outputDir,
			definitions: [{ ...base, builds: true }],
		})
		const resumedTrue = await resumedQueue.request({ id: "test", requestedBy: "true", controller: runner })
		expect(resumedTrue.key).toBe(first.key)
		expect(resumedTrue.satisfiesBuild).toBe(true)
		const flippedQueue = await ReviewCheckQueue.create({
			scope: target.scope,
			worktrees: pool,
			outputDir,
			definitions: [{ ...base, builds: false }],
		})
		const resumedFalse = await flippedQueue.request({ id: "test", requestedBy: "false", controller: runner })
		expect(resumedFalse.key).toBe(first.key)
		expect(resumedFalse.satisfiesBuild).toBe(false)
		await resumedQueue.dispose()
		await flippedQueue.dispose()
	})

	it("waits for requests still being authorized before becoming idle", async () => {
		await setup()
		const authorizationStarted = deferred()
		const releaseAuthorization = deferred()
		const runner = controller("idle-authorization")
		runner.bindCommandAuthorizer(async () => {
			authorizationStarted.resolve()
			await releaseAuthorization.promise
			return undefined
		})
		const pending = queue.request({ id: "test", requestedBy: "idle", controller: runner })
		await authorizationStarted.promise

		let becameIdle = false
		const waitingForIdle = queue.idle().then(() => {
			becameIdle = true
		})
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(becameIdle).toBe(false)
		} finally {
			releaseAuthorization.resolve()
		}

		expect((await pending).status).toBe("passed")
		await waitingForIdle
		expect(becameIdle).toBe(true)
	})

	it("aborts and awaits a request still being authorized during disposal", async () => {
		await setup()
		const authorizationStarted = deferred()
		const releaseAuthorization = deferred()
		const runner = controller("dispose-authorization")
		runner.bindCommandAuthorizer(async () => {
			authorizationStarted.resolve()
			await releaseAuthorization.promise
			return undefined
		})
		const pending = queue.request({ id: "test", requestedBy: "dispose", controller: runner })
		await authorizationStarted.promise

		let disposed = false
		const disposing = queue.dispose().then(() => {
			disposed = true
		})
		try {
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(disposed).toBe(false)
		} finally {
			releaseAuthorization.resolve()
		}

		expect(await pending).toMatchObject({ status: "cancelled" })
		await disposing
		expect(disposed).toBe(true)
	})

	it("aborts and awaits a real pending parent approval during disposal", async () => {
		await setup([
			{
				id: "install",
				command: "npm install",
				cwd: ".",
				kind: "other",
				builds: false,
				toolchain: "node-test",
				dependencies: ["package.json"],
			},
		])
		const parentSessionId = `${sandbox}-pending-approval`
		policyCleanups.push(
			registerPermissionPolicySource(parentSessionId, {
				getMode: () => ({ mode: "yolo", initiatedBy: "user", source: "runtime" }),
				getRules: () => [],
				getConfig: () => ({
					config: DEFAULT_CONFIG,
					allowBySource: { user: [], project: [], local: [], cli: [] },
					denyBySource: { user: [], project: [], local: [], cli: [] },
					paths: {},
				}),
				isDangerBypass: () => false,
				whenModeSettled: async () => {},
			}),
		)
		let resolveApproval = () => {}
		let promptSignal: AbortSignal | undefined
		const requestPermission = vi.fn(
			(request: PermissionRequest) =>
				new Promise<{ kind: "aborted" }>((resolve) => {
					promptSignal = request.signal
					resolveApproval = () => resolve({ kind: "aborted" })
					request.signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true })
				}),
		)
		const surface = { notify: vi.fn(), requestPermission }
		registerParentSurface(parentSessionId, surface)
		policyCleanups.push(() => unregisterParentSurface(parentSessionId, surface))
		const runner = controller("pending-approval")
		const child = createExtensionApi()
		createWorkerPermissionsExtension({
			parentSessionId,
			persona: "Policy reviewer",
			agentId: "policy",
			description: "await cancellation during approval",
			reviewExecution: runner,
		})(child.api)
		const context = createToolContext({ cwd: repo })
		const event = {
			type: "tool_call",
			toolCallId: "pending-approval-call",
			toolName: "run_review_command",
			input: { command: "npm install" },
		} as ToolCallEvent
		expect(await child.getHandler("tool_call")(event, context)).toBeUndefined()
		const pending = queue.request({
			id: "install",
			requestedBy: "pending-approval",
			controller: runner,
			toolCallId: event.toolCallId,
		})
		await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))

		let watchdogFired = false
		const watchdog = setTimeout(() => {
			watchdogFired = true
			resolveApproval()
		}, 1000)
		try {
			const disposing = queue.dispose()
			const result = await pending
			await disposing

			expect(watchdogFired).toBe(false)
			expect(result).toMatchObject({ status: "cancelled", approval: "aborted" })
			expect(promptSignal?.aborted).toBe(true)
		} finally {
			clearTimeout(watchdog)
			resolveApproval()
		}
	})

	it.each(["idle", "dispose"] as const)("rejects re-entrant %s from inside a request callback", async (method) => {
		await setup()
		const runner = controller(`reentrant-${method}`)
		runner.bindCommandAuthorizer(async () => {
			await expect(queue[method]()).rejects.toThrow("inside its own request callback")
			return undefined
		})

		await expect(queue.request({ id: "test", requestedBy: "reentrant", controller: runner })).resolves.toMatchObject({
			status: "passed",
		})
	})

	it("blocks a queued check that had not started when wrap-up began", async () => {
		const log = join(sandbox, "wrap-up-sentinel.log")
		const started = join(sandbox, "first-started")
		const release = join(sandbox, "release-first")
		writeFileSync(
			join(repo, "first.cjs"),
			`const fs = require('node:fs'); const { setTimeout: sleep } = require('node:timers/promises');
module.exports = (async () => {
 fs.writeFileSync(${JSON.stringify(started)}, 'started');
 while (!fs.existsSync(${JSON.stringify(release)})) await sleep(10);
 fs.appendFileSync(${JSON.stringify(log)}, 'first\\n');
})()`,
		)
		writeFileSync(join(repo, "second.cjs"), `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'second\\n')`)
		git(repo, "add", "first.cjs", "second.cjs")
		git(repo, "commit", "-m", "queue sentinel")
		await setup([
			{
				id: "first",
				command: "node first.cjs",
				cwd: ".",
				kind: "other",
				builds: false,
				toolchain: "node-test",
				dependencies: ["package.json"],
			},
			{
				id: "second",
				command: "node second.cjs",
				cwd: ".",
				kind: "other",
				builds: false,
				toolchain: "node-test",
				dependencies: ["package.json"],
			},
		])
		const runner = controller("queue")
		const first = queue.request({ id: "first", requestedBy: "first", controller: runner })
		const deadline = Date.now() + 5000
		while (!existsSync(started)) {
			if (Date.now() > deadline) throw new Error("first check did not start")
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		const second = queue.request({ id: "second", requestedBy: "second", controller: runner })
		queue.beginWrapUp()
		writeFileSync(release, "release")
		expect((await first).status).toBe("passed")
		expect(await second).toMatchObject({ status: "blocked", output: expect.stringContaining("wrap-up") })
		expect(readFileSync(log, "utf8")).toBe("first\n")
	})

	async function invokeWrapper(
		toolName: "run_review_command" | "run_review_check",
		params: Record<string, unknown>,
		requestController: ReturnType<typeof controller>,
		rules: Rule[] = [],
	) {
		const parentSessionId = `${sandbox}-${toolName}-${rules.map((rule) => rule.content).join("-")}`
		policyCleanups.push(
			registerPermissionPolicySource(parentSessionId, {
				getMode: () => ({ mode: "yolo", initiatedBy: "user", source: "runtime" }),
				getRules: () => rules,
				getConfig: () => ({
					config: DEFAULT_CONFIG,
					allowBySource: { user: [], project: [], local: [], cli: [] },
					denyBySource: { user: [], project: [], local: [], cli: [] },
					paths: {},
				}),
				isDangerBypass: () => false,
				whenModeSettled: async () => {},
			}),
		)
		const child = createExtensionApi()
		createWorkerPermissionsExtension({
			parentSessionId,
			persona: "Policy reviewer",
			agentId: "policy",
			description: "deny or hard-block actual review commands",
			reviewExecution: requestController,
		})(child.api)
		registerReviewChildTools(child.api, {
			controller: requestController,
			worktrees: pool,
			checks: queue,
			writer: "policy",
		})
		const context = createToolContext({ cwd: repo })
		const event = { ...{ type: "tool_call", toolCallId: `gate-${toolName}`, toolName }, input: params } as ToolCallEvent
		await child.getHandler("tool_call")(event, context)
		return child
			.getRegisteredTool(toolName)
			.execute(event.toolCallId ?? toolName, params, undefined, undefined, context)
	}

	it.each([
		{
			caseName: "inherited deny",
			rules: ["bash(echo REVIEW_DENY_BYPASS*)"],
			command: "echo REVIEW_DENY_BYPASS",
			checkId: "denied",
		},
		{ caseName: "hard block", rules: [], command: "sudo -n true", checkId: "hard" },
	])("applies $caseName to both review wrapper tools", async ({ rules, command, checkId }) => {
		await setup([
			{
				id: checkId,
				command,
				cwd: ".",
				kind: "other",
				builds: false,
				toolchain: "test",
				dependencies: ["package.json"],
			},
		])
		const parsedRules = rules.length ? parseRules(rules, "deny", "project") : []
		const routineRunner = controller("routine")
		const routineResult = await invokeWrapper("run_review_check", { id: checkId }, routineRunner, parsedRules)
		expect(routineResult.details).toMatchObject({ status: "blocked" })
		expect(JSON.stringify(routineResult.details)).not.toContain("passed")
		const focusedRunner = controller("focused")
		const focusedResult = await invokeWrapper(
			"run_review_command",
			{ command: `${command} && true` },
			focusedRunner,
			parsedRules,
		)
		expect(focusedResult.details).toMatchObject({ status: "blocked" })
		expect(focusedResult.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).toContain(
			parsedRules.length ? "Denied by rule" : "Hard-blocked",
		)
	})

	it("authorizes every shared-check requester before returning saved evidence", async () => {
		await setup([
			{
				id: "evidence",
				command: "echo REVIEW_DENY_BYPASS",
				cwd: ".",
				kind: "test",
				builds: true,
				toolchain: "test",
				dependencies: ["package.json"],
			},
		])
		const allowed = controller("allowed")
		const saved = await queue.request({ id: "evidence", requestedBy: "allowed", controller: allowed })
		expect(saved).toMatchObject({ status: "passed", satisfiesBuild: true })
		const denied = controller("denied")
		const result = await invokeWrapper(
			"run_review_check",
			{ id: "evidence" },
			denied,
			parseRules(["bash(echo REVIEW_DENY_BYPASS*)"], "deny", "project"),
		)
		expect(result.details).toMatchObject({ status: "blocked" })
		expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).toContain(
			"Denied by rule",
		)
	})
})
