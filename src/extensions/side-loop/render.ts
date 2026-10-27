/**
 * Stateless painters for the side loop: the top-right dock and the `/side`
 * pane. Theme is passed in; every producer string is stripped of control
 * characters here, so a card can only ever be text in our frame.
 */
import type { Theme } from "@earendil-works/pi-coding-agent"
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { Stage } from "./stage.js"
import { formatStats, type SideLoopStats } from "./stats.js"
import { resolve, type SideComponent, type SideSurface, type Tone } from "./surface.js"

const DOCK_ROWS = 4

export interface StageView {
	stage: Stage
	source: "d3" | "rule"
	confidence?: number
}

function stageLabel(view: StageView): string {
	return view.source === "d3" ? `${view.stage} · d3 ${(view.confidence ?? 0).toFixed(2)}` : view.stage
}

function clean(value: unknown): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
	return stripTerminalSequences(String(value ?? "")).replace(/[\u0000-\u001f\u007f]/g, " ")
}

function link(url: string, label: string): string {
	return `\x1b]8;;${clean(url)}\x07${label}\x1b]8;;\x07`
}

function toneColor(tone: Tone | undefined): "success" | "error" | "warning" | "accent" | "muted" {
	switch (tone) {
		case "ok":
			return "success"
		case "error":
			return "error"
		case "warn":
		case "pending":
			return "warning"
		case "info":
			return "accent"
		default:
			return "muted"
	}
}

function icon(surface: SideSurface, tone: Tone | undefined): string {
	if (surface.kind === "artifact") return "◆"
	if (tone === "error") return "✗"
	if (tone === "pending") return "◌"
	return "●"
}

interface Frame {
	top: (title: string, right?: string) => string
	row: (styled: string) => string
	bottom: (hint?: string) => string
	inner: number
}

function frame(theme: Theme, width: number, accent: boolean): Frame {
	const w = Math.max(4, width)
	const inner = Math.max(1, w - 4)
	const b = (s: string) => theme.fg(accent ? "borderAccent" : "border", s)
	const fill = (left: string, right: string) => {
		const used = visibleWidth(left) + visibleWidth(right)
		return Math.max(0, w - 2 - used)
	}
	return {
		inner,
		top: (title, right = "") => {
			const l = ` ${title} `
			const r = right ? ` ${right} ` : ""
			const n = fill(l, r)
			return truncateToWidth(b("╭") + theme.bold(l) + b("─".repeat(n)) + theme.fg("muted", r) + b("╮"), w)
		},
		row: (styled) => `${b("│")} ${truncateToWidth(styled, inner, "…", true)} ${b("│")}`,
		bottom: (hint = "") => {
			const r = hint ? ` ${hint} ` : ""
			return truncateToWidth(b("╰") + b("─".repeat(fill("", r))) + theme.fg("dim", r) + b("╯"), w)
		},
	}
}

function chip(theme: Theme, surface: SideSurface, index: number): string {
	const tone = resolve(surface.tone, surface.data)
	const summary = clean(resolve(surface.summary, surface.data) ?? "")
	const title = clean(surface.title)
	const head = theme.fg(toneColor(tone), `${icon(surface, tone)} `)
	const name = surface.link ? link(surface.link, theme.bold(title)) : theme.bold(title)
	return `${theme.fg("dim", `${index + 1}`)} ${head}${name}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`
}

/** The corner card: the cards that matter at this stage, one row each. */
export function renderDock(
	theme: Theme,
	surfaces: readonly SideSurface[],
	width: number,
	opts: { flash?: boolean; stage: StageView; hidden: number },
): string[] {
	if (!surfaces.length) return []
	const f = frame(theme, width, !!opts.flash)
	const lines = [f.top(opts.flash ? "in-time ●" : "in-time", opts.stage.stage)]
	for (const [i, surface] of surfaces.slice(0, DOCK_ROWS).entries()) lines.push(f.row(chip(theme, surface, i)))
	if (surfaces.length > DOCK_ROWS) lines.push(f.row(theme.fg("dim", `+${surfaces.length - DOCK_ROWS} more`)))
	lines.push(f.bottom(opts.hidden ? `${opts.hidden} parked · /side` : "/side"))
	return lines
}

