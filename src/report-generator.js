/**
 * HTML Report Generator
 *
 * Generates a detailed HTML report showing:
 *   - Overall pass/fail summary
 *   - Per-test-case results with observation details
 *   - Failure location information (which interaction group/observation failed)
 *   - Hours of operation override indicators
 *   - Timing information
 */

const fs = require('fs');
const path = require('path');

/**
 * Generate the HTML regression test report.
 *
 * @param {object} options
 * @param {Array} options.results - Test execution results
 * @param {object} options.suiteConfig - Original suite configuration
 * @param {string} options.outputDir - Directory to write the report
 * @param {Date} options.startTime - Suite start time
 * @param {Date} options.endTime - Suite end time
 * @param {string} options.region - AWS region
 * @returns {string} Path to the generated report file
 */
function generateHtmlReport(options) {
  const { results, suiteConfig, outputDir, startTime, endTime, region } = options;

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const totalTests = results.length;
  const passedTests = results.filter(r => r.status === 'PASSED').length;
  const failedTests = results.filter(r => r.status === 'FAILED').length;
  const stoppedTests = results.filter(r => r.status === 'STOPPED').length;
  const duration = ((endTime - startTime) / 1000).toFixed(1);
  const passRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0.0';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Contact Flow Regression Report — ${new Date().toLocaleDateString()}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f7fa;
      color: #1a1a2e;
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
      padding: 2rem;
      border-radius: 12px;
      margin-bottom: 2rem;
    }
    header h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
    header .subtitle { opacity: 0.8; font-size: 0.95rem; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .summary-card {
      background: white;
      padding: 1.5rem;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      text-align: center;
    }
    .summary-card .value {
      font-size: 2.5rem;
      font-weight: 700;
    }
    .summary-card .label {
      font-size: 0.85rem;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .value.pass { color: #10b981; }
    .value.fail { color: #ef4444; }
    .value.stop { color: #f59e0b; }
    .value.total { color: #3b82f6; }
    .test-results { margin-bottom: 2rem; }
    .test-results h2 {
      font-size: 1.4rem;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid #e5e7eb;
    }
    .test-card {
      background: white;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      margin-bottom: 1rem;
      overflow: hidden;
    }
    .test-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.5rem;
      cursor: pointer;
      user-select: none;
    }
    .test-card-header:hover { background: #f9fafb; }
    .test-card-header .test-name {
      font-weight: 600;
      font-size: 1.05rem;
    }
    .test-card-header .test-meta {
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.85rem;
      color: #666;
    }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
    }
    .status-badge.passed { background: #d1fae5; color: #065f46; }
    .status-badge.failed { background: #fee2e2; color: #991b1b; }
    .status-badge.stopped { background: #fef3c7; color: #92400e; }
    .hours-badge {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.75rem;
      background: #ede9fe;
      color: #5b21b6;
      font-weight: 500;
    }
    .test-card-body {
      padding: 0 1.5rem 1.5rem;
      display: none;
      border-top: 1px solid #f3f4f6;
    }
    .test-card.expanded .test-card-body { display: block; padding-top: 1rem; }
    .observation-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
      margin-top: 0.5rem;
    }
    .observation-table th {
      text-align: left;
      padding: 0.6rem 0.8rem;
      background: #f9fafb;
      border-bottom: 1px solid #e5e7eb;
      font-weight: 600;
      color: #374151;
    }
    .observation-table td {
      padding: 0.6rem 0.8rem;
      border-bottom: 1px solid #f3f4f6;
      vertical-align: top;
    }
    .observation-table tr.failed-row { background: #fef2f2; }
    .observation-table tr.passed-row { background: #f0fdf4; }
    .record-detail {
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 0.8rem;
      background: #f8fafc;
      padding: 0.5rem;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
    }
    .prompt {
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 0.8rem;
      background: #f8fafc;
      border-left: 3px solid #94a3b8;
      padding: 0.5rem 0.6rem;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow-y: auto;
      color: #334155;
      max-width: 420px;
    }
    .error-message {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      margin-top: 0.5rem;
      color: #991b1b;
      font-size: 0.9rem;
    }
    .meta-info {
      font-size: 0.85rem;
      color: #6b7280;
      margin-top: 0.5rem;
    }
    .meta-info span { margin-right: 1.5rem; }
    footer {
      text-align: center;
      padding: 2rem;
      color: #9ca3af;
      font-size: 0.85rem;
    }
    .toggle-icon {
      transition: transform 0.2s;
      font-size: 1.2rem;
    }
    .test-card.expanded .toggle-icon { transform: rotate(90deg); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📞 Connect Contact Flow Regression Report</h1>
      <div class="subtitle">
        Instance: ${suiteConfig.instanceId} • Region: ${region}
        <br>Generated: ${new Date().toLocaleString()} • Duration: ${duration}s
      </div>
    </header>

    <div class="summary-grid">
      <div class="summary-card">
        <div class="value total">${totalTests}</div>
        <div class="label">Total Tests</div>
      </div>
      <div class="summary-card">
        <div class="value pass">${passedTests}</div>
        <div class="label">Passed</div>
      </div>
      <div class="summary-card">
        <div class="value fail">${failedTests}</div>
        <div class="label">Failed</div>
      </div>
      <div class="summary-card">
        <div class="value stop">${stoppedTests}</div>
        <div class="label">Stopped/Timeout</div>
      </div>
      <div class="summary-card">
        <div class="value" style="color: #6366f1">${passRate}%</div>
        <div class="label">Pass Rate</div>
      </div>
    </div>

    <div class="test-results">
      <h2>Test Case Results</h2>
      ${results.map((result, index) => generateTestCard(result, index)).join('\n')}
    </div>

    <footer>
      Amazon Connect Contact Flow Regression Testing Suite
    </footer>
  </div>

  <script>
    document.querySelectorAll('.test-card-header').forEach(header => {
      header.addEventListener('click', () => {
        header.parentElement.classList.toggle('expanded');
      });
    });
  </script>
</body>
</html>`;

  // Write report file
  const reportFilename = `regression-report-${timestamp}.html`;
  const reportPath = path.join(outputDir, reportFilename);
  fs.writeFileSync(reportPath, html, 'utf-8');

  // Also write a "latest" symlink
  const latestPath = path.join(outputDir, 'latest-report.html');
  fs.writeFileSync(latestPath, html, 'utf-8');

  return reportPath;
}

/**
 * Generate HTML for a single test card.
 */
function generateTestCard(result, index) {
  const statusClass = result.status.toLowerCase();
  const hoursTag = result.hasHoursOverride
    ? '<span class="hours-badge">🕐 After-Hours Override</span>'
    : '';

  const duration = result.duration ? `${result.duration}s` : 'N/A';
  const observationSummary = result.observationSummary || {};
  const totalObs = observationSummary.TotalObservations || 0;
  const passedObs = observationSummary.ObservationsPassed || 0;
  const failedObs = observationSummary.ObservationsFailed || 0;

  let bodyContent = '';

  // Error message if present
  if (result.error) {
    bodyContent += `<div class="error-message">⚠️ Error: ${escapeHtml(result.error)}</div>`;
  }

  // Meta information
  bodyContent += `
    <div class="meta-info">
      <span><strong>Flow ID:</strong> ${escapeHtml(result.flowId)}</span>
      <span><strong>Channel:</strong> ${result.channel}</span>
      <span><strong>Duration:</strong> ${duration}</span>
      <span><strong>Observations:</strong> ${passedObs}/${totalObs} passed</span>
    </div>`;

  // Execution records table
  if (result.executionRecords && result.executionRecords.length > 0) {
    bodyContent += `
    <table class="observation-table">
      <thead>
        <tr>
          <th>Step</th>
          <th>Observation</th>
          <th>Status</th>
          <th>Prompt</th>
          <th>Timestamp</th>
        </tr>
      </thead>
      <tbody>
        ${result.executionRecords.map((record, rIndex) => {
          const rowClass = record.Status === 'FAILED' ? 'failed-row' : record.Status === 'PASSED' ? 'passed-row' : '';
          const statusBadge = `<span class="status-badge ${record.Status?.toLowerCase() || ''}">${record.Status || 'UNKNOWN'}</span>`;
          const timestamp = record.Timestamp ? new Date(record.Timestamp).toLocaleTimeString() : 'N/A';
          const prompt = extractPrompt(record.Record);
          const promptCell = prompt
            ? `<div class="prompt">${escapeHtml(prompt)}</div>`
            : '<span style="color:#9ca3af;font-style:italic;">—</span>';

          return `
        <tr class="${rowClass}">
          <td>${rIndex + 1}</td>
          <td>${escapeHtml(record.ObservationId || `Step ${rIndex + 1}`)}</td>
          <td>${statusBadge}</td>
          <td>${promptCell}</td>
          <td>${timestamp}</td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  } else if (!result.error) {
    bodyContent += '<p style="color: #6b7280; margin-top: 0.5rem;">No detailed execution records available.</p>';
  }

  // Map interaction groups to show where failure occurred
  if (result.status === 'FAILED' && result.interactionGroups) {
    bodyContent += generateFailureLocationInfo(result);
  }

  return `
      <div class="test-card ${statusClass === 'failed' ? 'expanded' : ''}">
        <div class="test-card-header">
          <div>
            <span class="test-name">${escapeHtml(result.name)}</span>
            ${hoursTag}
          </div>
          <div class="test-meta">
            <span>${duration}</span>
            <span class="status-badge ${statusClass}">${result.status}</span>
            <span class="toggle-icon">▶</span>
          </div>
        </div>
        <div class="test-card-body">
          ${bodyContent}
        </div>
      </div>`;
}

/**
 * Generate failure location information showing which interaction group failed.
 */
function generateFailureLocationInfo(result) {
  const failedRecords = (result.executionRecords || []).filter(r => r.Status === 'FAILED');

  if (failedRecords.length === 0) {
    return '<div class="error-message">Test failed but no specific failure location recorded (possible timeout).</div>';
  }

  let html = '<div style="margin-top: 1rem; padding: 1rem; background: #fef2f2; border-radius: 8px;">';
  html += '<strong style="color: #991b1b;">📍 Failure Location(s):</strong><ul style="margin-top: 0.5rem; padding-left: 1.5rem;">';

  failedRecords.forEach(record => {
    const detail = record.Record ? tryParseRecordDetail(record.Record) : null;
    const location = record.ObservationId || 'Unknown Step';
    const reason = detail?.reason || detail?.message || 'See record details above';
    html += `<li style="margin-bottom: 0.3rem;"><strong>${escapeHtml(location)}</strong>: ${escapeHtml(reason)}</li>`;
  });

  html += '</ul></div>';
  return html;
}

/**
 * Try to parse a record detail string to extract failure reason.
 */
function tryParseRecordDetail(recordStr) {
  try {
    return JSON.parse(recordStr);
  } catch {
    return { message: recordStr };
  }
}

/**
 * Extract the prompt/message text a MessageReceived observation was validating.
 * Returns null for non-message steps (e.g., TestInitiated, Completion).
 */
function extractPrompt(recordStr) {
  if (!recordStr) return null;
  try {
    const d = JSON.parse(recordStr);
    const ev = d.Event || {};
    if (ev.Type === 'MessageReceived') {
      return (ev.Properties && (ev.Properties.Text || ev.Properties.SSML)) || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a record string for display.
 */
function formatRecord(recordStr) {
  try {
    const parsed = JSON.parse(recordStr);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return recordStr;
  }
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { generateHtmlReport };
