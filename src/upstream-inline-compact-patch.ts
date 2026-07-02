/**
 * Local non-aborting adaptation of pi-coding-agent's AgentSession.compact()
 * lifecycle. Keep this close to upstream compaction behavior: it intentionally
 * reuses PI's internal prepare/compact functions and extension events, but skips
 * the manual compact path's session disconnect + abort.
 */
import { existsSync } from "node:fs"
import { dirname, join, parse } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
	AgentSession,
	type CompactionResult,
	ExtensionRunner,
	compact as piCompact,
} from "@earendil-works/pi-coding-agent"

export interface InlineCompactOptions {
	customInstructions?: string
	force?: boolean
}

type CompactionSettingsLike = {
	keepRecentTokens: number
	[key: string]: unknown
}

export type InlineCompactCompactionModule = {
	prepareCompaction: (pathEntries: unknown[], settings: CompactionSettingsLike) => unknown | undefined
	compact: (
		preparation: unknown,
		model: unknown,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		thinkingLevel: unknown,
		streamFn: unknown,
	) => Promise<CompactionResult>
}

type ExtensionRunnerLike = {
	hasHandlers(event: string): boolean
	emit(event: unknown): Promise<unknown>
}

type SessionManagerLike = {
	getBranch(): unknown[]
	getEntries(): unknown[]
	appendCompaction(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details: unknown,
		fromExtension: boolean,
	): void
	buildSessionContext(): { messages: unknown[] }
}

type PatchableSession = {
	model: unknown | undefined
	thinkingLevel: unknown
	agent: {
		state: { messages: unknown[] }
		streamFn: unknown
	}
	sessionManager: SessionManagerLike
	settingsManager: {
		getCompactionSettings(): CompactionSettingsLike
	}
	_getCompactionRequestAuth(model: unknown): Promise<{
		apiKey?: string
		headers?: Record<string, string>
	}>
	_extensionRunner: ExtensionRunnerLike
	_emit(event: unknown): void
	_compactionAbortController?: AbortController
	_autoCompactionAbortController?: AbortController
	_inlineCompactionAbortController?: AbortController
	inlineCompact?(options?: InlineCompactOptions): Promise<CompactionResult>
}

