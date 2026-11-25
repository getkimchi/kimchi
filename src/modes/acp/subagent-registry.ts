import type { SessionNotification } from "@agentclientprotocol/sdk/unstable"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { SubagentConfigReporter } from "./subagent-config.js"
import {
	collectRecoveredSubagents,
	type RecoveredSubagent,
	type RecoveredSubagentState,
	recoveredSubagentState,
} from "./subagent-recovery.js"
import {
	absoluteSubagentCwd,
	type SubagentSessionCreatedEvent,
	subagentAnnouncement,
	subagentReplayPromptMessages,
	subagentTitle,
} from "./subagents.js"

export interface ChildProjectionRecord {
	session: AgentSession
	cwd: string
	unsubscribe: () => void
	turn?: { cancelled: boolean }
	unsolicitedTurn?: { cancelled: boolean }
	unsolicitedCancelRequested?: boolean
	planTracker?: { stop(): void }
}

export interface SubagentRoute<T extends ChildProjectionRecord> {
	parentSessionId: string
	parentToolCallId: string
	record: T
	configReporter: SubagentConfigReporter
	cleanupInteraction: () => void
	background: boolean
	original: SubagentSessionCreatedEvent
	abort?: SubagentSessionCreatedEvent["abort"]
	cancelRequested?: boolean
	state?: RecoveredSubagentState
	pendingState?: RecoveredSubagentState
	pendingPrompt?: SessionNotification[]
}

interface RecoveredRoute<T extends ChildProjectionRecord> {
	association: RecoveredSubagent
	state?: RecoveredSubagentState
	record?: T
	configReporter?: SubagentConfigReporter
}

export interface RecoveredProjection<T extends ChildProjectionRecord> {
	record: T
	configReporter: SubagentConfigReporter
}

export interface SubagentRegistryDependencies<T extends ChildProjectionRecord> {
	enabled(): boolean
	send(notification: SessionNotification): void
	rootExists(sessionId: string): boolean
	loadRecovered(association: RecoveredSubagent): Promise<RecoveredProjection<T>>
	projectReplay(association: RecoveredSubagent, session: AgentSession): RecoveredProjection<T>
	replay(
		parentSessionId: string,
		association: RecoveredSubagent,
		projection: RecoveredProjection<T>,
		replayHistory: boolean,
	): void
}

function stateNotification(
	parentSessionId: string,
	childId: string,
	state: RecoveredSubagentState,
): SessionNotification {
	return { sessionId: parentSessionId, update: { sessionUpdate: "subagent_update", sessionId: childId, state } }
}

function replacedAnnouncement(
	parentSessionId: string,
	childId: string,
	state: RecoveredSubagentState = { state: "unknown" },
	association?: RecoveredSubagent,
): SessionNotification {
	return {
		sessionId: parentSessionId,
		update: {
			sessionUpdate: "subagent_update",
			sessionId: childId,
			...(association
				? {
						title: subagentTitle(association.description),
						description: association.description,
						cwd: association.cwd,
						additionalDirectories: [],
					}
				: {}),
			capabilities: {},
			state,
		},
	}
}

function currentNotification<T extends ChildProjectionRecord>(route: SubagentRoute<T>): SessionNotification {
	const active = route.state?.state === "running" || route.state?.state === "requires_action"
	return {
		sessionId: route.parentSessionId,
		update: {
			sessionUpdate: "subagent_update",
			sessionId: route.original.sessionId,
			capabilities: active && route.abort ? { cancel: {} } : {},
			state: route.state ?? { state: "unknown" },
		},
	}
}

function disposeProjection<T extends ChildProjectionRecord>(projection: RecoveredProjection<T>): void {
	projection.configReporter.dispose()
	projection.record.planTracker?.stop()
	projection.record.unsubscribe()
	const resources = projection.record.session.resourceLoader as { dispose?: () => void } | undefined
	resources?.dispose?.()
	projection.record.session.dispose()
}

