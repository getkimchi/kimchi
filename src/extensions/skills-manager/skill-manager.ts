import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { parse as parseYaml } from "yaml"

const SKILLS_DIR_CACHE = new Map<string, SkillManager>()

export function getSkillManager(skillsDir: string): SkillManager {
	let manager = SKILLS_DIR_CACHE.get(skillsDir)
	if (!manager) {
		manager = new SkillManager(skillsDir)
		SKILLS_DIR_CACHE.set(skillsDir, manager)
	}
	return manager
}

/**
 * Check if a skill directory exists.
 */
export async function skillExists(name: string): Promise<boolean> {
	const skillsDir = process.env.SKILLS_DIR ?? join(process.cwd(), "skills")
	const manager = new SkillManager(skillsDir)
	return manager.exists(name)
}

/**
 * Archive a skill by moving it to the .archive directory.
 * Returns true if successful, false if skill not found.
 */
export async function archiveSkill(name: string): Promise<boolean> {
	const skillsDir = process.env.SKILLS_DIR ?? join(process.cwd(), "skills")
	const manager = new SkillManager(skillsDir)
	const result = await manager.delete(name)
	return result.success
}

export type SkillAction = "create" | "edit" | "patch" | "delete" | "write_file" | "remove_file" | "pin"

export interface SkillManageResult {
	success: boolean
	message?: string
	error?: string
	file_preview?: string
	available_files?: string[]
	path?: string
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const MAX_NAME_LEN = 64
const ALLOWED_SUBDIRS = new Set(["references", "templates", "scripts", "assets"])

export function validateName(name: string): string | null {
	if (name.length === 0) return "Name cannot be empty."
	if (name.length > MAX_NAME_LEN) return `Name must be at most ${MAX_NAME_LEN} characters.`
	if (!NAME_RE.test(name)) {
		if (!/^[a-z0-9]/.test(name)) return "Name must start with a lowercase letter or digit."
		return "Name must contain only lowercase letters, digits, dots, underscores, or hyphens."
	}
	return null
}

export function validateCategory(category?: string): string | null {
	if (!category) return null
	return validateName(category)
}

/**
 * Parse the frontmatter block and body from a skill file.
 * Only looks at the first two `---` delimiters.
 * Returns the full block including both `---` delimiters for frontmatter.
 */
export function parseSkill(content: string): { frontmatter: string; body: string } {
	const first = content.indexOf("---")
	if (first !== 0) return { frontmatter: "", body: content }
	const second = content.indexOf("---", first + 3)
	if (second === -1) return { frontmatter: "", body: content }
	// frontmatter includes both opening and closing --- delimiters
	const frontmatter = content.slice(0, second + 3)
	// body starts after the closing --- (skip the newline immediately after it)
	const bodyStart = second + 3
	const body = content.slice(bodyStart).replace(/^\n/, "")
	return { frontmatter: `${frontmatter}\n`, body }
}

export async function validateFrontmatter(content: string): Promise<string | null> {
	const first = content.indexOf("---")
	if (first !== 0) return "Frontmatter must start with '---'."
	const afterFirst = content.indexOf("---", first + 3)
	if (afterFirst === -1) return "Frontmatter is missing a closing '---' delimiter."

	// Extract YAML content between the --- delimiters (don't include the --- itself)
	const fm = content.slice(first + 3, afterFirst)
	const body = content.slice(afterFirst + 3)
	if (body.trim().length === 0) return "Body content is required after frontmatter."

	// Parse just the YAML content between the delimiters
	let parsed: unknown
	try {
		parsed = parseYaml(fm)
	} catch (err) {
		return `Frontmatter contains invalid YAML: ${String(err)}`
	}

	if (typeof parsed !== "object" || parsed === null) {
		return "Frontmatter YAML must be an object (key-value mapping)."
	}

	const obj = parsed as Record<string, unknown>
	if (typeof obj.description !== "string" || obj.description.trim() === "") {
		return "Frontmatter must include a non-empty 'description' field."
	}

	return null
}

export function validateFilePath(filePath: string, skillDir: string): string | null {
	const resolved = resolve(skillDir, filePath)
	const skillResolved = resolve(skillDir) + sep
	if (!resolved.startsWith(skillResolved)) {
		return `Path escapes the skill directory: '${filePath}' is outside the allowed scope.`
	}

	// Check that the top-level subdirectory is one of the allowed ones
	const rel = filePath.replace(/\\/g, "/")
	const parts = rel.split("/")
	if (parts.length < 2) {
		return "Files must be placed inside a subdirectory (e.g. references/file.md), not at the root of the skill."
	}
	const top = parts[0]
	if (!ALLOWED_SUBDIRS.has(top)) {
		return `Top-level directory '${top}' is not allowed. Allowed: ${[...ALLOWED_SUBDIRS].join(", ")}.`
	}

	return null
}

export function formatPreview(content: string, maxLines = 50): string {
	const lines = content.split("\n")
	const totalLines = lines.length
	const pad = String(totalLines).length
	const preview = lines.slice(0, maxLines)
	const result = preview.map((line, i) => `${String(i + 1).padStart(pad, " ")} | ${line}`).join("\n")

	if (totalLines > maxLines) {
		const more = totalLines - maxLines
		return `${result}\n... (${more} more lines)`
	}

	return result
}

export type SkillOrigin = "harness" | "bundled"

interface SkillLocation {
	skillDir: string
	category: string
	origin: SkillOrigin
	readOnly: boolean
}

export interface SkillManagerOptions {
	/**
	 * Read-only roots scanned when a skill is not found in the harness dir
	 * (e.g. the bundled skills shipped with the harness). Listed weakest first;
	 * mutations targeting a bundled origin are refused.
	 */
	readonly bundledRoots?: readonly string[]
}

/** Refuse mutations on skills that do not live under the writable harness root. */
function readonlyGuard(loc: SkillLocation): string | null {
	if (!loc.readOnly) return null
	return `Skill is bundled with the harness (origin: ${loc.skillDir}) and is read-only. To customize it, copy it into the harness skills dir first.`
}

export class SkillManager {
	private skillsDir: string
	private bundledRoots: readonly string[]

