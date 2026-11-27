import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { createContext } from "../../../src/extensions/__mocks__/context.js"
import { createExtensionApi } from "../../../src/extensions/__mocks__/extension-api.js"
import type { RunResult } from "../../../src/extensions/agents/manager/agent-runner.js"
import { runReviewPanel } from "../../../src/extensions/review-panel/panel.js"
import { submitFinding, submitSummary } from "../../../src/extensions/review-submit/store.js"
import { parseReviewTargetArgs } from "../../../src/extensions/review-targets/parser.js"
import { resolveReviewTarget } from "../../../src/extensions/review-targets/resolve.js"
import type { ExplicitReviewRequest } from "../../../src/extensions/review-targets/types.js"

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim()
}

function completed(responseText: string): RunResult {
	return {
		responseText,
		session: { messages: [{ role: "assistant", stopReason: "stop" }] } as unknown as RunResult["session"],
		aborted: false,
		steered: false,
	}
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}
}

function createUsageSession() {
	const listeners = new Set<AgentSessionEventListener>()
	const session = {
		messages: [{ role: "assistant", stopReason: "stop" }],
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	} as unknown as RunResult["session"]
	return {
		session,
		emit(input: number, output: number) {
			const message: AssistantMessage = {
				role: "assistant",
				api: "openai-completions",
				provider: "natural-exit-provider",
				model: "natural-exit-model",
				content: [],
				usage: { ...zeroUsage(), input, output, totalTokens: input + output },
				stopReason: "stop",
				timestamp: Date.now(),
			}
			for (const listener of [...listeners]) listener({ type: "message_end", message })
		},
	}
}

async function main(): Promise<void> {
	const sandbox = mkdtempSync(join(tmpdir(), "review-panel-natural-exit-"))
	const repo = join(sandbox, "repo")
	const outputDir = join(sandbox, "review-output")
	const contextDir = join(sandbox, "review-context")
	const abortBlockedUsage = process.env.REVIEW_USAGE_ABORT === "1"
	const usageAborted = { value: false }
	const childUsage = createUsageSession()
	try {
		execFileSync("mkdir", ["-p", repo])
		git(repo, "init", "--initial-branch=main")
		git(repo, "config", "user.name", "Natural Exit Fixture")
		git(repo, "config", "user.email", "exit@localhost")
		writeFileSync(join(repo, "value.ts"), "export const value = 1\n")
		git(repo, "add", "value.ts")
		git(repo, "commit", "-m", "base")
		writeFileSync(join(repo, "value.ts"), "export const value = 1\nexport const risky = true\n")
		git(repo, "add", "value.ts")
		git(repo, "commit", "-m", "head")
		const baseSha = git(repo, "rev-parse", "HEAD^")
		const target = await resolveReviewTarget(
			parseReviewTargetArgs(["branch", "main", "--base", baseSha]) as ExplicitReviewRequest,
			{ root: repo, contextDir },
		)
		const result = await runReviewPanel({
			ctx: createContext({ cwd: repo, hasUI: false }),
			pi: createExtensionApi().api,
			target,
			outputDir,
			lenses: ["spec"],
			rootDir: join(sandbox, "worktrees"),
			checkDefinitions: [],
			executionPolicy: { mode: "headless" },
			...(abortBlockedUsage
				? {
						deadline: Date.now() + 500,
						finalWriteHeadroomMs: 200,
						reconciliationReserveMs: 300,
						submitGraceMs: 250,
						cancellationGraceMs: 250,
					}
				: {}),
			onProgress: (update) => {
				if (abortBlockedUsage && update.phase === "complete") childUsage.emit(40, 60)
			},
			onChildUsage: abortBlockedUsage
				? (_usage, signal) =>
						new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, 120_000)
							signal.addEventListener(
								"abort",
								() => {
									usageAborted.value = true
									clearTimeout(timer)
									resolve()
								},
								{ once: true },
							)
						})
				: undefined,
			spawnAgent: async ({ prompt, options }) => {
				options.onSessionCreated?.(childUsage.session)
				if (prompt.startsWith("REVIEW_LENS")) {
					await submitFinding(
						{
							path: "value.ts",
							line: 2,
							severity: "warning",
							type: "bug",
							description: "Natural-exit fixture finding.",
							suggestion: "Apply this valid candidate and exit without an explicit process.exit.",
						},
						{ writer: "spec", contextDir, outputDir },
					)
					await submitSummary(
						{ body: "Fast natural-exit review.", environment_gaps: [] },
						{ writer: "spec", contextDir, outputDir },
					)
					return completed("review complete")
				}
				return completed(
					JSON.stringify({
						schema_version: "review-reconciliation/v1",
						findings: [
							{
								id: "natural-exit-finding",
								path: "value.ts",
								line: 2,
								severity: "warning",
								type: "bug",
								description: "Natural-exit fixture finding.",
								suggestion: "Apply this valid candidate and exit without an explicit process.exit.",
								candidate_ids: ["spec-1"],
							},
						],
						decisions: [
							{
								candidate_id: "spec-1",
								disposition: "retained",
								finding: "natural-exit-finding",
								reason: "Independent candidate.",
							},
						],
						threads: [],
					}),
				)
			},
		})
		console.log(
			JSON.stringify({ outcome: "completion", findingCount: result.findings.length, usageAborted: usageAborted.value }),
		)
	} finally {
		rmSync(sandbox, { recursive: true, force: true })
	}
}

void main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
