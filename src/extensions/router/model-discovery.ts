import type { Model } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { isExperimentalFeaturesEnabled } from "../experimental.js"
import { isAutoModel } from "./constants.js"

let installed = false

function filterAuto<T extends Model<string>>(models: readonly T[]): T[] {
	return isExperimentalFeaturesEnabled() ? [...models] : models.filter((model) => !isAutoModel(model))
}

/**
 * Keep kimchi-dev/auto in Pi's full catalogue so saved sessions and defaults
 * can restore it, while removing it from discovery surfaces unless the launch
 * explicitly enables experimental features.
 */
export function installAutoModelDiscoveryAdapter(): void {
	if (installed) return
	installed = true

	const getAvailable = ModelRuntime.prototype.getAvailable
	ModelRuntime.prototype.getAvailable = async function (...args) {
		return filterAuto(await getAvailable.apply(this, args))
	}

	const getAvailableSnapshot = ModelRuntime.prototype.getAvailableSnapshot
	ModelRuntime.prototype.getAvailableSnapshot = function () {
		return filterAuto(getAvailableSnapshot.call(this))
	}
}
