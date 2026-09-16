/**
 * Consent-gated push + draft-PR helpers for the remote PR flow.
 *
 * This module is the ONLY code path that moves code to the remote git host.
 * It never runs on its own: post-completion invokes it strictly after the
 * user has explicitly consented in the dropdown. Two push strategies:
 *
 *  1. `pushBranchRemotely` — deterministic `ssh git -C <cwd> push -u origin
 *     <branch>` executed on the sandbox (the branch lives only there).
 *  2. `pushViaLocalFallback` — fetch the branch from the sandbox into the
 *     local repo under `refs/kimchi-push/<branch>` (never refs/heads, never
 *     the worktree) and push it to origin with the user's LOCAL credentials.
 *     Offered ONLY as an explicit user-facing choice after the sandbox push
 *     fails (sandbox clone tokens may be read-only or absent).
 *
 * `createDraftPr` runs `gh pr create --draft` locally — the branch is on
 * origin by then, so no checkout is required. When `gh` is missing or
 * unauthenticated, the exact manual command is returned for display; this
 * must never be a silent failure.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../config.js"
import { buildProxyCommand } from "../teleport/provisioning/proxy-command.js"
import type { SandboxGitError } from "./sandbox-git.js"
import { runSandboxGit, type SandboxGitConnection } from "./sandbox-git.js"

// ---------------------------------------------------------------------------
// Secret scanning (deterministic, curated high-confidence patterns only)

export interface SecretScanHit {
	/** Pattern label, e.g. "AWS access key id". */
	pattern: string
	/** The matching line, trimmed, with the secret substring redacted. */
	line: string
	/** 1-based line number within the scanned patch. */
	lineNumber: number
}

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{ label: "private key block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
	{ label: "AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
	{ label: "GitHub personal access token", regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/ },
	{ label: "GitLab personal access token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
	{ label: "OpenAI-style API key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
	{ label: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
]

/** Replace an obvious-looking secret substring inside a line with `***`. */
function redact(line: string): string {
	return line
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***")
		.replace(/\b(ghp_[A-Za-z0-9]{6})[A-Za-z0-9]{30}\b/g, "$1***")
		.replace(/\b(github_pat_[A-Za-z0-9_]{10})[A-Za-z0-9_]{12,}\b/g, "$1***")
		.replace(/\b(glpat-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{16,}\b/g, "$1***")
		.replace(/\b(sk-[A-Za-z0-9]{4})[A-Za-z0-9]{16,}\b/g, "$1***")
		.replace(/\b(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]{31}\b/g, "$1***")
		.replace(/\b(xox[baprs]-[A-Za-z0-9]{4})[A-Za-z0-9-]{6,}\b/g, "$1***")
}

/**
 * Scan a unified-diff patch for likely secrets. Deterministic regex set —
 * no entropy heuristics. Only added (`+`) lines are scanned; removed lines
 * are disappearing from the tree, not being pushed anywhere new.
 */
export function scanDiffForSecrets(patch: string): SecretScanHit[] {
	const hits: SecretScanHit[] = []
	patch.split("\n").forEach((rawLine, index) => {
		if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) return
		const line = rawLine.slice(1)
		for (const { label, regex } of SECRET_PATTERNS) {
			if (regex.test(line)) {
				hits.push({ pattern: label, line: redact(line.trim()).slice(0, 120), lineNumber: index + 1 })
				break
			}
		}
	})
	return hits
}

// ---------------------------------------------------------------------------
// Push — primary (sandbox) and fallback (local machine)

export type PushFailureKind = "auth" | "non-fast-forward" | "transport" | "unknown"

export interface PushFailure {
	kind: PushFailureKind
	/** Human-readable explanation, derived from git's stderr. */
	reason: string
	/** Raw stderr tail for the notify payload. */
	stderr?: string
}

export type PushResult = { ok: true } | { ok: false; failure: PushFailure }

/** Classify a failed `git push` stderr into an actionable kind. */
export function classifyPushFailure(stderr: string): PushFailure {
	const text = stderr.toLowerCase()
	if (/non-fast-forward|fetch first|stale info/.test(text)) {
		return {
			kind: "non-fast-forward",
			reason: "The remote already has this branch with different commits — someone else pushed to it.",
			stderr,
		}
	}
	if (/permission denied|authentication failed|could not read from|403|401|repository not found/.test(text)) {
		return {
			kind: "auth",
			reason:
				"The sandbox's git credential could not push (read-only or missing). Use the local fallback to push with your own credentials.",
			stderr,
		}
	}
	if (
		/connection (refused|reset)|operation timed out|network is unreachable|name or service not known|no route to host/.test(
			text,
		)
	) {
		return { kind: "transport", reason: "Could not reach the remote git host from the sandbox (network).", stderr }
	}
	return { kind: "unknown", reason: `git push failed: ${stderr.trim().split("\n")[0] ?? "unknown error"}`, stderr }
}

/**
 * Push the branch from the sandbox: `git push -u origin <branch>` via the
 * shared SSH transport. Never force-pushes. Failures are classified — never
 * thrown — so the caller can offer the local fallback explicitly.
 */
export async function pushBranchRemotely(opts: {
	connection: SandboxGitConnection
	branch: string
	signal?: AbortSignal
	onStdoutChunk?: (chunk: string) => void
}): Promise<PushResult> {
	try {
		await runSandboxGit({
			connection: opts.connection,
			args: ["push", "-u", "origin", opts.branch],
			signal: opts.signal,
			onStdoutChunk: opts.onStdoutChunk,
		})
		return { ok: true }
	} catch (err) {
		const stderr = (err as Partial<SandboxGitError>).stderr ?? (err instanceof Error ? err.message : String(err))
		return { ok: false, failure: classifyPushFailure(stderr) }
	}
}

/**
 * Local fallback: fetch the sandbox branch into the user's repo under
 * `refs/kimchi-push/<branch>` (never touches refs/heads or the worktree),
 * then push it to origin with the user's local credentials.
 *
 * The fetch's GIT_SSH_COMMAND mirrors buildSandboxGitSshArgv's option layout
 * (same ProxyCommand tunnel, BatchMode, keepalive); the push runs with the
 * plain ambient environment (the user's own git/ssh config untouched).
 */
export async function pushViaLocalFallback(opts: {
	connection: SandboxGitConnection
	branch: string
	localRepo: string
	/** Cloud API key for the ProxyCommand tunnel; defaults to loadConfig(). */
	apiKey?: string
	/** Test seams. */
	execFile?: typeof execFileSync
	proxyCommand?: string
}): Promise<PushResult> {
	const exec = opts.execFile ?? execFileSync
	const sessionDir = mkdtempSync(join(tmpdir(), "kimchi-push-fallback-"))
	const knownHostsFile = join(sessionDir, "known_hosts")
	const stagingRef = `refs/kimchi-push/${opts.branch}`
	try {
		writeFileSync(knownHostsFile, "", "utf-8")
		const proxyCommand = opts.proxyCommand ?? buildProxyCommand()
		// Same options as buildSandboxGitSshArgv (ssh -o …), minus destination +
		// remote command — GIT_SSH_COMMAND supplies those itself. Every value is
		// POSIX single-quoted except ProxyCommand, which buildProxyCommand has
		// already quoted for shell splitting (double-quoted here).
		const sshCommand = [
			"ssh",
			"-o",
			`"ProxyCommand=${proxyCommand}"`,
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`UserKnownHostsFile=${knownHostsFile}`,
			"-o",
			"BatchMode=yes",
			"-o",
			"ServerAliveInterval=15",
		].join(" ")
		const sshUrl = `ssh://${opts.connection.remoteUser}@${opts.connection.host}${opts.connection.cwd}`
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_SSH_COMMAND: sshCommand,
			KIMCHI_API_KEY: opts.apiKey ?? loadConfig().apiKey,
			AUTH_TOKEN: opts.connection.authToken,
		}
		exec("git", ["fetch", "--no-tags", sshUrl, `+refs/heads/${opts.branch}:${stagingRef}`], {
			cwd: opts.localRepo,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		})
		try {
			exec("git", ["push", "-u", "origin", `${stagingRef}:refs/heads/${opts.branch}`], {
				cwd: opts.localRepo,
				stdio: ["ignore", "pipe", "pipe"],
			})
		} finally {
			// The staging ref is a transport scratch space — never leave it in
			// the user's repo: stale refs can mask later pushes. Best-effort.
			try {
				exec("git", ["update-ref", "-d", stagingRef], { cwd: opts.localRepo, stdio: ["ignore", "pipe", "pipe"] })
			} catch {
				// already gone / never created — no user-facing consequence
			}
		}
		return { ok: true }
	} catch (err) {
		const stderr = stderrOf(err) || (err instanceof Error ? err.message : String(err))
		return { ok: false, failure: classifyPushFailure(stderr) }
	} finally {
		rmSync(sessionDir, { recursive: true, force: true })
	}
}

function stderrOf(err: unknown): string {
	if (err && typeof err === "object" && "stderr" in err) {
		const se = (err as { stderr?: unknown }).stderr
		if (Buffer.isBuffer(se)) return se.toString("utf8")
		if (typeof se === "string") return se
	}
	return ""
}

// ---------------------------------------------------------------------------
// Draft PR creation (local gh; manual fallback when unavailable)

export interface DraftPrManual {
	kind: "manual"
	/** Why gh could not be used (missing binary, unauthenticated, API error). */
	reason: string
	/** The exact command the user can run themselves. */
	command: string
}
export interface DraftPrCreated {
	kind: "created"
	url: string
}
export type DraftPrResult = DraftPrCreated | DraftPrManual

/** The exact manual command line for display (secrets-free). */
export function manualPrCommand(opts: { branch: string; baseBranch?: string; title: string }): string {
	return `gh pr create --draft --head ${opts.branch}${opts.baseBranch ? ` --base ${opts.baseBranch}` : ""} --title "${opts.title.replace(/"/g, '\\"')}" --body "<run summary>"`
}

/**
 * Create a draft PR via the local `gh` CLI (the branch is already on origin,
 * so no checkout is needed). Returns the manual command on ANY gh failure —
 * missing binary, unauthenticated, API error — so the user always has a
 * notified next action.
 */
export function createDraftPr(opts: {
	localRepo: string
	branch: string
	baseBranch?: string
	title: string
	body: string
	execFile?: typeof execFileSync
}): DraftPrResult {
	const command = manualPrCommand(opts)
	try {
		const exec = opts.execFile ?? execFileSync
		const stdout = exec(
			"gh",
			[
				"pr",
				"create",
				"--draft",
				"--head",
				opts.branch,
				...(opts.baseBranch ? ["--base", opts.baseBranch] : []),
				"--title",
				opts.title,
				"--body",
				opts.body,
			],
			{ cwd: opts.localRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		) as unknown as string
		const url = String(stdout).trim().split("\n").pop()?.trim() ?? ""
		if (!/^https?:\/\//.test(url)) {
			return { kind: "manual", reason: `gh produced no PR URL (${url || "empty output"})`, command }
		}
		return { kind: "created", url }
	} catch (err) {
		const stderr = stderrOf(err) || (err instanceof Error ? err.message : String(err))
		const reason = /ENOENT|command not found|not recognized/i.test(stderr)
			? "gh CLI is not installed"
			: /auth login|not authenticated|authentication required|\b401\b|\b403\b/i.test(stderr)
				? "gh CLI is not authenticated (run `gh auth login`)"
				: `gh pr create failed: ${stderr.trim().split("\n")[0] ?? "unknown error"}`
		return { kind: "manual", reason, command }
	}
}

// ---------------------------------------------------------------------------
// Local branch pull (after a consented push to origin)

export interface PullBranchSuccess {
	kind: "pulled"
	/** What happened to the local branch. */
	action: "created" | "checked-out" | "fast-forwarded"
}
export interface PullBranchFailure {
	kind: "failed"
	/** Human-readable reason (first stderr line). */
	reason: string
	/** The exact manual commands the user can run themselves. */
	command: string
}
export type PullBranchResult = PullBranchSuccess | PullBranchFailure

/**
 * After a consented push to origin, make the branch available locally:
 * fetch it from origin, then when the local branch already exists switch to
 * it and fast-forward-merge, otherwise create it tracking origin/<branch>.
 * NEVER throws, NEVER touches origin, and reports the exact manual commands
 * on any failure (dirty worktree, diverged branch).
 */
export function pullBranchLocally(opts: {
	localRepo: string
	branch: string
	execFile?: typeof execFileSync
}): PullBranchResult {
	const { localRepo, branch } = opts
	const command = `git fetch origin ${branch} && git switch ${branch} && git merge --ff-only origin/${branch}`
	const exec = opts.execFile ?? execFileSync
	const run = (args: string[]): void => {
		exec("git", args, { cwd: localRepo, stdio: ["ignore", "pipe", "pipe"] })
	}
	try {
		run(["fetch", "--no-tags", "origin", branch])
		let exists = true
		try {
			run(["rev-parse", "--verify", `refs/heads/${branch}`])
		} catch {
			exists = false
		}
		if (!exists) {
			run(["switch", "-c", branch, "--track", `origin/${branch}`])
			return { kind: "pulled", action: "created" }
		}
		run(["switch", branch])
		run(["merge", "--ff-only", `origin/${branch}`])
		return { kind: "pulled", action: "fast-forwarded" }
	} catch (err) {
		const stderr = stderrOf(err) || (err instanceof Error ? err.message : String(err))
		return { kind: "failed", reason: stderr.trim().split("\n")[0] ?? "unknown git error", command }
	}
}
