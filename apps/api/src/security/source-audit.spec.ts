import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The lint rules forbid the sinks below; this scan is the second pair of eyes: it also fails when somebody turns the
 * rule off for a line, and it covers files that ESLint is not told about (scripts, configs).
 */
const ROOT = path.resolve(__dirname, '../../../..');
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'generated',
  'coverage',
  'test-results',
]);
const SOURCE = /\.(ts|tsx|js|mjs)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$|[\\/]testing[\\/]|[\\/]e2e[\\/]/;

function sources(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (SOURCE.test(name) && !TEST_FILE.test(full)) found.push(full);
  }
  return found;
}

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/ },
  { name: 'unsafe raw SQL', pattern: /\$(query|execute)RawUnsafe/ },
  { name: 'Prisma.raw', pattern: /Prisma\.raw\b/ },
  { name: 'assigned HTML', pattern: /\.(innerHTML|outerHTML)\s*=[^=]/ },
  { name: 'eval', pattern: /(^|[^\w.])eval\s*\(|new\s+Function\s*\(/ },
  {
    name: 'a lint rule switched off',
    pattern:
      /eslint-disable[^\n]*(no-danger|no-restricted-syntax|no-eval|no-implied-eval|no-new-func)/,
  },
  // a template literal that starts like a statement, has a value spliced in and is not behind a tag (`$queryRaw<T>` too)
  {
    name: 'SQL built from a template literal',
    pattern:
      /(?<![\w$.)>])`\s*(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[^`]*\$\{[^`]*`/i,
  },
  {
    name: 'SQL concatenated from strings',
    pattern: /['"]\s*(SELECT|INSERT\s+INTO|DELETE\s+FROM)\b[^'"\n]*['"]\s*\+/i,
  },
];

describe('source audit', () => {
  const files = ['apps', 'packages'].flatMap((dir) => sources(path.join(ROOT, dir)));

  it('looks at the code it is meant to look at', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((file) => file.endsWith(path.join('documents', 'documents.service.ts'))),
    ).toBe(true);
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(files.some((file) => TEST_FILE.test(file))).toBe(false);
  });

  it.each(FORBIDDEN)('finds no $name in production code', ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['SQL built from a template literal', 'const q = `SELECT * FROM t WHERE id = ${id}`;'],
    ['SQL concatenated from strings', 'const q = "SELECT * FROM t WHERE id = " + id;'],
    ['a lint rule switched off', '// eslint-disable-next-line react/no-danger'],
    ['assigned HTML', 'node.innerHTML = value;'],
  ])('would notice %s', (name, line) => {
    const rule = FORBIDDEN.find((candidate) => candidate.name === name);
    expect(rule?.pattern.test(line)).toBe(true);
  });

  it('leaves tagged templates alone', () => {
    const tagged =
      'await this.prisma.$queryRaw`SELECT 1 WHERE id = ${id}`; Prisma.sql`SELECT ${x}`';
    expect(
      FORBIDDEN.some(({ name, pattern }) => name.startsWith('SQL') && pattern.test(tagged)),
    ).toBe(false);
  });
});
