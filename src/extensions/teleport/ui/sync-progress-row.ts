import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"

export interface SyncProgressState {
	spinnerFrame: string
	phase: string
	suffix: string
}

/**
 * Single-line widget mounted above the editor while `/sync` runs. Reads
 * its state through a getter closure so the widget instance is created
 * once (in the setWidget factory) and re-rendered as the controller
 * advances the spinner and phase text.
 */
export class SyncProgressRow {
	constructor(
		private readonly getState: () => SyncProgressState,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const { spinnerFrame, phase, suffix } = this.getState()
		if (!phase) return []
		const line = `${this.theme.fg("accent", spinnerFrame)} ${this.theme.fg("muted", `${phase}${suffix}`)}`
		return [truncateToWidth(line, width, this.theme.fg("dim", "..."))]
	}

	invalidate(): void {}
}
