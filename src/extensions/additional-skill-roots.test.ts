// Real-SDK integration tests for the non-ACP additional-skill-roots
// extension (`--additionalSkillsPaths`).
//
// Chunk 4 superseded the Chunk 3 `--skill` rewrite: non-ACP modes must
// contribute the roots additively through the inline `resources_discover`
// mechanism, prepended ahead of every other skill-contributing factory so
// collision precedence matches ACP's native `additionalSkillPaths`. These
// tests use the REAL pi SDK (DefaultResourceLoader + createAgentSession)
// and mirror production skill sources:
//   - a settings-configured root (agentDir settings.json `skills` array —
//     base-scanned by the loader like a global root);
//   - a repository root delivered through a second inline factory's
//     `resources_discover` (the way claude-code-skills feeds project-local
//     `.kimchi/skills`/`.claude/skills` roots into sessions);
//   - the additional root, either through the factory under test (non-ACP
//     shape) or through native `additionalSkillPaths` (ACP shape).
// Covered: coexistence of all three sources, cwd-relative resolution,
// deduplication, empty/no-flag behavior, and two-loader collision parity
// between the two contribution shapes (settings -> additional -> repository,
// first-named-skill-wins).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterAll, describe, expect, it } from "vitest"
import { createAdditionalSkillRootsExtension } from "./additional-skill-roots.js"

/** Minimal model stub — the session never streams in these tests. */
const fakeModel = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as unknown as Model<Api>

const tmpDirs: string[] = []

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "additional-skill-roots-"))
	tmpDirs.push(dir)
	return dir
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

/** Write `<root>/<name>/SKILL.md` — the directory shape every skill root uses. */
function writeSkill(root: string, name: string, description: string): string {
	const skillDir = join(root, name)
	mkdirSync(skillDir, { recursive: true })
	writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, "utf-8")
	return skillDir
}

function skillNames(loader: { getSkills(): { skills: Array<{ name: string }> } }): string[] {
	return loader
		.getSkills()
		.skills.map((s) => s.name)
		.sort()
}

function skillDescription(
	loader: { getSkills(): { skills: Array<{ name: string; description?: string }> } },
	name: string,
): string {
	const skill = loader.getSkills().skills.find((s) => s.name === name)
	if (!skill?.description) throw new Error(`skill ${name} not found`)
	return skill.description
}

/**
 * Repository-root factory: mirrors claude-code-skills — project-local roots
 * delivered via resources_discover AFTER the additional-roots factory in the
 * registration list.
 */
function repoSkillsExtension(dirs: () => string[]): InlineExtension {
	return (pi: ExtensionAPI) => {
		pi.on("resources_discover", () => ({ skillPaths: dirs() }))
	}
}

interface LoaderShape {
	/** Native process paths (ACP shape: DefaultResourceLoaderOptions). */
	nativeAdditionalPaths: string[]
	/** Inline factory roots (non-ACP shape: the extension under test). */
	factoryRoots: string[]
	/** Repository roots contributed by a later inline factory. */
	repoRoots: string[]
	/** Extra factory roots getter answers (prepended factory stays first). */
	settingsSkills?: string
}

interface Harness {
	loader: DefaultResourceLoader
	session: Awaited<ReturnType<typeof createAgentSession>>["session"]
	cwd: string
	dispose: () => Promise<void>
}

/** Build a real loader + real session over the three production source shapes. */
async function setupLoader(shape: LoaderShape): Promise<Harness> {
	const cwd = makeTmpDir()
	const agentDir = makeTmpDir()
	// Settings-configured root: base-scanned on every loader reload, exactly
	// like a global/config skill directory.
	const settingsSkills = shape.settingsSkills ?? makeTmpDir()
	writeSkill(settingsSkills, "settings-skill", "from-settings")
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [settingsSkills] }), "utf-8")

	const settingsManager = SettingsManager.create(cwd, agentDir)
	const extensionFactories: InlineExtension[] = [
		// The extension under test, PREPENDED exactly like cli.ts registers it.
		...(shape.factoryRoots.length > 0 ? [createAdditionalSkillRootsExtension(() => shape.factoryRoots)] : []),
		// Repository contributions come later in the registration order.
		repoSkillsExtension(() => shape.repoRoots),
	]
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories,
		additionalSkillPaths: shape.nativeAdditionalPaths,
	})
	await loader.reload()

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
		model: fakeModel,
		modelRuntime: {} as ModelRuntime,
		resourceLoader: loader,
	})
	await session.bindExtensions({
		onError: (err) => {
			throw new Error(`extension failed: ${err.error ?? err.extensionPath}`)
		},
	})
	return {
		loader,
		session,
		cwd,
		dispose: async () => {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
			session.dispose()
		},
	}
}

