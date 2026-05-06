---
name: systematic-debugging-agentless
description: Use when encountering any bug, test failure, or unexpected behavior. Standalone debugging without agent delegation — you investigate and fix directly.
when_to_use: User wants you to debug hands-on (no sub-agents), especially for flaky or small-scope bugs. Phrases like "debug this without agents", "standalone debug", "flaky test".
allowed-tools: [Read, Grep, Glob, Bash, Edit, Write]
argument-hint: [error or symptom description]
model: minimax-m2.7
effort: high
---

# Systematic Debugging (Agentless)

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

<iron_law>
<rule>NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST</rule>
<rule>If you haven't completed Phase 1, you cannot propose fixes.</rule>
</iron_law>

<triggers>
<trigger>Test failures</trigger>
<trigger>Bugs in production</trigger>
<trigger>Unexpected behavior</trigger>
<trigger>Performance problems</trigger>
<trigger>Build failures</trigger>
<trigger>Integration issues</trigger>
</triggers>

<use_especially_when>
<situation>Under time pressure (emergencies make guessing tempting)</situation>
<situation>"Just one quick fix" seems obvious</situation>
<situation>You've already tried multiple fixes</situation>
<situation>Previous fix didn't work</situation>
<situation>You don't fully understand the issue</situation>
</use_especially_when>

<dont_skip_when>
<excuse>Issue seems simple (simple bugs have root causes too)</excuse>
<excuse>You're in a hurry (rushing guarantees rework)</excuse>
<excuse>Manager wants it fixed NOW (systematic is faster than thrashing)</excuse>
</dont_skip_when>

<companion_files>
This skill includes companion technique files in its directory. When a phase references a companion file, use the Read tool to load and follow its complete guidance.
<file name="root-cause-tracing.md" used_in="Phase 1, Step 5: Trace Data Flow">Complete backward tracing technique — trace bugs through call stack to find original trigger</file>
<file name="defense-in-depth.md" used_in="Phase 4: After finding and fixing root cause">Add validation at multiple layers to make the bug structurally impossible</file>
<file name="condition-based-waiting.md" used_in="When debugging flaky tests with timing issues">Replace arbitrary timeouts with condition polling</file>
</companion_files>

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

<investigation_steps>
<step name="Read Error Messages Carefully">
<action>Don't skip past errors or warnings</action>
<action>They often contain the exact solution</action>
<action>Read stack traces completely</action>
<action>Note line numbers, file paths, error codes</action>
</step>

<step name="Reproduce Consistently">
<action>Can you trigger it reliably?</action>
<action>What are the exact steps?</action>
<action>Does it happen every time?</action>
<action>If not reproducible → gather more data, don't guess</action>
</step>

<step name="Check Recent Changes">
<action>What changed that could cause this?</action>
<action>Git diff, recent commits</action>
<action>New dependencies, config changes</action>
<action>Environmental differences</action>
</step>

<step name="Gather Evidence in Multi-Component Systems">
WHEN system has multiple components (CI → build → signing, API → service → database):
BEFORE proposing fixes, add diagnostic instrumentation:
<action>For EACH component boundary: log what data enters and exits</action>
<action>Verify environment/config propagation</action>
<action>Check state at each layer</action>
<action>Run once to gather evidence showing WHERE it breaks</action>
<action>THEN analyze evidence to identify failing component</action>
<action>THEN investigate that specific component</action>

Example (multi-layer system):
```bash
# Layer 1: Workflow
echo "=== Secrets available in workflow: ==="
echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

# Layer 2: Build script
echo "=== Env vars in build script: ==="
env | grep IDENTITY || echo "IDENTITY not in environment"

# Layer 3: Signing script
echo "=== Keychain state: ==="
security list-keychains
security find-identity -v

# Layer 4: Actual signing
codesign --sign "$IDENTITY" --verbose=4 "$APP"
```
This reveals: Which layer fails (secrets → workflow OK, workflow → build FAIL)
</step>

<step name="Trace Data Flow">
WHEN error is deep in call stack:
See root-cause-tracing.md in this directory for the complete backward tracing technique.
<action>Where does bad value originate?</action>
<action>What called this with bad value?</action>
<action>Keep tracing up until you find the source</action>
<action>Fix at source, not at symptom</action>
</step>
</investigation_steps>

### Phase 2: Pattern Analysis

<pattern_analysis>
<step name="Find Working Examples">
<action>Locate similar working code in same codebase</action>
<action>What works that's similar to what's broken?</action>
</step>

<step name="Compare Against References">
<action>If implementing pattern, read reference implementation COMPLETELY</action>
<action>Don't skim — read every line</action>
<action>Understand the pattern fully before applying</action>
</step>

<step name="Identify Differences">
<action>What's different between working and broken?</action>
<action>List every difference, however small</action>
<action>Don't assume "that can't matter"</action>
</step>

<step name="Understand Dependencies">
<action>What other components does this need?</action>
<action>What settings, config, environment?</action>
<action>What assumptions does it make?</action>
</step>
</pattern_analysis>

### Phase 3: Hypothesis and Testing

<hypothesis_testing>
<step name="Form Single Hypothesis">
<action>State clearly: "I think X is the root cause because Y"</action>
<action>Write it down</action>
<action>Be specific, not vague</action>
</step>

<step name="Test Minimally">
<action>Make the SMALLEST possible change to test hypothesis</action>
<action>One variable at a time</action>
<action>Don't fix multiple things at once</action>
</step>

<step name="Verify Before Continuing">
<action>Did it work? Yes → Phase 4</action>
<action>Didn't work? Form NEW hypothesis</action>
<action>DON'T add more fixes on top</action>
</step>

