import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "./store.js"

export interface ManagedExtensionFactory {
	id: string
	factory: ExtensionFactory
}

export function enabledExtensionFactories(factories: readonly ManagedExtensionFactory[]): ExtensionFactory[] {
	return factories.filter(({ id }) => isResourceEnabled(id)).map(({ factory }) => factory)
}