	/**
	 * @param skillsDir The single writable root this manager owns. Mutations
	 * (edit/patch/delete/write_file/remove_file) are only allowed on skills
	 * whose directory lives under this root; bundled and other read-only roots
	 * are scanned for viewing and copying, but never modified in place.
	 */
	constructor(skillsDir: string, options?: SkillManagerOptions) {
		this.skillsDir = skillsDir
		this.bundledRoots = options?.bundledRoots ?? []
	}

	private _isUnderSkillsDir(skillDir: string): boolean {
		const resolvedSkillDir = resolve(skillDir)
		const resolvedSkillsDir = resolve(this.skillsDir)
		return resolvedSkillDir === resolvedSkillsDir || resolvedSkillDir.startsWith(`${resolvedSkillsDir}${sep}`)
	}

	/**
	 * Locate a skill directory by name.
	 * 1. Check <skillsDir>/<name>/SKILL.md directly (harness origin).
	 * 2. Scan immediate subdirectories of skillsDir for <sub>/<name>/SKILL.md.
	 * 3. Fall back to bundled roots, strongest (later) root first.
	 */
	private async _findSkill(name: string): Promise<SkillLocation | null> {
		const direct = join(this.skillsDir, name, "SKILL.md")
		if (await this._exists(direct)) {
			const skillDir = join(this.skillsDir, name)
			return { skillDir, category: "", origin: "harness", readOnly: !this._isUnderSkillsDir(skillDir) }
		}

		let entries: string[] = []
		try {
			entries = await readdir(this.skillsDir)
		} catch {
			entries = []
		}

		for (const sub of entries) {
			const candidate = join(this.skillsDir, sub, name, "SKILL.md")
			if (await this._exists(candidate)) {
				const skillDir = join(this.skillsDir, sub, name)
				return { skillDir, category: sub, origin: "harness", readOnly: !this._isUnderSkillsDir(skillDir) }
			}
		}

		for (let i = this.bundledRoots.length - 1; i >= 0; i--) {
			const candidate = join(this.bundledRoots[i], name, "SKILL.md")
			if (await this._exists(candidate)) {
				const skillDir = join(this.bundledRoots[i], name)
				return { skillDir, category: "", origin: "bundled", readOnly: !this._isUnderSkillsDir(skillDir) }
			}
		}

		return null
	}

	private async _exists(path: string): Promise<boolean> {
		try {
			await stat(path)
			return true
		} catch {
			return false
		}
	}

	async exists(name: string): Promise<boolean> {
		const loc = await this._findSkill(name)
		return loc !== null
	}

	async listInventory(): Promise<
		Array<{ name: string; category?: string; path: string; agent_created: boolean; origin: SkillOrigin }>
	> {
		const inventory: Array<{
			name: string
			category?: string
			path: string
			agent_created: boolean
			origin: SkillOrigin
		}> = []
		await this._scanDir(this.skillsDir, undefined, "harness", inventory)
		for (const bundled of this.bundledRoots) {
			// Harness entries shadow bundled ones by name (mirrors _findSkill); skip
			// a bundled entry when a harness entry of the same name already exists.
			const bundledInventory: typeof inventory = []
			await this._scanDir(bundled, undefined, "bundled", bundledInventory)
			inventory.push(...bundledInventory.filter((entry) => !inventory.some((existing) => existing.name === entry.name)))
		}
		return inventory
	}

