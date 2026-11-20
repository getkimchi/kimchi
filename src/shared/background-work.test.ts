import { afterEach, describe, expect, it, vi } from "vitest"
import {
	type BackgroundWorkItem,
	type BackgroundWorkProvider,
	backgroundWorkLabel,
	listBackgroundWork,
	registerBackgroundWorkProvider,
	stopBackgroundWork,
} from "./background-work.js"

const proc = (id: string): BackgroundWorkItem => ({ kind: "process", id, label: id })
const agent = (id: string): BackgroundWorkItem => ({ kind: "agent", id, label: id })

function provider(items: BackgroundWorkItem[]): BackgroundWorkProvider {
	return { list: () => items, stop: vi.fn(async (ids) => items.filter((item) => ids.includes(item.id))) }
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
		await expect(stopBackgroundWork("missing", [proc("p1")])).resolves.toEqual({ processes: 0, agents: 0 })
	})

	it("lists bash work before agent work, whatever the registration order", () => {
		register("s1", "agents", provider([agent("a1")]))
		register("s1", "bash", provider([proc("p1"), proc("p2")]))
		expect(listBackgroundWork("s1").map((item) => item.id)).toEqual(["p1", "p2", "a1"])
		expect(listBackgroundWork("s2")).toEqual([])
	})

	it("sends each provider the ids of its kind and counts per kind", async () => {
		const bash = provider([proc("p1"), proc("p2")])
		const agents = provider([agent("a1")])
		register("s1", "bash", bash)
		register("s1", "agents", agents)
		const items = [proc("p1"), proc("p2"), agent("a1")]
		await expect(stopBackgroundWork("s1", items)).resolves.toEqual({ processes: 2, agents: 1 })
		expect(bash.stop).toHaveBeenCalledWith(["p1", "p2"])
		expect(agents.stop).toHaveBeenCalledWith(["a1"])
	})

	it("stops only the given items, not work that started later", async () => {
		const bash = provider([proc("p1"), proc("later")])
		register("s1", "bash", bash)
		await expect(stopBackgroundWork("s1", [proc("p1")])).resolves.toEqual({ processes: 1, agents: 0 })
		expect(bash.stop).toHaveBeenCalledWith(["p1"])
	})

	it("does not call a provider with no items of its kind", async () => {
		const bash = provider([proc("p1")])
		const agents = provider([agent("a1")])
		register("s1", "bash", bash)
		register("s1", "agents", agents)
		await expect(stopBackgroundWork("s1", [agent("a1")])).resolves.toEqual({ processes: 0, agents: 1 })
		expect(bash.stop).not.toHaveBeenCalled()
	})

	it("keeps going when one provider throws and logs the error", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		const agents = provider([agent("a1")])
		register("s1", "bash", {
			list: () => {
				throw new Error("list boom")
			},
			stop: () => {
				throw new Error("stop boom")
			},
		})
		register("s1", "agents", agents)

		expect(listBackgroundWork("s1")).toEqual([agent("a1")])
		await expect(stopBackgroundWork("s1", [proc("p1"), agent("a1")])).resolves.toEqual({ processes: 0, agents: 1 })
		expect(agents.stop).toHaveBeenCalledOnce()
		expect(error).toHaveBeenCalledTimes(2)
		expect(String(error.mock.calls[1][1])).toContain("stop boom")
	})

	it("counts a rejected stop as nothing stopped", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		register("s1", "bash", { list: () => [], stop: () => Promise.reject(new Error("nope")) })
		register("s1", "agents", provider([agent("a1"), agent("a2")]))
		await expect(stopBackgroundWork("s1", [proc("p1"), agent("a1"), agent("a2")])).resolves.toEqual({
			processes: 0,
			agents: 2,
		})
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

	it("strips terminal sequences and control characters from labels", () => {
		expect(backgroundWorkLabel("\x1b[2Jnpm\x1b[31m run\x1b[0m dev")).toBe("npm run dev")
		expect(backgroundWorkLabel("\x1b]52;c;aGVsbG8=\x07copy")).toBe("copy")
		expect(backgroundWorkLabel("\x1b]8;;https://x.test\x07link\x1b]8;;\x07")).toBe("link")
		expect(backgroundWorkLabel("a\tb\x00c")).toBe("a    bc")
		// A lone CR would move the cursor back over the label; treat it as a line break.
		expect(backgroundWorkLabel("  \rnpm run dev\rhidden")).toBe("npm run dev")
	})
})
