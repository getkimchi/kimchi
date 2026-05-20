import type { TipRegistry } from "./registry.js"
import type { Tip, TipCandidate, TipProvider, TipProviderKind } from "./types.js"

interface ProviderTips {
	source: string
	kind: TipProviderKind
	tips: TipCandidate[]
}

interface ActiveTipGroup {
	kind: TipProviderKind
	providers: ProviderTips[]
}

export class TipPresenter {
	private current: TipCandidate | undefined
	private completedTurnsVisible = 0
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
		this.nextTipIndexBySource.clear()
	}

	private refresh(rotate: boolean): TipCandidate | undefined {
		const group = this.getActiveGroup()
		if (!group) {
			this.current = undefined
			this.completedTurnsVisible = 0
			return undefined
		}

		const refreshedCurrent = this.current ? findTip(group, this.current) : undefined
		if (!refreshedCurrent) {
			return this.selectNext(group, this.current?.source)
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
		if (contextual.length > 0) return { kind: "contextual", providers: contextual }

		const general = this.getProviderTips("general")
		if (general.length > 0) return { kind: "general", providers: general }

		return undefined
	}

	private getProviderTips(kind: TipProviderKind): ProviderTips[] {
		const providers: ProviderTips[] = []

		for (const provider of this.registry.getProviders(kind)) {
			const tips = getProviderTips(provider)
			if (tips.length === 0) continue

			providers.push({
				source: provider.source,
				kind: provider.kind,
				tips: tips.map((tip) => ({
					source: provider.source,
					kind: provider.kind,
					id: tip.id,
					message: tip.message,
					command: tip.command,
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
	if (tip.kind !== group.kind) return undefined

	const provider = group.providers.find((candidate) => candidate.source === tip.source)
	return provider?.tips.find((candidate) => candidate.id === tip.id)
}
