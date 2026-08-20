/**
 * Hours of Operation Override Logic
 *
 * Applies hours-of-operation resource overrides to test case interaction groups.
 * This enables testing after-hours scenarios regardless of the actual time of day.
 *
 * The override injects an "override_resources" action into the first interaction
 * group of applicable test cases, pointing the HoursOfOperation to a specified
 * alternate resource.
 */

/**
 * Apply hours of operation overrides to test cases.
 *
 * @param {Array} testCases - Array of test case definitions
 * @param {Array} hoursOverrides - Array of hours of operation override configs
 * @returns {Array} Test cases with overrides applied (deep cloned)
 */
function applyHoursOverrides(testCases, hoursOverrides) {
  if (!hoursOverrides || hoursOverrides.length === 0) {
    return testCases.map(tc => ({ ...tc, hasHoursOverride: false }));
  }

  return testCases.map(tc => {
    const processed = JSON.parse(JSON.stringify(tc)); // deep clone
    let hasOverride = false;

    for (const override of hoursOverrides) {
      // Check if this override applies to this test case
      const applies = shouldApplyOverride(override, tc);

      if (applies) {
        injectHoursOverride(processed, override);
        hasOverride = true;
      }
    }

    processed.hasHoursOverride = hasOverride;
    return processed;
  });
}

/**
 * Determine if an hours override should be applied to a given test case.
 *
 * @param {object} override - The hours override config
 * @param {object} testCase - The test case
 * @returns {boolean}
 */
function shouldApplyOverride(override, testCase) {
  // If applyTo is specified, only apply to listed test cases
  if (override.applyTo && override.applyTo.length > 0) {
    return override.applyTo.includes(testCase.name);
  }

  // If no applyTo specified, apply to all test cases
  return true;
}

/**
 * Inject the hours of operation override into a test case's first interaction group.
 *
 * This adds an override_resources action that replaces the default HoursOfOperation
 * resource with the specified alternate one during test execution.
 *
 * @param {object} testCase - The test case to modify (mutated in place)
 * @param {object} override - The hours override config
 */
function injectHoursOverride(testCase, override) {
  if (!testCase.interactionGroups || testCase.interactionGroups.length === 0) {
    return;
  }

  // Find the first interaction group (typically test_started) to inject the override
  const targetGroup = testCase.interactionGroups[0];

  // Ensure actions array exists
  if (!targetGroup.actions) {
    targetGroup.actions = [];
  }

  // Add the override_resources action for HoursOfOperation
  const overrideAction = {
    type: 'override_resources',
    resource_type: 'HoursOfOperation',
    resource_id: override.hoursOfOperationId,
    description: `After-hours override: ${override.name}`
  };

  // Insert at the beginning of actions so it takes effect before other actions
  targetGroup.actions.unshift(overrideAction);
}

/**
 * Build the Connect API test content JSON that includes hours override.
 * This formats the override for the actual API Content payload.
 *
 * @param {object} overrideAction - The override action object
 * @returns {object} Formatted for Connect Testing Language
 */
function formatOverrideForApi(overrideAction) {
  return {
    type: 'override_resources',
    parameters: {
      resource_type: overrideAction.resource_type,
      resource_id: overrideAction.resource_id
    }
  };
}

module.exports = { applyHoursOverrides, formatOverrideForApi };
