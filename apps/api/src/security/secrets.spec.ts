import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** `KEY=value  # comment` lines of an env file. */
function parseEnv(file: string): Array<[string, string]> {
  return read(file)
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const [key, ...rest] = line.split('=');
      return [
        key as string,
        rest
          .join('=')
          .replace(/\s+#.*$/, '')
          .trim(),
      ];
    });
}

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|ACCESS_KEY)/;
const secretsOf = (entries: Array<[string, string]>) =>
  entries.filter(([key]) => SECRET_NAME.test(key));

/** `NAME: value` lines of a compose file whose name says it is a secret. */
function composeSecrets(file: string): Array<[string, string]> {
  const named = /^\s*([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|ACCESS_KEY)[A-Z0-9_]*):\s*(.+)$/;
  return read(file)
    .split('\n')
    .map((line) => named.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1] as string, match[2] as string]);
}

describe('secrets in the repository', () => {
  it('keeps only marked placeholders in .env.example', () => {
    const entries = parseEnv('.env.example');
    const secrets = secretsOf(entries);
    expect(secrets.length).toBeGreaterThanOrEqual(8);
    // empty (an optional credential) or a value the services refuse to start with outside dev and test
    const real = secrets.filter(([, value]) => value !== '' && !value.includes('dev-only'));
    expect(real).toEqual([]);
    // the URL that embeds the database password carries the placeholder, too
    expect(entries.find(([key]) => key === 'DATABASE_URL')?.[1]).toContain('dev-only');
  });

  it('leaves every secret empty in the staging template', () => {
    const entries = parseEnv('.env.staging.example');
    expect(secretsOf(entries).length).toBeGreaterThanOrEqual(8);
    expect(secretsOf(entries).filter(([, value]) => value !== '')).toEqual([]);
    expect(entries.find(([key]) => key === 'DATABASE_URL')?.[1]).toContain('<POSTGRES_PASSWORD>');
  });

  it('gives a secret a development default in compose and none in the staging override', () => {
    const dev = composeSecrets('docker-compose.yml');
    expect(dev.length).toBeGreaterThan(5);
    const withRealDefault = dev.filter(([, value]) => {
      const fallback = /\$\{[A-Z0-9_]+:-([^}]*)\}/.exec(value)?.[1];
      return fallback !== undefined && fallback !== '' && !fallback.includes('dev-only');
    });
    expect(withRealDefault).toEqual([]);

    const staging = composeSecrets('docker-compose.staging.yml');
    expect(staging.length).toBeGreaterThan(5);
    // every secret is required (`${NAME:?message}`) or passed on as it is; none falls back to a default
    const withDefault = staging.filter(([, value]) => value.includes(':-') || !/\$\{/.test(value));
    expect(withDefault).toEqual([]);
  });

  const SKIP = new Set([
    'node_modules',
    '.next',
    'dist',
    'generated',
    'coverage',
    'test-results',
    'playwright-report',
    '.git',
    'graphify-out',
    '.serena',
    '.claude',
  ]);
  const SELF = path.join(ROOT, 'apps/api/src/security/secrets.spec.ts');
  function files(dir: string, found: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) || name === 'pnpm-lock.yaml') continue;
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) files(full, found);
      else if (
        stat.size < 1_000_000 &&
        full !== SELF &&
        !/\.(png|jpe?g|gif|webp|ico|woff2?|zip)$/i.test(name)
      ) {
        found.push(full);
      }
    }
    return found;
  }

  // the shapes of credentials that providers issue; written so that this file does not match itself
  const KEY_SHAPES: Array<[string, RegExp]> = [
    ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
    ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ['a Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
    ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
    ['a signed JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/],
  ];

  it('looks at the files it is meant to look at', () => {
    const all = files(ROOT).map((file) => path.relative(ROOT, file));
    expect(all).toEqual(
      expect.arrayContaining(['.env.example', 'docker-compose.yml', 'README.md']),
    );
    expect(all.some((file) => file.includes('node_modules'))).toBe(false);
  });

  it.each(KEY_SHAPES)('has no file that contains %s', (_name, pattern) => {
    const offenders = files(ROOT)
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('would notice what it looks for', () => {
    const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    expect(KEY_SHAPES[1]![1].test(`key=${awsKey}`)).toBe(true);
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijk'].join('.');
    expect(KEY_SHAPES[5]![1].test(jwt)).toBe(true);
  });
});
