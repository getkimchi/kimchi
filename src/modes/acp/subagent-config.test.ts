import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSessionPermissionFlagController } from "../../extensions/permissions/mode-controller.js"
import {
	registerSessionPermissionFlagController,
	unregisterSessionPermissionFlagController,
} from "../../extensions/permissions/mode-controller-registry.js"
import type {
	PermissionMode,
	PermissionModeState,
	SessionPermissionFlagChanges,
	SessionPermissionFlagController,
} from "../../extensions/permissions/types.js"
import type {
	buildModelConfigOption as serverBuildModelConfigOption,
	buildPermissionsConfigOption as serverBuildPermissionsConfigOption,
	buildThinkingConfigOption as serverBuildThinkingConfigOption,
} from "./server.js"
import {
	buildSubagentConfigOptions,
	type SubagentConfigDependencies,
	SubagentConfigReporter,
	type SubagentConfigSession,
	subagentConfigNotification,
} from "./subagent-config.js"

const registeredControllers: Array<{ sessionId: string; controller: SessionPermissionFlagController }> = []

const serverBuilderCompatibility: [
	typeof serverBuildPermissionsConfigOption extends SubagentConfigDependencies["buildPermissionsConfigOption"]
		? true
		: false,
	typeof serverBuildModelConfigOption extends SubagentConfigDependencies["buildModelConfigOption"] ? true : false,
	typeof serverBuildThinkingConfigOption extends SubagentConfigDependencies["buildThinkingConfigOption"] ? true : false,
] = [true, true, true]

afterEach(() => {
	for (const { sessionId, controller } of registeredControllers.splice(0)) {
		unregisterSessionPermissionFlagController(sessionId, controller)
	}
})

function selectOption(id: string, currentValue: string): SessionConfigOption {
	return {
		id,
		name: id,
		type: "select",
		currentValue,
		options: [{ name: currentValue, value: currentValue }],
	}
}

function currentValues(notification: SessionNotification | undefined): Record<string, unknown> | undefined {
	if (notification?.update.sessionUpdate !== "config_option_update") return undefined
	return Object.fromEntries(notification.update.configOptions.map((option) => [option.id, option.currentValue]))
}

function model(id: string, provider = "persona"): NonNullable<SubagentConfigSession["model"]> {
	return { id, name: id, provider } as NonNullable<SubagentConfigSession["model"]>
}

function makeSession(sessionId: string, overrides: Partial<SubagentConfigSession> = {}): SubagentConfigSession {
	return {
		sessionId,
		model: model(`${sessionId}-model`),
		thinkingLevel: "medium",
		modelRuntime: {},
		sessionManager: {},
		...overrides,
	} as SubagentConfigSession
}

function modeState(mode: PermissionMode): PermissionModeState {
	return { mode, source: "runtime", initiatedBy: "user" }
}

