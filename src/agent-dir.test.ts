import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { applyAgentDirEnv } from "./agent-dir.js"

afterEach(() => {
	vi.unstubAllEnvs()
})

function stubHome(home: string): void {
	vi.stubEnv("HOME", home)
	vi.stubEnv("USERPROFILE", home)
}

describe("applyAgentDirEnv", () => {
	it("derives the dir from HOME, marks it, and gives a child with another HOME its own", () => {
		stubHome(resolve("/home/parent"))
		const env: NodeJS.ProcessEnv = {}
		const parentDir = join(resolve("/home/parent"), ".config", "kimchi", "harness")
		expect(applyAgentDirEnv(env)).toBe(parentDir)
		expect(env.KIMCHI_CODING_AGENT_DIR_DERIVED).toBe(parentDir)

		stubHome(resolve("/home/child"))
		const child = { ...env }

		const derived = join(resolve("/home/child"), ".config", "kimchi", "harness")
		expect(applyAgentDirEnv(child)).toBe(derived)
		expect(child.KIMCHI_CODING_AGENT_DIR_DERIVED).toBe(derived)
	})

	it("keeps an explicit dir set under an inherited marker, and so does its child", () => {
		stubHome(resolve("/home/parent"))
		const parent: NodeJS.ProcessEnv = {}
		applyAgentDirEnv(parent)

		// e.g. `KIMCHI_CODING_AGENT_DIR=/tmp/stage kimchi` typed in a Kimchi shell
		const child: NodeJS.ProcessEnv = { ...parent, KIMCHI_CODING_AGENT_DIR: resolve("/tmp/stage") }
		expect(applyAgentDirEnv(child)).toBe(resolve("/tmp/stage"))
		expect(child.KIMCHI_CODING_AGENT_DIR_DERIVED).toBeUndefined()

		stubHome(resolve("/home/grandchild"))
		const grandchild = { ...child }
		expect(applyAgentDirEnv(grandchild)).toBe(resolve("/tmp/stage"))
		expect(grandchild.KIMCHI_CODING_AGENT_DIR_DERIVED).toBeUndefined()
	})

	it("expands a leading ~ in an explicit dir", () => {
		stubHome(resolve("/home/user"))

		expect(applyAgentDirEnv({ KIMCHI_CODING_AGENT_DIR: "~/stage" })).toBe(join(resolve("/home/user"), "stage"))
		expect(applyAgentDirEnv({ KIMCHI_CODING_AGENT_DIR: "~" })).toBe(resolve("/home/user"))
	})
})
