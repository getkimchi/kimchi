/**
 * Non-aborting inline adaptation of AgentSession.compact().
 *
 * Caller contract (enforced where possible):
 * - Call from an awaited extension handler at a turn boundary (turn_end /
 *   agent_end) or while the session is idle.
 * - No unpaired toolCall in the current branch.
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import {
	AgentSession,
	buildSessionContext,
	type CompactionResult,
	ExtensionRunner,
} from "@earendil-works/pi-coding-agent"
import { isToolCallInFlight } from "./tool-call-in-flight.js"

export interface InlineCompactOptions {
	customInstructions?: string
	force?: boolean
	keepRecentTokens?: number
	/** Override model for the summarization call. */
	model?: Model<Api>
	/** Override thinking level for the summarization call. */
	thinkingLevel?: ModelThinkingLevel
}

type PatchableSession = Pick<AgentSession, "abort" | "sessionManager" | "settingsManager"> & {
	_compactionAbortController?: AbortController
	_autoCompactionAbortController?: AbortController
	_kimchiInlineCompactInFlight?: boolean
	_disconnectFromAgent: () => void
	inlineCompact?(options?: InlineCompactOptions): Promise<CompactionResult>
}

type UpstreamCompact = AgentSession["compact"]

type PatchableSessionPrototype = {
	_kimchiInlineCompactPatch?: boolean
	inlineCompact?: (this: PatchableSession, options?: InlineCompactOptions) => Promise<CompactionResult>
	compact?: (
		this: PatchableSession,
		customInstructions?: Parameters<UpstreamCompact>[0],
		force?: boolean,
	) => ReturnType<UpstreamCompact>
	_bindExtensionCore?: (this: PatchableSession, runner: PatchableRunnerInstance) => unknown
}

type PatchableSessionClass = {
	prototype: PatchableSessionPrototype
}

type PatchableRunnerInstance = {
	_kimchiInlineCompact?: (options?: InlineCompactOptions) => Promise<CompactionResult>
	assertActive?: () => void
}

type PatchableRunnerPrototype = {
	_kimchiInlineCompactContextPatch?: boolean
	createContext?: (this: PatchableRunnerInstance) => object
}

type PatchableRunnerClass = {
	prototype: PatchableRunnerPrototype
}

export interface InlineCompactPatchOptions {
	sessionClass?: PatchableSessionClass
	runnerClass?: PatchableRunnerClass
}

/**
 * Temporarily replace `target[key]` with `value`, returning a restore
 * function. Handles both own properties (fakes, per-instance state) and
 * prototype members (real AgentSession methods and accessors): a prototype
 * member is shadowed by defining an own property and restored by deleting it,
 * which re-exposes the prototype lookup.
 */
function shadowProperty(target: object, key: string, value: unknown): () => void {
	const record = target as Record<string, unknown>
	const ownDescriptor = Object.getOwnPropertyDescriptor(target, key)
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: ownDescriptor?.enumerable ?? false,
		writable: true,
		value,
	})
	return () => {
		if (ownDescriptor) {
			Object.defineProperty(target, key, ownDescriptor)
		} else {
			delete record[key]
		}
	}
}

/** Fail fast if upstream compact internals no longer match the inline patch. */
function assertCompactInternalsCompatible(sessionProto: PatchableSessionPrototype): void {
	const compactSource = typeof sessionProto.compact === "function" ? String(sessionProto.compact) : ""
	if (!compactSource.includes("_disconnectFromAgent") || !compactSource.includes("abort")) {
		throw new Error(
			"pi-coding-agent AgentSession.compact() is incompatible with Kimchi inline compaction " +
				"(expected it to quiesce via _disconnectFromAgent/abort — upstream internals changed)",
		)
	}
}

