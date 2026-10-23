/**
 * Bundled-behaviours extension.
 *
 * Two delivery paths:
 * - **Baseline** behaviours are concatenated into a `## Rules` block appended
 *   to the system prompt at every turn. Always in effect, no per-call cost.
 * - **Triggered** behaviours load when their session-probe triggers fire at
 *   session start, or when their tool-call matchers fire on a tool_call event.
 *   Delivery class is per behaviour (the `standing` flag on the registry
 *   source): session-triggered bodies and `standing: true` bodies render a
 *   system-prompt block that persists for the rest of the session (survives
 *   compaction); default tool-triggered bodies are steer-delivered only — once
 *   via `tool_result` in the load turn, then re-steered after every compaction
 *   (`session_compact` handler) — so a late-rendering block can never cause a
 *   one-time full-context cache invalidation.
 *
 * On each tool-call event the eval engine runs first against the prior loaded
 * set, then the trigger engine evaluates tool-call triggers; this ensures the
 * call that loads a behaviour is not also scored against its own evaluators.
 *
 * Triggered loads, eval verdicts, and a per-session summary are written into
 * the active session JSONL (`behaviour_loaded`, `behaviour_eval`,
 * `behaviour_session_summary`) so decisions can be audited offline. Steered
 * bodies persist as `behaviour` custom-message entries; re-steers carry
 * `details.reason: "compaction"`.
 *
 * The wiring layer lives in `wiring.ts` so tests can import it without
 * resolving the markdown bodies pulled in by `registry.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { behaviours as bundledBehaviours } from "./registry.js"
import { wireBehaviours } from "./wiring.js"

export { BEHAVIOUR_BODY_TYPE, type WireOptions, wireBehaviours } from "./wiring.js"

export default function behavioursExtension(pi: ExtensionAPI): void {
	wireBehaviours(pi, bundledBehaviours)
}
