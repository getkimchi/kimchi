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
import { waitFor as sharedWaitFor } from "./test-utils.js"

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
	/** The main loader's CURRENT skill names — live-mutation detector for the
	 *  race tests (a refresh must never touch this set). */
	mainSkillNames: () => string[]
}

/** Optional harness controls: parkDiscovery lets a test hold the extension's
 *  REAL resources_discover handler mid-flight (returns a promise the handler
 *  awaits) — the genuine side-effect path, not a bridge stub.
 *  lateContributedDir is added to the handler's answer only AFTER the park
 *  resolves, so the parked pass's contributions differ from startup's and
 *  any live application of them is observable. */
interface HarnessOptions {
	parkDiscovery?: () => Promise<boolean>
	lateContributedDir?: string
}

async function setupHarness(opts: HarnessOptions = {}): Promise<Harness> {
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
		pi.on("resources_discover", async () => {
			// Optional test park point INSIDE the real handler — used to hold
			// a refresh mid-discovery without stubbing any upstream seam. The
			// late dir is contributed only after a REAL park so the parked
			// pass's answer differs from startup's (an unparked invocation
			// must answer identically to keep baselines comparable).
			const parked = await opts.parkDiscovery?.()
			return {
				skillPaths: [extSkills, projectSkills, ...(parked && opts.lateContributedDir ? [opts.lateContributedDir] : [])],
			}
		})
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

	return {
		loader,
		session,
		factoryRuns: () => factoryRuns,
		deliveries,
		bus,
		settingsSkills,
		extSkills,
		projectSkills,
		mainSkillNames: () =>
			mainLoader
				.getSkills()
				.skills.map((sk) => sk.name)
				.sort(),
	}
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

			// Force the refresh to fail: a session without a live extension
			// runner cannot answer the resources_discover query.
			const brokenSession = {} as unknown as Parameters<AcpSessionResourceLoader["refreshSkills"]>[0]
			await expect(h.loader.refreshSkills(brokenSession)).rejects.toThrow(/emitResourcesDiscover/)

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
	/** Park a REAL resources_discover handler mid-flight. The handler also
	 *  runs at session startup (bindExtensions), so the park is ARMED from the
	 *  test after setup: armed() lets the next invocation (the refresh's
	 *  discovery query) enter; entered() reports it; release() lets it (and
	 *  the refresh) continue. This is the genuine side-effect path — no
	 *  upstream seam is stubbed. */
	function parkDiscoveryHandler() {
		let armed = false
		let entries = 0
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		return {
			arm: () => {
				armed = true
			},
			/** How many handler invocations are parked (a refresh AND a full
			 *  reload's own bridge call can park simultaneously). */
			enteredCount: () => entries,
			release: () => release?.(),
			parkDiscovery: () => {
				if (!armed) return Promise.resolve(false)
				entries++
				return gate.then(() => true)
			},
		}
	}

	it("a delayed discovery pass disposed mid-flight mutates nothing", async () => {
		const park = parkDiscoveryHandler()
		// The parked handler contributes a NEW dir once released: any live
		// application of the pass's answer (the old bridge behavior) would
		// publish it.
		const lateDir = makeTmpDir()
		writeSkill(lateDir, "posthumous-skill", "Must never be published")
		const h = await setupHarness({ parkDiscovery: park.parkDiscovery, lateContributedDir: lateDir })
		try {
			const mainBefore = h.mainSkillNames()
			const promptBefore = h.session.systemPrompt

			park.arm()
			const refresh = h.loader.refreshSkills(h.session)
			await sharedWaitFor(() => park.enteredCount() === 1, {
				message: () => "refresh never reached the discovery handler",
			})
			// The session dies while the pass is parked inside the real
			// handler — mirroring disposeSessionRecord's order.
			h.loader.dispose()
			h.session.dispose()
			park.release()

			expect(await refresh).toBe("discarded")
			// The snapshot was not committed…
			expect(skillNames(h.loader)).not.toContain("posthumous-skill")
			// …and the live surfaces were not mutated either: the main
			// loader's skill set and the disposed session's prompt are
			// exactly what they were before the pass started.
			expect(h.mainSkillNames()).toEqual(mainBefore)
			expect(h.session.systemPrompt).toBe(promptBefore)
		} finally {
			await dispose(h)
		}
	})

	it("a refresh that races a full reload discards without live mutations", async () => {
		const park = parkDiscoveryHandler()
		const h = await setupHarness({ parkDiscovery: park.parkDiscovery })
		try {
			const mainBefore = h.mainSkillNames()
			writeSkill(h.settingsSkills, "racy-skill", "Deleted while the refresh is parked")

			park.arm()
			const refresh = h.loader.refreshSkills(h.session)
			await sharedWaitFor(() => park.enteredCount() === 1, {
				message: () => "refresh never reached the discovery handler",
			})
			// The skill is deleted while the pass is parked — the reload's
			// scan no longer sees it, so the parked snapshot is obsolete.
			rmSync(join(h.settingsSkills, "racy-skill"), { recursive: true, force: true })
			// The TRUE intentional full reload. Its resources_discover pass
			// re-enters the same parked handler (entry #2) before the reload
			// can finish — release once both are parked.
			const reloaded = h.session.reload()
			await sharedWaitFor(() => park.enteredCount() === 2, {
				message: () => "reload never reached its own discovery pass",
			})
			park.release()

			// The refresh's captured generation predates the reload's bump:
			// its obsolete snapshot (with the since-deleted skill) discards.
			expect(await refresh).toBe("discarded")
			await reloaded

			// The reload's own state stands: no racy-skill anywhere, the
			// extension-contributed skills re-applied by the reload's bridge,
			// and the prompt rebuilt by the reload (not the discarded pass).
			expect(skillNames(h.loader)).not.toContain("racy-skill")
			expect(h.mainSkillNames()).toEqual(mainBefore)
			expect(h.session.systemPrompt).not.toContain("racy-skill")

			// A fresh refresh after the reload commits normally.
			expect(await h.loader.refreshSkills(h.session)).toBe("committed")
			expect(skillNames(h.loader)).not.toContain("racy-skill")
		} finally {
			await dispose(h)
		}
	})

	it("dispose discards an in-flight refresh and stops later ones", async () => {
		const park = parkDiscoveryHandler()
		const lateDir = makeTmpDir()
		writeSkill(lateDir, "posthumous-skill", "Must never be committed")
		const h = await setupHarness({ parkDiscovery: park.parkDiscovery, lateContributedDir: lateDir })
		try {
			park.arm()
			const refresh = h.loader.refreshSkills(h.session)
			await sharedWaitFor(() => park.enteredCount() === 1, {
				message: () => "refresh never reached the discovery handler",
			})
			h.loader.dispose()
			park.release()
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
