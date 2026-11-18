import type { CustomEntry, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createSessionLogHarness } from "../__mocks__/session-log.js"
import { registerDirectorWorkerGateway } from "../agents/director-gateway.js"
import { registerResumeSubagentTool } from "../agents/resume-tool.js"
import directorExtension from "./index.js"
import { activateDirector, type DirectorWorkerSnapshot, finishDirector } from "./lifecycle.js"
import { createDirectorState, renderDirectorStatus } from "./plan.js"
import { DirectorStore } from "./state.js"

function worker(id: string, overrides: Partial<DirectorWorkerSnapshot> = {}): DirectorWorkerSnapshot {
	return { id, type: "Builder", description: id, status: "running", startedAt: 1, ...overrides }
}

function stateWithWorker(id: string) {
	const state = createDirectorState("Cleanup", "run-1")
	state.plan.workers[id] = {
		id,
		type: "Builder",
		description: id,
		status: "running",
		disposition: "owned",
		artifactPaths: [],
	}
	return state
}

describe("review fixes", () => {
	it("keeps worker gateway ownership isolated by session", () => {
		const firstPi = {} as ExtensionAPI
		const secondPi = {} as ExtensionAPI
		registerDirectorWorkerGateway(firstPi, { list: () => [worker("first-worker")], abort: () => true })
		registerDirectorWorkerGateway(secondPi, { list: () => [worker("second-worker")], abort: () => true })

		expect(
			getDirectorWorkerGateway(firstPi)
				.list()
				.map((entry) => entry.id),
		).toEqual(["first-worker"])
		expect(
			getDirectorWorkerGateway(secondPi)
				.list()
				.map((entry) => entry.id),
		).toEqual(["second-worker"])
	})

	it("rejects cancellation when abort fails or a worker cannot be tracked", () => {
		const trackedStore = new DirectorStore(createSessionLogHarness())
		trackedStore.commit(stateWithWorker("cannot-stop"), 0)
		const failedAbort = {
			list: () => [worker("cannot-stop")],
			abort: () => false,
		}
		expect(() => finishDirector(trackedStore, { outcome: "cancelled", gateway: failedAbort })).toThrow(/abort|stop/i)
		expect(trackedStore.read()?.status).toBe("active")
		expect(trackedStore.read()?.plan.workers["cannot-stop"].disposition).toBe("owned")

		const untrackedStore = new DirectorStore(createSessionLogHarness())
		untrackedStore.commit(createDirectorState("Unknown ownership", "run-unknown"), 0)
		const untrackedAbort = { list: () => [worker("unknown-worker")], abort: () => true }
		expect(() => finishDirector(untrackedStore, { outcome: "cancelled", gateway: untrackedAbort })).toThrow(
			/untracked/i,
		)
		expect(untrackedStore.read()?.status).toBe("active")
	})

	it("preserves live handed-off workers and rejects inconsistent cancellation ownership", () => {
		const handedOffStore = new DirectorStore(createSessionLogHarness())
		const handedOffState = stateWithWorker("handed-off")
		handedOffState.plan.workers["handed-off"].disposition = "handed-off"
		handedOffStore.commit(handedOffState, 0)
		const abort = vi.fn(() => true)

		const result = finishDirector(handedOffStore, {
			outcome: "cancelled",
			gateway: { list: () => [worker("handed-off")], abort },
		})
		expect(abort).not.toHaveBeenCalled()
		expect(result.status).toBe("inactive")
		expect(result.plan.workers["handed-off"].disposition).toBe("handed-off")

		const inconsistentStore = new DirectorStore(createSessionLogHarness())
		const inconsistentState = stateWithWorker("inconsistent")
		inconsistentState.plan.workers.inconsistent.disposition = "joined"
		inconsistentStore.commit(inconsistentState, 0)
		expect(() =>
			finishDirector(inconsistentStore, {
				outcome: "cancelled",
				gateway: { list: () => [worker("inconsistent")], abort },
			}),
		).toThrow(/reconciliation/i)
		expect(abort).not.toHaveBeenCalled()
		expect(inconsistentStore.read()?.status).toBe("active")
	})

	it("persists the terminal status of a resumed Director worker", async () => {
		const harness = createSessionLogHarness()
		const api = createExtensionApi()
		directorExtension(api.api, {
			createStore: () => harness,
			isWorker: () => false,
			otherOrchestrationActive: () => false,
		})
		const ctx = createContext()
		await api.getHandler("input")(
			{ type: "input", text: "/skill:director resumed terminal status", source: "interactive" },
			ctx,
		)
		const record = {
			id: "resumed-worker",
			type: "Builder",
			description: "Regain a report",
			status: "completed",
			session: {},
			result: "Done",
		}
		registerResumeSubagentTool(api.api, {
			getRecord: () => record,
			getResumeBlockReason: () => undefined,
			resume: async () => record,
		} as never)

		await api
			.getRegisteredTool("resume_subagent")
			.execute(
				"resume-terminal",
				{ agent_id: record.id, prompt: "finish", max_turns: 3, max_duration: 30 },
				undefined,
				undefined,
				ctx as ExtensionToolContext,
			)
		expect(harness.entries.map((entry) => entry.customType)).toContain("director-mode/v1")
		expect(new DirectorStore(harness).read()?.plan.workers[record.id]).toMatchObject({
			status: "completed",
			disposition: "joined",
		})
	})

	it("includes worker ID and status when activation is blocked", () => {
		const store = new DirectorStore(createSessionLogHarness())
		expect(() =>
			activateDirector(store, {
				objective: "blocked",
				runId: "blocked",
				gateway: { list: () => [worker("worker-still-running")], abort: () => true },
			}),
		).toThrow(/worker-still-running \(running\)/)
	})

	it("clears profile and indicator when a saved Director snapshot is corrupt", async () => {
		const harness = createSessionLogHarness()
		harness.entries.push({
			type: "custom",
			customType: "director-mode/v1",
			data: { status: "active" },
		} as CustomEntry)
		const api = createExtensionApi()
		directorExtension(api.api, {
			createStore: () => harness,
			isWorker: () => false,
			otherOrchestrationActive: () => false,
		})
		const ctx = createContext()
		await api.getHandler("session_start")({}, ctx)

		expect(api.getActiveToolNames()).not.toContain("director_plan")
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("director", undefined)
	})

	it("reapplies Director's allowlist after a deferred tool is revealed", async () => {
		const harness = createSessionLogHarness()
		const api = createExtensionApi()
		for (const name of ["Agent", "questionnaire", "skill_view", "read", "debug_state_at"]) {
			api.registerTool({ name } as never)
		}
		directorExtension(api.api, {
			createStore: () => harness,
			isWorker: () => false,
			otherOrchestrationActive: () => false,
		})
		const ctx = createContext()
		await api.getHandler("session_start")({}, ctx)
		await api.getHandler("input")(
			{ type: "input", text: "/skill:director restricted tools", source: "interactive" },
			ctx,
		)
		api.setActiveTools(["debug_state_at"])

		await api.getHandler("tool_execution_end")({}, ctx)
		expect(api.getActiveToolNames()).not.toContain("debug_state_at")
	})

	it("caps worker rows in Director progress rendering", () => {
		const state = createDirectorState("Large fleet", "run-large")
		for (let index = 1; index <= 18; index++) {
			const id = `agent-${index}`
			state.plan.workers[id] = {
				id,
				type: "Builder",
				description: id,
				status: "running",
				disposition: "owned",
				artifactPaths: [],
			}
		}

		const report = renderDirectorStatus(state)
		const agentRows = report.split("\n").filter((line) => line.startsWith("- agent-"))
		expect(agentRows).toHaveLength(12)
		expect(report).toContain("… 6 more")
		expect(report).not.toContain("agent-13")
	})
})

import { getDirectorWorkerGateway } from "../agents/director-gateway.js"