describe("createAdditionalSkillRootsExtension — real loader integration", () => {
	it("loads settings, repository, and additional roots together", async () => {
		// Non-ACP shape: additional roots through the prepended factory.
		const additionalRoot = makeTmpDir()
		writeSkill(additionalRoot, "additional-skill", "from-additional")
		writeSkill(additionalRoot, "second-additional-skill", "also-from-additional")
		const repoRoot = makeTmpDir()
		writeSkill(repoRoot, "repo-skill", "from-repo")

		const h = await setupLoader({ nativeAdditionalPaths: [], factoryRoots: [additionalRoot], repoRoots: [repoRoot] })
		try {
			expect(skillNames(h.loader)).toEqual([
				"additional-skill",
				"repo-skill",
				"second-additional-skill",
				"settings-skill",
			])
		} finally {
			await h.dispose()
		}
	})

	it("contributes nothing when no roots exist (no-flag behavior)", async () => {
		const repoRoot = makeTmpDir()
		writeSkill(repoRoot, "repo-skill", "from-repo")

		const h = await setupLoader({ nativeAdditionalPaths: [], factoryRoots: [], repoRoots: [repoRoot] })
		try {
			expect(skillNames(h.loader)).toEqual(["repo-skill", "settings-skill"])
		} finally {
			await h.dispose()
		}
	})

	it("resolves relative roots against the discovery event cwd and deduplicates", async () => {
		const cwd = makeTmpDir()
		const relative = "extra-skills"
		writeSkill(join(cwd, relative), "relative-skill", "resolved-against-session-cwd")
		const absoluteDuplicate = join(cwd, relative)

		const agentDir = makeTmpDir()
		const settingsSkills = makeTmpDir()
		writeSkill(settingsSkills, "settings-skill", "from-settings")
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [settingsSkills] }), "utf-8")
		const settingsManager = SettingsManager.create(cwd, agentDir)

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			// The factory under test, first in the list, with a relative root,
			// its absolute spelling, and a repeat — all one resolved root.
			extensionFactories: [createAdditionalSkillRootsExtension(() => [relative, absoluteDuplicate, relative])],
		})
		await loader.reload()
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			model: fakeModel,
			modelRuntime: {} as ModelRuntime,
			resourceLoader: loader,
		})
		await session.bindExtensions({
			onError: (err) => {
				throw new Error(`extension failed: ${err.error ?? err.extensionPath}`)
			},
		})
		try {
			// The relative root resolves against the session cwd (not the test
			// runner's process.cwd()) — otherwise the skill would not load at
			// all — and the duplicate spellings collapse to one root.
			expect(skillNames(loader)).toEqual(["relative-skill", "settings-skill"])
			const relativeSkill = loader.getSkills().skills.find((s) => s.name === "relative-skill")
			expect(relativeSkill?.description).toBe("resolved-against-session-cwd")
		} finally {
			await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
			session.dispose()
		}
	})

	it("chooses the same collision winner as ACP's native additionalSkillPaths (two-loader parity)", async () => {
		// One skill name colliding across all three sources: settings must win
		// over the additional root, and the additional root must win over the
		// repository contribution — in BOTH contribution shapes.
		const additionalRoot = makeTmpDir()
		const repoRoot = makeTmpDir()
		const settingsSkills = makeTmpDir()
		writeSkill(settingsSkills, "colliding", "from-settings")
		writeSkill(settingsSkills, "settings-only", "from-settings")
		writeSkill(additionalRoot, "colliding", "from-additional")
		writeSkill(additionalRoot, "add-vs-repo", "from-additional")
		writeSkill(additionalRoot, "add-only", "from-additional")
		writeSkill(repoRoot, "colliding", "from-repo")
		writeSkill(repoRoot, "add-vs-repo", "from-repo")
		writeSkill(repoRoot, "repo-only", "from-repo")

		const acpShape = await setupLoader({
			nativeAdditionalPaths: [additionalRoot],
			factoryRoots: [],
			repoRoots: [repoRoot],
			settingsSkills,
		})
		const nonAcpShape = await setupLoader({
			nativeAdditionalPaths: [],
			factoryRoots: [additionalRoot],
			repoRoots: [repoRoot],
			settingsSkills,
		})
		try {
			for (const h of [acpShape, nonAcpShape]) {
				// settings -> additional -> repository, first-named-skill-wins.
				expect(skillDescription(h.loader, "colliding")).toBe("from-settings")
				// Without a settings collision, the additional root beats the
				// repository contribution in both shapes too.
				expect(skillDescription(h.loader, "add-vs-repo")).toBe("from-additional")
				// The non-colliding sources still coexist (including the harness's
				// own settings-skill).
				expect(skillNames(h.loader)).toEqual([
					"add-only",
					"add-vs-repo",
					"colliding",
					"repo-only",
					"settings-only",
					"settings-skill",
				])
			}
		} finally {
			await acpShape.dispose()
			await nonAcpShape.dispose()
		}
	})
})
