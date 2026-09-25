import type { Api, ImageContent, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { contextFitsModel, getLatestMessages, resolveContextTokens } from "./model-guard.js"
import { modelSupportsImages, needsVisionSwitch, visionModelCandidates } from "./vision-support.js"
import {
	showVisionSwitchDialog,
	type VisionDialogResult,
	type VisionSwitchCandidate,
	type VisionSwitchOutcome,
} from "./vision-switch-dialog.js"

/**
 * Submit-time vision gate state machine.
 *
 * The gate lives at the `input` event — the single choke point where pasted,
 * typed, and upstream-attached images converge — and only for interactive TUI
 * submissions (`ctx.mode === "tui" && event.source === "interactive"`). Outside
 * that boundary clipboard-image preserves its existing behavior.
 *
 * Module-level state mirrors model-guard's pattern: a session generation
 * counter invalidates async work across session replacements, reset from the
 * host extension's session_start/session_shutdown handlers.
 */

/** A submission retained between the gate intercepting it and its outcome. */
export interface RetainedSubmission {
	/** Draft text exactly as submitted (the text restored into the editor). */
	text: string
	/** Images that arrived on the input event itself (upstream/drag-drop). */
	incoming: ImageContent[]
	/** Clipboard-pasted attachments pending at submission time. */
	pasted: ImageContent[]
	/** Typed-path attachments keyed by resolved absolute path. */
	paths: Map<string, ImageContent>
	/** Vision-gate session generation captured at assembly time. */
	generation: number
}

/** Path attachment before keying (as produced by the input handler). */
export interface PathAttachment {
	resolvedPath: string
	image: ImageContent
}

/** One-submission typed-path suppression armed by deferred Remove. */
interface PathSuppression {
	text: string
	generation: number
	paths: Set<string>
}

/** Deferred-dialog latch armed by a streaming interception. */
interface DeferredLatch {
	generation: number
}

export type VisionGateOutcome =
	/** Checked switch succeeded — attach the retained images and submit now. */
	| { kind: "proceed" }
	/** Remove chosen — caller returns the trimmed text with `images: []`. */
	| { kind: "remove" }
	/** Submission consumed without sending (cancel, streaming, invalidation, error). */
	| { kind: "handled" }

// ─── Module state ──────────────────────────────────────────────────────────

let sessionGeneration = 0
let retained: RetainedSubmission | null = null
let suppression: PathSuppression | null = null
let deferredLatch: DeferredLatch | null = null
let dialogOpen = false
let dialogToken = 0
let activeDialogClose: (() => void) | null = null
let clearPendingAttachmentsFn: (() => void) | null = null

/** Side effects owned by the host extension (pending paste buffer + indicator). */
export function registerVisionGateSideEffects(effects: { clearPendingAttachments: () => void }): void {
	clearPendingAttachmentsFn = effects.clearPendingAttachments
}

/** Current vision-gate session generation (captures for async rechecks). */
export function getVisionGateSessionGeneration(): number {
	return sessionGeneration
}

/** The retained submission, if any (read by the host extension for merging). */
export function getRetainedSubmission(): RetainedSubmission | null {
	return retained
}

/** Clears the retained submission (after an accepted transfer or Remove). */
export function clearRetained(): void {
	retained = null
}

/**
 * Resets all gate state. Called on session_start/session_shutdown so a
 * replacement session never sees retained attachments, suppressions, latches,
 * or dialogs from its predecessor — and a stale dialog is closed without
 * committing anything.
 */
export function resetVisionGateState(): void {
	sessionGeneration++
	retained = null
	suppression = null
	deferredLatch = null
	dialogToken++
	dialogOpen = false
	const close = activeDialogClose
	activeDialogClose = null
	try {
		close?.()
	} catch {
		// best-effort close
	}
}

// ─── Pure retention logic ──────────────────────────────────────────────────

/**
 * Assembles the submission record before any marker/registry mutation.
 *
 * - No prior retention: everything on this submission is fresh.
 * - Same draft resubmitted: retained attachments are reused; fresh typed-path
 *   extraction only fills paths not already retained (no duplicates).
 * - Draft changed: path-derived attachments refresh against the new text,
 *   while explicit incoming/pasted attachments are retained; new pastes
 *   (entries of `pending` not already retained) remain distinct additions.
 */
export function mergeRetainedSubmission(input: {
	text: string
	incoming: ImageContent[]
	pending: ImageContent[]
	pathMatches: PathAttachment[]
	retained: RetainedSubmission | null
	generation: number
}): RetainedSubmission {
	const { text, incoming, pending, pathMatches, retained: prior, generation } = input
	if (!prior) {
		return {
			text,
			incoming: [...incoming],
			pasted: [...pending],
			paths: new Map(pathMatches.map((m) => [m.resolvedPath, m.image])),
			generation,
		}
	}
	const sameDraft = prior.text === text
	const pasted = [...prior.pasted]
	for (const img of pending) {
		if (!pasted.includes(img)) pasted.push(img)
	}
	const paths = new Map<string, ImageContent>(sameDraft ? prior.paths : undefined)
	for (const m of pathMatches) {
		if (!paths.has(m.resolvedPath)) paths.set(m.resolvedPath, m.image)
	}
	return {
		text,
		incoming: [...prior.incoming, ...incoming],
		pasted,
		paths,
		generation,
	}
}

/**
 * Reads the one-submission typed-path suppression for `text`, if armed.
 * A suppression only applies to the exact restored draft in the same session
 * generation; any observed draft change (different text) or session reset
 * invalidates it. The caller consumes it only once the input is accepted, so a
 * cancelled gate attempt cannot accidentally re-arm the removed paths.
 */
export function getPathSuppression(text: string, generation: number): Set<string> | null {
	if (!suppression) return null
	if (suppression.generation !== generation || suppression.text !== text) {
		suppression = null
		return null
	}
	return suppression.paths
}

/** Consumes a suppression after its matching input has been accepted. */
export function consumePathSuppression(text: string, generation: number): void {
	if (suppression?.generation === generation && suppression.text === text) suppression = null
}

function armSuppression(text: string, paths: Iterable<string>, generation: number): void {
	const merged =
		suppression?.text === text && suppression.generation === generation ? suppression.paths : new Set<string>()
	for (const path of paths) merged.add(path)
	suppression = { text, generation, paths: merged }
}

// ─── Dialog wiring ──────────────────────────────────────────────────────────

function currentContextTokens(ctx: ExtensionContext): number | null {
	try {
		return resolveContextTokens(ctx.getContextUsage(), getLatestMessages())
	} catch {
		return null
	}
}

/** Switch candidates with fresh compact badges (recomputed per dialog render). */
function computeCandidates(ctx: ExtensionContext): VisionSwitchCandidate[] {
	const available = ctx.modelRegistry?.getAvailable() ?? []
	const tokens = currentContextTokens(ctx)
	return visionModelCandidates(available).map((model) => ({
		model,
		compactNeeded: tokens != null && !contextFitsModel(tokens, model.contextWindow),
	}))
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
	try {
		ctx.ui.notify(message, type)
	} catch {
		// best-effort
	}
}

function restoreDraft(ctx: ExtensionContext, text: string): void {
	try {
		ctx.ui.setEditorText(text)
		// Editor.setText updates state without requesting a render (upstream's
		// own restore path re-renders explicitly), so force one with a no-op
		// status update — the same trick ui.ts uses to repaint the status line.
		ctx.ui.setStatus("__vision_gate_draft", undefined)
	} catch {
		// best-effort — never block the outcome on editor restoration
	}
}

/**
 * Checked switch for a dialog selection: fresh fit validation, confirmed
 * compaction when needed, `pi.setModel` with default persistence (same as
 * /model Enter), then live-model verification — the `model_select` guard can
 * revert a switch after `setModel` resolves, so a resolved call alone is not
 * success. Never forces a retry; every failure resolves `{ ok: false, error }`
 * so the dialog stays open with attachments retained.
 */
async function performCheckedSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	model: Model<Api>,
	generation: number,
	compactConfirmed: boolean,
): Promise<VisionSwitchOutcome> {
	try {
		let tokens = currentContextTokens(ctx)
		if (tokens == null) {
			return { ok: false, error: "Unable to determine the current context size — switch aborted." }
		}
		if (!contextFitsModel(tokens, model.contextWindow)) {
			if (!compactConfirmed) {
				// The row's badge was computed before the context grew; the
				// refreshed badge re-presents the two-step confirm on reselection.
				return {
					ok: false,
					error: `Context (${tokens.toLocaleString()} tokens) now exceeds ${model.id}'s safe window — select it again to confirm compaction.`,
				}
			}
			const inlineCompact = ctx.inlineCompact
			if (typeof inlineCompact !== "function") {
				return {
					ok: false,
					error: `Context (${tokens.toLocaleString()} tokens) exceeds ${model.id}'s safe window and inline compaction is unavailable. Run /compact, then retry.`,
				}
			}
			try {
				await inlineCompact()
			} catch (err) {
				return { ok: false, error: `Compaction failed: ${errorMessage(err)}` }
			}
			if (generation !== sessionGeneration) {
				return { ok: false, error: "Session changed during compaction — switch aborted." }
			}
			tokens = currentContextTokens(ctx)
			if (tokens == null) {
				return { ok: false, error: "Unable to verify the context size after compaction — switch aborted." }
			}
			if (!contextFitsModel(tokens, model.contextWindow)) {
				return {
					ok: false,
					error: `Context (${tokens.toLocaleString()} tokens) still exceeds ${model.id}'s safe window after compaction.`,
				}
			}
		}
		let ok: boolean
		try {
			// Same persistence semantics as /model Enter (user-initiated selection
			// persists the default).
			ok = await pi.setModel(model, { persist: true })
		} catch (err) {
			return { ok: false, error: `Switch failed: ${errorMessage(err)}` }
		}
		if (generation !== sessionGeneration) {
			return { ok: false, error: "Session changed during the switch — aborted." }
		}
		if (!ok) {
			return { ok: false, error: `No API key available for ${model.provider}/${model.id}.` }
		}
		const live = ctx.model
		if (!live || live.provider !== model.provider || live.id !== model.id) {
			return {
				ok: false,
				error: `Switch to ${model.id} was reverted — ${live?.id ?? "the previous model"} remains active.`,
			}
		}
		if (!modelSupportsImages(live)) {
			return { ok: false, error: `${live.id} does not accept image input.` }
		}
		return { ok: true }
	} catch (err) {
		return { ok: false, error: errorMessage(err) }
	}
}

