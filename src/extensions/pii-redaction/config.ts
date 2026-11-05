/**
 * Redaction configuration reader.
 *
 * Enablement is governed by the resources system: the org policy's
 * kimchiResources entry (ON/OFF soft defaults, FORCE_ON/FORCE_OFF locks),
 * the user's persistent /resources override, the transient
 * KIMCHI_ENABLE_RESOURCES env, and the definition default (off).
 *
 * Entity exclusions are governed locally by the `redaction` block of the
 * same settings.json the resources system reads:
 *
 *   { "redaction": { "excludedEntities": ["DATE_TIME", "PHONE_NUMBER"] } }
 *
 * A present `excludedEntities` array REPLACES the tier-registry default
 * wholesale; an absent key keeps the registry default byte-for-byte.
 * Unknown entity names throw (fail-visible — the same convention as a
 * malformed settings.json). Consumers split by failure policy: the strict
 * export path lets the throw propagate (fail closed — no transcript is
 * published under a policy nobody wrote down), while the redactor's
 * snapshot resolution degrades to the registry defaults with one loud log
 * so a settings typo can never silently switch the live pipeline's
 * redaction off. When the platform later carries the list via managed
 * settings, it takes precedence above the local key (managed → local →
 * registry default); see `.kimchi/plans/redaction-precision.md` for the
 * compatibility contract.
 *
 * Reads go through the stat-gated JSON cache shared with the resources
 * store, so per-event consultation is cheap and mid-session edits are
 * picked up without a restart (the redactor engine rebuilds when the
 * resolved exclusion list changes). With an org FORCE_* lock in force the
 * settings file is not read at all — a locked deployment cannot be broken
 * by a corrupt local file, and exclusions stay at the registry default.
 *
 * The module is a thin seam by design: it is the one place that names the
 * redaction gate for consumers outside this extension's hooks
 * (work-attribution/semantic.ts, ferment-v2/evaluator.ts), and the single
 * mock point for their tests.
 */

import { readJsonCached } from "../../config/json.js"
import { getResourceSettingsPath, isResourceEnabled, isResourceLocked } from "../../resources/store.js"
import { getDefaultExcludedEntities, isKnownEntity } from "./entity-tiers.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"

export interface RedactionConfig {
	/** Whether PII/secret redaction is active. */
	enabled: boolean
	/**
	 * Entity types excluded at engine level: local settings.json
	 * `redaction.excludedEntities` when present, else the tier-registry
	 * default.
	 */
	excludedEntities: string[]
	/**
	 * The raw user-supplied exclusion list ([] when the settings key is
	 * absent). Engine entities are excluded by resolved `excludedEntities`,
	 * but kimchi-owned custom patterns must only honor what the user
	 * explicitly wrote: the registry default excludes anchor-required
	 * entities precisely so their anchored custom re-additions can fire —
	 * letting defaults also filter customs would delete the anchored
	 * coverage (e.g. no AWS-secret redaction at all).
	 */
	userExcludedEntities: string[]
}

/**
 * Non-throwing enablement gate for the extension hooks. The hooks need only
 * `enabled`, which never depends on the `redaction` settings block whose
 * validation can throw — a typo'd exclusion list must not turn the gate
 * into a rejection the extension runner discards (that would store and send
 * unredacted content with only a per-event log). Exclusion degrade
 * semantics live in the redactor's snapshot resolution; a fully malformed
 * settings.json still fails visibly per the readJson convention.
 */
export function isRedactionEnabled(): boolean {
	return isResourceEnabled(PII_REDACTION_RESOURCE_ID)
}

/** Read the current config: resources-system enablement + local exclusion list. */
export function getRedactionConfig(): RedactionConfig {
	// Lock short-circuit mirrors the resources store: under FORCE_* the
	// settings file is never opened.
	if (isResourceLocked(PII_REDACTION_RESOURCE_ID)) {
		return {
			enabled: isResourceEnabled(PII_REDACTION_RESOURCE_ID),
			excludedEntities: getDefaultExcludedEntities(),
			userExcludedEntities: [],
		}
	}
	const user = readExcludedEntitiesSetting()
	return {
		enabled: isResourceEnabled(PII_REDACTION_RESOURCE_ID),
		excludedEntities: user ?? getDefaultExcludedEntities(),
		userExcludedEntities: user ?? [],
	}
}

/**
 * Read + validate settings.json `redaction.excludedEntities`. Returns
 * undefined when the key is absent (defaults apply). Malformed JSON
 * propagates through readJsonCached (fail-visible); unknown entity names
 * throw for the same reason — either way the operator learns their
 * settings file is wrong instead of running with silently different
 * redaction behavior than they wrote down.
 */
function readExcludedEntitiesSetting(): string[] | undefined {
	const settings = readJsonCached(getResourceSettingsPath())
	const redaction = settings.redaction
	if (redaction === undefined) return undefined
	if (redaction === null || typeof redaction !== "object" || Array.isArray(redaction)) {
		throw new Error('settings.json "redaction" must be an object')
	}
	const raw = (redaction as Record<string, unknown>).excludedEntities
	if (raw === undefined) return undefined
	if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
		throw new Error('settings.json "redaction.excludedEntities" must be an array of strings')
	}
	for (const name of raw as string[]) {
		if (!isKnownEntity(name)) {
			throw new Error(`settings.json "redaction.excludedEntities": unknown entity "${name}"`)
		}
	}
	return raw as string[]
}
