# Amazon Connect Contact Flow Regression Testing Suite — Build Specification

Version: 1.0
Status: Implementation-ready
Audience: Engineering team rebuilding this application for a new customer/environment

---

## 1. Purpose

Build an API-driven regression testing suite for Amazon Connect contact flows using the
**Connect Testing Simulations API** (GA Feb 2026). The suite programmatically creates,
publishes, executes, and evaluates test cases against contact flows, then produces an
HTML report showing where the customer experience succeeds vs. fails.

The suite is **customer- and environment-agnostic**: it targets a *test* Connect instance
by default but can run against a *production* instance when explicitly configured with prod
resource IDs. See Section 8 (Environment Safety) — this is a hard requirement, not optional.

Non-negotiable design goals:
1. **No simulated contact may ever reach a live agent.** (Section 7)
2. **No test may invoke a live external resource with side effects** (Lambda, etc.) unless
   explicitly and intentionally configured. (Section 6)
3. **Dev/prod must be impossible to confuse by mistyping.** (Section 8)
4. **No hardcoded resource IDs/ARNs in source.** All environment specifics live in a
   gitignored, per-environment config file. (Section 4)

---

## 2. High-Level Architecture

```
config (per-environment JSON)  ──▶  loader/validator  ──▶  guardrail checks
                                                               │
                                                               ▼
                                              test-case builder (Testing Language JSON)
                                                               │
                                                               ▼
                          Connect API: CreateTestCase (PUBLISHED)  ──▶  StartTestCaseExecution
                                                               │
                                                               ▼
                          poll GetTestCaseExecutionSummary until terminal
                                                               │
                                                               ▼
                          ListTestCaseExecutionRecords (step detail)
                                                               │
                                                               ▼
                                              HTML report generator
```

Language/runtime: Node.js ≥ 18 (reference implementation) OR Python 3.11+ (boto3).
The Testing Language JSON schema is identical regardless of SDK.

Module breakdown (reference implementation):
- `config-loader`   — load + schema-validate the config; run all guardrail checks
- `env-guard`       — dev/prod resolution and confirmation gating (Section 8)
- `testcase-builder`— produce Testing Language JSON from declarative test definitions
- `simulation-runner`— CreateTestCase → Start → poll → collect records; concurrency control
- `report-generator`— render HTML report from results
- `index` (CLI)     — orchestrator

---

## 3. Connect Testing Simulations API — Reference

### 3.1 Call sequence
1. `CreateTestCase(InstanceId, Name, Description, Content, EntryPoint, Status)` → `TestCaseId`
   - `Status: "SAVED"` stores WITHOUT validation and is **NOT executable**.
   - `Status: "PUBLISHED"` validates content and is executable.
2. `StartTestCaseExecution(InstanceId, TestCaseId)` → `TestCaseExecutionId`, `Status`
3. `GetTestCaseExecutionSummary(InstanceId, TestCaseId, TestCaseExecutionId)`
   → `Status`, `ObservationSummary{TotalObservations, ObservationsPassed, ObservationsFailed}`
4. `ListTestCaseExecutionRecords(InstanceId, TestCaseId, TestCaseExecutionId)`
   → `ExecutionRecords[]{ObservationId, Status, Timestamp, Record}`
5. `UpdateTestCase(...)` to modify; `DeleteTestCase(...)` to remove; `ListTestCases(...)` to enumerate.

Statuses: `INITIATED | IN_PROGRESS | PASSED | FAILED | STOPPED`.

### 3.2 Service limits (design around these)
- **5 concurrent executions** max. Additional requests → `INITIALIZATION_FAILURE`
  ("limit reached"). Runner MUST cap concurrency at 5 and queue the rest.
- **100 executions** max in queue.
- **5-minute timeout** per execution. An unmatched observation runs until timeout → `FAILED`
  with `CompletionReason.Type = TIMEOUT`, `FailureReasons = ["OBSERVE_EVENT"]`.
- Execution records retained indefinitely for runs on/after 2026-02-09.

