// tui-test treats each filter as a regex over the absolute test file path, so a
// bare stem like "side-chat" also matches "side-chat-permission-ask.test.ts" and
// runs that file a second time. This filter matches one file only.
//
// tui-test doubles every backslash before it builds the RegExp, so the pattern
// must not use backslash escapes: "[.]" stands for a literal dot, and the
// leading class stands for the path separator on any platform.
export function exactFileFilter(stem) {
	const literal = stem.replace(/[^A-Za-z0-9_-]/g, (char) => `[${char}]`)
	return `[^A-Za-z0-9_-]${literal}[.]test[.]ts$`
}
