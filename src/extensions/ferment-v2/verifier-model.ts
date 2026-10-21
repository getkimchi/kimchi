import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { findModelByRef, refFromModel } from "../model-catalog/ref-utils.js"

/**
 * The model the Ferment V2 evaluator (and, later, the executing verifier) runs
 * on, chosen from the ordered `fermentV2.evaluatorModels` setting.
 */
export interface FermentV2VerifierModelChoice {
	model: Model<Api>
	/** Canonical `provider/id` of the chosen model. */
	ref: string
	/** True when the chosen model is canonically the implementer's session model. */
	sameAsImplementer: boolean
	/** Set when no configured model was usable and the session model was used instead. */
	fallback?: "session"
	/** Configured refs skipped because they did not resolve or failed auth, in configured order. */
	unusableRefs?: readonly string[]
}

/**
 * Resolve the Ferment V2 evaluator model from an ordered list of model refs.
 *
 * A ref is usable when it resolves in the model registry (`findModelByRef`) and
 * the registry can authenticate it (`getApiKeyAndHeaders(model).ok`). The
 * implementer is the session model (`ctx.model`); models are compared by
 * canonical `provider/id` of the resolved models, so alias-shaped refs of the
 * implementer are recognized too.
 *
 * Selection: the first usable entry that is not the implementer; if every usable
 * entry is the implementer, the first usable one; if none is usable, the session
 * model with `fallback: "session"`. Refs that do not resolve or fail the auth
 * check are skipped and reported as `unusableRefs`. Returns `undefined` only
 * when there is no usable configured model and no session model to fall back
 * to.
 *
 * This applies in single- and multi-model mode alike; `modelRoles.judge` is a
 * Ferment V1 concept only.
 */
export async function resolveFermentV2VerifierModel(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	refs: readonly string[],
): Promise<FermentV2VerifierModelChoice | undefined> {
	const implementerRef = ctx.model ? refFromModel(ctx.model) : undefined
	const usable: Model<Api>[] = []
	const unusable: string[] = []
	for (const ref of refs) {
		const model = findModelByRef(ctx.modelRegistry, ref)
		if (!model) {
			unusable.push(ref)
			continue
		}
		if (!(await modelHasAuth(ctx.modelRegistry, model))) {
			unusable.push(ref)
			continue
		}
		usable.push(model)
	}
	if (usable.length > 0) {
		const chosen =
			(implementerRef === undefined ? undefined : usable.find((model) => refFromModel(model) !== implementerRef)) ??
			usable[0]
		return {
			model: chosen,
			ref: refFromModel(chosen),
			sameAsImplementer: implementerRef !== undefined && refFromModel(chosen) === implementerRef,
			...(unusable.length ? { unusableRefs: unusable } : {}),
		}
	}
	if (!ctx.model) return undefined
	return {
		model: ctx.model,
		ref: refFromModel(ctx.model),
		sameAsImplementer: true,
		fallback: "session",
		...(unusable.length ? { unusableRefs: unusable } : {}),
	}
}

async function modelHasAuth(modelRegistry: ModelRegistry, model: Model<Api>): Promise<boolean> {
	try {
		return (await modelRegistry.getApiKeyAndHeaders(model)).ok
	} catch {
		return false
	}
}

/**
 * Cause-and-fix text for the one-time-per-ferment warning that the evaluator
 * runs on the implementer's own model. The cause names why the selection
 * collapsed ("only one model configured", "every configured model is the
 * implementer's model", or "no usable independent model is available" when the
 * configured non-implementer refs did not resolve or authenticate) or why the
 * session model was used instead ("no configured model available").
 */
export function formatFermentV2EvaluatorModelWarning(input: {
	ref: string | undefined
	sameAsImplementer?: boolean
	modelFallback?: "session"
	configuredRefs: readonly string[]
	unusableRefs?: readonly string[]
}): string {
	const ref = input.ref ?? "session model"
	if (input.modelFallback === "session") {
		return `Ferment V2 evaluator fell back to the session model (${ref}): no configured model available. Fix: set fermentV2.evaluatorModels in settings.json to an ordered list of models you can use.`
	}
	if (input.unusableRefs?.length) {
		const unusable = input.unusableRefs.join(", ")
		return `Ferment V2 evaluator uses the same model as the implementer (${ref}): no usable independent model is available (${unusable} could not be resolved or authenticated). Fix: check the ref and authentication of the unusable models in the fermentV2.evaluatorModels list in settings.json so verification is model-diverse.`
	}
	const cause =
		input.configuredRefs.length <= 1 ? "only one model configured" : "every configured model is the implementer's model"
	return `Ferment V2 evaluator uses the same model as the implementer (${ref}): ${cause}. Fix: add a different model to the fermentV2.evaluatorModels list in settings.json so verification is model-diverse.`
}