/** Parent-scoped child identity, lifecycle and replay. The server remains the
 * protocol/event adapter; this registry has no process-global manager lookup
 * and never starts a prompt or binds a child extension on the ACP surface. */
export class SubagentRegistry<T extends ChildProjectionRecord> {
	private readonly live = new Map<string, SubagentRoute<T>>()
	private readonly recovered = new Map<string, Map<string, RecoveredRoute<T>>>()
	private readonly recovering = new Map<string, object>()
	private readonly byParentTool = new Map<string, Map<string, string>>()

	constructor(private readonly dependencies: SubagentRegistryDependencies<T>) {}

	getLive(childId: string): SubagentRoute<T> | undefined {
		return this.live.get(childId)
	}

	has(childId: string): boolean {
		if (this.live.has(childId)) return true
		for (const children of this.recovered.values()) if (children.has(childId)) return true
		return false
	}

	childForTool(parentSessionId: string, toolCallId: string, upstreamId: string): string | undefined {
		const mapped = this.byParentTool.get(parentSessionId)
		return mapped?.get(toolCallId) ?? mapped?.get(upstreamId)
	}

	retireTool(parentSessionId: string, toolCallId: string): void {
		const mapped = this.byParentTool.get(parentSessionId)
		mapped?.delete(toolCallId)
		if (mapped?.size === 0) this.byParentTool.delete(parentSessionId)
	}

	release(childId: string): void {
		const child = this.live.get(childId)
		if (!child) return
		child.record.planTracker?.stop()
		child.record.unsubscribe()
		child.configReporter.dispose()
		child.cleanupInteraction()
		this.live.delete(childId)
		this.retireTool(child.parentSessionId, child.parentToolCallId)
	}

	register(event: SubagentSessionCreatedEvent, route: Omit<SubagentRoute<T>, "original" | "state">): void {
		const child: SubagentRoute<T> = { ...route, original: event, state: { state: "running" } }
		this.live.set(event.sessionId, child)
		let byTool = this.byParentTool.get(event.parentSessionId)
		if (!byTool) {
			byTool = new Map()
			this.byParentTool.set(event.parentSessionId, byTool)
		}
		byTool.set(event.toolCallId, event.sessionId)

		const pending = this.recovering.has(event.parentSessionId)
		const liveAnnouncement = subagentAnnouncement(event.parentSessionId, event, route.record.cwd)
		const announcement = pending
			? {
					...liveAnnouncement,
					update: { ...liveAnnouncement.update, state: { state: "unknown" }, capabilities: {} },
				}
			: liveAnnouncement
		if (pending) {
			child.state = undefined
			child.pendingState = { state: "running" }
			child.pendingPrompt = subagentReplayPromptMessages(event.parentSessionId, event)
		}
		this.dependencies.send(announcement)
		if (pending) return
		child.configReporter.publishInitial(this.dependencies.send)
		for (const message of subagentReplayPromptMessages(event.parentSessionId, event)) this.dependencies.send(message)
	}

	publishConfig(childId: string): void {
		const child = this.live.get(childId)
		if (!child) return
		child.configReporter.publishChanged((params) => {
			if (!this.recovering.has(child.parentSessionId)) this.dependencies.send(params)
		})
	}

	publishState(childId: string, state: RecoveredSubagentState): void {
		const child = this.live.get(childId)
		if (!child) return
		if (this.recovering.has(child.parentSessionId)) {
			child.pendingState = state
			return
		}
		child.state = state
		this.dependencies.send(stateNotification(child.parentSessionId, childId, state))
	}

	/** Admit client cancellation only while its capability is published.
	 * Pending and failed parent recovery leave state undefined. Parent-driven
	 * cancellation and close still use stopParent and must not be blocked here. */
	canAcceptCancellation(childId: string): boolean {
		const child = this.live.get(childId)
		return child?.abort !== undefined && (child.state?.state === "running" || child.state?.state === "requires_action")
	}

