import type { Dirent, Stats } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { listBackups, pruneOldBackups, rollback, snapshotBeforeCurator } from "./backup.js"

vi.mock("tar", () => ({
	create: vi.fn().mockResolvedValue(undefined),
	extract: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs/promises", () => ({
	stat: vi.fn(),
	readdir: vi.fn(),
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	rename: vi.fn(),
	rm: vi.fn(),
}))

vi.mock("node:fs", () => ({
	existsSync: vi.fn().mockReturnValue(true),
}))

const mockTar = (await import("tar")) as unknown as {
	create: ReturnType<typeof vi.fn>
	extract: ReturnType<typeof vi.fn>
}
const mockFsPromises = (await import("node:fs/promises")) as unknown as {
	stat: ReturnType<typeof vi.fn>
	readdir: ReturnType<typeof vi.fn>
	mkdir: ReturnType<typeof vi.fn>
	writeFile: ReturnType<typeof vi.fn>
	rename: ReturnType<typeof vi.fn>
	rm: ReturnType<typeof vi.fn>
}

function createMockDirent(name: string, isDir: boolean): Dirent<string> {
	return {
		isDirectory: () => isDir,
		isFile: () => !isDir,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSymbolicLink: () => false,
		isSocket: () => false,
		name,
	} as Dirent<string>
}

function createMockStat(size: number): Stats {
	return { size } as Stats
}

describe("backup module", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("snapshotBeforeCurator", () => {
		it("creates tar.gz excluding .curator_backups and .archive", async () => {
			const skillsDir = "/skills"
			vi.mocked(mockFsPromises.mkdir).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.stat).mockResolvedValue(createMockStat(1234))
			vi.mocked(mockFsPromises.readdir).mockResolvedValue([
				createMockDirent("skill-a", true),
				createMockDirent("skill-b", true),
			])

			const result = await snapshotBeforeCurator(skillsDir)

			expect(mockTar.create).toHaveBeenCalledWith(
				expect.objectContaining({
					gzip: true,
					cwd: skillsDir,
					filter: expect.any(Function),
				}),
				["."],
			)
			expect(result).toContain(".curator_backups")
		})

		it("writes manifest with skill count", async () => {
			const skillsDir = "/skills"
			vi.mocked(mockFsPromises.mkdir).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.stat).mockResolvedValue(createMockStat(5678))
			vi.mocked(mockFsPromises.readdir).mockResolvedValue([
				createMockDirent("skill-x", true),
				createMockDirent("skill-y", true),
				createMockDirent(".hidden-skill", true),
			])

			await snapshotBeforeCurator(skillsDir)

			const manifestCall = mockFsPromises.writeFile.mock.calls.find((call) => call[0]?.includes("manifest.json"))
			expect(manifestCall).toBeDefined()
			const manifest = JSON.parse(manifestCall?.[1] as string)
			expect(manifest.skillCount).toBe(2) // excludes hidden
			expect(manifest.reason).toBe("pre-curator-run")
			expect(manifest.size).toBe(5678)
		})

		it("handles missing skills directory gracefully", async () => {
			const skillsDir = "/skills"
			vi.mocked(mockFsPromises.mkdir).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.stat).mockResolvedValue(createMockStat(100))
			vi.mocked(mockFsPromises.readdir).mockRejectedValue(new Error("ENOENT"))

			// Should not throw
			await expect(snapshotBeforeCurator(skillsDir)).resolves.toBeDefined()
		})
	})

	describe("rollback", () => {
		it("creates safety snapshot before rollback", async () => {
			const backupDir = "/skills/.curator_backups/2024-01-01"
			const skillsDir = "/skills"

			vi.mocked(mockFsPromises.mkdir).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.rename).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.rm).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.stat).mockResolvedValue(createMockStat(100))
			vi.mocked(mockFsPromises.readdir).mockResolvedValue([createMockDirent("skill-a", true)])

			await rollback(backupDir, skillsDir)

			// Should call tar.create for safety snapshot (called at start of rollback)
			expect(mockTar.create).toHaveBeenCalled()
			// Should extract from backup
			expect(mockTar.extract).toHaveBeenCalled()
		})

		it("restores from staging dir on failure", async () => {
			const backupDir = "/skills/.curator_backups/2024-01-01"
			const skillsDir = "/skills"

			vi.mocked(mockFsPromises.mkdir).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.rename).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.rm).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.writeFile).mockResolvedValue(undefined)
			vi.mocked(mockFsPromises.stat).mockResolvedValue(createMockStat(100))
			vi.mocked(mockFsPromises.readdir).mockResolvedValue([createMockDirent("skill-a", true)])

			// Make tar.extract fail
			vi.mocked(mockTar.extract).mockRejectedValueOnce(new Error("Extract failed"))

			await expect(rollback(backupDir, skillsDir)).rejects.toThrow("Extract failed")

			// Should have called rename to restore staging dir
			const restoreCall = mockFsPromises.rename.mock.calls.find((call) => call[0]?.includes(".rollback-staging"))
			expect(restoreCall).toBeDefined()
		})
	})

	describe("listBackups", () => {
		it("returns sorted backup directories in reverse order", async () => {
			const skillsDir = "/skills"
			vi.mocked(mockFsPromises.readdir).mockResolvedValue([
				createMockDirent("not-a-backup", false),
				createMockDirent("2024-01-01T00-00-00-000Z", true),
				createMockDirent("2024-01-02T00-00-00-000Z", true),
				createMockDirent("2024-01-03T00-00-00-000Z", true),
			])

			const result = await listBackups(skillsDir)

			expect(result).toEqual(["2024-01-03T00-00-00-000Z", "2024-01-02T00-00-00-000Z", "2024-01-01T00-00-00-000Z"])
		})

		it("returns empty array when no backups exist", async () => {
			const skillsDir = "/skills"
			vi.mocked(mockFsPromises.readdir).mockRejectedValue(new Error("ENOENT"))

			const result = await listBackups(skillsDir)

			expect(result).toEqual([])
		})
	})

	describe("pruneOldBackups", () => {
		it("keeps only KEEP_BACKUPS most recent backups", async () => {
			const backupBase = "/skills/.curator_backups"
			vi.mocked(mockFsPromises.readdir).mockResolvedValue([
				createMockDirent("2024-01-01T00-00-00-000Z", true),
				createMockDirent("2024-01-02T00-00-00-000Z", true),
				createMockDirent("2024-01-03T00-00-00-000Z", true),
				createMockDirent("2024-01-04T00-00-00-000Z", true),
				createMockDirent("2024-01-05T00-00-00-000Z", true),
				createMockDirent("2024-01-06T00-00-00-000Z", true),
				createMockDirent("2024-01-07T00-00-00-000Z", true),
			])
			vi.mocked(mockFsPromises.rm).mockResolvedValue(undefined)

			await pruneOldBackups(backupBase, 5)

			// Should delete 2 oldest (2024-01-01 and 2024-01-02)
			expect(mockFsPromises.rm).toHaveBeenCalledTimes(2)
		})

		it("does nothing when fewer backups than keep count", async () => {
			const backupBase = "/skills/.curator_backups"
			vi.mocked(mockFsPromises.readdir).mockResolvedValue([
				createMockDirent("2024-01-06T00-00-00-000Z", true),
				createMockDirent("2024-01-07T00-00-00-000Z", true),
			])

			await pruneOldBackups(backupBase, 5)

			expect(mockFsPromises.rm).not.toHaveBeenCalled()
		})
	})
})
