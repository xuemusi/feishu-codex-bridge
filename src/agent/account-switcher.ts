import { exec } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AccountSwitcherConfig } from '../config/schema';

const execAsync = promisify(exec);

export interface AccountQuotaSummary {
  /** Gemini Pro / Neon remaining % (0-100) */
  geminiPro?: number;
  /** Claude Opus / Sonnet remaining % (0-100) */
  claude?: number;
  /** Gemini Flash remaining % (0-100) */
  flash?: number;
  /** Short one-line summary for select options, e.g. "G:100% C:80% F:100%" */
  shortText: string;
}

export interface AccountEntry {
  id: string;
  label: string;
  active: boolean;
  quota?: AccountQuotaSummary;
}

export interface SwitchAccountResult {
  ok: boolean;
  output: string;
}

export type ResolvedAccountSwitcher =
  | { kind: 'cli'; cfg: AccountSwitcherConfig }
  | { kind: 'cockpit'; wsPort: number };

const SAFE_ACCOUNT_ID = /^[a-zA-Z0-9._@+-]{1,128}$/;

/** Read only the documented `ws_port` from `~/.antigravity_cockpit/server.json`. */
export function resolveCockpitWsPort(): number | null {
  const statusFile = join(homedir(), '.antigravity_cockpit', 'server.json');
  if (!existsSync(statusFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(statusFile, 'utf8')) as { ws_port?: unknown };
    if (typeof raw.ws_port === 'number' && raw.ws_port > 0 && raw.ws_port < 65536) {
      return raw.ws_port;
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve account switcher config: explicit CLI config first, then env fallback. */
export function resolveAccountSwitcherConfig(
  pref?: AccountSwitcherConfig,
): AccountSwitcherConfig | undefined {
  const listCmd = pref?.listCmd?.trim() || process.env.AGY_ACCOUNT_LIST_CMD?.trim();
  const switchCmd = pref?.switchCmd?.trim() || process.env.AGY_ACCOUNT_SWITCH_CMD?.trim();
  if (!listCmd || !switchCmd) return undefined;
  return { listCmd, switchCmd };
}

/** Resolve the active switcher provider (explicit CLI > local Cockpit Tools WS). */
export function resolveAccountSwitcher(
  pref?: AccountSwitcherConfig,
): ResolvedAccountSwitcher | undefined {
  const cli = resolveAccountSwitcherConfig(pref);
  if (cli) return { kind: 'cli', cfg: cli };
  const wsPort = resolveCockpitWsPort();
  if (wsPort) return { kind: 'cockpit', wsPort };
  return undefined;
}

/**
 * Parse stdout from `listCmd`. Supports:
 *   1. JSON array of strings or `{ id/name/email, label?, active/current? }`
 *   2. Plain text lines (one account per line; leading `* ` or `(active)` marks active)
 */
export function parseAccountListOutput(stdout: string): AccountEntry[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { accounts?: unknown })?.accounts)
          ? (parsed as { accounts: unknown[] }).accounts
          : [];
      const out: AccountEntry[] = [];
      for (const item of arr) {
        if (typeof item === 'string' && item.trim()) {
          const id = item.trim();
          out.push({ id, label: id, active: false });
        } else if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const id = String(obj.id ?? obj.name ?? obj.email ?? '').trim();
          if (!id) continue;
          const label = String(obj.label ?? obj.displayName ?? id).trim() || id;
          const active = Boolean(obj.active ?? obj.current ?? obj.isActive);
          out.push({ id, label, active });
        }
      }
      if (out.length) return out;
    } catch {
      /* fall through to plain text */
    }
  }

  const out: AccountEntry[] = [];
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let active = false;
    let clean = line;
    if (/^[*✓✅>]\s*/.test(clean)) {
      active = true;
      clean = clean.replace(/^[*✓✅>]\s*/, '').trim();
    }
    if (/\((active|current)\)$/i.test(clean)) {
      active = true;
      clean = clean.replace(/\((active|current)\)$/i, '').trim();
    }
    const token = clean.split(/\s+/)[0]?.trim();
    if (!token) continue;
    out.push({ id: token, label: clean, active });
  }
  return out;
}

