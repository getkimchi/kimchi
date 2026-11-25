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
	it("derives the dir from HOME and marks it derived", () => {
		stubHome(resolve("/home/parent"))
		const env: NodeJS.ProcessEnv = {}

		expect(applyAgentDirEnv(env)).toBe(join(resolve("/home/parent"), ".config", "kimchi", "harness"))
		expect(env.KIMCHI_CODING_AGENT_DIR_DERIVED).toBe("1")
	})

	it("gives a child with another HOME its own dir, not the parent's derived one", () => {
		stubHome(resolve("/home/parent"))
		const env: NodeJS.ProcessEnv = {}
		applyAgentDirEnv(env)

		stubHome(resolve("/home/child"))
		const child = { ...env }

		expect(applyAgentDirEnv(child)).toBe(join(resolve("/home/child"), ".config", "kimchi", "harness"))
		expect(child.KIMCHI_CODING_AGENT_DIR_DERIVED).toBe("1")
	})

	it("keeps an explicit dir in the child and never marks it derived", () => {
		stubHome(resolve("/home/parent"))
		const env: NodeJS.ProcessEnv = { KIMCHI_CODING_AGENT_DIR: resolve("/stage/agent") }
		applyAgentDirEnv(env)

		stubHome(resolve("/home/child"))
		const child = { ...env }

		expect(applyAgentDirEnv(child)).toBe(resolve("/stage/agent"))
		expect(env.KIMCHI_CODING_AGENT_DIR_DERIVED).toBeUndefined()
		expect(child.KIMCHI_CODING_AGENT_DIR_DERIVED).toBeUndefined()
	})
})
