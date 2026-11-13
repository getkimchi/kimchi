/**
 * Post-main exit prompt for worktree sessions (slice 1, TUI only).
 *
 * Called from cli.ts after pi's main() returns and the TUI is torn down.
 * Rules (plan §2.3 step 7):
 *   - unnamed (`--worktree` without a name) and clean → removed silently;
 *   - named and clean → ask keep/remove;
 *   - has work (dirty/untracked/own commits) → ask keep/remove, and confirm
 *     again before force-removing;
 *   - headless (`-p`), ACP or non-TTY stdout → never prompt, keep.
 *
 * Everything here is best-effort: a failure to prompt or remove must never
 * change the session's exit code (the visit decision is already made).
 */

import { existsSync } from "node:fs"
import { confirm, isCancel, log } from "@clack/prompts"
import { trackWorktreeEvent } from "./extensions/telemetry/index.js"
import {
	removeWorktree,
	resolveRepoRoots,
	WORKTREE_BRANCH_PREFIX,
	WorktreeError,
	worktreeStatus,
} from "./shared/git/worktree.js"
import { emitWorktreeHook, type WorktreeHookSubject } from "./worktree-hooks.js"

function exitHookSubject(env: ExitPromptEnvironment): WorktreeHookSubject {
	return {
		name: env.name,
		dir: env.dir,
		branch: `${WORKTREE_BRANCH_PREFIX}${env.name}`,
		mainRoot: env.mainRoot,
		kind: "user",
	}
}

export interface ExitPromptEnvironment {
	/** The worktree directory. */
	dir: string
	/** The main checkout root. */
	mainRoot: string
	/** Worktree name (dir basename). */
	name: string
	/** True when the user named the worktree (auto-generated names are removed
	 *  silently when clean). */
	named: boolean
	/** True only for the interactive TUI with TTY stdout. */
	interactive: boolean
}

export interface ExitDecision {
	/** Keep the worktree (and print the resume hint when asked). */
	action: "keep" | "remove"
	/** Print `kimchi --worktree <name> --resume` (keep path). */
	resumeHint: boolean
}

/** True when stdout is a TTY and stdin is not piped (an interactive TUI can
 *  actually answer). Mirrors cli.ts's terminalIo checks. */
export function isInteractiveExitPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.KIMCHI_NONINTERACTIVE !== "1" && process.stdout.isTTY === true && process.stdin.isTTY === true
}

/**
 * Decide the worktree's fate at session exit without prompting:
 * the no-UI path used by `-p`, ACP and non-TTY invocations (always keep).
 */
export function silentExitDecision(): ExitDecision {
	return { action: "keep", resumeHint: false }
}

/** Read the worktree state; failures degrade to "assume work exists" (keep). */
async function readExitStatus(
	dir: string,
	mainRoot: string,
): Promise<{ dirty: boolean; untracked: boolean; ownCommits: number }> {
	try {
		return await worktreeStatus(dir, mainRoot)
	} catch {
		return { dirty: true, untracked: false, ownCommits: 0 }
	}
}

/**
 * Run the exit prompt for the given worktree session. Returns the decision.
 * Never throws: prompting errors degrade to "keep".
 */
export async function promptWorktreeExit(env: ExitPromptEnvironment): Promise<ExitDecision> {
	if (!env.interactive) return silentExitDecision()

	if (!existsSync(env.dir)) {
		// The worktree was already removed (e.g. user did it mid-session).
		return { action: "remove", resumeHint: false }
	}

	const status = await readExitStatus(env.dir, env.mainRoot)
	const hasWork = status.dirty || status.untracked || status.ownCommits > 0

	// Unnamed + clean → remove silently (Claude Code semantics for anonymous
	// worktrees). Named worktrees are always asked.
	if (!env.named && !hasWork) {
		try {
			await removeWorktree({ dir: env.dir, branch: `${WORKTREE_BRANCH_PREFIX}${env.name}` })
			await emitWorktreeHook("WorktreeRemove", exitHookSubject(env), true)
			trackWorktreeEvent("removed", { source: "user", named: env.named, had_work: false })
		} catch {
			// Removal is best-effort at exit.
		}
		log.info(`Removed worktree ${env.name} (clean)`)
		return { action: "remove", resumeHint: false }
	}

	const removeAnswer = await confirm({
		message: hasWork ? `Worktree ${env.name} has uncommitted work. Remove it anyway?` : `Keep worktree ${env.name}?`,
		initialValue: !hasWork, // default: keep when there is work, remove when clean
	})
	if (isCancel(removeAnswer) || removeAnswer === false) {
		// Keep.
		if (!env.named) {
			log.info(`Worktree ${env.name} kept. Resume it later with: kimchi --worktree ${env.name} --resume`)
		}
		trackWorktreeEvent("kept", { source: "user", named: env.named, had_work: hasWork })
		return { action: "keep", resumeHint: !env.named }
	}

	// Remove confirmed. If there is work, confirm once more before discarding.
	if (hasWork) {
		const discard = await confirm({
			message: `Discard uncommitted work in ${env.name}? This cannot be undone.`,
			initialValue: false,
		})
		if (isCancel(discard) || discard === false) {
			return { action: "keep", resumeHint: false }
		}
	}

	try {
		await removeWorktree({ dir: env.dir, branch: `${WORKTREE_BRANCH_PREFIX}${env.name}`, force: hasWork })
		await emitWorktreeHook("WorktreeRemove", exitHookSubject(env), true)
		trackWorktreeEvent("removed", { source: "user", named: env.named, had_work: hasWork })
		log.info(`Removed worktree ${env.name}`)
		return { action: "remove", resumeHint: false }
	} catch (err) {
		if (err instanceof WorktreeError) log.warn(`Could not remove worktree ${env.name}: ${err.message}`)
		return { action: "keep", resumeHint: false }
	}
}

/** Default mainRoot lookup for `promptWorktreeExit` — from a sibling env var. */
export function worktreeMainRootFromDir(dir: string): string | undefined {
	// The pre-main hook sets KIMCHI_WORKTREE_MAIN to the main root. When that's
	// missing (e.g. a resumed session), fall back to resolveRepoRoots.
	const fromEnv = process.env.KIMCHI_WORKTREE_MAIN
	if (fromEnv) return fromEnv
	const roots = resolveRepoRoots(dir)
	return roots.mainRoot
}

/** Convenience wrapper for cli.ts: reads the binding + environment from the
 *  process state and runs the prompt. Returns the decision. */
export async function runWorktreeExitPrompt(opts: {
	dir: string
	mainRoot: string
	name: string
	named: boolean
	interactive: boolean
}): Promise<ExitDecision> {
	return promptWorktreeExit(opts)
}