function makeController(initialMode: PermissionMode) {
	const listeners = new Set<(changes: SessionPermissionFlagChanges) => void>()
	let current = initialMode
	const controller: SessionPermissionFlagController = {
		getMode: () => modeState(current),
		setMode: (state, skipNotify) => {
			current = state.mode
			if (!skipNotify) for (const listener of listeners) listener({ mode: modeState(current) })
		},
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
	return controller
}

function makeDependencies(
	controllers: ReadonlyMap<string, SessionPermissionFlagController> = new Map(),
): SubagentConfigDependencies & {
	buildPermissionsConfigOption: ReturnType<typeof vi.fn>
	buildModelConfigOption: ReturnType<typeof vi.fn>
	buildThinkingConfigOption: ReturnType<typeof vi.fn>
} {
	return {
		getPermissionFlagController: (sessionId) => controllers.get(sessionId),
		buildPermissionsConfigOption: vi.fn((mode: PermissionMode) => selectOption("permissions-mode", mode)),
		buildModelConfigOption: vi.fn((session: SubagentConfigSession) =>
			selectOption("model", `${session.model?.provider}/${session.model?.id}`),
		),
		buildThinkingConfigOption: vi.fn(({ model: effectiveModel, thinkingLevel }) =>
			selectOption("reasoning_effort", `${effectiveModel.id}:${thinkingLevel}`),
		),
	}
}

function registerController(sessionId: string, mode: PermissionMode): SessionPermissionFlagController {
	const controller = createSessionPermissionFlagController({ mode: modeState(mode) })
	registerSessionPermissionFlagController(sessionId, controller)
	registeredControllers.push({ sessionId, controller })
	return controller
}

describe("buildSubagentConfigOptions", () => {
	it("accepts the server's existing builders without adapter wrappers", () => {
		expect(serverBuilderCompatibility).toEqual([true, true, true])
	})

	it("reports persona-specific model and reasoning values with each child's own inherited or differing mode", () => {
		const parent = makeController("plan")
		const inherited = makeController("plan")
		const elevated = makeController("yolo")
		const dependencies = makeDependencies(
			new Map([
				["parent", parent],
				["reviewer", inherited],
				["builder", elevated],
			]),
		)
		const reviewer = makeSession("reviewer", { model: model("opus", "reviewer-persona"), thinkingLevel: "high" })
		const builder = makeSession("builder", { model: model("minimax", "builder-persona"), thinkingLevel: "low" })

		expect(
			currentValues(subagentConfigNotification("reviewer", buildSubagentConfigOptions(reviewer, dependencies))),
		).toEqual({
			"permissions-mode": "plan",
			model: "reviewer-persona/opus",
			reasoning_effort: "opus:high",
		})
		expect(
			currentValues(subagentConfigNotification("builder", buildSubagentConfigOptions(builder, dependencies))),
		).toEqual({
			"permissions-mode": "yolo",
			model: "builder-persona/minimax",
			reasoning_effort: "minimax:low",
		})
		expect(dependencies.buildPermissionsConfigOption.mock.calls.map(([mode]) => mode)).toEqual(["plan", "yolo"])
		expect(dependencies.buildModelConfigOption).toHaveBeenNthCalledWith(1, reviewer)
		expect(dependencies.buildModelConfigOption).toHaveBeenNthCalledWith(2, builder)
	})

	it("uses the real registry entry for the child, never the parent's controller", () => {
		registerController("registry-parent", "yolo")
		registerController("registry-inherited", "plan")
		const elevated = registerController("registry-elevated", "default")
		const dependencies = makeDependencies()
		dependencies.getPermissionFlagController = undefined

		const inherited = buildSubagentConfigOptions(makeSession("registry-inherited"), dependencies)
		const different = buildSubagentConfigOptions(makeSession("registry-elevated"), dependencies)
		const missing = buildSubagentConfigOptions(makeSession("registry-missing"), dependencies)

		expect(inherited.map((option) => option.currentValue)).toContain("plan")
		expect(different.map((option) => option.currentValue)).toContain("default")
		expect(missing.map((option) => option.id)).toEqual(["model", "reasoning_effort"])
		elevated.setMode(modeState("auto"))
		expect(buildSubagentConfigOptions(makeSession("registry-elevated"), dependencies)[0]?.currentValue).toBe("auto")
	})

	it("uses a routed physical model and its response effort for the reasoning builder", () => {
		const dependencies = makeDependencies()
		const virtual = model("auto", "router")
		const physical = model("physical-large", "provider")
		const session = makeSession("routed", {
			model: virtual,
			thinkingLevel: "medium",
			routedModel: { model: physical, thinkingLevel: "high" },
		})

		const options = buildSubagentConfigOptions(session, dependencies)

		expect(dependencies.buildModelConfigOption).toHaveBeenCalledWith(session)
		expect(dependencies.buildThinkingConfigOption).toHaveBeenCalledWith({ model: physical, thinkingLevel: "high" })
		expect(currentValues(subagentConfigNotification("routed", options))).toMatchObject({
			model: "router/auto",
			reasoning_effort: "physical-large:high",
		})
	})

	it("falls back only to the same child's selected model and requested effort before routing resolves", () => {
		const dependencies = makeDependencies()
		const child = makeSession("unresolved", { thinkingLevel: "minimal" })

		buildSubagentConfigOptions(child, dependencies)

		expect(dependencies.buildThinkingConfigOption).toHaveBeenCalledWith({
			model: child.model,
			thinkingLevel: "minimal",
		})
	})

	it("omits unconfirmed model, thinking and mode values instead of consulting a parent", () => {
		const dependencies = makeDependencies(new Map([["parent", makeController("yolo")]]))
		const child = makeSession("empty-child", {
			model: undefined,
			routedModel: undefined,
			thinkingLevel: undefined,
		})

		const notification = subagentConfigNotification("empty-child", buildSubagentConfigOptions(child, dependencies))

		expect(notification).toEqual({
			sessionId: "empty-child",
			update: { sessionUpdate: "config_option_update", configOptions: [] },
		})
		expect(dependencies.buildModelConfigOption).not.toHaveBeenCalled()
		expect(dependencies.buildThinkingConfigOption).not.toHaveBeenCalled()
		expect(dependencies.buildPermissionsConfigOption).not.toHaveBeenCalled()
	})

	it("omits only an unsupported or unconfirmed reasoning option while retaining known values", () => {
		const dependencies = makeDependencies(new Map([["partial", makeController("default")]]))
		dependencies.buildThinkingConfigOption.mockReturnValue(null)

		const options = buildSubagentConfigOptions(makeSession("partial"), dependencies)

		expect(options.map((option) => option.id)).toEqual(["permissions-mode", "model"])
	})

	it("addresses the child directly rather than wrapping configuration in the parent announcement", () => {
		const notification = subagentConfigNotification("child-address", [selectOption("model", "child-model")])
		expect(notification.sessionId).toBe("child-address")
		expect(notification.update.sessionUpdate).toBe("config_option_update")
	})
})

describe("SubagentConfigReporter", () => {
	it("publishes one child-addressed initial snapshot directly after its announcement", () => {
		const sent: SessionNotification[] = []
		const announcement = {
			sessionId: "parent",
			update: { sessionUpdate: "subagent_update", sessionId: "announced-child" },
		} as SessionNotification
		sent.push(announcement)
		const reporter = new SubagentConfigReporter(makeSession("announced-child"), makeDependencies())

		const initial = reporter.publishInitial((notification) => sent.push(notification))

		expect(sent).toEqual([announcement, initial])
		expect(initial.sessionId).toBe("announced-child")
		expect(reporter.publishChanged((notification) => sent.push(notification))).toBeUndefined()
		expect(sent).toHaveLength(2)
	})

	it("refreshes model, effort and routed values change-only without event-driven spam", () => {
		const sent: SessionNotification[] = []
		const send = (notification: SessionNotification) => sent.push(notification)
		const session = makeSession("changing")
		const reporter = new SubagentConfigReporter(session, makeDependencies())
		reporter.publishInitial(send)

		expect(reporter.publishChanged(send)).toBeUndefined()
		expect(reporter.publishChanged(send)).toBeUndefined()
		session.model = model("next-persona-model")
		expect(currentValues(reporter.publishChanged(send))).toMatchObject({ model: "persona/next-persona-model" })
		session.thinkingLevel = "high"
		expect(currentValues(reporter.publishChanged(send))).toMatchObject({
			reasoning_effort: "next-persona-model:high",
		})
		session.routedModel = { model: model("physical"), thinkingLevel: "low" }
		expect(currentValues(reporter.publishChanged(send))).toMatchObject({ reasoning_effort: "physical:low" })
		expect(reporter.publishChanged(send)).toBeUndefined()
		expect(sent).toHaveLength(4)
	})

	it("publishes a single permission refresh and suppresses duplicate mode notifications", () => {
		const controller = makeController("default")
		const dependencies = makeDependencies(new Map([["mode-child", controller]]))
		const sent: SessionNotification[] = []
		const send = (notification: SessionNotification) => sent.push(notification)
		const reporter = new SubagentConfigReporter(makeSession("mode-child"), dependencies)
		reporter.publishInitial(send)

		controller.setMode(modeState("auto"))
		controller.setMode(modeState("auto"))

		expect(sent).toHaveLength(2)
		expect(currentValues(sent.at(-1))).toMatchObject({ "permissions-mode": "auto" })
		reporter.dispose()
		controller.setMode(modeState("yolo"))
		expect(sent).toHaveLength(2)
	})

	it("discovers a controller that becomes available after the initial empty snapshot", () => {
		const controllers = new Map<string, SessionPermissionFlagController>()
		const sent: SessionNotification[] = []
		const send = (notification: SessionNotification) => sent.push(notification)
		const reporter = new SubagentConfigReporter(makeSession("late-mode"), makeDependencies(controllers))
		expect(reporter.publishInitial(send).update).toMatchObject({ configOptions: expect.any(Array) })
		expect(sent).toHaveLength(1)

		const controller = makeController("plan")
		controllers.set("late-mode", controller)
		reporter.publishChanged(send)
		expect(sent).toHaveLength(2)
		controller.setMode(modeState("auto"))
		expect(sent).toHaveLength(3)
		expect(currentValues(sent.at(-1))).toMatchObject({ "permissions-mode": "auto" })

		reporter.dispose()
	})

	it("moves its subscription when the child's registered controller is replaced", () => {
		const original = makeController("default")
		const controllers = new Map([["replacement-child", original]])
		const sent: SessionNotification[] = []
		const send = (notification: SessionNotification) => sent.push(notification)
		const reporter = new SubagentConfigReporter(makeSession("replacement-child"), makeDependencies(controllers))
		reporter.publishInitial(send)
		const replacement = makeController("plan")
		controllers.set("replacement-child", replacement)
		reporter.publishChanged(send)
		expect(sent).toHaveLength(2)

		original.setMode(modeState("yolo"))
		expect(sent).toHaveLength(2)
		replacement.setMode(modeState("auto"))
		expect(sent).toHaveLength(3)
		reporter.dispose()
	})

	it("publishes a full replacement when a previously confirmed model disappears", () => {
		const sent: SessionNotification[] = []
		const send = (notification: SessionNotification) => sent.push(notification)
		const session = makeSession("disappearing-model")
		const reporter = new SubagentConfigReporter(session, makeDependencies())
		reporter.publishInitial(send)

		session.model = undefined
		session.thinkingLevel = undefined
		const update = reporter.publishChanged(send)

		expect(update?.update).toEqual({ sessionUpdate: "config_option_update", configOptions: [] })
		expect(reporter.publishChanged(send)).toBeUndefined()
		expect(sent).toHaveLength(2)
	})
})
