import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function getDataDir(): string {
  const configured = process.env.TURTLE_DATA_DIR;
  const base = configured || (process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'TurtleProject')
    : join(process.env.XDG_DATA_HOME || join(process.env.HOME || tmpdir(), '.local', 'share'), 'TurtleProject'));
  mkdirSync(base, { recursive: true });
  return base;
}
