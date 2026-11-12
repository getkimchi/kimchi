import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { command } from "../pull-request-status/provider-api.js"
import type { PRSnapshot } from "./types.js"

export async function checkoutProblem(cwd: string, pr: PRSnapshot, signal: AbortSignal): Promise<string | null> {
	const deadline = Date.now() + 5000
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

export async function acquirePRLease(
	pr: PRSnapshot,
	onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
	const key = createHash("sha256").update(pr.url).digest("hex")
	const directory = join(getAgentDir(), "pr-monitor", key)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	return lock(directory, { retries: 0, stale: 30_000, update: 5000, onCompromised })
}
