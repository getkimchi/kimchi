/**
 * Patches @clack/core and @clack/prompts to support "locked" options:
 * disabled options that are checked by default and cannot be toggled,
 * rendered with a green checkmark and gray text (no strikethrough).
 *
 * Run this script before `pnpm run build:binary` after `pnpm install`.
 */
import { readFileSync, writeFileSync } from "node:fs"

const CORE = "node_modules/.pnpm/@clack+core@1.3.0/node_modules/@clack/core/dist/index.mjs"
const PROMPTS = "node_modules/.pnpm/@clack+prompts@1.3.0/node_modules/@clack/prompts/dist/index.mjs"

let core = readFileSync(CORE, "utf-8")
let prompts = readFileSync(PROMPTS, "utf-8")

function verify(name, before, after) {
	if (before === after) {
		throw new Error(`Patch failed: "${name}" did not match. The minified clack output may have changed — review the patch script.`)
	}
}

/* ── @clack/core: allow cursor navigation to disabled options ── */

// findCursor — remove disabled-skip logic
const beforeFindCursor = core
core = core.replace(
	"function d(r,t,s){if(!s.some(o=>!o.disabled))return r;const e=r+t,i=Math.max(s.length-1,0),n=e<0?i:e>i?0:e;return s[n].disabled?d(n,t<0?-1:1,s):n}",
	"function d(r,t,s){const e=r+t,i=Math.max(s.length-1,0),n=e<0?i:e>i?0:e;return n}"
)
verify("findCursor", beforeFindCursor, core)

// MultiSelectPrompt initial cursor — don't skip disabled on init
const beforeInitCursor = core
core = core.replace(
	"this.cursor=this.options[s].disabled?d(s,1,this.options):s",
	"this.cursor=s"
)
verify("initCursor", beforeInitCursor, core)

// MultiSelectPrompt cursor events — simple wrap without disabled skip
const beforeNavCursor = core
core = core.replace(
	'case"left":case"up":this.cursor=d(this.cursor,-1,this.options);break;case"down":case"right":this.cursor=d(this.cursor,1,this.options);break;',
	'case"left":case"up":{const n=this.cursor-1,o=this.options.length-1;this.cursor=n<0?o:n>o?0:n;break;}case"down":case"right":{const n=this.cursor+1,o=this.options.length-1;this.cursor=n<0?o:n>o?0:n;break;}'
)
verify("navCursor", beforeNavCursor, core)

// toggleValue — skip disabled options
const beforeToggleValue = core
core = core.replace(
	'toggleValue(){this.value===void 0&&(this.value=[]);const t=this.value.includes(this._value);this.value=t?this.value.filter(s=>s!==this._value):[...this.value,this._value]}',
	'toggleValue(){if(this.options[this.cursor]?.disabled)return;this.value===void 0&&(this.value=[]);const t=this.value.includes(this._value);this.value=t?this.value.filter(s=>s!==this._value):[...this.value,this._value]}'
)
verify("toggleValue", beforeToggleValue, core)

// toggleAll — preserve locked (disabled+selected) values
const beforeToggleAll = core
core = core.replace(
	'toggleAll(){const t=this._enabledOptions,s=this.value!==void 0&&this.value.length===t.length;this.value=s?[]:t.map(e=>e.value)}',
	'toggleAll(){const t=this._enabledOptions,s=this.value!==void 0&&this.value.length===t.length;const l=this.options.filter(o=>o.disabled&&this.value?.includes(o.value)).map(o=>o.value);this.value=s?[...l]:[...t.map(e=>e.value),...l]}'
)
verify("toggleAll", beforeToggleAll, core)

// toggleInvert — preserve locked (disabled+selected) values
const beforeToggleInvert = core
core = core.replace(
	'toggleInvert(){const t=this.value;if(!t)return;const s=this._enabledOptions.filter(e=>!t.includes(e.value));this.value=s.map(e=>e.value)}',
	'toggleInvert(){const t=this.value;if(!t)return;const s=this._enabledOptions.filter(e=>!t.includes(e.value)),l=this.options.filter(o=>o.disabled&&this.value?.includes(o.value)).map(o=>o.value);this.value=[...s.map(e=>e.value),...l]}'
)
verify("toggleInvert", beforeToggleInvert, core)

/* ── @clack/prompts: render disabled+selected with green checkmark ── */

const beforePrompts = prompts
prompts = prompts.replace(
	'c=(a,l)=>{if(a.disabled)return r(a,"disabled");const d=o.includes(a.value);return l&&d?r(a,"active-selected"):d?r(a,"selected"):r(a,l?"active":"inactive")};',
	'c=(a,l)=>{if(a.disabled){const d=o.includes(a.value);return d?`${e("green",U)} ${Q(a.label??String(a.value),o=>e("gray",o))}${a.hint?` ${e("dim",`(${a.hint})`)}`:""}`:r(a,"disabled")}const d=o.includes(a.value);return l&&d?r(a,"active-selected"):d?r(a,"selected"):r(a,l?"active":"inactive")};'
)
verify("styleOption", beforePrompts, prompts)

writeFileSync(CORE, core)
writeFileSync(PROMPTS, prompts)

console.log("✅ Patched @clack/core and @clack/prompts for locked options")
