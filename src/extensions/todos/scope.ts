import type {
	FermentTodoScope,
	TodoScope,
	TodoScopeAgent,
	TodoScopeFerment,
	TodoScopeFermentPhase,
	TodoScopeFermentStep,
} from "./types.js"

export type { TodoScope, TodoScopeAgent, TodoScopeFerment, TodoScopeFermentPhase, TodoScopeFermentStep }

type UnknownRecord = Record<string, unknown>

function asString(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : ""
	return text.length > 0 ? text : undefined
}

export function normalizeTodoScope(rawScope: unknown): TodoScope {
	if (typeof rawScope === "string") {
		const scope = asString(rawScope)
		if (scope === "global") return { kind: "global" }
		throw new Error(`Invalid todo scope '${rawScope}'`)
	}

	if (!rawScope || typeof rawScope !== "object") {
		throw new Error("Invalid todo scope: must be an object")
	}

	const raw = rawScope as UnknownRecord
	const type = asString(raw.type) ?? asString(raw.kind)
	if (type === undefined) {
		throw new Error("Invalid todo scope: missing kind")
	}

	if (type === "global") {
		return { kind: "global" }
	}

	if (type === "ferment") {
		const fermentId = asString(raw.fermentId) ?? asString(raw.ferment_id)
		if (!fermentId) throw new Error("Invalid ferment todo scope: missing fermentId")
		return { kind: "ferment", fermentId }
	}

	if (type === "agent" || type === "subagent") {
		const agentId = asString(raw.agentId) ?? asString(raw.agent_id)
		if (!agentId) throw new Error("Invalid agent todo scope: missing agentId")
		return { kind: "agent", agentId }
	}

	if (type === "ferment_phase" || type === "phase") {
		const fermentId = asString(raw.fermentId) ?? asString(raw.ferment_id)
		const phaseId = asString(raw.phaseId) ?? asString(raw.phase_id)
		if (!fermentId) throw new Error("Invalid ferment-phase todo scope: missing fermentId")
		if (!phaseId) throw new Error("Invalid ferment-phase todo scope: missing phaseId")
		return { kind: "ferment_phase", fermentId, phaseId }
	}

	if (type !== "ferment_step" && type !== "step") {
		throw new Error(`Invalid todo scope type '${type}'`)
	}

	const fermentId = asString(raw.fermentId) ?? asString(raw.ferment_id)
	const phaseId = asString(raw.phaseId) ?? asString(raw.phase_id)
	const stepId = asString(raw.stepId) ?? asString(raw.step_id)
	if (!fermentId) throw new Error("Invalid ferment-step todo scope: missing fermentId")
	if (!phaseId) throw new Error("Invalid ferment-step todo scope: missing phaseId")
	if (!stepId) throw new Error("Invalid ferment-step todo scope: missing stepId")
	return { kind: "ferment_step", fermentId, phaseId, stepId }
}

export function getTodoScopeKey(scope: TodoScope): string {
	if (scope.kind === "global") return "global"
	if (scope.kind === "agent") return ["agent", encodeURIComponent(scope.agentId)].join(":")
	if (scope.kind === "ferment") return ["ferment", encodeURIComponent(scope.fermentId)].join(":")
	if (scope.kind === "ferment_phase") {
		return ["ferment_phase", encodeURIComponent(scope.fermentId), encodeURIComponent(scope.phaseId)].join(":")
	}
	return [
		"ferment_step",
		encodeURIComponent(scope.fermentId),
		encodeURIComponent(scope.phaseId),
		encodeURIComponent(scope.stepId),
	].join(":")
}

export function parseTodoScopeKey(scopeKey: string): TodoScope {
	const [type, ...parts] = scopeKey.split(":")
	if (type === "global") return { kind: "global" }
	if (type === "ferment") {
		const fermentId = parts[0] ? decodeURIComponent(parts[0]) : undefined
		if (!fermentId) throw new Error(`Invalid todo scope key '${scopeKey}'`)
		return { kind: "ferment", fermentId }
	}
	if (type === "agent") {
		const agentId = parts[0] ? decodeURIComponent(parts[0]) : undefined
		if (!agentId) throw new Error(`Invalid todo scope key '${scopeKey}'`)
		return { kind: "agent", agentId }
	}
	if (type === "ferment_phase") {
		const fermentId = parts[0] ? decodeURIComponent(parts[0]) : undefined
		const phaseId = parts[1] ? decodeURIComponent(parts[1]) : undefined
		if (!fermentId || !phaseId) throw new Error(`Invalid todo scope key '${scopeKey}'`)
		return { kind: "ferment_phase", fermentId, phaseId }
	}
	if (type === "ferment_step") {
		const fermentId = parts[0] ? decodeURIComponent(parts[0]) : undefined
		const phaseId = parts[1] ? decodeURIComponent(parts[1]) : undefined
		const stepId = parts[2] ? decodeURIComponent(parts[2]) : undefined
		if (!fermentId || !phaseId || !stepId) {
			throw new Error(`Invalid todo scope key '${scopeKey}'`)
		}
		return { kind: "ferment_step", fermentId, phaseId, stepId }
	}

	throw new Error(`Invalid todo scope key '${scopeKey}'`)
}

export function todoScopeFromFermentScope(scope: FermentTodoScope): TodoScope | undefined {
	if (scope.level === "ferment") return { kind: "ferment", fermentId: scope.fermentId }
	if (scope.level === "phase" && scope.phaseId) {
		return { kind: "ferment_phase", fermentId: scope.fermentId, phaseId: scope.phaseId }
	}
	if (scope.level !== "step" || !scope.phaseId || !scope.stepId) return undefined
	return {
		kind: "ferment_step",
		fermentId: scope.fermentId,
		phaseId: scope.phaseId,
		stepId: scope.stepId,
	}
}
