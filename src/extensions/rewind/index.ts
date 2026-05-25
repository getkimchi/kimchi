import { renameSync, writeFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent"

export default function rewindExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rewind", {
		description: "Rewind conversation to a previous point",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const targetId = await resolveRewindTarget(args, ctx)
			if (!targetId) return
			await performRewind(targetId, ctx)
		},
	})
}

// ─── Target resolution ────────────────────────────────────────────────────────

async function resolveRewindTarget(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const trimmed = args.trim()

	// Offset mode: /rewind -N
	if (/^-\d+$/.test(trimmed)) {
		return resolveByOffset(Number.parseInt(trimmed, 10), ctx)
	}

	// Empty → interactive picker
	if (trimmed === "") {
		return resolveByPicker(ctx)
	}

	// Invalid format
	ctx.ui.notify("Usage: /rewind or /rewind -N", "warning")
	return undefined
}

function resolveByOffset(offset: number, ctx: ExtensionCommandContext): string | undefined {
	const sm = ctx.sessionManager
	const leafId = sm.getLeafId()
	if (!leafId) {
		ctx.ui.notify("No active session.", "warning")
		return undefined
	}

	// Walk backward counting "message" type entries
	let currentId: string | null = leafId
	let count = 0

	while (currentId && count < Math.abs(offset)) {
		const entry = sm.getEntry(currentId)
		if (!entry) break
		if (entry.type === "message") {
			const role = (entry as { message?: { role?: string } }).message?.role
			if (role === "user" || role === "developer") {
				count++
			}
		}
		if (count === Math.abs(offset)) break
		currentId = entry.parentId
	}

	if (count < Math.abs(offset)) {
		const available = count
		ctx.ui.notify(`Cannot rewind ${Math.abs(offset)} messages: only ${available} available.`, "warning")
		return undefined
	}

	// currentId is now the Nth message from the end; return its parentId (rewind BEFORE it)
	if (!currentId) {
		ctx.ui.notify("Could not resolve rewind target.", "error")
		return undefined
	}
	const targetEntry = sm.getEntry(currentId)
	if (!targetEntry) {
		ctx.ui.notify("Could not resolve rewind target.", "error")
		return undefined
	}
	return targetEntry.parentId ?? undefined
}

async function resolveByPicker(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const entries = ctx.sessionManager.getEntries()
	const userMessages: SessionEntry[] = []

	for (const entry of entries) {
		if (entry.type !== "message") continue
		const role = (entry as { message?: { role?: string } }).message?.role
		if (role === "user" || role === "developer") {
			userMessages.push(entry)
		}
	}

	if (userMessages.length === 0) {
		ctx.ui.notify("No messages to rewind.", "warning")
		return undefined
	}

	// Format as "N. preview" — the index maps directly to userMessages array
	const choiceLabels = userMessages.map((entry, index) => {
		const text = extractPreview(entry)
		return `${index + 1}. ${text}`
	})

	const selected = await ctx.ui.select("Rewind to before which message?", choiceLabels)
	if (!selected) return undefined

	// Parse the selected index and look up the corresponding entry
	const match = selected.match(/^(\d+)\./)
	if (!match) return undefined
	const chosenIndex = Number.parseInt(match[1], 10) - 1
	const chosen = userMessages[chosenIndex]
	if (!chosen) return undefined
	return chosen.parentId ?? undefined
}

// ─── File rewrite ─────────────────────────────────────────────────────────────

async function performRewind(targetId: string, ctx: ExtensionCommandContext): Promise<void> {
	const sm = ctx.sessionManager
	const originalFile = sm.getSessionFile()
	if (!originalFile) {
		ctx.ui.notify("Session file not found.", "error")
		return
	}

	const branchPath = sm.getBranch(targetId)
	if (branchPath.length === 0) {
		ctx.ui.notify("Could not resolve branch for rewind target.", "error")
		return
	}

	const header = sm.getHeader()
	if (!header) {
		ctx.ui.notify("Session header not found.", "error")
		return
	}

	const content = `${[header, ...branchPath].map((e) => JSON.stringify(e)).join("\n")}\n`
	const tempFile = `${originalFile}.rewind.tmp`

	try {
		writeFileSync(tempFile, content)
		renameSync(tempFile, originalFile)
	} catch (err) {
		ctx.ui.notify(`Failed to rewind: ${err instanceof Error ? err.message : String(err)}`, "error")
		return
	}

	const result = await ctx.switchSession(originalFile)
	if (result.cancelled) {
		ctx.ui.notify("Rewind was cancelled.", "warning")
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPreview(entry: SessionEntry): string {
	if (entry.type !== "message") return "(non-message)"
	const text =
		(entry as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join(" ") ?? ""
	const trimmed = text.trim().replace(/\s+/g, " ")
	return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed || "(empty message)"
}
