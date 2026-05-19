/**
 * Compare two `MAJOR.MINOR.PATCH` strings. Returns true iff `a >= b`. We
 * keep this inline rather than pulling the `semver` package because the only
 * comparison we need is simple version gates.
 *
 * Inputs that aren't strict three-part numerics return false — same effect
 * as Go's `semver.NewVersion(version)` returning err on unparseable strings.
 */
export function compareSemverGte(a: string | null, b: string): boolean {
	if (!a) return false
	const parts = (s: string): [number, number, number] | null => {
		const m = s.match(/^(\d+)\.(\d+)\.(\d+)/)
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
	}
	const av = parts(a)
	const bv = parts(b)
	if (!av || !bv) return false
	for (let i = 0; i < 3; i++) {
		if (av[i] > bv[i]) return true
		if (av[i] < bv[i]) return false
	}
	return true
}
