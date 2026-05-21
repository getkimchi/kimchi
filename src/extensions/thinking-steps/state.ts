import type { ActiveThinkingState, ThinkingStepsMode } from "./types.js"

const STATE_KEY = Symbol.for("kimchi-extensions.thinking-steps.state")
const DEFAULT_SCOPE_KEY = "__default__"
const LABEL_REFRESH_SUFFIX = "\u2060"

type PatchCleanup = () => void | Promise<void>
type PatchInstallPromise = Promise<PatchCleanup>
type PatchRelease = () => Promise<void>

interface ThinkingActiveEntry {
	contentIndex?: number
}

interface ThinkingStepsGlobalState {
	currentScopeKey: string
	modeByScopeKey: Record<string, ThinkingStepsMode>
	activeByScopeKey: Record<string, Record<string, ThinkingActiveEntry>>
	lastActiveByScopeKey: Record<string, ActiveThinkingState>
	refreshToggleByScope: Record<string, boolean>
	messageScopeByObject: WeakMap<object, string>
	messageObjectsByScope: Record<string, Set<object>>
	messageScopeByTimestamp: Record<string, string>
	patchReleases: PatchRelease[]
	patchReleasesByScope: Record<string, PatchRelease[]>
	patchRefCount: number
	patchCleanup?: PatchCleanup | undefined
	patchInstallPromise?: PatchInstallPromise | undefined
	lastThinkingDurationMs?: number | undefined
	lastThinkingMessageTimestamp?: number | undefined
}

interface LegacyThinkingStepsGlobalState {
	mode?: unknown
	active?: unknown
	currentScopeKey?: unknown
	modeByScopeKey?: unknown
	activeByScopeKey?: unknown
	lastActiveByScopeKey?: unknown
	refreshToggleByScope?: unknown
	messageScopeByObject?: unknown
	messageObjectsByScope?: unknown
	messageScopeByTimestamp?: unknown
	patchReleases?: unknown
	patchReleasesByScope?: unknown
	patchRefCount?: unknown
	patchCleanup?: unknown
	patchInstallPromise?: unknown
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null
}

function normalizeThinkingScopeKey(scopeKey?: string): string {
	const trimmed = scopeKey?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_SCOPE_KEY
}

function normalizeThinkingMode(mode: unknown): ThinkingStepsMode {
	return mode === "collapsed" || mode === "summary" || mode === "expanded" ? mode : "summary"
}

function normalizeActiveThinkingState(value: unknown): ActiveThinkingState {
	if (!isRecord(value) || value.active !== true) {
		return { active: false }
	}
	return {
		active: true,
		messageTimestamp: typeof value.messageTimestamp === "number" ? value.messageTimestamp : undefined,
		contentIndex: typeof value.contentIndex === "number" ? value.contentIndex : undefined,
	}
}

function normalizeModeByScopeKey(
	value: unknown,
	currentScopeKey: string,
	legacyMode: unknown,
): Record<string, ThinkingStepsMode> {
	const modeByScopeKey: Record<string, ThinkingStepsMode> = {}
	if (isRecord(value)) {
		for (const [scopeKey, scopeMode] of Object.entries(value)) {
			modeByScopeKey[normalizeThinkingScopeKey(scopeKey)] = normalizeThinkingMode(scopeMode)
		}
	}
	modeByScopeKey[currentScopeKey] ??= normalizeThinkingMode(legacyMode)
	return modeByScopeKey
}

function normalizeActiveByScopeKey(value: unknown): Record<string, Record<string, ThinkingActiveEntry>> {
	const activeByScopeKey: Record<string, Record<string, ThinkingActiveEntry>> = {}
	if (!isRecord(value)) return activeByScopeKey
	for (const [scopeKey, entries] of Object.entries(value)) {
		const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey)
		activeByScopeKey[normalizedScopeKey] = {}
		if (!isRecord(entries)) continue
		for (const [messageTimestamp, entry] of Object.entries(entries)) {
			if (!isRecord(entry)) continue
			;(activeByScopeKey[normalizedScopeKey] as Record<string, ThinkingActiveEntry>)[messageTimestamp] = {
				contentIndex: typeof entry.contentIndex === "number" ? entry.contentIndex : undefined,
			}
		}
	}
	return activeByScopeKey
}

