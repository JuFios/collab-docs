// Prints a Markdown table of the coverage the test runs left under apps/* and packages/*.
// Informational: it never fails a build. Usage: node .github/scripts/coverage-summary.mjs "<title>"
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const title = process.argv[2] ?? 'Coverage';
const METRICS = ['lines', 'statements', 'functions', 'branches'];

const workspaces = ['apps', 'packages'].flatMap((group) =>
  existsSync(group)
    ? readdirSync(group, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(group, entry.name))
    : [],
);

const rows = workspaces.flatMap((workspace) => {
  const file = path.join(workspace, 'coverage', 'coverage-summary.json');
  if (!existsSync(file)) return [];
  const { total } = JSON.parse(readFileSync(file, 'utf8'));
  return [[workspace, ...METRICS.map((metric) => `${total[metric].pct}%`)]];
});

const lines = [`### ${title}`, ''];
if (rows.length === 0) {
  lines.push('No coverage was collected.');
} else {
  lines.push(
    `| package | ${METRICS.join(' | ')} |`,
    `|---|${METRICS.map(() => '---:').join('|')}|`,
  );
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
}
console.log(lines.join('\n'));
