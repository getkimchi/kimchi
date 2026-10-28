import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent"

/** Upstream loader options, derived from the constructor's parameter so it cannot drift from the pinned pi-coding-agent version. */
type UpstreamLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

/**
 * Options for {@link SubagentResourceLoader}: normal upstream loader options
 * plus the required live prompt source.
 */
export interface SubagentResourceLoaderOptions extends UpstreamLoaderOptions {
	/**
	 * Supplies the subagent system prompt. Invoked on every
	 * `getSystemPrompt()` call, so the value read is always current — unlike
	 * `systemPromptOverride`, which upstream only evaluates inside `reload()`.
	 */
	readSystemPrompt: () => string
}

/**
 * A `DefaultResourceLoader` whose system prompt is read live from a callback
 * instead of the snapshot cached at `reload()` time.
 *
 * Why this exists: the subagent runner only learns the final active-tool list
 * after the session is created and bound, and `AgentSession` re-reads
 * `resourceLoader.getSystemPrompt()` whenever the tool loadout changes
 * (`setActiveToolsByName` → `_rebuildSystemPrompt`). Upstream's only hook for
 * a custom prompt, `systemPromptOverride`, is evaluated inside `reload()` — so
 * the runner used to reload the loader a second time after binding. That
 * reload re-runs every inline extension factory against the loader's shared
 * event bus, constructing orphaned duplicate extension copies whose bus
 * subscriptions survive (they are never dispatched, but they still hear every
 * channel event → duplicated telemetry).
 *
 * This adapter keeps upstream session creation, tool activation, and extension
 * dispatch untouched: each extension factory runs once (at the single initial
 * `reload()`), and prompt re-evaluation happens through the public
 * `getSystemPrompt()` path.
 */
export class SubagentResourceLoader extends DefaultResourceLoader {
	private readonly readSystemPrompt: () => string

	constructor(options: SubagentResourceLoaderOptions) {
		const { readSystemPrompt, ...loaderOptions } = options
		// No `systemPromptOverride` is forwarded: the getter below is the sole
		// source of the subagent prompt, so the value `reload()` caches in
		// `this.systemPrompt` stays unused on this path.
		super(loaderOptions)
		this.readSystemPrompt = readSystemPrompt
	}

	override getSystemPrompt(): string {
		return this.readSystemPrompt()
	}
}