export type OpenGateDialog = (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	generation: number,
) => Promise<VisionDialogResult>

async function openGateDialog(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	generation: number,
): Promise<VisionDialogResult> {
	return showVisionSwitchDialog(ctx, {
		currentModelId: ctx.model?.id ?? "current model",
		getCandidates: () => computeCandidates(ctx),
		registerClose: (close: () => void) => {
			if (generation === sessionGeneration) activeDialogClose = close
		},
		onSwitch: (model, selection) => performCheckedSwitch(pi, ctx, model, generation, selection.compactConfirmed),
	})
}

// ─── Gate flow ──────────────────────────────────────────────────────────────

/**
 * Runs the vision gate for an assembled submission record. The record must be
 * gathered before any marker/registry mutation; mutation only happens for an
 * accepted submission (the caller commits markers for `proceed`).
 *
 * Never throws: upstream catches input-handler exceptions and continues the
 * submission, so blocking is expressed only through returned outcomes.
 */
export async function runVisionGate(options: {
	pi: ExtensionAPI
	ctx: ExtensionContext
	event: Pick<InputEvent, "text" | "streamingBehavior">
	record: RetainedSubmission
	openDialog?: OpenGateDialog
}): Promise<VisionGateOutcome> {
	const { pi, ctx, event, record } = options
	const generation = record.generation

	// Streaming: no model switch mid-stream. Consume the submission, restore
	// the draft, notify, and arm the deferred-dialog latch — the dialog opens
	// after the run completes (see visionGateOnAgentEnd).
	if (event.streamingBehavior) {
		retained = record
		deferredLatch = { generation }
		restoreDraft(ctx, event.text)
		notify(
			ctx,
			`${ctx.model?.id ?? "Current model"} is text-only — switch available when generation finishes`,
			"warning",
		)
		return { kind: "handled" }
	}

	// Exclusive dialog ownership — a second gate cannot open while one is
	// active. Retain everything and restore the draft; the user can resubmit.
	if (dialogOpen) {
		retained = record
		restoreDraft(ctx, event.text)
		return { kind: "handled" }
	}

	retained = record
	const token = ++dialogToken
	dialogOpen = true
	try {
		const result = await (options.openDialog ?? openGateDialog)(pi, ctx, generation)
		if (generation !== sessionGeneration) {
			// The session was replaced while the dialog was open; reset already
			// cleared the retained state and closed the dialog. Ignore the result.
			return { kind: "handled" }
		}
		if (result.kind === "switch") {
			// Checked success — the caller may commit markers and submit images.
			clearRetained()
			return { kind: "proceed" }
		}
		if (result.kind === "remove") {
			clearRetained()
			clearPendingAttachments()
			return { kind: "remove" }
		}
		// Cancel: all attachment sources stay retained; the exact draft is restored.
		restoreDraft(ctx, event.text)
		return { kind: "handled" }
	} catch {
		// The gate cannot remain open — consume the submission and restore the
		// draft rather than throwing (an exception would continue the submission
		// on the text-only model).
		if (generation === sessionGeneration) restoreDraft(ctx, event.text)
		return { kind: "handled" }
	} finally {
		if (token === dialogToken) dialogOpen = false
	}
}

