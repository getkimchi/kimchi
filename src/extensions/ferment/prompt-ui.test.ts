import { beforeEach, describe, expect, it, vi } from "vitest"
import { promptInput, promptSelect } from "./prompt-ui.js"

const tipWidgetLocationMock = vi.hoisted(() => ({
	restore: vi.fn(),
	set: vi.fn(),
}))

vi.mock("../tips/index.js", () => ({
	setTipWidgetLocation: tipWidgetLocationMock.set,
}))

beforeEach(() => {
	tipWidgetLocationMock.restore.mockReset()
	tipWidgetLocationMock.set.mockReset()
	tipWidgetLocationMock.set.mockReturnValue(tipWidgetLocationMock.restore)
})

describe("ferment prompt UI", () => {
	it("hides tips while an input prompt replaces the editor", async () => {
		let resolveInput: (value: string | undefined) => void = () => {}
		const ui = {
			input: vi.fn(
				() =>
					new Promise<string | undefined>((resolve) => {
						resolveInput = resolve
					}),
			),
			setWorkingVisible: vi.fn(),
		}

		const pending = promptInput({ ui }, "What do you want to do?", "Describe it")

		expect(tipWidgetLocationMock.set).toHaveBeenCalledWith("hidden")
		expect(tipWidgetLocationMock.restore).not.toHaveBeenCalled()
		expect(ui.setWorkingVisible).toHaveBeenCalledWith(false)

		resolveInput("build it")

		await expect(pending).resolves.toBe("build it")
		expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(true)
		expect(tipWidgetLocationMock.restore).toHaveBeenCalledTimes(1)
	})

	it("hides tips while a selection prompt replaces the editor", async () => {
		const ui = {
			select: vi.fn(async () => "Start execution  ✓"),
			setWorkingVisible: vi.fn(),
		}

		await expect(promptSelect({ ui }, "Proceed with this plan?", ["Start execution  ✓"])).resolves.toBe(
			"Start execution  ✓",
		)

		expect(tipWidgetLocationMock.set).toHaveBeenCalledWith("hidden")
		expect(ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		expect(tipWidgetLocationMock.restore).toHaveBeenCalledTimes(1)
	})
})
