// Braille spinner — used by per-tool block icons (subagent, etc.)
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const BRAILLE_INTERVAL_MS = 80

export interface SpinnerState {
	spinnerIdx: number
	spinnerInterval: ReturnType<typeof setInterval> | undefined
}

export function tickSpinner(state: SpinnerState, invalidate: () => void): void {
	if (!state.spinnerInterval) {
		state.spinnerIdx = 0
		state.spinnerInterval = setInterval(() => {
			state.spinnerIdx = (state.spinnerIdx + 1) % BRAILLE_FRAMES.length
			invalidate()
		}, BRAILLE_INTERVAL_MS)
	}
}

export function clearSpinner(state: SpinnerState): void {
	if (state.spinnerInterval) {
		clearInterval(state.spinnerInterval)
		state.spinnerInterval = undefined
	}
}

export function spinnerFrame(state: SpinnerState): string {
	return BRAILLE_FRAMES[state.spinnerIdx ?? 0]
}

// Cooking animator — drives the global working indicator in the status bar
const COOKING_FRAMES: readonly {
	readonly frames: readonly string[]
	readonly message: string
	readonly intervalMs: number
}[] = [
	{ frames: ["|", "/", "-", "\\"], message: "Stirring", intervalMs: 140 },
	{ frames: ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"], message: "Marinating", intervalMs: 80 },
	{ frames: ["|", "/", "-", "\\"], message: "Chopping", intervalMs: 140 },
	{ frames: ["◐", "◓", "◑", "◒"], message: "Mixing the gochugaru", intervalMs: 140 },
	{ frames: ["·", "+", "·", "×", "·", "+"], message: "Salting the cabbage", intervalMs: 93 },
	{ frames: ["|", "/", "-", "\\"], message: "Grinding spices", intervalMs: 140 },
	{ frames: ["_", "-", "_", "-"], message: "Packing the jar", intervalMs: 140 },
	{ frames: ["|", "/", "-", "\\"], message: "Massaging the leaves", intervalMs: 140 },
	{
		frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
		message: "Reducing",
		intervalMs: 40,
	},
	{ frames: ["✦", "✧", "✦", "✧"], message: "Prepping aromatics", intervalMs: 140 },
	{ frames: ["·", "+", "·", "×", "·", "+"], message: "Simmering", intervalMs: 93 },
	{ frames: ["░", "▒", "▓", "█", "▓", "▒", "░"], message: "Fermenting", intervalMs: 80 },
	{ frames: ["·", "+", "·", "×", "·", "+"], message: "Seasoning", intervalMs: 93 },
	{ frames: ["ˊ", "`", "ˊ", "`"], message: "Tasting", intervalMs: 100 },
	{ frames: ["z", "Z", "z", "Z"], message: "Letting it rest", intervalMs: 140 },
	{ frames: ["~", "-", "~", "-"], message: "Rinsing", intervalMs: 140 },
	{ frames: ["•", "·", "•", "·"], message: "Building the brine", intervalMs: 140 },
	{ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], message: "Cooking", intervalMs: 56 },
	{ frames: ["~", "-", "~", "-"], message: "Braising", intervalMs: 140 },
	{ frames: ["⊙", "⊚", "⊙", "⊚"], message: "Tossing everything together", intervalMs: 140 },
]

const DOT_STATES = ["", ".", "..", "..."] as const

const DOT_CYCLE_MS = 500
const MESSAGE_CYCLE_MS = 6000

let _resumeFrameIdx = 0

export function createWorkingAnimator(onUpdate: (char: string, message: string) => void): () => void {
	let frameIdx = _resumeFrameIdx
	let spinIdx = 0
	let dotIdx = 0
	let spinId: ReturnType<typeof setInterval> | undefined

	function render() {
		const f = COOKING_FRAMES[frameIdx]
		onUpdate(f.frames[spinIdx], f.message + DOT_STATES[dotIdx])
	}

	function restartSpin() {
		if (spinId) clearInterval(spinId)
		const interval = COOKING_FRAMES[frameIdx].intervalMs
		spinId = setInterval(() => {
			const f = COOKING_FRAMES[frameIdx]
			spinIdx = (spinIdx + 1) % f.frames.length
			onUpdate(f.frames[spinIdx], f.message + DOT_STATES[dotIdx])
		}, interval)
	}

	const initId = setTimeout(() => {
		render()
		restartSpin()
	}, 0)

	const dotId = setInterval(() => {
		dotIdx = (dotIdx + 1) % DOT_STATES.length
		render()
	}, DOT_CYCLE_MS)

	const msgId = setInterval(() => {
		frameIdx = (frameIdx + 1) % COOKING_FRAMES.length
		spinIdx = 0
		dotIdx = 0
		_resumeFrameIdx = frameIdx
		render()
		restartSpin()
	}, MESSAGE_CYCLE_MS)

	return () => {
		clearTimeout(initId)
		if (spinId) clearInterval(spinId)
		clearInterval(dotId)
		clearInterval(msgId)
		_resumeFrameIdx = (frameIdx + 1) % COOKING_FRAMES.length
	}
}
