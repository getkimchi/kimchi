// Declared artifacts that actually emitted during the current prompt. ACP
// owns emission; the recorder needs the same fact to decide whether a file
// deleted before settlement still belongs in its replay row.

const emittedDeclaredPaths = new WeakMap<object, Set<string>>()

export function markDeclaredArtifactsEmitted(scope: object, paths: readonly string[]): void {
	if (paths.length === 0) return
	let emitted = emittedDeclaredPaths.get(scope)
	if (!emitted) {
		emitted = new Set()
		emittedDeclaredPaths.set(scope, emitted)
	}
	for (const path of paths) emitted.add(path)
}

export function wasDeclaredArtifactEmitted(scope: object, path: string): boolean {
	return emittedDeclaredPaths.get(scope)?.has(path) === true
}

export function clearDeclaredArtifactEmissions(scope: object): void {
	emittedDeclaredPaths.delete(scope)
}
