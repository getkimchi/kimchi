import type { EnvironmentGap } from "../review-submit/store.js"

/** Operational limitations imposed by the caller's sandbox. No variable values
 * (which may contain credentials in proxy URLs) are copied into review output. */
export function headlessEnvironmentGaps(env: NodeJS.ProcessEnv = process.env): EnvironmentGap[] {
	const gaps: EnvironmentGap[] = []
	if (env.GOTOOLCHAIN === "local") {
		gaps.push({
			kind: "unsupported_toolchain_download",
			name: "Go toolchain downloads",
			note: "GOTOOLCHAIN=local blocks automatic Go toolchain downloads; checks requiring another Go toolchain cannot run.",
		})
	}
	if (env.CARGO_NET_OFFLINE?.toLowerCase() === "true") {
		gaps.push({
			kind: "registry_offline",
			name: "Cargo registry access",
			note: "CARGO_NET_OFFLINE=true blocks Cargo registry access; dependencies absent from local caches cannot be fetched.",
		})
	}
	if (env.GOPROXY) {
		gaps.push({
			kind: "constrained_module_proxy",
			name: "Go module retrieval",
			note:
				env.GOPROXY === "off"
					? "GOPROXY=off blocks Go module proxy retrieval; modules absent from the local module cache cannot be downloaded."
					: "A constrained GOPROXY controls Go module sources; modules unavailable through it and allowed direct sources fail normally.",
		})
	}
	return gaps
}
