import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
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
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
		setActive: vi.fn(),
	}
	const pi = {
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "bash"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "create_ferment" }, { name: "start_step" }]),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
	const ctx = {
		hasUI: false,
		ui: { notify: vi.fn() },
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
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash", "create_ferment", "start_step"])
	})
})
