/**
 * Clock/ID seam for deterministic writer output (Phase 2+; writers are not
 * allowed to call Date.now()/Math.random() directly). With everything pinned,
 * creation output is byte-identical across platforms — doctor hashes goldens.
 *
 * Read-phase code only consumes RealClock; the seam ships now so writers can
 * be written against it from day one.
 */

export interface DocumentClock {
	now(): Date
	/** Hex id used for PDF /ID and zip metadata, deterministic when pinned. */
	id(): string
}

export const RealClock: DocumentClock = {
	now: () => new Date(),
	id: () => cryptoRandomHex(16),
}

export function createPinnedClock(
	fixedIsoDate = "1980-01-01T00:00:00.000Z",
	fixedId = "0000000000000000",
): DocumentClock {
	const date = new Date(fixedIsoDate)
	return {
		now: () => new Date(date.getTime()),
		id: () => fixedId,
	}
}

function cryptoRandomHex(bytes: number): string {
	const arr = new Uint8Array(bytes)
	globalThis.crypto.getRandomValues(arr)
	return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
}
