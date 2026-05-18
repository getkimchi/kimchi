import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { FermentCommandController, getFermentArgumentCompletions, registerFermentCommands } from "./commands.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { createApplyAndPersist } from "./tool-helpers.js"

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		writeFileSync: vi.fn(actual.writeFileSync),
	}
})

vi.mock("../../ferment/shorten-title.js", () => ({
	shortenTitle: vi.fn(async (input: string) => input),
}))

const writeFileSyncMock = vi.mocked(writeFileSync)
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs")

afterEach(() => {
	writeFileSyncMock.mockReset()
	writeFileSyncMock.mockImplementation(actualFs.writeFileSync)
})

interface RegisteredCommand {
	getArgumentCompletions?: (
		prefix: string,
	) =>
		| Promise<Array<{ value: string; label: string; description?: string }> | null>
		| Array<{ value: string; label: string; description?: string }>
		| null
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>
}

function createHarness() {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-command-controller-test-")))
	const baseRuntime = createDefaultFermentRuntime()
	baseRuntime.setContinuationPolicy("manual")
	let activeRef: Ferment | undefined
	const runtime: FermentRuntime = {
		...baseRuntime,
		getStorage: () => storage,
		getActive: vi.fn(() => activeRef),
		getActiveId: vi.fn(() => activeRef?.id),
		setActive: vi.fn((ferment: Ferment | undefined) => {
			activeRef = ferment
		}),
	}
	const pi = {
		on: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "bash"]),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "create_ferment" },
			{ name: "start_ferment_step" },
		]),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
	const ctx = {
		hasUI: false,
		ui: { notify: vi.fn() },
		abort: vi.fn(),
	} as unknown as ExtensionCommandContext
	return { storage, runtime, pi, ctx }
}

