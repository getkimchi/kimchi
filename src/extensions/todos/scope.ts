import type { TodoScope, TodoScopeFerment, TodoScopeFermentStep } from "./types.js"

export type { TodoScope }

type UnknownRecord = Record<string, unknown>

export interface ScopeKindHandler {
	kind: string
	normalize(raw: UnknownRecord): TodoScope | undefined
	toKey(scope: TodoScope): string
	fromKey(parts: string[]): TodoScope | undefined
}

const scopeKindHandlers = new Map<string, ScopeKindHandler>()

function asString(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : ""
	return text.length > 0 ? text : undefined
}

function rawKind(raw: UnknownRecord): string | undefined {
	return asString(raw.kind) ?? asString(raw.type)
}

export function registerTodoScopeKind(handler: ScopeKindHandler): void {
	scopeKindHandlers.set(handler.kind, handler)
}

function normalizeGlobalScope(raw: UnknownRecord): TodoScope | undefined {
	const kind = rawKind(raw)
	return kind === undefined || kind === "global" ? { kind: "global" } : undefined
}

registerTodoScopeKind({
	kind: "global",
	normalize: normalizeGlobalScope,
	toKey: () => "global",
	fromKey: (parts) => (parts.length === 0 ? { kind: "global" } : undefined),
})

registerTodoScopeKind({
	kind: "ferment",
	normalize: (raw) => {
		const phaseId = typeof raw.phaseId === "string" ? raw.phaseId.trim() : ""
		return phaseId ? { kind: "ferment", phaseId } : undefined
	},
	toKey: (scope) => {
		const f = scope as TodoScopeFerment
		return `ferment:${encodeURIComponent(f.phaseId)}`
	},
	fromKey: (parts) => {
		const phaseId = parts[0] ? decodeURIComponent(parts[0]) : ""
		return phaseId ? { kind: "ferment", phaseId } : undefined
	},
})

registerTodoScopeKind({
	kind: "ferment-step",
	normalize: (raw) => {
		const phaseId = typeof raw.phaseId === "string" ? raw.phaseId.trim() : ""
		const stepId = typeof raw.stepId === "string" ? raw.stepId.trim() : ""
		return phaseId && stepId ? { kind: "ferment-step", phaseId, stepId } : undefined
	},
	toKey: (scope) => {
		const s = scope as TodoScopeFermentStep
		return `ferment-step:${encodeURIComponent(s.phaseId)}:${encodeURIComponent(s.stepId)}`
	},
	fromKey: (parts) => {
		const phaseId = parts[0] ? decodeURIComponent(parts[0]) : ""
		const stepId = parts[1] ? decodeURIComponent(parts[1]) : ""
		return phaseId && stepId ? { kind: "ferment-step", phaseId, stepId } : undefined
	},
})

/**
 * Check whether a scope input is effectively "no scope provided" — the model
 * passed undefined, null, an empty string, "{}", or an empty object.
 * Mirrors the logic in store.ts so validation is self-contained.
 */
function isEmptyScopeInput(scopeInput: unknown): boolean {
	if (scopeInput === undefined || scopeInput === null) return true
	if (typeof scopeInput === "string") {
		const trimmed = scopeInput.trim()
		return trimmed === "" || trimmed === "{}"
	}
	if (typeof scopeInput === "object") {
		return Object.keys(scopeInput as Record<string, unknown>).length === 0
	}
	return false
}

/** Result of validating an explicitly-provided scope. */
export interface ValidateScopeResult {
	/** Present when validation succeeds with an explicit scope. */
	scope?: TodoScope
	/** Present when the input was non-empty but malformed. */
	error?: string
}

/**
 * Validate a scope that was explicitly provided by a model/tool caller.
 *
 * - Returns `{}` (no scope, no error) when the input is empty/omitted,
 *   signaling the caller to auto-route via providers.
 * - Returns `{scope}` when the input is a valid recognized scope.
 * - Returns `{error}` when the input is non-empty but malformed (unknown
 *   kind, missing fields, wrong type). This prevents silent collapse to
 *   global — the model gets a corrective message instead.
 *
 * Internal callers (bridge, /todos command, restore) should use the lenient
 * `normalizeTodoScope` instead, which never errors.
 */
export function validateExplicitTodoScope(rawScope: unknown): ValidateScopeResult {
	if (isEmptyScopeInput(rawScope)) return {}

	if (typeof rawScope === "string") {
		const kind = asString(rawScope)
		if (!kind || kind === "global") return { scope: { kind: "global" } }
		const handler = scopeKindHandlers.get(kind)
		if (handler) {
			const scope = handler.normalize({ kind })
			if (scope) return { scope }
		}
		return {
			error: `Unknown todo scope '${rawScope}'. Omit scope for auto-routing, or use {kind:"global"}, {kind:"ferment",phaseId:"..."}, or {kind:"ferment-step",phaseId:"...",stepId:"..."}.`,
		}
	}

	if (typeof rawScope !== "object") {
		return { error: `Invalid todo scope: expected an object or string, got ${typeof rawScope}.` }
	}

	const raw = rawScope as UnknownRecord
	const kind = rawKind(raw)
	if (!kind) {
		return { error: `Todo scope is missing 'kind'. Use "global", "ferment", or "ferment-step".` }
	}

	const handler = scopeKindHandlers.get(kind)
	if (!handler) {
		return { error: `Unknown todo scope kind '${kind}'. Use "global", "ferment", or "ferment-step".` }
	}

	const scope = handler.normalize(raw)
	if (!scope) {
		if (kind === "ferment") {
			return { error: `Ferment scope requires a non-empty 'phaseId'. Example: {kind:"ferment",phaseId:"phase-2"}.` }
		}
		if (kind === "ferment-step") {
			return {
				error: `Ferment-step scope requires non-empty 'phaseId' and 'stepId'. Example: {kind:"ferment-step",phaseId:"phase-2",stepId:"step-3"}.`,
			}
		}
		return { error: `Invalid todo scope for kind '${kind}'.` }
	}

	return { scope }
}

export function normalizeTodoScope(rawScope: unknown): TodoScope {
	if (rawScope === undefined || rawScope === null) return { kind: "global" }

	if (typeof rawScope === "string") {
		const kind = asString(rawScope)
		if (!kind || kind === "global") return { kind: "global" }
		const handler = scopeKindHandlers.get(kind)
		return handler?.normalize({ kind }) ?? { kind: "global" }
	}

	if (typeof rawScope !== "object") return { kind: "global" }

	const raw = rawScope as UnknownRecord
	const kind = rawKind(raw)
	if (!kind) return { kind: "global" }
	const handler = scopeKindHandlers.get(kind)
	return handler?.normalize(raw) ?? { kind: "global" }
}

export function getTodoScopeKey(scope: TodoScope): string {
	const handler = scopeKindHandlers.get(scope.kind)
	if (!handler) throw new Error(`Invalid todo scope kind '${scope.kind}'`)
	return handler.toKey(scope)
}

export function parseTodoScopeKey(scopeKey: string): TodoScope {
	const [kind, ...encodedParts] = scopeKey.split(":")
	const handler = kind ? scopeKindHandlers.get(kind) : undefined
	if (!handler) throw new Error(`Invalid todo scope key '${scopeKey}'`)

	const parts = encodedParts.map((part) => decodeURIComponent(part))
	const scope = handler.fromKey(parts)
	if (!scope) throw new Error(`Invalid todo scope key '${scopeKey}'`)
	return scope
}
