import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import benchmarkProfileExtension, {
	getBenchmarkProfile,
	isLeanBenchmarkProfile,
	KIMCHI_BENCHMARK_PROFILE_ENV,
} from "./benchmark-profile.js"
import questionnaireExtension from "./questionnaire/questionnaire.js"
import todosExtension from "./todos/index.js"
import { TODO_TOOL_NAMES } from "./todos/tool.js"

const LEAN_ENV = { [KIMCHI_BENCHMARK_PROFILE_ENV]: "lean" } as NodeJS.ProcessEnv

function makePi(): ExtensionAPI & {
	registeredTools: string[]
	active: string[]
	fire(event: string, ctx?: unknown): void
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>()
	const state = {
		registeredTools: [] as string[],
		active: ["read", "bash", "set_phase", "questionnaire", ...TODO_TOOL_NAMES],
		fire(event: string, ctx?: unknown) {
			for (const h of handlers.get(event) ?? []) h({}, ctx)
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			const registered = handlers.get(event) ?? []
			registered.push(handler)
			handlers.set(event, registered)
		},
		registerTool(tool: ToolInfo) {
			state.registeredTools.push(tool.name)
		},
		registerCommand() {},
		registerShortcut() {},
		getActiveTools() {
			return state.active
		},
		setActiveTools(names: string[]) {
			state.active = names
		},
	}
	return state as unknown as ExtensionAPI & {
		registeredTools: string[]
		active: string[]
		fire(event: string, ctx?: unknown): void
	}
}

function setProfileEnv(value: string | undefined): void {
	if (value === undefined) delete process.env[KIMCHI_BENCHMARK_PROFILE_ENV]
	else process.env[KIMCHI_BENCHMARK_PROFILE_ENV] = value
}

afterEach(() => {
	delete process.env[KIMCHI_BENCHMARK_PROFILE_ENV]
})

describe("benchmark profile env parsing", () => {
	it("returns undefined when the env var is missing or blank", () => {
		expect(getBenchmarkProfile({} as NodeJS.ProcessEnv)).toBeUndefined()
		expect(getBenchmarkProfile({ [KIMCHI_BENCHMARK_PROFILE_ENV]: "  " } as NodeJS.ProcessEnv)).toBeUndefined()
	})

	it("trims the profile value", () => {
		expect(getBenchmarkProfile({ [KIMCHI_BENCHMARK_PROFILE_ENV]: " lean " } as NodeJS.ProcessEnv)).toBe("lean")
	})

	it("detects the lean profile only for the exact value", () => {
		expect(isLeanBenchmarkProfile(LEAN_ENV)).toBe(true)
		expect(isLeanBenchmarkProfile({ [KIMCHI_BENCHMARK_PROFILE_ENV]: "default" } as NodeJS.ProcessEnv)).toBe(false)
		expect(isLeanBenchmarkProfile({} as NodeJS.ProcessEnv)).toBe(false)
	})
})

describe("benchmarkProfileExtension", () => {
	it("hides set_phase on session_start under the lean profile", () => {
		setProfileEnv("lean")
		const pi = makePi()
		benchmarkProfileExtension(pi)

		pi.fire("session_start")

		expect(pi.active).not.toContain("set_phase")
		// Other tools are untouched — only set_phase gets a disable vote.
		expect(pi.active).toContain("bash")
	})

	it("is a no-op without the lean profile", () => {
		const pi = makePi()
		benchmarkProfileExtension(pi)

		pi.fire("session_start")

		expect(pi.active).toContain("set_phase")
	})
})

describe("lean profile extension gating", () => {
	it("todos extension registers no todo tools under the lean profile", () => {
		setProfileEnv("lean")
		const pi = makePi()
		todosExtension(pi)

		expect(pi.registeredTools).toEqual([])
	})

	it("todos extension registers the full todo tool set by default", () => {
		const pi = makePi()
		todosExtension(pi)

		for (const name of TODO_TOOL_NAMES) {
			expect(pi.registeredTools).toContain(name)
		}
	})

	it("questionnaire extension registers no tool under the lean profile", () => {
		setProfileEnv("lean")
		const pi = makePi()
		questionnaireExtension(pi)

		expect(pi.registeredTools).toEqual([])
	})

	it("questionnaire extension registers its tool by default", () => {
		const pi = makePi()
		questionnaireExtension(pi)

		expect(pi.registeredTools).toContain("questionnaire")
	})
})
