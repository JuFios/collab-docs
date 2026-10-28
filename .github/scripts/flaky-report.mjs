// Lists the Playwright tests that failed and then passed on a retry, with the first failure of each, so that a
// flake is looked at instead of being absorbed by the retry. Informational: it never fails a build.
// Usage: node .github/scripts/flaky-report.mjs <path to the JSON report>
import { existsSync, readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.log('### End-to-end flakiness\n\nNo report was written.');
  process.exit(0);
}

const report = JSON.parse(readFileSync(file, 'utf8'));
const flaky = [];
const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };

function walk(suite, trail) {
  const path = suite.title && !suite.file ? [...trail, suite.title] : trail;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      counts[test.status] = (counts[test.status] ?? 0) + 1;
      if (test.status !== 'flaky') continue;
      const failure = test.results.find((result) => result.status !== 'passed');
      const message = stripVTControlCharacters(failure?.error?.message ?? 'no message').split(
        '\n',
      )[0];
      flaky.push({
        where: `${spec.file}:${spec.line}`,
        title: [...path, spec.title].join(' › '),
        attempts: test.results.length,
        message,
      });
    }
  }
  for (const child of suite.suites ?? []) walk(child, path);
}
for (const suite of report.suites ?? []) walk(suite, []);

const lines = [
  '### End-to-end flakiness',
  '',
  `passed ${counts.expected} · flaky ${counts.flaky} · failed ${counts.unexpected} · skipped ${counts.skipped}`,
  '',
];
if (flaky.length === 0) {
  lines.push('No test needed a retry.');
} else {
  lines.push(
    'These tests passed only on a retry. Find the cause (a fixed sleep, a shared resource, an unawaited ' +
      'effect) and fix it; a retry is not a fix.',
    '',
    '| test | attempts | first failure |',
    '|---|---:|---|',
  );
  for (const item of flaky) {
    lines.push(
      `| \`${item.where}\` ${item.title} | ${item.attempts} | ${item.message.replace(/\|/g, '\\|')} |`,
    );
  }
}
console.log(lines.join('\n'));
