import { existsSync } from "node:fs"
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as tar from "tar"

const BACKUP_DIR_NAME = ".curator_backups"
const KEEP_BACKUPS = 5

export interface BackupManifest {
	reason: string
	timestamp: string
	skillCount: number
	size: number
}

export async function snapshotBeforeCurator(skillsDir: string): Promise<string> {
	const backupBase = join(skillsDir, BACKUP_DIR_NAME)
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
	const backupDir = join(backupBase, timestamp)
	const tarPath = join(backupDir, "skills.tar.gz")

	await mkdir(backupDir, { recursive: true })

	// Create tar.gz — explicitly filter out .curator_backups/ and .archive to avoid recursive backup
	await tar.create(
		{
			gzip: true,
			file: tarPath,
			cwd: skillsDir,
			filter: (path) =>
				!path.includes("/.curator_backups") &&
				!path.includes("/.archive") &&
				!path.endsWith(".curator_backups") &&
				!path.endsWith(".archive"),
		},
		["."],
	)

	// Count skills for manifest
	const skillsBase = join(skillsDir, "skills")
	let skillCount = 0
	try {
		const entries = await readdir(skillsBase, { withFileTypes: true })
		skillCount = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).length
	} catch {
		// skills dir might not exist yet
	}

	// Write manifest
	const manifest: BackupManifest = {
		reason: "pre-curator-run",
		timestamp,
		skillCount,
		size: (await stat(tarPath)).size,
	}
	await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2))

	// Prune old backups
	await pruneOldBackups(backupBase, KEEP_BACKUPS)

	return backupDir
}

export async function rollback(backupDir: string, skillsDir: string): Promise<void> {
	// Safety snapshot of current (broken) state
	await snapshotBeforeCurator(skillsDir)

	const stagingDir = join(skillsDir, "..", `.rollback-staging-${Date.now()}`)

	try {
		await rename(skillsDir, stagingDir)
		await mkdir(skillsDir, { recursive: true })
		await tar.extract({
			gzip: true,
			file: join(backupDir, "skills.tar.gz"),
			cwd: skillsDir,
		})
		await rm(stagingDir, { recursive: true, force: true })
	} catch (err) {
		// Restore from safety snapshot on failure
		await rm(skillsDir, { recursive: true, force: true })
		await rename(stagingDir, skillsDir)
		throw err
	}
}

export async function listBackups(skillsDir: string): Promise<string[]> {
	const backupBase = join(skillsDir, BACKUP_DIR_NAME)
	try {
		const entries = await readdir(backupBase, { withFileTypes: true })
		return entries
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort()
			.reverse()
	} catch {
		return []
	}
}

export async function pruneOldBackups(backupBase: string, keep: number): Promise<void> {
	const backups = await listBackups(backupBase.replace(`${BACKUP_DIR_NAME}/`, "").replace(BACKUP_DIR_NAME, ""))
	const toDelete = backups.slice(keep)

	for (const backup of toDelete) {
		await rm(join(backupBase, backup), { recursive: true, force: true })
	}
}
