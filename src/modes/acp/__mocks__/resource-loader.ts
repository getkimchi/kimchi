import type { ResourceLoader } from "@earendil-works/pi-coding-agent"

// Shared fake ResourceLoader for ACP palette tests: a fixed skill list plus
// reload/refresh hooks so refresh tests can observe/count rescans. The
// refresh sweep calls refreshSkills (the ACP adapter's resources-only
// discovery), NOT loader.reload() — see session-resource-loader.ts.
export function makeResourceLoader(opts: {
	skills?: Array<{ name: string; description?: string; filePath: string }>
	onReload?: () => void | Promise<void>
	onRefreshSkills?: (session: unknown) => void | Promise<void>
}): ResourceLoader {
	const skills = opts.skills ?? []
	return {
		getSkills: () => ({ skills, diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: undefined }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		refreshSkills: async (session: unknown) => {
			await opts.onRefreshSkills?.(session)
		},
		reload: async () => {
			await opts.onReload?.()
		},
	} as unknown as ResourceLoader
}
