import {
	type AgentSession,
	DefaultResourceLoader,
	type ResourceDiagnostic,
	type ResourceLoader,
	type SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent"
import { buildSkillListBlock, cachedSkillListBlock, setCachedSkillListBlock } from "./skill-commands.js"

/** Upstream reload options — derived from the interface so it cannot drift. */
type LoaderReloadOptions = Parameters<ResourceLoader["reload"]>[0]

/**
 * Stable session loader adapter for ACP: fronts the real (main) loader while
 * keeping `getExtensions()` pointed at the LIVE extension set, and publishes
 * skills through a per-session discovery snapshot that skill refreshes
 * recompute WITHOUT reloading the main loader.
 *
 * Why: the ACP skill-refresh sweep used to call
 * `session.resourceLoader.reload()` + the private
 * `extendResourcesFromExtensions` bridge to pick up skill changes. A full
 * loader reload re-runs every inline extension factory (another MCP adapter,
 * another set of subscriptions, another session-start lifecycle) just to
 * re-read a directory listing. This adapter makes a skill refresh a
 * resources-only operation: a throwaway discovery loader (noExtensions, no
 * inline factories, no additional paths) scans the same cwd/agentDir with
 * the same trusted SettingsManager, the live runner's `resources_discover`
 * results are staged into it via the public `extendResources`, and only then
 * does `getSkills()` switch to the new snapshot.
 *
 * The append-system-prompt content is also served from this adapter (built
 * per call from the CURRENT skills with a per-adapter cache): the base
 * loader caches its append prompt at reload time, so cache invalidation
 * alone would leave the model reading a stale skill list until the next
 * full reload.
 */
export class AcpSessionResourceLoader implements ResourceLoader {
	private readonly mainLoader: DefaultResourceLoader
	private readonly discoveryCwd: string
	private readonly discoveryAgentDir: string
	private readonly discoverySettingsManager: SettingsManager
	private readonly baseAppend: () => string[]
	/**
	 * Committed skills snapshot — served by `getSkills()` once set. Undefined
	 * until the first refresh: the main loader's own skills (base scan +
	 * startup resources_discover) are the initial truth.
	 */
	private skillsSnapshot: { skills: Skill[]; diagnostics: ResourceDiagnostic[] } | undefined
	/** Discovery loader receiving extension-contributed paths during a refresh. */
	private staged: DefaultResourceLoader | undefined
	/** Serializes refreshes: each runs a full rescan after the previous one. */
	private refreshChain: Promise<void> = Promise.resolve()

	constructor(options: {
		mainLoader: DefaultResourceLoader
		cwd: string
		agentDir: string
		settingsManager: SettingsManager
		/** ACP append base (CLI flag + `_meta["kimchi.dev"].appendSystemPrompt`). */
		baseAppend: () => string[]
	}) {
		this.mainLoader = options.mainLoader
		this.discoveryCwd = options.cwd
		this.discoveryAgentDir = options.agentDir
		this.discoverySettingsManager = options.settingsManager
		this.baseAppend = options.baseAppend
	}

	getExtensions() {
		return this.mainLoader.getExtensions()
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return this.skillsSnapshot ?? this.mainLoader.getSkills()
	}

	getPrompts() {
		return this.mainLoader.getPrompts()
	}

	getThemes() {
		return this.mainLoader.getThemes()
	}

	getAgentsFiles() {
		return this.mainLoader.getAgentsFiles()
	}

	getSystemPrompt() {
		return this.mainLoader.getSystemPrompt()
	}

	getSystemPromptSource() {
		return this.mainLoader.getSystemPromptSource()
	}

	/**
	 * ACP append content, computed per call: the configured base plus the
	 * skill-list block built from THIS adapter's current skills. The
	 * per-adapter cache (WeakMap) is invalidated by the refresh sweep, so a
	 * committed snapshot is reflected on the next prompt rebuild without a
	 * main-loader reload.
	 */
	getAppendSystemPrompt(): string[] {
		let block = cachedSkillListBlock(this)
		if (block === undefined) {
			try {
				block = buildSkillListBlock(this)
			} catch {
				// The block is non-essential; an empty one must not break the session.
				block = ""
			}
			setCachedSkillListBlock(this, block)
		}
		return [...this.baseAppend(), ...(block ? [block] : [])]
	}

	getAppendSystemPromptSources() {
		return this.mainLoader.getAppendSystemPromptSources()
	}

	extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
		this.mainLoader.extendResources(paths)
		// During a refresh, extension-contributed paths are staged into the
		// discovery loader too, so the committed snapshot includes them.
		this.staged?.extendResources(paths)
	}

	async reload(options?: LoaderReloadOptions): Promise<void> {
		await this.mainLoader.reload(options)
		// An intentional full reload re-binds the extension set: reset the
		// discovery snapshot so the newly bound set's resources (applied by
		// the reload's own resources_discover pass) are exposed normally.
		this.skillsSnapshot = undefined
	}

	/**
	 * Refresh skills without touching the live extension set. Builds a
	 * resources-only discovery loader, scans base sources (bundled,
	 * configured, project, Claude — same cwd, agent dir, and trusted settings
	 * as the session), stages the live runner's `resources_discover` results
	 * into it, and commits the new snapshot only after discovery succeeded —
	 * a failure keeps the previous snapshot (and the advertised palette).
	 *
	 * Refreshes are serialized per adapter; concurrent callers each get a
	 * full rescan in order.
	 */
	refreshSkills(session: AgentSession): Promise<void> {
		const run = this.refreshChain.then(() => this.doRefreshSkills(session))
		// Keep the chain alive across failures so a later refresh is not
		// permanently wedged behind a rejected predecessor.
		this.refreshChain = run.catch(() => {})
		return run
	}

	private async doRefreshSkills(session: AgentSession): Promise<void> {
		const discovery = new DefaultResourceLoader({
			cwd: this.discoveryCwd,
			agentDir: this.discoveryAgentDir,
			settingsManager: this.discoverySettingsManager,
			// Resources-only: no extension loading, no inline factories, no
			// additional extension paths — the live set stays on the main loader.
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		})
		this.staged = discovery
		try {
			await discovery.reload()
			// Re-run resources_discover on the existing runner so extension-
			// contributed skill sources remain present. The bridge forwards
			// the discovered paths through session.resourceLoader — THIS
			// adapter — so they land on both the main loader and the staged
			// discovery loader (see extendResources).
			await runResourcesDiscover(session)
			// Commit only after discovery succeeded (a throw above leaves the
			// previous snapshot and palette in place).
			this.skillsSnapshot = discovery.getSkills()
		} finally {
			this.staged = undefined
		}
	}
}

/**
 * Runs the upstream resources_discover pass against the session's live
 * extension runner and forwards the contributed paths through
 * `session.resourceLoader.extendResources(...)` — the same step
 * `bindExtensions()` runs after session_start (upstream:
 * packages/coding-agent/src/core/agent-session.ts). This is the ONE place the
 * ACP surface reaches into the private AgentSession method; the check fails
 * loudly if upstream renames it. Drop the cast once a public refresh API
 * exists.
 */
export async function runResourcesDiscover(session: AgentSession): Promise<void> {
	const refreshable = session as unknown as Record<string, unknown>
	if (typeof refreshable.extendResourcesFromExtensions !== "function") {
		throw new TypeError("AgentSession.extendResourcesFromExtensions missing (upstream pi rename?)")
	}
	await (refreshable.extendResourcesFromExtensions as (reason: "reload") => Promise<void>).call(session, "reload")
}
