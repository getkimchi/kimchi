import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { Container, fuzzyFilter, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { renderModelTable } from "../model-selector-table.js"
import { getModelDescription } from "../models.js"

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

const MAX_VISIBLE_CANDIDATES = 10
const SEARCH_PLACEHOLDER = "filter models…"

/** Mirrors the /model selector's search-text shape (provider first, then
 *  provider/id, id, and display name) so filtering feels identical. */
function visionCandidateSearchText(model: Model<Api>): string {
	const name = model.name ? ` ${model.name}` : ""
	return `${model.provider} ${model.provider}/${model.id} ${model.id}${name}`
}

/**
 * Searchable vision-model switch selector, rendered inline in the editor
 * region (the permission-prompt / `/model` pattern — `ctx.ui.custom` without
 * overlay options). The chat stays visible above; `done()` restores the
 * editor. The candidate list renders as a /model-style capability table
 * (MODEL | PROVIDER | CONTEXT | DESCRIPTION, without the constant VISION
 * column since every candidate is vision-capable by definition) with the
 * same fuzzy search, so switching feels like using /model. All effects
 * (compaction, model switch) are injected through `onSwitch`; the selector
 * only owns rendering, filtering, the compact two-step confirm, and
 * busy/error state.
 */
export async function showVisionSwitchDialog(
	ctx: ExtensionContext,
	options: ShowVisionSwitchDialogOptions,
): Promise<VisionDialogResult> {
	return ctx.ui.custom<VisionDialogResult>(
		(tui, theme, _keybindings, done) => new VisionSwitchComponent(tui, theme, options, done, options.registerClose),
	)
}

type DialogMode = "list" | "confirm" | "busy" | "error"

export class VisionSwitchComponent extends Container {
	private readonly tui: TUI
	private readonly theme: Theme
	private readonly options: ShowVisionSwitchDialogOptions
	private readonly done: (result: VisionDialogResult) => void

	private query = ""
	private selectedIndex = 0
	private mode: DialogMode = "list"
	private errorMessage: string | null = null
	private confirmCandidate: VisionSwitchCandidate | null = null

	constructor(
		tui: TUI,
		theme: Theme,
		options: ShowVisionSwitchDialogOptions,
		done: (result: VisionDialogResult) => void,
		registerClose?: (close: () => void) => void,
	) {
		super()
		this.tui = tui
		this.theme = theme
		this.options = options
		this.done = done
		registerClose?.(() => this.done({ kind: "cancel" }))
	}

	private get filteredCandidates(): VisionSwitchCandidate[] {
		const candidates = this.options.getCandidates()
		const q = this.query.trim()
		if (!q) return candidates
		// Same fuzzy search as the /model selector (pi-tui's fuzzyFilter over
		// provider, provider/id, id, and display name), best matches first.
		return fuzzyFilter(candidates, q, (c) => visionCandidateSearchText(c.model))
	}

	private requestRender(): void {
		this.invalidate()
		this.tui.requestRender()
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
		// Ctrl+R is owned by legacy feedback after a run settles.
		if (matchesKey(data, Key.alt("r"))) {
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
		// input — removal is Alt+R only.
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

	override render(width: number): string[] {
		const dim = (s: string) => this.theme.fg("muted", s)
		const rule = this.theme.fg("border", "─".repeat(Math.max(1, width)))

		const lines: string[] = []
		lines.push(rule)
		lines.push("")

		lines.push(` ${this.theme.fg("accent", this.theme.bold("Switch to a vision model"))}`)
		lines.push("")

		const headerPlain = `⚠ ${this.options.currentModelId} is text-only — switch to send image(s)`
		lines.push(` ${this.theme.fg("warning", headerPlain)}`)
		lines.push("")

		// Search row. `❯ ` prefix; placeholder while empty.
		if (this.query.length > 0) {
			lines.push(` ${dim("❯ ")}${this.query}`)
		} else {
			lines.push(` ${dim("❯ ")}${dim(SEARCH_PLACEHOLDER)}`)
		}
		lines.push("")

		const candidates = this.filteredCandidates
		if (candidates.length === 0) {
			const nonePlain = this.options.getCandidates().length === 0 ? "No vision models available" : "No matching models"
			lines.push(` ${dim(nonePlain)}`)
		} else {
			const table = renderModelTable(
				candidates.map((candidate, index) => ({
					model: candidate.model,
					id: candidate.model.id,
					provider: candidate.model.provider,
					selected: index === this.selectedIndex,
					description: getModelDescription(`${candidate.model.provider}/${candidate.model.id}`) ?? "",
					annotation: candidate.compactNeeded ? "⚠ compact first" : "",
					warning: candidate.compactNeeded,
				})),
				width,
				this.theme,
			)
			lines.push(table[0] ?? "")

			const maxVisible = Math.min(MAX_VISIBLE_CANDIDATES, candidates.length)
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), candidates.length - maxVisible),
			)
			const endIndex = Math.min(startIndex + maxVisible, candidates.length)
			lines.push(...table.slice(startIndex + 1, endIndex + 1))
			if (startIndex > 0 || endIndex < candidates.length) {
				lines.push(` ${dim(`(${this.selectedIndex + 1}/${candidates.length})`)}`)
			}
			// Mirrors the /model selector's footer: the highlighted row's
			// human-readable model name.
			const selected = candidates[this.selectedIndex]
			if (selected) {
				lines.push(` ${dim(`Model Name: ${selected.model.name}`)}`)
			}
		}

		lines.push("")

		if (this.mode === "confirm" && this.confirmCandidate) {
			const confirmPlain = "⚠ this will compact your context — continue? [y/N]"
			lines.push(` ${this.theme.fg("warning", confirmPlain)}`)
		} else if (this.mode === "busy") {
			lines.push(` ${dim("Switching…")}`)
		} else if (this.mode === "error" && this.errorMessage) {
			lines.push(` ${this.theme.fg("error", this.errorMessage)}`)
		}

		const hintPlain = "↑↓ navigate · Enter select · Esc cancel · Alt+R remove image(s)"
		lines.push("")
		lines.push(` ${this.theme.fg("dim", hintPlain)}`)
		lines.push("")
		lines.push(rule)
		return lines.map((line) => truncateToWidth(line, width, ""))
	}
}
