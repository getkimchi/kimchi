import { type BashToolDetails, createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { ProcessDisplaySnapshot } from "./process-registry.js"

/** Shell text is data: never send its terminal controls to the user's terminal. */
export function safeBashText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, (char) => (char === "\n" ? char : ""))
}

export function bashStatus(snapshot: ProcessDisplaySnapshot, now = snapshot.observedAt): string {
	const elapsed = `${Math.max(0, Math.floor(((snapshot.finishedAt ?? now) - snapshot.startedAt) / 1000))}s`
	if (snapshot.reason === "deadline") return `Deadline reached · ${elapsed}`
	if (snapshot.reason === "stop") return `Stopped · ${elapsed}`
	if (snapshot.reason === "aborted") return `Aborted · ${elapsed}`
	if (snapshot.state === "running") return `Running · ${elapsed}`
	if (snapshot.exitCode === 0) return `Exited 0 · ${elapsed}`
	if (snapshot.exitCode !== null) return `Failed (exit ${snapshot.exitCode}) · ${elapsed}`
	return `Outcome unavailable · ${elapsed}`
}

export function bashOutputAge(snapshot: ProcessDisplaySnapshot, now = snapshot.observedAt): string {
	return snapshot.lastOutputAt === undefined
		? "No output yet"
		: `Last output ${Math.max(0, Math.floor((now - snapshot.lastOutputAt) / 1000))}s ago`
}

export function bashTitle(snapshot: ProcessDisplaySnapshot): string {
	return safeBashText(snapshot.description || snapshot.command)
		.replace(/\s+/g, " ")
		.trim()
}

function stringArg(args: unknown, key: string): string {
	if (!args || typeof args !== "object") return ""
	const value: unknown = Reflect.get(args, key)
	return typeof value === "string" ? value : ""
}

let upstreamBash: ReturnType<typeof createBashToolDefinition> | undefined

export const renderBashCall: NonNullable<ToolDefinition["renderCall"]> = (args, _theme, ctx) => ({
	invalidate() {},
	render(width) {
		const purpose = safeBashText(stringArg(args, "description")).replace(/\s+/g, " ")
		const command = safeBashText(stringArg(args, "command"))
		const handle = stringArg(args, "handle") ? `Command ${safeBashText(stringArg(args, "handle"))}` : ""
		const lines = [`Bash${purpose ? ` · ${purpose}` : ""}${handle ? ` · ${handle}` : ""}`]
		if (command)
			lines.push(...(ctx.expanded ? wrapTextWithAnsi(command, Math.max(1, width)) : [command.replace(/\s+/g, " ")]))
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"))
	},
})

export const renderBashResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, ctx) => {
	upstreamBash ??= createBashToolDefinition(process.cwd())
	const details = result.details as (BashToolDetails & { display?: ProcessDisplaySnapshot }) | undefined
	const display = details?.display
	const terminal = display && display.state !== "running"
	// Keep upstream full-result rendering, expansion, truncation warnings and spill-file references.
	// Pass a fresh component because our live preview has a different component shape.
	const complete =
		!display || terminal
			? upstreamBash.renderResult?.(
					{
						content: result.content.map((block) =>
							block.type === "text" ? { ...block, text: safeBashText(block.text) } : block,
						),
						details: details
							? {
									...details,
									fullOutputPath: details.fullOutputPath ? safeBashText(details.fullOutputPath) : undefined,
								}
							: undefined,
					},
					options,
					theme,
					{ ...ctx, args: { command: stringArg(ctx.args, "command") }, lastComponent: undefined },
				)
			: undefined
	if (!display && complete) return complete
	return {
		invalidate() {
			complete?.invalidate()
		},
		render(width) {
			const w = Math.max(1, width)
			if (!display) return []
			const captured = !options.isPartial && display.state === "running"
			const status = captured
				? bashStatus(display).replace("Running", "Still running at check-in")
				: bashStatus(display)
			const lines = [`${bashTitle(display)} · ${status}`, `Command ${display.handle}`]
			if (stringArg(ctx.args, "handle"))
				lines.push(...wrapTextWithAnsi(safeBashText(display.command), w).slice(0, options.expanded ? undefined : 1))
			if (terminal && complete) return [...lines.map((line) => truncateToWidth(line, w, "…")), ...complete.render(w)]
			const output = wrapTextWithAnsi(safeBashText(display.output).trimEnd() || "No output yet", w)
			const tail = output.slice(-(options.expanded ? 20 : 3))
			lines.push(...tail)
			if (display.omittedBytes > 0 || output.length > tail.length) lines.push("Older output omitted")
			lines.push(`${bashOutputAge(display)} · ${captured ? "Snapshot at check-in · " : ""}/commands to inspect`)
			return lines.map((line) => truncateToWidth(line, w, "…"))
		},
	}
}