<step name="When You Don't Know">
<action>Say "I don't understand X"</action>
<action>Don't pretend to know</action>
<action>Ask for help</action>
<action>Research more</action>
</step>
</hypothesis_testing>

### Phase 4: Implementation

<implementation>
<step name="Create Failing Test Case">
<action>Simplest possible reproduction</action>
<action>Automated test if possible</action>
<action>One-off test script if no framework</action>
<action>MUST have before fixing</action>
<action>Use orchestrator-workflows:test-driven-development for writing proper failing tests</action>
</step>

<step name="Implement Single Fix">
<action>Address the root cause identified</action>
<action>ONE change at a time</action>
<action>No "while I'm here" improvements</action>
<action>No bundled refactoring</action>
</step>

<step name="Verify Fix">
<action>Test passes now?</action>
<action>No other tests broken?</action>
<action>Issue actually resolved?</action>
</step>

<step name="If Fix Doesn't Work">
<action>STOP</action>
<action>Count: How many fixes have you tried?</action>
<action>If less than 3: Return to Phase 1, re-analyze with new information</action>
<action>If 3 or more: STOP and question the architecture (see below)</action>
<action>DON'T attempt Fix #4 without architectural discussion</action>
</step>

<step name="If 3+ Fixes Failed: Question Architecture">
Pattern indicating architectural problem:
<signal>Each fix reveals new shared state/coupling/problem in different place</signal>
<signal>Fixes require "massive refactoring" to implement</signal>
<signal>Each fix creates new symptoms elsewhere</signal>

STOP and question fundamentals:
<action>Is this pattern fundamentally sound?</action>
<action>Are we "sticking with it through sheer inertia"?</action>
<action>Should we refactor architecture vs. continue fixing symptoms?</action>
<action>Discuss with your human partner before attempting more fixes</action>
This is NOT a failed hypothesis — this is a wrong architecture.
</step>
</implementation>

<red_flags>
If you catch yourself thinking any of these, STOP and return to Phase 1:
<flag>"Quick fix for now, investigate later"</flag>
<flag>"Just try changing X and see if it works"</flag>
<flag>"Add multiple changes, run tests"</flag>
<flag>"Skip the test, I'll manually verify"</flag>
<flag>"It's probably X, let me fix that"</flag>
<flag>"I don't fully understand but this might work"</flag>
<flag>"Pattern says X but I'll adapt it differently"</flag>
<flag>"Here are the main problems: [lists fixes without investigation]"</flag>
<flag>Proposing solutions before tracing data flow</flag>
<flag>"One more fix attempt" (when already tried 2+)</flag>
<flag>Each fix reveals new problem in different place</flag>
</red_flags>

<user_signals>
Watch for these redirections from your human partner — they mean STOP and return to Phase 1:
<signal>"Is that not happening?" — You assumed without verifying</signal>
<signal>"Will it show us...?" — You should have added evidence gathering</signal>
<signal>"Stop guessing" — You're proposing fixes without understanding</signal>
<signal>"Ultrathink this" — Question fundamentals, not just symptoms</signal>
<signal>"We're stuck?" (frustrated) — Your approach isn't working</signal>
</user_signals>

<common_rationalizations>
<rationalization excuse="Issue is simple, don't need process" reality="Simple issues have root causes too. Process is fast for simple bugs." />
<rationalization excuse="Emergency, no time for process" reality="Systematic debugging is FASTER than guess-and-check thrashing." />
<rationalization excuse="Just try this first, then investigate" reality="First fix sets the pattern. Do it right from the start." />
<rationalization excuse="I'll write test after confirming fix works" reality="Untested fixes don't stick. Test first proves it." />
<rationalization excuse="Multiple fixes at once saves time" reality="Can't isolate what worked. Causes new bugs." />
<rationalization excuse="Reference too long, I'll adapt the pattern" reality="Partial understanding guarantees bugs. Read it completely." />
<rationalization excuse="I see the problem, let me fix it" reality="Seeing symptoms is not understanding root cause." />
<rationalization excuse="One more fix attempt (after 2+ failures)" reality="3+ failures = architectural problem. Question pattern, don't fix again." />
</common_rationalizations>

<quick_reference>
<phase name="1. Root Cause" activities="Read errors, reproduce, check changes, gather evidence" success="Understand WHAT and WHY" />
<phase name="2. Pattern" activities="Find working examples, compare" success="Identify differences" />
<phase name="3. Hypothesis" activities="Form theory, test minimally" success="Confirmed or new hypothesis" />
<phase name="4. Implementation" activities="Create test, fix, verify" success="Bug resolved, tests pass" />
</quick_reference>

<no_root_cause>
If systematic investigation reveals issue is truly environmental, timing-dependent, or external:
<step>You've completed the process</step>
<step>Document what you investigated</step>
<step>Implement appropriate handling (retry, timeout, error message)</step>
<step>Add monitoring/logging for future investigation</step>
But: 95% of "no root cause" cases are incomplete investigation.
</no_root_cause>

<supporting_techniques instruction="Read these files from this skill's directory when the corresponding technique is needed">
<technique file="root-cause-tracing.md">Trace bugs backward through call stack to find original trigger</technique>
<technique file="defense-in-depth.md">Add validation at multiple layers after finding root cause</technique>
<technique file="condition-based-waiting.md">Replace arbitrary timeouts with condition polling</technique>
</supporting_techniques>

<related_skills>
<skill name="orchestrator-workflows:test-driven-development">For creating failing test case (Phase 4, Step 1)</skill>
<skill name="orchestrator-workflows:finish-development">Verify fix worked before claiming success</skill>
</related_skills>
