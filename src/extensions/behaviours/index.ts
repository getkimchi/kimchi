/**
 * Bundled-behaviours extension.
 *
 * Two delivery paths:
 * - **Baseline** behaviours are concatenated into a `## Rules` block appended
 *   to the system prompt at every turn. Always in effect, no per-call cost.
 * - **Triggered** behaviours load when their session-probe triggers fire at
 *   session start, or when their tool-call matchers fire on a tool_call event.
 *   Loaded bodies are delivered as hidden custom messages on the next agent
 *   turn, once per behaviour per session, plus once more after each
 *   compaction (which summarises the body away).
 *
 * On each tool-call event the eval engine runs first against the prior loaded
 * set, then the trigger engine evaluates tool-call triggers; this ensures the
 * call that loads a behaviour is not also scored against its own evaluators.
 *
 * Triggered loads, eval verdicts, post-compaction requeues, and a per-session
 * summary are written into the active session JSONL (`behaviour_loaded`,
 * `behaviour_eval`, `behaviour_requeued`, `behaviour_session_summary`) so
 * decisions can be audited offline.
 *
 * The wiring layer lives in `wiring.ts` so tests can import it without
 * resolving the markdown bodies pulled in by `registry.ts`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { behaviours as bundledBehaviours } from "./registry.js"
import { wireBehaviours } from "./wiring.js"

export { BEHAVIOUR_BODY_TYPE, type WireOptions, wireBehaviours } from "./wiring.js"

export default function behavioursExtension(pi: ExtensionAPI): void {
	wireBehaviours(pi, bundledBehaviours)
}