function normalizeLastActiveByScopeKey(value: unknown): Record<string, ActiveThinkingState> {
	const lastActiveByScopeKey: Record<string, ActiveThinkingState> = {}
	if (!isRecord(value)) return lastActiveByScopeKey
	for (const [scopeKey, entry] of Object.entries(value)) {
		lastActiveByScopeKey[normalizeThinkingScopeKey(scopeKey)] = normalizeActiveThinkingState(entry)
	}
	return lastActiveByScopeKey
}

function ensureGlobalStateShape(
	state: ThinkingStepsGlobalState & LegacyThinkingStepsGlobalState,
): ThinkingStepsGlobalState {
	const currentScopeKey = normalizeThinkingScopeKey(
		typeof state.currentScopeKey === "string" ? state.currentScopeKey : undefined,
	)
	const modeByScopeKey = normalizeModeByScopeKey(state.modeByScopeKey, currentScopeKey, state.mode)
	const activeByScopeKey = normalizeActiveByScopeKey(state.activeByScopeKey)
	const lastActiveByScopeKey = normalizeLastActiveByScopeKey(state.lastActiveByScopeKey)
	const legacyActive = normalizeActiveThinkingState(state.active)
	const refreshToggleByScope: Record<string, boolean> = isRecord(state.refreshToggleByScope)
		? Object.fromEntries(
				Object.entries(state.refreshToggleByScope).map(([scopeKey, enabled]) => [
					normalizeThinkingScopeKey(scopeKey),
					enabled === true,
				]),
			)
		: {}
	const messageScopeByObject =
		state.messageScopeByObject instanceof WeakMap
			? (state.messageScopeByObject as WeakMap<object, string>)
			: new WeakMap<object, string>()
	const messageObjectsByScope: Record<string, Set<object>> = isRecord(state.messageObjectsByScope)
		? Object.fromEntries(
				Object.entries(state.messageObjectsByScope).map(([scopeKey, messages]) => [
					normalizeThinkingScopeKey(scopeKey),
					messages instanceof Set ? (messages as Set<object>) : new Set<object>(),
				]),
			)
		: {}
	const messageScopeByTimestamp: Record<string, string> = isRecord(state.messageScopeByTimestamp)
		? Object.fromEntries(
				Object.entries(state.messageScopeByTimestamp)
					.filter((entry): entry is [string, string] => typeof entry[1] === "string")
					.map(([messageTimestamp, scopeKey]) => [messageTimestamp, normalizeThinkingScopeKey(scopeKey)]),
			)
		: {}
	const legacyPatchReleasesByScope: Record<string, PatchRelease[]> = isRecord(state.patchReleasesByScope)
		? Object.fromEntries(
				Object.entries(state.patchReleasesByScope).map(([scopeKey, releases]) => [
					normalizeThinkingScopeKey(scopeKey),
					Array.isArray(releases) ? (releases as PatchRelease[]) : [],
				]),
			)
		: {}
	const patchReleases: PatchRelease[] = Array.isArray(state.patchReleases)
		? (state.patchReleases as PatchRelease[])
		: Object.values(legacyPatchReleasesByScope).flat()
	const patchReleasesByScope: Record<string, PatchRelease[]> = { ...legacyPatchReleasesByScope }

	for (const scopeKey of Object.keys(modeByScopeKey)) {
		activeByScopeKey[scopeKey] ??= {}
		lastActiveByScopeKey[scopeKey] ??= { active: false }
		refreshToggleByScope[scopeKey] ??= false
		messageObjectsByScope[scopeKey] ??= new Set<object>()
		patchReleasesByScope[scopeKey] ??= []
	}

	if (legacyActive.active) {
		lastActiveByScopeKey[currentScopeKey] = legacyActive
		if (legacyActive.messageTimestamp !== undefined) {
			;(activeByScopeKey[currentScopeKey] as Record<string, ThinkingActiveEntry>)[
				String(legacyActive.messageTimestamp)
			] = {
				contentIndex: legacyActive.contentIndex,
			}
		}
	}

	state.currentScopeKey = currentScopeKey
	state.modeByScopeKey = modeByScopeKey
	state.activeByScopeKey = activeByScopeKey
	state.lastActiveByScopeKey = lastActiveByScopeKey
	state.refreshToggleByScope = refreshToggleByScope
	state.messageScopeByObject = messageScopeByObject
	state.messageObjectsByScope = messageObjectsByScope
	state.messageScopeByTimestamp = messageScopeByTimestamp
	state.patchReleases = patchReleases
	state.patchReleasesByScope = patchReleasesByScope
	state.patchRefCount =
		typeof state.patchRefCount === "number" && Number.isFinite(state.patchRefCount) ? state.patchRefCount : 0
	state.patchCleanup = typeof state.patchCleanup === "function" ? (state.patchCleanup as PatchCleanup) : undefined
	state.patchInstallPromise =
		state.patchInstallPromise instanceof Promise ? (state.patchInstallPromise as PatchInstallPromise) : undefined
	return state
}

