import type { ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"
import {
	registerSessionPermissionPrompter,
	type SessionPermissionPrompterSource,
} from "../../extensions/permissions/session-prompter-registry.js"

interface AcpPrompterRegistration {
	prompter: ToolPermissionPrompter
	source: SessionPermissionPrompterSource
	remove: () => void
}

// MULTI-OWNER slots: concurrent same-id attaches (load+resume coalesce
// separately) can both register before either installs its record — a plain
// Map.set could displace a LIVE winner's entry, after which the loser's
// legitimately identity-checked teardown would evict it. Registrations
// push; identity-checked removals pop only their own object; lookups read
// the latest registration. Keep this paired with every ACP session
// ownership path: load/new register, bind failures, session/close, and
// process shutdown all need symmetric cleanup.
const bySessionId = new Map<string, AcpPrompterRegistration[]>()

export function registerAcpPrompter(sessionId: string, prompter: ToolPermissionPrompter): void {
	const list = bySessionId.get(sessionId) ?? []
	const source: SessionPermissionPrompterSource = {
		// Only select this transport in the context the host actually owns.
		// Broadcasting a session must not steal another host's terminal prompt.
		canPromptDirectly: (ctx) => ctx.mode === "rpc",
		resolve: (ctx) => (ctx.mode === "rpc" ? prompter : undefined),
	}
	const registration: AcpPrompterRegistration = {
		prompter,
		source,
		remove: registerSessionPermissionPrompter(sessionId, source),
	}
	list.push(registration)
	bySessionId.set(sessionId, list)
}

/**
 * Id keys recycle across concurrent attaches and respawns, so a caller that
 * registered a SPECIFIC prompter passes it back for an identity check —
 * removing by key alone could evict another (winning, still-live) session's
 * prompter. Without `expected`, the whole slot is dropped (legacy cleanup
 * paths). Returns whether the requested removal left the slot EMPTY.
 */
export function unregisterAcpPrompter(sessionId: string, expected?: ToolPermissionPrompter): boolean {
	const list = bySessionId.get(sessionId)
	if (!list) return true
	if (expected === undefined) {
		bySessionId.delete(sessionId)
		for (const registration of list) registration.remove()
		return true
	}
	const idx = list.findLastIndex((registration) => registration.prompter === expected)
	if (idx < 0) return list.length === 0
	for (const registration of list.splice(idx, 1)) registration.remove()
	if (list.length === 0) {
		bySessionId.delete(sessionId)
		return true
	}
	return false
}

export function getAcpPrompter(sessionId: string): ToolPermissionPrompter | undefined {
	const list = bySessionId.get(sessionId)
	return list?.[list.length - 1]?.prompter
}
