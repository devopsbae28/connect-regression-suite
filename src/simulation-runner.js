/**
 * Simulation Runner
 *
 * Core module that interacts with the Amazon Connect Testing Simulations API.
 * Handles:
 *   - Creating test cases via API
 *   - Starting test case executions
 *   - Polling for completion
 *   - Retrieving detailed execution records
 *   - Managing concurrency (max 5 concurrent)
 */

const { ConnectClient, CreateTestCaseCommand, StartTestCaseExecutionCommand, GetTestCaseExecutionSummaryCommand, ListTestCaseExecutionRecordsCommand } = require('@aws-sdk/client-connect');
const { formatOverrideForApi } = require('./hours-override');

const POLL_INTERVAL_MS = 5000; // 5 seconds between status checks
const MAX_POLL_DURATION_MS = 330000; // 5.5 minutes (test timeout is 5 min)
const TERMINAL_STATUSES = ['PASSED', 'FAILED', 'STOPPED'];

class SimulationRunner {
  /**
   * @param {object} options
   * @param {string} options.region - AWS region
   * @param {string} options.instanceId - Amazon Connect instance ID
   * @param {number} options.concurrency - Max concurrent test executions (1-5)
   */
  constructor(options) {
    this.region = options.region;
    this.instanceId = options.instanceId;
    this.concurrency = Math.min(options.concurrency || 5, 5);
    this.client = new ConnectClient({ region: this.region });
  }

