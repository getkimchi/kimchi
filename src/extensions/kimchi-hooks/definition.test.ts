import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { KIMCHI_HOOKS_ADAPTER_DEFINITION, discoverKimchiHookResources } from "./definition.js"

let dir: string

describe("Kimchi hooks discovery", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-hooks-def-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("sources() returns empty when .kimchi/ dir does not exist", () => {
		const sources = KIMCHI_HOOKS_ADAPTER_DEFINITION.sources(dir)

		expect(sources).toEqual([])
	})

	it("sources() returns the project path when .kimchi/hooks.json exists", () => {
		const projectHooks = join(dir, ".kimchi", "hooks.json")
		writeJson(projectHooks, {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "project-stop" }] }],
			},
		})

		const sources = KIMCHI_HOOKS_ADAPTER_DEFINITION.sources(dir)

		expect(sources).toEqual([{ scope: "project", path: projectHooks }])
	})

	it("sources() returns the local path when .kimchi/hooks.local.json exists", () => {
		const localHooks = join(dir, ".kimchi", "hooks.local.json")
		writeJson(localHooks, {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "local-stop" }] }],
			},
		})

		const sources = KIMCHI_HOOKS_ADAPTER_DEFINITION.sources(dir)

		expect(sources).toEqual([{ scope: "local", path: localHooks }])
	})

	it("sources() returns both when both exist", () => {
		const projectHooks = join(dir, ".kimchi", "hooks.json")
		const localHooks = join(dir, ".kimchi", "hooks.local.json")
		writeJson(projectHooks, {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "project-stop" }] }],
			},
		})
		writeJson(localHooks, {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "local-stop" }] }],
			},
		})

		const sources = KIMCHI_HOOKS_ADAPTER_DEFINITION.sources(dir)

		expect(sources).toEqual([
			{ scope: "project", path: projectHooks },
			{ scope: "local", path: localHooks },
		])
	})

	it("discoverKimchiHookResources returns empty when .kimchi/ is absent", () => {
		const resources = discoverKimchiHookResources(dir)

		expect(resources).toEqual([])
	})

	it("discoverKimchiHookResources discovers hooks from both files", () => {
		const projectHooks = join(dir, ".kimchi", "hooks.json")
		const localHooks = join(dir, ".kimchi", "hooks.local.json")
		writeJson(projectHooks, {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "project-stop" }] }],
			},
		})
		writeJson(localHooks, {
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "local-stop" }] }],
			},
		})

		const resources = discoverKimchiHookResources(dir)
		const commands = resources.map((r) => r.command).sort()

		expect(commands).toEqual(["local-stop", "project-stop"])
		expect(resources.every((r) => r.adapterId === "kimchi-hooks")).toBe(true)
	})
})

function writeJson(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8")
}
