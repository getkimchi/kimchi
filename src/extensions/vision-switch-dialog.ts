import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { Container, Key, matchesKey } from "@earendil-works/pi-tui"
import { createDialogChrome } from "./feedback/dialog-chrome.js"
import { humanizeContextWindow } from "./vision-support.js"

/** Outcome the gate acts on. `cancel` keeps every attachment source retained. */
export type VisionDialogResult = { kind: "switch"; model: Model<Api> } | { kind: "remove" } | { kind: "cancel" }

/** Checked result of an injected switch attempt. */
export interface VisionSwitchOutcome {
	ok: boolean
	error?: string
}

/** A switch candidate with the caller's compact badge already computed. */
export interface VisionSwitchCandidate {
	model: Model<Api>
	/** True when the current context exceeds this model's safe window (compaction needed before switching). */
	compactNeeded: boolean
}

export interface ShowVisionSwitchDialogOptions {
	/** Id of the text-only model the submission is gated on (shown in the header). */
	currentModelId: string
	/** Candidates are assembled and badged by the caller (Chunk 3 gate); recomputed per render so badges stay fresh. */
	getCandidates: () => VisionSwitchCandidate[]
	/** Invoked once when the dialog mounts; `close` resolves it as a cancel (session invalidation). */
	registerClose?: (close: () => void) => void
	/**
	 * Performs the checked switch for the selected model: fresh fit validation,
	 * optional confirmed compaction, `pi.setModel`, and live-model verification.
	 * `selection.compactConfirmed` reports whether this selection passed the
	 * compact two-step confirm. Resolves `{ ok: true }` only after the live model
	 * matches the selection and supports vision; `{ ok: false, error }` keeps the
	 * dialog open with an inline error.
	 */
	onSwitch: (model: Model<Api>, selection: { compactConfirmed: boolean }) => Promise<VisionSwitchOutcome>
}

const MAX_VISIBLE_CANDIDATES = 8
const SEARCH_PLACEHOLDER = "filter models…"

/**
 * Searchable vision-model switch dialog, patterned on the feedback
 * model-switch dialog and reusing its chrome. All effects (compaction,
 * model switch) are injected through `onSwitch`; the dialog only owns
 * rendering, filtering, the compact two-step confirm, and busy/error state.
 */
export async function showVisionSwitchDialog(
	ctx: ExtensionContext,
	options: ShowVisionSwitchDialogOptions,
): Promise<VisionDialogResult> {
	return ctx.ui.custom<VisionDialogResult>(
		(tui, theme, _keybindings, done) => new VisionSwitchComponent(tui, theme, options, done, options.registerClose),
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "40%" } },
	)
}

type DialogMode = "list" | "confirm" | "busy" | "error"

export class VisionSwitchComponent extends Container {
	private readonly theme: Theme
	private readonly options: ShowVisionSwitchDialogOptions
	private readonly done: (result: VisionDialogResult) => void

	private query = ""
	private selectedIndex = 0
	private mode: DialogMode = "list"
	private errorMessage: string | null = null
	private confirmCandidate: VisionSwitchCandidate | null = null

	constructor(
		_tui: TUI,
		theme: Theme,
		options: ShowVisionSwitchDialogOptions,
		done: (result: VisionDialogResult) => void,
		registerClose?: (close: () => void) => void,
	) {
		super()
		this.theme = theme
		this.options = options
		this.done = done
		registerClose?.(() => this.done({ kind: "cancel" }))
	}

	private get filteredCandidates(): VisionSwitchCandidate[] {
		const q = this.query.trim().toLowerCase()
		const candidates = this.options.getCandidates()
		if (!q) return candidates
		return candidates.filter((c) => c.model.id.toLowerCase().includes(q) || c.model.provider.toLowerCase().includes(q))
	}

	private requestRender(): void {
		this.invalidate()
	}

	private moveSelection(delta: number): void {
		const count = this.filteredCandidates.length
		if (count === 0) return
		this.selectedIndex = (this.selectedIndex + delta + count) % count
		this.requestRender()
	}

	private handleConfirmInput(data: string): void {
		// Two-step confirm for compact-marked rows. Default is No: Enter or any
		// non-y key declines and returns to the list; only an explicit `y`
		// proceeds. Esc also declines (it does not cancel the whole dialog —
		// the user explicitly asked for a switch, just not the compaction).
		if (data === "y" || data === "Y") {
			const candidate = this.confirmCandidate
			this.confirmCandidate = null
			if (candidate) void this.attemptSwitch(candidate)
			return
		}
		this.confirmCandidate = null
		this.mode = "list"
		this.requestRender()
	}

	private async attemptSwitch(candidate: VisionSwitchCandidate): Promise<void> {
		if (this.mode === "busy") return
		this.mode = "busy"
		this.errorMessage = null
		this.requestRender()
		try {
			const result = await this.options.onSwitch(candidate.model, {
				compactConfirmed: candidate.compactNeeded,
			})
			if (result.ok) {
				this.done({ kind: "switch", model: candidate.model })
				return
			}
			this.errorMessage = result.error ?? "Switch failed"
			this.mode = "error"
		} catch (err) {
			this.errorMessage = err instanceof Error ? err.message : String(err)
			this.mode = "error"
		}
		this.requestRender()
	}

