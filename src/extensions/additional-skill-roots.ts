import { resolve } from "node:path"
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent"

/**
 * Non-ACP contribution of `--additional-skill-paths` roots: upstream pi's
 * main() has no additionalSkillPaths parameter, so the roots ride the inline
 * resources_discover mechanism. ACP does not load this factory — its loaders
 * receive the roots directly through RunAcpOptions.additionalSkillPaths.
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
