export type PromptUi = {
	select?: (title: string, options: string[]) => Promise<string | undefined>
	input?: (title: string, placeholder?: string) => Promise<string | undefined>
	setWorkingVisible?: (visible: boolean) => void
}

export function getPromptUi(ctx: unknown): PromptUi | undefined {
	return (ctx as { ui?: PromptUi } | undefined)?.ui
}

export async function withWorkingHidden<T>(ui: PromptUi, fn: () => Promise<T>): Promise<T> {
	ui.setWorkingVisible?.(false)
	try {
		return await fn()
	} finally {
		ui.setWorkingVisible?.(true)
	}
}

export function promptSelect(ctx: unknown, title: string, options: string[]): Promise<string | undefined> {
	const ui = getPromptUi(ctx)
	if (!ui?.select) return Promise.resolve(undefined)
	return withWorkingHidden(ui, () => ui.select?.(title, options) ?? Promise.resolve(undefined))
}

export function promptInput(ctx: unknown, title: string, placeholder?: string): Promise<string | undefined> {
	const ui = getPromptUi(ctx)
	if (!ui?.input) return Promise.resolve(undefined)
	return withWorkingHidden(ui, () => ui.input?.(title, placeholder) ?? Promise.resolve(undefined))
}
