import { setImmediate } from "node:timers/promises"
import type { RecordBackend } from "./records.js"

const MARKER_CLEAR_BATCH = 1_024

/** Call only after the group's facts commit; interrupted cleanup leaves markers for idempotent replay. */
export async function clearTranslatedMarkers(
	backend: RecordBackend,
	recordHashes: Iterable<string>,
	assertCurrent: () => void,
): Promise<void> {
	let batch: string[] = []
	const clearBatch = async () => {
		assertCurrent()
		backend.tx(() => {
			assertCurrent()
			backend.clearTranslations(new Set(batch))
			assertCurrent()
		})
		batch = []
		await setImmediate()
	}
	for (const hash of recordHashes) {
		batch.push(hash)
		if (batch.length === MARKER_CLEAR_BATCH) await clearBatch()
	}
	if (batch.length) await clearBatch()
}
