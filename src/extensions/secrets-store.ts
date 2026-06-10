const secrets = new Map<string, string>()

export function storeSecret(id: string, value: string): void {
	secrets.set(id, value)
}

export function getSecret(id: string): string | undefined {
	return secrets.get(id)
}

export function clearSecrets(): void {
	secrets.clear()
}

export function substituteSecrets(text: string): string {
	return text.replace(/\$\{kimchi_secret:([a-zA-Z0-9_-]+)\}/g, (_, id) => {
		const v = secrets.get(id)
		return v === undefined ? _ : v
	})
}
