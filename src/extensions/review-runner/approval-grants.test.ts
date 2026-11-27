import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createToolContext } from "../__mocks__/context.js"
import {
	createReviewBashToolDefinition,
	createReviewExecutionController,
	executeReviewCommand,
	type ReviewApprovalRequest,
	type ReviewApprovalStatus,
	type ReviewExecutionController,
	type ReviewExecutionEvent,
} from "./execution.js"
import type { ReviewWorktree } from "./types.js"

function fixtureWorktree(root: string): ReviewWorktree {
	const scratchDir = join(root, "scratch")
	const cacheDir = join(root, "cache")
	const buildDir = join(root, "build")
	const homeDir = join(root, "home")
	return {
		id: "writer",
		kind: "reviewer",
		revision: "head",
		path: root,
		pinnedSha: "a".repeat(40),
		scratchDir,
		buildDir,
		cacheDir,
		homeDir,
		env: { HOME: homeDir, TMPDIR: scratchDir },
	}
}

describe("single-use approval grants", () => {
	let root: string
	let worktree: ReviewWorktree

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "review-approval-grants-"))
		worktree = fixtureWorktree(root)
	})

	afterEach(() => rmSync(root, { recursive: true, force: true }))

	function setup() {
		const controller = createReviewExecutionController({ mode: "local", worktree })
		const approval = vi.fn(
			async (_request: ReviewApprovalRequest, _execution: ReviewExecutionEvent): Promise<ReviewApprovalStatus> =>
				"approved",
		)
		controller.bindApprover(approval)
		const executed: string[] = []
		const operations: BashOperations = {
			exec: async (command) => {
				executed.push(command)
				return { exitCode: 0 }
			},
		}
		return { controller, approval, executed, operations }
	}

	function execute(
		controller: ReviewExecutionController,
		operations: BashOperations,
		command: string,
		toolName = "bash",
		toolCallId = "reused-id",
	) {
		return executeReviewCommand(controller, {
			command,
			cwd: worktree.path,
			intendedCheck: "approval grant audit",
			worktree,
			operations,
			toolCallId,
			toolName,
		})
	}

	function settle(_controller: ReviewExecutionController, command: string, toolName = "bash"): ReviewApprovalRequest {
		return {
			kind: "direct-install",
			command,
			intendedCheck: "approval grant audit",
			worktrees: [worktree.path],
			toolCallId: "reused-id",
			toolName,
		}
	}

	it("requires fresh approval when the same tool-call ID changes direct-install commands", async () => {
		const { controller, approval, executed, operations } = setup()
		await execute(controller, operations, "npx --version")
		await execute(controller, operations, "corepack prepare pnpm@10.0.0 --activate")
		expect(approval).toHaveBeenCalledTimes(2)
		expect(executed).toEqual(["npx --version", "corepack prepare pnpm@10.0.0 --activate"])
	})

	it("requires fresh approval when the same command is replayed under the same ID", async () => {
		const { controller, approval, executed, operations } = setup()
		await execute(controller, operations, "corepack prepare pnpm@10.0.0 --activate")
		await execute(controller, operations, "corepack prepare pnpm@10.0.0 --activate")
		expect(approval).toHaveBeenCalledTimes(2)
		expect(executed).toEqual(["corepack prepare pnpm@10.0.0 --activate", "corepack prepare pnpm@10.0.0 --activate"])
	})

	it("does not reuse an approval across different tool names", async () => {
		const { controller, approval, executed, operations } = setup()
		const grant = settle(controller, "npx --version")
		controller.settleBashApproval("reused-id", "approved", grant)
		await execute(controller, operations, "npx --version", "run_review_command")
		expect(approval).toHaveBeenCalledTimes(1)
		expect(executed).toEqual(["npx --version"])
	})

	it("requires fresh approval when the command changes between gate settlement and execution", async () => {
		const { controller, approval, operations } = setup()
		const grant = settle(controller, "npx --version")
		controller.settleBashApproval("reused-id", "approved", grant)
		await execute(controller, operations, "npm install completely-different-package")
		expect(approval).toHaveBeenCalledTimes(1)
		expect(approval.mock.calls[0][0]).toMatchObject({
			command: "npm install completely-different-package",
			kind: "direct-install",
		})
	})

	it("preserves the unchanged gate-and-execution single-approval path", async () => {
		const { controller, approval, operations } = setup()
		const grant = settle(controller, "npx --version")
		expect(await controller.requestApproval(grant, { mode: "library" })).toBe("approved")
		controller.settleBashApproval("reused-id", "approved", grant)
		const result = await execute(controller, operations, "npx --version")
		expect(result).toMatchObject({ status: "passed", approval: "approved", network: "approved-online" })
		expect(approval).toHaveBeenCalledTimes(1)
	})

	it("clears a settled grant when preparation throws before executeReviewCommand runs", async () => {
		const { controller, approval, operations } = setup()
		controller.settleBashApproval("reused-id", "approved", settle(controller, "npx --version"))
		controller.bindCommandAuthorizer(async () => {
			throw new Error("preparation crash")
		})
		await expect(execute(controller, operations, "npx --version")).rejects.toThrow("preparation crash")

		controller.bindCommandAuthorizer(async () => undefined)
		await execute(controller, operations, "npx --version")
		expect(approval).toHaveBeenCalledTimes(1)
	})

	it("clears a settled grant when a bash call is aborted before execution", async () => {
		const { controller, approval } = setup()
		mkdirSync(worktree.path, { recursive: true })
		controller.settleBashApproval("reused-id", "approved", settle(controller, "npx --version"))
		const bash = createReviewBashToolDefinition(controller)
		const context = createToolContext({ cwd: worktree.path })
		const abort = new AbortController()
		abort.abort()
		await expect(
			bash.execute("reused-id", { command: "npx --version" }, abort.signal, undefined, context),
		).rejects.toThrow(/aborted/)

		await bash.execute("reused-id", { command: "npx --version" }, undefined, undefined, context)
		expect(approval).toHaveBeenCalledTimes(1)
	})
})
