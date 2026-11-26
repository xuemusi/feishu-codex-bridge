import type { ChildProcess } from 'node:child_process';
import { log } from '../../core/logger';
import { spawnProcess } from '../../platform/spawn';
import type {
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  CompactResult,
  PermissionMode,
  ReasoningEffort,
  TurnOptions,
} from '../types';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../bridge-instructions';
import { createAgyTurnMapper, type AgyStreamMessage } from './event-map';
import { createEmptyConversation } from './backend';

/**
 * Detect whether a failed `agy -r <sessionId>` error looks like a stale or
 * cross-account conversation failure (e.g. user switched `agy` account) so we
 * can transparently mint a fresh conversation and retry the turn once.
 */
export function isRecoverableSessionError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes('conversation') ||
    s.includes('not found') ||
    s.includes('permission') ||
    s.includes('unauthorized') ||
    s.includes('unauthenticated') ||
    s.includes('forbidden') ||
    s.includes('access denied') ||
    s.includes('invalid session') ||
    s.includes('403') ||
    s.includes('404')
  );
}

export interface AgyThreadConfig {
  sessionId: string;
  bin: string;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  mode: PermissionMode;
  isNew: boolean;
}

type StreamItem =
  | { kind: 'msg'; msg: AgyStreamMessage }
  | { kind: 'close'; code: number | null; stderr: string }
  | { kind: 'error'; err: unknown };

class Inbox<T> {
  private readonly buf: T[] = [];
  private readonly waiters: ((v: T) => void)[] = [];
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.buf.push(v);
  }
  next(): Promise<T> {
    const v = this.buf.shift();
    if (v !== undefined) return Promise.resolve(v);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Map bridge ReasoningEffort to agy `--effort` values (`low|medium|high|xhigh|max`). */
function toAgyEffort(e: ReasoningEffort | undefined): string | undefined {
  if (!e) return undefined;
  if (e === 'none' || e === 'minimal') return 'low';
  if (e === 'ultra') return 'max';
  return e;
}

/**
 * Check whether an agy model id already encodes an effort suffix (e.g.
 * `gemini-4-neon-medium`, `claude-sonnet-5-5-high`). Passing `--effort` on top
 * of a suffixed model id can be rejected by `agy`, so only pass `--effort` when
 * the model id does not already carry one.
 */
function modelHasEffortSuffix(model: string | undefined): boolean {
  if (!model) return false;
  return /-(low|medium|high|xhigh|max)$/i.test(model);
}

function buildPromptText(input: AgentInput, includeBridgeHint: boolean): string {
  const parts: string[] = [];
  if (includeBridgeHint) {
    parts.push(`[Bridge Context]\n${BRIDGE_DEVELOPER_INSTRUCTIONS}`);
  }
  const text = (input.text ?? '').trim();
  if (text) parts.push(text);
  const images = input.images ?? [];
  if (images.length > 0) {
    parts.push(
      `[用户发送了本地图片，请使用 view_file 工具查看后再回答]\n${images.map((p) => `- ${p}`).join('\n')}`,
    );
  }
  return parts.join('\n\n') || '请继续';
}

function goalPrompt(objective: string): string {
  return [
    '【自主目标】请连续、自主地完成下面的目标：按需使用工具，一步步做到完成为止，',
    '中途不要停下来等我确认；完成后用一段话总结做了什么。',
    '',
    `目标：${objective}`,
  ].join('\n');
}

function bridgeAgyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.FEISHU_CODEX_BRIDGE = '1';
  return env;
}

/**
 * Antigravity CLI (`agy`) thread backed by per-turn `agy --output-format stream-json -r <sessionId>`.
 *
 * Why per-turn `-r` instead of a single long-lived process:
 *  - `agy` already talks to the resident Antigravity language server, so `-r` resumes
 *    the exact conversation with full history.
 *  - Per-turn invocation honors `/model` and effort changes immediately on the next turn.
 *  - `abort()` (⏹) can cleanly terminate the active child process without wedging state.
 */
export class AntigravityThread implements AgentThread {
  private _sessionId: string;
  readonly supportsSteer = false;

  get sessionId(): string {
    return this._sessionId;
  }

  private readonly bin: string;
  private readonly cwd: string;
  private readonly mode: PermissionMode;
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private sentBridgeHint: boolean;
  private dead = false;
  private turnSeq = 0;
  private currentTurnId: string | undefined;
  private lastActivityAt = Date.now();
  private activeChild: ChildProcess | undefined;
  private interruptRequested = false;
  private goalRunning = false;

  constructor(cfg: AgyThreadConfig) {
    this._sessionId = cfg.sessionId;
    this.bin = cfg.bin;
    this.cwd = cfg.cwd;
    this.mode = cfg.mode;
    this.model = cfg.model;
    this.effort = cfg.effort;
    this.sentBridgeHint = !cfg.isNew;
  }