async function runInlineCompact(
	session: PatchableSession,
	originalCompact: NonNullable<PatchableSessionPrototype["compact"]>,
	options: InlineCompactOptions,
): Promise<CompactionResult> {
	if (
		session._kimchiInlineCompactInFlight ||
		session._compactionAbortController ||
		session._autoCompactionAbortController
	) {
		throw new Error("Compaction already in progress")
	}

	// Safety assertion (not deferral — callers wanting deferral must check
	// before calling): compacting across an unpaired toolCall summarises away
	// the assistant toolCall and orphans the toolResult appended later. Pi's
	// context builder applies the active branch and latest compaction boundary.
	const activeMessages = buildSessionContext(session.sessionManager.getBranch()).messages
	if (isToolCallInFlight(activeMessages)) {
		throw new Error(
			"inlineCompact called while a tool call is in flight — callers must defer to a turn boundary with no unpaired toolCall",
		)
	}

	session._kimchiInlineCompactInFlight = true
	const restores: Array<() => void> = []

	try {
		// One-shot suppression of the quiesce pair. Any later abort() during
		// summarization is a genuine cancellation request.
		const realDisconnect = session._disconnectFromAgent
		const realAbort = session.abort
		let disconnectSuppressed = false
		let abortSuppressed = false
		restores.push(
			shadowProperty(session, "_disconnectFromAgent", function inlineShadowedDisconnect(this: PatchableSession) {
				if (!disconnectSuppressed) {
					disconnectSuppressed = true
					return
				}
				return realDisconnect.call(this)
			}),
			shadowProperty(session, "abort", async function inlineShadowedAbort(this: PatchableSession) {
				if (!abortSuppressed) {
					abortSuppressed = true
					return
				}
				this._compactionAbortController?.abort()
				return realAbort.call(this)
			}),
		)

		// force means "compact everything before the newest valid cut point".
		if (options.force || options.keepRecentTokens !== undefined) {
			const settingsManager = session.settingsManager
			const realGetCompactionSettings = settingsManager.getCompactionSettings
			const keepRecentTokens = options.keepRecentTokens ?? 0
			restores.push(
				shadowProperty(settingsManager, "getCompactionSettings", function inlineShadowedSettings() {
					return { ...realGetCompactionSettings.call(settingsManager), keepRecentTokens }
				}),
			)
		}

		// compact() reads these properties for auth and summarization.
		if (options.model !== undefined) {
			restores.push(shadowProperty(session, "model", options.model))
		}
		if (options.thinkingLevel !== undefined) {
			restores.push(shadowProperty(session, "thinkingLevel", options.thinkingLevel))
		}

		return await originalCompact.call(session, options.customInstructions, options.force ?? false)
	} finally {
		session._kimchiInlineCompactInFlight = false
		for (const restore of restores.reverse()) {
			restore()
		}
	}
}

export function installInlineCompactPatch(options: InlineCompactPatchOptions = {}): void {
	const sessionClass = options.sessionClass ?? (AgentSession as unknown as PatchableSessionClass)
	const runnerClass = options.runnerClass ?? (ExtensionRunner as unknown as PatchableRunnerClass)

	const sessionProto = sessionClass.prototype
	if (!sessionProto.compact || !sessionProto._bindExtensionCore) {
		const missing = [
			!sessionProto.compact && "AgentSession.compact()",
			!sessionProto._bindExtensionCore && "AgentSession._bindExtensionCore()",
		].filter(Boolean)
		throw new Error(
			`pi-coding-agent AgentSession internals are incompatible with Kimchi inline compaction (missing ${missing.join(" and ")} — upstream internals changed)`,
		)
	}
	assertCompactInternalsCompatible(sessionProto)

	if (!sessionProto._kimchiInlineCompactPatch) {
		const originalCompact = sessionProto.compact
		const originalBindExtensionCore = sessionProto._bindExtensionCore

		sessionProto.inlineCompact = function inlineCompact(options: InlineCompactOptions = {}) {
			return runInlineCompact(this, originalCompact, options)
		}

		sessionProto._bindExtensionCore = function patchedBindExtensionCore(runner: PatchableRunnerInstance) {
			runner._kimchiInlineCompact = (inlineOptions?: InlineCompactOptions) =>
				this.inlineCompact?.(inlineOptions) ?? Promise.reject(new Error("inlineCompact is not available"))
			return originalBindExtensionCore.call(this, runner)
		}

		sessionProto._kimchiInlineCompactPatch = true
	}

	const runnerProto = runnerClass.prototype
	if (!runnerProto.createContext) {
		throw new Error(
			"pi-coding-agent ExtensionRunner internals are incompatible with Kimchi inline compaction " +
				"(missing ExtensionRunner.createContext() — upstream internals changed)",
		)
	}

	if (!runnerProto._kimchiInlineCompactContextPatch) {
		const originalCreateContext = runnerProto.createContext
		runnerProto.createContext = function patchedCreateContext() {
			const context = originalCreateContext.call(this)
			const inlineCompact = this._kimchiInlineCompact
			if (typeof inlineCompact === "function") {
				Object.defineProperty(context, "inlineCompact", {
					configurable: true,
					enumerable: true,
					value: (inlineOptions?: InlineCompactOptions) => {
						this.assertActive?.()
						return inlineCompact(inlineOptions)
					},
				})
			}
			return context
		}
		runnerProto._kimchiInlineCompactContextPatch = true
	}
}
