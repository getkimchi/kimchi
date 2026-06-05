import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	getAgentDir: vi.fn(() => "/fake/agent/dir"),
	SettingsManager: {
		create: vi.fn(() => ({})),
	},
	DefaultPackageManager: vi.fn().mockImplementation(() => ({
		listConfiguredPackages: vi.fn(() => []),
	})),
}))
const piLookupMocks = vi.hoisted(() => ({
	getOriginalPiConfiguredPackages: vi.fn(() => []),
	isOriginalPiPackageLookupEnabled: vi.fn(() => true),
}))

vi.mock("@earendil-works/pi-coding-agent", () => mocks)
vi.mock("../extensions/pi-package-lookup/index.js", () => ({
	...piLookupMocks,
	PI_PACKAGE_LOOKUP_RESOURCE_ID: "extensions.pi-package-lookup",
}))

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent"
import { getOriginalPiConfiguredPackages } from "../extensions/pi-package-lookup/index.js"
import {
	discoverPackageResources,
	packageResourceId,
	packageResourceRecordsFromConfiguredPackages,
	packageSourcesMatch,
} from "./package-resources.js"

describe("package resources", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.SettingsManager.create.mockReturnValue({})
		mocks.DefaultPackageManager.mockImplementation(() => ({
			listConfiguredPackages: vi.fn(() => []),
		}))
		piLookupMocks.getOriginalPiConfiguredPackages.mockReturnValue([])
		piLookupMocks.isOriginalPiPackageLookupEnabled.mockReturnValue(true)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("creates a stable resource id from an npm package source", () => {
		expect(packageResourceId("npm:context-mode")).toBe("plugins.package.npm-context-mode")
	})

	it("creates a stable resource id from a scoped npm package source", () => {
		expect(packageResourceId("npm:@juicesharp/rpiv-todo")).toBe("plugins.package.npm-juicesharp-rpiv-todo")
	})

	it("matches package source aliases by npm package identity", () => {
		expect(packageSourcesMatch("npm:@gonrocca/zero-pi", "@gonrocca/zero-pi")).toBe(true)
		expect(packageSourcesMatch("npm:context-mode@1.0.0", "context-mode")).toBe(true)
		expect(packageSourcesMatch("npm:context-mode", "npm:@gonrocca/zero-pi")).toBe(false)
		expect(packageSourcesMatch("git:https://example.com/repo.git", "repo")).toBe(false)
	})

	it("surfaces configured packages as plugin resources", () => {
		vi.mocked(DefaultPackageManager).mockImplementationOnce(
			() =>
				({
					listConfiguredPackages: vi.fn(() => [
						{
							source: "npm:context-mode",
							scope: "user" as const,
							filtered: true,
							installedPath: "/tmp/context-mode",
						},
					]),
				}) as unknown as DefaultPackageManager,
		)

		expect(discoverPackageResources("/repo")).toEqual([
			{
				id: "plugins.package.npm-context-mode",
				kind: "plugins",
				label: "Package: context-mode",
				description: "Enable Kimchi package npm:context-mode.",
				defaultEnabled: true,
				restartRequired: true,
			},
		])
	})

	it("dedupes duplicate package sources with project scope winning", () => {
		const records = packageResourceRecordsFromConfiguredPackages([
			{
				source: "npm:context-mode",
				scope: "user",
				filtered: false,
				installedPath: "/global/context-mode",
			},
			{
				source: "npm:context-mode",
				scope: "project",
				filtered: false,
				installedPath: "/project/context-mode",
			},
		])

		expect(records).toEqual([
			{
				id: "plugins.package.npm-context-mode",
				source: "npm:context-mode",
				scope: "project",
				origin: "kimchi",
				installedPath: "/project/context-mode",
			},
		])
	})

	it("surfaces packages discovered through the original pi lookup", () => {
		vi.mocked(getOriginalPiConfiguredPackages).mockReturnValueOnce([
			{
				source: "npm:pi-subagents",
				scope: "user",
				filtered: false,
				origin: "pi",
				installedPath: "/pi/agent/npm/node_modules/pi-subagents",
			},
		])

		expect(discoverPackageResources("/repo")).toEqual([
			{
				id: "plugins.package.npm-pi-subagents",
				kind: "plugins",
				label: "Package: pi-subagents",
				description: "Enable package npm:pi-subagents discovered from the original pi CLI.",
				defaultEnabled: true,
				restartRequired: true,
			},
		])
	})

	it("surfaces scoped packages discovered through the original pi lookup", () => {
		vi.mocked(getOriginalPiConfiguredPackages).mockReturnValueOnce([
			{
				source: "npm:@juicesharp/rpiv-todo",
				scope: "user",
				filtered: false,
				origin: "pi",
				installedPath: "/pi/agent/npm/node_modules/@juicesharp/rpiv-todo",
			},
		])

		expect(discoverPackageResources("/repo")).toEqual([
			{
				id: "plugins.package.npm-juicesharp-rpiv-todo",
				kind: "plugins",
				label: "Package: @juicesharp/rpiv-todo",
				description: "Enable package npm:@juicesharp/rpiv-todo discovered from the original pi CLI.",
				defaultEnabled: true,
				restartRequired: true,
			},
		])
	})

	it("dedupes kimchi-native packages over original pi packages", () => {
		const records = packageResourceRecordsFromConfiguredPackages([
			{
				source: "npm:context-mode",
				scope: "user",
				filtered: false,
				origin: "pi",
				installedPath: "/pi/context-mode",
			},
			{
				source: "npm:context-mode",
				scope: "user",
				filtered: false,
				origin: "kimchi",
				installedPath: "/kimchi/context-mode",
			},
		])

		expect(records).toEqual([
			{
				id: "plugins.package.npm-context-mode",
				source: "npm:context-mode",
				scope: "user",
				origin: "kimchi",
				installedPath: "/kimchi/context-mode",
			},
		])
	})

	it("dedupes pinned npm sources by package name", () => {
		const records = packageResourceRecordsFromConfiguredPackages([
			{
				source: "npm:context-mode@1.0.0",
				scope: "user",
				filtered: false,
				origin: "pi",
				installedPath: "/pi/context-mode",
			},
			{
				source: "npm:context-mode@1.1.0",
				scope: "project",
				filtered: false,
				origin: "kimchi",
				installedPath: "/project/context-mode",
			},
		])

		expect(records).toEqual([
			{
				id: "plugins.package.npm-context-mode-1-1-0",
				source: "npm:context-mode@1.1.0",
				scope: "project",
				origin: "kimchi",
				installedPath: "/project/context-mode",
			},
		])
	})

	it("returns [] and logs a warning when package discovery fails", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(DefaultPackageManager).mockImplementationOnce(
			() =>
				({
					listConfiguredPackages: vi.fn(() => {
						throw new Error("package manager exploded")
					}),
				}) as unknown as DefaultPackageManager,
		)

		expect(discoverPackageResources("/repo")).toEqual([])
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("package manager exploded"))
	})
})