	handleInput(data: string): void {
		// Busy: an in-flight mutation owns the dialog — block duplicate
		// selection, removal, and cancellation until it settles.
		if (this.mode === "busy") return

		if (this.mode === "confirm") {
			this.handleConfirmInput(data)
			return
		}

		if (matchesKey(data, Key.escape)) {
			this.done({ kind: "cancel" })
			return
		}
		if (matchesKey(data, Key.ctrl("r"))) {
			this.done({ kind: "remove" })
			return
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1)
			return
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1)
			return
		}
		if (matchesKey(data, Key.enter)) {
			const candidates = this.filteredCandidates
			const candidate = candidates[this.selectedIndex]
			if (!candidate) return
			if (candidate.compactNeeded) {
				this.confirmCandidate = candidate
				this.mode = "confirm"
				this.requestRender()
				return
			}
			void this.attemptSwitch(candidate)
			return
		}
		// Plain `r` (and every other printable) always belongs to the search
		// input — removal is Ctrl+R only.
		if (matchesKey(data, Key.backspace) || data === "\x7f") {
			this.query = this.query.slice(0, -1)
			this.selectedIndex = 0
			this.requestRender()
			return
		}
		if (data.length === 1 && data.charCodeAt(0) >= 0x20 && data !== "\x7f") {
			this.query += data
			this.selectedIndex = 0
			this.requestRender()
		}
	}

	/** Plain (unstyled) row text for a candidate — shared by render and tests. */

	override render(width: number): string[] {
		const { emptyRow, contentRow, topBorder, bottomBorder } = createDialogChrome(this.theme, width)

		const lines: string[] = []
		lines.push(topBorder("Switch to a vision model"))
		lines.push(emptyRow)

		const headerPlain = `⚠ ${this.options.currentModelId} is text-only — switch to send image(s)`
		lines.push(contentRow(this.theme.fg("text", headerPlain), headerPlain))
		lines.push(emptyRow)

		// Search row. `❯ ` prefix; placeholder while empty.
		const dim = (s: string) => this.theme.fg("muted", s)
		if (this.query.length > 0) {
			const searchPlain = `❯ ${this.query}`
			lines.push(contentRow(`${dim("❯ ")}${this.query}`, searchPlain))
		} else {
			const searchPlain = `❯ ${SEARCH_PLACEHOLDER}`
			lines.push(contentRow(`${dim("❯ ")}${dim(SEARCH_PLACEHOLDER)}`, searchPlain))
		}
		lines.push(emptyRow)

		const candidates = this.filteredCandidates
		if (candidates.length === 0) {
			const nonePlain = this.options.getCandidates().length === 0 ? "No vision models available" : "No matching models"
			lines.push(contentRow(dim(nonePlain), nonePlain))
		} else {
			const maxVisible = Math.min(MAX_VISIBLE_CANDIDATES, candidates.length)
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), candidates.length - maxVisible),
			)
			const endIndex = Math.min(startIndex + maxVisible, candidates.length)
			for (let i = startIndex; i < endIndex; i++) {
				const candidate = candidates[i]
				if (!candidate) continue
				const isSelected = i === this.selectedIndex
				const id = candidate.model.id
				const provider = `[${candidate.model.provider}]`
				const context = humanizeContextWindow(candidate.model.contextWindow)
				const badge = candidate.compactNeeded ? dim(" · ⚠ compact") : ""
				const cursor = isSelected ? this.theme.fg("accent", "→ ") : "  "
				const idText = isSelected ? this.theme.fg("accent", id) : this.theme.fg("text", id)
				const providerText = dim(provider)
				const contextText = this.theme.fg("text", context)
				const rowPlain = `${cursor}${id}  ${provider}  ${context}${candidate.compactNeeded ? " · ⚠ compact" : ""}`
				lines.push(contentRow(`${cursor}${idText}  ${providerText}  ${contextText}${badge}`, rowPlain))
			}
			if (startIndex > 0 || endIndex < candidates.length) {
				const scrollPlain = `(${this.selectedIndex + 1}/${candidates.length})`
				lines.push(contentRow(dim(`  ${scrollPlain}`), `  ${scrollPlain}`))
			}
		}

		lines.push(emptyRow)

		if (this.mode === "confirm" && this.confirmCandidate) {
			const confirmPlain = `⚠ this will compact your context — continue? [y/N]`
			lines.push(contentRow(this.theme.fg("warning", confirmPlain), confirmPlain))
		} else if (this.mode === "busy") {
			const busyPlain = "Switching…"
			lines.push(contentRow(dim(busyPlain), busyPlain))
		} else if (this.mode === "error" && this.errorMessage) {
			lines.push(contentRow(this.theme.fg("error", this.errorMessage), this.errorMessage))
		}

		const footerPlain = "[Ctrl+R] remove image(s)  [Esc] cancel"
		lines.push(contentRow(this.theme.fg("dim", footerPlain), footerPlain))
		lines.push(emptyRow)
		lines.push(bottomBorder)
		return lines
	}
}
