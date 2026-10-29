// session-resource-loader.test.ts
//
// REAL-SDK regression tests for the ACP skill-refresh adapter (the
// implementation checkpoint from the single-load plan: prove the adapter with
// a real loader and real session before trusting the command-mocked suites).
//
// The old refresh flow reloaded the session's loader to pick up skill
// changes, which re-ran every inline extension factory (MCP adapter,
// subscriptions, lifecycle) just to re-read a directory listing. The adapter
// refreshes skills with a resources-only discovery loader while
// getExtensions() keeps pointing at the live set.
//
// These tests use the REAL pi SDK (DefaultResourceLoader +
// createAgentSession + a real AgentSession) and mirror production skill
// sources: settings-configured directories (base-scanned by every loader
// reload) and extension-contributed roots (delivered through
// resources_discover — the way claude-code-skills feeds project, bundled, and
// config skills into ACP sessions). Covered:
//   1. extension factories run exactly once across setup and any number of
//      skill refreshes, and one bus event still reaches one subscriber;
//   2. add/edit/delete rescans update the adapter's skills from both source
//      kinds, the served append prompt, and the session's rebuilt system
//      prompt;
//   3. a failed refresh keeps the previous snapshot;
//   4. an intentional full reload resets the discovery snapshot.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
	createAgentSession,
	createEventBus,
	DefaultResourceLoader,
	type ExtensionAPI,
	type InlineExtension,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { afterAll, describe, expect, it } from "vitest"
import { AcpSessionResourceLoader } from "./session-resource-loader.js"
import { invalidateSkillListBlock } from "./skill-commands.js"

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
	const dir = mkdtempSync(join(tmpdir(), "acp-adapter-"))
	tmpDirs.push(dir)
	return dir
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function writeSkill(root: string, name: string, description: string): void {
	mkdirSync(join(root, name), { recursive: true })
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, "utf-8")
}

function rewriteSkill(root: string, name: string, description: string): void {
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, "utf-8")
}

function skillNames(loader: { getSkills(): { skills: Array<{ name: string; description?: string }> } }): string[] {
	return loader
		.getSkills()
		.skills.map((s) => s.name)
		.sort()
}

interface Harness {
	loader: AcpSessionResourceLoader
	session: Awaited<ReturnType<typeof createAgentSession>>["session"]
	factoryRuns: () => number
	deliveries: unknown[]
	bus: ReturnType<typeof createEventBus>
	/** Settings-configured skill dir (base-scanned by loader reloads). */
	settingsSkills: string
	/** Extension-contributed skill dir (delivered via resources_discover). */
	extSkills: string
	/** Project skill dir, also extension-contributed (claude-code-skills shape). */
	projectSkills: string
}

async function setupHarness(): Promise<Harness> {
	const cwd = makeTmpDir()
	const agentDir = makeTmpDir()
	const settingsSkills = makeTmpDir()
	const extSkills = makeTmpDir()
	const projectSkills = join(cwd, ".kimchi", "skills")
	const bus = createEventBus()

	// Base-scanned source: settings-configured custom directories (pi's
	// settings.json `skills` array) — scanned by every loader reload,
	// including the adapter's resources-only discovery pass.
	writeSkill(settingsSkills, "settings-skill", "Configured via settings.json")
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [settingsSkills] }), "utf-8")

	// Extension-contributed sources: the inline factory mirrors
	// claude-code-skills — cwd-local roots delivered via resources_discover.
	writeSkill(extSkills, "ext-skill", "Extension-contributed skill")
	writeSkill(projectSkills, "project-skill", "Project-local skill")

	let factoryRuns = 0
	const deliveries: unknown[] = []
	const extension: InlineExtension = (pi: ExtensionAPI) => {
		factoryRuns++
		pi.on("resources_discover", () => ({ skillPaths: [extSkills, projectSkills] }))
		pi.events.on("acp-adapter-test", (payload) => deliveries.push(payload))
	}

	const settingsManager = SettingsManager.create(cwd, agentDir)
	const mainLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [extension],
		eventBus: bus,
	})
	const loader = new AcpSessionResourceLoader({
		mainLoader,
		cwd,
		agentDir,
		settingsManager,
		baseAppend: () => ["base append"],
	})
	// Mirrors createSessionSettings: the loader is loaded before the session
	// is created from it.
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

	return { loader, session, factoryRuns: () => factoryRuns, deliveries, bus, settingsSkills, extSkills, projectSkills }
}