	async stop(childId: string): Promise<boolean> {
		const child = this.live.get(childId)
		if (!child) return false
		const cancellation = child.abort?.()
		if (!cancellation) return false
		if (cancellation.accepted) {
			child.cancelRequested = true
			if (child.record.unsolicitedTurn) child.record.unsolicitedTurn.cancelled = true
			else child.record.unsolicitedCancelRequested = true
		}
		// A second cancel while native shutdown is still settling must await it
		// too; `accepted:false` is not proof that the run has stopped.
		await cancellation.stopped
		return cancellation.accepted
	}

	async stopParent(parentSessionId: string, includeBackground: boolean): Promise<void> {
		const stops: Promise<boolean>[] = []
		for (const child of this.live.values()) {
			if (child.parentSessionId === parentSessionId && (includeBackground || !child.background)) {
				stops.push(this.stop(child.original.sessionId))
			}
		}
		await Promise.all(stops)
	}

	begin(parentSessionId: string): object | undefined {
		if (!this.dependencies.enabled()) return undefined
		const request = {}
		this.recovering.set(parentSessionId, request)
		for (const [childId, child] of this.live) {
			if (child.parentSessionId !== parentSessionId) continue
			child.pendingState = child.state
			child.state = undefined
			child.configReporter.invalidate()
			this.dependencies.send(replacedAnnouncement(parentSessionId, childId))
		}
		for (const [childId, child] of this.recovered.get(parentSessionId) ?? []) {
			child.state = undefined
			child.configReporter?.invalidate()
			this.dependencies.send(replacedAnnouncement(parentSessionId, childId, { state: "unknown" }, child.association))
		}
		return request
	}

	discard(parentSessionId: string, request: object | undefined): void {
		if (!request || this.recovering.get(parentSessionId) !== request) return
		this.recovering.delete(parentSessionId)
		for (const child of this.live.values()) {
			if (child.parentSessionId !== parentSessionId) continue
			child.state = undefined
			child.pendingState = undefined
			child.pendingPrompt = undefined
			child.configReporter.invalidate()
		}
		for (const child of this.recovered.get(parentSessionId)?.values() ?? []) {
			child.state = undefined
			child.configReporter?.invalidate()
		}
	}

	complete(parentSessionId: string, request: object | undefined): void {
		if (!request || this.recovering.get(parentSessionId) !== request) return
		this.recovering.delete(parentSessionId)
		// The SDK responds in its microtask chain; publication belongs strictly
		// after a successful parent response, not after a failed load/resume.
		setImmediate(() => {
			if (!this.dependencies.rootExists(parentSessionId)) return
			for (const child of this.live.values()) {
				if (child.parentSessionId !== parentSessionId) continue
				child.state = child.pendingState
				child.pendingState = undefined
				for (const message of child.pendingPrompt ?? []) this.dependencies.send(message)
				child.pendingPrompt = undefined
				this.dependencies.send(currentNotification(child))
				child.configReporter.publishInitial(this.dependencies.send)
			}
			for (const [childId, child] of this.recovered.get(parentSessionId) ?? []) {
				child.state = recoveredSubagentState(child.association)
				this.dependencies.send(replacedAnnouncement(parentSessionId, childId, child.state, child.association))
				if (child.configReporter) child.configReporter.publishInitial(this.dependencies.send)
				else {
					this.dependencies.send({
						sessionId: childId,
						update: { sessionUpdate: "config_option_update", configOptions: [] },
					})
				}
			}
		})
	}

