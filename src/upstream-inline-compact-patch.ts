/**
 * Non-aborting inline adaptation of pi-coding-agent's AgentSession.compact().
 *
 * Instead of cloning upstream's compaction lifecycle, `inlineCompact` DELEGATES
 * to the original `compact()` with the quiesce pair suppressed: upstream's
 * `_disconnectFromAgent()` + `await this.abort()` exist to force-idle a live
 * run before rewriting `agent.state.messages`, but inline callers (Ferment's
 * stage-boundary compaction) invoke this from an AWAITED extension handler at
 * a turn boundary — the agent loop is suspended for the whole call, so the
 * rewrite is already safe and the run must NOT be aborted.
 *
 * Delegation means upstream's own code runs: `_compactionAbortController` is
 * set (so `isCompacting` and `abortCompaction()` work unpatched), events carry
 * upstream's exact shapes (reason "manual"), and upstream fixes are inherited
 * automatically.
 *
 * The suppression works through temporary per-instance property shadows that
 * intercept the prototype members `compact()` reaches via `this`. That
 * coupling is asserted fail-loud at patch-install time (i.e. process startup)
 * by checking the source text of `compact()` — a regression here must abort
 * the process, not silently turn stage compaction abortive or into a no-op.
 *
 * Caller contract (enforced where possible):
 * - Call from an awaited extension handler at a turn boundary (turn_end /
 *   agent_end) or while the session is idle. NOT enforceable from inside the
 *   session; violating it races the agent loop.
 * - No unpaired toolCall in the current branch. ENFORCED: throws before
 *   compacting (see isToolCallInFlight) instead of orphaning the toolResult.
 */
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import { AgentSession, type CompactionResult, ExtensionRunner } from "@earendil-works/pi-coding-agent"
import { collectMessagesAfterLastCompaction, isToolCallInFlight } from "./tool-call-in-flight.js"

export interface InlineCompactOptions {
	customInstructions?: string
	force?: boolean
	/** Override model for the summarization call. Falls back to the session's
	 *  active model when omitted (prior behavior). Lets callers (e.g. Ferment's
	 *  stage-boundary compaction) point summarization at a separate, cheaper or
	 *  non-reasoning model — upstream's summarizer already gates thinkingLevel
	 *  on `model.reasoning`, so a non-reasoning model here needs no other patch. */
	model?: Model<Api>
	/** Override thinking level for the summarization call. Falls back to the
	 *  session's current thinking level when omitted. Every model in Kimchi's
	 *  catalog today reports `reasoning: true` (some hybrid, some just not yet
	 *  gated off at the compat layer), so picking a different `model` above does
	 *  not by itself guarantee no reasoning tokens are spent — this is the actual
	 *  lever for that. */
	thinkingLevel?: ModelThinkingLevel
}

type CompactionSettingsLike = {
	keepRecentTokens: number
	[key: string]: unknown
}

type PatchableSession = {
	_compactionAbortController?: AbortController
	_autoCompactionAbortController?: AbortController
	_disconnectFromAgent: () => void
	abort: (...args: unknown[]) => Promise<unknown>
	sessionManager: { getBranch(): unknown[] }
	settingsManager: { getCompactionSettings(): CompactionSettingsLike }
	inlineCompact?(options?: InlineCompactOptions): Promise<CompactionResult>
}

type PatchableSessionPrototype = {
	_kimchiInlineCompactPatch?: boolean
	inlineCompact?: (this: PatchableSession, options?: InlineCompactOptions) => Promise<CompactionResult>
	compact?: (this: PatchableSession, customInstructions?: string, force?: boolean) => Promise<CompactionResult>
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

/**
 * Fail at patch-install time (i.e. process startup) when `compact()` no longer
 * calls the internals the inline shadows suppress. If upstream renames
 * `_disconnectFromAgent` or stops quiescing via `this.abort()`, the shadows
 * would silently go inert and inline compaction would become abortive again —
 * the same silent-regression class that once turned every stage-boundary
 * compaction in a benchmark run into a no-op.
 */
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
	if (session._compactionAbortController || session._autoCompactionAbortController) {
		throw new Error("Compaction already in progress")
	}

	// Safety assertion (not deferral — callers wanting deferral must check
	// before calling): compacting across an unpaired toolCall summarises away
	// the assistant toolCall and orphans the toolResult appended later. Scoped
	// past the newest compaction entry so a historical, already-neutralised
	// orphan cannot permanently veto compaction.
	if (isToolCallInFlight(collectMessagesAfterLastCompaction(session.sessionManager.getBranch()))) {
		throw new Error(
			"inlineCompact called while a tool call is in flight — callers must defer to a turn boundary with no unpaired toolCall",
		)
	}

	const restores: Array<() => void> = []

	// One-shot suppression of the quiesce pair. compact() calls each exactly
	// once at its start, and the agent loop is suspended in the awaited
	// handler, so no other caller can land in that window. Any LATER abort()
	// during the summarization is a genuine cancellation request: cancel the
	// compaction and delegate to the real abort.
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
		shadowProperty(session, "abort", async function inlineShadowedAbort(this: PatchableSession, ...args: unknown[]) {
			if (!abortSuppressed) {
				abortSuppressed = true
				return
			}
			this._compactionAbortController?.abort()
			return realAbort.apply(this, args)
		}),
	)

	// force means "compact everything before the newest valid cut point".
	// Upstream's own force fallback (retry with keepRecentTokens: 0) only fires
	// when preparation is undefined — a session smaller than keepRecentTokens
	// returns a DEFINED preparation with zero summarizable messages, which
	// turned every small-session forced compaction into a no-op. Shadow the
	// settings so preparation starts from keepRecentTokens: 0 directly.
	if (options.force) {
		const settingsManager = session.settingsManager
		const realGetCompactionSettings = settingsManager.getCompactionSettings
		restores.push(
			shadowProperty(settingsManager, "getCompactionSettings", function inlineShadowedSettings() {
				return { ...realGetCompactionSettings.call(settingsManager), keepRecentTokens: 0 }
			}),
		)
	}

	// compact() reads `this.model` / `this.thinkingLevel` (prototype getters
	// over agent.state) for auth and the summarization call. Instance shadows
	// reroute both without touching agent.state, so the suspended loop resumes
	// with its own model untouched.
	if (options.model !== undefined) {
		restores.push(shadowProperty(session, "model", options.model))
	}
	if (options.thinkingLevel !== undefined) {
		restores.push(shadowProperty(session, "thinkingLevel", options.thinkingLevel))
	}

	try {
		return await originalCompact.call(session, options.customInstructions, options.force ?? false)
	} finally {
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
		throw new Error("pi-coding-agent AgentSession internals are incompatible with Kimchi inline compaction")
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
		throw new Error("pi-coding-agent ExtensionRunner internals are incompatible with Kimchi inline compaction")
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
