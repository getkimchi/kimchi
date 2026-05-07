import { createCliRuntime } from "./cli.js"
import type { ContainerRuntime, SpawnFn } from "./types.js"

export interface SelectRuntimeDeps {
	spawn?: SpawnFn
}

export function selectRuntime(name: string, deps?: SelectRuntimeDeps): ContainerRuntime {
	const normalized = name.toLowerCase()

	switch (normalized) {
		case "docker":
			return createCliRuntime({ binary: "docker", spawn: deps?.spawn })
		case "orbstack":
			return createCliRuntime({ binary: "orbstack", spawn: deps?.spawn })
		case "podman":
			return createCliRuntime({ binary: "podman", spawn: deps?.spawn })
		default:
			throw new Error(`Unknown runtime: ${name}`)
	}
}
