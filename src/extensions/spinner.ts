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
const COOKING_FRAMES = [
	{ frames: ["|", "/", "-", "\\"], message: "Stirring" },
	{ frames: ["○", "◔", "◑", "◕", "●", "◕", "◑", "◔"], message: "Marinating" },
	{ frames: ["|", "/", "-", "\\"], message: "Chopping" },
	{ frames: ["◐", "◓", "◑", "◒"], message: "Mixing the gochugaru" },
	{ frames: ["·", "+", "·", "×", "·", "+"], message: "Salting the cabbage" },
	{ frames: ["|", "/", "-", "\\"], message: "Grinding spices" },
	{ frames: ["_", "-", "_", "-"], message: "Packing the jar" },
	{ frames: ["|", "/", "-", "\\"], message: "Massaging the leaves" },
	{ frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"], message: "Reducing" },
	{ frames: ["✦", "✧", "✦", "✧"], message: "Prepping aromatics" },
	{ frames: ["·", "+", "·", "×", "·", "+"], message: "Simmering" },
	{ frames: ["░", "▒", "▓", "█", "▓", "▒", "░"], message: "Fermenting" },
	{ frames: ["·", "+", "·", "×", "·", "+"], message: "Seasoning" },
	{ frames: ["ˊ", "`", "ˊ", "`"], message: "Tasting" },
	{ frames: ["z", "Z", "z", "Z"], message: "Letting it rest" },
	{ frames: ["~", "-", "~", "-"], message: "Rinsing" },
	{ frames: ["•", "·", "•", "·"], message: "Building the brine" },
	{ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], message: "Cooking" },
	{ frames: ["~", "-", "~", "-"], message: "Braising" },
	{ frames: ["⊙", "⊚", "⊙", "⊚"], message: "Tossing everything together" },
] as const

const DOT_STATES = ["", ".", "..", "..."] as const

const SPIN_MS = 80
const DOT_CYCLE_MS = 500
const MESSAGE_CYCLE_MS = 1400

let _resumeFrameIdx = 0

export function createWorkingAnimator(onUpdate: (char: string, message: string) => void): () => void {
	let frameIdx = _resumeFrameIdx
	let spinIdx = 0
	let dotIdx = 0
	const frame = COOKING_FRAMES[frameIdx]

	const initId = setTimeout(() => {
		onUpdate(frame.frames[spinIdx], frame.message + DOT_STATES[dotIdx])
	}, 0)

	const spinId = setInterval(() => {
		const f = COOKING_FRAMES[frameIdx]
		spinIdx = (spinIdx + 1) % f.frames.length
		onUpdate(f.frames[spinIdx], f.message + DOT_STATES[dotIdx])
	}, SPIN_MS)

	const dotId = setInterval(() => {
		dotIdx = (dotIdx + 1) % DOT_STATES.length
		const f = COOKING_FRAMES[frameIdx]
		onUpdate(f.frames[spinIdx], f.message + DOT_STATES[dotIdx])
	}, DOT_CYCLE_MS)

	const msgId = setInterval(() => {
		frameIdx = (frameIdx + 1) % COOKING_FRAMES.length
		spinIdx = 0
		dotIdx = 0
		_resumeFrameIdx = frameIdx
		const f = COOKING_FRAMES[frameIdx]
		onUpdate(f.frames[spinIdx], f.message + DOT_STATES[dotIdx])
	}, MESSAGE_CYCLE_MS)

	return () => {
		clearTimeout(initId)
		clearInterval(spinId)
		clearInterval(dotId)
		clearInterval(msgId)
		_resumeFrameIdx = (frameIdx + 1) % COOKING_FRAMES.length
	}
}
