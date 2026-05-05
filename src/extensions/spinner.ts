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
interface SpinnerFrame {
	char: string
	message: string
}

const COOKING_FRAMES: SpinnerFrame[] = [
	{ char: "\\", message: "Stirring" },
	{ char: "o", message: "Marinating" },
	{ char: "/", message: "Chopping" },
	{ char: "●", message: "Mixing the gochugaru" },
	{ char: "·", message: "Salting the cabbage" },
	{ char: "/", message: "Grinding spices" },
	{ char: "_", message: "Packing the jar" },
	{ char: "/", message: "Massaging the leaves" },
	{ char: "=", message: "Reducing" },
	{ char: "+", message: "Prepping aromatics" },
	{ char: "·", message: "Simmering" },
	{ char: "⠒", message: "Fermenting" },
	{ char: "·", message: "Seasoning" },
	{ char: "ˊ", message: "Tasting" },
	{ char: "z", message: "Letting it rest" },
	{ char: "~", message: "Rinsing" },
	{ char: "•", message: "Building the brine" },
	{ char: "¨", message: "Cooking" },
	{ char: "~", message: "Braising" },
	{ char: "⊙", message: "Tossing everything together" },
]

const CHAR_INTERVAL_MS = 40
const DOT_COUNT = 3
const HOLD_TICKS = 30

export function createWorkingAnimator(onUpdate: (char: string, message: string) => void): () => void {
	let frameIdx = 0
	let tickOffset = 0
	const id = setInterval(() => {
		const frame = COOKING_FRAMES[frameIdx]
		tickOffset++
		if (tickOffset > frame.message.length + DOT_COUNT + HOLD_TICKS) {
			frameIdx = (frameIdx + 1) % COOKING_FRAMES.length
			tickOffset = 0
		}
		const msg = frame.message
		const partial =
			tickOffset <= msg.length
				? msg.slice(0, tickOffset)
				: msg + ".".repeat(Math.min(tickOffset - msg.length, DOT_COUNT))
		onUpdate(frame.char, partial)
	}, CHAR_INTERVAL_MS)
	return () => clearInterval(id)
}
