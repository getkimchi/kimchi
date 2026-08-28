import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveAuxiliaryFilesDir } from "../../auxiliary-files/resolver.js"
import { findNearestAncestorSkillDir } from "../../skill-paths.js"

/**
 * Central skill-root resolver — the single place that knows which directories
 * are scanned for skills and in what precedence order. Before this module
 * existed, skills-manager, the agents skill-loader, ACP skill-commands, and
 * prompt-enrichment each re-derived their own location rules, which is why
 * bundled skills (shipped with the harness) previously had to be *deployed*
 * into the user home dir to become visible (see extensions/improve's removed
 * deploy).
 */

export type SkillRootKind = "bundled" | "harness" | "config" | "project"

export interface SkillRoot {
	readonly dir: string
	readonly kind: SkillRootKind
}

export interface ResolveSkillRootsOptions {
	/** Working directory for cwd-relative config paths and project ancestor search. */
	readonly cwd: string
	/** Default homedir(); override in tests. */
	readonly homeDir?: string
	/** Default process.execPath; used for the compiled-binary bundled lookup. */
	readonly execPath?: string
	/**
	 * Config-style skill paths (e.g. DEFAULT_SKILL_PATHS minus the harness dir) mapped by
	 * the historical rule: absolute → as-is, `.config/` → home, else → cwd.
	 * Defaults to the two optional locations `.pi/agent/skills` and `.claude/skills`.
	 */
	readonly configPaths?: readonly string[]
	/**
	 * Override for the bundled skills dir. `null` disables the bundled root.
	 * Defaults to `resources/skills/` in the source tree, or the staged
	 * `skills/` dir under resolveAuxiliaryFilesDir() in the compiled binary.
	 */
	readonly bundledDir?: string | null
}

const DEFAULT_CONFIG_PATHS = [join(".pi", "agent", "skills"), join(".claude", "skills")]

const HARNESS_SKILLS_REL = join(".config", "kimchi", "harness", "skills")

/** The harness skills dir — the writable root that skills-manager manages. */
export function resolveHarnessSkillsDir(home: string = homedir()): string {
	return join(home, HARNESS_SKILLS_REL)
}

/**
 * Locate the bundled skills dir. In dev it sits at <repo>/resources/skills
 * (three levels up from this module). In the compiled Bun binary the module
 * path is virtual, so fall back to the staged copy next to the executer
 * via resolveAuxiliaryFilesDir (same mechanism ssh-proxy uses).
 */
export function resolveBundledSkillsDir(home: string = homedir(), execPath?: string): string | null {
	const devDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "skills")
	if (existsSync(devDir)) return devDir

	const staged = join(resolveAuxiliaryFilesDir(process.env, home, execPath), "skills")
	if (existsSync(staged)) return staged
	return null
}

function mapConfigPath(path: string, cwd: string, home: string): string {
	if (isAbsolute(path)) return path
	if (path.startsWith(".config/") || path.startsWith(".config\\")) return join(home, path)
	return join(cwd, path)
}

/**
 * Ordered skill roots, weakest first. Consumers that build a name→skill map
 * should let later occurrences override earlier ones, yielding the precedence
 * project > config > harness > bundled. Missing `config` and `project`
 * directories are skipped; the harness root is always included because it is
 * the default writable root even when it has not been created yet, and the
 * bundled root is included only when it resolves to an existing directory.
 */
export function resolveSkillRoots(options: ResolveSkillRootsOptions): SkillRoot[] {
	const home = options.homeDir ?? homedir()
	const bundled =
		options.bundledDir === undefined ? resolveBundledSkillsDir(home, options.execPath) : options.bundledDir
	const roots: SkillRoot[] = []

	if (bundled) roots.push({ dir: bundled, kind: "bundled" })
	roots.push({ dir: resolveHarnessSkillsDir(home), kind: "harness" })
	for (const p of options.configPaths ?? DEFAULT_CONFIG_PATHS) {
		const dir = mapConfigPath(p, options.cwd, home)
		if (existsSync(dir)) roots.push({ dir, kind: "config" })
	}
	const projectDir = findNearestAncestorSkillDir(options.cwd, join(".kimchi", "skills"))
	if (projectDir) roots.push({ dir: projectDir, kind: "project" })

	return roots
}

