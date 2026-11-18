import type { CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent"
import { assertValidDirectorRunState, type DirectorRunState } from "./plan.js"

export const DIRECTOR_SESSION_ENTRY_TYPE = "director-mode/v1"

export interface DirectorStoreOptions {
	sessionManager: Pick<SessionManager, "getEntries">
	appendEntry: (customType: string, data: unknown) => void
}

/** Revision-checked persistent state for the main session's current Director run. */
export class DirectorStore {
	private readonly sessionManager: DirectorStoreOptions["sessionManager"]
	private readonly appendEntry: DirectorStoreOptions["appendEntry"]

	constructor(options: DirectorStoreOptions) {
		this.sessionManager = options.sessionManager
		this.appendEntry = options.appendEntry
	}

	read(): DirectorRunState | undefined {
		const entries = this.sessionManager.getEntries()
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]
			if (entry.type !== "custom" || entry.customType !== DIRECTOR_SESSION_ENTRY_TYPE) continue
			const snapshot = (entry as CustomEntry<DirectorRunState>).data
			assertValidDirectorRunState(snapshot)
			return structuredClone(snapshot)
		}
		return undefined
	}

	commit(next: DirectorRunState, expectedRevision: number): DirectorRunState {
		const current = this.read()
		if (current?.revision !== expectedRevision && !(current === undefined && expectedRevision === 0)) {
			throw new Error(
				`Director revision conflict: expected ${expectedRevision}, current ${current?.revision ?? "none"}`,
			)
		}
		const snapshot = structuredClone(next)
		snapshot.revision = expectedRevision + 1
		snapshot.updatedAt = new Date().toISOString()
		assertValidDirectorRunState(snapshot)
		this.appendEntry(DIRECTOR_SESSION_ENTRY_TYPE, snapshot)
		return snapshot
	}
}
