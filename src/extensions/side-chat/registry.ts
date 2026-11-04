/**
 * In-process handoff between the side-chat extension instances (which own the
 * per-session SideChatAcpBridge) and the ACP server's ext-method dispatch
 * (which receives client requests routed by sessionId). Both run in the same
 * process; the ACP server cannot reach a session's pi.events bus, so the
 * bridge is looked up here by session id — the same module-level pattern as
 * the plan-review context store.
 */

import type { SideChatAcpBridge } from "./acp-bridge.js"

const bridges = new Map<string, SideChatAcpBridge>()

type BridgeRegisterListener = (sessionId: string, bridge: SideChatAcpBridge) => void
const registerListeners = new Set<BridgeRegisterListener>()

/**
 * Notified when a session's bridge registers. The ACP server uses this to
 * attach update forwarding even when the bridge appears before the session
 * entry is stored (extension session_start runs during session creation).
 */
export function onSideChatBridgeRegistered(listener: BridgeRegisterListener): () => void {
	registerListeners.add(listener)
	return () => registerListeners.delete(listener)
}

/** Register the session's bridge; returns the unregister handle. */
export function registerSideChatBridge(sessionId: string, bridge: SideChatAcpBridge): () => void {
	bridges.set(sessionId, bridge)
	for (const listener of registerListeners) listener(sessionId, bridge)
	return () => {
		if (bridges.get(sessionId) === bridge) bridges.delete(sessionId)
	}
}

export function getSideChatBridge(sessionId: string): SideChatAcpBridge | undefined {
	return bridges.get(sessionId)
}

/** Test hook: drop every registered bridge and register listener. */
export function resetSideChatBridges(): void {
	bridges.clear()
	registerListeners.clear()
}
