import { beforeEach, describe, expect, it, vi } from "vitest"

const checkForUpdateMock = vi.fn()
const getVersionMock = vi.fn()
const isHomebrewInstallMock = vi.fn(() => false)
const loadAutoUpdateSettingMock = vi.fn(() => false)
const loadAutoUpdateNoticeShownMock = vi.fn(() => false)
const markAutoUpdateNoticeShownMock = vi.fn()

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
vi.mock("../update/settings.js", () => ({
	loadAutoUpdateSetting: () => loadAutoUpdateSettingMock(),
	saveAutoUpdateSetting: vi.fn(),
	loadAutoUpdateNoticeShown: () => loadAutoUpdateNoticeShownMock(),
	markAutoUpdateNoticeShown: () => markAutoUpdateNoticeShownMock(),
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
	const notify = vi.fn()
	const ctx = {
		hasUI: opts.hasUI,
		ui: {
			setStatus,
			notify,
			theme: { bold: (s: string) => s },
		},
	}
	return { ctx, setStatus, notify }
}

describe("startupUpdateExtension", () => {
	beforeEach(() => {
		checkForUpdateMock.mockReset()
		getVersionMock.mockReset()
		isHomebrewInstallMock.mockReset()
		loadAutoUpdateSettingMock.mockReset()
		loadAutoUpdateNoticeShownMock.mockReset()
		markAutoUpdateNoticeShownMock.mockReset()
		isHomebrewInstallMock.mockReturnValue(false)
		// Default: auto-update disabled → preserves legacy setStatus behavior
		// for the existing tests below. New tests override per-case.
		loadAutoUpdateSettingMock.mockReturnValue(false)
		loadAutoUpdateNoticeShownMock.mockReturnValue(false)
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

	describe("auto-update aware", () => {
		it("suppresses setStatus (no nag) when autoUpdate is enabled and update is available", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(true) // isolate the suppression path
			checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			// Auto-update handles currency on next launch — no footer nag,
			// no version check here, and the onboarding toast is already shown.
			expect(checkForUpdateMock).not.toHaveBeenCalled()
			expect(setStatus).not.toHaveBeenCalled()
			expect(notify).not.toHaveBeenCalled()
		})

		it("emits one-time notify and marks shown when autoUpdate is enabled and notice not yet shown", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(false)
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			expect(notify).toHaveBeenCalledOnce()
			expect(notify.mock.calls[0][0]).toContain("Run `/update` to disable")
			expect(markAutoUpdateNoticeShownMock).toHaveBeenCalledOnce()
			expect(checkForUpdateMock).not.toHaveBeenCalled()
			expect(setStatus).not.toHaveBeenCalled()
		})

		it("does not notify when autoUpdate is enabled and notice already shown", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(true)
			loadAutoUpdateNoticeShownMock.mockReturnValue(true)
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			expect(notify).not.toHaveBeenCalled()
			expect(markAutoUpdateNoticeShownMock).not.toHaveBeenCalled()
			expect(setStatus).not.toHaveBeenCalled()
		})

		it("preserves setStatus behavior and skips notice when autoUpdate is disabled", async () => {
			getVersionMock.mockReturnValue("v0.0.23")
			loadAutoUpdateSettingMock.mockReturnValue(false)
			loadAutoUpdateNoticeShownMock.mockReturnValue(false)
			checkForUpdateMock.mockResolvedValue({ hasUpdate: true })
			const { handlers, api } = createMockApi()
			startupUpdateExtension(api)
			const handler = handlers.get("session_start")
			if (!handler) throw new Error("no session_start handler")

			const { ctx, setStatus, notify } = makeCtx({ hasUI: true })
			await handler({}, ctx)

			expect(setStatus).toHaveBeenCalledOnce()
			const [key] = setStatus.mock.calls[0]
			expect(key).toBe("update-available")
			expect(notify).not.toHaveBeenCalled()
			expect(markAutoUpdateNoticeShownMock).not.toHaveBeenCalled()
		})
	})
})
