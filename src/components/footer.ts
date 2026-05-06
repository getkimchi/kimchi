import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { AssistantMessage } from "@mariozechner/pi-ai"
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent"
import type { Component } from "@mariozechner/pi-tui"
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui"
import { RST_FG, TEAL_FG, resolvedSemanticFg } from "../ansi.js"
import { formatCount } from "../extensions/format.js"
import { getMultiModelEnabled } from "../extensions/orchestration/prompt-enrichment.js"
import { getCurrentPermissionsMode } from "../extensions/permissions/index.js"
import { getActiveSubagentCount } from "../extensions/subagent.js"
import { getActiveTags, getCurrentPhase, parseTag } from "../extensions/tags.js"

interface FooterSegment {
	text: string
	width: number
}

const HARNESS_SETTINGS_PATH = join(homedir(), ".config", "kimchi", "harness", "settings.json")

export function readStatusLineCommand(): string | null {
	try {
		const raw = readFileSync(HARNESS_SETTINGS_PATH, "utf-8")
		const parsed = JSON.parse(raw)
		const cmd = parsed?.statusLine?.command
		if (typeof cmd !== "string" || cmd.length === 0) return null
		if (cmd.startsWith("~/")) return resolve(homedir(), cmd.slice(2))
		return cmd
	} catch {
		return null
	}
}

export function buildScriptPayload(
	ctx: ExtensionContext,
	status: "idle" | "generating",
	sessionStartMs: number,
	linesAdded: number,
	linesRemoved: number,
) {
	const usage = ctx.getContextUsage()

	let costUsd = 0
	let totalInput = 0
	let totalOutput = 0
	let lastTurn: { input: number; output: number } | null = null
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const u = (entry.message as AssistantMessage).usage
			costUsd += u.cost.total
			totalInput += u.input
			totalOutput += u.output
			lastTurn = { input: u.input, output: u.output }
		}
	}

	return {
		// kimchi fields
		model: { id: ctx.model?.id ?? null, name: ctx.model?.name ?? null },
		context: {
			used: usage?.tokens ?? null,
			limit: usage?.contextWindow ?? null,
			percent: usage?.percent ?? null,
		},
		workspace: { cwd: ctx.cwd, current_dir: ctx.cwd },
		status,
		session: {
			cost_usd: costUsd,
			last_turn: lastTurn,
			id: ctx.sessionManager.getSessionId(),
			name: ctx.sessionManager.getSessionName() ?? null,
			transcript_path: ctx.sessionManager.getSessionFile(),
		},
		// claude code compat fields
		cost: {
			total_cost_usd: costUsd,
			total_duration_ms: Date.now() - sessionStartMs,
			total_lines_added: linesAdded,
			total_lines_removed: linesRemoved,
		},
		context_window: {
			context_window_size: usage?.contextWindow ?? null,
			used_percentage: usage?.percent ?? null,
			remaining_percentage: usage?.percent != null ? 100 - usage.percent : null,
			current_usage: usage?.tokens != null ? { input_tokens: usage.tokens } : null,
			total_input_tokens: totalInput,
			total_output_tokens: totalOutput,
		},
		exceeds_200k_tokens: (usage?.tokens ?? 0) > 200_000,
		permissions: {
			mode: getCurrentPermissionsMode(),
		},
		multi_model: {
			enabled: getMultiModelEnabled(),
		},
	}
}

export class ScriptFooter implements Component {
	private cachedLines: string[] = []

	constructor(private getControlsLine: () => string | null) {}

	setLines(lines: string[]): void {
		this.cachedLines = lines
	}

	invalidate(): void {}

	render(width: number): string[] {
		const controls = this.getControlsLine()
		const scriptLines = this.cachedLines.map((line) => truncateToWidth(line, width))
		if (!controls) return scriptLines
		return [...scriptLines, "", truncateToWidth(controls, width)]
	}
}

const BAR_WIDTH = 16

function teal(text: string): string {
	return `${TEAL_FG}${text}${RST_FG}`
}

function seg(text: string): FooterSegment {
	return { text, width: visibleWidth(text) }
}

export class StatsFooter implements Component {
	constructor(
		private ctx: ExtensionContext,
		private theme: Theme,
		private _footerData: ReadonlyFooterDataProvider,
	) {}

	invalidate(): void {}

	// Use the "text" token (not "dim") so labels match the editor input/cwd chrome.
	private dim(s: string): string {
		return this.theme.fg("text", s)
	}

	private modelSegment(): FooterSegment {
		const modelId = this.ctx.model?.id ?? "n/a"
		return seg(teal(modelId))
	}

