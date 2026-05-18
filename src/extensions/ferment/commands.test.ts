import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { FermentCommandController, registerFermentCommands } from "./commands.js"
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
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>
}

function createHarness() {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-command-controller-test-")))
	let activeRef: Ferment | undefined
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
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
	it("executes add commands through injected runtime storage", async () => {
		const h = createHarness()
		const controller = new FermentCommandController()

		const result = await controller.execute(
			{ type: "add", title: "Controller Test" },
			{ raw: 'add "Controller Test"', pi: h.pi, ctx: h.ctx, runtime: h.runtime },
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
		await fermentCommand.handler('add "Registered Command"', h.ctx)

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

	it("reenables ferment tools after /auto resumes a paused ferment", async () => {
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

		expect(active.status).toBe("running")
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "create_ferment", "start_ferment_step"])
	})

	it("/pause transitions running ferment to paused status", async () => {
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
		h.runtime.setAutoModeEnabled = vi.fn()

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const pauseCommand = commands.get("pause")
		if (!pauseCommand) throw new Error("pause command was not registered")
		await pauseCommand.handler("", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.setAutoModeEnabled).toHaveBeenCalledWith(false)
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Paused"))
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
		expect(h.ctx.abort).toHaveBeenCalled()
	})

	it("/pause is a no-op when already paused", async () => {
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
		h.runtime.setAutoModeEnabled = vi.fn()

		const commands = new Map<string, RegisteredCommand>()
		const pi = {
			...h.pi,
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command)
			},
		} as unknown as ExtensionAPI
		registerFermentCommands(pi, h.runtime)

		const pauseCommand = commands.get("pause")
		if (!pauseCommand) throw new Error("pause command was not registered")
		await pauseCommand.handler("", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(active.status).toBe("paused")
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already paused"))
		expect(h.ctx.abort).not.toHaveBeenCalled()
	})

	it("implements pause → resume lifecycle with auto-mode toggle and tool restoration", async () => {
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
		h.runtime.setAutoModeEnabled = vi.fn()
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

		// Step 2: Call /pause handler → status becomes "paused", steps reset to "pending"
		const pauseCommand = commands.get("pause")
		if (!pauseCommand) throw new Error("pause command was not registered")
		await pauseCommand.handler("", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.setAutoModeEnabled).toHaveBeenCalledWith(false)
		expect(active.status).toBe("paused")
		expect(active.phases[0].steps[0].status).toBe("pending")
		expect(active.phases[0].steps[1].status).toBe("pending")
		expect(h.ctx.abort).toHaveBeenCalled()

		// Step 3: Call /auto handler → status becomes "running", active phase restored, setActiveTools called
		const autoCommand = commands.get("auto")
		if (!autoCommand) throw new Error("auto command was not registered")
		await autoCommand.handler("", h.ctx)

		active = h.storage.get(active.id) ?? active
		expect(h.runtime.setAutoModeEnabled).toHaveBeenCalledWith(true)
		expect(active.status).toBe("running")
		expect(active.phases[0].status).toBe("active")
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "create_ferment", "start_ferment_step"])

		// Step 4: Verify setAutoModeEnabled was called with both false and true
		expect(h.runtime.setAutoModeEnabled).toHaveBeenCalledTimes(2)
	})
})
