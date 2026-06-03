import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const original = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	return {
		...original,
		copyToClipboard: vi.fn(),
	}
})

import { copyToClipboard } from "@earendil-works/pi-coding-agent"
import { createXtermCore } from "./xterm-core.js"

const mockCopyToClipboard = vi.mocked(copyToClipboard)

describe("XtermCore OSC 52 clipboard sync", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCopyToClipboard.mockResolvedValue(undefined)
	})

	it("calls copyToClipboard when OSC 52 clipboard data arrives via BEL terminator", async () => {
		const core = createXtermCore(80, 24)
		const text = "hello tmux"
		const b64 = Buffer.from(text).toString("base64")
		await core.writeString(`\x1b]52;c;${b64}\x07`)

		expect(mockCopyToClipboard).toHaveBeenCalledTimes(1)
		expect(mockCopyToClipboard).toHaveBeenCalledWith(text)
		core.dispose()
	})

	it("calls copyToClipboard when OSC 52 clipboard data arrives via ST terminator", async () => {
		const core = createXtermCore(80, 24)
		const text = "copy via st"
		const b64 = Buffer.from(text).toString("base64")
		await core.writeString(`\x1b]52;c;${b64}\x1b\\`)

		expect(mockCopyToClipboard).toHaveBeenCalledTimes(1)
		expect(mockCopyToClipboard).toHaveBeenCalledWith(text)
		core.dispose()
	})

	it("ignores malformed OSC 52 without semicolon", async () => {
		const core = createXtermCore(80, 24)
		await core.writeString("\x1b]52;bad\x07")

		expect(mockCopyToClipboard).not.toHaveBeenCalled()
		core.dispose()
	})

	it("ignores empty base64 payload", async () => {
		const core = createXtermCore(80, 24)
		await core.writeString("\x1b]52;c;\x07")

		expect(mockCopyToClipboard).not.toHaveBeenCalled()
		core.dispose()
	})

	it("handles utf-8 text after base64 decode", async () => {
		const core = createXtermCore(80, 24)
		const text = "héllo wörld 🌍"
		const b64 = Buffer.from(text).toString("base64")
		await core.writeString(`\x1b]52;c;${b64}\x07`)

		expect(mockCopyToClipboard).toHaveBeenCalledWith(text)
		core.dispose()
	})

	it("does not throw when copyToClipboard rejects", async () => {
		mockCopyToClipboard.mockRejectedValue(new Error("clipboard unavailable"))
		const core = createXtermCore(80, 24)
		const text = "should not crash"
		const b64 = Buffer.from(text).toString("base64")

		await expect(core.writeString(`\x1b]52;c;${b64}\x07`)).resolves.not.toThrow()
		core.dispose()
	})
})
