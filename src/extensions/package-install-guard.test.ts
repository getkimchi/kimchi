import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import packageInstallGuardExtension from "./package-install-guard.js"

// Mock consumePackageInstallFailures at the module level
vi.mock("./pi-package-lookup/native-compat.js", () => ({
	consumePackageInstallFailures: vi.fn(),
}))

const { consumePackageInstallFailures } = await import("./pi-package-lookup/native-compat.js")

function createMockPi(): {
	pi: ExtensionAPI
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>>
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>>()
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
			if (!handlers.has(event)) handlers.set(event, [])
			handlers.get(event)?.push(handler)
		}),
	} as unknown as ExtensionAPI
	return { pi, handlers }
}

function createMockCtx(hasUI: boolean): ExtensionContext {
	const notify = vi.fn()
	return {
		hasUI,
		ui: hasUI ? ({ notify } as unknown as ExtensionContext["ui"]) : undefined,
	} as unknown as ExtensionContext
}

function getSessionStartHandler(
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>>,
) {
	const handlersList = handlers.get("session_start")
	if (!handlersList || handlersList.length === 0) {
		throw new Error("session_start handler not registered")
	}
	return handlersList[0]
}

describe("package-install-guard extension", () => {
	beforeEach(() => {
		vi.mocked(consumePackageInstallFailures).mockReset()
	})

	it("does not notify when there are no failures", async () => {
		vi.mocked(consumePackageInstallFailures).mockReturnValue([])
		const { pi, handlers } = createMockPi()
		packageInstallGuardExtension(pi)

		const ctx = createMockCtx(true)
		await getSessionStartHandler(handlers)({}, ctx)

		expect(ctx.ui?.notify).not.toHaveBeenCalled()
	})

	it("notifies with a single failure message", async () => {
		vi.mocked(consumePackageInstallFailures).mockReturnValue([{ source: "npm:@kimchi-dev/kimchi-workflows" }])
		const { pi, handlers } = createMockPi()
		packageInstallGuardExtension(pi)

		const ctx = createMockCtx(true)
		await getSessionStartHandler(handlers)({}, ctx)

		expect(ctx.ui?.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui?.notify).toHaveBeenCalledWith(
			"Could not install 1 package extension:\n  • npm:@kimchi-dev/kimchi-workflows",
			"warning",
		)
	})

	it("notifies with a list when multiple failures", async () => {
		vi.mocked(consumePackageInstallFailures).mockReturnValue([
			{ source: "npm:@kimchi-dev/kimchi-workflows" },
			{ source: "npm:other-package" },
		])
		const { pi, handlers } = createMockPi()
		packageInstallGuardExtension(pi)

		const ctx = createMockCtx(true)
		await getSessionStartHandler(handlers)({}, ctx)

		expect(ctx.ui?.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui?.notify).toHaveBeenCalledWith(
			"Could not install 2 package extensions:\n  • npm:@kimchi-dev/kimchi-workflows\n  • npm:other-package",
			"warning",
		)
	})

	it("does not notify when hasUI is false", async () => {
		vi.mocked(consumePackageInstallFailures).mockReturnValue([{ source: "npm:@kimchi-dev/kimchi-workflows" }])
		const { pi, handlers } = createMockPi()
		packageInstallGuardExtension(pi)

		const ctx = createMockCtx(false)
		await getSessionStartHandler(handlers)({}, ctx)

		// consumePackageInstallFailures should not even be called when hasUI is false
		expect(consumePackageInstallFailures).not.toHaveBeenCalled()
	})
})
