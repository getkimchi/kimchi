import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { type ExtensionToolContext, getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { quote } from "shell-quote"
import { resolvePreMainProjectTrust } from "../../project-trust.js"
import { command } from "../pull-request-status/provider-api.js"
import { readPRSource } from "./providers.js"
import type { PRSnapshot } from "./types.js"

const GIT_BUDGET_MS = 5000
const CLONE_TIMEOUT_SECONDS = 120
const CLONE_ERROR_LIMIT = 600
const LEASE_STALE_MS = 30_000
const LEASE_UPDATE_MS = 5000

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

export async function checkoutProblem(cwd: string, pr: PRSnapshot, signal: AbortSignal): Promise<string | null> {
	const deadline = Date.now() + GIT_BUDGET_MS
	const git = (...args: string[]) => command("git", ["-C", cwd, ...args], cwd, signal, deadline)
	const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD")
	if (branch !== pr.branch) return "The checked-out branch changed. Enable auto-fix again on the intended PR."
	const head = await git("rev-parse", "HEAD")
	if (head !== pr.headSha) return "Local HEAD differs from the PR. Push or sync your branch before auto-fixing."
	// --branch makes a clean result nonempty, so a failed Git command cannot look clean.
	const status = await git("status", "--porcelain=v1", "--branch", "--untracked-files=normal")
	if (!status?.startsWith("## ")) return "The working tree could not be verified."
	const header = status.split("\n")[0]
	if (header !== `## ${pr.branch}` && !header.startsWith(`## ${pr.branch}...`)) return "The checked-out branch changed."
	return status.includes("\n") ? "Commit or stash local changes before auto-fixing this PR." : null
}

/** One repair per PR across Kimchi sessions and processes. */
export async function acquirePRLease(
	pr: PRSnapshot,
	onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
	const directory = join(getAgentDir(), "pr-watch", "leases", digest(pr.url))
	await mkdir(directory, { recursive: true, mode: 0o700 })
	return lock(directory, { retries: 0, stale: LEASE_STALE_MS, update: LEASE_UPDATE_MS, onCompromised })
}

/** Asks before allowing automatic repairs in a checkout outside the session's project. */
export async function confirmCheckoutTrust(ctx: ExtensionToolContext, cwd: string, signal: AbortSignal): Promise<void> {
	if (resolvePreMainProjectTrust(cwd, getAgentDir())) return
	const allowed =
		ctx.hasUI &&
		(await ctx.ui.confirm(
			"Trust PR checkout?",
			`Allow automatic repairs in ${cwd}? Normal tool permissions still apply.`,
			{
				signal,
			},
		))
	if (!allowed) throw new Error(`Trust ${cwd} before enabling auto-fix.`)
	new ProjectTrustStore(getAgentDir()).set(cwd, true)
}

/** Uses the given checkout, or clones the PR's source branch through permission-checked Bash. */
export async function preparePRCheckout(
	ctx: ExtensionToolContext,
	url: string,
	signal: AbortSignal,
	directory?: string,
	requireTrust = true,
): Promise<string> {
	const source = await readPRSource(url, signal)
	if (source.state !== "open") throw new Error("This PR is no longer open.")
	const cwd = directory
		? resolve(ctx.cwd, directory)
		: join(getAgentDir(), "pr-watch", "checkouts", digest(`${ctx.sessionManager.getSessionId()}:${source.url}`))
	if (!existsSync(join(cwd, ".git"))) {
		if (directory || existsSync(cwd))
			throw new Error(`No Git checkout at ${cwd}. Choose a checkout or let Kimchi create an isolated one.`)
		await mkdir(dirname(cwd), { recursive: true, mode: 0o700 })
		const cli = source.provider === "github" ? "gh" : "glab"
		const clone = [cli, "repo", "clone", source.cloneURL, cwd, "--", "--single-branch", "--branch", source.branch]
		const outcome = await ctx.executeTool("bash", { command: quote(clone), timeout: CLONE_TIMEOUT_SECONDS }, { signal })
		if (outcome.isError) {
			const output = outcome.result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ")
			throw new Error(`Could not prepare ${source.url}. ${output.slice(0, CLONE_ERROR_LIMIT)}`)
		}
	}
	signal.throwIfAborted()
	if (requireTrust) await confirmCheckoutTrust(ctx, cwd, signal)
	return cwd
}