const globalState = (() => {
	const existing = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY]
	if (isRecord(existing)) {
		return ensureGlobalStateShape(existing as unknown as ThinkingStepsGlobalState & LegacyThinkingStepsGlobalState)
	}
	const created: ThinkingStepsGlobalState = {
		currentScopeKey: DEFAULT_SCOPE_KEY,
		modeByScopeKey: { [DEFAULT_SCOPE_KEY]: "summary" },
		activeByScopeKey: { [DEFAULT_SCOPE_KEY]: {} },
		lastActiveByScopeKey: { [DEFAULT_SCOPE_KEY]: { active: false } },
		refreshToggleByScope: {},
		messageScopeByObject: new WeakMap<object, string>(),
		messageObjectsByScope: { [DEFAULT_SCOPE_KEY]: new Set<object>() },
		messageScopeByTimestamp: {},
		patchReleases: [],
		patchReleasesByScope: {},
		patchRefCount: 0,
	}
	;(globalThis as Record<PropertyKey, unknown>)[STATE_KEY] = created
	return created
})()

function ensureScopeState(scopeKey: string): void {
	if (!(scopeKey in globalState.modeByScopeKey)) {
		globalState.modeByScopeKey[scopeKey] = "summary"
	}
	if (!(scopeKey in globalState.activeByScopeKey)) {
		globalState.activeByScopeKey[scopeKey] = {}
	}
	if (!(scopeKey in globalState.lastActiveByScopeKey)) {
		globalState.lastActiveByScopeKey[scopeKey] = { active: false }
	}
	if (!(scopeKey in globalState.refreshToggleByScope)) {
		globalState.refreshToggleByScope[scopeKey] = false
	}
	if (!(scopeKey in globalState.messageObjectsByScope)) {
		globalState.messageObjectsByScope[scopeKey] = new Set<object>()
	}
	if (!(scopeKey in globalState.patchReleasesByScope)) {
		globalState.patchReleasesByScope[scopeKey] = []
	}
}

export function getCurrentThinkingScopeKey(): string {
	return globalState.currentScopeKey
}

export function setCurrentThinkingScopeKey(scopeKey: string): void {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey)
	ensureScopeState(normalizedScopeKey)
	globalState.currentScopeKey = normalizedScopeKey
}

export function getThinkingStepsMode(scopeKey?: string): ThinkingStepsMode {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey)
	ensureScopeState(normalizedScopeKey)
	return globalState.modeByScopeKey[normalizedScopeKey] ?? "summary"
}

export function setThinkingStepsMode(mode: ThinkingStepsMode, scopeKey?: string): void {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey)
	ensureScopeState(normalizedScopeKey)
	globalState.modeByScopeKey[normalizedScopeKey] = mode
	globalState.currentScopeKey = normalizedScopeKey
}

export function getActiveThinkingState(messageTimestamp?: number, scopeKey?: string): ActiveThinkingState {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey)
	ensureScopeState(normalizedScopeKey)

	if (messageTimestamp !== undefined) {
		const entry = (globalState.activeByScopeKey[normalizedScopeKey] as Record<string, ThinkingActiveEntry>)[
			String(messageTimestamp)
		]
		if (!entry) return { active: false }
		return { active: true, messageTimestamp, contentIndex: entry.contentIndex }
	}

	return { ...(globalState.lastActiveByScopeKey[normalizedScopeKey] as ActiveThinkingState) }
}

