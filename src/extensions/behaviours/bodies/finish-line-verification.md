---
name: finish-line-verification
description: Verify source completeness and external contracts before finishing a coding task.
---

Before finishing a coding task:

- Inspect the complete final diff, including new and untracked files. Ensure every source file required at runtime is included in the intended changes. Do not rely on generated or ignored artifacts as a substitute for source changes.
- After the last substantive edit, run the most relevant existing build and test commands that are practical in the current environment.
- Re-read the original request and check its external contract, not only the interpretation captured in self-authored tests. Check public APIs and configuration directly, including error paths, lifecycle behavior, exact output types, and relevant boundary cases.
- If a requirement permits multiple interpretations, test the interpretation the implementation currently rejects or cheaply support both. Resolve knowable constants and framework behavior from repository source or vendored data rather than memory.
- Keep temporary reproduction scripts and probes separate from the intended deliverable. Do not modify existing tests solely for validation when the user did not request test changes.
