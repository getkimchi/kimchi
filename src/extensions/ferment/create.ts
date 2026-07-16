import type { Ferment } from "../../ferment/types.js"
import type { FermentRuntime } from "./runtime.js"
import { continuationPolicyForNewFerment } from "./state.js"

export interface CreateFermentOptions {
	name: string
	goal: string
	hasUI: boolean
	isOneShot: boolean
}

/** Create a ferment and initialize the policy that belongs to that ferment. */
export function createFerment(runtime: FermentRuntime, options: CreateFermentOptions): Ferment {
	const ferment = runtime.getStorage().create(options.name, options.goal)
	runtime.setContinuationPolicy(continuationPolicyForNewFerment(options.hasUI, options.isOneShot))
	return ferment
}
