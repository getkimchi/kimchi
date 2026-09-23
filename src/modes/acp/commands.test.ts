import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { SLASH_COMMANDS } from "../../extensions/slash-commands.js"
import { asSession, BaseFakeAgentSession } from "./__mocks__/fake-agent-session.js"
import { makeResourceLoader } from "./__mocks__/resource-loader.js"
import {
	AVAILABLE_COMMANDS,
	composeAvailableCommands,
	createCommandsRefresher,
	discoverSkillCommandsMap,
	reloadSkillCommandsMap,
} from "./commands.js"
import { waitFor as sharedWaitFor } from "./test-utils.js"

describe("AVAILABLE_COMMANDS — ACP advertisement", () => {
	it("exposes at least one command", () => {
		expect(AVAILABLE_COMMANDS.length).toBeGreaterThan(0)
	})

	it("includes the /bug command advertised from SLASH_COMMANDS", () => {
		const bug = AVAILABLE_COMMANDS.find((c) => c.name === "bug")
		expect(bug).toBeDefined()
		expect(bug?.description).toBe(SLASH_COMMANDS.bug.hint)
	})

	it("every advertised name is a real slash command", () => {
		for (const cmd of AVAILABLE_COMMANDS) {
			expect(SLASH_COMMANDS).toHaveProperty(cmd.name)
		}
	})

	it("every advertised description is a non-empty string", () => {
		for (const cmd of AVAILABLE_COMMANDS) {
			expect(typeof cmd.description).toBe("string")
			expect(cmd.description.length).toBeGreaterThan(0)
		}
	})
})

function makeSession(opts: {
	skills: Array<{ name: string; description?: string; filePath: string }>
	reloads?: { n: number }
}): AgentSession {
	const fake = new BaseFakeAgentSession("acp-test-session")
	fake.resourceLoader = makeResourceLoader({
		skills: opts.skills,
		onReload: () => {
			if (opts.reloads) opts.reloads.n++
		},
	})
	return asSession(fake)
}

describe("composeAvailableCommands", () => {
	it("puts static commands first, then skill commands in map order", () => {
		const skills = new Map([
			["alpha", { name: "alpha", description: "Alpha skill", filePath: "/skills/alpha/SKILL.md" }],
			["beta", { name: "beta", description: "Beta skill", filePath: "/skills/beta/SKILL.md" }],
		])

		const commands = composeAvailableCommands(skills)

		expect(commands[0]?.name).toBe("bug")
		const skillCmds = commands.filter((c) => c.name.startsWith("skill:"))
		expect(skillCmds.map((c) => c.name)).toEqual(["skill:alpha", "skill:beta"])
		expect(skillCmds[0]?.input).toEqual({ hint: "Optional prompt to run with this skill loaded." })
	})

	it("returns only the static palette when a session has no skills", () => {
		expect(composeAvailableCommands(new Map()).map((c) => c.name)).toEqual(["bug"])
	})
})

describe("discoverSkillCommandsMap", () => {
	it("reads the loader's current skills without rescanning", () => {
		const reloads = { n: 0 }
		const session = makeSession({
			skills: [{ name: "deploy", description: "Ship it", filePath: "/skills/deploy/SKILL.md" }],
			reloads,
		})

		expect(discoverSkillCommandsMap(session).get("deploy")).toMatchObject({ name: "deploy" })
		expect(reloads.n).toBe(0)
	})
})

describe("reloadSkillCommandsMap", () => {
	it("rescans the loader before discovering skills", async () => {
		const reloads = { n: 0 }
		const session = makeSession({
			skills: [{ name: "deploy", description: "Ship it", filePath: "/skills/deploy/SKILL.md" }],
			reloads,
		})

		expect((await reloadSkillCommandsMap(session)).get("deploy")).toBeDefined()
		expect(reloads.n).toBe(1)
	})

	it("fails loudly when the private resource-refresh API disappears (upstream rename guard)", async () => {
		const session = makeSession({ skills: [] })
		;(session as unknown as Record<string, unknown>).extendResourcesFromExtensions = undefined

		await expect(reloadSkillCommandsMap(session)).rejects.toThrow(/extendResourcesFromExtensions/)
	})
})