interface CockpitWsMessage {
  type?: string;
  payload?: Record<string, unknown>;
}

interface CockpitAccountInfo {
  id?: string;
  email?: string;
  name?: string | null;
  is_current?: boolean;
  disabled?: boolean;
  subscription_tier?: string | null;
}

interface CockpitQuotaModel {
  displayName?: string;
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
}

/** Extract compact Gemini Pro / Claude / Flash remaining percentages from Cockpit quota cache. */
export function summarizeCockpitQuota(models: Record<string, CockpitQuotaModel>): AccountQuotaSummary | undefined {
  let geminiPro: number | undefined;
  let claude: number | undefined;
  let flash: number | undefined;

  for (const [rawKey, info] of Object.entries(models)) {
    const frac = info?.quotaInfo?.remainingFraction;
    if (typeof frac !== 'number' || Number.isNaN(frac)) continue;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    const key = rawKey.toLowerCase();

    if (key.includes('claude')) {
      claude = claude === undefined ? pct : Math.min(claude, pct);
    } else if (key.includes('neon') || key.includes('carbon') || key.includes('argon') || key.includes('pro')) {
      geminiPro = geminiPro === undefined ? pct : Math.min(geminiPro, pct);
    } else if (key.includes('flash') && !key.includes('image')) {
      flash = flash === undefined ? pct : Math.min(flash, pct);
    }
  }

  const parts: string[] = [];
  if (geminiPro !== undefined) parts.push(`G:${geminiPro}%`);
  if (claude !== undefined) parts.push(`C:${claude}%`);
  if (flash !== undefined) parts.push(`F:${flash}%`);
  if (!parts.length) return undefined;
  return { geminiPro, claude, flash, shortText: parts.join(' ') };
}

/** Read only the non-credential quota cache JSON written by Cockpit Tools. */
function readCockpitQuotaForEmail(email: string): AccountQuotaSummary | undefined {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const hash = createHash('sha256').update(normalized).digest('hex');
  const cacheBase = join(homedir(), '.antigravity_cockpit', 'cache', 'quota_api_v1_desktop');
  for (const source of ['authorized', 'custom']) {
    const file = join(cacheBase, source, `${hash}.json`);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        payload?: { models?: Record<string, CockpitQuotaModel> };
      };
      if (parsed.payload?.models) {
        return summarizeCockpitQuota(parsed.payload.models);
      }
    } catch {
      /* ignore corrupt/partial cache */
    }
  }
  return undefined;
}

/** Map Cockpit Tools `response.accounts` payload into bridge AccountEntry[]. */
export function mapCockpitAccounts(
  accounts: CockpitAccountInfo[],
  currentId?: string | null,
  quotaReader: (email: string) => AccountQuotaSummary | undefined = readCockpitQuotaForEmail,
): AccountEntry[] {
  return accounts
    .filter((a) => typeof a.id === 'string' && a.id.trim().length > 0 && !a.disabled)
    .map((a) => {
      const id = a.id!.trim();
      const email = (a.email ?? id).trim();
      const tier = a.subscription_tier ? ` [${a.subscription_tier}]` : '';
      const active = Boolean(a.is_current || (currentId && currentId === id));
      const quota = a.email ? quotaReader(a.email) : undefined;
      return { id, label: `${email}${tier}`, active, quota };
    });
}

