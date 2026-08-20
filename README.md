# Amazon Connect Contact Flow Regression Testing Suite

Automated regression testing for Amazon Connect contact flows using the [Connect Testing Simulations API](https://docs.aws.amazon.com/connect/latest/adminguide/testing-simulation.html). Validates user experience across voice and chat contact flows, generates detailed HTML reports showing exactly where and why tests pass or fail.

## Features

- **API-Driven Testing** — Uses Amazon Connect's native Testing Simulations API (no visual editor needed)
- **Multi-Channel** — Supports both VOICE_CALL and CHAT contact flows
- **Hours of Operation Overrides** — Test after-hours scenarios any time of day by overriding HoursOfOperation resources
- **Resource Overrides** — Mock Lambda functions, Lex bots, and queues during testing
- **Concurrency Control** — Runs up to 5 tests simultaneously (Connect API limit)
- **HTML Reports** — Detailed reports with pass/fail status, failure locations, and observation details
- **CI/CD Ready** — Exit codes and CLI interface suitable for pipeline integration

## Prerequisites

- **Node.js** 18.0 or later
- **AWS credentials** configured (via environment variables, shared credentials file, or IAM role)
- **Amazon Connect instance** with Testing Simulations enabled
- **IAM permissions** for the Connect testing APIs:
  - `connect:CreateTestCase`
  - `connect:StartTestCaseExecution`
  - `connect:GetTestCaseExecutionSummary`
  - `connect:ListTestCaseExecutionRecords`
  - `connect:ListTestCaseExecutions`

## Quick Start

```bash
# 1. Clone/navigate to the project
cd connect-regression-suite

# 2. Install dependencies
npm install

# 3. Copy and configure the test suite
cp tests/suite-config.json tests/my-suite.json
# Edit my-suite.json with your instance ID, flow IDs, and phone numbers

# 4. Validate configuration (dry run)
node src/index.js --config tests/my-suite.json --dry-run

# 5. Run the regression suite
node src/index.js --config tests/my-suite.json --region us-east-1

# 6. View the report
open reports/latest-report.html
```

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--config <path>` | `./tests/suite-config.json` | Path to test suite configuration file |
| `--region <region>` | `us-east-1` | AWS region where your Connect instance lives |
| `--dry-run` | `false` | Validate config without executing tests |
| `--concurrency <n>` | `5` | Max concurrent test executions (1–5) |
| `--output <path>` | `./reports` | Output directory for HTML reports |
| `--help` | — | Display help information |

## Configuration Schema

The test suite is configured via a JSON file. See `tests/suite-config.json` for a complete example.

### Top-Level Structure

```json
{
  "instanceId": "your-connect-instance-id",
  "description": "Suite description",
  "testCases": [...],
  "hoursOfOperation": [...]
}
```

### Test Case Definition

Each test case represents one contact flow scenario to validate:

```json
{
  "name": "unique-test-name",
  "description": "Human-readable description",
  "flowId": "connect-flow-id",
  "channel": "VOICE_CALL",
  "sourcePhoneNumber": "+1XXXXXXXXXX",
  "destinationPhoneNumber": "+1XXXXXXXXXX",
  "interactionGroups": [...]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier for the test case |
| `description` | No | Description of what this test validates |
| `flowId` | Yes | Amazon Connect flow ID to test |
| `channel` | Yes | `VOICE_CALL` or `CHAT` |
| `sourcePhoneNumber` | Voice only | Caller's phone number |
| `destinationPhoneNumber` | Voice only | Called phone number |
| `interactionGroups` | Yes | Sequence of interaction validations |

### Interaction Groups

Each interaction group validates one step in the contact flow experience:

```json
{
  "id": "welcome_prompt",
  "observe": {
    "type": "message_received",
    "content": "Thank you for calling",
    "match_type": "Contains"
  },
  "check": [
    {
      "type": "user_defined",
      "key": "attribute_name",
      "expectedValue": "expected_value",
      "operator": "Equals"
    }
  ],
  "actions": [
    { "type": "send_dtmf", "value": "1" }
  ]
}
```

#### Observe Block (Required)

Validates what the system does at this step:

| Type | Description |
|------|-------------|
| `test_started` | Test has been initiated |
| `message_received` | System played/sent a message (requires `content`) |
| `action_triggered` | System triggered an action (requires `action_type`) |
| `test_completed` | Test flow has finished |

For `message_received`, set `match_type` to `Contains` (substring match) or `Similarity` (semantic match).

#### Check Block (Optional)

Validates attributes at this point in the flow:

| Check Type | Description |
|------------|-------------|
| `user_defined` | Custom attributes set by the flow |
| `system` | System attributes (Queue.Name, etc.) |
| `segment` | Segment/contact attributes |

#### Actions Block (Optional)

Actions to take after observing:

| Action Type | Parameters | Description |
|-------------|------------|-------------|
| `send_dtmf` | `value`: digits | Simulate DTMF input |
| `send_text` | `value`: text | Simulate chat/utterance input |
| `end_test` | — | End the test at this point |
| `override_resources` | `resource_type`, `resource_id` | Override a resource |

### Hours of Operation Configuration

Override hours of operation to test after-hours/business-hours scenarios regardless of actual time:

```json
{
  "hoursOfOperation": [
    {
      "name": "After Hours - Closed",
      "description": "Simulate closed offices",
      "hoursOfOperationId": "hours-id-for-closed",
      "applyTo": ["after-hours-message"]
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Descriptive name for this override |
| `hoursOfOperationId` | Yes | ID of the HoursOfOperation resource to use |
| `applyTo` | No | Array of test case names (empty = apply to all) |

**Tip:** Create two HoursOfOperation resources in Connect — one that's always "open" and one that's always "closed" — then reference them in your test config to control business hours scenarios.

## HTML Report

The generated report includes:

- **Summary dashboard** — Total tests, passed, failed, pass rate
- **Per-test details** — Expandable cards for each test case
- **Failure location** — Exactly which observation/step failed and why
- **Execution records** — Full observation details from the API
- **Hours override indicators** — Shows which tests used after-hours overrides

Failed tests are automatically expanded in the report for quick identification.

Reports are saved to `./reports/` with timestamped filenames plus a `latest-report.html` for convenience.

## CI/CD Integration

The CLI exits with code `1` when any test fails, making it suitable for pipeline gates:

```yaml
# GitHub Actions example
- name: Run Connect Regression Tests
  run: |
    cd connect-regression-suite
    npm install
    node src/index.js --config tests/production-suite.json --region us-east-1
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

- name: Upload Test Report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: regression-report
    path: connect-regression-suite/reports/latest-report.html
```

## API Limits & Considerations

- **Max 5 concurrent tests** — The suite automatically queues tests beyond this limit
- **5-minute timeout per test** — Tests not completed within 5 minutes are marked STOPPED
- **100 tests max in queue** — Queue capacity for pending executions
- **English only for message matching** — `message_received` observe blocks support English only
- **Always end tests before queue** — Use `end_test` actions to prevent simulated contacts from reaching live agents

## Project Structure

```
connect-regression-suite/
├── src/
│   ├── index.js              # CLI entry point and orchestrator
│   ├── config-loader.js      # Configuration loading and validation
│   ├── simulation-runner.js  # Core API interaction and execution
│   ├── hours-override.js     # Hours of operation override logic
│   └── report-generator.js   # HTML report generation
├── tests/
│   └── suite-config.json     # Sample test configuration
├── reports/                   # Generated reports (gitignored)
├── package.json
└── README.md
```

## Providing Test Flows

Provide test definitions in the `suite-config.json` format:

1. **Identify each flow** to test and its flow ID from the Connect console
2. **Map the expected user journey** — what prompts should play, what DTMF options exist, where calls route
3. **Define interaction groups** matching each step in the flow
4. **Set up hours overrides** for any flows with time-based routing
5. **Include both happy-path and edge cases** — invalid inputs, timeouts, after-hours

## Known Limitation: Content Schema

The Amazon Connect Testing Simulations API (released Feb 2026) requires test case content to be PUBLISHED before execution. The **exact JSON serialization format** for the `Content` field that passes PUBLISHED validation is not publicly documented in the API reference — it is an internal schema used by the Connect Console's visual test designer.

**Current workaround options:**

1. **Create tests via the Console first**, then use this suite to `StartTestCaseExecution` + poll + collect results + generate reports on pre-existing published test cases. The `simulation-runner.js` already supports this flow.

2. **Export content from console-created tests** using `DescribeTestCase` to capture the validated `Content` string, then use that format as a template for API-created tests.

3. **Open an AWS Support case** requesting the Testing Language JSON schema documentation for programmatic test creation.

The suite is designed so that once the content format is known (or tests are created via Console), the full end-to-end execution pipeline works: create → execute → poll → collect records → generate HTML report.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `AccessDeniedException` | Verify IAM permissions include all `connect:*TestCase*` actions |
| Tests timing out | Ensure `end_test` actions are placed before queue transfers |
| `InvalidTestCaseException` | Content schema not matching — see "Known Limitation" above; create tests via Console first |
| Observe block fails | Verify prompt text matches what the flow actually plays |
| `ResourceNotFoundException` | Confirm instance ID, flow IDs, and hours IDs are correct; test must be PUBLISHED to execute |