export function setActiveThinkingState(state: ActiveThinkingState, scopeKey?: string): void {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey)
	ensureScopeState(normalizedScopeKey)
	globalState.lastActiveByScopeKey[normalizedScopeKey] = { ...state }

	if (!state.active || state.messageTimestamp === undefined) {
		if (state.messageTimestamp !== undefined) {
			delete (globalState.activeByScopeKey[normalizedScopeKey] as Record<string, ThinkingActiveEntry>)[
				String(state.messageTimestamp)
			]
		}
		return
	}
	;(globalState.activeByScopeKey[normalizedScopeKey] as Record<string, ThinkingActiveEntry>)[
		String(state.messageTimestamp)
	] = {
		contentIndex: state.contentIndex,
	}
}

export function clearActiveThinkingState(messageTimestamp?: number, scopeKey?: string): void {
	if (messageTimestamp !== undefined) {
		const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey)
		ensureScopeState(normalizedScopeKey)
		delete (globalState.activeByScopeKey[normalizedScopeKey] as Record<string, ThinkingActiveEntry>)[
			String(messageTimestamp)
		]
		if (
			(globalState.lastActiveByScopeKey[normalizedScopeKey] as ActiveThinkingState).messageTimestamp ===
			messageTimestamp
		) {
			globalState.lastActiveByScopeKey[normalizedScopeKey] = { active: false }
		}
		return
	}

	if (scopeKey !== undefined) {
		const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey)
		ensureScopeState(normalizedScopeKey)
		globalState.activeByScopeKey[normalizedScopeKey] = {}
		globalState.lastActiveByScopeKey[normalizedScopeKey] = { active: false }
		return
	}

	for (const existingScopeKey of Object.keys(globalState.modeByScopeKey)) {
		ensureScopeState(existingScopeKey)
		globalState.activeByScopeKey[existingScopeKey] = {}
		globalState.lastActiveByScopeKey[existingScopeKey] = { active: false }
	}
}

export function nextThinkingRefreshLabel(label: string, scopeKey?: string): string {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey)
	ensureScopeState(normalizedScopeKey)
	const useInvisibleSuffix = globalState.refreshToggleByScope[normalizedScopeKey] ?? false
	globalState.refreshToggleByScope[normalizedScopeKey] = !useInvisibleSuffix
	return useInvisibleSuffix ? `${label}${LABEL_REFRESH_SUFFIX}` : label
}

export function registerThinkingPatchRelease(scopeKey: string, release: PatchRelease): void {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey)
	ensureScopeState(normalizedScopeKey)
	;(globalState.patchReleasesByScope[normalizedScopeKey] as PatchRelease[]).push(release)
}

export function takeThinkingPatchRelease(scopeKey: string): PatchRelease | undefined {
	const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey)
	ensureScopeState(normalizedScopeKey)
	return (globalState.patchReleasesByScope[normalizedScopeKey] as PatchRelease[]).pop()
}

export function recordThinkingMessageScope(message: object, scopeKey?: string): void {
	const requestedScopeKey = normalizeThinkingScopeKey(scopeKey ?? globalState.currentScopeKey)
	ensureScopeState(requestedScopeKey)

	const existingScopeKey = globalState.messageScopeByObject.get(message)
	const normalizedScopeKey = existingScopeKey ?? requestedScopeKey
	ensureScopeState(normalizedScopeKey)
	if (!existingScopeKey) {
		globalState.messageScopeByObject.set(message, normalizedScopeKey)
	}
	;(globalState.messageObjectsByScope[normalizedScopeKey] as Set<object>).add(message)

	const timestamp =
		typeof (message as { timestamp?: unknown }).timestamp === "number"
			? (message as { timestamp: number }).timestamp
			: undefined
	if (timestamp !== undefined) {
		globalState.messageScopeByTimestamp[String(timestamp)] = normalizedScopeKey
	}
}