function clearPendingAttachments(): void {
	try {
		clearPendingAttachmentsFn?.()
	} catch {
		// best-effort
	}
}

// ─── Deferred dialog (streaming interception → after run completion) ────────

/**
 * agent_end hook: schedules the deferred dialog after the handler returns.
 * Never awaits user interaction inside the handler. Before opening, rechecks
 * the latch, retained submission, session generation, idle state, the
 * unchanged restored draft, the current model, and dialog ownership; skips
 * (keeping the latch for the next idle completion) when the run has merely
 * resumed, and disarms when the submission is no longer valid.
 */
export function visionGateOnAgentEnd(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!deferredLatch) return
	const latchGeneration = deferredLatch.generation
	// Defer past the handler so run-completion UI is not blocked.
	setTimeout(() => {
		if (!deferredLatch) return
		if (!retained) {
			deferredLatch = null
			return
		}
		if (latchGeneration !== sessionGeneration) {
			deferredLatch = null
			return
		}
		if (dialogOpen) return // another dialog owns the screen — retry at next idle
		let idle = false
		try {
			idle = ctx.isIdle()
		} catch {
			idle = false
		}
		if (!idle) return // run resumed/retried — keep the latch armed
		let draft = ""
		try {
			draft = ctx.ui.getEditorText()
		} catch {
			draft = "\u0000"
		}
		if (draft !== retained.text) {
			deferredLatch = null
			return
		}
		if (!needsVisionSwitch(ctx.model)) {
			deferredLatch = null
			return
		}
		// Consume the latch before opening so Cancel cannot reopen it.
		deferredLatch = null
		void runDeferredDialog(pi, ctx)
	}, 0)
}

