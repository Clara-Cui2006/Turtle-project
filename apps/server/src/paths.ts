import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TurtlePaths {
  root: string;
  database: string;
  settings: string;
  assets: string;
  recordings: string;
  backups: string;
  logs: string;
  imports: string;
}

export function getDataDir(): string {
  const configured = process.env.TURTLE_DATA_DIR;
  if (process.platform === 'win32' && !configured && !process.env.APPDATA) throw new Error('无法解析 Windows APPDATA，拒绝使用临时目录启动，以免产生第二份数据库。');
  const base = configured || (process.platform === 'win32'
    ? join(process.env.APPDATA!, 'TurtleProject')
    : join(process.env.XDG_DATA_HOME || join(process.env.HOME || tmpdir(), '.local', 'share'), 'TurtleProject'));
  mkdirSync(base, { recursive: true });
  return base;
}

export function getPaths(): TurtlePaths {
  const root = getDataDir();
  const paths = {
    root,
    database: join(root, 'turtle.db'),
    settings: join(root, 'local-settings.json'),
    assets: join(root, 'assets'),
    recordings: join(root, 'recordings'),
    backups: join(root, 'backups'),
    logs: join(root, 'logs'),
    imports: join(root, 'imports')
  };
  for (const directory of [paths.assets, paths.recordings, paths.backups, paths.logs, paths.imports]) mkdirSync(directory, { recursive: true });
  return paths;
}
