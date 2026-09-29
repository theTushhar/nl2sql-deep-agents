---
name: response-composer
version: 1.0
owner: src/orchestration/response-composer.ts
used_by: composeResponse()
when: envelope assembly on every terminal path (success, blocked, conversational, error, unsupported)
description: User-facing copy pack. Pure template — no LLM cost. Tune tone and wording here; code only picks the block by kind.
model_env: LLM_MODEL
model_fallback: gpt-4o-mini
temperature: 0.0
json_mode: false
variables: question, tables, dialect, intent
---

# Copy blocks (edit wording freely; keep the block names)

## conversational_default
Hello. I am your InfoQA data assistant. Please ask a data question about your test sets, test cases, or test runs.

## blocked_default
Your request cannot be processed as stated. Please rephrase it as a data question about your test sets, test cases, or test runs, avoiding any system or destructive instructions.

## error_exhausted
Your request could not be converted into a certified query after repeated attempts. Please rephrase your question with additional detail about the test sets, test cases, or test runs you need, and try again.

## unsupported_default
This search cannot be represented by the supported query contract.

## success_template
Here is your certified query for "{{question}}". It retrieves filtered results from {{tables}}.
