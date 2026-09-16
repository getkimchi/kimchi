/**
 * Git intent capture for remote plan execution (PR-first flow).
 *
 * When the user picks "Execute the plan in a remote workspace", the dispatch
 * can optionally capture a branch name. With a branch captured, the worker
 * provisions the sandbox onto that branch (created from the origin default
 * branch when missing), the agent commits its work there, and the completion
 * flow offers review → steer → push-with-consent → draft PR.
 *
 * Escape/empty input (or any non-interactive mode) yields no intent — the run
 * behaves exactly like a plain remote execution.
 *
 * See .kimchi/plans/remote-pr-flow.md.
 */

import { execFileSync } from "node:child_process"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

/** Git intent captured at dispatch — the branch the remote agent commits on. */
export interface RemoteGitWorkflow {
	/** The PR branch, e.g. `kimchi/add-rate-limits`. */
	branch: string
	/**
	 * Origin's default branch the worker forks from. Undefined when the local
	 * clone cannot resolve it (e.g. refs/remotes/origin/HEAD missing) — the
	 * worker still forks from the remote default branch, this only feeds
	 * prompt text and `gh pr create --base`.
	 */
	baseBranch: string | undefined
}

const ORIGIN_PREFIX = "origin/"
const FALLBACK_SLUG = "plan"
export const MAX_SLUG_LENGTH = 48

/**
 * Derives the suggested branch name from the plan's `## Goal` first line:
 * `kimchi/<slug>`. Falls back to `kimchi/plan` when there is no Goal section
 * or the goal yields no usable ASCII slug.
 */
export function slugifyPlanBranch(planText: string): string {
	const goalLine = extractGoalFirstLine(planText)
	const slug = goalLine ? slugify(goalLine) : ""
	return `kimchi/${slug || FALLBACK_SLUG}`
}

function extractGoalFirstLine(planText: string): string | undefined {
	const lines = planText.split(/\r?\n/)
	const headerIndex = lines.findIndex((line) => /^##\s+Goal\b/.test(line))
	if (headerIndex === -1) return undefined
	for (const line of lines.slice(headerIndex + 1)) {
		const trimmed = line.trim()
		if (/^#{1,6}\s/.test(trimmed)) return undefined
		if (trimmed.length > 0) return trimmed
	}
	return undefined
}

function slugify(text: string): string {
	const slug = text
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
	if (slug.length <= MAX_SLUG_LENGTH) return slug
	return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "")
}

export interface ResolveBaseBranchOptions {
	/** Test seam: injectable exec. Defaults to node:child_process execFileSync. */
	_execFileSync?: typeof execFileSync
}

/**
 * Resolves the local clone's origin default branch (the branch the worker
 * forks the PR branch from) via `git symbolic-ref --short refs/remotes/origin/HEAD`.
 * Deterministic and offline — reads a local symref, never touches the network.
 * Returns undefined when the symref is missing or git fails.
 */
export function resolveBaseBranch(
	ctx: Pick<ExtensionContext, "cwd">,
	opts: ResolveBaseBranchOptions = {},
): string | undefined {
	const exec = opts._execFileSync ?? execFileSync
	let out: string
	try {
		out = exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
			cwd: ctx.cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
	} catch {
		return undefined
	}
	const branch = out.startsWith(ORIGIN_PREFIX) ? out.slice(ORIGIN_PREFIX.length) : undefined
	return branch || undefined
}

/**
 * Conservative git branch-name validation (subset of check-ref-format rules).
 * The branch name later rides into deterministic remote git argv, so reject
 * anything git would refuse rather than letting it fail on the sandbox.
 */
export function isValidBranchName(name: string): boolean {
	if (!name || name.length > 200) return false
	// Allowlist charset — rejects control chars, space, and every git-forbidden char (~^:?*[\]).
	if (!/^[\w./-]+$/.test(name)) return false
	if (name.includes("..") || name.includes("//") || name.includes("@{")) return false
	if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false
	if (name.split("/").some((c) => c.length === 0 || c.startsWith(".") || c.endsWith(".lock"))) return false
	return true
}

export const REMOTE_BRANCH_PROMPT = "Branch name for the remote run (Escape or empty for a plain run)"

export interface PromptForRemoteBranchOptions {
	/** Test seam: injectable base-branch resolver. */
	_resolveBaseBranch?: (ctx: Pick<ExtensionContext, "cwd">) => string | undefined
}

/**
 * Asks for the PR branch name, prefilled with the suggestion. Returns the
 * captured git intent, or undefined for a plain run: non-interactive modes,
 * Escape/empty input, or an invalid branch name.
 */
export async function promptForRemoteBranch(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui">,
	suggested: string,
	opts: PromptForRemoteBranchOptions = {},
): Promise<RemoteGitWorkflow | undefined> {
	// Headless/oneshot: no UI to review/steer/consent later — plain run.
	if (!ctx.hasUI || ctx.mode !== "tui") return undefined
	const input = await ctx.ui.input(REMOTE_BRANCH_PROMPT, suggested)
	const branch = input?.trim()
	if (!branch) return undefined
	if (!isValidBranchName(branch)) {
		ctx.ui.notify(`"${branch}" is not a valid git branch name — running a plain remote run instead`, "warning")
		return undefined
	}
	const resolve = opts._resolveBaseBranch ?? resolveBaseBranch
	return { branch, baseBranch: resolve(ctx) }
}
