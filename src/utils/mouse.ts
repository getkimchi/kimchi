/**
 * SGR mouse-mode helpers for the TUI.
 *
 * Enables modes 1000 (basic tracking), 1002 (motion while button held),
 * and 1006 (SGR coordinates).  When a button is pressed the terminal
 * reports position on every movement so the harness can implement
 * drag-to-select text copying.  Native terminal selection via Shift+drag
 * is no longer available once these modes are active.
 */

// ─── enable / disable ──────────────────────────────────────────────

export function enableMouseMode(): string {
	return "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
}

export function disableMouseMode(): string {
	return "\x1b[?1002l\x1b[?1000l\x1b[?1006l"
}

// ─── SGR event types ───────────────────────────────────────────────

export interface SgrMouseEvent {
	/** 0 = left, 1 = middle, 2 = right, 3 = released */
	button: number
	/** 1-based column (character position, not byte) */
	x: number
	/** 1-based row */
	y: number
	/** true = press, false = release */
	isPress: boolean
	/** modifier flags */
	shift: boolean
	meta: boolean
	ctrl: boolean
	/** Set when the terminal reports a motion event (bit 5 set, 32-35). */
	isMotion: boolean
	/** Set when the terminal reports a scroll-wheel event (64/65). */
	isScroll: boolean
}

// ─── parsing ───────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse escape sequence
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/

export function isMouseEvent(data: string): boolean {
	return SGR_MOUSE_RE.test(data)
}

export function parseSgrMouse(data: string): SgrMouseEvent | null {
	const m = SGR_MOUSE_RE.exec(data)
	if (!m) return null

	const raw = Number(m[1])
	const isPress = m[4] === "M"
	const x = Number(m[2])
	const y = Number(m[3])

	// In SGR mode button encoding is a bit-field:
	//   bits 0-1:  0=left, 1=middle, 2=right, 3=released
	//   bit 2:     shift
	//   bit 3:     meta/alt
	//   bit 4:     ctrl
	//   bit 5 (32): motion event
	//   64/65:     scroll up/down
	const isMotion = (raw & 32) !== 0
	const isScroll = raw >= 64 && raw <= 65
	const buttonBits = raw & 3
	const shift = (raw & 4) !== 0
	const meta = (raw & 8) !== 0
	const ctrl = (raw & 16) !== 0

	return {
		button: buttonBits === 3 ? 3 : buttonBits,
		x,
		y,
		isPress,
		shift,
		meta,
		ctrl,
		isMotion,
		isScroll,
	}
}

// ─── click-vs-drag ─────────────────────────────────────────────────

export interface ClickDetectorState {
	lastPressX: number
	lastPressY: number
	lastPressButton: number
	lastPressTime: number
	/**
	 * If the user moved the mouse *between* press and release we
	 * never treat the pair as a click.  We keep this as a simple
	 * boolean because mode-1000 does not deliver motion events;
	 * if a future change enables mode-1002 this is the hook to
	 * upgrade.
	 */
	sawMotion: boolean
}

export function createClickDetector(): ClickDetectorState {
	return {
		lastPressX: 0,
		lastPressY: 0,
		lastPressButton: 0,
		lastPressTime: 0,
		sawMotion: false,
	}
}

const CLICK_THRESHOLD_MS = 500
const CLICK_DRAG_THRESHOLD = 2

export function onMouseDown(state: ClickDetectorState, event: SgrMouseEvent): ClickDetectorState {
	return {
		...state,
		lastPressX: event.x,
		lastPressY: event.y,
		lastPressButton: event.button,
		lastPressTime: Date.now(),
		sawMotion: false,
	}
}

export function onMouseMotion(state: ClickDetectorState, event: SgrMouseEvent): ClickDetectorState {
	if (!state.sawMotion) {
		const dx = Math.abs(event.x - state.lastPressX)
		const dy = Math.abs(event.y - state.lastPressY)
		if (dx <= CLICK_DRAG_THRESHOLD && dy <= CLICK_DRAG_THRESHOLD) {
			return state
		}
	}
	return { ...state, sawMotion: true }
}

export function onMouseUp(
	state: ClickDetectorState,
	event: SgrMouseEvent,
): { isClick: boolean; click?: SgrMouseEvent } {
	const dt = Date.now() - state.lastPressTime
	const dx = event.x - state.lastPressX
	const dy = event.y - state.lastPressY

	// Some terminals send button=3 (all buttons released) on mouse-up (e.g.
	// older xterm builds). Treat that as matching a prior left-button press.
	const sameButton = event.button === state.lastPressButton || (event.button === 3 && state.lastPressButton === 0)
	const inTime = dt <= CLICK_THRESHOLD_MS
	const inPlace = Math.abs(dx) <= CLICK_DRAG_THRESHOLD && Math.abs(dy) <= CLICK_DRAG_THRESHOLD
	const noMotion = !state.sawMotion

	if (sameButton && inTime && inPlace && noMotion) {
		return { isClick: true, click: event }
	}
	return { isClick: false }
}
