// Session-scoped view of background work that a user may stop: managed bash
// processes and background subagents. Feature extensions register providers;
// the TUI asks "what still runs?" and "stop these items" through this module.
//
// A stop through this module is a user stop. The work ends and its card shows
// a final state. The model learns about it on its next turn, but the stop
// itself must not start a new model turn. Providers own that rule.
//
// This module must stay free of imports from src/extensions/** so that shared
// code never depends on a feature.

import { safePanelText } from "../components/input-panel.js"

export interface BackgroundProcessItem {
	kind: "process"
	id: string
	label: string
}
export interface BackgroundAgentItem {
	kind: "agent"
	id: string
	label: string
}
export type BackgroundWorkItem = BackgroundProcessItem | BackgroundAgentItem

export interface BackgroundWorkProvider {
	/** Work that is still running and that a user stop would end. */
	list(): BackgroundWorkItem[]
	/** Stop the work with these ids as a user stop: no model wake-up. Ids that
	 *  no longer run are skipped, and work not named is never touched. Resolves
	 *  with what was stopped. */
	stop(ids: readonly string[]): Promise<BackgroundWorkItem[]>
}

export type BackgroundWorkProviderKey = "bash" | "agents"

// Fixed order so a list always shows processes before agents.
const PROVIDER_ORDER: readonly BackgroundWorkProviderKey[] = ["bash", "agents"]

const LABEL_MAX_CHARS = 80

const providersBySession = new Map<string, Map<BackgroundWorkProviderKey, BackgroundWorkProvider>>()

/** Register PROVIDER for SESSIONID under KEY, replacing an earlier one. The
 *  returned function removes only this provider, so a stale unregister from a
 *  replaced session cannot remove its successor. */
export function registerBackgroundWorkProvider(
	sessionId: string,
	key: BackgroundWorkProviderKey,
	provider: BackgroundWorkProvider,
): () => void {
	let providers = providersBySession.get(sessionId)
	if (!providers) {
		providers = new Map()
		providersBySession.set(sessionId, providers)
	}
	providers.set(key, provider)
	return () => {
		const current = providersBySession.get(sessionId)
		if (current?.get(key) !== provider) return
		current.delete(key)
		if (current.size === 0) providersBySession.delete(sessionId)
	}
}

function orderedProviders(sessionId: string): Array<[BackgroundWorkProviderKey, BackgroundWorkProvider]> {
	const providers = providersBySession.get(sessionId)
	if (!providers) return []
	const ordered: Array<[BackgroundWorkProviderKey, BackgroundWorkProvider]> = []
	for (const key of PROVIDER_ORDER) {
		const provider = providers.get(key)
		if (provider) ordered.push([key, provider])
	}
	return ordered
}

/** Running background work of SESSIONID: bash processes first, then agents. */
export function listBackgroundWork(sessionId: string): BackgroundWorkItem[] {
	return orderedProviders(sessionId).flatMap(([key, provider]) => {
		try {
			return provider.list()
		} catch (err) {
			console.error(`background-work: ${key} provider failed to list:`, err)
			return []
		}
	})
}

const PROVIDER_KIND: Record<BackgroundWorkProviderKey, BackgroundWorkItem["kind"]> = {
	bash: "process",
	agents: "agent",
}

/** Stop ITEMS of SESSIONID as a user stop. Only these items are stopped: work
 *  that started after ITEMS was listed may be a foreground call of a new turn.
 *  A failing provider does not keep the others from stopping; counts cover
 *  only what stopped. */
export async function stopBackgroundWork(
	sessionId: string,
	items: readonly BackgroundWorkItem[],
): Promise<{ processes: number; agents: number }> {
	const providers = orderedProviders(sessionId).flatMap(([key, provider]) => {
		const ids = items.filter((item) => item.kind === PROVIDER_KIND[key]).map((item) => item.id)
		return ids.length > 0 ? [{ key, provider, ids }] : []
	})
	// The extra then() turns a synchronous throw into a rejection, so it is settled too.
	const results = await Promise.allSettled(
		providers.map(({ provider, ids }) => Promise.resolve().then(() => provider.stop(ids))),
	)
	let processes = 0
	let agents = 0
	results.forEach((result, index) => {
		if (result.status === "rejected") {
			console.error(`background-work: ${providers[index].key} provider failed to stop:`, result.reason)
			return
		}
		for (const item of result.value) {
			if (item.kind === "process") processes++
			else agents++
		}
	})
	return { processes, agents }
}

/** One-line label for a dialog row: first non-empty line, capped in length.
 *  TEXT is model-written, so it is cleaned before it reaches the terminal. */
export function backgroundWorkLabel(text: string): string {
	const line =
		safePanelText(text)
			.split("\n")
			.map((part) => part.trim())
			.find((part) => part.length > 0) ?? ""
	return line.length > LABEL_MAX_CHARS ? `${line.slice(0, LABEL_MAX_CHARS - 1)}…` : line
}