	async replay(session: AgentSession, replayHistory: boolean): Promise<void> {
		if (!this.dependencies.enabled()) return
		const parentSessionId = session.sessionId
		const associations = collectRecoveredSubagents(session.sessionManager.getBranch(), {
			sessionId: parentSessionId,
			sessionFile: session.sessionManager.getSessionFile(),
			previousSessionFile: session.sessionManager.getHeader()?.parentSession,
		})
		const byTool = new Map<string, string>()
		for (const [childId, child] of this.live) {
			if (child.parentSessionId === parentSessionId) byTool.set(child.parentToolCallId, childId)
		}
		const previous = this.recovered.get(parentSessionId) ?? new Map()
		const next = new Map<string, RecoveredRoute<T>>()
		for (const association of associations) {
			byTool.set(association.toolCallId, association.sessionId)
			const live = this.live.get(association.sessionId)
			if (live?.parentSessionId === parentSessionId) {
				if (!replayHistory) continue
				const projection = this.dependencies.projectReplay(association, live.record.session)
				try {
					for (const message of subagentReplayPromptMessages(parentSessionId, association)) {
						this.dependencies.send(message)
					}
					this.dependencies.replay(parentSessionId, association, projection, true)
				} finally {
					projection.configReporter.dispose()
				}
				continue
			}
			const cwd = absoluteSubagentCwd(association.cwd, session.sessionManager.getCwd())
			const event = { ...association, cwd }
			let projection: RecoveredProjection<T> | undefined
			try {
				projection = await this.dependencies.loadRecovered(event)
				if (projection.record.session.sessionId !== association.sessionId) {
					disposeProjection(projection)
					projection = undefined
					next.set(association.sessionId, { association: event })
					this.dependencies.send(replacedAnnouncement(parentSessionId, association.sessionId, undefined, event))
					continue
				}
				next.set(association.sessionId, { association: event, ...projection })
				this.dependencies.send(replacedAnnouncement(parentSessionId, association.sessionId, undefined, event))
				for (const message of subagentReplayPromptMessages(parentSessionId, association)) {
					if (replayHistory && association.prompt.length > 0) this.dependencies.send(message)
				}
				this.dependencies.replay(parentSessionId, event, projection, replayHistory)
			} catch {
				if (projection) disposeProjection(projection)
				// An unreadable child history cannot invalidate an otherwise valid
				// parent load. Its configuration remains explicitly unconfirmed.
				next.set(association.sessionId, { association: event })
				this.dependencies.send(replacedAnnouncement(parentSessionId, association.sessionId, undefined, event))
			}
		}
		for (const old of previous.values()) {
			if (old.record && old.configReporter) {
				disposeProjection({ record: old.record, configReporter: old.configReporter })
			}
		}
		this.recovered.set(parentSessionId, next)
		this.byParentTool.set(parentSessionId, byTool)
	}

	/** Drop request-scoped historical projections after any parent replay
	 * failure. Existing client history remains on the wire; no state or config
	 * from the failed request becomes current. Live child ownership is intact. */
	clearRecovered(parentSessionId: string): void {
		for (const child of this.recovered.get(parentSessionId)?.values() ?? []) {
			if (child.record && child.configReporter) {
				disposeProjection({ record: child.record, configReporter: child.configReporter })
			}
		}
		const associations = new Map<string, RecoveredRoute<T>>()
		for (const [childId, child] of this.recovered.get(parentSessionId) ?? []) {
			associations.set(childId, { association: child.association })
		}
		this.recovered.set(parentSessionId, associations)
		this.byParentTool.delete(parentSessionId)
		for (const [childId, child] of this.live) {
			if (child.parentSessionId !== parentSessionId) continue
			let byTool = this.byParentTool.get(parentSessionId)
			if (!byTool) {
				byTool = new Map()
				this.byParentTool.set(parentSessionId, byTool)
			}
			byTool.set(child.parentToolCallId, childId)
		}
	}

	cleanup(parentSessionId: string): void {
		this.recovering.delete(parentSessionId)
		for (const [childId, child] of this.live) {
			if (child.parentSessionId !== parentSessionId) continue
			child.record.planTracker?.stop()
			child.record.unsubscribe()
			child.configReporter.dispose()
			child.cleanupInteraction()
			this.live.delete(childId)
		}
		for (const child of this.recovered.get(parentSessionId)?.values() ?? []) {
			if (child.record && child.configReporter) {
				disposeProjection({ record: child.record, configReporter: child.configReporter })
			}
		}
		this.recovered.delete(parentSessionId)
		this.byParentTool.delete(parentSessionId)
	}
}
