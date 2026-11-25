import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { DEFAULT_CONFIG } from "../permissions/constants.js"
import { createWorkerPermissionsExtension } from "../permissions/index.js"
import { registerParentSurface, unregisterParentSurface } from "../permissions/parent-surface-registry.js"
import { registerPermissionPolicySource } from "../permissions/policy-source-registry.js"
import type { PermissionRequest } from "../permissions/prompter.js"
import type { ApprovalOutcome } from "../permissions/prompts.js"
import { parseRules } from "../permissions/rules.js"
import type { PermissionMode, Rule } from "../permissions/types.js"
import { createReviewBashToolDefinition, createReviewExecutionController, executeReviewCommand } from "./execution.js"
import type { ReviewWorktree } from "./types.js"

function fixtureWorktree(root: string, id: string): ReviewWorktree {
	return {
		id,
		kind: "reviewer",
		revision: "head",
		path: join(root, id),
		pinnedSha: "a".repeat(40),
		scratchDir: join(root, id, "scratch"),
		buildDir: join(root, id, "build"),
		cacheDir: join(root, id, "cache"),
		homeDir: join(root, id, "home"),
		env: {},
	}
}

describe("review worker permission integration", () => {
	const root = mkdtempSync(join(tmpdir(), "review-permissions-test-"))
	const cleanups: Array<() => void> = []

	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup()
		rmSync(join(root, "one"), { recursive: true, force: true })
		rmSync(join(root, "two"), { recursive: true, force: true })
	})

	function gate(
		mode: PermissionMode,
		outcome: ApprovalOutcome | undefined,
		id = "one",
		policy: { rules?: Rule[]; dangerBypass?: boolean } = {},
	) {
		const parentSessionId = `parent-${id}`
		const controller = createReviewExecutionController({ mode: "local", worktree: fixtureWorktree(root, id) })
		const unregisterPolicy = registerPermissionPolicySource(parentSessionId, {
			getMode: () => ({ mode, initiatedBy: "user", source: "runtime" }),
			getRules: () => policy.rules ?? [],
			getConfig: () => ({
				config: DEFAULT_CONFIG,
				allowBySource: { user: [], project: [], local: [], cli: [] },
				denyBySource: { user: [], project: [], local: [], cli: [] },
				paths: {},
			}),
			isDangerBypass: () => policy.dangerBypass ?? false,
			whenModeSettled: async () => {},
		})
		const requestPermission = vi.fn(async (_request: PermissionRequest): Promise<ApprovalOutcome> => {
			if (outcome === undefined) throw new Error("Approval UI is unavailable.")
			return outcome
		})
		const surface = { notify: vi.fn(), ...(outcome === undefined ? {} : { requestPermission }) }
		registerParentSurface(parentSessionId, surface)
		cleanups.push(() => {
			unregisterPolicy()
			unregisterParentSurface(parentSessionId, surface)
		})
		const child = createExtensionApi()
		createWorkerPermissionsExtension({
			parentSessionId,
			persona: `Reviewer ${id}`,
			agentId: id,
			description: `Review lens ${id}`,
			reviewExecution: controller,
		})(child.api)
		const ctx = createContext({ cwd: fixtureWorktree(root, id).path, hasUI: false }) as ExtensionContext
		return { controller, child, ctx, requestPermission }
	}

	async function call(
		child: ReturnType<typeof createExtensionApi>,
		ctx: ExtensionContext,
		toolName: string,
		input: Record<string, unknown>,
	) {
		const event = { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input } as ToolCallEvent
		return (await child.getHandler("tool_call")(event, ctx)) as { block?: boolean; reason?: string } | undefined
	}

	it("requires parent approval for a direct install under local yolo", async () => {
		const installed = gate("yolo", { kind: "allow-once" })
		const result = await call(installed.child, installed.ctx, "bash", { command: "pnpm add example package" })
		expect(result).toBeUndefined()
		expect(installed.requestPermission).toHaveBeenCalledTimes(1)
		expect(installed.requestPermission.mock.calls[0][0]).toMatchObject({
			toolName: "bash",
			input: {
				command: "pnpm add example package",
				network: "online",
				reason: "direct-install",
				worktrees: [join(root, "one")],
			},
		})
		expect(installed.controller.networkFor("call-bash")).toBe("approved-online")

		const script = gate("yolo", { kind: "allow-once" }, "two")
		expect(await call(script.child, script.ctx, "bash", { command: "pnpm test" })).toBeUndefined()
		expect(script.requestPermission).not.toHaveBeenCalled()
		expect(script.controller.networkFor("call-bash")).toBe("unenforced")
	})

	it.each([
		{ outcome: { kind: "allow-once" } as const, status: "approved" },
		{ outcome: { kind: "deny" } as const, status: "declined" },
		{ outcome: { kind: "aborted" } as const, status: "aborted" },
		{ outcome: undefined, status: "unavailable" },
	])("maps the parent approval outcome to $status", async ({ outcome, status }) => {
		const review = gate("yolo", outcome)
		const event = {
			type: "tool_call",
			toolCallId: "review-approval-outcome",
			toolName: "bash",
			input: { command: "npm install" },
		} as ToolCallEvent
		const result = await review.controller.requestApproval(
			{
				kind: "direct-install",
				command: "npm install",
				intendedCheck: "test",
				worktrees: [review.controller.worktree.path],
			},
			{ event, ctx: review.ctx, mode: "yolo" },
		)

		expect(result).toBe(status)
		expect(review.requestPermission).toHaveBeenCalledTimes(outcome === undefined ? 0 : 1)
	})

	it("shares one direct-install approval between the gate and bash execution", async () => {
		const installed = gate("yolo", { kind: "allow-once" })
		await call(installed.child, installed.ctx, "bash", { command: "npx --version" })
		expect(installed.requestPermission).toHaveBeenCalledTimes(1)
		mkdirSync(installed.controller.worktree.path, { recursive: true })
		const bash = createReviewBashToolDefinition(installed.controller)
		const result = await bash.execute(
			"call-bash",
			{ command: "npx --version" },
			undefined,
			undefined,
			createToolContext({ cwd: installed.controller.worktree.path }),
		)
		expect(result.isError).not.toBe(true)
		expect(installed.controller.records.at(-1)?.network).toBe("approved-online")
		expect(installed.requestPermission).toHaveBeenCalledTimes(1)
	})

	it("records a declined yolo install without executing it", async () => {
		const declined = gate("yolo", { kind: "deny" })
		const result = await call(declined.child, declined.ctx, "bash", { command: "npm install" })
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("declined") })
		expect(declined.controller.records).toHaveLength(1)
		expect(declined.controller.records[0]).toMatchObject({ status: "blocked", approval: "declined" })
	})

	it.each([
		{ caseName: "plan mutation", mode: "plan", command: "node focused.test", blocked: true },
		{ caseName: "plan read-only command", mode: "plan", command: "echo safe", blocked: false },
		{
			caseName: "yolo deny rule",
			mode: "yolo",
			command: "echo REVIEW_DENY_BYPASS",
			rules: parseRules(["bash(echo REVIEW_DENY_BYPASS*)"], "deny", "project"),
			blocked: true,
		},
		{
			caseName: "default deny rule",
			mode: "default",
			command: "echo REVIEW_DENY_BYPASS",
			rules: parseRules(["bash(echo REVIEW_DENY_BYPASS*)"], "deny", "project"),
			blocked: true,
		},
		{ caseName: "auto compound hard block", mode: "auto", command: "echo safe && sudo whoami", blocked: true },
		{ caseName: "default compound hard block", mode: "default", command: "echo safe && sudo whoami", blocked: true },
		{ caseName: "yolo hard block", mode: "yolo", command: "shutdown now", blocked: true },
		{ caseName: "yolo allowed command", mode: "yolo", command: "echo safe", blocked: false },
		{ caseName: "default read-only command", mode: "default", command: "echo safe", blocked: false },
	] as const)("keeps ordinary and review block decisions aligned for $caseName", async (fixture) => {
		const review = gate(fixture.mode, { kind: "allow-once" }, "one", { rules: fixture.rules })

		const ordinary = await call(review.child, review.ctx, "bash", { command: fixture.command })
		const authorized = await review.controller.authorizeCommand(fixture.command, { mode: fixture.mode })

		expect(Boolean(ordinary?.block)).toBe(fixture.blocked)
		expect(Boolean(authorized?.block)).toBe(fixture.blocked)
	})

	it.each(["default", "auto"] as const)("honours standalone hard-block approval outcomes in %s mode", async (mode) => {
		for (const scenario of [
			{ name: "approved", outcome: { kind: "allow-once" } as const, status: "passed", prompts: 1, runs: 1 },
			{ name: "declined", outcome: { kind: "deny" } as const, status: "blocked", prompts: 1, runs: 0 },
			{ name: "unavailable", outcome: undefined, status: "blocked", prompts: 0, runs: 0 },
		] as const) {
			const review = gate(mode, scenario.outcome, `${mode}-${scenario.name}`)
			const operations = { exec: vi.fn(async () => ({ exitCode: 0 })) }
			const event = {
				type: "tool_call",
				toolCallId: `hard-block-${mode}-${scenario.name}`,
				toolName: "bash",
				input: { command: "shutdown now" },
			} as ToolCallEvent
			review.controller.captureExecution(event, review.ctx, mode)

			const result = await executeReviewCommand(review.controller, {
				command: "shutdown now",
				cwd: review.controller.worktree.path,
				intendedCheck: "hard-block approval",
				worktree: review.controller.worktree,
				online: true,
				toolCallId: event.toolCallId,
				operations,
			})

			expect(result).toMatchObject({ status: scenario.status, approval: scenario.name })
			expect(operations.exec).toHaveBeenCalledTimes(scenario.runs)
			expect(review.requestPermission).toHaveBeenCalledTimes(scenario.prompts)
			if (scenario.prompts > 0) {
				expect(review.requestPermission.mock.calls[0][0].subtitle).toContain("Hard-blocked command")
			}
		}
	})

	it.each([
		"default",
		"auto",
	] as const)("keeps direct-install compound denies ahead of approval in %s mode", async (mode) => {
		const review = gate(mode, { kind: "allow-once" }, `${mode}-direct-precheck`)
		const event = {
			type: "tool_call",
			toolCallId: `direct-precheck-${mode}`,
			toolName: "bash",
			input: { command: "npm install && shutdown now" },
		} as ToolCallEvent
		review.controller.captureExecution(event, review.ctx, mode)
		const operations = { exec: vi.fn(async () => ({ exitCode: 0 })) }

		const result = await executeReviewCommand(review.controller, {
			command: "npm install && shutdown now",
			cwd: review.controller.worktree.path,
			intendedCheck: "direct-install precheck",
			worktree: review.controller.worktree,
			toolCallId: event.toolCallId,
			operations,
		})

		expect(result).toMatchObject({ status: "blocked", approval: "not-requested" })
		expect(result.output).toContain("Hard-blocked")
		expect(operations.exec).not.toHaveBeenCalled()
		expect(review.requestPermission).not.toHaveBeenCalled()
	})

	it.each([
		"default",
		"auto",
	] as const)("honours an explicit allow rule for a standalone hard block in %s mode", async (mode) => {
		const allowed = gate(mode, { kind: "allow-once" }, `${mode}-allowed-hard-block`, {
			rules: parseRules(["bash(shutdown now)"], "allow", "project"),
		})
		expect(await call(allowed.child, allowed.ctx, "bash", { command: "shutdown now" })).toBeUndefined()
		await expect(allowed.controller.authorizeCommand("shutdown now", { mode })).resolves.toBeUndefined()
	})

	it("prevents every reviewer from writing or running scripts in read-only mode", async () => {
		for (const id of ["one", "two"]) {
			const planned = gate("plan", { kind: "allow-once" }, id)
			const write = await call(planned.child, planned.ctx, "write", { path: "focused.test", content: "test" })
			expect(write).toMatchObject({ block: true, reason: expect.stringContaining("plan mode") })
			const script = await call(planned.child, planned.ctx, "bash", { command: "node focused.test" })
			expect(script).toMatchObject({ block: true, reason: expect.stringContaining("plan mode") })
			const routine = await call(planned.child, planned.ctx, "run_review_check", { id: "test" })
			expect(routine).toMatchObject({ block: true, reason: expect.stringContaining("plan mode") })
			expect(planned.requestPermission).not.toHaveBeenCalled()
		}
	})

	it("returns a stopped result when a reviewer is cancelled during approval", async () => {
		const stopped = gate("yolo", { kind: "allow-once" })
		const abort = new AbortController()
		Object.assign(stopped.ctx, { signal: abort.signal })
		stopped.controller.bindApprover(async () => "aborted")
		abort.abort()
		const result = await call(stopped.child, stopped.ctx, "bash", { command: "npm install" })
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("stopped") })
	})

	it("does not make the routine check tool a new approval path in default mode", async () => {
		const normal = gate("default", { kind: "allow-once" })
		expect(await call(normal.child, normal.ctx, "run_review_check", { id: "test" })).toBeUndefined()
		expect(normal.requestPermission).not.toHaveBeenCalled()
	})
})
