#!/usr/bin/env node

/**
 * Amazon Connect Contact Flow Regression Testing Suite
 * Main CLI Entry Point
 *
 * Usage:
 *   node src/index.js [options]
 *
 * Options:
 *   --config <path>     Path to test suite configuration (default: ./tests/suite-config.json)
 *   --region <region>   AWS region (default: us-east-1)
 *   --dry-run           Validate configuration without executing tests
 *   --concurrency <n>   Max concurrent test executions (default: 5, max: 5)
 *   --output <path>     Output directory for reports (default: ./reports)
 */

const path = require('path');
const { loadAndValidateConfig } = require('./config-loader');
const { SimulationRunner } = require('./simulation-runner');
const { generateHtmlReport } = require('./report-generator');
const { applyHoursOverrides } = require('./hours-override');

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    config: './tests/suite-config.json',
    region: 'us-east-1',
    dryRun: false,
    concurrency: 5,
    output: './reports'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config':
        options.config = args[++i];
        break;
      case '--region':
        options.region = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--concurrency':
        options.concurrency = Math.min(parseInt(args[++i], 10), 5);
        break;
      case '--output':
        options.output = args[++i];
        break;
      case '--help':
        console.log(`
Amazon Connect Contact Flow Regression Testing Suite

Usage: node src/index.js [options]

Options:
  --config <path>     Path to test suite configuration (default: ./tests/suite-config.json)
  --region <region>   AWS region (default: us-east-1)
  --dry-run           Validate configuration without executing tests
  --concurrency <n>   Max concurrent test executions (default: 5, max: 5)
  --output <path>     Output directory for reports (default: ./reports)
  --help              Show this help message
`);
        process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();
  const startTime = new Date();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Amazon Connect Contact Flow Regression Testing Suite');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Config:      ${options.config}`);
  console.log(`  Region:      ${options.region}`);
  console.log(`  Concurrency: ${options.concurrency}`);
  console.log(`  Dry Run:     ${options.dryRun}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Step 1: Load and validate configuration
  console.log('[1/4] Loading and validating test configuration...');
  const configPath = path.resolve(process.cwd(), options.config);
  let suiteConfig;
  try {
    suiteConfig = loadAndValidateConfig(configPath);
    console.log(`      ✓ Loaded ${suiteConfig.testCases.length} test case(s)\n`);
  } catch (err) {
    console.error(`      ✗ Configuration error: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Apply hours of operation overrides
  console.log('[2/4] Processing hours of operation overrides...');
  const processedTestCases = applyHoursOverrides(suiteConfig.testCases, suiteConfig.hoursOfOperation);
  const overrideCount = processedTestCases.filter(tc => tc.hasHoursOverride).length;
  console.log(`      ✓ ${overrideCount} test case(s) have hours-of-operation overrides\n`);

  // Step 3: Execute tests (or validate in dry-run mode)
  if (options.dryRun) {
    console.log('[3/4] Dry run mode — skipping test execution');
    console.log('      ✓ Configuration is valid. Tests would execute successfully.\n');
    console.log('[4/4] Skipping report generation in dry-run mode.\n');
    console.log('Dry run complete. No tests were executed.');
    process.exit(0);
  }

  console.log('[3/4] Executing test simulations...');
  const runner = new SimulationRunner({
    region: options.region,
    instanceId: suiteConfig.instanceId,
    concurrency: options.concurrency
  });

  let results;
  try {
    results = await runner.executeAll(processedTestCases);
    const passed = results.filter(r => r.status === 'PASSED').length;
    const failed = results.filter(r => r.status === 'FAILED').length;
    const stopped = results.filter(r => r.status === 'STOPPED').length;
    console.log(`      ✓ Execution complete: ${passed} passed, ${failed} failed, ${stopped} stopped\n`);
  } catch (err) {
    console.error(`      ✗ Execution error: ${err.message}`);
    process.exit(1);
  }

  // Step 4: Generate HTML report
  console.log('[4/4] Generating HTML report...');
  const endTime = new Date();
  const reportPath = generateHtmlReport({
    results,
    suiteConfig,
    outputDir: path.resolve(process.cwd(), options.output),
    startTime,
    endTime,
    region: options.region
  });
  console.log(`      ✓ Report saved to: ${reportPath}\n`);

  // Summary
  const passed = results.filter(r => r.status === 'PASSED').length;
  const failed = results.filter(r => r.status === 'FAILED').length;
  const total = results.length;
  const duration = ((endTime - startTime) / 1000).toFixed(1);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed}/${total} passed | ${failed} failed | ${duration}s total`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Exit with non-zero if any tests failed
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