function cockpitWsRequest<T>(
  wsPort: number,
  request: CockpitWsMessage,
  match: (msg: CockpitWsMessage) => { done: true; value: T } | { done: true; error: string } | { done: false },
  timeoutMs = 12_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    let settled = false;
    const finish = (err: Error | null, val?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(val as T);
    };

    const timer = setTimeout(() => {
      finish(new Error('连接 Cockpit Tools 超时（请确认 Cockpit Tools 正在运行）'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify(request));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.addEventListener('message', (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const msg = JSON.parse(text) as CockpitWsMessage;
        const res = match(msg);
        if (res.done) {
          if ('error' in res) finish(new Error(res.error));
          else finish(null, res.value);
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.addEventListener('error', () => {
      finish(new Error(`无法连接 Cockpit Tools 本地服务（ws://127.0.0.1:${wsPort}），请确认 Cockpit Tools 已启动`));
    });

    ws.addEventListener('close', () => {
      if (!settled) finish(new Error('Cockpit Tools 连接提前关闭'));
    });
  });
}

async function listAccountsFromCockpit(wsPort: number): Promise<AccountEntry[]> {
  const requestId = `fcb-${randomUUID()}`;
  return cockpitWsRequest<AccountEntry[]>(
    wsPort,
    { type: 'request.get_accounts', payload: { request_id: requestId } },
    (msg) => {
      if (msg.type === 'response.accounts' && msg.payload?.request_id === requestId) {
        const rawList = Array.isArray(msg.payload.accounts)
          ? (msg.payload.accounts as CockpitAccountInfo[])
          : [];
        const currentId = typeof msg.payload.current_account_id === 'string'
          ? msg.payload.current_account_id
          : null;
        return { done: true, value: mapCockpitAccounts(rawList, currentId) };
      }
      if (msg.type === 'response.error' && msg.payload?.request_id === requestId) {
        return { done: true, error: String(msg.payload.error ?? 'Cockpit Tools 返回错误') };
      }
      return { done: false };
    },
  );
}

async function switchAccountViaCockpit(wsPort: number, accountIdOrEmail: string): Promise<SwitchAccountResult> {
  // Allow user to pass either Cockpit's internal account_id or email via `/account <email>`.
  let targetId = accountIdOrEmail.trim();
  const accounts = await listAccountsFromCockpit(wsPort);
  const byEmailOrId = accounts.find(
    (a) => a.id === targetId || a.label.toLowerCase().startsWith(targetId.toLowerCase()),
  );
  if (byEmailOrId) targetId = byEmailOrId.id;

  const requestId = `fcb-${randomUUID()}`;
  try {
    const message = await cockpitWsRequest<string>(
      wsPort,
      {
        type: 'request.switch_account',
        payload: {
          account_id: targetId,
          request_id: requestId,
        },
      },
      (msg) => {
        if (msg.type === 'event.account_switched') {
          const email = String(msg.payload?.email ?? targetId);
          return { done: true, value: `已通过 Cockpit Tools 切换到 ${email}` };
        }
        if (msg.type === 'response.success' && msg.payload?.request_id === requestId) {
          return { done: true, value: String(msg.payload.message ?? `已切换到 ${targetId}`) };
        }
        if (msg.type === 'event.switch_error') {
          return { done: true, error: String(msg.payload?.message ?? 'Cockpit Tools 切号失败') };
        }
        if (msg.type === 'response.error' && (!msg.payload?.request_id || msg.payload.request_id === requestId)) {
          return { done: true, error: String(msg.payload?.error ?? 'Cockpit Tools 返回错误') };
        }
        return { done: false };
      },
      20_000,
    );
    return { ok: true, output: message };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

export async function listAccounts(switcher: ResolvedAccountSwitcher): Promise<AccountEntry[]> {
  if (switcher.kind === 'cockpit') {
    return listAccountsFromCockpit(switcher.wsPort);
  }
  const { stdout } = await execAsync(switcher.cfg.listCmd, { timeout: 15_000, env: process.env });
  return parseAccountListOutput(stdout);
}

/** Validate account id strictly before substituting into switchCmd to prevent shell injection. */
export function buildSwitchCommand(template: string, accountId: string): string {
  const clean = accountId.trim();
  if (!SAFE_ACCOUNT_ID.test(clean)) {
    throw new Error(`账号标识包含不允许的字符：「${clean}」`);
  }
  if (!template.includes('{account}')) {
    return `${template} ${clean}`;
  }
  return template.replaceAll('{account}', clean);
}

export async function switchAccount(
  switcher: ResolvedAccountSwitcher,
  accountId: string,
): Promise<SwitchAccountResult> {
  if (switcher.kind === 'cockpit') {
    return switchAccountViaCockpit(switcher.wsPort, accountId);
  }
  const cmd = buildSwitchCommand(switcher.cfg.switchCmd, accountId);
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 20_000, env: process.env });
    const text = (stdout || stderr || '').trim();
    return { ok: true, output: text || `已切换到账号 ${accountId}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || String(err)).trim();
    return { ok: false, output: detail.slice(0, 400) };
  }
}
