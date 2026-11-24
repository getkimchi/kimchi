import { resolve } from "node:path"
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent"

/**
 * Non-ACP contribution of `--additionalSkillsPaths` roots.
 *
 * Upstream pi's `main()` has no `additionalSkillPaths` parameter (only
 * `DefaultResourceLoader` does), so non-ACP modes surface the roots through
 * the established inline `resources_discover` mechanism instead. ACP does not
 * load this factory: its loaders receive the roots directly through
 * `RunAcpOptions.additionalSkillPaths`.
 *
 * The factory MUST be registered ahead of every other skill-contributing
 * inline factory. The upstream loader scans settings/native
 * `additionalSkillPaths` paths first and then appends extension
 * `resources_discover` contributions in factory registration order
 * (first-named-skill-wins on collisions), so a prepended registration gives
 * the additional roots exactly the collision precedence ACP's native
 * `additionalSkillPaths` have: after base/settings, before repository
 * contributions. Tail-appending would reverse that precedence, and
 * rewriting the flag to upstream `--skill` would take `--skill`'s separate
 * first-slot merge order instead.
 */
export function createAdditionalSkillRootsExtension(getRoots: () => string[]): InlineExtension {
	const factory = (pi: ExtensionAPI): void => {
		pi.on("resources_discover", (event) => {
			// Roots are read at emit time so a later discovery pass always sees
			// the current getter answer, not a startup snapshot.
			const skillPaths: string[] = []
			const seen = new Set<string>()
			for (const root of getRoots()) {
				if (root === "") continue
				// Relative roots resolve against the discovery event's cwd (the
				// session working directory); absolute roots stay absolute.
				const resolved = resolve(event.cwd, root)
				if (seen.has(resolved)) continue
				seen.add(resolved)
				skillPaths.push(resolved)
			}
			if (skillPaths.length === 0) return undefined
			return { skillPaths }
		})
	}
	return { name: "additional-skill-roots", factory }
}