### 3.3 Entry point
```json
// Voice — FlowId alone is sufficient:
{ "Type": "VOICE_CALL", "VoiceCallEntryPointParameters": { "FlowId": "<FLOW_ID>" } }
// Voice with phone routing (both numbers required together if used):
{ "Type": "VOICE_CALL", "VoiceCallEntryPointParameters": {
    "SourcePhoneNumber": "<E164>", "DestinationPhoneNumber": "<E164>", "FlowId": "<FLOW_ID>" } }
// Chat:
{ "Type": "CHAT", "ChatEntryPointParameters": { "FlowId": "<FLOW_ID>" } }
```
Note: supplying `DestinationPhoneNumber` without `SourcePhoneNumber` is rejected
(`Missing mandatory parameter ... SourcePhoneNumber`).

---

## 4. Testing Language Content Schema (VERIFIED)

The `Content` field is a JSON **string** (JSON-stringify the document). The official schema
is documented in the AWS Connect Developer Guide (Testing Language reference); the schema
below is verified against a working, published test case and matches the current docs.

### 4.1 Root
```json
{
  "Version": "2019-10-30",         // REQUIRED, exact string. Any other value → deserialize failure.
  "Metadata": {},                   // object; may be empty
  "Observations": [ /* ... */ ]     // array of observation objects (these are the "interaction groups")
}
```

### 4.2 Observation
```json
{
  "Identifier": "unique-id",
  "Event": { /* see 4.3 */ },
  "Actions": [ /* see 4.4 */ ],     // may be [] (empty)
  "Transitions": { "NextObservations": ["next-id"] }  // [] = terminal observation
}
```
> **DO NOT include a `Usage` block.** The server auto-applies the default
> (`Exactly`, `Times: 1`). Supplying `Usage` with mismatched enum casing
> (e.g. `"EXACTLY"`) triggers semantic validation failure. Omit it.

### 4.3 Event (Actor is always "System" for observed events)
```json
{ "Identifier": "evt-id", "Type": "<EVENT_TYPE>", "Actor": "System", "Properties": { } }
```
`Event.Identifier` is REQUIRED (used for UI rendering). Event types:

| Type                | Properties                                                                 |
|---------------------|----------------------------------------------------------------------------|
| `TestInitiated`     | `{}`                                                                        |
| `TestCompleted`     | `{}`                                                                        |
| `MessageReceived`   | `{ "Text": "<expected>", "MatchingCriteria": { "Type": "Similarity" } }`    |
| `FlowActionStarted` | `{ "ActionType": "<flowActionType>", "ActionParameters": { ... } }`         |

**`MatchingCriteria` (VERIFIED, critical):** it is an **object INSIDE `Properties`**, of the
form `{ "Type": "Similarity" }` or `{ "Type": "Inclusion" }`.

- `Similarity` = semantic match (recommended for voice; audio is segmented so exact matches are brittle).
- `Inclusion` = observed message contains the specified text.
- **Do NOT** pass `MatchingCriteria` as a bare string (e.g. `"Similarity"`) or as a sibling of
  `Properties`. A string value publishes but is silently normalized to empty `{}` at execution,
  so the observation never matches and the test fails after a 5-minute `OBSERVE_EVENT` timeout.
- **Do NOT** use `"Contains"` — that is the console UI label; the API enum is `"Inclusion"`.
- The object form placed as a *sibling* of `Properties` publishes but fails at execution with
  `INITIALIZATION_FAILURE: invalid execution parameters`. It must be inside `Properties`.

For `MessageReceived`, `Properties` also accepts (mutually exclusive with `Text`): `PromptId`,
`SSML`, or `Media { Uri, SourceType, MediaType }`. Reference:
docs.aws.amazon.com/connect/latest/devguide/testing-language-events-message-received.html

### 4.4 Action
```json
{ "Identifier": "act-id", "Type": "<ACTION_TYPE>", "Parameters": { /* per type */ }, "Transitions": {} }
```
`Action.Transitions` is `{}` (empty) for a terminal action, or `{"NextAction":"<id>"}`
to chain to the next action in the same observation.

