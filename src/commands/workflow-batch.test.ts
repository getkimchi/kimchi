import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runWorkflowBatch } from "./workflow-batch.js"

describe("runWorkflowBatch", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
	})

	afterEach(() => {
		stderrSpy.mockRestore()
	})

	it("forwards the post-verb argv verbatim to the host main", async () => {
		let seen: string[] | undefined
		await runWorkflowBatch(["run", "smoke-ok", "--result-out", "out/r.json"], {
			main: async (args) => {
				seen = args
				return 0
			},
		})
		expect(seen).toEqual(["run", "smoke-ok", "--result-out", "out/r.json"])
	})

	it.each([
		[0, "completed"],
		[2, "blocked"],
		[3, "cancelled"],
		[4, "crashed"],
	])("passes the host's exit code %d through untouched (%s)", async (code) => {
		const result = await runWorkflowBatch(["run", "w"], { main: async () => code })
		expect(result).toBe(code)
	})

	it("maps a non-integer main resolution to a crashed run (4) — never leaks garbage to process.exit", async () => {
		for (const bogus of [undefined, Number.NaN, "4", 3.14] as unknown[]) {
			const result = await runWorkflowBatch(["run", "w"], { main: async () => bogus as number })
			expect(result).toBe(4)
		}
	})

	it("converts a host throw into one clean stderr line and exit 4 (no raw stack for scheduler logs)", async () => {
		const result = await runWorkflowBatch(["run", "w"], {
			main: async () => {
				throw new Error("sub-cli blew up")
			},
		})
		expect(result).toBe(4)
		expect(stderrSpy).toHaveBeenCalledTimes(1)
		const line = String(stderrSpy.mock.calls[0][0])
		expect(line).toContain("workflow: sub-cli blew up")
		expect(line).toMatch(/\n$/)
	})

	it("non-Error throws are stringified instead of crashing with [object Object]", async () => {
		const result = await runWorkflowBatch(["run", "w"], {
			main: async () => {
				// oxlint-disable-next-line no-throw-literal -- deliberate non-Error throw for the contract check
				throw { weird: true }
			},
		})
		expect(result).toBe(4)
		expect(String(stderrSpy.mock.calls[0][0])).toContain("[object Object]")
	})
})