async function dispose(h: Harness): Promise<void> {
	await h.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" })
	h.session.dispose()
}

describe("AcpSessionResourceLoader — real-loader skill refresh", () => {
	it("refreshes skills without re-running extension factories or duplicating bus delivery", async () => {
		const h = await setupHarness()
		try {
			expect(h.factoryRuns()).toBe(1)

			// Startup palette: settings-configured + extension-contributed skills.
			expect(skillNames(h.loader)).toEqual(["ext-skill", "project-skill", "settings-skill"])

			// Add a settings-configured skill after setup; a refresh picks it up.
			writeSkill(h.settingsSkills, "late-skill", "Appears after setup v1")
			await h.loader.refreshSkills(h.session)
			expect(skillNames(h.loader)).toContain("late-skill")

			// Edit it; the refreshed snapshot carries the new description.
			rewriteSkill(h.settingsSkills, "late-skill", "Edited description v2")
			await h.loader.refreshSkills(h.session)
			const edited = h.loader.getSkills().skills.find((s) => s.name === "late-skill")
			expect(edited?.description).toBe("Edited description v2")

			// Delete it; the refreshed snapshot drops it (no stale entries).
			rmSync(join(h.settingsSkills, "late-skill"), { recursive: true, force: true })
			await h.loader.refreshSkills(h.session)
			expect(skillNames(h.loader)).not.toContain("late-skill")

			// Deletion of an extension-contributed skill also lands (the
			// root stays contributed; its files are gone).
			rmSync(join(h.extSkills, "ext-skill"), { recursive: true, force: true })
			await h.loader.refreshSkills(h.session)
			expect(skillNames(h.loader)).toEqual(["project-skill", "settings-skill"])

			// Extensions loaded exactly once through setup AND all refreshes.
			expect(h.factoryRuns()).toBe(1)
			// getExtensions() still points at the live extension set.
			expect(h.loader.getExtensions().extensions.length).toBeGreaterThan(0)

			// One announced bus event reaches exactly one subscriber.
			h.bus.emit("acp-adapter-test", { marker: "once" })
			expect(h.deliveries).toEqual([{ marker: "once" }])
		} finally {
			await dispose(h)
		}
	})

	it("reflects a committed snapshot in the served append prompt and the session's rebuilt system prompt", async () => {
		const h = await setupHarness()
		try {
			writeSkill(h.settingsSkills, "prompt-skill", "Prompt visible skill")
			await h.loader.refreshSkills(h.session)
			// The sweep invalidates the cached skill-list block after the commit.
			invalidateSkillListBlock(h.loader)

			// The append prompt is computed from the CURRENT skills (a base
			// loader would serve a cached append until its next reload).
			const append = h.loader.getAppendSystemPrompt()
			expect(append[0]).toBe("base append")
			expect(append.join("\n")).toContain("prompt-skill")

			// Rebuilding prompt options the way the refresh sweep does: same
			// active tools, so only the prompt side changes.
			h.session.setActiveToolsByName(h.session.getActiveToolNames())
			expect(h.session.systemPrompt).toContain("prompt-skill")
			expect(h.session.systemPrompt).toContain("base append")
		} finally {
			await dispose(h)
		}
	})

	it("keeps the previous snapshot when a refresh fails", async () => {
		const h = await setupHarness()
		try {
			writeSkill(h.settingsSkills, "doomed-skill", "Never committed")
			await h.loader.refreshSkills(h.session)
			expect(skillNames(h.loader)).toContain("doomed-skill")
			const before = skillNames(h.loader)

			// Force the refresh to fail: a session without the upstream
			// resources-discover bridge trips the adapter's rename guard.
			const brokenSession = {} as unknown as Parameters<AcpSessionResourceLoader["refreshSkills"]>[0]
			await expect(h.loader.refreshSkills(brokenSession)).rejects.toThrow(/extendResourcesFromExtensions/)

			// The previously committed snapshot is unchanged.
			expect(skillNames(h.loader)).toEqual(before)
		} finally {
			await dispose(h)
		}
	})

	it("resets the discovery snapshot on an intentional full reload", async () => {
		const h = await setupHarness()
		try {
			writeSkill(h.settingsSkills, "reload-skill", "Lands before reload")
			await h.loader.refreshSkills(h.session)
			expect(skillNames(h.loader)).toContain("reload-skill")

			// Full reload: the main loader is reloaded and the discovery
			// snapshot resets — getSkills() serves the main loader's own
			// (re-scanned) set until the next refresh commits a new one.
			rmSync(join(h.settingsSkills, "reload-skill"), { recursive: true, force: true })
			const factoryRunsBeforeReload = h.factoryRuns()
			await h.loader.reload()
			expect(skillNames(h.loader)).not.toContain("reload-skill")
			// Settings-configured skills are re-scanned by the main reload.
			expect(skillNames(h.loader)).toContain("settings-skill")
			// An intentional full reload DOES re-run the factories — the
			// documented cost of session.reload() the skill refresh avoids.
			expect(h.factoryRuns()).toBe(factoryRunsBeforeReload + 1)
		} finally {
			await dispose(h)
		}
	})
})