Action types:

**TestControl** (end test / log):
```json
{ "Identifier": "end", "Type": "TestControl",
  "Parameters": { "ActionType": "TestControl", "Command": { "Type": "EndTest" } },
  "Transitions": {} }
```

**SendInstruction** (simulate customer input; DTMF `Value` is a NUMBER):
```json
{ "Identifier": "dtmf", "Type": "SendInstruction", "Actor": "Customer",
  "Parameters": { "ActionType": "SendInstruction", "Actor": "Customer",
    "Instruction": { "Type": "DtmfInput", "Properties": { "Value": 1 } } },
  "Transitions": {} }
// Text/utterance: "Instruction": { "Type": "TextInput", "Properties": { "Value": "book a flight" } }
```

**Assert** (validate an attribute — NOTE: no `ActionType` echo, unlike other actions):
```json
{ "Identifier": "assert", "Type": "Assert",
  "Parameters": { "Namespace": "$.Queue.Name", "Operator": "Equals", "Operand": "<value>" },
  "Transitions": {} }
```
Operators: `Equals, TextStartsWith, TextEndsWith, TextContains,
NumberGreaterThan, NumberGreaterOrEqualTo, NumberLessThan, NumberLessOrEqualTo, Exists`.

**OverrideSystemBehavior** (mock/substitute a flow resource — see Section 6):
```json
{ "Identifier": "mock", "Type": "OverrideSystemBehavior",
  "Parameters": { "ActionType": "OverrideSystemBehavior",
    "Behavior": { "Type": "FlowAction", "Properties": {
      "ActionType": "<FlowActionType>",
      "ActionParameters": { /* identifies which block */ },
      "Strategy": { /* MockResponse OR SubstituteResource */ } } } },
  "Transitions": {} }
```

### 4.5 Key schema rules (capture in code comments)
- `Version` must be exactly `"2019-10-30"`.
- Omit `Usage` (server default) — or match exact casing if you must include it.
- `Event.Identifier` required.
- `MatchingCriteria` = object `{ "Type": "Similarity" | "Inclusion" }` **inside `Properties`** (not a
  bare string, not a sibling; `"Contains"` is invalid — use `"Inclusion"`). See §4.3.
- Every non-Assert action `Parameters` must echo `ActionType`; `Assert` must NOT.
- DTMF `Value` is a number.
- `MockResponse.ExecutionResult.Value` must be a **JSON-serialized string**, not an object
  (passing an object fails validation with an internal
  `ClassCastException: ... cannot be cast to MockResponseStrategy`). This is the key fix
  for the previously-seen `InvalidTestCaseException` on `OverrideSystemBehavior` mocks.
- `SAVED` skips validation entirely; only `PUBLISHED` validates and is executable.

---

## 4A. Validation Strategy (IMPORTANT — read before authoring tests)

Every contact center is different. The prompt/greeting wording a flow plays is
**customer-specific** and changes frequently (copy edits, localization, seasonal
messaging). Therefore:

1. **Expected prompt text is always caller-supplied input, never assumed by the suite.**
   The suite validates against the expectation the test author declares in config. A
   mismatch is a legitimate *test result* (the experience differs from what was declared),
   not a suite defect. Do NOT hardcode prompt wording into the tooling; it lives only in
   per-customer config.

2. **Prefer contact-center-agnostic validation over prompt-text matching.** Assert on
   stable, structural signals wherever possible. Recommended order of preference:

   | Validation                         | Stability | Example |
   |------------------------------------|-----------|---------|
   | `action_triggered` (flow action)   | Highest — structural | `TransferContactToQueue`, `InvokeLambdaFunction`, `CheckHoursOfOperation`, Lex bot connect |
   | `check` / `Assert` on attributes    | High — data | `$.Queue.Name Equals "Sales"`, `$.Attributes.verified Equals "true"` |
   | `MessageReceived` + `Similarity`    | Medium — semantic | tolerant of minor wording changes |
   | `MessageReceived` + `Inclusion`     | Low — substring | brittle; breaks on any copy change |

   For "did the caller reach the right place," assert on the **routing event + target
   resource** (e.g., queue transfer + `$.Queue.Name`) rather than the prompt text. This is
   portable across any contact center.