  /**
   * Execute all test cases with a worker-pool that:
   *  - never runs more than `concurrency` executions at once, and
   *  - resolves only after EVERY test has reached a terminal state.
   *
   * @param {Array} testCases - Array of processed test case definitions
   * @returns {Array} Array of result objects with status and execution details
   */
  async executeAll(testCases) {
    const results = [];
    const queue = [...testCases];

    // Each worker pulls from the shared queue until it is empty.
    const worker = async () => {
      while (queue.length > 0) {
        const testCase = queue.shift();
        if (!testCase) break;
        try {
          results.push(await this.executeSingle(testCase));
        } catch (err) {
          results.push({
            name: testCase.name,
            flowId: testCase.flowId,
            channel: testCase.channel,
            status: 'FAILED',
            error: err.message,
            observations: [],
            executionRecords: [],
            hasHoursOverride: testCase.hasHoursOverride || false
          });
        }
      }
    };

    // Spawn up to `concurrency` workers. Promise.all resolves ONLY when all
    // workers have drained the queue AND every in-flight execution completed —
    // guaranteeing the report is generated after ALL tests finish, not just
    // the first batch.
    const workerCount = Math.min(this.concurrency, queue.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }

  /**
   * Execute a single test case end-to-end.
   *
   * @param {object} testCase - Processed test case definition
   * @returns {object} Result object
   */
  async executeSingle(testCase) {
    const testStartTime = new Date();
    console.log(`      ▶ Starting: ${testCase.name}`);

    // Step 1: Build test case content
    const content = this.buildTestContent(testCase);

    // Step 2: Create the test case in Connect
    const testCaseId = await this.createTestCase(testCase, content);

    // Step 3: Start execution
    const executionId = await this.startExecution(testCaseId);

    // Step 4: Poll for completion
    const summary = await this.pollForCompletion(testCaseId, executionId);

    // Step 5: Get detailed execution records
    const executionRecords = await this.getExecutionRecords(testCaseId, executionId);

    const testEndTime = new Date();
    const duration = ((testEndTime - testStartTime) / 1000).toFixed(1);
    const statusIcon = summary.Status === 'PASSED' ? '✓' : '✗';
    console.log(`      ${statusIcon} ${testCase.name} — ${summary.Status} (${duration}s)`);

    return {
      name: testCase.name,
      description: testCase.description || '',
      flowId: testCase.flowId,
      channel: testCase.channel,
      status: summary.Status,
      testCaseId,
      executionId,
      startTime: summary.StartTime || testStartTime,
      endTime: summary.EndTime || testEndTime,
      duration: parseFloat(duration),
      observationSummary: summary.ObservationSummary || {},
      executionRecords,
      hasHoursOverride: testCase.hasHoursOverride || false,
      interactionGroups: testCase.interactionGroups
    };
  }

  /**
   * Build the JSON content string for the Connect test case API.
   * Emits the verified Testing Language schema:
   *   { Version, Metadata, Observations: [{ Identifier, Event, Actions, Transitions }] }
   * Observations are chained sequentially via Transitions.NextObservations.
   */
  buildTestContent(testCase) {
    const groups = testCase.interactionGroups;
    const observations = groups.map((group, index) => {
      const id = group.id || `obs_${index + 1}`;
      const nextId = index < groups.length - 1
        ? (groups[index + 1].id || `obs_${index + 2}`)
        : null;

      const obs = {
        Identifier: id,
        Event: this.buildEvent(group.observe, id),
        Actions: [],
        Transitions: { NextObservations: nextId ? [nextId] : [] }
      };

      // Check/Assert blocks first, then actions (send input / end / override).
      if (group.check && group.check.length > 0) {
        obs.Actions.push(...group.check.map((c, i) => this.buildAssert(c, `${id}-assert-${i}`)));
      }
      if (group.actions && group.actions.length > 0) {
        obs.Actions.push(...group.actions.map((a, i) => this.buildActionBlock(a, `${id}-act-${i}`)));
      }
      return obs;
    });

    return JSON.stringify({ Version: '2019-10-30', Metadata: {}, Observations: observations });
  }

  /**
   * Build the Event object for an observation (verified schema).
   * Actor is always "System" for observed events.
   */
  buildEvent(observe, obsId) {
    const evt = { Identifier: `evt-${obsId}`, Actor: 'System' };

    switch (observe.type) {
      case 'test_started':
        evt.Type = 'TestInitiated';
        evt.Properties = {};
        break;

      case 'test_completed':
        evt.Type = 'TestCompleted';
        evt.Properties = {};
        break;

      case 'message_received': {
        evt.Type = 'MessageReceived';
        // MatchingCriteria is an OBJECT, INSIDE Properties: { "Type": "Similarity" | "Inclusion" }.
        // Accept config shorthand `match` ("Similarity"|"Inclusion"); default to Similarity.
        const matchType = observe.match === 'Inclusion' ? 'Inclusion' : 'Similarity';
        evt.Properties = {
          Text: observe.content,
          MatchingCriteria: { Type: matchType }
        };
        break;
      }

      case 'action_triggered':
        evt.Type = 'FlowActionStarted';
        // ActionParameters carrying the specific resource identity is REQUIRED for a match
        // (e.g., { LambdaFunctionARN } for Lambda, { QueueId } for a queue transfer).
        evt.Properties = {
          ActionType: observe.actionType,
          ActionParameters: observe.actionParameters || {}
        };
        break;

      default:
        evt.Type = observe.type;
        evt.Properties = observe.properties || {};
    }

    return evt;
  }

  /**
   * Build an Assert action (validates an attribute). Note: Assert Parameters do NOT echo ActionType.
   */
  buildAssert(check, id) {
    return {
      Identifier: id,
      Type: 'Assert',
      Parameters: {
        Namespace: check.namespace || check.key,
        Operator: check.operator || 'Equals',
        Operand: check.operand !== undefined ? check.operand : check.expectedValue
      },
      Transitions: {}
    };
  }

  /**
   * Build an action block for the API content (verified schema).
   */
  buildActionBlock(action, id) {
    switch (action.type) {
      case 'override_resources':
      case 'override':
        return formatOverrideForApi(action, id);

      case 'send_dtmf':
        return {
          Identifier: id,
          Type: 'SendInstruction',
          Actor: 'Customer',
          Parameters: {
            ActionType: 'SendInstruction',
            Actor: 'Customer',
            Instruction: { Type: 'DtmfInput', Properties: { Value: action.value } }
          },
          Transitions: {}
        };

      case 'send_text':
        return {
          Identifier: id,
          Type: 'SendInstruction',
          Actor: 'Customer',
          Parameters: {
            ActionType: 'SendInstruction',
            Actor: 'Customer',
            Instruction: { Type: 'TextInput', Properties: { Value: action.value } }
          },
          Transitions: {}
        };

      case 'end_test':
        return {
          Identifier: id,
          Type: 'TestControl',
          Parameters: { ActionType: 'TestControl', Command: { Type: 'EndTest' } },
          Transitions: {}
        };

      default:
        return action; // Pass through for custom/pre-built action objects
    }
  }

  /**
   * Create a test case via the Connect API.
   */
  async createTestCase(testCase, content) {
    const entryPoint = this.buildEntryPoint(testCase);

    const params = {
      InstanceId: this.instanceId,
      Name: `regression_${testCase.name}_${Date.now()}`,
      Description: testCase.description || `Regression test: ${testCase.name}`,
      Content: content,
      EntryPoint: entryPoint,
      Status: 'PUBLISHED'
    };

    const command = new CreateTestCaseCommand(params);
    const response = await this.client.send(command);
    return response.TestCaseId;
  }

  /**
   * Build the entry point configuration based on channel type.
   */
  buildEntryPoint(testCase) {
    if (testCase.channel === 'VOICE_CALL') {
      return {
        Type: 'VOICE_CALL',
        VoiceCallEntryPointParameters: {
          SourcePhoneNumber: testCase.sourcePhoneNumber,
          DestinationPhoneNumber: testCase.destinationPhoneNumber,
          FlowId: testCase.flowId
        }
      };
    }

    return {
      Type: 'CHAT',
      ChatEntryPointParameters: {
        FlowId: testCase.flowId
      }
    };
  }

  /**
   * Start test case execution.
   */
  async startExecution(testCaseId) {
    const command = new StartTestCaseExecutionCommand({
      InstanceId: this.instanceId,
      TestCaseId: testCaseId
    });

    const response = await this.client.send(command);
    return response.TestCaseExecutionId;
  }

  /**
   * Poll for test execution completion.
   */
  async pollForCompletion(testCaseId, executionId) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      const command = new GetTestCaseExecutionSummaryCommand({
        InstanceId: this.instanceId,
        TestCaseId: testCaseId,
        TestCaseExecutionId: executionId
      });

      const response = await this.client.send(command);

      if (TERMINAL_STATUSES.includes(response.Status)) {
        return response;
      }

      // Wait before polling again
      await this.sleep(POLL_INTERVAL_MS);
    }

