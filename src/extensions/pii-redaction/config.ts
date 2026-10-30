/**
 * Redaction configuration reader.
 *
 * Enablement is governed by the resources system: the org policy's
 * kimchiResources entry (ON/OFF soft defaults, FORCE_ON/FORCE_OFF locks),
 * the user's persistent /resources override, the transient
 * KIMCHI_ENABLE_RESOURCES env, and the definition default (off).
 *
 * `isResourceEnabled` reads settings through a stat-gated cache, so
 * consulting it per event is cheap. No module-level state is held, keeping
 * a long-lived host (the ACP server) correct across sessions.
 *
 * The module is a thin seam by design: it is the one place that names the
 * redaction gate for consumers outside this extension's hooks
 * (work-attribution/semantic.ts, ferment-v2/evaluator.ts), and the single
 * mock point for their tests.
 */

import { isResourceEnabled } from "../../resources/store.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"

export interface RedactionConfig {
	/** Whether PII/secret redaction is active. */
	enabled: boolean
}

/** Read the current enablement from the resources system. */
export function getRedactionConfig(): RedactionConfig {
	return { enabled: isResourceEnabled(PII_REDACTION_RESOURCE_ID) }
}
