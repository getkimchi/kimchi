import { Key, isKeyRelease, matchesKey } from "@earendil-works/pi-tui"

export type ChordAction =
	| { kind: "next-tab" }
	| { kind: "prev-tab" }
	| { kind: "switch"; index: number }
	| { kind: "cancel" }

/**
 * - An action object: chord completed, dispatch the action.
 * - `"consumed"`: input was absorbed (prefix press, or unknown operand following the prefix);
 *   do not forward to the active tab.
 * - `null`: input was not chord-related; forward to the active tab.
 */
export type ChordResult = ChordAction | "consumed" | null

const CHORD_PREFIX = Key.ctrl("b")

export class ChordParser {
	private waiting = false

	process(data: string): ChordResult {
		// Key releases reach us because the overlay sets wantsKeyRelease=true on
		// its Component (so the PTY can see them). They must not drive chord
		// state transitions — otherwise the release event for Ctrl+B would
		// satisfy the "waiting for operand" branch, swallow itself as an unknown
		// operand, and reset us to idle before the actual operand keypress
		// arrives.
		if (isKeyRelease(data)) return null

		if (!this.waiting) {
			if (matchesKey(data, CHORD_PREFIX)) {
				this.waiting = true
				return "consumed"
			}
			return null
		}

		this.waiting = false

		if (matchesKey(data, "escape")) return { kind: "cancel" }
		if (matchesKey(data, "n")) return { kind: "next-tab" }
		if (matchesKey(data, "p")) return { kind: "prev-tab" }

		const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const
		for (let i = 0; i < digits.length; i++) {
			if (matchesKey(data, digits[i])) {
				return { kind: "switch", index: i }
			}
		}

		// Unknown operand: swallow silently so it doesn't leak into the active
		// tab's shell. The chord state resets — the user must press the prefix
		// again to start a new chord.
		return "consumed"
	}

	get isWaiting(): boolean {
		return this.waiting
	}

	reset(): void {
		this.waiting = false
	}
}