describe("FermentCommandController", () => {
	it("executes new commands through injected runtime storage", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute(
			{ type: "new", title: "Controller Test" },
			{ raw: 'new "Controller Test"', pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		const created = h.storage.list().find((f) => f.name === "Controller Test")
		expect(result).toEqual({ handled: true })
		expect(created).toBeDefined()
		expect(h.runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }))
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [expect.objectContaining({ text: expect.stringContaining("Scope:") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("echoes the interactive request before starting the hidden scoping turn", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ctx = {
			hasUI: true,
			ui: {
				notify: vi.fn(),
				input: vi.fn().mockResolvedValueOnce("make the todo app glassy"),
				select: vi.fn().mockResolvedValue("No, I know what I'm doing"),
			},
		} as unknown as ExtensionCommandContext

		const result = await controller.execute({ type: "interactive" }, { raw: "", pi: h.pi, ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_request",
				display: true,
				details: { intent: "make the todo app glassy" },
			}),
		)
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_created_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("make the todo app glassy") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("returns a structured handled result for headless list output", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		h.storage.create("Existing")

		const result = await controller.execute({ type: "list" }, { raw: "list", pi: h.pi, ctx: h.ctx, runtime: h.runtime })

		expect(result).toEqual({ handled: true })
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Existing"))
	})

	it("reports unknown commands without creating a ferment", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute(
			{ type: "unknown", input: 'use "Existing"' },
			{ raw: 'use "Existing"', pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.storage.list()).toHaveLength(0)
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown /ferment command"))
	})

	it("reports export write failures without throwing", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const active = h.storage.create("Export Test")
		h.runtime.getActive = vi.fn(() => active)
		writeFileSyncMock.mockImplementation(() => {
			throw new Error("permission denied")
		})

		const result = await controller.execute(
			{ type: "export" },
			{ raw: "export", pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Export failed: permission denied")
	})
})

describe("registerFermentCommands", () => {
	it("registers /ferment against the injected runtime storage", async () => {
		const h = createHarness()
		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler('new "Registered Command"', h.ctx)

		const created = h.storage.list().find((f) => f.name === "Registered Command")
		expect(created).toBeDefined()
		expect(h.runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }))
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [expect.objectContaining({ text: expect.stringContaining("Scope:") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("registers /ferment argument completions for lifecycle subcommands", async () => {
		const h = createHarness()
		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand?.getArgumentCompletions) throw new Error("ferment completions were not registered")

		const completions = await fermentCommand.getArgumentCompletions("pa")

		expect(completions).toContainEqual(
			expect.objectContaining({
				value: "pause",
				label: "pause",
				description: expect.stringContaining("Pause"),
			}),
		)
		expect(completions).not.toContainEqual(expect.objectContaining({ value: "use " }))
		expect(completions).not.toContainEqual(expect.objectContaining({ value: "add " }))
	})

	it("advertises /ferment new as the create subcommand", () => {
		const h = createHarness()

		expect(getFermentArgumentCompletions("n", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "new ", label: "new" }),
		)
	})

	it("shows /ferment new first in broad argument completions", () => {
		const h = createHarness()

		expect(getFermentArgumentCompletions("", h.runtime)?.[0]).toEqual(
			expect.objectContaining({ value: "new ", label: "new" }),
		)
	})

	it("completes /ferment target subcommands from stored ferments", () => {
		const h = createHarness()
		const ferment = h.storage.create("Auth Rewrite")

		const completions = getFermentArgumentCompletions("switch auth", h.runtime)

		expect(completions).toContainEqual(
			expect.objectContaining({
				value: `switch "${ferment.name}"`,
				label: ferment.name,
				description: expect.stringContaining(ferment.id.slice(0, 8)),
			}),
		)
		expect(getFermentArgumentCompletions("resume ", h.runtime)).toBeNull()
	})

	it("completes /ferment nested static argument groups", () => {
		const h = createHarness()

		expect(getFermentArgumentCompletions("revise c", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "revise criteria", label: "criteria" }),
		)
		expect(getFermentArgumentCompletions("mode e", h.runtime)).toContainEqual(
			expect.objectContaining({ value: "mode exec", label: "exec" }),
		)
	})

	it("/manual and /auto update continuation policy without changing lifecycle status", async () => {
		const h = createHarness()
		const ferment = h.storage.create("Policy Ferment")
		h.runtime.setActive(ferment)

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const autoCommand = commands.get("auto")
		const manualCommand = commands.get("manual")
		if (!autoCommand) throw new Error("auto command was not registered")
		if (!manualCommand) throw new Error("manual command was not registered")

		await autoCommand.handler("", h.ctx)
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(h.storage.get(ferment.id)?.status).toBe("draft")

		await manualCommand.handler("", h.ctx)
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(h.storage.get(ferment.id)?.status).toBe("draft")
	})

	it("/auto on a paused ferment sets automated policy without resuming lifecycle", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Paused Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const paused = applyAndPersist(ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment ?? active
		})

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const autoCommand = commands.get("auto")
		if (!autoCommand) throw new Error("auto command was not registered")
		await autoCommand.handler("", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("run /ferment resume"))
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
	})

	it("/ferment mode is a compatibility stub that does not mutate policy or persisted state", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()
		const ferment = h.storage.create("Legacy Mode Command")
		h.runtime.setActive(ferment)

		const result = await controller.execute(
			{ type: "mode", mode: "exec" },
			{ raw: "mode exec", pi: h.pi, ctx: h.ctx, runtime: h.runtime },
		)

		expect(result).toEqual({ handled: true })
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(h.storage.get(ferment.id)).not.toHaveProperty("mode")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Legacy ferment modes are ignored"))
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
	})

	it("/auto at a phase boundary kicks automated continuation without changing lifecycle state", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Boundary Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)

		let active = completed.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment ?? active
		})

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const autoCommand = commands.get("auto")
		if (!autoCommand) throw new Error("auto command was not registered")
		await autoCommand.handler("", h.ctx)

		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("planned")
		expect(active.phases[1].status).toBe("planned")
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_automode_nudge",
				content: [
					expect.objectContaining({
						text: expect.stringContaining(
							`Action: call activate_ferment_phase with ferment_id "${active.id}", phase_id "phase-2"`,
						),
					}),
				],
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		)
	})

	it("/ferment list Continue on the active ferment kicks continuation", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Active List Continue")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)

		let active = activated.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.getActiveId = vi.fn(() => active?.id)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment
		})
		const select = vi
			.fn()
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
		const ctx = { ...h.ctx, hasUI: true, ui: { ...h.ctx.ui, select } } as ExtensionCommandContext

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("list", ctx)

		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_resume_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("start_ferment_step") })],
			}),
			{ triggerTurn: true },
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith('Continuing "Active List Continue"')
	})

	it("/ferment list Continue explicitly crosses a manual phase boundary", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Boundary List Continue")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(activated.ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)

		let active = completed.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.getActiveId = vi.fn(() => active?.id)
		h.runtime.setActive = vi.fn((ferment) => {
			active = ferment
		})
		h.runtime.setContinuationPolicy("manual")
		const select = vi
			.fn()
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
			.mockImplementationOnce((_title: string, options: string[]) => options[0])
		const ctx = { ...h.ctx, hasUI: true, ui: { ...h.ctx.ui, select } } as ExtensionCommandContext

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("list", ctx)

		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_resume_nudge",
				content: [expect.objectContaining({ text: "activate_ferment_phase: activate the first planned phase" })],
			}),
			{ triggerTurn: true },
		)
		expect(active.status).toBe("planned")
		expect(ctx.ui.notify).toHaveBeenCalledWith('Continuing "Boundary List Continue"')
	})

	it("does not register a top-level /pause command", () => {
		const h = createHarness()
		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI

		registerFermentCommands(pi, h.runtime)

		expect(commands.has("pause")).toBe(false)
	})

	it("/ferment pause transitions running ferment to paused status", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Running Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)

		let active = activated.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setContinuationPolicy("automated")

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("pause", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Paused"))
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
		expect(h.ctx.abort).toHaveBeenCalled()
	})

	it("/ferment pause is a no-op when already paused", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Already Paused Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const paused = applyAndPersist(ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("pause", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already paused"))
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("/ferment resume"))
		expect(h.ctx.abort).not.toHaveBeenCalled()
	})

	it("implements pause → /auto → /ferment resume with policy separated from lifecycle", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Lifecycle Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }, { description: "Test it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)

		let active = activated.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((f) => {
			active = f ?? active
		})
		h.runtime.setContinuationPolicy("manual")
		h.pi.setActiveTools = vi.fn()

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		// Step 1: Verify initial state (running with active phase)
		expect(active.status).toBe("running")
		expect(active.phases[0].status).toBe("active")

		// Step 2: Call /ferment pause → status becomes "paused", steps reset to "pending"
		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("pause", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(active.status).toBe("paused")
		expect(active.phases[0].steps[0].status).toBe("pending")
		expect(active.phases[0].steps[1].status).toBe("pending")
		expect(h.ctx.abort).toHaveBeenCalled()

		// Step 3: Call /auto handler → policy changes, lifecycle stays paused
		const autoCommand = commands.get("auto")
		if (!autoCommand) throw new Error("auto command was not registered")
		await autoCommand.handler("", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("run /ferment resume"))

		// Step 4: Call /ferment resume → lifecycle resumes using the current policy
		await fermentCommand.handler("resume", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("automated")
		expect(active.status).toBe("running")
		expect(active.phases[0].status).toBe("active")
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "create_ferment", "start_ferment_step"])
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_resume_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("start_ferment_step") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("/ferment resume in manual policy kicks work inside the active phase", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Manual Resume Ferment")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const paused = applyAndPersist(activated.ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((f) => {
			active = f ?? active
		})
		h.runtime.setContinuationPolicy("manual")

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("resume", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.getContinuationPolicy()).toBe("manual")
		expect(active.status).toBe("running")
		expect(active.phases[0].status).toBe("active")
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_resume_nudge",
				content: [expect.objectContaining({ text: expect.stringContaining("start_ferment_step") })],
			}),
			{ triggerTurn: true },
		)
	})

	it("/ferment resume in manual policy does not cross a phase boundary", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const ferment = h.storage.create("Manual Boundary Resume")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [
				{ name: "Done", goal: "Build", steps: [] },
				{ name: "Next", goal: "Continue", steps: [] },
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(scoped.ferment.id, { type: "activate_phase", phaseId: "phase-1" })
		if (!activated.ok) throw new Error(activated.error.message)
		const completed = applyAndPersist(activated.ferment.id, {
			type: "complete_phase",
			phaseId: "phase-1",
			summary: "done",
		})
		if (!completed.ok) throw new Error(completed.error.message)
		const paused = applyAndPersist(completed.ferment.id, { type: "pause" })
		if (!paused.ok) throw new Error(paused.error.message)

		let active = paused.ferment
		h.runtime.getActive = vi.fn(() => active)
		h.runtime.setActive = vi.fn((f) => {
			active = f ?? active
		})
		h.runtime.setContinuationPolicy("manual")

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const fermentCommand = commands.get("ferment")
		if (!fermentCommand) throw new Error("ferment command was not registered")
		await fermentCommand.handler("resume", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(active.status).toBe("planned")
		expect(active.phases[1].status).toBe("planned")
		expect(h.pi.sendMessage).not.toHaveBeenCalled()
		expect(h.pi.appendEntry).toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({ text: expect.stringContaining("Manual resume waiting at phase boundary") }),
		)
	})
})
