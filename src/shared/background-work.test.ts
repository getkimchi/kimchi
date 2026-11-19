import { afterEach, describe, expect, it, vi } from "vitest"
import {
	type BackgroundWorkItem,
	type BackgroundWorkProvider,
	backgroundWorkLabel,
	listBackgroundWork,
	registerBackgroundWorkProvider,
	stopAllBackgroundWork,
} from "./background-work.js"

const proc = (id: string): BackgroundWorkItem => ({ kind: "process", id, label: id })
const agent = (id: string): BackgroundWorkItem => ({ kind: "agent", id, label: id })

function provider(items: BackgroundWorkItem[]): BackgroundWorkProvider {
	return { list: () => items, stopAll: vi.fn(async () => items) }
}

describe("background-work", () => {
	const cleanups: Array<() => void> = []
	const register = (...args: Parameters<typeof registerBackgroundWorkProvider>) => {
		const unregister = registerBackgroundWorkProvider(...args)
		cleanups.push(unregister)
		return unregister
	}

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup()
		vi.restoreAllMocks()
	})

	it("is empty and a no-op stop for an unknown session", async () => {
		expect(listBackgroundWork("missing")).toEqual([])
		await expect(stopAllBackgroundWork("missing")).resolves.toEqual({ processes: 0, agents: 0 })
	})

	it("lists bash work before agent work, whatever the registration order", () => {
		register("s1", "agents", provider([agent("a1")]))
		register("s1", "bash", provider([proc("p1"), proc("p2")]))
		expect(listBackgroundWork("s1").map((item) => item.id)).toEqual(["p1", "p2", "a1"])
		expect(listBackgroundWork("s2")).toEqual([])
	})

	it("stops every provider and counts per kind", async () => {
		const bash = provider([proc("p1"), proc("p2")])
		const agents = provider([agent("a1")])
		register("s1", "bash", bash)
		register("s1", "agents", agents)
		await expect(stopAllBackgroundWork("s1")).resolves.toEqual({ processes: 2, agents: 1 })
		expect(bash.stopAll).toHaveBeenCalledOnce()
		expect(agents.stopAll).toHaveBeenCalledOnce()
	})

	it("keeps going when one provider throws and logs the error", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const agents = provider([agent("a1")])
		register("s1", "bash", {
			list: () => {
				throw new Error("list boom")
			},
			stopAll: () => {
				throw new Error("stop boom")
			},
		})
		register("s1", "agents", agents)

		expect(listBackgroundWork("s1")).toEqual([agent("a1")])
		await expect(stopAllBackgroundWork("s1")).resolves.toEqual({ processes: 0, agents: 1 })
		expect(agents.stopAll).toHaveBeenCalledOnce()
		expect(error).toHaveBeenCalledTimes(2)
		expect(String(error.mock.calls[1][1])).toContain("stop boom")
	})

	it("counts a rejected stop as nothing stopped", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		register("s1", "bash", { list: () => [], stopAll: () => Promise.reject(new Error("nope")) })
		register("s1", "agents", provider([agent("a1"), agent("a2")]))
		await expect(stopAllBackgroundWork("s1")).resolves.toEqual({ processes: 0, agents: 2 })
	})

	it("replaces a provider registered again under the same key", () => {
		register("s1", "bash", provider([proc("old")]))
		register("s1", "bash", provider([proc("new")]))
		expect(listBackgroundWork("s1").map((item) => item.id)).toEqual(["new"])
	})

	it("an old unregister does not remove a newer provider", () => {
		const unregisterOld = register("s1", "bash", provider([proc("old")]))
		const unregisterNew = register("s1", "bash", provider([proc("new")]))
		unregisterOld()
		expect(listBackgroundWork("s1").map((item) => item.id)).toEqual(["new"])
		unregisterNew()
		expect(listBackgroundWork("s1")).toEqual([])
	})

	it("builds one-line labels capped at 80 characters", () => {
		expect(backgroundWorkLabel("\n  npm run dev  \nmore")).toBe("npm run dev")
		const long = backgroundWorkLabel("x".repeat(200))
		expect(long).toHaveLength(80)
		expect(long.endsWith("…")).toBe(true)
		expect(backgroundWorkLabel("")).toBe("")
	})
})
