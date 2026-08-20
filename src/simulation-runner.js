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
   * Execute all test cases with concurrency control.
   *
   * @param {Array} testCases - Array of processed test case definitions
   * @returns {Array} Array of result objects with status and execution details
   */
  async executeAll(testCases) {
    const results = [];
    const queue = [...testCases];
    const inFlight = new Set();

    const processNext = async () => {
      if (queue.length === 0) return;

      const testCase = queue.shift();
      const promise = this.executeSingle(testCase)
        .then(result => {
          results.push(result);
          inFlight.delete(promise);
        })
        .catch(err => {
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
          inFlight.delete(promise);
        });

      inFlight.add(promise);

      // If we have capacity, start more
      if (inFlight.size < this.concurrency && queue.length > 0) {
        await processNext();
      }
    };

    // Start initial batch
    const initialBatch = Math.min(this.concurrency, queue.length);
    const startPromises = [];
    for (let i = 0; i < initialBatch; i++) {
      startPromises.push(processNext());
    }
    await Promise.all(startPromises);

    // Wait for all in-flight to complete, starting new ones as slots open
    while (inFlight.size > 0 || queue.length > 0) {
      if (inFlight.size > 0) {
        await Promise.race([...inFlight]);
        // Start next if queue has items
        if (queue.length > 0 && inFlight.size < this.concurrency) {
          await processNext();
        }
      }
    }

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
   */
  buildTestContent(testCase) {
    const interactionGroups = testCase.interactionGroups.map((group, index) => {
      const ig = {
        id: group.id || `interaction_group_${index + 1}`,
        observe: this.buildObserveBlock(group.observe),
      };

      // Add transitions (sequential by default)
      if (index > 0) {
        ig.depends_on = testCase.interactionGroups[index - 1].id || `interaction_group_${index}`;
      }

      // Add check block if present
      if (group.check && group.check.length > 0) {
        ig.check = group.check.map(c => this.buildCheckBlock(c));
      }

      // Add actions block if present
      if (group.actions && group.actions.length > 0) {
        ig.actions = group.actions.map(a => this.buildActionBlock(a));
      }

      return ig;
    });

    return JSON.stringify({ interaction_groups: interactionGroups });
  }

  /**
   * Build an observe block for the API content.
   */
  buildObserveBlock(observe) {
    const block = { type: observe.type };

    if (observe.type === 'message_received') {
      block.content = observe.content;
      if (observe.match_type) {
        block.match_type = observe.match_type; // "Contains" or "Similarity"
      }
    }

    if (observe.type === 'action_triggered') {
      block.action_type = observe.action_type;
      if (observe.action_name) {
        block.action_name = observe.action_name;
      }
    }

    return block;
  }

  /**
   * Build a check block for the API content.
   */
  buildCheckBlock(check) {
    const block = {
      type: check.type,
      key: check.key,
      expected_value: check.expectedValue,
    };

    if (check.operator) {
      block.operator = check.operator;
    }

    return block;
  }

  /**
   * Build an action block for the API content.
   */
  buildActionBlock(action) {
    switch (action.type) {
      case 'override_resources':
        return formatOverrideForApi(action);

      case 'send_dtmf':
        return {
          type: 'send_instructions',
          parameters: {
            input_type: 'dtmf',
            value: action.value
          }
        };

      case 'send_text':
        return {
          type: 'send_instructions',
          parameters: {
            input_type: 'text',
            value: action.value
          }
        };

      case 'end_test':
        return {
          type: 'test_control',
          parameters: {
            action: 'end_test'
          }
        };

      default:
        return action; // Pass through as-is for custom action types
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
    const inFlight = new Set();

    const processNext = async () => {
      if (queue.length === 0) return;
      const tc = queue.shift();
      const promise = this.executeExistingSingle(tc)
        .then(result => { results.push(result); inFlight.delete(promise); })
        .catch(err => {
          results.push({ name: tc.name || tc.testCaseId, status: 'FAILED', error: err.message, executionRecords: [] });
          inFlight.delete(promise);
        });
      inFlight.add(promise);
      if (inFlight.size < this.concurrency && queue.length > 0) await processNext();
    };

    const initialBatch = Math.min(this.concurrency, queue.length);
    for (let i = 0; i < initialBatch; i++) await processNext();
    while (inFlight.size > 0 || queue.length > 0) {
      if (inFlight.size > 0) {
        await Promise.race([...inFlight]);
        if (queue.length > 0 && inFlight.size < this.concurrency) await processNext();
      }
    }
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
