import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentThread,
  BackendProbe,
  GenerateSessionTitleOptions,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import { agyVersionAsync, resolveAgyBin } from './locate';
import { AntigravityThread } from './thread';

const AGY_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const STATIC_MODELS: ModelInfo[] = [
  {
    id: 'gemini-4-neon-medium',
    displayName: 'Gemini 4 Neon (Medium)',
    description: 'Antigravity 默认均衡模型',
    supportedEfforts: AGY_EFFORTS,
    defaultEffort: 'medium',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'gemini-4-neon-high',
    displayName: 'Gemini 4 Neon (High)',
    description: '高推理强度，复杂工程任务',
    supportedEfforts: AGY_EFFORTS,
    defaultEffort: 'high',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'gemini-3.8-flash-medium',
    displayName: 'Gemini 3.8 Flash (Medium)',
    description: '快速响应，日常轻量任务',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'claude-sonnet-5-5-medium',
    displayName: 'Claude Sonnet 5.5 (Medium)',
    description: 'Antigravity 内置 Claude Sonnet',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'claude-opus-5-5-medium',
    displayName: 'Claude Opus 5.5 (Medium)',
    description: 'Antigravity 内置 Claude Opus',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    isDefault: false,
    hidden: false,
  },
];

/**
 * Parse `agy models` stdout (`<id>\t<Display Name>` per line) into bridge ModelInfo[].
 * Exported for unit testing.
 */
export function parseAgyModelsOutput(stdout: string): ModelInfo[] {
  const rows: { id: string; displayName: string }[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes('\t')) continue;
    const [id, ...rest] = line.split('\t');
    const cleanId = id?.trim();
    const displayName = rest.join('\t').trim();
    if (!cleanId || !displayName) continue;
    rows.push({ id: cleanId, displayName });
  }
  if (!rows.length) return [];

  const preferredIdx = rows.findIndex((r) => r.id === 'gemini-4-neon-medium');
  const defaultIdx = preferredIdx >= 0 ? preferredIdx : 0;

  return rows.map((row, index) => {
    const effortMatch = row.id.match(/-(low|medium|high|xhigh|max)$/i);
    const defaultEffort = (effortMatch?.[1]?.toLowerCase() as ReasoningEffort | undefined) ?? 'medium';
    return {
      id: row.id,
      displayName: row.displayName,
      description: 'Antigravity CLI',
      supportedEfforts: effortMatch ? [defaultEffort] : AGY_EFFORTS,
      defaultEffort,
      isDefault: index === defaultIdx,
      hidden: false,
    };
  });
}

/**
 * Create an empty Antigravity conversation and read its `conversation_id` from
 * the first `init` event (zero LLM tokens, exits immediately on stdin EOF).
 */
export async function createEmptyConversation(bin: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnProcess(
      bin,
      ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Close stdin right away so agy emits `init` and exits cleanly with 0 tokens.
    child.stdin?.end();

    let buf = '';
    let stderr = '';
    let settled = false;
    const done = (err: Error | null, id?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(id!);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(new Error('Antigravity 初始化会话超时（15s）'));
    }, 15_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as { event?: string; conversation_id?: string };
            if (parsed.event === 'init' && parsed.conversation_id) {
              done(null, parsed.conversation_id);
              return;
            }
          } catch {
            /* ignore non-JSON lines */
          }
        }
        nl = buf.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => done(err instanceof Error ? err : new Error(String(err))));
    child.on('close', (code) => {
      done(
        new Error(
          `Antigravity 初始化会话失败（code=${code ?? 'null'}）${stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : ''}`,
        ),
      );
    });
  });
}

const MODEL_CACHE_TTL_MS = 60_000;

/**
 * Antigravity CLI (`agy`) backend — drives Google Antigravity via its native
 * `agy --output-format stream-json -r <conversation_id>` interface.
 */
export class AntigravityCliBackend implements AgentBackend {
  readonly id = 'antigravity-cli';
  readonly displayName = 'Antigravity';
  private modelCache: { models: ModelInfo[]; expiresAt: number } | null = null;

  readonly capabilities: AgentCapabilities = {
    goal: true,
    steer: false,
    compact: false,
    resume: false,
    approvals: false,
  };

