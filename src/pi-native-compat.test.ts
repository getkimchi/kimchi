import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { filterDisabledPackageExtensions, normalizePiNativeExtensions } from "./pi-native-compat.js"

describe("pi native compatibility", () => {
	it("adds legacy aliases to tool_result events for package adapters", async () => {
		const handler = vi.fn(async () => undefined)
		const result = loadResultWithHandlers("tool_result", [handler])

		normalizePiNativeExtensions(result)
		await result.extensions[0].handlers.get("tool_result")?.[0](
			{
				type: "tool_result",
				toolName: "bash",
				input: { command: "pwd" },
				content: [{ type: "text", text: "/tmp" }],
				isError: false,
			},
			{},
		)

		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				params: { command: "pwd" },
				output: "/tmp",
				result: "/tmp",
			}),
			{},
		)
	})

	it("aliases before_provider_response handlers to after_provider_response", async () => {
		const legacy = vi.fn(async () => undefined)
		const result = loadResultWithHandlers("before_provider_response", [legacy])

		normalizePiNativeExtensions(result)
		await result.extensions[0].handlers.get("after_provider_response")?.[0](
			{
				type: "after_provider_response",
				status: 200,
				headers: { "x-test": "1" },
			},
			{},
		)

		expect(legacy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "before_provider_response",
				status: 200,
				headers: { "x-test": "1" },
			}),
			{},
		)
	})

	it("normalizes loaded extensions only once", () => {
		const handler = vi.fn(async () => undefined)
		const result = loadResultWithHandlers("tool_result", [handler])

		normalizePiNativeExtensions(result)
		const wrapped = result.extensions[0].handlers.get("tool_result")?.[0]
		normalizePiNativeExtensions(result)

		expect(result.extensions[0].handlers.get("tool_result")?.[0]).toBe(wrapped)
	})

	it("filters disabled package extensions and provider registrations", () => {
		const result = loadResultWithExtensions([
			extensionFixture("/packages/context-mode/extensions/index.js", "npm:context-mode"),
			extensionFixture("/packages/other/extensions/index.js", "npm:other"),
		])
		result.errors.push({ path: "/packages/context-mode/extensions/broken.js", error: "boom" })
		result.runtime.pendingProviderRegistrations.push(
			{ name: "ctx", config: {} as never, extensionPath: "/packages/context-mode/extensions/index.js" },
			{ name: "other", config: {} as never, extensionPath: "/packages/other/extensions/index.js" },
		)

		const filtered = filterDisabledPackageExtensions(
			result,
			[
				{
					id: "plugins.package.npm-context-mode",
					source: "npm:context-mode",
					scope: "user",
					installedPath: "/packages/context-mode",
				},
			],
			() => false,
		)

		expect(filtered.extensions.map((extension) => extension.path)).toEqual(["/packages/other/extensions/index.js"])
		expect(filtered.errors).toEqual([])
		expect(result.runtime.pendingProviderRegistrations.map((registration) => registration.name)).toEqual(["other"])
	})

	it("filters disabled package provider registrations by disabled extension path when no package root is known", () => {
		const result = loadResultWithExtensions([extensionFixture("/somewhere/context-mode.js", "npm:context-mode")])
		result.runtime.pendingProviderRegistrations.push({
			name: "ctx",
			config: {} as never,
			extensionPath: "/somewhere/context-mode.js",
		})

		filterDisabledPackageExtensions(
			result,
			[{ id: "plugins.package.npm-context-mode", source: "npm:context-mode", scope: "user" }],
			() => false,
		)

		expect(result.runtime.pendingProviderRegistrations).toEqual([])
	})
})

function loadResultWithHandlers(
	event: string,
	handlers: Array<(event: unknown, ctx: unknown) => Promise<unknown>>,
): LoadExtensionsResult {
	return loadResultWithExtensions([
		{
			...extensionFixture("/pkg/extension.js", "package"),
			handlers: new Map([[event, handlers]]),
		},
	])
}

function loadResultWithExtensions(extensions: LoadExtensionsResult["extensions"]): LoadExtensionsResult {
	return {
		extensions,
		errors: [],
		runtime: {
			pendingProviderRegistrations: [],
		} as never,
	}
}

function extensionFixture(path: string, source: string): LoadExtensionsResult["extensions"][number] {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path, source, scope: "user", origin: "package", baseDir: path } as never,
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	}
}