	private usageSegment(): FooterSegment | null {
		let totalInput = 0
		let totalOutput = 0
		for (const entry of this.ctx.sessionManager.getEntries()) {
			if (entry.type === "message") {
				const msg = entry.message
				if (msg?.role === "assistant" && msg.usage) {
					totalInput += msg.usage.input ?? 0
					totalOutput += msg.usage.output ?? 0
				}
			}
		}
		if (!totalInput && !totalOutput) return null
		const tokens = [totalInput ? `↑${formatCount(totalInput)}` : "", totalOutput ? `↓${formatCount(totalOutput)}` : ""]
			.filter(Boolean)
			.join(" ")
		return seg(this.dim(tokens))
	}

	private contextSegment(): FooterSegment {
		const contextUsage = this.ctx.getContextUsage()
		const pct = contextUsage?.percent ?? 0

		const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)))
		const fill = resolvedSemanticFg(this.theme, "success")
		const bar = `${fill}${"█".repeat(filled)}${RST_FG}${this.dim("░".repeat(BAR_WIDTH - filled))}`
		const pctColor = pct > 90 ? "error" : pct > 70 ? "warning" : undefined
		const pctStr = pctColor
			? `${resolvedSemanticFg(this.theme, pctColor)}${Math.round(pct)}%${RST_FG}`
			: teal(`${Math.round(pct)}%`)
		return seg(`${bar} ${pctStr} ${this.dim("ctx")}`)
	}

	private phaseSegment(): FooterSegment {
		const phase = getCurrentPhase() ?? "n/a"
		return seg(`${this.dim("phase:")}${teal(phase)}`)
	}

	private tagsSegment(parsed: Array<{ key: string; value: string }>): FooterSegment | null {
		const display = parsed.filter((t) => t.key !== "team" && t.key !== "phase")
		if (display.length === 0) return null
		const formatted = display.map((t) => this.dim(`${t.key}:${t.value}`)).join(this.dim(" "))
		return seg(`${this.dim("tags:")}${formatted}`)
	}

	private teamSegment(parsed: Array<{ key: string; value: string }>): FooterSegment | null {
		const team = parsed.find((t) => t.key === "team")
		if (!team) return null
		return seg(`${this.dim("team:")}${teal(team.value)}`)
	}

	private permissionsSegment(): FooterSegment | null {
		const mode = this._footerData.getExtensionStatuses().get("permissions-mode")
		if (!mode) return null
		return seg(mode)
	}

	private multiModelSegment(): FooterSegment {
		const enabled = getMultiModelEnabled()
		const label = enabled ? teal("on") : this.dim("off")
		const shortcut = process.platform === "darwin" ? "option+tab" : "alt+tab"
		return seg(`${this.dim("multi-model:")} ${label} ${this.dim(`→ ${shortcut}`)}`)
	}

	private subagentSegment(): FooterSegment | null {
		const count = getActiveSubagentCount()
		if (count === 0) return null
		return seg(teal(`${count} subagent${count === 1 ? "" : "s"}`))
	}

	private permissionsWarning(): FooterSegment | null {
		const text = this._footerData.getExtensionStatuses().get("permissions-warning")
		if (!text) return null
		return seg(this.theme.fg("warning", text))
	}

	private updateAvailableSegment(): FooterSegment | null {
		const text = this._footerData.getExtensionStatuses().get("update-available")
		if (!text) return null
		return seg(this.theme.fg("accent", text))
	}

	render(width: number): string[] {
		const tags = getActiveTags()
			.map(parseTag)
			.filter((t): t is { key: string; value: string } => t !== null)

		const segments = [
			this.permissionsSegment(),
			this.multiModelSegment(),
			this.modelSegment(),
			this.subagentSegment(),
			this.contextSegment(),
			this.usageSegment(),
			this.phaseSegment(),
			this.tagsSegment(tags),
			this.teamSegment(tags),
		].filter((s): s is FooterSegment => s !== null)

		const sep = ` ${this.dim("·")} `
		const left = segments.map((s) => s.text).join(sep)
		const leftWidth = visibleWidth(left)

		const hint = this.dim("/ for commands")
		const hintWidth = visibleWidth(hint)

		let line: string
		if (leftWidth + 2 + hintWidth <= width) {
			line = `${left}${" ".repeat(width - leftWidth - hintWidth)}${hint}`
		} else {
			line = truncateToWidth(left, width)
		}

		const infoLine = this.buildInfoLine(width)
		return infoLine ? [infoLine, line] : [line]
	}

	buildInfoLine(width: number): string {
		let line = ""
		const permissionsWarningSeg = this.permissionsWarning()
		const updateSeg = this.updateAvailableSegment()

		let remainingWidth = width
		if (permissionsWarningSeg) {
			line = truncateToWidth(permissionsWarningSeg.text, remainingWidth)
			remainingWidth -= visibleWidth(line)
		}

		if (updateSeg && remainingWidth >= updateSeg.width + 2) {
			line = `${line}${" ".repeat(remainingWidth - updateSeg.width)}${updateSeg.text}`
		}

		return line
	}
}