function component(theme: Theme, surface: SideSurface, c: SideComponent, byId: Map<string, SideComponent>): string[] {
	const data = surface.data
	switch (c.type) {
		case "text": {
			const text = clean(resolve(c.text, data))
			return text ? [theme.fg(c.tone ? toneColor(resolve(c.tone, data)) : "text", text)] : []
		}
		case "status": {
			const tone = resolve(c.tone, data)
			return [`${theme.fg("muted", clean(c.label))} ${theme.fg(toneColor(tone), clean(resolve(c.value, data)))}`]
		}
		case "link": {
			const url = clean(resolve(c.url, data))
			return url ? [link(url, theme.fg("accent", clean(resolve(c.label, data))))] : []
		}
		case "kv":
			return c.items
				.map((item) => [clean(item.label), clean(resolve(item.value, data))] as const)
				.filter(([, value]) => value)
				.map(([label, value]) => `${theme.fg("muted", label.padEnd(9))}${value}`)
		case "list":
			return c.children.flatMap((id) => {
				const child = byId.get(id)
				return child && child.type !== "list" ? component(theme, surface, child, byId) : []
			})
	}
}

function verdict(theme: Theme, surface: SideSurface): string {
	const v = surface.verdict
	if (!v) return ""
	const by = v.source === "d3" ? `d3 ${(v.confidence ?? 0).toFixed(2)}` : "rule"
	return theme.fg("dim", `${v.attention} · ${by}`)
}

function card(theme: Theme, f: Frame, surface: SideSurface, index: number, dim: boolean): string[] {
	if (dim) return [f.row(theme.fg("dim", stripTerminalSequences(chip(theme, surface, index))))]
	const byId = new Map(surface.components.map((c) => [c.id, c]))
	const root = byId.get("root") ?? surface.components[0]
	const tone = resolve(surface.tone, surface.data)
	const lines = [f.row(`${chip(theme, surface, index)}  ${verdict(theme, surface)}`)]
	for (const text of root ? component(theme, surface, root, byId) : []) lines.push(f.row(`   ${text}`))
	if (surface.link) lines.push(f.row(`   ${link(surface.link, theme.fg(toneColor(tone), clean(surface.link)))}`))
	return lines
}

/** The expanded pane: focused cards in full, parked ones dimmed, then what the side loop has cost. */
export function renderPane(
	theme: Theme,
	focused: readonly SideSurface[],
	parked: readonly SideSurface[],
	width: number,
	stats: SideLoopStats,
	maxRows: number,
	stage: StageView,
): string[] {
	const f = frame(theme, width, false)
	const lines = [f.top("in-time · side loop", `stage: ${stageLabel(stage)}`)]
	if (!focused.length && !parked.length)
		lines.push(f.row(theme.fg("muted", "Nothing yet. Cards appear as the session produces things.")))
	for (const [i, surface] of focused.entries()) lines.push(...card(theme, f, surface, i, false), f.row(""))
	if (parked.length) {
		lines.push(f.row(theme.fg("muted", `parked — not relevant while ${stage.stage}`)))
		for (const [i, surface] of parked.entries()) lines.push(...card(theme, f, surface, focused.length + i, true))
	}
	const statRows = formatStats(stats)
	const room = Math.max(1, maxRows - statRows.length - 4)
	if (lines.length > room) lines.splice(room, lines.length, f.row(theme.fg("dim", "… /side clear to dismiss")))
	lines.push(f.row(theme.fg("borderMuted", "─".repeat(f.inner))))
	lines.push(f.row(theme.bold("cost of this side loop")))
	for (const row of statRows) lines.push(f.row(theme.fg("muted", row)))
	lines.push(f.bottom("/side open <n> · /side · /side stats"))
	return lines
}
