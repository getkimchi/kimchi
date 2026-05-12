import type { ImageContent } from "@earendil-works/pi-ai"

/**
 * Session-level image store for cross-turn persistence.
 *
 * Images are accumulated across turns until explicitly consumed by a subagent.
 * This allows users to reference images from previous turns (e.g., "describe
 * the image from earlier") and ensures images survive across turn boundaries.
 *
 * `clipboard-image.ts` adds new images on paste and `on("input")`.
 * `subagent.ts` reads images when forwarding to a subagent and clears them
 * after successful forwarding via `consumeTurnImages()`.
 */
let sessionImages: readonly ImageContent[] = []

/**
 * Add images to the session store. Images accumulate across turns.
 * Call this on every `on("input")` event with the new images from that turn.
 */
export function addSessionImages(images: readonly ImageContent[]): void {
	if (images.length === 0) return
	sessionImages = [...sessionImages, ...images]
}

/**
 * Return all images in the session store (from all turns).
 */
export function getCurrentTurnImages(): readonly ImageContent[] {
	return sessionImages
}

/**
 * Consume (clear) all images from the session store.
 * Called by subagent.ts after images have been forwarded to a subagent.
 */
export function consumeTurnImages(): void {
	sessionImages = []
}

/**
 * Reset the session store, e.g. on `session_start`.
 */
export function clearCurrentTurnImages(): void {
	sessionImages = []
}

// Keep old name as alias for backwards compat during transition
export const setCurrentTurnImages = addSessionImages
