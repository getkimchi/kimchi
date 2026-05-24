import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import { LogoHeader } from "../../../components/logo.js"

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

export function createTeleportProgress(ui: ExtensionUIContext) {
	const steps: ProgressStep[] = []
	let headerTui: { requestRender(): void } | undefined
	let finished = false
	let sessionInfo: SessionInfo | undefined

	let phaseIdx = 0
	let phaseFrameIdx = 0
	let phaseSpinId: ReturnType<typeof setInterval> | undefined
	let stepSpinIdx = 0

	function currentPhase(): FunPhase {
		return TELEPORT_FUN_PHASES[phaseIdx]
	}

	function renderProgress(theme: { fg(color: string, text: string): string }, width: number): string[] {
		const lines: string[] = []
		const dim = (t: string) => theme.fg("dim", t)
		const trunc = (line: string) => truncateToWidth(line, width)

		if (finished) {
			lines.push(trunc(`${theme.fg("success", "✓")} ${theme.fg("success", "Teleported")}`))
		} else {
			const p = currentPhase()
			const char = p.frames[phaseFrameIdx % p.frames.length]
			lines.push(trunc(`${theme.fg("accent", char)} ${theme.fg("accent", p.message)}`))
		}

		for (const s of steps) {
			if (s.done) {
				lines.push(trunc(`  ${theme.fg("success", "✓")} ${dim(s.label)}`))
			} else {
				const frame = SPIN_FRAMES[stepSpinIdx]
				lines.push(trunc(`  ${theme.fg("accent", frame)} ${s.label}`))
			}
		}

		if (finished && sessionInfo) {
			lines.push("")
			const labelW = 4
			const pad = (l: string) => l.padEnd(labelW)
			lines.push(trunc(`  ${dim("┌")} ${theme.fg("success", sessionInfo.description)}`))
			lines.push(trunc(`  ${dim("│")} ${dim(pad("id"))} ${sessionInfo.id}`))
			lines.push(trunc(`  ${dim("└")} ${dim(pad("url"))} ${sessionInfo.url}`))
		}

		return lines
	}

	function setTeleportHeader() {
		ui.setHeader((_tui, theme) => {
			const logo = new LogoHeader(theme)
			return {
				invalidate() {
					logo.invalidate()
					headerTui = undefined
				},
				render(width: number) {
					headerTui = _tui
					const lines = logo.render(width)
					lines.push(...renderProgress(theme, width))
					lines.push("")
					return lines
				},
			}
		})
	}

	function restartPhaseSpin() {
		if (phaseSpinId) clearInterval(phaseSpinId)
		phaseSpinId = setInterval(() => {
			phaseFrameIdx++
			headerTui?.requestRender()
		}, currentPhase().intervalMs)
	}

	setTeleportHeader()
	restartPhaseSpin()

	const stepSpinId = setInterval(() => {
		stepSpinIdx = (stepSpinIdx + 1) % SPIN_FRAMES.length
		headerTui?.requestRender()
	}, SPIN_MS)

	const phaseCycleId = setInterval(() => {
		phaseIdx = (phaseIdx + 1) % TELEPORT_FUN_PHASES.length
		phaseFrameIdx = 0
		restartPhaseSpin()
		headerTui?.requestRender()
	}, PHASE_CYCLE_MS)

	const unsubInput = ui.onTerminalInput((data) => {
		if (data === "\x03" || data === "\x04") return undefined
		return { consume: true }
	})

	ui.setWidget(
		"teleport-lock",
		(_tui, theme) => ({
			render: (width: number) => [truncateToWidth(theme.fg("dim", "🔒 Input sealed - in transit…"), width)],
			invalidate: () => {},
		}),
		{ placement: "aboveEditor" },
	)

	function stopTimers() {
		if (phaseSpinId) clearInterval(phaseSpinId)
		clearInterval(stepSpinId)
		clearInterval(phaseCycleId)
	}

	return {
		step(label: string) {
			steps.push({ label, done: false })
			headerTui?.requestRender()
		},
		complete(doneLabel?: string) {
			const cur = steps.at(-1)
			if (cur) {
				cur.done = true
				if (doneLabel) cur.label = doneLabel
			}
			headerTui?.requestRender()
		},
		finish(info: SessionInfo) {
			const cur = steps.at(-1)
			if (cur) cur.done = true
			finished = true
			sessionInfo = info
			stopTimers()
			unsubInput()
			ui.setWidget("teleport-lock", undefined)
			setTeleportHeader()
		},
		stop() {
			if (finished) return
			stopTimers()
			unsubInput()
			ui.setWidget("teleport-lock", undefined)
			ui.setHeader((_tui, theme) => new LogoHeader(theme))
		},
	}
}
