import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn(() => "/fake/agent/dir"),
	SettingsManager: {
		create: vi.fn(() => ({})),
	},
	DefaultPackageManager: vi.fn().mockImplementation(() => ({
		listConfiguredPackages: vi.fn(() => []),
	})),
}))

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent"
import { getInstalledPackageResourceDirs } from "./package-resources.js"

describe("getInstalledPackageResourceDirs", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pkg-resources-test-"))
		vi.clearAllMocks()
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("returns [] when no packages are configured", () => {
		vi.mocked(DefaultPackageManager).mockImplementationOnce(
			() =>
				({
					listConfiguredPackages: vi.fn(() => []),
				}) as unknown as DefaultPackageManager,
		)

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([])
	})

	it("returns both paths when two packages both have the subdir", () => {
		const pkg1Dir = join(tmpDir, "pkg1")
		const pkg2Dir = join(tmpDir, "pkg2")
		mkdirSync(join(pkg1Dir, "agents"), { recursive: true })
		mkdirSync(join(pkg2Dir, "agents"), { recursive: true })

		vi.mocked(DefaultPackageManager).mockImplementationOnce(
			() =>
				({
					listConfiguredPackages: vi.fn(() => [
						{ installedPath: pkg1Dir, source: "p1", scope: "user" as const, filtered: false },
						{ installedPath: pkg2Dir, source: "p2", scope: "user" as const, filtered: false },
					]),
				}) as unknown as DefaultPackageManager,
		)

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([join(pkg1Dir, "agents"), join(pkg2Dir, "agents")])
	})

	it("returns only the path for the package whose subdir exists", () => {
		const pkg1Dir = join(tmpDir, "pkg1-exists")
		const pkg2Dir = join(tmpDir, "pkg2-missing")
		mkdirSync(join(pkg1Dir, "agents"), { recursive: true })
		// pkg2Dir's agents/ subdir is intentionally NOT created

		vi.mocked(DefaultPackageManager).mockImplementationOnce(
			() =>
				({
					listConfiguredPackages: vi.fn(() => [
						{ installedPath: pkg1Dir, source: "p1", scope: "user" as const, filtered: false },
						{ installedPath: pkg2Dir, source: "p2", scope: "user" as const, filtered: false },
					]),
				}) as unknown as DefaultPackageManager,
		)

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([join(pkg1Dir, "agents")])
	})

	it("silently skips packages with no installedPath", () => {
		const pkgWithPath = join(tmpDir, "pkg-with-path")
		mkdirSync(join(pkgWithPath, "agents"), { recursive: true })

		vi.mocked(DefaultPackageManager).mockImplementationOnce(
			() =>
				({
					listConfiguredPackages: vi.fn(() => [
						{ installedPath: undefined, source: "p1", scope: "user" as const, filtered: false },
						{ installedPath: pkgWithPath, source: "p2", scope: "user" as const, filtered: false },
					]),
				}) as unknown as DefaultPackageManager,
		)

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([join(pkgWithPath, "agents")])
	})

	it("returns [] and logs a warning when listConfiguredPackages throws", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		vi.mocked(DefaultPackageManager).mockImplementationOnce(
			() =>
				({
					listConfiguredPackages: vi.fn(() => {
						throw new Error("package manager exploded")
					}),
				}) as unknown as DefaultPackageManager,
		)

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([])
		expect(warnSpy).toHaveBeenCalledOnce()
		expect(warnSpy.mock.calls[0][0]).toContain("package manager exploded")

		warnSpy.mockRestore()
	})

	it("honors the subdir parameter — agents vs skills return different paths", () => {
		const pkgDir = join(tmpDir, "pkg-multi-subdir")
		mkdirSync(join(pkgDir, "agents"), { recursive: true })
		mkdirSync(join(pkgDir, "skills"), { recursive: true })

		const mockReturn = () =>
			({
				listConfiguredPackages: vi.fn(() => [
					{ installedPath: pkgDir, source: "p", scope: "user" as const, filtered: false },
				]),
			}) as unknown as DefaultPackageManager
		vi.mocked(DefaultPackageManager).mockImplementationOnce(mockReturn).mockImplementationOnce(mockReturn)

		const agentsResult = getInstalledPackageResourceDirs("/any/cwd", "agents")
		const skillsResult = getInstalledPackageResourceDirs("/any/cwd", "skills")

		expect(agentsResult).toEqual([join(pkgDir, "agents")])
		expect(skillsResult).toEqual([join(pkgDir, "skills")])
		expect(agentsResult).not.toEqual(skillsResult)
	})
})
