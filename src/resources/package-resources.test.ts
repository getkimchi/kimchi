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

vi.mock("@earendil-works/pi-coding-agent", () => mocks)

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent"
import {
	discoverPackageResources,
	packageResourceId,
	packageResourceRecordsFromConfiguredPackages,
} from "./package-resources.js"

describe("package resources", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("creates a stable resource id from an npm package source", () => {
		expect(packageResourceId("npm:context-mode")).toBe("plugins.package.npm-context-mode")
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
				description: "Enable Pi package npm:context-mode.",
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