async function runDeferredDialog(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const record = retained
	if (!record) return
	const generation = sessionGeneration
	const token = ++dialogToken
	dialogOpen = true
	try {
		const result = await openGateDialog(pi, ctx, generation)
		if (generation === sessionGeneration) {
			applyDeferredOutcome(ctx, record, result, generation)
		}
	} catch {
		// best-effort: the draft and attachments simply stay retained
	} finally {
		if (token === dialogToken) dialogOpen = false
	}
}

function applyDeferredOutcome(
	ctx: ExtensionContext,
	record: RetainedSubmission,
	result: VisionDialogResult,
	generation: number,
): void {
	switch (result.kind) {
		case "switch":
			// The checked switch already succeeded. The draft and attachments
			// stay retained; the user presses Enter to send on the new model —
			// the normal input path then merges and consumes the record.
			notify(ctx, `Switched to ${result.model.id} — press Enter to send`, "info")
			return
		case "cancel":
			// Draft/attachments retained; the latch was consumed before
			// opening, so cancel does not reopen the dialog.
			return
		case "remove":
			clearRetained()
			clearPendingAttachments()
			armSuppression(record.text, record.paths.keys(), generation)
			return
	}
}

/** @internal — test hook resetting module state between unit tests. */
export function __resetVisionGateForTest(): void {
	sessionGeneration = 0
	retained = null
	suppression = null
	deferredLatch = null
	dialogOpen = false
	dialogToken = 0
	activeDialogClose = null
	clearPendingAttachmentsFn = null
}