describe("createCommandsRefresher", () => {
	const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
	const waitForCount = async (get: () => number, want: number): Promise<void> =>
		sharedWaitFor(() => get() >= want, { message: () => `waitForCount: got ${get()}, wanted ${want}` })

	function makeRecordHolder() {
		const reloads = { n: 0 }
		let gate: (() => void) | undefined
		const session = new BaseFakeAgentSession("acp-test-session")
		session.resourceLoader = makeResourceLoader({
			onReload: () => {
				reloads.n++
				return new Promise<void>((r) => {
					gate = r
				})
			},
		})
		return { reloads, record: { session: asSession(session), skillCommands: new Map() }, releaseGate: () => gate?.() }
	}

	it("serializes a kick that arrives while a sweep is in flight", async () => {
		const { reloads, record, releaseGate } = makeRecordHolder()
		const broadcasts: string[] = []
		const refresher = createCommandsRefresher({
			sessions: () => [["s1", record] as [string, typeof record]],
			broadcast: (id) => broadcasts.push(id),
			debounceMs: 0,
		})

		refresher.request()
		await waitForCount(() => reloads.n, 1) // sweep started, stuck in reload
		refresher.request()
		refresher.request() // collapsed into the single pending follow-up
		releaseGate()
		await waitForCount(() => reloads.n, 2) // follow-up sweep's reload
		releaseGate()
		await waitForCount(() => broadcasts.length, 2)

		expect(reloads.n).toBe(2)
	})

	it("cancelling mid-sweep stops further reloads and broadcasts", async () => {
		const { reloads, record, releaseGate } = makeRecordHolder()
		const broadcasts: string[] = []
		const refresher = createCommandsRefresher({
			sessions: () => [["s1", record] as [string, typeof record]],
			broadcast: (id) => broadcasts.push(id),
			debounceMs: 0,
		})

		refresher.request()
		await waitForCount(() => reloads.n, 1) // sweep stuck in reload
		refresher.cancel()
		releaseGate()
		await tick(50)

		expect(broadcasts).toEqual([])
	})

	it("a failed reload keeps that session's palette but does not stop the sweep", async () => {
		const failingSession = new BaseFakeAgentSession("s-bad")
		failingSession.resourceLoader = makeResourceLoader({
			onReload: () => {
				throw new Error("boom")
			},
		})
		const failing = {
			session: asSession(failingSession),
			skillCommands: new Map([["old", { name: "old", description: "", filePath: "/s/old/SKILL.md" }]]),
		}
		const healthy = {
			session: asSession(new BaseFakeAgentSession("s-good")),
			skillCommands: new Map<string, { name: string; description: string; filePath: string }>(),
		}
		const broadcasts: string[] = []
		const origWrite = process.stderr.write.bind(process.stderr)
		const stderrWrites: string[] = []
		// biome-ignore lint/suspicious/noExplicitAny: test-only stderr capture
		;(process.stderr.write as any) = (chunk: string | Uint8Array) => {
			stderrWrites.push(String(chunk))
			return true
		}
		try {
			const refresher = createCommandsRefresher({
				sessions: () => [
					["bad", failing],
					["good", healthy],
				],
				broadcast: (id) => broadcasts.push(id),
				debounceMs: 0,
			})
			refresher.request()
			await waitForCount(() => broadcasts.length, 1)
		} finally {
			process.stderr.write = origWrite
		}

		expect(broadcasts).toEqual(["good"])
		expect(failing.skillCommands.has("old")).toBe(true)
		expect(stderrWrites.some((w) => w.includes("reload failed for session bad"))).toBe(true)
	})

	it("a sweep escape (e.g. broadcast throwing) is logged and does not wedge the refresher", async () => {
		const reloads = { n: 0 }
		const session = new BaseFakeAgentSession("acp-test-session")
		session.resourceLoader = makeResourceLoader({
			onReload: () => {
				reloads.n++
			},
		})
		const record = { session: asSession(session), skillCommands: new Map() }
		const origWrite = process.stderr.write.bind(process.stderr)
		const stderrWrites: string[] = []
		// biome-ignore lint/suspicious/noExplicitAny: test-only stderr capture
		;(process.stderr.write as any) = (chunk: string | Uint8Array) => {
			stderrWrites.push(String(chunk))
			return true
		}
		try {
			let calls = 0
			const refresher = createCommandsRefresher({
				sessions: () => [["s1", record] as [string, typeof record]],
				broadcast: () => {
					if (calls++ === 0) throw new Error("broadcast boom")
				},
				debounceMs: 0,
			})
			refresher.request()
			await waitForCount(() => stderrWrites.filter((w) => w.includes("sweep failed")).length, 1)

			// Not wedged: the next kick sweeps and broadcasts normally again.
			refresher.request()
			await waitForCount(() => reloads.n, 2)
			expect(calls).toBe(2)
		} finally {
			process.stderr.write = origWrite
		}
	})

	it("cancelling before the debounce fires drops the sweep", async () => {
		const { reloads, record } = makeRecordHolder()
		const refresher = createCommandsRefresher({
			sessions: () => [["s1", record] as [string, typeof record]],
			broadcast: () => {},
			debounceMs: 50,
		})

		refresher.request()
		refresher.cancel()
		await tick(150)

		expect(reloads.n).toBe(0)
	})
})