  private buildArgs(prompt: string): string[] {
    const args: string[] = [
      '--output-format',
      'stream-json',
      '-r',
      this._sessionId,
    ];

    if (this.model) {
      args.push('--model', this.model);
    }
    const agyEffort = toAgyEffort(this.effort);
    if (agyEffort && !modelHasEffortSuffix(this.model)) {
      args.push('--effort', agyEffort);
    }

    // Permission tier mapping:
    //  - qa: read-only plan mode + sandbox
    //  - write: sandboxed auto-approve
    //  - full: unrestricted auto-approve
    if (this.mode === 'qa') {
      args.push('--mode', 'plan', '--sandbox');
    } else if (this.mode === 'write') {
      args.push('--sandbox', '--dangerously-skip-permissions');
    } else {
      args.push('--dangerously-skip-permissions');
    }

    // Attach prompt with `=` so prompts starting with `-` are never parsed as flags.
    args.push(`-p=${prompt}`);
    return args;
  }

  private spawnTurn(prompt: string): Inbox<StreamItem> {
    const inbox = new Inbox<StreamItem>();
    const args = this.buildArgs(prompt);
    let child: ChildProcess;
    try {
      child = spawnProcess(this.bin, args, {
        cwd: this.cwd,
        env: bridgeAgyEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      inbox.push({ kind: 'error', err });
      return inbox;
    }

    this.activeChild = child;
    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      this.lastActivityAt = Date.now();
      stdoutBuf += chunk.toString('utf8');
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as AgyStreamMessage;
            inbox.push({ kind: 'msg', msg: parsed });
          } catch {
            log.info('agent', 'agy-stdout-nonjson', {
              backend: 'antigravity-cli',
              line: line.slice(0, 300),
            });
          }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.lastActivityAt = Date.now();
      const s = chunk.toString('utf8');
      stderrBuf += s;
      const trimmed = s.trim();
      if (trimmed) {
        log.info('agent', 'agy-stderr', {
          backend: 'antigravity-cli',
          line: trimmed.slice(0, 300),
        });
      }
    });

    child.on('error', (err) => {
      if (this.activeChild === child) this.activeChild = undefined;
      inbox.push({ kind: 'error', err });
    });

    child.on('close', (code) => {
      if (this.activeChild === child) this.activeChild = undefined;
      const tail = stdoutBuf.trim();
      if (tail) {
        try {
          const parsed = JSON.parse(tail) as AgyStreamMessage;
          inbox.push({ kind: 'msg', msg: parsed });
        } catch {
          /* ignore trailing non-JSON */
        }
      }
      inbox.push({ kind: 'close', code, stderr: stderrBuf.trim() });
    });

    return inbox;
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const turnId = `t${++this.turnSeq}`;
    this.currentTurnId = turnId;
    this.interruptRequested = false;

    if (turn?.model) this.model = turn.model;
    if (turn?.effort) this.effort = turn.effort;

    const includeHint = !this.sentBridgeHint;
    this.sentBridgeHint = true;
    const prompt = buildPromptText(input, includeHint);
    const mapper = createAgyTurnMapper({ cwd: this.cwd });
    const inbox = this.spawnTurn(prompt);

    const self = this;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield { type: 'turn_started', turnId };

      for (let attempt = 0; attempt < 2; attempt++) {
        const activeMapper = attempt === 0 ? mapper : createAgyTurnMapper({ cwd: self.cwd });
        const activeInbox = attempt === 0 ? inbox : self.spawnTurn(buildPromptText(input, true));
        let sawResult = false;
        let resultFailed = false;
        let resultError = '';
        let shouldRetryFresh = false;

        while (true) {
          const item = await activeInbox.next();
          if (item.kind === 'error') {
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
              return;
            }
            const msg = item.err instanceof Error ? item.err.message : String(item.err);
            yield { type: 'error', message: msg || 'Antigravity 进程启动失败', willRetry: false };
            return;
          }
          if (item.kind === 'close') {
            for (const ev of activeMapper.flush()) yield ev;
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
              return;
            }
            const errDetail = resultFailed
              ? resultError || 'Antigravity 执行失败'
              : !sawResult && item.code !== 0
                ? `Antigravity 进程异常退出（code=${item.code ?? 'null'}）${item.stderr ? `：${item.stderr.slice(0, 300)}` : ''}`
                : '';

            if (errDetail) {
              // If the user switched `agy` accounts and the old `-r` conversation is no
              // longer accessible, mint a fresh conversation and retry once transparently.
              if (
                attempt === 0 &&
                !activeMapper.hasEmittedText() &&
                isRecoverableSessionError(`${errDetail}\n${item.stderr}`)
              ) {
                try {
                  const freshId = await createEmptyConversation(self.bin, self.cwd);
                  log.info('agent', 'agy-session-recreated', {
                    backend: 'antigravity-cli',
                    oldSessionId: self._sessionId,
                    newSessionId: freshId,
                  });
                  self._sessionId = freshId;
                  shouldRetryFresh = true;
                  break;
                } catch (recreateErr) {
                  log.fail('agent', recreateErr, { backend: 'antigravity-cli', phase: 'recreate-session' });
                }
              }
              yield { type: 'error', message: errDetail, willRetry: false };
              return;
            }

            yield { type: 'done', turnId };
            return;
          }

