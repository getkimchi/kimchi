import type { TipRegistry } from "./registry.js"
import type { Tip, TipCandidate, TipProvider, TipScope } from "./types.js"

interface ProviderTips {
	source: string
	tips: TipCandidate[]
}

interface ActiveTipGroup {
	scope: TipScope
	providers: ProviderTips[]
}

export class TipPresenter {
	private current: TipCandidate | undefined
	private completedTurnsVisible = 0
	private activeGroupKey: string | undefined
	private readonly nextTipIndexBySource = new Map<string, number>()

	constructor(private readonly registry: TipRegistry) {}

	getCurrentTip(): TipCandidate | undefined {
		return this.refresh(false)
	}

	onTurnEnd(): TipCandidate | undefined {
		if (this.current) this.completedTurnsVisible += 1
		return this.refresh(this.completedTurnsVisible >= 1)
	}

	clear(): void {
		this.current = undefined
		this.completedTurnsVisible = 0
		this.activeGroupKey = undefined
		this.nextTipIndexBySource.clear()
	}

	private refresh(rotate: boolean): TipCandidate | undefined {
		const group = this.getActiveGroup()
		if (!group) {
			this.current = undefined
			this.completedTurnsVisible = 0
			this.activeGroupKey = undefined
			return undefined
		}

		const groupKey = getGroupKey(group)
		const groupChanged = groupKey !== this.activeGroupKey
		if (groupChanged) {
			this.activeGroupKey = groupKey
			for (const provider of group.providers) {
				this.nextTipIndexBySource.delete(provider.source)
			}
		}

		const refreshedCurrent = !groupChanged && this.current ? findTip(group, this.current) : undefined
		if (!refreshedCurrent) {
			return this.selectNext(group, groupChanged ? undefined : this.current?.source)
		}
		this.current = refreshedCurrent

		if (rotate) {
			return this.selectNext(group, this.current?.source)
		}

		return this.current
	}

	private selectNext(group: ActiveTipGroup, afterSource?: string): TipCandidate | undefined {
		const providerIndex = afterSource ? group.providers.findIndex((provider) => provider.source === afterSource) : -1
		const nextProvider = group.providers[(providerIndex + 1) % group.providers.length]
		if (!nextProvider) {
			this.current = undefined
			this.completedTurnsVisible = 0
			return undefined
		}

		const rawTipIndex = this.nextTipIndexBySource.get(nextProvider.source) ?? 0
		const tipIndex = rawTipIndex % nextProvider.tips.length
		const nextTip = nextProvider.tips[tipIndex]
		this.nextTipIndexBySource.set(nextProvider.source, (tipIndex + 1) % nextProvider.tips.length)

		this.current = nextTip
		this.completedTurnsVisible = 0
		return nextTip
	}

	private getActiveGroup(): ActiveTipGroup | undefined {
		const contextual = this.getProviderTips("contextual")
		if (contextual.length > 0) return { scope: "contextual", providers: contextual }

		const general = this.getProviderTips("general")
		if (general.length > 0) return { scope: "general", providers: general }

		return undefined
	}

	private getProviderTips(scope: TipScope): ProviderTips[] {
		const providers: ProviderTips[] = []

		for (const provider of this.registry.getProviders()) {
			const tips = getProviderTips(provider).filter((tip) => tip.scope === scope)
			if (tips.length === 0) continue

			providers.push({
				source: provider.source,
				tips: tips.map((tip) => ({
					source: provider.source,
					id: tip.id,
					scope: tip.scope,
					message: tip.message,
				})),
			})
		}

		return providers
	}
}

function getProviderTips(provider: TipProvider): readonly Tip[] {
	try {
		return provider.getTips()
	} catch {
		return []
	}
}

function findTip(group: ActiveTipGroup, tip: TipCandidate): TipCandidate | undefined {
	if (tip.scope !== group.scope) return undefined

	const provider = group.providers.find((candidate) => candidate.source === tip.source)
	return provider?.tips.find((candidate) => candidate.id === tip.id)
}

function getGroupKey(group: ActiveTipGroup): string {
	const providers = group.providers
		.map((provider) => `${provider.source}[${provider.tips.map((tip) => tip.id).join(",")}]`)
		.join("|")
	return `${group.scope}:${providers}`
}