describe("AcpSessionResourceLoader — refresh lifecycle races", () => {
	/** Gate the private resources-discover bridge so a refresh can be parked
	 *  mid-flight, deterministically interleaving reload/dispose with it.
	 *  One-shot: releasing restores the original bridge so later refreshes
	 *  (the post-race follow-up) run for real. */
	function gateBridge(session: Awaited<ReturnType<typeof createAgentSession>>["session"]) {
		const refreshable = session as unknown as Record<string, unknown>
		const original = refreshable.extendResourcesFromExtensions
		let release: (() => void) | undefined
		refreshable.extendResourcesFromExtensions = () =>
			new Promise<void>((resolve) => {
				release = () => {
					refreshable.extendResourcesFromExtensions = original
					resolve()
				}
			})
		return () => release?.()
	}

	it("a refresh that races a full reload discards its result", async () => {
		const h = await setupHarness()
		try {
			const release = gateBridge(h.session)
			writeSkill(h.settingsSkills, "racy-skill", "Deleted while the refresh is parked")

			const refresh = h.loader.refreshSkills(h.session)
			// Park the refresh inside the bridge; its discovery pass has
			// already scanned racy-skill into its snapshot.
			await new Promise<void>((r) => setTimeout(r, 20))
			// The skill is deleted while the pass is parked — the reload's
			// scan no longer sees it, so the parked snapshot is obsolete.
			rmSync(join(h.settingsSkills, "racy-skill"), { recursive: true, force: true })
			await h.loader.reload()
			release()
			expect(await refresh).toBe("discarded")

			// The obsolete snapshot (still containing the deleted skill) was
			// NOT committed over the reload's state.
			expect(skillNames(h.loader)).not.toContain("racy-skill")

			// A fresh refresh after the reload commits normally.
			expect(await h.loader.refreshSkills(h.session)).toBe("committed")
			expect(skillNames(h.loader)).not.toContain("racy-skill")
		} finally {
			await dispose(h)
		}
	})

	it("dispose discards an in-flight refresh and stops later ones", async () => {
		const h = await setupHarness()
		try {
			const release = gateBridge(h.session)
			writeSkill(h.settingsSkills, "posthumous-skill", "Must never be committed")

			const refresh = h.loader.refreshSkills(h.session)
			await new Promise<void>((r) => setTimeout(r, 20))
			h.loader.dispose()
			release()
			expect(await refresh).toBe("discarded")
			expect(skillNames(h.loader)).not.toContain("posthumous-skill")

			// Post-dispose refreshes are no-ops.
			expect(await h.loader.refreshSkills(h.session)).toBe("discarded")
			expect(skillNames(h.loader)).not.toContain("posthumous-skill")
		} finally {
			await dispose(h)
		}
	})

	it("a full reload drops the stale cached skill-list block from the served append", async () => {
		const h = await setupHarness()
		try {
			writeSkill(h.settingsSkills, "stale-after-reload", "Visible until the reload")
			expect(await h.loader.refreshSkills(h.session)).toBe("committed")
			// The sweep invalidates the cached block after the commit.
			invalidateSkillListBlock(h.loader)
			expect(h.loader.getAppendSystemPrompt().join("\n")).toContain("stale-after-reload")

			// Delete the skill, then full-reload: the skills AND the cached
			// append block must both drop it (the cache is invalidated by the
			// reload, so the model never reads a stale advertisement).
			rmSync(join(h.settingsSkills, "stale-after-reload"), { recursive: true, force: true })
			await h.loader.reload()
			expect(skillNames(h.loader)).not.toContain("stale-after-reload")
			expect(h.loader.getAppendSystemPrompt().join("\n")).not.toContain("stale-after-reload")
		} finally {
			await dispose(h)
		}
	})
})