	private async _scanDir(
		dir: string,
		category: string | undefined,
		origin: SkillOrigin,
		out: Array<{ name: string; category?: string; path: string; agent_created: boolean; origin: SkillOrigin }>,
	): Promise<void> {
		let entries: string[] = []
		try {
			entries = await readdir(dir)
		} catch {
			return
		}

		for (const entry of entries) {
			if (entry.startsWith(".")) continue
			const full = join(dir, entry)
			try {
				const s = await stat(full)
				if (s.isDirectory()) {
					const skillPath = join(full, "SKILL.md")
					try {
						await stat(skillPath)
						// Check agent_created flag in .usage.json
						let agentCreated = false
						try {
							const usagePath = join(full, ".usage.json")
							const usageContent = await readFile(usagePath, "utf-8")
							const usage = JSON.parse(usageContent)
							agentCreated = usage.agent_created === true
						} catch {
							// No .usage.json or parse error → not agent-created
						}
						out.push({ name: entry, category, path: full, agent_created: agentCreated, origin })
					} catch {
						// Not a skill dir, recurse into subdirs
						await this._scanDir(full, entry, origin, out)
					}
				}
			} catch {
				// skip
			}
		}
	}

	private async _atomicWrite(filePath: string, content: string): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true })
		const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`
		await writeFile(tmp, content, "utf-8")
		await rename(tmp, filePath)
	}

	private async _pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
		let current = dir
		while (current !== stopAt && current !== dirname(current)) {
			try {
				const entries = await readdir(current)
				if (entries.length > 0) break
				await rmdir(current)
				current = dirname(current)
			} catch {
				break
			}
		}
	}

	async create(name: string, content: string, category?: string): Promise<SkillManageResult> {
		const nameError = validateName(name)
		if (nameError) return { success: false, error: nameError }

		const catError = validateCategory(category)
		if (catError) return { success: false, error: catError }

		const fmError = await validateFrontmatter(content)
		if (fmError) {
			return { success: false, error: fmError, file_preview: formatPreview(content) }
		}

		const skillDir = category ? join(this.skillsDir, category, name) : join(this.skillsDir, name)
		const skillPath = join(skillDir, "SKILL.md")

		if (await this._exists(skillPath)) {
			return { success: false, error: `Skill '${name}' already exists.` }
		}

		try {
			await this._atomicWrite(skillPath, content)
			return {
				success: true,
				message: `Skill '${name}' created.`,
				path: skillDir,
			}
		} catch (err) {
			return { success: false, error: String(err) }
		}
	}

	async edit(name: string, content: string): Promise<SkillManageResult> {
		const loc = await this._findSkill(name)
		if (!loc) return { success: false, error: `Skill '${name}' not found.` }
		const readOnlyReason = readonlyGuard(loc)
		if (readOnlyReason) return { success: false, error: readOnlyReason }

		const fmError = await validateFrontmatter(content)
		if (fmError) {
			return { success: false, error: fmError, file_preview: formatPreview(content) }
		}

		const skillPath = join(loc.skillDir, "SKILL.md")
		try {
			await this._atomicWrite(skillPath, content)
			return { success: true, message: `Skill '${name}' updated.` }
		} catch (err) {
			return { success: false, error: String(err) }
		}
	}

	async patch(name: string, oldString: string, newString: string, filePath?: string): Promise<SkillManageResult> {
		const loc = await this._findSkill(name)
		if (!loc) return { success: false, error: `Skill '${name}' not found.` }
		const readOnlyReason = readonlyGuard(loc)
		if (readOnlyReason) return { success: false, error: readOnlyReason }

		const targetPath = filePath ? join(loc.skillDir, filePath) : join(loc.skillDir, "SKILL.md")

		let content: string
		try {
			content = await readFile(targetPath, "utf-8")
		} catch {
			return { success: false, error: `Could not read file '${filePath ?? "SKILL.md"}'.` }
		}

		const parts = content.split(oldString)
		const matchCount = parts.length - 1

		if (matchCount === 0) {
			return {
				success: false,
				error: `Pattern not found: '${oldString}'.`,
				file_preview: formatPreview(content),
			}
		}

		if (matchCount > 1) {
			return {
				success: false,
				error: `Multiple matches (${matchCount}) for '${oldString}'. Provide a larger unique context.`,
				file_preview: formatPreview(content),
			}
		}

		const patched = parts.join(newString)

		// If patching SKILL.md, validate frontmatter after patch
		if (!filePath) {
			const fmError = await validateFrontmatter(patched)
			if (fmError) {
				return {
					success: false,
					error: `Patch would break frontmatter: ${fmError}`,
					file_preview: formatPreview(patched),
				}
			}
		}

		try {
			await this._atomicWrite(targetPath, patched)
			return { success: true, message: `Patched '${name}'.` }
		} catch (err) {
			return { success: false, error: String(err) }
		}
	}

	async delete(name: string, _absorbedInto?: string): Promise<SkillManageResult> {
		const loc = await this._findSkill(name)
		if (!loc) return { success: false, error: `Skill '${name}' not found.` }
		const readOnlyReason = readonlyGuard(loc)
		if (readOnlyReason) return { success: false, error: readOnlyReason }

		const archiveDir = join(this.skillsDir, ".archive")
		const archivePath = join(archiveDir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)

		try {
			await mkdir(archiveDir, { recursive: true })
			await rename(loc.skillDir, archivePath)
			return { success: true, message: `Skill '${name}' archived.` }
		} catch (err) {
			const code = (err as { code?: string }).code
			if (code === "ENOENT") {
				return { success: false, error: `Skill '${name}' was already moved or deleted by another operation.` }
			}
			return { success: false, error: String(err) }
		}
	}

	async writeFile(name: string, filePath: string, fileContent: string): Promise<SkillManageResult> {
		const loc = await this._findSkill(name)
		if (!loc) return { success: false, error: `Skill '${name}' not found.` }
		const readOnlyReason = readonlyGuard(loc)
		if (readOnlyReason) return { success: false, error: readOnlyReason }

		const pathError = validateFilePath(filePath, loc.skillDir)
		if (pathError) return { success: false, error: pathError }

		const targetPath = join(loc.skillDir, filePath)
		try {
			await this._atomicWrite(targetPath, fileContent)
			return { success: true, message: `File '${filePath}' written.` }
		} catch (err) {
			return { success: false, error: String(err) }
		}
	}

	async removeFile(name: string, filePath: string): Promise<SkillManageResult> {
		const loc = await this._findSkill(name)
		if (!loc) return { success: false, error: `Skill '${name}' not found.` }
		const readOnlyReason = readonlyGuard(loc)
		if (readOnlyReason) return { success: false, error: readOnlyReason }

		const targetPath = join(loc.skillDir, filePath)
		if (!(await this._exists(targetPath))) {
			// List available files in the skill
			const available: string[] = []
			await this._collectFiles(loc.skillDir, "", available)
			return {
				success: false,
				error: `File '${filePath}' not found in skill '${name}'.`,
				available_files: available,
			}
		}

		try {
			await unlink(targetPath)
			await this._pruneEmptyDirs(dirname(targetPath), loc.skillDir)
			return { success: true, message: `File '${filePath}' removed.` }
		} catch (err) {
			return { success: false, error: String(err) }
		}
	}

	async view(
		name: string,
		filePath?: string,
	): Promise<SkillManageResult & { content?: string; linked_files?: Record<string, string[]> }> {
		const loc = await this._findSkill(name)
		if (!loc) {
			return { success: false, error: `Skill '${name}' not found.` }
		}

		const targetPath = filePath ? join(loc.skillDir, filePath) : join(loc.skillDir, "SKILL.md")

		// Path traversal guard
		if (filePath) {
			const resolved = resolve(targetPath)
			if (!resolved.startsWith(`${resolve(loc.skillDir)}/`)) {
				return { success: false, error: "Path traversal is not allowed." }
			}
		}

		let content: string
		try {
			content = await readFile(targetPath, "utf-8")
		} catch {
			return { success: false, error: `File '${filePath ?? "SKILL.md"}' not found in skill '${name}'.` }
		}

		if (filePath) {
			return { success: true, message: `Loaded '${filePath}' from '${name}'.`, content }
		}

		// Collect linked files by subdirectory
		const linked_files: Record<string, string[]> = {}
		for (const subdir of ["references", "templates", "scripts", "assets"]) {
			const files: string[] = []
			await this._collectFiles(join(loc.skillDir, subdir), subdir, files)
			if (files.length > 0) linked_files[subdir] = files
		}

		return {
			success: true,
			message: `Loaded skill '${name}'.`,
			content,
			...(Object.keys(linked_files).length > 0 ? { linked_files } : {}),
		}
	}

	private async _collectFiles(dir: string, prefix: string, out: string[]): Promise<void> {
		let entries: string[] = []
		try {
			entries = await readdir(dir)
		} catch {
			return
		}

		for (const entry of entries) {
			const full = join(dir, entry)
			const rel = prefix ? `${prefix}/${entry}` : entry
			try {
				const s = await stat(full)
				if (s.isFile()) {
					out.push(rel)
				} else if (s.isDirectory()) {
					await this._collectFiles(full, rel, out)
				}
			} catch {
				// skip entries we can't stat
			}
		}
	}
}