type PatchableSessionPrototype = {
	_kimchiInlineCompactPatch?: boolean
	inlineCompact?: (this: PatchableSession, options?: InlineCompactOptions) => Promise<CompactionResult>
	_bindExtensionCore?: (this: PatchableSession, runner: PatchableRunnerInstance) => unknown
	abortCompaction?: (this: PatchableSession, ...args: unknown[]) => unknown
	abort?: (this: PatchableSession, ...args: unknown[]) => unknown
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

interface SessionBeforeCompactResultLike {
	cancel?: boolean
	compaction?: CompactionResult
}

export interface InlineCompactPatchOptions {
	sessionClass?: PatchableSessionClass
	runnerClass?: PatchableRunnerClass
	loadCompactionModule?: () => Promise<InlineCompactCompactionModule>
}

let defaultCompactionModulePromise: Promise<InlineCompactCompactionModule> | undefined

function resolveCodingAgentEntryUrl(): string {
	const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve
	if (typeof resolver === "function") {
		return resolver("@earendil-works/pi-coding-agent")
	}

	let current = dirname(fileURLToPath(import.meta.url))
	const root = parse(current).root
	while (true) {
		const entry = join(current, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
		if (existsSync(entry)) return pathToFileURL(entry).href
		if (current === root) break
		current = dirname(current)
	}
	throw new Error("Unable to resolve pi-coding-agent from Kimchi inline compaction")
}

export async function loadDefaultCompactionModule(): Promise<InlineCompactCompactionModule> {
	defaultCompactionModulePromise ??= (async () => {
		const packageRoot = resolveCodingAgentEntryUrl()
		const moduleUrl = new URL("./core/compaction/index.js", packageRoot)
		const mod = (await import(moduleUrl.href)) as Partial<Pick<InlineCompactCompactionModule, "prepareCompaction">>
		if (typeof mod.prepareCompaction !== "function") {
			throw new Error("pi-coding-agent compaction internals are incompatible with Kimchi inline compaction")
		}
		return {
			prepareCompaction: mod.prepareCompaction,
			compact: piCompact as InlineCompactCompactionModule["compact"],
		}
	})()
	return defaultCompactionModulePromise
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object"
}

function isCompactionResult(value: unknown): value is CompactionResult {
	return (
		isRecord(value) &&
		typeof value.summary === "string" &&
		typeof value.firstKeptEntryId === "string" &&
		typeof value.tokensBefore === "number"
	)
}

function asBeforeCompactResult(value: unknown): SessionBeforeCompactResultLike | undefined {
	if (!isRecord(value)) return undefined
	return {
		cancel: value.cancel === true,
		compaction: isCompactionResult(value.compaction) ? value.compaction : undefined,
	}
}

function getResultFromExtension(compaction: CompactionResult): CompactionResult {
	return {
		summary: compaction.summary,
		firstKeptEntryId: compaction.firstKeptEntryId,
		tokensBefore: compaction.tokensBefore,
		details: compaction.details,
	}
}

function findSavedCompactionEntry(entries: unknown[], summary: string): unknown | undefined {
	return entries.find((entry) => isRecord(entry) && entry.type === "compaction" && entry.summary === summary)
}

async function runInlineCompact(
	session: PatchableSession,
	options: InlineCompactOptions,
	loadCompactionModule: () => Promise<InlineCompactCompactionModule>,
): Promise<CompactionResult> {
	if (
		session._inlineCompactionAbortController ||
		session._compactionAbortController ||
		session._autoCompactionAbortController
	) {
		throw new Error("Compaction already in progress")
	}
	// PI only exposes manual/threshold/overflow compaction event reasons.
	// Inline compaction is automatic extension-driven work, so use threshold
	// rather than manual even when Ferment triggers it proactively.
	const reason = "threshold"
	const customInstructions = options.customInstructions
	session._inlineCompactionAbortController = new AbortController()
	session._emit({ type: "compaction_start", reason })

	try {
		const signal = session._inlineCompactionAbortController.signal
		const { prepareCompaction, compact } = await loadCompactionModule()
		if (signal.aborted) {
			throw new Error("Compaction cancelled")
		}
		if (!session.model) {
			throw new Error("No model selected")
		}

		const { apiKey, headers } = await session._getCompactionRequestAuth(session.model)
		const pathEntries = session.sessionManager.getBranch()
		const settings = session.settingsManager.getCompactionSettings()
		let preparation = prepareCompaction(pathEntries, settings)

		if (!preparation) {
			const lastEntry = pathEntries[pathEntries.length - 1]
			if (isRecord(lastEntry) && lastEntry.type === "compaction") {
				throw new Error("Already compacted")
			}
			if (!options.force) {
				throw new Error("Nothing to compact (session too small)")
			}
			preparation = prepareCompaction(pathEntries, { ...settings, keepRecentTokens: 0 })
			if (!preparation) {
				throw new Error("Nothing to compact (no valid cut point)")
			}
		}

		let compactionResult: CompactionResult | undefined
		let fromExtension = false
		if (session._extensionRunner.hasHandlers("session_before_compact")) {
			const extensionResult = asBeforeCompactResult(
				await session._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal,
				}),
			)
			if (extensionResult?.cancel) {
				throw new Error("Compaction cancelled")
			}
			if (extensionResult?.compaction) {
				compactionResult = getResultFromExtension(extensionResult.compaction)
				fromExtension = true
			}
		}

		if (!compactionResult) {
			compactionResult = await compact(
				preparation,
				session.model,
				apiKey,
				headers,
				customInstructions,
				signal,
				session.thinkingLevel,
				session.agent.streamFn,
			)
		}

		if (signal.aborted) {
			throw new Error("Compaction cancelled")
		}

		session.sessionManager.appendCompaction(
			compactionResult.summary,
			compactionResult.firstKeptEntryId,
			compactionResult.tokensBefore,
			compactionResult.details,
			fromExtension,
		)
		const newEntries = session.sessionManager.getEntries()
		const sessionContext = session.sessionManager.buildSessionContext()
		session.agent.state.messages = sessionContext.messages

		const savedCompactionEntry = findSavedCompactionEntry(newEntries, compactionResult.summary)
		if (savedCompactionEntry) {
			await session._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			})
		}

		session._emit({ type: "compaction_end", reason, result: compactionResult, aborted: false, willRetry: false })
		return compactionResult
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")
		session._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted,
			willRetry: false,
			errorMessage: aborted ? undefined : `Inline compaction failed: ${message}`,
		})
		throw error
	} finally {
		session._inlineCompactionAbortController = undefined
	}
}

export function installInlineCompactPatch(options: InlineCompactPatchOptions = {}): void {
	const sessionClass = options.sessionClass ?? (AgentSession as unknown as PatchableSessionClass)
	const runnerClass = options.runnerClass ?? (ExtensionRunner as unknown as PatchableRunnerClass)
	const loadCompactionModule = options.loadCompactionModule ?? loadDefaultCompactionModule

	const sessionProto = sessionClass.prototype
	if (!sessionProto._bindExtensionCore || !sessionProto.abortCompaction || !sessionProto.abort) {
		throw new Error("pi-coding-agent AgentSession internals are incompatible with Kimchi inline compaction")
	}

	if (!sessionProto._kimchiInlineCompactPatch) {
		const originalBindExtensionCore = sessionProto._bindExtensionCore
		const originalAbortCompaction = sessionProto.abortCompaction
		const originalAbort = sessionProto.abort

		sessionProto.inlineCompact = function inlineCompact(options: InlineCompactOptions = {}) {
			return runInlineCompact(this, options, loadCompactionModule)
		}

		sessionProto.abortCompaction = function patchedAbortCompaction(...args: unknown[]) {
			this._inlineCompactionAbortController?.abort()
			return originalAbortCompaction.apply(this, args)
		}

		sessionProto.abort = function patchedAbort(...args: unknown[]) {
			this._inlineCompactionAbortController?.abort()
			return originalAbort.apply(this, args)
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