    // Timed out waiting
    return {
      Status: 'STOPPED',
      ObservationSummary: { TotalObservations: 0, ObservationsPassed: 0, ObservationsFailed: 0 }
    };
  }

  /**
   * Retrieve detailed execution records for a completed test.
   */
  async getExecutionRecords(testCaseId, executionId) {
    const records = [];
    let nextToken = null;

    do {
      const params = {
        InstanceId: this.instanceId,
        TestCaseId: testCaseId,
        TestCaseExecutionId: executionId,
        MaxResults: 100
      };
      if (nextToken) {
        params.NextToken = nextToken;
      }

      const command = new ListTestCaseExecutionRecordsCommand(params);
      const response = await this.client.send(command);

      if (response.ExecutionRecords) {
        records.push(...response.ExecutionRecords);
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return records;
  }

  /**
   * Sleep helper.
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute pre-existing published test cases (created via Console).
   * This is the recommended path when the Content schema is not available
   * for programmatic test creation.
   *
   * @param {Array} testCaseIds - Array of {testCaseId, name, description} objects
   * @returns {Array} Array of result objects
   */
  async executeExisting(testCaseIds) {
    const results = [];
    const queue = [...testCaseIds];

    const worker = async () => {
      while (queue.length > 0) {
        const tc = queue.shift();
        if (!tc) break;
        try {
          results.push(await this.executeExistingSingle(tc));
        } catch (err) {
          results.push({ name: tc.name || tc.testCaseId, status: 'FAILED', error: err.message, executionRecords: [] });
        }
      }
    };

    // Spawn up to `concurrency` workers; Promise.all resolves only after every
    // test reaches a terminal state (report generated after ALL complete).
    const workerCount = Math.min(this.concurrency, queue.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }

  /**
   * Execute a single pre-existing published test case.
   */
  async executeExistingSingle(tc) {
    const testStartTime = new Date();
    const testCaseId = tc.testCaseId;
    console.log(`      ▶ Starting: ${tc.name || testCaseId}`);

    const executionId = await this.startExecution(testCaseId);
    const summary = await this.pollForCompletion(testCaseId, executionId);
    const executionRecords = await this.getExecutionRecords(testCaseId, executionId);

    const testEndTime = new Date();
    const duration = ((testEndTime - testStartTime) / 1000).toFixed(1);
    const statusIcon = summary.Status === 'PASSED' ? '✓' : '✗';
    console.log(`      ${statusIcon} ${tc.name || testCaseId} — ${summary.Status} (${duration}s)`);

    return {
      name: tc.name || testCaseId,
      description: tc.description || '',
      flowId: tc.flowId || '',
      channel: tc.channel || 'VOICE_CALL',
      status: summary.Status,
      testCaseId,
      executionId,
      startTime: summary.StartTime || testStartTime,
      endTime: summary.EndTime || testEndTime,
      duration: parseFloat(duration),
      observationSummary: summary.ObservationSummary || {},
      executionRecords,
      hasHoursOverride: tc.hasHoursOverride || false,
      interactionGroups: tc.interactionGroups || []
    };
  }
}

module.exports = { SimulationRunner };
