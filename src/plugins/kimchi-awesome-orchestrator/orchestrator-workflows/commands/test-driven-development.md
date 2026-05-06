---
name: test-driven-development
description: Use when implementing any feature or bugfix where you want tests written first. Ensures code is testable and requirements are clear.
when_to_use: User explicitly wants tests-first. Phrases like "TDD", "write the test first", "red-green-refactor", "drive with tests".
allowed-tools: [Task]
argument-hint: [feature or bug description]
model: minimax-m2.7
effort: medium
---

# Test-Driven Development

**Core principle:** Write the test first. Watch it fail. Then write the code.

<orchestrator_role>
<rule>YOU DO NOT WRITE TESTS YOURSELF.</rule>
<rule>YOU DO NOT WRITE PRODUCTION CODE YOURSELF.</rule>
<rule>YOU DELEGATE all test writing and implementation to agents via the Task tool.</rule>
<rule>You COORDINATE the Red/Green/Refactor cycle — nothing else.</rule>
</orchestrator_role>

<triggers>
<trigger>Implementing new feature</trigger>
<trigger>Fixing a bug (write test that reproduces it)</trigger>
<trigger>Requirements are clear enough to test</trigger>
<trigger>Want to ensure code is testable</trigger>
</triggers>

<iron_law>
<rule>NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST</rule>
</iron_law>

<agent_discovery required="true">
Check Task tool's subagent_type options for available agents.
<agent>test-writer</agent>
<agent>expert-coder</agent>
</agent_discovery>

## The TDD Cycle

### Red: Write Failing Test

<dispatch agent="test-writer">Write a test for: [feature/behavior description]. Requirements: [acceptance criteria]. Match the project's existing test framework and patterns. The test MUST fail when run (the implementation doesn't exist yet). Run the test and confirm it fails for the right reason.</dispatch>

Wait for agent to return. Verify the test fails for the RIGHT reason:

<verify_fail_reason>
<ok>Missing function/class</ok>
<ok>Wrong return value</ok>
<not_ok>Test passes immediately — re-dispatch test-writer to fix</not_ok>
</verify_fail_reason>

### Green: Make Test Pass

<dispatch agent="expert-coder">Write MINIMAL code to make this failing test pass: [test file and location]. Do not write more than needed. Ugly code is fine at this stage. Run the test and confirm it passes.</dispatch>

Wait for agent to return. Verify the test passes.

### Refactor: Clean Up

<dispatch agent="expert-coder">Refactor the code from [files]. Improve: readability, naming, remove duplication. Do NOT change behavior. Run all tests after each change — they MUST still pass.</dispatch>

## Multiple TDD Cycles

For features with multiple behaviors, repeat the cycle:

<cycles>
<cycle>Red → Green → Refactor (for behavior A)</cycle>
<cycle>Red → Green → Refactor (for behavior B)</cycle>
<cycle>Red → Green → Refactor (for behavior C)</cycle>
</cycles>

Each cycle dispatches fresh agents. Pass context about what previous cycles created.

## Integration with Debugging

When fixing bugs with TDD:

<dispatch agent="test-writer">Write a test that reproduces this bug: [bug description]. The test should FAIL with the current code. Run it and confirm it fails.</dispatch>

Then proceed with Green (fix) and Refactor phases.

<todo>
For each feature unit:
<task>Step 0: Discover available agents</task>
<task>RED: Dispatch test-writer agent → test fails</task>
<task>GREEN: Dispatch expert-coder agent → test passes</task>
<task>REFACTOR: Dispatch expert-coder agent → tests still pass</task>
</todo>

<question_relay>
When a delegated agent returns with a question instead of a deliverable:
<step>Detect: The agent response contains a question or "need clarification" — not a completed deliverable.</step>
<step>Relay: Present the agent's question to the user. Add context: which TDD phase (Red/Green/Refactor), which agent.</step>
<step>Wait: Do not proceed, guess, or answer on the user's behalf.</step>
<step>Resume: Use the Task tool's resume parameter with the agent's ID to continue with the user's answer.</step>
<step>Repeat: If the resumed agent asks again, relay again.</step>
<never>Answer an agent's question yourself, skip it, or re-spawn a new agent losing context.</never>
</question_relay>

<red_flags>
<flag>You are writing tests yourself instead of dispatching a test-writer agent</flag>
<flag>You are writing production code instead of dispatching an expert-coder agent</flag>
<flag>The test passed on first run (test proves nothing)</flag>
<flag>You skipped the Refactor phase</flag>
<flag>You skipped agent discovery</flag>
</red_flags>
