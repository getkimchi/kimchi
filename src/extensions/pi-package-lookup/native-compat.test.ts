import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { ResolvedPaths } from "./index.js"
import {
	filterDisabledPackageExtensions,
	filterDisabledPackageResolvedPaths,
	filterPackageExtensionToolConflicts,
	normalizePiNativeExtensions,
} from "./native-compat.js"

describe("pi native compatibility", () => {
	it("adds legacy aliases to tool_result events for package adapters", async () => {
		const handler = vi.fn(async () => undefined)
		const result = loadResultWithHandlers("tool_result", [handler])

		const normalized = normalizePiNativeExtensions(result)
		await normalized.extensions[0].handlers.get("tool_result")?.[0](
			{
				type: "tool_result",
				toolName: "bash",
				input: { command: "pwd" },
				content: [{ type: "text", text: "/tmp" }],
				isError: false,
			},
			{},
		)

		expect(normalized.extensions[0]).not.toBe(result.extensions[0])
		expect(result.extensions[0].handlers.get("tool_result")?.[0]).toBe(handler)
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

		const normalized = normalizePiNativeExtensions(result)
		await normalized.extensions[0].handlers.get("after_provider_response")?.[0](
			{
				type: "after_provider_response",
				status: 200,
				headers: { "x-test": "1" },
			},
			{},
		)

		expect(result.extensions[0].handlers.has("after_provider_response")).toBe(false)
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

		const normalized = normalizePiNativeExtensions(result)
		const wrapped = normalized.extensions[0].handlers.get("tool_result")?.[0]
		const normalizedAgain = normalizePiNativeExtensions(normalized)

		expect(normalizedAgain.extensions[0].handlers.get("tool_result")?.[0]).toBe(wrapped)
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
					origin: "kimchi",
					installedPath: "/packages/context-mode",
				},
			],
			() => false,
		)

		expect(filtered.extensions.map((extension) => extension.path)).toEqual(["/packages/other/extensions/index.js"])
		expect(filtered.errors).toEqual([])
		expect(filtered.runtime).toBe(result.runtime)
		expect(filtered.runtime.pendingProviderRegistrations.map((registration) => registration.name)).toEqual(["other"])
		expect(result.runtime.pendingProviderRegistrations.map((registration) => registration.name)).toEqual(["other"])
	})

	it("filters disabled package provider registrations by disabled extension path when no package root is known", () => {
		const result = loadResultWithExtensions([extensionFixture("/somewhere/context-mode.js", "npm:context-mode")])
		result.runtime.pendingProviderRegistrations.push({
			name: "ctx",
			config: {} as never,
			extensionPath: "/somewhere/context-mode.js",
		})

		const filtered = filterDisabledPackageExtensions(
			result,
			[{ id: "plugins.package.npm-context-mode", source: "npm:context-mode", scope: "user", origin: "kimchi" }],
			() => false,
		)

		expect(filtered.runtime).toBe(result.runtime)
		expect(filtered.runtime.pendingProviderRegistrations).toEqual([])
		expect(result.runtime.pendingProviderRegistrations).toEqual([])
	})

	it("filters disabled package resolved paths before extension modules load", () => {
		const paths = resolvedPathsFixture({
			extensions: [
				resolvedResourceFixture(
					"/packages/zero-pi/extensions/zero-banner.ts",
					"npm:@gonrocca/zero-pi",
					"/packages/zero-pi",
				),
				resolvedResourceFixture("/packages/other/extensions/index.js", "npm:other", "/packages/other"),
			],
			prompts: [resolvedResourceFixture("/packages/zero-pi/prompts/zero.md", "@gonrocca/zero-pi")],
		})

		const filtered = filterDisabledPackageResolvedPaths(
			paths,
			[
				{
					id: "plugins.package.npm-gonrocca-zero-pi",
					source: "npm:@gonrocca/zero-pi",
					scope: "user",
					origin: "kimchi",
					installedPath: "/packages/zero-pi",
				},
			],
			() => false,
		)

		expect(filtered.extensions.map((resource) => resource.path)).toEqual(["/packages/other/extensions/index.js"])
		expect(filtered.prompts).toEqual([])
		expect(paths.extensions).toHaveLength(2)
	})

	it("filters disabled package extensions when source metadata omits npm prefix", () => {
		const result = loadResultWithExtensions([extensionFixture("/somewhere/zero-banner.ts", "@gonrocca/zero-pi")])

		const filtered = filterDisabledPackageExtensions(
			result,
			[
				{
					id: "plugins.package.npm-gonrocca-zero-pi",
					source: "npm:@gonrocca/zero-pi",
					scope: "user",
					origin: "kimchi",
				},
			],
			() => false,
		)

		expect(filtered.extensions).toEqual([])
	})

	it("removes package tools that collide with Kimchi-owned tools", () => {
		const packageExtension = withTools(
			extensionFixture("/packages/pi-web-search/extensions/index.js", "npm:@ollama/pi-web-search"),
			["web_fetch", "web_search", "ollama_search"],
		)
		const kimchiWebFetch = withTools(extensionFixture("<inline:42>", "kimchi-inline"), ["web_fetch"])
		const result = loadResultWithExtensions([packageExtension, kimchiWebFetch])
		result.errors.push(
			{
				path: "<inline:42>",
				error: 'Tool "web_fetch" conflicts with /packages/pi-web-search/extensions/index.js',
			},
			{
				path: "/somewhere/else.js",
				error: 'Flag "--web" conflicts with /packages/pi-web-search/extensions/index.js',
			},
		)

		const filtered = filterPackageExtensionToolConflicts(result, [
			{
				id: "plugins.package.npm-ollama-pi-web-search",
				source: "npm:@ollama/pi-web-search",
				scope: "user",
				origin: "pi",
				installedPath: "/packages/pi-web-search",
			},
		])

		expect([...filtered.extensions[0].tools.keys()]).toEqual(["web_search", "ollama_search"])
		expect([...filtered.extensions[1].tools.keys()]).toEqual(["web_fetch"])
		expect(filtered.errors).toEqual([
			{
				path: "/somewhere/else.js",
				error: 'Flag "--web" conflicts with /packages/pi-web-search/extensions/index.js',
			},
		])
	})

	it("keeps reporting non-package tool conflicts", () => {
		const result = loadResultWithExtensions([
			withTools(extensionFixture("<inline:1>", "kimchi-a"), ["same_tool"]),
			withTools(extensionFixture("<inline:2>", "kimchi-b"), ["same_tool"]),
		])
		result.errors.push({ path: "<inline:2>", error: 'Tool "same_tool" conflicts with <inline:1>' })

		const filtered = filterPackageExtensionToolConflicts(result, [
			{
				id: "plugins.package.npm-ollama-pi-web-search",
				source: "npm:@ollama/pi-web-search",
				scope: "user",
				origin: "pi",
				installedPath: "/packages/pi-web-search",
			},
		])

		expect(filtered.errors).toEqual([{ path: "<inline:2>", error: 'Tool "same_tool" conflicts with <inline:1>' }])
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

function resolvedPathsFixture(overrides: Partial<ResolvedPaths> = {}): ResolvedPaths {
	return {
		extensions: [],
		skills: [],
		prompts: [],
		themes: [],
		...overrides,
	}
}

function resolvedResourceFixture(path: string, source: string, baseDir?: string): ResolvedPaths["extensions"][number] {
	return {
		path,
		enabled: true,
		metadata: { path, source, scope: "user", origin: "package", baseDir } as never,
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

function withTools(
	extension: LoadExtensionsResult["extensions"][number],
	tools: string[],
): LoadExtensionsResult["extensions"][number] {
	return {
		...extension,
		tools: new Map(tools.map((tool) => [tool, {} as never])),
	}
}