/**
 * Resolve skill roots and return a flat list of skill paths suitable for
 * contributing to pi's resource inventory via resources_discover.
 *
 * - Non-existent paths are filtered out (pi warns about them).
 * - The harness dir is excluded because pi loads it natively via
 *   includeDefaults (agentDir/skills) — contributing it again is redundant.
 * - Bundled skills already present in a stronger path (harness, config, or
 *   project) are silently skipped via a filtered temp copy, so no collision
 *   warnings are emitted. New bundled skills not present elsewhere are still
 *   contributed.
 *
 * @param cwd Working directory for project ancestor search.
 * @param homeDir Override for os.homedir() (tests).
 * @param bundledDir Override for the bundled skills dir; null disables it.
 * @param configPaths Override for config-style skill paths.
 * @param extraPaths Additional paths to include (e.g. configured skillPaths
 *   from kimchi config.json that pi doesn't see).
 */
export function resolveSkillPathsForDiscovery(
	cwd: string,
	options?: {
		homeDir?: string
		bundledDir?: string | null
		configPaths?: readonly string[]
		extraPaths?: readonly string[]
	},
): string[] {
	const home = options?.homeDir ?? homedir()
	const roots = resolveSkillRoots({
		cwd,
		homeDir: home,
		bundledDir: options?.bundledDir,
		configPaths: options?.configPaths ?? [],
	})

	const harnessDir = resolveHarnessSkillsDir(home)
	const normalizedHarnessDir = resolve(harnessDir)

	// First pass: collect skill names from all non-bundled roots + extraPaths
	// so the bundled filter is robust to root ordering (resolveSkillRoots
	// returns weakest-first, so bundled comes before project/config).
	const skillNamesFromStronger = new Set<string>()
	collectSkillNames(harnessDir, skillNamesFromStronger)
	for (const root of roots) {
		if (root.kind === "bundled" || root.kind === "harness") continue
		if (!existsSync(root.dir)) continue
		collectSkillNames(root.dir, skillNamesFromStronger)
	}
	for (const p of options?.extraPaths ?? []) {
		if (resolve(p) === normalizedHarnessDir) continue
		if (!existsSync(p)) continue
		collectSkillNames(p, skillNamesFromStronger)
	}

	// Second pass: build the output path list.
	const paths: string[] = []
	const seen = new Set<string>()

	for (const root of roots) {
		if (root.kind === "harness") continue
		const normalized = resolve(root.dir)
		if (seen.has(normalized)) continue
		if (!existsSync(normalized)) continue

		if (root.kind === "bundled") {
			const filtered = filterBundledSkills(normalized, skillNamesFromStronger)
			if (filtered) {
				seen.add(filtered)
				paths.push(filtered)
			}
			continue
		}

		seen.add(normalized)
		paths.push(normalized)
	}

	for (const p of options?.extraPaths ?? []) {
		const normalized = resolve(p)
		if (seen.has(normalized)) continue
		if (normalized === normalizedHarnessDir) continue
		if (!existsSync(normalized)) continue
		seen.add(normalized)
		paths.push(normalized)
	}

	return paths
}

function listSkillNames(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
	} catch {
		return []
	}
}

function collectSkillNames(dir: string, out: Set<string>): void {
	for (const name of listSkillNames(dir)) {
		out.add(name)
	}
}

function filterBundledSkills(bundledDir: string, existingSkillNames: Set<string>): string | undefined {
	const bundledSkills = listSkillNames(bundledDir)
	if (bundledSkills.length === 0) return undefined
	const newSkills = bundledSkills.filter((name) => !existingSkillNames.has(name))
	if (newSkills.length === 0) return undefined
	const tempDir = mkdtempSync(join(tmpdir(), "kimchi-bundled-skills-"))
	process.once("exit", () => {
		rmSync(tempDir, { recursive: true, force: true })
	})
	for (const name of newSkills) {
		cpSync(join(bundledDir, name), join(tempDir, name), { recursive: true })
	}
	return tempDir
}
