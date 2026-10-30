/**
 * Live PR card: reads the PR with `gh pr view` (your existing login) and turns
 * the answer into the card's data model. Read-only. GitLab cards are created
 * but not polled yet.
 */
import { execFile } from "node:child_process"
import type { PullRequestRef } from "./signals.js"
import type { SideSurface, Tone } from "./surface.js"

export const POLL_ENV = "KIMCHI_SIDE_LOOP_POLL_MS"
const DEFAULT_POLL_MS = 20_000
const FIELDS = "number,title,state,isDraft,reviewDecision,statusCheckRollup,comments,url,headRefName"

export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const value = Number(env[POLL_ENV])
	return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_POLL_MS
}

interface Check {
	name?: string
	context?: string
	status?: string
	conclusion?: string
	state?: string
}

interface GhPullRequest {
	number: number
	title: string
	state: string
	isDraft?: boolean
	reviewDecision?: string
	statusCheckRollup?: Check[]
	comments?: unknown[]
	headRefName?: string
}

type Outcome = "pass" | "fail" | "pending"

function outcome(check: Check): Outcome {
	const value = (check.conclusion || check.state || check.status || "").toUpperCase()
	if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value)) return "pass"
	if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value))
		return "fail"
	return "pending"
}

/** Map a `gh pr view --json` answer to the card's data model. Pure. */
export function pullRequestData(pr: GhPullRequest): Record<string, unknown> {
	const checks = pr.statusCheckRollup ?? []
	const outcomes = checks.map(outcome)
	const passed = outcomes.filter((o) => o === "pass").length
	const failed = checks.filter((_, i) => outcomes[i] === "fail").map((c) => c.name ?? c.context ?? "check")
	const pending = outcomes.filter((o) => o === "pending").length
	const state = pr.state === "OPEN" && pr.isDraft ? "draft" : pr.state.toLowerCase()
	let tone: Tone = "ok"
	if (failed.length || pr.reviewDecision === "CHANGES_REQUESTED") tone = "error"
	else if (pending) tone = "pending"
	const ci = !checks.length
		? "no checks"
		: failed.length
			? `✗ ${failed.length} failed · ${passed}/${checks.length} passed`
			: pending
				? `… ${passed}/${checks.length} passed · ${pending} running`
				: `✓ ${passed}/${checks.length} passed`
	const review =
		pr.reviewDecision === "APPROVED"
			? "approved"
			: pr.reviewDecision === "CHANGES_REQUESTED"
				? "changes requested"
				: "review pending"
	const comments = pr.comments?.length ?? 0
	return {
		title: pr.title,
		state,
		ci,
		failed: failed.join(", "),
		review,
		comments: String(comments),
		branch: pr.headRefName ?? "",
		tone,
		summary: `${ci.split(" · ")[0]} · 💬 ${comments}`,
		terminal: pr.state === "MERGED" || pr.state === "CLOSED",
	}
}

export function pullRequestSurface(ref: PullRequestRef): Omit<SideSurface, "createdAt" | "updatedAt"> {
	return {
		id: `pr:${ref.repo}#${ref.number}`,
		kind: "pr",
		title: `${ref.host === "gitlab" ? "MR !" : "PR #"}${ref.number}`,
		summary: { path: "/summary" },
		tone: { path: "/tone" },
		link: ref.url,
		components: [
			{ id: "root", type: "list", children: ["title", "facts", "failed"] },
			{ id: "title", type: "text", text: { path: "/title" } },
			{
				id: "facts",
				type: "kv",
				items: [
					{ label: "state", value: { path: "/state" } },
					{ label: "CI", value: { path: "/ci" } },
					{ label: "review", value: { path: "/review" } },
					{ label: "comments", value: { path: "/comments" } },
				],
			},
			{ id: "failed", type: "text", text: { path: "/failed" }, tone: "error" },
		],
		data: {
			title: ref.repo,
			state: "opened",
			ci: "loading…",
			review: "",
			comments: "0",
			tone: "pending",
			summary: "loading…",
		},
	}
}

export type GhRunner = (args: string[], cwd: string, signal: AbortSignal) => Promise<string>

export const runGh: GhRunner = (args, cwd, signal) =>
	new Promise((resolve, reject) => {
		execFile("gh", args, { cwd, signal, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		)
	})

export async function readPullRequest(
	ref: PullRequestRef,
	cwd: string,
	signal: AbortSignal,
	gh: GhRunner = runGh,
): Promise<Record<string, unknown>> {
	const stdout = await gh(["pr", "view", ref.url, "--json", FIELDS], cwd, signal)
	return pullRequestData(JSON.parse(stdout) as GhPullRequest)
}
