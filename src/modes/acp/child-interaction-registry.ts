import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import { getAcpPrompter } from "./permission-prompter-registry.js"

/** Transports installed when the server announces a native child to an ACP client. */
export interface AcpChildInteractionRegistration {
	childSessionId: string
	parentSessionId: string
	permissionPrompter: ToolPermissionPrompter
	uiContext: ExtensionUIContext
	/**
	 * Called when the child starts/stops waiting for a permission or elicitation.
	 * Concurrent requests are aggregated: true is emitted for the first waiter and
	 * false only after the last waiter settles. Cleanup also clears a live wait.
	 */
	onRequiresActionChange?: (requiresAction: boolean) => void
}

type ChildInteraction = AcpChildInteractionRegistration & {
	pendingRequests: number
	waiting: boolean
}

const children = new Map<string, ChildInteraction[]>()
const parentByChild = new Map<string, string[]>()
const rootUiBySession = new Map<string, ExtensionUIContext[]>()

function latest<T>(values: T[] | undefined): T | undefined {
	return values?.[values.length - 1]
}

function removeLatest<T>(values: T[] | undefined, expected: T): boolean {
	if (!values) return false
	const index = values.lastIndexOf(expected)
	if (index < 0) return false
	values.splice(index, 1)
	return true
}

function notifyWaiting(interaction: ChildInteraction, waiting: boolean): void {
	if (interaction.waiting === waiting) return
	interaction.waiting = waiting
	interaction.onRequiresActionChange?.(waiting)
}

function cleanupRegistration<T>(map: Map<string, T[]>, key: string, expected: T): void {
	const values = map.get(key)
	if (!removeLatest(values, expected)) return
	if (values?.length === 0) map.delete(key)
}

/** Register the root UI used as the fallback for that root's unexposed workers. */
export function registerAcpRootUIContext(sessionId: string, uiContext: ExtensionUIContext): () => void {
	const values = rootUiBySession.get(sessionId) ?? []
	values.push(uiContext)
	rootUiBySession.set(sessionId, values)
	let cleaned = false
	return () => {
		if (cleaned) return
		cleaned = true
		cleanupRegistration(rootUiBySession, sessionId, uiContext)
	}
}

/**
 * Associate a worker with its owning root before extension binding. This is
 * deliberately parent-scoped; no process-global manager is consulted.
 */
export function registerAcpWorkerSession(childSessionId: string, parentSessionId: string): () => void {
	const values = parentByChild.get(childSessionId) ?? []
	values.push(parentSessionId)
	parentByChild.set(childSessionId, values)
	let cleaned = false
	return () => {
		if (cleaned) return
		cleaned = true
		cleanupRegistration(parentByChild, childSessionId, parentSessionId)
	}
}

/** Install child-native permission/elicitation transports at announcement time. */
export function registerAcpChildInteraction(registration: AcpChildInteractionRegistration): () => void {
	const interaction: ChildInteraction = { ...registration, pendingRequests: 0, waiting: false }
	const values = children.get(registration.childSessionId) ?? []
	values.push(interaction)
	children.set(registration.childSessionId, values)
	let cleaned = false
	return () => {
		if (cleaned) return
		cleaned = true
		notifyWaiting(interaction, false)
		cleanupRegistration(children, registration.childSessionId, interaction)
	}
}

export function resolveAcpInteractionPrompter(sessionId: string): ToolPermissionPrompter | undefined {
	const child = latest(children.get(sessionId))
	if (child) return child.permissionPrompter
	const parentSessionId = latest(parentByChild.get(sessionId))
	return getAcpPrompter(parentSessionId ?? sessionId)
}

export function getAcpRootUIContext(sessionId: string): ExtensionUIContext | undefined {
	return latest(rootUiBySession.get(sessionId))
}

function resolveUIContext(sessionId: string): ExtensionUIContext | undefined {
	const child = latest(children.get(sessionId))
	if (child) return child.uiContext
	const parentSessionId = latest(parentByChild.get(sessionId))
	return getAcpRootUIContext(parentSessionId ?? sessionId)
}

/**
 * Run one blocking interaction against the registration captured at its start.
 * Later announcements/registrations cannot move that in-flight request to a
 * different transport, and settlement clears the state hook exactly once.
 */
export async function withAcpInteraction<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
	const interaction = latest(children.get(sessionId))
	if (!interaction?.onRequiresActionChange) return run()
	interaction.pendingRequests++
	if (interaction.pendingRequests === 1) notifyWaiting(interaction, true)
	try {
		return await run()
	} finally {
		interaction.pendingRequests = Math.max(0, interaction.pendingRequests - 1)
		if (interaction.pendingRequests === 0) notifyWaiting(interaction, false)
	}
}

const NOOP_THEME = new Proxy({} as ExtensionUIContext["theme"], {
	get(_target, property) {
		if (property === "then" || property === "catch") return undefined
		return () => undefined
	},
})

/**
 * Lazy, per-call UI forwarding for one worker. The destination is captured at
 * invocation, so a request that began through the parent remains there even if
 * the child is announced while the request is pending.
 */
export function createAcpWorkerUIContext(childSessionId: string): ExtensionUIContext | undefined {
	if (!resolveUIContext(childSessionId)) return undefined
	return new Proxy({} as ExtensionUIContext, {
		get(_target, property: keyof ExtensionUIContext | "then") {
			if (property === "then") return undefined
			if (property === "theme") return resolveUIContext(childSessionId)?.theme ?? NOOP_THEME
			return (...args: unknown[]) => {
				const ui = resolveUIContext(childSessionId)
				const member = ui?.[property] as ((...methodArgs: unknown[]) => unknown) | undefined
				if (member) return member.apply(ui, args)
				switch (property) {
					case "onTerminalInput":
						return () => {}
					case "custom":
						return Promise.resolve(undefined)
					case "getEditorText":
						return ""
					case "getToolsExpanded":
						return false
					case "getAllThemes":
						return []
					default:
						return undefined
				}
			}
		},
	})
}

/** Test-only lifecycle reset. Production cleanup is registration-scoped. */
export function resetAcpInteractionRegistriesForTests(): void {
	children.clear()
	parentByChild.clear()
	rootUiBySession.clear()
}
