import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent"
import { type Component, truncateToWidth } from "@earendil-works/pi-tui"
import { GitTokenPromptComponent, type GitTokenPromptResult } from "./git-token-prompt.js"

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPIN_MS = 80

interface FunPhase {
	readonly frames: readonly string[]
	readonly message: string
	readonly intervalMs: number
}

const TELEPORT_FUN_PHASES: readonly FunPhase[] = [
	{ frames: ["|", "/", "-", "\\"], message: "Packing the jar", intervalMs: 140 },
	{ frames: ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"], message: "Sealing the jar for transit", intervalMs: 80 },
	{ frames: ["·", "+", "·", "×", "·", "+"], message: "Loading the cart", intervalMs: 93 },
	{ frames: ["◐", "◓", "◑", "◒"], message: "Spinning up the kitchen", intervalMs: 140 },
	{ frames: ["~", "-", "~", "-"], message: "Riding the conveyor", intervalMs: 140 },
	{ frames: ["◐", "◓", "◑", "◒"], message: "Unpacking at the remote kitchen", intervalMs: 140 },
]

const PHASE_CYCLE_MS = 4_000

interface ProgressStep {
	label: string
	done: boolean
}

export interface SessionInfo {
	id: string
	url: string
	description: string
}

interface PanelTui {
	requestRender(force?: boolean): void
}

class TeleportProgressPanel implements Component {
	private readonly steps: ProgressStep[] = []
	private finished = false
	private sessionInfo: SessionInfo | undefined

	private phaseIdx = 0
	private phaseFrameIdx = 0
	private stepSpinIdx = 0

	private phaseSpinId: ReturnType<typeof setInterval> | undefined
	private stepSpinId: ReturnType<typeof setInterval> | undefined
	private phaseCycleId: ReturnType<typeof setInterval> | undefined

	private mode: "progress" | "git-token" = "progress"
	private gitTokenPrompt: GitTokenPromptComponent | undefined
	private gitTokenResolver: ((result: GitTokenPromptResult) => void) | undefined

	constructor(
		private readonly tui: PanelTui,
		private readonly theme: Theme,
	) {}

	start(): void {
		this.restartPhaseSpin()
		this.stepSpinId = setInterval(() => {
			this.stepSpinIdx = (this.stepSpinIdx + 1) % SPIN_FRAMES.length
			this.tui.requestRender()
		}, SPIN_MS)
		this.phaseCycleId = setInterval(() => {
			this.phaseIdx = (this.phaseIdx + 1) % TELEPORT_FUN_PHASES.length
			this.phaseFrameIdx = 0
			this.restartPhaseSpin()
			this.tui.requestRender()
		}, PHASE_CYCLE_MS)
	}

	stopTimers(): void {
		if (this.phaseSpinId) clearInterval(this.phaseSpinId)
		if (this.stepSpinId) clearInterval(this.stepSpinId)
		if (this.phaseCycleId) clearInterval(this.phaseCycleId)
		this.phaseSpinId = undefined
		this.stepSpinId = undefined
		this.phaseCycleId = undefined
	}

	private restartPhaseSpin(): void {
		if (this.phaseSpinId) clearInterval(this.phaseSpinId)
		this.phaseSpinId = setInterval(() => {
			this.phaseFrameIdx++
			this.tui.requestRender()
		}, this.currentPhase().intervalMs)
	}

	private currentPhase(): FunPhase {
		return TELEPORT_FUN_PHASES[this.phaseIdx]
	}

	appendStep(label: string): void {
		this.steps.push({ label, done: false })
		this.tui.requestRender()
	}

	completeStep(doneLabel?: string): void {
		const cur = this.steps.at(-1)
		if (cur) {
			cur.done = true
			if (doneLabel) cur.label = doneLabel
		}
		this.tui.requestRender()
	}

	setFinished(info: SessionInfo): void {
		const cur = this.steps.at(-1)
		if (cur) cur.done = true
		this.finished = true
		this.sessionInfo = info
		this.tui.requestRender()
	}

	enterGitTokenMode(host: string, resolve: (result: GitTokenPromptResult) => void): void {
		this.mode = "git-token"
		this.gitTokenResolver = resolve
		this.gitTokenPrompt = new GitTokenPromptComponent(
			this.theme,
			host,
			(result) => {
				const r = this.gitTokenResolver
				this.gitTokenResolver = undefined
				this.gitTokenPrompt = undefined
				this.mode = "progress"
				this.tui.requestRender()
				r?.(result)
			},
			() => this.tui.requestRender(),
		)
		this.tui.requestRender()
	}

	forceCloseGitTokenMode(): void {
		if (this.mode !== "git-token") return
		const r = this.gitTokenResolver
		this.gitTokenResolver = undefined
		this.gitTokenPrompt = undefined
		this.mode = "progress"
		r?.({ outcome: "skipped" })
	}

	handleInput(data: string): void {
		if (this.mode === "git-token" && this.gitTokenPrompt) {
			this.gitTokenPrompt.handleInput(data)
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.stopTimers()
	}

	render(width: number): string[] {
		const { theme } = this
		const b = (s: string) => theme.fg("border", s)
		const dim = (s: string) => theme.fg("dim", s)
		const innerW = Math.max(20, width - 2)
		const contentW = innerW - 2

		const lines: string[] = []

		const titleText = " Teleport "
		const borderLen = Math.max(0, innerW - titleText.length)
		const leftB = Math.floor(borderLen / 2)
		const rightB = borderLen - leftB
		lines.push(`${b(`╭${"─".repeat(leftB)}`)}${dim(titleText)}${b(`${"─".repeat(rightB)}╮`)}`)

		const ansiRow = (content: string, rawLen: number) =>
			`${b("│")} ${content}${" ".repeat(Math.max(0, contentW - rawLen))} ${b("│")}`
		const emptyRow = () => `${b("│")}${" ".repeat(innerW)}${b("│")}`
		const trunc = (line: string) => truncateToWidth(line, contentW, "")
		const visibleLen = (s: string): number => {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
			return s.replace(/\x1b\[[0-9;]*m/g, "").length
		}
		const pushBody = (content: string) => {
			const truncated = trunc(content)
			lines.push(ansiRow(truncated, visibleLen(truncated)))
		}

		lines.push(emptyRow())

		// Progress header line + steps
		const progressLines = this.renderProgressLines(theme)
		for (const line of progressLines) pushBody(line)

		if (this.mode === "git-token" && this.gitTokenPrompt) {
			lines.push(emptyRow())
			lines.push(ansiRow(dim("─".repeat(contentW)), contentW))
			const promptLines = this.gitTokenPrompt.render(contentW)
			for (const line of promptLines) pushBody(line)
		} else if (!this.finished) {
			lines.push(emptyRow())
			const hint = "Teleporting in progress — input disabled"
			pushBody(dim(hint))
		}

		lines.push(emptyRow())
		lines.push(b(`╰${"─".repeat(innerW)}╯`))

		return lines
	}

	private renderProgressLines(theme: Theme): string[] {
		const lines: string[] = []
		const dim = (t: string) => theme.fg("dim", t)

		if (this.finished) {
			lines.push(`${theme.fg("success", "✓")} ${theme.fg("success", "Teleported")}`)
		} else {
			const p = this.currentPhase()
			const char = p.frames[this.phaseFrameIdx % p.frames.length]
			lines.push(`${theme.fg("accent", char)} ${theme.fg("accent", p.message)}`)
		}

		for (const s of this.steps) {
			if (s.done) {
				lines.push(`  ${theme.fg("success", "✓")} ${dim(s.label)}`)
			} else {
				const frame = SPIN_FRAMES[this.stepSpinIdx]
				lines.push(`  ${theme.fg("accent", frame)} ${s.label}`)
			}
		}

		if (this.finished && this.sessionInfo) {
			lines.push("")
			const labelW = 4
			const pad = (l: string) => l.padEnd(labelW)
			lines.push(`  ${dim("┌")} ${theme.fg("success", this.sessionInfo.description)}`)
			lines.push(`  ${dim("│")} ${dim(pad("id"))} ${this.sessionInfo.id}`)
			lines.push(`  ${dim("└")} ${dim(pad("url"))} ${this.sessionInfo.url}`)
		}

		return lines
	}
}

export interface TeleportProgress {
	step(label: string): void
	complete(doneLabel?: string): void
	finish(info: SessionInfo): void
	stop(): void
	promptGitToken(host: string): Promise<GitTokenPromptResult>
}

export function createTeleportProgress(ui: ExtensionUIContext): TeleportProgress {
	let panel: TeleportProgressPanel | undefined
	let resolveDone: (() => void) | undefined
	let closed = false
	const pending: Array<(p: TeleportProgressPanel) => void> = []

	const withPanel = (fn: (p: TeleportProgressPanel) => void) => {
		if (panel) fn(panel)
		else pending.push(fn)
	}

	ui.custom<void>(
		(tui, theme, _kb, done) => {
			resolveDone = () => done(undefined)
			panel = new TeleportProgressPanel(tui, theme)
			panel.start()
			for (const fn of pending) fn(panel)
			pending.length = 0
			return panel
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" } },
	).catch(() => {})

	const closeOnce = () => {
		if (closed) return
		closed = true
		panel?.stopTimers()
		resolveDone?.()
	}

	return {
		step(label) {
			withPanel((p) => p.appendStep(label))
		},
		complete(doneLabel) {
			withPanel((p) => p.completeStep(doneLabel))
		},
		finish(info) {
			withPanel((p) => p.setFinished(info))
			closeOnce()
		},
		stop() {
			panel?.forceCloseGitTokenMode()
			closeOnce()
		},
		promptGitToken(host) {
			if (closed) return Promise.resolve<GitTokenPromptResult>({ outcome: "skipped" })
			return new Promise<GitTokenPromptResult>((resolve) => {
				withPanel((p) => p.enterGitTokenMode(host, resolve))
			})
		},
	}
}
