/**
 * Compatibility assertions for pi upstream internals we monkey-patch at runtime.
 *
 * These tests import the actual installed pi package and assert that every
 * field/method our patches depend on exists with the expected shape. A failure
 * here means a pi upgrade broke one of our patches before it manifests as a
 * silent runtime degradation.
 *
 * Run via: pnpm test (vitest run --dir src)
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent"
import { Container } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it } from "vitest"

// ToolExecutionComponent and UserMessageComponent constructors access the theme
// singleton at construction time. Initialise it once with the default theme so
// tests can instantiate these classes without a "Theme not initialized" error.
beforeAll(() => {
	initTheme("default")
})

// ---------------------------------------------------------------------------
// AssistantMessageComponent — depended on by:
//   src/extensions/assistant-prefix.ts
//   src/extensions/thinking-steps/internal-patch.ts
// ---------------------------------------------------------------------------

describe("AssistantMessageComponent prototype compatibility", () => {
	const proto = AssistantMessageComponent.prototype as unknown as Record<string, unknown>

	it("exports a class (function)", () => {
		expect(typeof AssistantMessageComponent).toBe("function")
	})

	it("has prototype.updateContent as a function", () => {
		expect(typeof proto.updateContent).toBe("function")
	})

	it("has prototype.setHideThinkingBlock as a function", () => {
		expect(typeof proto.setHideThinkingBlock).toBe("function")
	})

	it("has prototype.setHiddenThinkingLabel as a function", () => {
		expect(typeof proto.setHiddenThinkingLabel).toBe("function")
	})

	it("instance has contentContainer with clear() and addChild()", () => {
		const instance = new AssistantMessageComponent(undefined as any, false)
		const container = (instance as any).contentContainer
		expect(container).toBeDefined()
		expect(typeof container.clear).toBe("function")
		expect(typeof container.addChild).toBe("function")
	})

	it("instance has hideThinkingBlock field", () => {
		const instance = new AssistantMessageComponent(undefined as any)
		expect("hideThinkingBlock" in instance).toBe(true)
	})

	it("instance has markdownTheme field", () => {
		const instance = new AssistantMessageComponent(undefined as any)
		expect("markdownTheme" in instance).toBe(true)
	})

	it("instance has hiddenThinkingLabel field", () => {
		const instance = new AssistantMessageComponent(undefined as any)
		expect("hiddenThinkingLabel" in instance).toBe(true)
	})

	it("contentContainer.children is an array", () => {
		const instance = new AssistantMessageComponent(undefined as any)
		const container = (instance as any).contentContainer
		expect(Array.isArray(container.children)).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// UserMessageComponent — depended on by:
//   src/extensions/tool-rendering.ts  (patchUserMessageRender)
// ---------------------------------------------------------------------------

describe("UserMessageComponent prototype compatibility", () => {
	const proto = UserMessageComponent.prototype as unknown as Record<string, unknown>

	it("exports a class (function)", () => {
		expect(typeof UserMessageComponent).toBe("function")
	})

	it("has prototype.render as a function", () => {
		expect(typeof proto.render).toBe("function")
	})

	it("instance has contentBox field", () => {
		const instance = new UserMessageComponent("test")
		expect((instance as any).contentBox).toBeDefined()
	})

	it("contentBox has paddingX as a number", () => {
		const instance = new UserMessageComponent("test")
		const box = (instance as any).contentBox
		expect(typeof box.paddingX).toBe("number")
	})

	it("render() returns a non-empty string array", () => {
		const instance = new UserMessageComponent("hello")
		const lines = instance.render(80)
		expect(Array.isArray(lines)).toBe(true)
		expect(lines.length).toBeGreaterThan(0)
		expect(typeof lines[0]).toBe("string")
	})
})

// ---------------------------------------------------------------------------
// ToolExecutionComponent — depended on by:
//   src/extensions/tool-rendering.ts  (patchToolExecutionRenderers,
//                                       patchToolRenderCacheInvalidation,
//                                       patchReadImageExpansion)
// ---------------------------------------------------------------------------

describe("ToolExecutionComponent prototype compatibility", () => {
	const proto = ToolExecutionComponent.prototype as unknown as Record<string, unknown>

	it("exports a class (function)", () => {
		expect(typeof ToolExecutionComponent).toBe("function")
	})

	it("has prototype.hasRendererDefinition as a function", () => {
		expect(typeof proto.hasRendererDefinition).toBe("function")
	})

	it("has prototype.getCallRenderer as a function", () => {
		expect(typeof proto.getCallRenderer).toBe("function")
	})

	it("has prototype.getResultRenderer as a function", () => {
		expect(typeof proto.getResultRenderer).toBe("function")
	})

	it("has prototype.updateDisplay as a function", () => {
		expect(typeof proto.updateDisplay).toBe("function")
	})

	const cacheInvalidationMethods = [
		"updateArgs",
		"markExecutionStarted",
		"setArgsComplete",
		"updateResult",
		"setExpanded",
		"setShowImages",
		"setImageWidthCells",
		"invalidate",
	]

	it.each(cacheInvalidationMethods)("has prototype.%s as a function (cache invalidation patch)", (method) => {
		expect(typeof proto[method]).toBe("function")
	})

	it("instance has toolName field", () => {
		const instance = new ToolExecutionComponent("bash", "call-1", {}, {}, undefined, undefined as any, process.cwd())
		expect(typeof (instance as any).toolName).toBe("string")
	})

	it("instance has imageComponents and imageSpacers arrays", () => {
		const instance = new ToolExecutionComponent("bash", "call-1", {}, {}, undefined, undefined as any, process.cwd())
		expect(Array.isArray((instance as any).imageComponents)).toBe(true)
		expect(Array.isArray((instance as any).imageSpacers)).toBe(true)
	})

	it("instance has expanded field", () => {
		const instance = new ToolExecutionComponent("bash", "call-1", {}, {}, undefined, undefined as any, process.cwd())
		expect("expanded" in instance).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// Container prototype — depended on by:
//   src/extensions/tool-rendering.ts  (patchGlobalToolBorders wraps Container.prototype.render)
// ---------------------------------------------------------------------------

describe("Container prototype compatibility (patchGlobalToolBorders)", () => {
	it("exports Container as a class (function)", () => {
		expect(typeof Container).toBe("function")
	})

	it("has prototype.render as a function", () => {
		const proto = Container.prototype as unknown as Record<string, unknown>
		expect(typeof proto.render).toBe("function")
	})

	it("render() on a bare Container returns a string array", () => {
		const c = new Container()
		const lines = c.render(40)
		expect(Array.isArray(lines)).toBe(true)
	})
})
