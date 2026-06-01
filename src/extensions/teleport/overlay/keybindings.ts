import { Key, matchesKey } from "@earendil-works/pi-tui"

export type ChordAction =
	| { kind: "new-tab" }
	| { kind: "switch"; index: number }
	| { kind: "close-tab" }
	| { kind: "delete-session" }
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
		if (!this.waiting) {
			if (matchesKey(data, CHORD_PREFIX)) {
				this.waiting = true
				return "consumed"
			}
			return null
		}

		this.waiting = false

		if (matchesKey(data, "escape")) return { kind: "cancel" }
		if (matchesKey(data, "n")) return { kind: "new-tab" }
		if (matchesKey(data, "w")) return { kind: "close-tab" }
		if (matchesKey(data, "x")) return { kind: "delete-session" }

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
