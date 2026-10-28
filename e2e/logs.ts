import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');

export const SERVICES = ['api', 'worker', 'collab', 'web'] as const;
export type Service = (typeof SERVICES)[number];

/** One structured log line (pino JSON). */
export interface LogLine {
  level: number;
  time: number;
  msg?: string;
  event?: string;
  correlationId?: string;
  [field: string]: unknown;
}

interface ServiceLogs {
  /** Everything the service printed, as text. */
  raw: string;
  /** The lines that are JSON objects. */
  lines: LogLine[];
}

/** The output of a compose service since `since`; the stack is the one the suite runs against. */
export async function logsOf(service: Service, since: Date): Promise<ServiceLogs> {
  const { stdout, stderr } = await run(
    'docker',
    ['compose', 'logs', '--no-color', '--no-log-prefix', '--since', since.toISOString(), service],
    { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 },
  );
  const raw = `${stdout}\n${stderr}`;
  const lines: LogLine[] = [];
  for (const text of stdout.split('\n')) {
    if (!text.startsWith('{')) continue;
    try {
      lines.push(JSON.parse(text) as LogLine);
    } catch {
      // a line that merely starts with a brace
    }
  }
  return { raw, lines };
}
