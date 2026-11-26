import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnProcess, spawnProcessSync } from '../../platform/spawn';

const IS_WIN = process.platform === 'win32';

let binCache: string | null = null;
const versionCache = new Map<string, string>();

/**
 * Resolve the Antigravity CLI (`agy`) binary, in priority order:
 *   1. $AGY_BIN (explicit override)
 *   2. PATH (`agy`, via `where`/`which`)
 *   3. Common user/system install locations (~/.local/bin/agy, /opt/homebrew/bin/agy, /usr/local/bin/agy)
 *      so macOS launchd daemons (minimal PATH) still find it reliably.
 */
export function resolveAgyBin(opts?: { force?: boolean }): string | null {
  if (!opts?.force && binCache && existsSync(binCache)) return binCache;
  binCache = locateBin();
  return binCache;
}

function locateBin(): string | null {
  const env = process.env.AGY_BIN;
  if (env && existsSync(env)) return env;

  const onPath = which('agy');
  if (onPath) return onPath;

  const home = homedir();
  const candidates = IS_WIN
    ? [join(home, '.local', 'bin', 'agy.exe'), join(home, '.local', 'bin', 'agy.cmd')]
    : [
        join(home, '.local', 'bin', 'agy'),
        '/opt/homebrew/bin/agy',
        '/usr/local/bin/agy',
      ];

  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function which(cmd: string): string | null {
  try {
    const res = spawnProcessSync(IS_WIN ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const first = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/** Async version probe (`agy --version`) so card callbacks never block the event loop. */
export async function agyVersionAsync(bin: string, opts?: { force?: boolean }): Promise<string | null> {
  if (!opts?.force) {
    const hit = versionCache.get(bin);
    if (hit !== undefined) return hit;
  }
  const out = await new Promise<string | null>((resolve) => {
    let child;
    try {
      child = spawnProcess(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(null);
    }, 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code === 0) {
        const text = (stdout || stderr).trim().split('\n')[0]?.trim() || 'installed';
        done(text);
      } else {
        done(null);
      }
    });
  });
  if (out !== null) versionCache.set(bin, out);
  return out;
}
