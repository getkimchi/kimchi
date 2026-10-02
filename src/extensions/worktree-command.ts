import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { quote } from "shell-quote"
import { loadConfig } from "../config.js"
import { runInWorkspace } from "../worktree-launch.js"
import { listWorktrees, prepareWorktree } from "../worktrees.js"

export default function worktreeCommandExtension(pi: ExtensionAPI): void {
	const show = (content: string) =>
		pi.sendMessage({ customType: "worktree", content, display: true }, { triggerTurn: false })
	pi.registerCommand("worktree", {
		description: "Create or open a Git worktree; /worktree list shows all checkouts",
		handler: async (args, ctx) => {
			await ctx.waitForIdle()
			try {
				let branch = args.trim()
				if (branch === "list" || (!branch && !ctx.hasUI)) {
					show(
						listWorktrees(ctx.cwd)
							.map(
								(tree) =>
									`${tree.branch ?? "detached HEAD"} — ${tree.path}${tree.locked ? " (locked)" : ""}${tree.prunable ? " (missing)" : ""}`,
							)
							.join("\n"),
					)
					return
				}
				let path: string | undefined
				if (!branch) {
					const trees = listWorktrees(ctx.cwd).filter((tree) => !tree.prunable && !tree.locked)
					const labels = trees.map((tree) => `${tree.branch ?? "detached HEAD"} — ${tree.path}`)
					const choice = await ctx.ui.select("Worktrees", ["Create a new worktree", ...labels])
					if (!choice) return
					if (choice === "Create a new worktree") {
						branch = (await ctx.ui.input("Branch for the new worktree", "fix/login"))?.trim() ?? ""
						if (!branch) return
					} else {
						const tree = trees[labels.indexOf(choice)]
						path = tree.path
						branch = tree.branch ?? "detached HEAD"
					}
				}
				path ??= prepareWorktree(ctx.cwd, branch).path
				show(
					`Worktree ready: ${branch}\n${path}\n\nRun in another terminal:\n${quote(["cd", path])} && kimchi\n\nUncommitted and ignored files stay in the original checkout. Exit the new session to return here.`,
				)
				if (!ctx.hasUI) return
				const action = await ctx.ui.select(`Open ${branch}`, [
					"Start a new session",
					"Resume latest session",
					"Show launch command",
				])
				if (!action || action === "Show launch command") return
				const childArgs = ctx.model ? ["--provider", ctx.model.provider, "--model", ctx.model.id] : []
				if (action === "Resume latest session") childArgs.push("--continue")
				const env = { ...process.env, KIMCHI_API_KEY: loadConfig().apiKey }
				const target = path
				const code = await ctx.ui.custom<number>(async (tui, _theme, _keys, done) => {
					tui.stop()
					let result: number
					try {
						result = await runInWorkspace(target, childArgs, env)
					} finally {
						tui.start()
						tui.requestRender(true)
					}
					done(result)
					return { render: () => [], invalidate: () => {} }
				})
				ctx.ui.notify(`Returned to ${ctx.cwd}${code ? ` (child exited ${code})` : ""}`, code ? "warning" : "info")
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
			}
		},
	})
}
