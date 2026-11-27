import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { getParsedCliArgs } from "../../cli-args.js"
import { resolveReviewDirectories } from "./paths.js"
import {
	DEFAULT_WRITER_LIMIT,
	type ReviewSubmitContext,
	type SubmitResult,
	submitFinding,
	submitReply,
	submitSummary,
} from "./store.js"

function invalidWriterLimit(configuredLimit: string | undefined): SubmitResult | undefined {
	if (configuredLimit === undefined) return undefined
	const parsed = Number(configuredLimit)
	if (!/^[0-9]+$/.test(configuredLimit) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
		return {
			accepted: false,
			reason: "invalid_writer_limit",
			field: "writer_limit",
			message:
				"--review-writer-limit must be a decimal integer from 1 to 1000 (default 50; no sign, decimal point, exponent, or whitespace).",
		}
	}
	return undefined
}

type ReviewInvocation =
	| { context: ReviewSubmitContext; rejection?: never }
	| { context?: never; rejection: SubmitResult }

function toolResult(result: SubmitResult): AgentToolResult<SubmitResult> {
	return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
}

export default function reviewSubmitExtension(pi: ExtensionAPI, binding?: ReviewSubmitContext): void {
	if (binding === undefined) {
		pi.registerFlag("review", {
			description: "Enable review mode and its submit tools",
			type: "boolean",
		})
		pi.registerFlag("review-writer", {
			description: "Writer ID for submitted review records (default: final)",
			type: "string",
			default: "final",
		})
		pi.registerFlag("review-writer-limit", {
			description: "Maximum findings per non-final writer: decimal integer 1–1000 (default: 50; final is always 50)",
			type: "string",
			default: String(DEFAULT_WRITER_LIMIT),
		})
		pi.registerFlag("review-context-dir", {
			description: "Review context directory (default: .kimchi/review-context under the current project)",
			type: "string",
		})
		pi.registerFlag("review-output-dir", {
			description: "Review output directory (default: .kimchi/review-output under the current project)",
			type: "string",
		})
	}
	// Upstream applies extension flag values after factories load. The shared
	// CLI parse captures --review before flags are applied at that later stage.
	if (!binding && pi.getFlag("review") !== true && getParsedCliArgs().options.review !== true) return
	const stringFlag = (name: string): string | undefined => {
		const value = pi.getFlag(name)
		return typeof value === "string" ? value : undefined
	}
	const contextFor = (cwd: string): ReviewInvocation => {
		if (binding) return { context: binding }
		const rejection = invalidWriterLimit(stringFlag("review-writer-limit"))
		if (rejection) return { rejection }
		const writer = stringFlag("review-writer") ?? "final"
		return {
			context: {
				writer,
				writerLimit:
					writer === "final" ? DEFAULT_WRITER_LIMIT : Number(stringFlag("review-writer-limit") ?? DEFAULT_WRITER_LIMIT),
				...resolveReviewDirectories(cwd, {
					contextDir: stringFlag("review-context-dir"),
					outputDir: stringFlag("review-output-dir"),
				}),
			},
		}
	}

	pi.registerTool({
		name: "submit_finding",
		label: "Submit Review Finding",
		description:
			"Validate and store one structured code-review finding in the configured review output directory for the writer selected with --review-writer (default: final). Output defaults to .kimchi/review-output under the current project. Anchors are read from the configured review context directory (default: .kimchi/review-context under the current project). Returns the accepted finding ID or a structured rejection. Writes are local and atomic; this tool never posts or uses the network.",
		promptSnippet: "Store a validated local review finding without posting it",
		parameters: Type.Object(
			{
				path: Type.String({ description: "Repository-relative file path (maximum 4 KiB in UTF-8)" }),
				line: Type.Integer({ minimum: 1, description: "New-side line number" }),
				severity: Type.Union([Type.Literal("critical"), Type.Literal("warning"), Type.Literal("info")]),
				type: Type.String({ description: "Lowercase finding type, matching ^[a-z][a-z0-9_]*$ (maximum 64 bytes)" }),
				description: Type.String({ description: "Concrete finding and its consequence (maximum 16 KiB in UTF-8)" }),
				suggestion: Type.String({ description: "Actionable correction (maximum 16 KiB in UTF-8)" }),
				derived_from: Type.Optional(
					Type.Array(Type.String(), {
						maxItems: 50,
						description: "IDs of earlier or merged findings that provide provenance",
					}),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const invocation = contextFor(ctx.cwd)
			if (invocation.rejection) return toolResult(invocation.rejection)
			return toolResult(await submitFinding(params, invocation.context))
		},
	})

	pi.registerTool({
		name: "submit_summary",
		label: "Submit Review Summary",
		description:
			"Replace the current writer's local review summary in the configured output directory (default: .kimchi/review-output under the current project). Include environment_gaps for missing tools and unavailable private, Git-URL, or otherwise unsupported dependencies. Validation limits follow review-summary/v1. The write is atomic, nothing is posted, and no network access is used.",
		promptSnippet: "Store the local review summary and environment gaps",
		parameters: Type.Object(
			{
				body: Type.String({
					description: "Overall review body, including summary-only findings (maximum 64 KiB in UTF-8)",
				}),
				score: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
				estimated_effort_to_review: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
				environment_gaps: Type.Optional(
					Type.Array(
						Type.Object(
							{
								kind: Type.String({
									description: "For example missing_tool, private_package, git_url_package, or unsupported_ecosystem",
								}),
								name: Type.String({ description: "Missing tool or package name (maximum 512 UTF-8 bytes)" }),
								note: Type.String({ description: "Short explanation of what was blocked (maximum 2 KiB in UTF-8)" }),
							},
							{ additionalProperties: false },
						),
						{ maxItems: 50 },
					),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const invocation = contextFor(ctx.cwd)
			if (invocation.rejection) return toolResult(invocation.rejection)
			return toolResult(await submitSummary(params, invocation.context))
		},
	})

	pi.registerTool({
		name: "submit_reply",
		label: "Submit Review Reply",
		description:
			"Validate and store a local reply to an existing thread from the configured review context directory (default: .kimchi/review-context under the current project). Replies are restricted to our own findings and threads marked as mentioning the bot. Only our threads can use resolve or reopen. Own-finding replies require verdict, evidence_kind, and evidence. Missing thread context rejects every reply. Writes are local and atomic; nothing is posted.",
		promptSnippet: "Store a scoped local review-thread reply without posting it",
		parameters: Type.Object(
			{
				thread_id: Type.String({ description: "Existing thread ID from comments.json" }),
				body: Type.String({ description: "Reply body (maximum 64 KiB in UTF-8)" }),
				action: Type.Union([Type.Literal("resolve"), Type.Literal("reopen"), Type.Literal("none")]),
				verdict: Type.Optional(
					Type.Union([
						Type.Literal("fixed"),
						Type.Literal("not_fixed"),
						Type.Literal("partially_fixed"),
						Type.Literal("no_longer_applicable"),
						Type.Literal("regressed"),
						Type.Literal("unverified"),
					]),
				),
				evidence_kind: Type.Optional(
					Type.Union([
						Type.Literal("code_reference"),
						Type.Literal("existing_test"),
						Type.Literal("new_test"),
						Type.Literal("none"),
					]),
				),
				evidence: Type.Optional(Type.String({ description: "Verification evidence (maximum 16 KiB in UTF-8)" })),
			},
			{ additionalProperties: false },
		),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const invocation = contextFor(ctx.cwd)
			if (invocation.rejection) return toolResult(invocation.rejection)
			return toolResult(await submitReply(params, invocation.context))
		},
	})
}

/** Bind one reviewer instance without consulting process-level review flags.
 * Concurrent in-process reviewers each get their own immutable writer context. */
export function createReviewSubmitExtension(context: ReviewSubmitContext): (pi: ExtensionAPI) => void {
	return (pi) => reviewSubmitExtension(pi, context)
}
