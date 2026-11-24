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
import type { PermissionMode } from "../permissions/types.js"
import { createReviewBashToolDefinition, createReviewExecutionController } from "./execution.js"
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

	function gate(mode: PermissionMode, outcome: ApprovalOutcome, id = "one") {
		const parentSessionId = `parent-${id}`
		const controller = createReviewExecutionController({ mode: "local", worktree: fixtureWorktree(root, id) })
		const unregisterPolicy = registerPermissionPolicySource(parentSessionId, {
			getMode: () => ({ mode, initiatedBy: "user", source: "runtime" }),
			getRules: () => [],
			getConfig: () => ({
				config: DEFAULT_CONFIG,
				allowBySource: { user: [], project: [], local: [], cli: [] },
				denyBySource: { user: [], project: [], local: [], cli: [] },
				paths: {},
			}),
			isDangerBypass: () => false,
			whenModeSettled: async () => {},
		})
		const requestPermission = vi.fn(async (_request: PermissionRequest): Promise<ApprovalOutcome> => outcome)
		const surface = { notify: vi.fn(), requestPermission }
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
