import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk/unstable"
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { getSessionPermissionFlagController } from "../../extensions/permissions/mode-controller-registry.js"
import type { PermissionMode, SessionPermissionFlagController } from "../../extensions/permissions/types.js"

/** The session surface consumed here is structural so tests and future Pi
 * versions can omit values that ACP has not confirmed yet. modelRuntime and
 * sessionManager are passed through to the existing model-option builder. */
export type SubagentConfigSession = {
	-readonly [K in "model" | "modelRuntime" | "routedModel" | "sessionId" | "sessionManager"]: AgentSession[K]
} & {
	modelRegistry?: ModelRegistry
	thinkingLevel?: AgentSession["thinkingLevel"]
}

export type SubagentThinkingConfig = {
	model: NonNullable<AgentSession["model"]>
	thinkingLevel: AgentSession["thinkingLevel"]
}

/** Inject the server's existing definitions rather than importing server.ts
 * (which owns this reporter's orchestrator) or forking ACP option builders. */
export interface SubagentConfigBuilders {
	buildPermissionsConfigOption(currentMode: PermissionMode): SessionConfigOption
	buildModelConfigOption(session: SubagentConfigSession): SessionConfigOption
	buildThinkingConfigOption(session: SubagentThinkingConfig): SessionConfigOption | null
}

export interface SubagentConfigDependencies extends SubagentConfigBuilders {
	/** Defaults to the real session registry; injectable for isolated tests. */
	getPermissionFlagController?(sessionId: string): SessionPermissionFlagController | undefined
	/** Resolve the child's own persisted/runtime default when no controller exists yet. */
	getEffectivePermissionMode?(sessionId: string): PermissionMode | undefined
}

export type SendSubagentConfigUpdate = (notification: SessionNotification) => void

function permissionController(
	sessionId: string,
	dependencies: SubagentConfigDependencies,
): SessionPermissionFlagController | undefined {
	return (dependencies.getPermissionFlagController ?? getSessionPermissionFlagController)(sessionId)
}

/** Build the complete replacement list for one child. Every value is read
 * from that child (or its own controller); an absent value omits its option.
 * In particular, no parent session or default permission mode is consulted. */
export function buildSubagentConfigOptions(
	session: SubagentConfigSession,
	dependencies: SubagentConfigDependencies,
): SessionConfigOption[] {
	const options: SessionConfigOption[] = []
	const mode =
		permissionController(session.sessionId, dependencies)?.getMode().mode ??
		dependencies.getEffectivePermissionMode?.(session.sessionId)
	if (mode !== undefined) options.push(dependencies.buildPermissionsConfigOption(mode))

	// The existing model builder requires a selected model. Unlike root ACP
	// sessions, an exposed child may still be initializing, so absence is an
	// unconfirmed value rather than an error or a reason to borrow the parent's.
	if (session.model) options.push(dependencies.buildModelConfigOption(session))

	// A virtual selection's latest physical response is authoritative for the
	// reasoning capabilities and effective effort. Until one exists, use the
	// child's requested model/effort; never infer either from an ancestor.
	const thinkingModel = session.routedModel?.model ?? session.model
	const thinkingLevel = session.routedModel?.thinkingLevel ?? session.thinkingLevel
	if (thinkingModel && thinkingLevel !== undefined) {
		const thinking = dependencies.buildThinkingConfigOption({ model: thinkingModel, thinkingLevel })
		if (thinking) options.push(thinking)
	}
	return options
}

export function subagentConfigNotification(
	childSessionId: string,
	configOptions: SessionConfigOption[],
): SessionNotification {
	return {
		sessionId: childSessionId,
		update: { sessionUpdate: "config_option_update", configOptions },
	}
}

function fingerprint(configOptions: SessionConfigOption[]): string {
	return JSON.stringify(configOptions)
}

/** Per-child initial/change-only publisher. The reporter only reads runtime
 * state; its mutable bookkeeping is limited to deduplication and one mode
 * subscription. Call publishChanged from child session events, and dispose
 * with the child projection. Permission changes publish through the child's
 * own controller without requiring a synthetic session event. */
export class SubagentConfigReporter {
	private lastFingerprint: string | undefined
	private subscribedController: SessionPermissionFlagController | undefined
	private subscribedSend: SendSubagentConfigUpdate | undefined
	private unsubscribePermission: (() => void) | undefined

	constructor(
		private readonly session: SubagentConfigSession,
		private readonly dependencies: SubagentConfigDependencies,
	) {}

	/** Always emits exactly once, including an empty list when all values are
	 * unconfirmed. Invoke directly after the child's announcement. */
	publishInitial(send: SendSubagentConfigUpdate): SessionNotification {
		const configOptions = buildSubagentConfigOptions(this.session, this.dependencies)
		const notification = subagentConfigNotification(this.session.sessionId, configOptions)
		this.lastFingerprint = fingerprint(configOptions)
		send(notification)
		this.syncPermissionSubscription(send)
		return notification
	}

	/** Emits only when the complete client-visible snapshot changed. Repeated
	 * model events, route resolutions with identical options, and duplicate
	 * mode notifications therefore stay silent. */
	publishChanged(send: SendSubagentConfigUpdate): SessionNotification | undefined {
		this.syncPermissionSubscription(send)
		const configOptions = buildSubagentConfigOptions(this.session, this.dependencies)
		const nextFingerprint = fingerprint(configOptions)
		if (nextFingerprint === this.lastFingerprint) return undefined
		this.lastFingerprint = nextFingerprint
		const notification = subagentConfigNotification(this.session.sessionId, configOptions)
		send(notification)
		return notification
	}

	private syncPermissionSubscription(send: SendSubagentConfigUpdate): void {
		const controller = permissionController(this.session.sessionId, this.dependencies)
		if (controller === this.subscribedController && send === this.subscribedSend) return
		this.unsubscribePermission?.()
		this.subscribedController = controller
		this.subscribedSend = send
		this.unsubscribePermission = controller?.subscribe(() => {
			this.publishChanged(send)
		})
	}

	/** Invalidates client-confirmed state without discarding the child's
	 * own configuration source or its live permission subscription. */
	invalidate(): void {
		this.lastFingerprint = undefined
	}

	dispose(): void {
		this.unsubscribePermission?.()
		this.unsubscribePermission = undefined
		this.subscribedController = undefined
		this.subscribedSend = undefined
	}
}
