# Kimchi

Shared domain language for the Kimchi coding harness.

## Codemode

**Codemode purpose**:
A short plain-language statement of what the primary model intends a Codemode script to accomplish.
_Avoid_: generated summary, outcome

**Codemode action summary**:
A deterministic account of the nested tool actions a script performed and their outcomes.
_Avoid_: purpose, generated outcome

**Tokens kept out of context**:
An estimate of intermediate-result token volume not exposed to the model after accounting for the Codemode output returned to it. It is not a verified net token or cost saving.
_Avoid_: tokens saved, exact savings
