import { afterEach, describe, expect, it, vi } from "vitest"
import { confirm } from "./_helpers.js"

type Listener = (chunk?: Buffer) => void

/** Spy on stdin/stdout, capturing listeners so tests can emit manually. */
function mockPromptIo(): { emitData: (text: string) => void; emitClose: () => void } {
	const dataListeners: Listener[] = []
	const closeListeners: Array<() => void> = []
	vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never)
	vi.spyOn(process.stdin, "on").mockImplementation(((event: string, cb: Listener) => {
		if (event === "data") dataListeners.push(cb)
		return process.stdin
	}) as never)
	vi.spyOn(process.stdin, "once").mockImplementation(((event: string, cb: () => void) => {
		if (event === "close") closeListeners.push(cb)
		return process.stdin
	}) as never)
	vi.spyOn(process.stdin, "off").mockImplementation((() => process.stdin) as never)
	vi.spyOn(process.stdin, "resume").mockImplementation((() => process.stdin) as never)
	vi.spyOn(process.stdin, "pause").mockImplementation((() => process.stdin) as never)
	return {
		emitData: (text: string) => {
			for (const cb of [...dataListeners]) cb(Buffer.from(text))
		},
		emitClose: () => {
			for (const cb of [...closeListeners]) cb()
		},
	}
}

describe("confirm", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("bare Enter means yes", async () => {
		const io = mockPromptIo()
		const result = confirm("proceed? ")
		io.emitData("\n")
		await expect(result).resolves.toBe(true)
	})

	it("explicit y means yes", async () => {
		const io = mockPromptIo()
		const result = confirm("proceed? ")
		io.emitData("y\n")
		await expect(result).resolves.toBe(true)
	})

	it("explicit n means no", async () => {
		const io = mockPromptIo()
		const result = confirm("proceed? ")
		io.emitData("n\n")
		await expect(result).resolves.toBe(false)
	})

	it("declines when stdin closes without data instead of hanging", async () => {
		const io = mockPromptIo()
		const result = confirm("proceed? ")
		io.emitClose()
		await expect(result).resolves.toBe(false)
	})

	it("the first answer wins when data is followed by close", async () => {
		const io = mockPromptIo()
		const result = confirm("proceed? ")
		io.emitData("y\n")
		io.emitClose()
		await expect(result).resolves.toBe(true)
	})
})
