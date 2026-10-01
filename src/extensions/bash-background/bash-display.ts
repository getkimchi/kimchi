import {
	type BashToolDetails,
	createBashToolDefinition,
	type ThemeColor,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { ProcessDisplaySnapshot, ProcessRegistry } from "./process-registry.js"
import { getSessionRegistry } from "./session-registry.js"

type BashResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0]
type BashRow = {
	source: BashResult
	result: BashResult
	isPartial: boolean
	invalidate: () => void
	unsubscribe?: () => void
}

// A fresh registry also isolates resumed sessions. Historical control results replay
// into the original row, while controls without that row keep their own display.
const sessionRows = new WeakMap<ProcessRegistry, Map<string, BashRow>>()

function rowsForSession(): Map<string, BashRow> | undefined {
	const registry = getSessionRegistry()
	if (!registry) return undefined
	let rows = sessionRows.get(registry)
	if (!rows) {
		rows = new Map()
		sessionRows.set(registry, rows)
	}
	return rows
}

function hiddenControl(ctx: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2]): boolean {
	return !ctx.state.bashControlError && !!rowsForSession()?.has(stringArg(ctx.args, "handle"))
}

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

export function bashStatusColor(snapshot: ProcessDisplaySnapshot): ThemeColor {
	if (snapshot.state === "running") return "accent"
	if (snapshot.reason) return "warning"
	if (snapshot.exitCode === 0) return "success"
	return snapshot.exitCode === null ? "warning" : "error"
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

export const renderBashCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme, ctx) => ({
	invalidate() {},
	render(width) {
		if (hiddenControl(ctx)) return []
		const purpose = safeBashText(stringArg(args, "description")).replace(/\s+/g, " ")
		const command = safeBashText(stringArg(args, "command"))
		const handle = stringArg(args, "handle") ? `Command ${safeBashText(stringArg(args, "handle"))}` : ""
		const lines = [
			theme.bold(theme.fg("toolTitle", `Bash${purpose ? ` · ${purpose}` : ""}`)) +
				theme.fg("text", handle ? ` · ${handle}` : ""),
		]
		if (command)
			lines.push(
				...(ctx.expanded ? wrapTextWithAnsi(command, Math.max(1, width)) : [command.replace(/\s+/g, " ")]).map((line) =>
					theme.fg("mdCode", line),
				),
			)
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"))
	},
})

export const renderBashResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, ctx) => {
	const display = (result.details as { display?: ProcessDisplaySnapshot } | undefined)?.display
	const registry = getSessionRegistry()
	const rows = rowsForSession()
	if (stringArg(ctx.args, "handle")) {
		ctx.state.bashControlError = !display
		const original = display && rows?.get(display.handle)
		if (original) {
			if (ctx.state.bashControlResult !== result.details) {
				ctx.state.bashControlResult = result.details
				original.result = result
				original.isPartial = options.isPartial
				original.invalidate()
			}
			return { invalidate() {}, render: () => [] }
		}
	} else if (display && rows && registry) {
		let row: BashRow | undefined = ctx.state.bashRow
		if (!row) {
			row = { source: result, result, isPartial: options.isPartial, invalidate: ctx.invalidate }
			ctx.state.bashRow = row
			rows.get(display.handle)?.unsubscribe?.()
			rows.set(display.handle, row)
			const target = row
			let subscribed = false
			target.unsubscribe = registry.observeDisplay(display.handle, (snapshot) => {
				const final = snapshot.state !== "running" ? registry.finalSnapshot(snapshot.handle) : undefined
				target.result = {
					content: [{ type: "text", text: final?.content ?? snapshot.output }],
					details: { ...final, display: snapshot },
				}
				target.isPartial = snapshot.state === "running"
				if (subscribed) target.invalidate()
			})
			subscribed = true
		} else if (row.source.content !== result.content || row.source.details !== result.details) {
			// Pi recreates the result wrapper on invalidation; only a new payload is an update.
			row.source = result
			row.result = result
			row.isPartial = options.isPartial
		}
		result = row.result
		options = { ...options, isPartial: row.isPartial || !!registry.getEntry(display.handle) }
	}
	return renderBashOutput(result, options, theme, ctx)
}

const renderBashOutput: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, ctx) => {
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
			const lines = [
				`${theme.bold(theme.fg("toolTitle", bashTitle(display)))} · ${theme.fg(bashStatusColor(display), status)}`,
				theme.fg("text", `Command ${display.handle}`),
			]
			if (stringArg(ctx.args, "handle"))
				lines.push(
					...wrapTextWithAnsi(safeBashText(display.command), w)
						.slice(0, options.expanded ? undefined : 1)
						.map((line) => theme.fg("mdCode", line)),
				)
			if (terminal && complete) return [...lines.map((line) => truncateToWidth(line, w, "…")), ...complete.render(w)]
			const output = wrapTextWithAnsi(safeBashText(display.output).trimEnd() || "No output yet", w)
			const tail = output.slice(-(options.expanded ? 20 : 3))
			lines.push(...tail.map((line) => theme.fg("toolOutput", line)))
			if (display.omittedBytes > 0 || output.length > tail.length)
				lines.push(theme.fg("warning", "Older output omitted"))
			lines.push(
				`${theme.fg("text", bashOutputAge(display))} · ${captured ? theme.fg("warning", "Snapshot at check-in · ") : ""}${theme.bold(theme.fg("accent", "/processes"))}${theme.fg("text", " to inspect")}`,
			)
			return lines.map((line) => truncateToWidth(line, w, "…"))
		},
	}
}