3. **Prompt observation is OPTIONAL.** A test may validate a DTMF/utterance path purely by
   the destination *action* (e.g., "pressing 3 triggers the Lambda block", "pressing 1
   transfers to the Sales queue") with no prompt-text observation at all.

4. **When you do observe a message, default to `Similarity`, not `Contains`.** Reserve
   `Contains` for cases where an exact, stable substring is genuinely required.

5. **Voice caveat.** Voice audio is segmented by the simulator based on pauses/speech
   patterns, so exact-text matching on voice prompts is especially unreliable. Favor
   event/attribute assertions for voice; use `Similarity` if a message check is required.

Loader guidance: a test with zero observations beyond `test_started` and no
event/attribute assertion is not meaningfully validating anything — warn on it. A test that
asserts only on prompt `Contains` for voice should emit an advisory to consider event-based
validation.

---

## 5. Execution Record Anatomy (for the report)

`ListTestCaseExecutionRecords` returns ordered records; `Record` is a JSON string:
- `Type: "INITIATION"`     — test accepted
- `Type: "EXECUTION_START"`— simulated contact created (`ContactId` present)
- `Type: "OBSERVATION"`    — one observation result (`Identifier`, `Status`, `Event`, `Actions[]`)
- `Type: "COMPLETION"`     — final result with `CompletionReason { Type, Message, FailureReasons[] }`

`CompletionReason.Type` values seen: `SUCCESS`, `TIMEOUT`, `FAILURE`.
`FailureReasons` values seen: `OBSERVE_EVENT` (observation never matched),
`INITIALIZATION_FAILURE` (concurrency/limit).

The report should surface, per test: overall status, observation pass/fail counts, the
first failing step, the `CompletionReason`, and the simulated `ContactId`.

---

## 6. Resource Mocking (no live side effects)

Register overrides in the **first observation** (`TestInitiated`) so they take effect before
the flow runs. Two strategies:

### 6.1 MockResponse — return a canned value; the real resource is NEVER called
Lambda (Value MUST be a JSON string):
```json
"Strategy": { "Type": "MockResponse",
  "Response": { "Type": "ExecutionResult",
    "ExecutionResult": { "Value": "{\"Key\":\"Val\"}" } } }
```
> **CheckHoursOfOperation does NOT support MockResponse (VERIFIED).** Every MockResponse
> variant for `CheckHoursOfOperation` (`Value: "InHours"|"OutOfHours"`, JSON-string, Branch,
> etc.) is rejected at publish with `InvalidTestCaseException`. To force open/closed, use
> **SubstituteResource** (§6.2) pointing at an alternate hours-of-operation resource. Create a
> dedicated always-open and always-closed HoO and substitute the appropriate one. MockResponse
> is (so far) confirmed only for `InvokeLambdaFunction`.

### 6.2 SubstituteResource — swap in a safe alternate resource by ARN
```json
"Strategy": { "Type": "SubstituteResource", "SubstituteArn": "<ALTERNATE_RESOURCE_ARN>" }
```
This is the strategy for **CheckHoursOfOperation** (substitute an always-open / always-closed
HoO to exercise business-hours vs after-hours branches) and for swapping queues to an
agent-free test queue. Example (force after-hours):
```json
"Properties": {
  "ActionType": "CheckHoursOfOperation",
  "ActionParameters": { "HoursOfOperationId": "<ALWAYS_CLOSED_HOO_ARN>" },
  "Strategy": { "Type": "SubstituteResource", "SubstituteArn": "<ALWAYS_CLOSED_HOO_ARN>" }
}
```

**Requirement:** Any test whose target flow invokes an external resource with side effects
(Lambda, external HTTP via Lambda, payment, DB writes) MUST mock that resource with
`MockResponse` (Lambda) or substitute a sandbox resource (`SubstituteResource`, incl. hours).
The config loader SHOULD warn if a flow known to contain such a block is tested without an
override (best-effort; see 9.3).

---

## 7. Live-Agent Protection (MANDATORY)

A simulated contact that is transferred to a queue and not ended can connect to a **real
agent**. This must be impossible. Enforce ALL of the following:

1. **Mandatory EndTest-before-queue rule (validated at config load):**
   For every test definition, if any observation observes or is expected to reach a
   queue-transfer flow action, an `EndTest` TestControl action MUST execute before that
   point. The loader MUST reject (hard error, non-zero exit) any test that could observe a
   post-queue-transfer event without a preceding `EndTest`.

2. **Prefer ending before the transfer:** Design tests to `EndTest` upon observing the
   *pre-queue* prompt or the `FlowActionStarted`/`TransferContactToQueue` event itself —
   do not observe events that occur after the contact is enqueued.

3. **Queue substitution as defense-in-depth:** When a test must proceed through a transfer,
   substitute a dedicated **test queue with no agents/routing** via `SubstituteResource`
   (`<TEST_QUEUE_ARN>` from config). Never allow substitution to a production queue.

4. **Global kill-switch config flag:** `safety.blockQueueTransfers: true` (default true).
   When true, the builder auto-injects an `EndTest` immediately upon any observed
   queue-transfer action and refuses to add observations beyond it.

5. **Runner assertion:** If any execution record shows the contact reached a live agent
   state, the runner logs a CRITICAL warning and marks the run unsafe. (Detectable via the
   COMPLETION/observation records.)

The loader MUST fail closed: if it cannot prove a test is safe, it rejects the test.

---

## 8. Environment Safety — Dev/Prod Separation (MANDATORY)

Goal: make it impossible to accidentally run against production by mistyping an ID, and
require an explicit, deliberate action to target prod.

### 8.1 Config carries an explicit environment
```json
{
  "environment": "test",            // REQUIRED: "test" | "production" (exact, lowercase)
  "instanceId": "<INSTANCE_ID>",
  "instanceAlias": "<INSTANCE_ALIAS>",   // human-readable, used in confirmation prompts
  "region": "<REGION>",
  "allowedInstanceIds": ["<INSTANCE_ID>"] // allowlist; instanceId MUST be a member
}
```

### 8.2 Resolution + gating rules (enforced by `env-guard`)
1. `environment` MUST be exactly `"test"` or `"production"`. Any other value → hard error.
2. `instanceId` MUST appear in `allowedInstanceIds`. Prevents a typo'd instance ID from
   silently targeting an unintended instance.
3. On startup, the runner calls `DescribeInstance` and verifies the returned
   `InstanceAlias` matches `instanceAlias` in config. Mismatch → hard error (guards against
   copy-pasting a prod instance ID under a "test" config).
4. **Production requires a double opt-in:**
   - CLI flag `--environment production` MUST match the config's `environment`.
     If the config says `production` but the flag says `test` (or is absent) → refuse.
   - CLI flag `--confirm-production "<INSTANCE_ALIAS>"` MUST be supplied and its value MUST
     exactly equal the config `instanceAlias`. Wrong/absent → refuse.
5. **Dry-run is the default.** Real execution requires `--execute`. Without it, the suite
   validates config + builds test JSON + prints the plan, but calls no mutating/execution APIs.
6. **Environment tag on every created test case:** `Tags: { "Environment": "<env>",
   "ManagedBy": "connect-regression-suite" }`. The runner refuses to Start/Update/Delete any
   test case whose `Environment` tag does not match the resolved environment.
7. **Region pinning:** all API calls use `region` from config; no implicit default region.

### 8.3 Suggested CLI contract
```
node src/index.js --config <path> [--environment test|production]
                  [--execute] [--confirm-production "<alias>"]
                  [--concurrency <=5] [--output <dir>]
Behavior matrix:
  no --execute                       → dry run (safe, default)
  env=test  + --execute              → runs
  env=production without both prod flags → HARD REFUSE
  env=production + --environment production + --confirm-production "<matching alias>" + --execute → runs
```

---

## 9. Configuration Schema (placeholders only — NO real IDs)

`tests/suite-config.example.json` (committed) — safe template with placeholders.
`tests/<env>-suite-config.json` (gitignored via `tests/*-suite-config.json` except the example)
— real per-environment values, never committed.

### 9.1 Full example (placeholders)
```json
{
  "environment": "test",
  "instanceId": "<INSTANCE_ID>",
  "instanceAlias": "<INSTANCE_ALIAS>",
  "region": "<REGION>",
  "allowedInstanceIds": ["<INSTANCE_ID>"],
  "safety": {
    "blockQueueTransfers": true,
    "requireLambdaMock": true,
    "testQueueArn": "<TEST_QUEUE_ARN_NO_AGENTS>"
  },
  "resources": {
    "hoursOfOperation": { "alwaysOpen": "<HOO_ID_OPEN>", "alwaysClosed": "<HOO_ID_CLOSED>" }
  },
  "testCases": [
    {
      "name": "menu-option-1-<destination>",
      "description": "DTMF 1 routes to <destination>",
      "flowId": "<FLOW_ID>",
      "channel": "VOICE_CALL",
      "overrides": [
        { "type": "lambda", "lambdaArn": "<LAMBDA_ARN>",
          "mockValue": { "Key": "Value" } },
        { "type": "hoursOfOperation", "mock": "InHours" }
      ],
      "interactionGroups": [
        { "id": "start", "observe": { "type": "test_started" } },
        { "id": "menu",  "observe": { "type": "message_received",
            "content": "<MENU_PROMPT_TEXT>", "match": "Similarity" },
          "action": { "type": "send_dtmf", "value": 1 } },
        { "id": "dest",  "observe": { "type": "message_received",
            "content": "<DESTINATION_PROMPT_TEXT>", "match": "Similarity" },
          "action": { "type": "end_test" } }
      ]
    }
  ]
}
```

### 9.2 Placeholder catalogue (replace per customer/environment)
| Placeholder                    | Meaning                                                    |
|--------------------------------|------------------------------------------------------------|
| `<INSTANCE_ID>`                | Connect instance UUID                                      |
| `<INSTANCE_ALIAS>`             | Connect instance alias (for confirmation gating)           |
| `<REGION>`                     | AWS region of the instance                                 |
| `<FLOW_ID>`                    | Contact flow UUID under test                               |
| `<LAMBDA_ARN>`                 | ARN of a Lambda the flow invokes (to be mocked)            |
| `<HOO_ID_OPEN>` / `<HOO_ID_CLOSED>` | Hours-of-operation IDs for open/closed simulation      |
| `<TEST_QUEUE_ARN_NO_AGENTS>`   | Dedicated agent-free queue for safe substitution           |
| `<MENU_PROMPT_TEXT>` / `<DESTINATION_PROMPT_TEXT>` | Expected prompt text to observe         |

### 9.3 Loader validation rules (all hard errors unless noted)
- `environment` ∈ {test, production}; `instanceId` ∈ `allowedInstanceIds`.
- Each test: `name`, `flowId`, `channel` ∈ {VOICE_CALL, CHAT}, non-empty `interactionGroups`.
- First interaction group MUST observe `test_started`.
- Live-agent rule (Section 7): reject any post-queue observation lacking a prior `end_test`.
- If `safety.requireLambdaMock` and a test lacks a lambda override but is flagged as touching
  a Lambda → hard error (or WARN if flow introspection is unavailable).
- No raw resource ID/ARN may appear outside the config file (lint check in CI).

---

## 10. IAM — Least Privilege

The execution identity needs ONLY:
```
connect:CreateTestCase
connect:UpdateTestCase
connect:DeleteTestCase
connect:StartTestCaseExecution
connect:GetTestCaseExecutionSummary
connect:ListTestCaseExecutions
connect:ListTestCaseExecutionRecords
connect:ListTestCases
connect:DescribeInstance          (env alias verification)
connect:DescribeContactFlow       (optional: flow introspection for safety checks)
connect:ListContactFlows / ListQueues / ListHoursOfOperations  (optional: discovery)
```
Scope resources to the target instance ARN. Do NOT run under an admin role. Prod and test
should use separate roles/accounts where possible. Never hardcode credentials — use the
default provider chain (env, SSO, or instance role).

---

## 11. Reporting

Generate a self-contained HTML report (no external assets) containing:
- Header: instance alias + ID, region, **environment badge (TEST/PROD)**, timestamp.
- Summary tiles: total / passed / failed / in-progress / stopped, pass rate.
- Execution analysis callout (auto-summarize dominant failure reasons).
- Per-test expandable cards: description, test case ID, observation pass/fail counts,
  step table (Initiation → Execution Start → each Observation → Completion), and an explicit
  **failure-location** box citing the failing step + `CompletionReason`.
- Failed tests expanded by default.
- HTML-escape all record content (records may contain PII — see Section 12).
- Write timestamped file + `latest-report.html`. Output dir gitignored.

Exit code: non-zero if any test FAILED (CI gate).

---

## 12. Security & Data Handling

- Resource IDs/ARNs are not credentials but are environment-specific — keep in gitignored
  config; never commit real values. Provide only `*.example.json` with placeholders.
- `.gitignore` MUST include: `node_modules/`, `reports/`, `*.log`, `.env`, `.DS_Store`,
  `tests/*-suite-config.json` (but allow `tests/suite-config.example.json`).
- Execution records and reports may contain PII (customer input, attributes, mocked/real
  Lambda output). Treat `reports/` as sensitive; do not attach to tickets unscrubbed.
- Secure-input / PCI flows: never assert on or log the encrypted payload or encryption key.
- Pin dependency versions exactly. Flag typosquat-looking packages.
- Build API payloads via structured serialization (JSON.stringify / json.dumps) — never
  string-concatenate user/config values into commands or JSON.

---

## 13. Build Checklist

- [ ] Scaffold project (package.json pinned deps, .gitignore per §12, dirs: src/, tests/, reports/).
- [ ] Implement `env-guard` (§8) FIRST — nothing runs without it.
- [ ] Implement config loader + all validation/guardrail rules (§7, §9.3).
- [ ] Implement test-case builder producing verified Testing Language JSON (§4), including
      override injection (§6) and auto EndTest-before-queue (§7.4).
- [ ] Implement simulation-runner: create(PUBLISHED)→start→poll→records; cap concurrency at 5;
      environment-tag every test case; refuse cross-environment mutations (§8.2.6).
- [ ] Implement report generator (§11).
- [ ] Provide `tests/suite-config.example.json` with placeholders only (§9.1).
- [ ] CI lint: fail if any real-looking instance/flow/queue/Lambda ID appears outside config.
- [ ] Dry-run by default; `--execute` required; prod double opt-in (§8.2.4).
- [ ] Verify a minimal `TestInitiated → EndTest` test PUBLISHES and PASSES before adding complexity.

---

## 14. Known-Good Minimal Test (smoke test the schema first)

```json
{
  "Version": "2019-10-30",
  "Metadata": {},
  "Observations": [{
    "Identifier": "start",
    "Event": { "Identifier": "evt-1", "Type": "TestInitiated", "Actor": "System", "Properties": {} },
    "Actions": [{
      "Identifier": "end", "Type": "TestControl",
      "Parameters": { "ActionType": "TestControl", "Command": { "Type": "EndTest" } },
      "Transitions": {}
    }],
    "Transitions": { "NextObservations": [] }
  }]
}
```
Publish this against `<FLOW_ID>` with `Status: PUBLISHED`; it should PASS in a few seconds.
Only after this succeeds should you build multi-observation DTMF/chat tests.
```
```
