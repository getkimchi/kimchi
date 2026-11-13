/**
 * EnterWorktree / ExitWorktree tools (slice 4) — restart-in-place worktree
 * switching from inside the interactive TUI.
 *
 * A tool cannot re-exec the process mid-turn, so both tools follow the same
 * dance: do the filesystem work, drop a restart marker (src/worktree-restart.ts),
 * ask the model to stop, and request a graceful shutdown via ctx.shutdown()
 * (a flag checked at the next turn boundary). cli.ts then reads the marker
 * after pi's main() returns and re-execs the binary resumed into the target
 * directory. See docs/worktrees.md.
 *
 * Registered only for the interactive TUI — ACP clients use the
 * `_kimchi.dev/worktree/create|list|remove` ext methods instead, and headless
 * `-p` runs have no terminal to restart into.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { createWorktree, generateWorktreeName, resolveRepoRoots, WorktreeError } from "../shared/git/worktree.js"
import { emitWorktreeHook } from "../worktree-hooks.js"
import { writeWorktreeRestartRequest } from "../worktree-restart.js"
import { readWorktreeBindingFromEnv } from "./worktree-session-binding.js"

function agentDirFromEnv(): string {
	return process.env.KIMCHI_CODING_AGENT_DIR ?? resolve(homedir(), ".config", "kimchi", "harness")
}

function text(content: string) {
	return { content: [{ type: "text" as const, text: content }], details: {} }
}

export function createWorktreeModeExtension() {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "EnterWorktree",
			label: "Enter Worktree",
			description:
				"Restart the current session inside a git worktree (branch worktree-<name>) under " +
				".kimchi/worktrees/, resuming the conversation there. Use for isolated, disposable work " +
				"without touching the main checkout. The session shuts down and relaunches — do not call " +
				"further tools afterwards in the same turn.",
			parameters: Type.Object({
				name: Type.Optional(Type.String({ description: "Worktree name ([a-z0-9-]). Auto-generated when omitted." })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (readWorktreeBindingFromEnv()) {
					return text("Already inside a kimchi worktree — use ExitWorktree to leave it instead.")
				}
				const name = params.name ?? generateWorktreeName()
				try {
					const { mainRoot, worktreeRoot } = resolveRepoRoots(ctx.cwd)
					if (worktreeRoot) {
						return text("Already inside a linked git worktree — nested worktrees are not supported.")
					}
					const reused = existsSync(resolve(mainRoot, ".kimchi", "worktrees", name))
					const created = await createWorktree({ mainRoot, name, baseRef: "fresh", reuseExisting: reused })
					const sessionFile = ctx.sessionManager.getSessionFile()
					if (!sessionFile) {
						return text("No session file yet — send one message first, then enter the worktree.")
					}
					writeWorktreeRestartRequest(agentDirFromEnv(), {
						direction: "enter",
						name: created.name,
						sessionFile,
					})
					if (!reused) {
						void emitWorktreeHook(
							"WorktreeCreate",
							{ name: created.name, dir: created.path, branch: created.branch, mainRoot, kind: "user" },
							true,
						)
					}
					ctx.shutdown()
					return text(
						`Restarting the session in worktree ${created.name} (${created.path}, branch ${created.branch}). ` +
							"Do not call further tools — the session relaunches there automatically.",
					)
				} catch (err) {
					if (err instanceof WorktreeError) return text(`Could not enter worktree: ${err.message}`)
					throw err
				}
			},
		})

		pi.registerTool({
			name: "ExitWorktree",
			label: "Exit Worktree",
			description:
				"Leave the current git worktree session and restart in the main checkout, resuming the " +
				"conversation. The worktree itself is kept (use `kimchi worktree remove` to clean up later). " +
				"The session shuts down and relaunches — do not call further tools afterwards in the same turn.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const binding = readWorktreeBindingFromEnv()
				if (!binding) {
					return text("This session is not running inside a worktree.")
				}
				const sessionFile = ctx.sessionManager.getSessionFile()
				if (!sessionFile) {
					return text("No session file yet — send one message first, then exit the worktree.")
				}
				writeWorktreeRestartRequest(agentDirFromEnv(), {
					direction: "exit",
					mainRoot: binding.mainRoot,
					sessionFile,
				})
				ctx.shutdown()
				return text(
					`Restarting the session in the main checkout (${binding.mainRoot}). The worktree ${binding.name} is kept. ` +
						"Do not call further tools — the session relaunches automatically.",
				)
			},
		})
	}
}

export default createWorktreeModeExtension
