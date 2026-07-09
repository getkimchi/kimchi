import type { CustomEntry, ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent"
import { readConfigSetting } from "../config/settings.js"
import { getProcessMultiModelEnabled, setProcessMultiModelEnabled } from "./kimchi-process.js"

function hasExplicitModelFlag(): boolean {
	const args = process.argv
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i]?.startsWith("--model=")) return true
	}
	return false
}

const _defaultMultiModelEnabled = hasExplicitModelFlag()
	? false
	: (readConfigSetting("multiModel", (value) => typeof value === "boolean") ?? true)
const _multiModelEntryType = "multi_model_enabled" as const

export function getMultiModelEnabled(
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId"> | null,
): boolean {
	if (sessionManager) {
		const enabled = getProcessMultiModelEnabled(sessionManager.getSessionId())
		if (enabled !== undefined) {
			return enabled
		}
		const lastEntry = sessionManager
			.getEntries()
			.findLast(
				(item): item is CustomEntry<boolean> => item.type === "custom" && item.customType === _multiModelEntryType,
			)

		return lastEntry?.data ?? _defaultMultiModelEnabled
	}
	return _defaultMultiModelEnabled
}

/** Writes the multi-model flag to the current process, keyed by session ID. */
export function setMultiModelEnabled(sessionId: string, enabled: boolean): void {
	setProcessMultiModelEnabled(sessionId, enabled)
}

/** Persists the multi-model flag to session log. Should be called once per started session, if changed. */
export function persistMultiModelEnabled(
	context: Pick<SessionManager, "appendCustomEntry"> | Pick<ExtensionAPI, "appendEntry">,
	enabled: boolean,
): void {
	const append = "appendCustomEntry" in context ? context.appendCustomEntry : context.appendEntry
	append(_multiModelEntryType, enabled)
}
