/**
 * Configuration Loader and Validator
 *
 * Loads the test suite configuration from JSON and validates it
 * against the expected schema for Amazon Connect Testing Simulations.
 */

const fs = require('fs');
const path = require('path');

/**
 * Load and validate the test suite configuration file.
 * @param {string} configPath - Absolute path to suite-config.json
 * @returns {object} Validated configuration object
 */
function loadAndValidateConfig(configPath) {
  // Check file exists
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  // Parse JSON
  let config;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse configuration file: ${err.message}`);
  }

  // Validate required top-level fields
  validateRequiredField(config, 'instanceId', 'string');
  validateRequiredField(config, 'testCases', 'array');

  if (config.testCases.length === 0) {
    throw new Error('Configuration must contain at least one test case');
  }

  // Validate each test case
  config.testCases.forEach((tc, index) => {
    validateTestCase(tc, index);
  });

  // Validate hours of operation config (optional)
  if (config.hoursOfOperation) {
    validateHoursOfOperation(config.hoursOfOperation);
  }

  return config;
}

/**
 * Validate an individual test case definition.
 */
function validateTestCase(testCase, index) {
  const prefix = `testCases[${index}]`;

  if (!testCase.name || typeof testCase.name !== 'string') {
    throw new Error(`${prefix}.name is required and must be a string`);
  }

  if (!testCase.flowId || typeof testCase.flowId !== 'string') {
    throw new Error(`${prefix}.flowId is required and must be a string`);
  }

  // Channel type validation
  const validChannels = ['VOICE_CALL', 'CHAT'];
  if (!testCase.channel || !validChannels.includes(testCase.channel)) {
    throw new Error(`${prefix}.channel must be one of: ${validChannels.join(', ')}`);
  }

  // Voice call requires phone numbers
  if (testCase.channel === 'VOICE_CALL') {
    if (!testCase.sourcePhoneNumber) {
      throw new Error(`${prefix}.sourcePhoneNumber is required for VOICE_CALL channel`);
    }
    if (!testCase.destinationPhoneNumber) {
      throw new Error(`${prefix}.destinationPhoneNumber is required for VOICE_CALL channel`);
    }
  }

  // Interaction groups validation
  if (!testCase.interactionGroups || !Array.isArray(testCase.interactionGroups)) {
    throw new Error(`${prefix}.interactionGroups is required and must be an array`);
  }

  if (testCase.interactionGroups.length === 0) {
    throw new Error(`${prefix}.interactionGroups must contain at least one interaction group`);
  }

  testCase.interactionGroups.forEach((group, gIndex) => {
    validateInteractionGroup(group, `${prefix}.interactionGroups[${gIndex}]`);
  });
}

/**
 * Validate an interaction group definition.
 */
function validateInteractionGroup(group, prefix) {
  // Observe block is required
  if (!group.observe) {
    throw new Error(`${prefix}.observe is required`);
  }

  if (!group.observe.type) {
    throw new Error(`${prefix}.observe.type is required`);
  }

  const validObserveTypes = ['test_started', 'message_received', 'action_triggered', 'test_completed'];
  if (!validObserveTypes.includes(group.observe.type)) {
    throw new Error(`${prefix}.observe.type must be one of: ${validObserveTypes.join(', ')}`);
  }

  // If type is message_received, content is expected
  if (group.observe.type === 'message_received' && !group.observe.content) {
    throw new Error(`${prefix}.observe.content is required when type is 'message_received'`);
  }

  // Check block is optional but if present must be valid
  if (group.check) {
    if (!Array.isArray(group.check)) {
      throw new Error(`${prefix}.check must be an array`);
    }
    group.check.forEach((check, cIndex) => {
      if (!check.type) {
        throw new Error(`${prefix}.check[${cIndex}].type is required`);
      }
      const validCheckTypes = ['user_defined', 'system', 'segment'];
      if (!validCheckTypes.includes(check.type)) {
        throw new Error(`${prefix}.check[${cIndex}].type must be one of: ${validCheckTypes.join(', ')}`);
      }
    });
  }

  // Actions block is optional
  if (group.actions) {
    if (!Array.isArray(group.actions)) {
      throw new Error(`${prefix}.actions must be an array`);
    }
  }
}

/**
 * Validate hours of operation configuration.
 */
function validateHoursOfOperation(hoursConfig) {
  if (!Array.isArray(hoursConfig)) {
    throw new Error('hoursOfOperation must be an array');
  }

  hoursConfig.forEach((override, index) => {
    const prefix = `hoursOfOperation[${index}]`;

    if (!override.name || typeof override.name !== 'string') {
      throw new Error(`${prefix}.name is required`);
    }

    if (!override.hoursOfOperationId || typeof override.hoursOfOperationId !== 'string') {
      throw new Error(`${prefix}.hoursOfOperationId is required`);
    }

    // applyTo specifies which test cases get this override
    if (override.applyTo && !Array.isArray(override.applyTo)) {
      throw new Error(`${prefix}.applyTo must be an array of test case names`);
    }
  });
}

/**
 * Validate a required field exists with the correct type.
 */
function validateRequiredField(obj, field, expectedType) {
  if (obj[field] === undefined || obj[field] === null) {
    throw new Error(`'${field}' is required in configuration`);
  }

  if (expectedType === 'array' && !Array.isArray(obj[field])) {
    throw new Error(`'${field}' must be an array`);
  } else if (expectedType !== 'array' && typeof obj[field] !== expectedType) {
    throw new Error(`'${field}' must be of type ${expectedType}`);
  }
}

module.exports = { loadAndValidateConfig };
