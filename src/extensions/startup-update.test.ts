import { beforeEach, describe, expect, it, vi } from "vitest"

const checkForUpdateMock = vi.fn()
const getVersionMock = vi.fn()
const isHomebrewInstallMock = vi.fn(() => false)

vi.mock(import("../update/workflow.js"), async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...actual,
		checkForUpdate: (...args: unknown[]) => checkForUpdateMock(...args),
	}
})
vi.mock("../utils.js", () => ({
	getVersion: () => getVersionMock(),
}))
vi.mock("../update/paths.js", () => ({
	isHomebrewInstall: () => isHomebrewInstallMock(),
}))

const { default: startupUpdateExtension } = await import("./startup-update.js")

type Handler = (event: unknown, ctx: unknown) => unknown

function createMockApi() {
	const handlers = new Map<string, Handler>()
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler)
		},
	}
	return { handlers, api: api as unknown as Parameters<typeof startupUpdateExtension>[0] }
}

function makeCtx(opts: { hasUI: boolean }) {
	const setStatus = vi.fn()
	const ctx = {
		hasUI: opts.hasUI,
		ui: {
			setStatus,
			theme: { bold: (s: string) => s },
		},
	}
	return { ctx, setStatus }
}

describe("startupUpdateExtension", () => {
	beforeEach(() => {
		checkForUpdateMock.mockReset()
		getVersionMock.mockReset()
		isHomebrewInstallMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
	})

	it("checks for update on bare 0.0.0 dev build", async () => {
		getVersionMock.mockReturnValue("0.0.0")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(setStatus).toHaveBeenCalledOnce()
	})

	it("does not check or set status when local version is canary", async () => {
		getVersionMock.mockReturnValue("0.0.0-canary.20260509.abc1234")
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).not.toHaveBeenCalled()
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("sets update-available status on stable when remote is newer", async () => {
		getVersionMock.mockReturnValue("v0.0.23")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(setStatus).toHaveBeenCalledOnce()
		const [key, msg] = setStatus.mock.calls[0]
		expect(key).toBe("update-available")
		expect(msg).toContain("kimchi update")
	})

	it("does not set status on stable when no update", async () => {
		getVersionMock.mockReturnValue("v0.0.23")
		checkForUpdateMock.mockResolvedValue({ hasUpdate: false })
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: true })
		await handler({}, ctx)

		expect(checkForUpdateMock).toHaveBeenCalledOnce()
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("skips entirely when hasUI is false", async () => {
		getVersionMock.mockReturnValue("v0.0.23")
		const { handlers, api } = createMockApi()
		startupUpdateExtension(api)
		const handler = handlers.get("session_start")
		if (!handler) throw new Error("no session_start handler")

		const { ctx, setStatus } = makeCtx({ hasUI: false })
		await handler({}, ctx)

		expect(checkForUpdateMock).not.toHaveBeenCalled()
		expect(setStatus).not.toHaveBeenCalled()
	})
})