export function resolveThinkingMessageScope(message: object, fallbackScopeKey?: string): string {
	const objectScopeKey = globalState.messageScopeByObject.get(message)
	if (objectScopeKey) {
		ensureScopeState(objectScopeKey)
		return objectScopeKey
	}

	const timestamp =
		typeof (message as { timestamp?: unknown }).timestamp === "number"
			? (message as { timestamp: number }).timestamp
			: undefined
	if (timestamp !== undefined) {
		const timestampScopeKey = globalState.messageScopeByTimestamp[String(timestamp)]
		if (timestampScopeKey) {
			ensureScopeState(timestampScopeKey)
			return timestampScopeKey
		}
	}

	const normalizedScopeKey = normalizeThinkingScopeKey(fallbackScopeKey ?? globalState.currentScopeKey)
	ensureScopeState(normalizedScopeKey)
	return normalizedScopeKey
}

export function clearThinkingMessageOwnership(scopeKey?: string): void {
	if (scopeKey !== undefined) {
		const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey)
		ensureScopeState(normalizedScopeKey)
		const ownedMessages = globalState.messageObjectsByScope[normalizedScopeKey] ?? new Set<object>()
		for (const message of ownedMessages) {
			globalState.messageScopeByObject.delete(message)
		}
		globalState.messageObjectsByScope[normalizedScopeKey] = new Set<object>()
		for (const [messageTimestamp, ownerScopeKey] of Object.entries(globalState.messageScopeByTimestamp)) {
			if (ownerScopeKey === normalizedScopeKey) {
				delete globalState.messageScopeByTimestamp[messageTimestamp]
			}
		}
		return
	}

	globalState.messageScopeByObject = new WeakMap<object, string>()
	globalState.messageObjectsByScope = { [DEFAULT_SCOPE_KEY]: new Set<object>() }
	globalState.messageScopeByTimestamp = {}
}

export function resetThinkingStepsViewState(scopeKey?: string): void {
	if (scopeKey !== undefined) {
		const normalizedScopeKey = normalizeThinkingScopeKey(scopeKey)
		globalState.currentScopeKey = normalizedScopeKey
		globalState.modeByScopeKey[normalizedScopeKey] = "summary"
		globalState.refreshToggleByScope[normalizedScopeKey] = false
		globalState.activeByScopeKey[normalizedScopeKey] = {}
		globalState.lastActiveByScopeKey[normalizedScopeKey] = { active: false }
		clearThinkingMessageOwnership(normalizedScopeKey)
		return
	}

	globalState.currentScopeKey = DEFAULT_SCOPE_KEY
	globalState.modeByScopeKey = { [DEFAULT_SCOPE_KEY]: "summary" }
	globalState.activeByScopeKey = { [DEFAULT_SCOPE_KEY]: {} }
	globalState.lastActiveByScopeKey = { [DEFAULT_SCOPE_KEY]: { active: false } }
	globalState.refreshToggleByScope = {}
	clearThinkingMessageOwnership()
}

export function getPatchRefCount(): number {
	return globalState.patchRefCount
}

export function incrementPatchRefCount(): number {
	globalState.patchRefCount += 1
	return globalState.patchRefCount
}

export function decrementPatchRefCount(): number {
	globalState.patchRefCount = Math.max(0, globalState.patchRefCount - 1)
	return globalState.patchRefCount
}

export function getPatchCleanup(): PatchCleanup | undefined {
	return globalState.patchCleanup
}

export function setPatchCleanup(cleanup: PatchCleanup | undefined): void {
	globalState.patchCleanup = cleanup
}

export function getPatchInstallPromise(): PatchInstallPromise | undefined {
	return globalState.patchInstallPromise
}

export function setPatchInstallPromise(installPromise: PatchInstallPromise | undefined): void {
	globalState.patchInstallPromise = installPromise
}

export function setLastThinkingDuration(messageTimestamp: number, durationMs: number): void {
	globalState.lastThinkingMessageTimestamp = messageTimestamp
	globalState.lastThinkingDurationMs = durationMs
}

export function getLastThinkingDuration(): { messageTimestamp: number; durationMs: number } | undefined {
	if (globalState.lastThinkingMessageTimestamp === undefined || globalState.lastThinkingDurationMs === undefined) {
		return undefined
	}
	return { messageTimestamp: globalState.lastThinkingMessageTimestamp, durationMs: globalState.lastThinkingDurationMs }
}
