/**
 * Restores project files together with the conversation. The bundled
 * pi-rewind-hook package snapshots the git worktree on every turn and adds
 * "restore files" choices to /tree and /fork; /rewind moves the conversation
 * back to an earlier prompt and lets that menu restore the files.
 * File restore needs a git repository.
 */

import type { UserMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import registerFileCheckpoints from "./pi-rewind-hook.js"

const LABEL_MAX_CHARS = 80

export default function rewindExtension(pi: ExtensionAPI): void {
	registerFileCheckpoints(pi)

	pi.registerCommand("rewind", {
		description: "Go back to an earlier prompt, optionally restoring files",
		handler: (_args, ctx) => rewindToPrompt(ctx),
	})
}

async function rewindToPrompt(ctx: ExtensionCommandContext): Promise<void> {
	// ACP clients have no session tree to move back in.
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Rewind is available in the terminal UI.", "info")
		return
	}

	if (!ctx.isIdle()) {
		ctx.ui.notify("Rewind is available once the agent finishes. Press Esc to stop it first.", "warning")
		return
	}

	const prompts = userPrompts(ctx.sessionManager.getBranch())
	if (prompts.length === 0) {
		ctx.ui.notify("Nothing to rewind to yet.", "info")
		return
	}

	// Numbered in conversation order so identical prompts stay distinguishable; listed newest first.
	const choices = new Map(prompts.map((prompt, index) => [`${index + 1}. ${prompt.label}`, prompt.id]))
	const choice = await ctx.ui.select("Rewind to before which prompt?", [...choices.keys()].reverse())
	const targetId = choice ? choices.get(choice) : undefined
	if (!targetId) return

	await ctx.navigateTree(targetId, { summarize: false })
}

function userPrompts(branch: SessionEntry[]): Array<{ id: string; label: string }> {
	return branch.flatMap((entry) =>
		entry.type === "message" && entry.message.role === "user"
			? [{ id: entry.id, label: promptLabel(entry.message.content) }]
			: [],
	)
}

function promptLabel(content: UserMessage["content"]): string {
	const text =
		typeof content === "string"
			? content
			: content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ")
	const firstLine = text.trim().split("\n")[0] ?? ""
	return firstLine.length > LABEL_MAX_CHARS ? `${firstLine.slice(0, LABEL_MAX_CHARS - 1)}…` : firstLine
}
