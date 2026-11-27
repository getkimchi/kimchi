import { isAbsolute, relative, resolve, sep } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { ReviewCheckQueue } from "./checks.js"
import {
	commandToolResult,
	createReviewBashToolDefinition,
	executeReviewCommand,
	isDirectInstallCommand,
	REVIEW_CHECK_TOOL,
	REVIEW_COMMAND_TOOL,
	type ReviewCommandRecord,
	type ReviewExecutionController,
} from "./execution.js"
import type { ReviewWorktreePool } from "./types.js"

export const REVIEW_CHILD_TOOL_NAMES = [
	REVIEW_CHECK_TOOL,
	REVIEW_COMMAND_TOOL,
	"submit_finding",
	"submit_summary",
	"submit_reply",
] as const

export interface ReviewChildToolsOptions {
	controller: ReviewExecutionController
	worktrees: ReviewWorktreePool
	checks: ReviewCheckQueue
	writer: string
}

function commandDirectory(worktreePath: string, requested: string | undefined): { path: string; relative: string } {
	if (requested !== undefined && (isAbsolute(requested) || requested.includes("\0"))) {
		throw new Error("Review command cwd must be a repository-relative path.")
	}
	const path = resolve(worktreePath, requested || ".")
	const repositoryRelative = relative(worktreePath, path)
	if (repositoryRelative === ".." || repositoryRelative.startsWith(`..${sep}`) || isAbsolute(repositoryRelative)) {
		throw new Error("Review command cwd must stay inside its assigned worktree.")
	}
	return { path, relative: repositoryRelative || "." }
}

function notRun(command: string, cwd: string, worktree: string, output: string): ReviewCommandRecord {
	return {
		command,
		cwd,
		intendedCheck: "focused reviewer check",
		worktree,
		status: "blocked",
		elapsedMs: 0,
		output,
		network: "offline",
		approval: "not-requested",
	}
}

/** Register only review-local adapters. The worker permission gate remains the
 * single permission/prompt extension in the child. */
export function registerReviewChildTools(pi: ExtensionAPI, options: ReviewChildToolsOptions): void {
	const bash = createReviewBashToolDefinition(options.controller)
	bash.description +=
		" Local review commands run offline except for an explicitly approved direct install. Use run_review_check for configured routine builds and suites and run_review_command for focused evidence or an online retry after an offline failure."
	pi.registerTool(bash)

	pi.registerTool({
		name: REVIEW_CHECK_TOOL,
		label: "Run Shared Review Check",
		description:
			"Run or join the configured routine review check by ID in its dedicated pinned worktree. Concurrent callers share one execution and later callers reuse its saved result, including failures. Set online=true only after the same offline check failed and an online retry is necessary; that retry requires the same explicit local approval as an install.",
		promptSnippet: "Run or cite shared routine build/test evidence",
		parameters: Type.Object(
			{
				id: Type.String({ description: "Configured check ID, such as build or test" }),
				revision: Type.Optional(Type.Union([Type.Literal("base"), Type.Literal("head")], { default: "head" })),
				online: Type.Optional(Type.Boolean({ default: false })),
			},
			{ additionalProperties: false },
		),
		executionMode: "parallel",
		async execute(toolCallId, params, signal) {
			const result = await options.checks.request({
				id: params.id,
				requestedBy: options.writer,
				controller: options.controller,
				toolCallId,
				revision: params.revision,
				online: params.online,
				signal,
			})
			return commandToolResult(result)
		},
	})

	pi.registerTool({
		name: REVIEW_COMMAND_TOOL,
		label: "Run Focused Review Command",
		description:
			"Run one focused reviewer-authored check in this reviewer's private worktree, or its private base-revision comparison worktree. Routine configured builds and suites must use run_review_check instead. Local runs are offline. After an identical offline command fails, online=true asks for one explicitly approved online rerun.",
		promptSnippet: "Run focused private test evidence or request an online retry",
		parameters: Type.Object(
			{
				command: Type.String({ description: "Shell command to execute" }),
				cwd: Type.Optional(Type.String({ description: "Repository-relative working directory (default: .)" })),
				intended_check: Type.Optional(Type.String({ description: "What this command is intended to verify" })),
				revision: Type.Optional(Type.Union([Type.Literal("base"), Type.Literal("head")], { default: "head" })),
				online: Type.Optional(Type.Boolean({ default: false })),
			},
			{ additionalProperties: false },
		),
		executionMode: "parallel",
		async execute(toolCallId, params, signal) {
			const revision = params.revision ?? "head"
			const worktree =
				revision === "base"
					? await options.worktrees.getWorktree(`${options.writer}:base`, { kind: "reviewer", revision: "base" })
					: options.controller.worktree
			const directory = commandDirectory(worktree.path, params.cwd)
			if (revision === "head") {
				const routine = options.checks.routineCommand(params.command, directory.relative)
				if (routine) {
					return commandToolResult(
						notRun(
							params.command,
							directory.path,
							worktree.path,
							`This is configured routine check "${routine.id}". Request it with run_review_check so every reviewer shares one result.`,
						),
					)
				}
			}
			if (params.online === true && options.controller.mode === "local" && !isDirectInstallCommand(params.command)) {
				const failedOffline = options.controller.records.some(
					(record) =>
						record.command === params.command &&
						record.cwd === directory.path &&
						record.worktree === worktree.path &&
						record.network === "offline" &&
						record.status === "failed",
				)
				if (!failedOffline) {
					return commandToolResult(
						notRun(
							params.command,
							directory.path,
							worktree.path,
							"An online rerun requires a failed offline execution of this exact command, cwd, and private worktree.",
						),
					)
				}
			}
			return commandToolResult(
				await executeReviewCommand(options.controller, {
					command: params.command,
					cwd: directory.path,
					intendedCheck: params.intended_check ?? "focused reviewer check",
					worktree,
					online: params.online,
					toolCallId,
					signal,
				}),
			)
		},
	})
}