          const msg = item.msg;
          self.lastActivityAt = Date.now();
          for (const ev of activeMapper.map(msg)) {
            yield ev;
          }
          if (msg.event === 'result' && msg.result) {
            sawResult = true;
            if (msg.result.status && msg.result.status !== 'SUCCESS') {
              resultFailed = true;
              resultError = msg.result.error || `Antigravity 返回状态 ${msg.result.status}`;
            }
          }
        }

        if (!shouldRetryFresh) return;
      }
    }

    return {
      events: gen(),
      turnId: () => self.currentTurnId,
      lastActivity: () => self.lastActivityAt,
    };
  }

  runGoal(objective: string): AgentRun {
    const turnId = `g${++this.turnSeq}`;
    this.currentTurnId = turnId;
    this.interruptRequested = false;
    this.goalRunning = true;
    const startedAt = Date.now();

    const includeHint = !this.sentBridgeHint;
    this.sentBridgeHint = true;
    const prompt = buildPromptText({ text: goalPrompt(objective) }, includeHint);
    const mapper = createAgyTurnMapper({ cwd: this.cwd });
    const inbox = this.spawnTurn(prompt);

    const self = this;
    async function* gen(): AsyncGenerator<AgentEvent> {
      yield {
        type: 'goal_update',
        status: 'active',
        objective,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        tokenBudget: null,
      };
      yield { type: 'turn_started', turnId };

      let tokensUsed = 0;
      let sawResult = false;
      let resultFailed = false;
      let resultError = '';

      const finishGoal = (status: string): AgentEvent => ({
        type: 'goal_update',
        status,
        objective,
        tokensUsed,
        timeUsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        tokenBudget: null,
      });

      try {
        while (true) {
          const item = await inbox.next();
          if (item.kind === 'error') {
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
              return;
            }
            const msg = item.err instanceof Error ? item.err.message : String(item.err);
            yield finishGoal('blocked');
            yield { type: 'error', message: msg || 'Antigravity 进程启动失败', willRetry: false };
            return;
          }
          if (item.kind === 'close') {
            for (const ev of mapper.flush()) yield ev;
            if (self.interruptRequested) {
              yield { type: 'done', turnId };
              return;
            }
            if (resultFailed) {
              yield finishGoal('blocked');
              yield { type: 'error', message: resultError || 'Antigravity 目标执行失败', willRetry: false };
              return;
            }
            if (sawResult || item.code === 0) {
              yield finishGoal('complete');
              yield { type: 'done', turnId };
              return;
            }
            yield finishGoal('blocked');
            yield {
              type: 'error',
              message: `Antigravity 进程异常退出（code=${item.code ?? 'null'}）`,
              willRetry: false,
            };
            return;
          }

          const msg = item.msg;
          self.lastActivityAt = Date.now();
          for (const ev of mapper.map(msg)) {
            if (ev.type === 'usage') {
              tokensUsed = (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0);
            }
            yield ev;
          }
          if (msg.event === 'result' && msg.result) {
            sawResult = true;
            if (msg.result.status && msg.result.status !== 'SUCCESS') {
              resultFailed = true;
              resultError = msg.result.error || `Antigravity 返回状态 ${msg.result.status}`;
            }
          }
        }
      } finally {
        self.goalRunning = false;
      }
    }

    return {
      events: gen(),
      turnId: () => self.currentTurnId,
      lastActivity: () => self.lastActivityAt,
    };
  }

  async clearGoal(): Promise<void> {
    if (!this.goalRunning) return;
    this.goalRunning = false;
    await this.abort(this.currentTurnId ?? '');
  }

  async steer(): Promise<void> {
    throw new Error('antigravity-cli 后端暂不支持飞行中引导（steer），将自动改为下一轮发送');
  }

  async compact(): Promise<CompactResult> {
    throw new Error('antigravity-cli 后端暂不支持手动 /compact 压缩');
  }

  async abort(_turnId: string): Promise<void> {
    this.interruptRequested = true;
    const child = this.activeChild;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (this.activeChild === child && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 2_000).unref();
  }

  isAlive(): boolean {
    return !this.dead;
  }

  async close(): Promise<void> {
    this.dead = true;
    await this.abort(this.currentTurnId ?? '');
  }
}