  readonly supportedModes: readonly PermissionMode[] = ['qa', 'write', 'full'];

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(opts?: { force?: boolean }): Promise<BackendProbe> {
    const bin = resolveAgyBin(opts);
    if (!bin) {
      return {
        ok: false,
        version: null,
        depState: 'external-missing',
        hint: '未找到 agy CLI（确认已安装 Antigravity CLI，或设置 AGY_BIN 指向 agy 可执行文件）',
      };
    }
    const version = await agyVersionAsync(bin, opts);
    if (!version) {
      return {
        ok: false,
        version: null,
        location: bin,
        depState: 'external-missing',
        hint: `找到 ${bin}，但 \`agy --version\` 执行失败`,
      };
    }
    return {
      ok: true,
      version,
      location: bin,
      depState: 'installed',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() < this.modelCache.expiresAt) {
      return this.modelCache.models;
    }
    const bin = resolveAgyBin();
    if (!bin) return STATIC_MODELS;

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawnProcess(bin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          reject(new Error('agy models timed out'));
        }, 10_000);
        child.stdout?.on('data', (c: Buffer) => {
          out += c.toString('utf8');
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(`agy models exited with code ${code ?? 'null'}`));
        });
      });
      const parsed = parseAgyModelsOutput(stdout);
      if (!parsed.length) return STATIC_MODELS;
      this.modelCache = { models: parsed, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
      return parsed;
    } catch (err) {
      log.fail('agent', err, { backend: 'antigravity-cli', phase: 'listModels' });
      return STATIC_MODELS;
    }
  }

  async listThreads(_cwd: string, _limit = 15): Promise<ThreadSummary[]> {
    return [];
  }

  async readHistory(_cwd: string, _sessionId: string, _maxTurns = 10): Promise<ThreadHistory> {
    return { turns: [], totalTurns: 0 };
  }

  async generateSessionTitle(opts: GenerateSessionTitleOptions): Promise<string | undefined> {
    const bin = resolveAgyBin();
    if (!bin) throw new Error('未找到 agy CLI');

    const args = ['--output-format', 'stream-json', '--disable-slash-commands'];
    if (opts.model) args.push('--model', opts.model);
    args.push(`-p=${opts.prompt}`);

    return new Promise<string | undefined>((resolve, reject) => {
      const child = spawnProcess(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      let responseText: string | undefined;
      let errText: string | undefined;
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        reject(new Error('Antigravity title generation timed out'));
      }, 30_000);

      child.stdout?.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              const m = JSON.parse(line) as {
                event?: string;
                result?: { status?: string; response?: string; error?: string };
              };
              if (m.event === 'result' && m.result) {
                if (m.result.status && m.result.status !== 'SUCCESS') {
                  errText = m.result.error || `status=${m.result.status}`;
                } else if (typeof m.result.response === 'string') {
                  responseText = m.result.response.trim() || undefined;
                }
              }
            } catch {
              /* ignore */
            }
          }
          nl = buf.indexOf('\n');
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (errText) reject(new Error(errText));
        else if (code === 0 || responseText !== undefined) resolve(responseText);
        else reject(new Error(`agy title generation exited with code ${code ?? 'null'}`));
      });
    });
  }

  private assertMode(mode: PermissionMode | undefined): PermissionMode {
    const resolved = mode ?? 'full';
    if (!this.supportedModes.includes(resolved)) {
      throw new Error(`antigravity-cli 后端不支持权限档「${resolved}」`);
    }
    return resolved;
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const mode = this.assertMode(opts.mode);
    const bin = resolveAgyBin();
    if (!bin) {
      throw new Error('未找到 agy CLI（请确认已安装 Antigravity CLI，或设置 AGY_BIN）');
    }
    const sessionId = await createEmptyConversation(bin, opts.cwd);
    return new AntigravityThread({
      sessionId,
      bin,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      mode,
      isNew: true,
    });
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const mode = this.assertMode(opts.mode);
    const bin = resolveAgyBin();
    if (!bin) {
      throw new Error('未找到 agy CLI（请确认已安装 Antigravity CLI，或设置 AGY_BIN）');
    }
    return new AntigravityThread({
      sessionId: opts.sessionId,
      bin,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      mode,
      isNew: false,
    });
  }
}
