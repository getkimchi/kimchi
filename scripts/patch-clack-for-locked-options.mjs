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

/* ── @clack/core: allow cursor navigation to disabled options ── */

// findCursor — remove disabled-skip logic
// Before: function d(r,t,s){if(!s.some(o=>!o.disabled))return r;const e=r+t,i=Math.max(s.length-1,0),n=e<0?i:e>i?0:e;return s[n].disabled?d(n,t<0?-1:1,s):n}
// After:   function d(r,t,s){const e=r+t,i=Math.max(s.length-1,0),n=e<0?i:e>i?0:e;return n}
core = core.replace(
  "function d(r,t,s){if(!s.some(o=>!o.disabled))return r;const e=r+t,i=Math.max(s.length-1,0),n=e<0?i:e>i?0:e;return s[n].disabled?d(n,t<0?-1:1,s):n}",
  "function d(r,t,s){const e=r+t,i=Math.max(s.length-1,0),n=e<0?i:e>i?0:e;return n}"
)

// MultiSelectPrompt initial cursor — don't skip disabled on init
// Before: this.cursor=this.options[s].disabled?d(s,1,this.options):s
// After:   this.cursor=s
core = core.replace(
  "this.cursor=this.options[s].disabled?d(s,1,this.options):s",
  "this.cursor=s"
)

// MultiSelectPrompt cursor events — simple wrap without disabled skip
// Before: case"left":case"up":this.cursor=d(this.cursor,-1,this.options);break;case"down":case"right":this.cursor=d(this.cursor,1,this.options);break;
// After:   inline wrap logic
core = core.replace(
  'case"left":case"up":this.cursor=d(this.cursor,-1,this.options);break;case"down":case"right":this.cursor=d(this.cursor,1,this.options);break;',
  'case"left":case"up":{const n=this.cursor-1,o=this.options.length-1;this.cursor=n<0?o:n>o?0:n;break;}case"down":case"right":{const n=this.cursor+1,o=this.options.length-1;this.cursor=n<0?o:n>o?0:n;break;}'
)

/* ── @clack/prompts: render disabled+selected with green checkmark ── */

// styleOption — when disabled AND selected, render green checkbox + gray label
// Before: const c=(a,l)=>{if(a.disabled)return r(a,"disabled");const d=o.includes(a.value);return l&&d?r(a,"active-selected"):d?r(a,"selected"):r(a,l?"active":"inactive")};
// After:   same but checks selected state for disabled options
prompts = prompts.replace(
  'const c=(a,l)=>{if(a.disabled)return r(a,"disabled");const d=o.includes(a.value);return l&&d?r(a,"active-selected"):d?r(a,"selected"):r(a,l?"active":"inactive")};',
  'const c=(a,l)=>{if(a.disabled){const d=o.includes(a.value);return d?`${e("green",U)} ${Q(a.label??String(a.value),o=>e("gray",o))}${a.hint?` ${e("dim",`(${a.hint})`)}`:""}`:r(a,"disabled")}const d=o.includes(a.value);return l&&d?r(a,"active-selected"):d?r(a,"selected"):r(a,l?"active":"inactive")};'
)

writeFileSync(CORE, core)
writeFileSync(PROMPTS, prompts)

console.log("✅ Patched @clack/core and @clack/prompts for locked options")
