import type { ImageContent } from "@earendil-works/pi-ai"

/**
 * Per-turn image snapshot for cross-extension state.
 *
 * `clipboard-image.ts` writes the current turn's images after every
 * `on("input")` event (including empty turns to clear state).
 * `subagent.ts` reads the snapshot when forwarding images to a subagent.
 */
let currentTurnImages: readonly ImageContent[] = []

/**
 * Replace the cached image list for the current turn.
 * Call this on every `on("input")` event, even when the list is empty,
 * to prevent state leakage across turns.
 */
export function setCurrentTurnImages(images: readonly ImageContent[]): void {
	currentTurnImages = images
}

/**
 * Return a shallow copy of the images attached to the current turn.
 */
export function getCurrentTurnImages(): readonly ImageContent[] {
	return currentTurnImages
}

/**
 * Reset the state, e.g. on `session_start`.
 */
export function clearCurrentTurnImages(): void {
	currentTurnImages = []
}
