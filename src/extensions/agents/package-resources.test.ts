import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const packageResourceMocks = vi.hoisted(() => ({
	getConfiguredPackageResourceRecords: vi.fn(() => []),
}))
const resourceStoreMocks = vi.hoisted(() => ({
	isResourceEnabled: vi.fn(() => true),
}))

vi.mock("../../resources/package-resources.js", () => packageResourceMocks)
vi.mock("../../resources/store.js", () => resourceStoreMocks)

import { getConfiguredPackageResourceRecords } from "../../resources/package-resources.js"
import { isResourceEnabled } from "../../resources/store.js"
import { getInstalledPackageResourceDirs } from "./package-resources.js"

describe("getInstalledPackageResourceDirs", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pkg-resources-test-"))
		vi.clearAllMocks()
		packageResourceMocks.getConfiguredPackageResourceRecords.mockReturnValue([])
		resourceStoreMocks.isResourceEnabled.mockReturnValue(true)
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("returns [] when no packages are configured", () => {
		vi.mocked(getConfiguredPackageResourceRecords).mockReturnValueOnce([])

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([])
	})

	it("returns both paths when two packages both have the subdir", () => {
		const pkg1Dir = join(tmpDir, "pkg1")
		const pkg2Dir = join(tmpDir, "pkg2")
		mkdirSync(join(pkg1Dir, "agents"), { recursive: true })
		mkdirSync(join(pkg2Dir, "agents"), { recursive: true })

		vi.mocked(getConfiguredPackageResourceRecords).mockReturnValueOnce([
			{ id: "plugins.package.p1", installedPath: pkg1Dir, source: "p1", scope: "user", origin: "kimchi" },
			{ id: "plugins.package.p2", installedPath: pkg2Dir, source: "p2", scope: "user", origin: "kimchi" },
		])

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([join(pkg1Dir, "agents"), join(pkg2Dir, "agents")])
	})

	it("returns only the path for the package whose subdir exists", () => {
		const pkg1Dir = join(tmpDir, "pkg1-exists")
		const pkg2Dir = join(tmpDir, "pkg2-missing")
		mkdirSync(join(pkg1Dir, "agents"), { recursive: true })
		// pkg2Dir's agents/ subdir is intentionally NOT created

		vi.mocked(getConfiguredPackageResourceRecords).mockReturnValueOnce([
			{ id: "plugins.package.p1", installedPath: pkg1Dir, source: "p1", scope: "user", origin: "kimchi" },
			{ id: "plugins.package.p2", installedPath: pkg2Dir, source: "p2", scope: "user", origin: "kimchi" },
		])

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([join(pkg1Dir, "agents")])
	})

	it("skips disabled packages even when their subdir exists", () => {
		const enabledPkgDir = join(tmpDir, "enabled-pkg")
		const disabledPkgDir = join(tmpDir, "disabled-pkg")
		mkdirSync(join(enabledPkgDir, "skills"), { recursive: true })
		mkdirSync(join(disabledPkgDir, "skills"), { recursive: true })
		vi.mocked(isResourceEnabled).mockImplementation((id) => id !== "plugins.package.disabled")

		vi.mocked(getConfiguredPackageResourceRecords).mockReturnValueOnce([
			{
				id: "plugins.package.enabled",
				installedPath: enabledPkgDir,
				source: "enabled",
				scope: "user",
				origin: "kimchi",
			},
			{
				id: "plugins.package.disabled",
				installedPath: disabledPkgDir,
				source: "disabled",
				scope: "user",
				origin: "kimchi",
			},
		])

		const result = getInstalledPackageResourceDirs("/any/cwd", "skills")
		expect(result).toEqual([join(enabledPkgDir, "skills")])
	})

	it("silently skips packages with no installedPath", () => {
		const pkgWithPath = join(tmpDir, "pkg-with-path")
		mkdirSync(join(pkgWithPath, "agents"), { recursive: true })

		vi.mocked(getConfiguredPackageResourceRecords).mockReturnValueOnce([
			{ id: "plugins.package.p1", installedPath: undefined, source: "p1", scope: "user", origin: "kimchi" },
			{ id: "plugins.package.p2", installedPath: pkgWithPath, source: "p2", scope: "user", origin: "kimchi" },
		])

		const result = getInstalledPackageResourceDirs("/any/cwd", "agents")
		expect(result).toEqual([join(pkgWithPath, "agents")])
	})

	it("returns [] and logs a warning when listConfiguredPackages throws", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		vi.mocked(getConfiguredPackageResourceRecords).mockImplementationOnce(() => {
			throw new Error("package manager exploded")
		})

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

		vi.mocked(getConfiguredPackageResourceRecords)
			.mockReturnValueOnce([
				{ id: "plugins.package.p", installedPath: pkgDir, source: "p", scope: "user", origin: "kimchi" },
			])
			.mockReturnValueOnce([
				{ id: "plugins.package.p", installedPath: pkgDir, source: "p", scope: "user", origin: "kimchi" },
			])

		const agentsResult = getInstalledPackageResourceDirs("/any/cwd", "agents")
		const skillsResult = getInstalledPackageResourceDirs("/any/cwd", "skills")

		expect(agentsResult).toEqual([join(pkgDir, "agents")])
		expect(skillsResult).toEqual([join(pkgDir, "skills")])
		expect(agentsResult).not.toEqual(skillsResult)
	})
})
