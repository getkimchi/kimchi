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
