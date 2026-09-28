import type { ResourceLoader } from "@earendil-works/pi-coding-agent"

// Shared fake ResourceLoader for ACP palette tests: a fixed skill list plus a
// reload hook so refresh tests can observe/count rescans.
export function makeResourceLoader(opts: {
	skills?: Array<{ name: string; description?: string; filePath: string }>
	onReload?: () => void | Promise<void>
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
		reload: async () => {
			await opts.onReload?.()
		},
	} as unknown as ResourceLoader
}
