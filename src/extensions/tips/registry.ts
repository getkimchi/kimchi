import type { Tip, TipCandidate, TipProvider, TipProviderKind } from "./types.js"

interface ProviderRecord {
	owner: symbol
	provider: TipProvider
}

export class TipRegistry {
	private readonly providers = new Map<string, ProviderRecord>()

	registerProvider(provider: TipProvider): () => void {
		if (provider.source.trim().length === 0) {
			throw new Error("Tip provider source must be non-empty")
		}
		const owner = Symbol(provider.source)
		this.providers.set(provider.source, { owner, provider })

		return () => {
			const current = this.providers.get(provider.source)
			if (current?.owner === owner) this.providers.delete(provider.source)
		}
	}

	getProviders(kind?: TipProviderKind): readonly TipProvider[] {
		const providers = Array.from(this.providers.values(), (record) => record.provider)
		return kind === undefined ? providers : providers.filter((provider) => provider.kind === kind)
	}

	getEligibleTips(kind?: TipProviderKind): TipCandidate[] {
		const candidates: TipCandidate[] = []

		for (const provider of this.getProviders(kind)) {
			let tips: readonly Tip[]
			try {
				tips = provider.getTips()
			} catch {
				continue
			}

			for (const tip of tips) {
				candidates.push({
					source: provider.source,
					kind: provider.kind,
					id: tip.id,
					message: tip.message,
					command: tip.command,
				})
			}
		}

		return candidates
	}

	getFirstTip(kind: TipProviderKind = "general"): TipCandidate | undefined {
		return this.getEligibleTips(kind)[0]
	}

	clear(): void {
		this.providers.clear()
	}
}

export const globalTipRegistry = new TipRegistry()

export function registerTipProvider(provider: TipProvider): () => void {
	return globalTipRegistry.registerProvider(provider)
}
