import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { Container, Key, matchesKey } from "@earendil-works/pi-tui"
import type { FeedbackSentiment } from "./dialog.js"
import { createDialogChrome } from "./dialog-chrome.js"

/**
 * Sentiment picker shown on Ctrl+R in terminals without the Kitty keyboard
 * protocol (see `usesLegacyRatingPrompt`). Those terminals can't send
 * Ctrl+<digit>, so instead of two dedicated shortcuts they get a single key
 * that opens this picker; choosing Good/Bad drops into the existing details
 * dialog (`showFeedbackDetailsDialog`) for the picked sentiment.
 *
 * Returns the picked sentiment, or `undefined` when the user pressed Esc.
 */
export async function showRatingSelectorDialog(ctx: ExtensionContext): Promise<FeedbackSentiment | undefined> {
	return ctx.ui.custom<FeedbackSentiment | undefined>(
		(_tui, theme, _keybindings, done) => new RatingSelectorComponent(theme, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "60%", maxHeight: "80%" },
		},
	)
}

type RatingOption = { label: string; sentiment: FeedbackSentiment }

const OPTIONS: RatingOption[] = [
	{ label: "Good", sentiment: "positive" },
	{ label: "Bad", sentiment: "negative" },
]

export class RatingSelectorComponent extends Container {
	private readonly theme: Theme
	private readonly done: (result: FeedbackSentiment | undefined) => void
	/** Focused option index — starts on "Good". */
	private focusIndex = 0

	constructor(theme: Theme, done: (result: FeedbackSentiment | undefined) => void) {
		super()
		this.theme = theme
		this.done = done
	}

	override render(width: number): string[] {
		const { emptyRow, contentRow, topBorder, bottomBorder } = createDialogChrome(this.theme, width)

		const promptPlain = "How would you rate this response?"
		const hintPlain = `[Enter] Continue  [↑↓] Select  [Esc] Cancel`

		const lines: string[] = [
			topBorder("Rate response"),
			emptyRow,
			contentRow(this.theme.fg("text", promptPlain), promptPlain),
			emptyRow,
			...OPTIONS.map((option, i) => {
				if (i === this.focusIndex) {
					const label = `${this.theme.fg("accent", "→ ")}${this.theme.bold(this.theme.fg("accent", option.label))}`
					return contentRow(label, option.label.length + 2)
				}
				return contentRow(`  ${option.label}`, option.label.length + 2)
			}),
		]

		lines.push(emptyRow, contentRow(this.theme.fg("dim", hintPlain), hintPlain), emptyRow, bottomBorder)

		return lines
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined)
			return
		}
		if (matchesKey(data, Key.enter)) {
			this.done(OPTIONS[this.focusIndex].sentiment)
			return
		}
		if (matchesKey(data, Key.down)) {
			this.focusIndex = Math.min(OPTIONS.length - 1, this.focusIndex + 1)
			return
		}
		if (matchesKey(data, Key.up)) {
			this.focusIndex = Math.max(0, this.focusIndex - 1)
			return
		}
	}
}
