import type { CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent"

export interface SessionLogHarness {
	entries: CustomEntry[]
	sessionManager: Pick<SessionManager, "getEntries">
	appendEntry: (customType: string, data: unknown) => void
}

export function createSessionLogHarness(): SessionLogHarness {
	const entries: CustomEntry[] = []
	return {
		entries,
		sessionManager: { getEntries: () => entries },
		appendEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data } as CustomEntry)
		},
	}
}
