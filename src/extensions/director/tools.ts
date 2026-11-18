import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { type DirectorWorkerGateway, finishDirector as finishLifecycle, reconcileDirectorWorker } from "./lifecycle.js"
import { renderDirectorStatus } from "./plan.js"
import type { DirectorStore } from "./state.js"

interface DirectorToolCallbacks {
	getStore(ctx: ExtensionContext): DirectorStore
	gateway: DirectorWorkerGateway
	onChange(ctx: ExtensionContext): void
}

function textResult(text: string, state?: unknown, error?: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { state, ...(error === undefined ? {} : { error }) },
	}
}

function errorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return textResult(message, undefined, message)
}

export function registerDirectorTools(pi: ExtensionAPI, callbacks: DirectorToolCallbacks): void {
	pi.registerTool({
		name: "director_plan",
		label: "Director Plan",
		description: "Read, revision-check, update, or reconcile the current Director run's durable orchestration plan.",
		promptGuidelines: [
			"Use this to maintain the plan instead of direct file tools. Supply the current expected revision for every update.",
		],
		parameters: Type.Union([
			Type.Object({ action: Type.Literal("read") }),
			Type.Object({
				action: Type.Literal("update"),
				expectedRevision: Type.Integer({ minimum: 0 }),
				plan: Type.Any({ description: "Complete validated DirectorPlan snapshot" }),
			}),
			Type.Object({
				action: Type.Literal("reconcile"),
				workerId: Type.String(),
				disposition: Type.Union([Type.Literal("joined"), Type.Literal("stopped"), Type.Literal("handed-off")]),
				note: Type.Optional(Type.String()),
			}),
		]),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const store = callbacks.getStore(ctx)
				const current = store.read()
				if (!current) return errorResult("Director is not active; start with /skill:director <objective>")
				if (params.action === "read") {
					return textResult(JSON.stringify({ state: current, liveWorkers: callbacks.gateway.list() }, null, 2), current)
				}
				if (params.action === "reconcile") {
					const reconciled = reconcileDirectorWorker(store, params)
					callbacks.onChange(ctx)
					return textResult(JSON.stringify(reconciled, null, 2), reconciled)
				}
				const updated = store.commit({ ...current, plan: params.plan }, params.expectedRevision)
				callbacks.onChange(ctx)
				return textResult(JSON.stringify(updated, null, 2), updated)
			} catch (error) {
				return errorResult(error)
			}
		},
	})

	pi.registerTool({
		name: "director_finish",
		label: "Finish Director",
		description:
			"Complete, block, or cancel the active Director run after accounting for every worker and reporting verification.",
		promptGuidelines: [
			"Call only after workers are joined, stopped, or deliberately handed off and the objective has a verification report.",
		],
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("cancelled")]),
			verificationSummary: Type.Optional(Type.String()),
			artifactPaths: Type.Optional(Type.Array(Type.String())),
			handoff: Type.Optional(Type.Boolean()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const state = finishLifecycle(callbacks.getStore(ctx), {
					outcome: params.outcome,
					verificationSummary: params.verificationSummary,
					artifactPaths: params.artifactPaths,
					gateway: callbacks.gateway,
					handoff: params.handoff,
				})
				callbacks.onChange(ctx)
				return textResult(`Director ${params.outcome}: ${state.objective}\n${renderDirectorStatus(state)}`, state)
			} catch (error) {
				return errorResult(error)
			}
		},
	})
}
