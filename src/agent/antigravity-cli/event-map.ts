import type { AgentEvent, ToolKind } from '../types';

export interface AgyMapContext {
  /** thread cwd, to relativize file paths in tool titles */
  cwd?: string;
}

export interface AgyStreamMessage {
  event?: string;
  conversation_id?: string;
  init?: {
    model?: string;
    cwd?: string;
  };
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    thinking_delta?: string;
    tool_name?: string;
    tool_info?: {
      name?: string;
      parameters?: Record<string, unknown>;
      output?: string;
      error?: string;
    };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    finished_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      thinking_tokens?: number;
      cache_read_tokens?: number;
      total_tokens?: number;
    };
  };
}

export interface AgyTurnMapper {
  map(msg: AgyStreamMessage): AgentEvent[];
  /** Flush any open text/thinking block if the stream terminates without DONE. */
  flush(): AgentEvent[];
  /** Whether any text_delta or text event has been emitted during this turn. */
  hasEmittedText(): boolean;
}

/**
 * Map `agy --output-format stream-json` NDJSON events to normalized {@link AgentEvent}s.
 */
export function createAgyTurnMapper(ctx: AgyMapContext = {}): AgyTurnMapper {
  let systemEmitted = false;
  let initModel: string | undefined;
  let emittedText = false;
  /** Last single-step context size (input + cache_read). `result.usage` is the
   * cumulative sum across all tool-call steps in a turn, NOT the current context window. */
  let lastStepContextUsed = 0;
  const openText = new Map<number, string>();
  const openThinking = new Map<number, string>();
  const startedTools = new Set<number>();

  function map(msg: AgyStreamMessage): AgentEvent[] {
    if (!msg || typeof msg.event !== 'string') return [];

    if (msg.event === 'init') {
      if (typeof msg.init?.model === 'string') initModel = msg.init.model;
      if (!systemEmitted && msg.conversation_id) {
        systemEmitted = true;
        return [{ type: 'system', threadId: msg.conversation_id }];
      }
      return [];
    }

    if (msg.event === 'step_update' && msg.step_update) {
      const u = msg.step_update;
      const idx = typeof u.step_index === 'number' ? u.step_index : 0;
      const out: AgentEvent[] = [];

      if (u.step_type === 'agent_response') {
        const textId = `agy-text-${idx}`;
        const thinkId = `agy-think-${idx}`;

        if (typeof u.thinking_delta === 'string' && u.thinking_delta.length > 0) {
          openThinking.set(idx, (openThinking.get(idx) ?? '') + u.thinking_delta);
          out.push({ type: 'thinking_delta', itemId: thinkId, delta: u.thinking_delta });
        }
        if (typeof u.text_delta === 'string' && u.text_delta.length > 0) {
          emittedText = true;
          openText.set(idx, (openText.get(idx) ?? '') + u.text_delta);
          out.push({ type: 'text_delta', itemId: textId, delta: u.text_delta });
        }

        if (u.usage) {
          const stepUsed = (u.usage.input_tokens ?? 0) + (u.usage.cache_read_tokens ?? 0);
          if (stepUsed > 0) lastStepContextUsed = stepUsed;
        }

        if (u.state === 'DONE') {
          const thinkAcc = openThinking.get(idx);
          if (thinkAcc) {
            openThinking.delete(idx);
            out.push({ type: 'thinking', itemId: thinkId, text: thinkAcc });
          }
          const textAcc = openText.get(idx);
          if (textAcc) {
            openText.delete(idx);
            out.push({ type: 'text', itemId: textId, text: textAcc });
          }
        }
        return out;
      }

      if (u.step_type === 'tool') {
        const itemId = `agy-tool-${idx}`;
        const name = u.tool_name || u.tool_info?.name || 'tool';
        const params = (u.tool_info?.parameters ?? {}) as Record<string, unknown>;

        if (u.state === 'ACTIVE' || !startedTools.has(idx)) {
          if (!startedTools.has(idx)) {
            startedTools.add(idx);
            out.push({
              type: 'tool_use',
              itemId,
              title: agyToolTitle(name, params, ctx.cwd),
              detail: agyToolDetail(name, params),
              kind: agyToolKind(name),
            });
          }
        }

        if (u.state === 'DONE' || u.state === 'ERROR' || u.state === 'FAILED') {
          const output = u.tool_info?.output ?? u.tool_info?.error;
          const exitCode = parseExitCode(output, u.state !== 'DONE');
          out.push({
            type: 'tool_result',
            itemId,
            output: typeof output === 'string' && output.length > 0 ? output : undefined,
            exitCode,
          });
        }
        return out;
      }

      return [];
    }

    if (msg.event === 'result' && msg.result) {
      const out: AgentEvent[] = [];
      const r = msg.result;

      // If the response text was only delivered on the final result object
      // (no streaming text_delta arrived), emit it so the card isn't empty.
      if (!emittedText && typeof r.response === 'string' && r.response.trim().length > 0) {
        emittedText = true;
        out.push({ type: 'text', itemId: 'agy-result-text', text: r.response });
      }

      const usage = r.usage;
      if (usage) {
        out.push({
          type: 'usage',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        });
        const used =
          lastStepContextUsed > 0
            ? lastStepContextUsed
            : (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0);
        if (used > 0) {
          out.push({
            type: 'context_usage',
            usedTokens: used,
            contextWindow: contextWindowForAgyModel(initModel),
          });
        }
      }
      return out;
    }

    return [];
  }

  function flush(): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const [idx, text] of openThinking.entries()) {
      if (text) out.push({ type: 'thinking', itemId: `agy-think-${idx}`, text });
    }
    openThinking.clear();
    for (const [idx, text] of openText.entries()) {
      if (text) out.push({ type: 'text', itemId: `agy-text-${idx}`, text });
    }
    openText.clear();
    return out;
  }

  return {
    map,
    flush,
    hasEmittedText: () => emittedText,
  };
}

function parseExitCode(output: string | undefined, isErrorState: boolean): number | null {
  if (typeof output === 'string') {
    const m = output.match(/Command exited with code (\d+)/);
    if (m) return Number(m[1]);
  }
  return isErrorState ? 1 : 0;
}

export function agyToolTitle(name: string, params: Record<string, unknown>, cwd?: string): string {
  const s = (...keys: string[]): string => {
    for (const k of keys) {
      if (typeof params[k] === 'string' && (params[k] as string).trim()) return params[k] as string;
    }
    return '';
  };

  switch (name) {
    case 'run_command':
      return s('CommandLine', 'command') || 'Shell 命令';
    case 'view_file':
    case 'read_file':
      return `读取 ${displayPath(s('AbsolutePath', 'Path', 'path'), cwd)}`;
    case 'write_to_file':
    case 'write_file':
      return `写入 ${displayPath(s('TargetFile', 'Path', 'path'), cwd)}`;
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'edit_file':
    case 'sed_file':
      return `编辑 ${displayPath(s('TargetFile', 'Path', 'path'), cwd)}`;
    case 'list_dir':
      return `列出目录 ${displayPath(s('DirectoryPath', 'Path', 'path'), cwd)}`;
    case 'find_by_name':
      return `查找 ${s('Pattern', 'pattern')}`.trim();
    case 'grep_search':
      return `搜索 ${s('Query', 'query')}`.trim();
    case 'search_web':
      return `联网搜索 ${s('query', 'Query')}`.trim();
    case 'read_url_content':
      return `抓取网页 ${s('Url', 'url')}`.trim();
    case 'invoke_subagent':
      return `子任务：${s('Role', 'TypeName') || 'subagent'}`;
    default:
      return name || '工具调用';
  }
}

function agyToolKind(name: string): ToolKind {
  switch (name) {
    case 'run_command':
      return 'command';
    case 'view_file':
    case 'read_file':
    case 'write_to_file':
    case 'write_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'edit_file':
    case 'sed_file':
    case 'notebook_edit':
      return 'file';
    case 'list_dir':
    case 'find_by_name':
    case 'grep_search':
    case 'search_web':
    case 'read_url_content':
      return 'search';
    default:
      return 'tool';
  }
}

function agyToolDetail(name: string, params: Record<string, unknown>): string | undefined {
  if (name === 'run_command' && typeof params.toolSummary === 'string' && params.toolSummary.trim()) {
    return params.toolSummary.trim();
  }
  return undefined;
}

const PATH_TAIL_MAX = 40;
function displayPath(p: string, cwd?: string): string {
  if (!p) return '文件';
  if (cwd) {
    const sep = cwd.includes('\\') ? '\\' : '/';
    const root = cwd.endsWith(sep) ? cwd : cwd + sep;
    if (p.startsWith(root) && p.length > root.length) return p.slice(root.length);
  }
  if (p.length <= PATH_TAIL_MAX || !p.includes('/')) return p;
  const segs = p.split('/');
  let out = segs[segs.length - 1] ?? p;
  for (let i = segs.length - 2; i >= 0; i--) {
    const cand = `${segs[i]}/${out}`;
    if (cand.length > PATH_TAIL_MAX) break;
    out = cand;
  }
  return `…/${out}`;
}

function contextWindowForAgyModel(model: unknown): number | null {
  const id = typeof model === 'string' ? model.toLowerCase() : '';
  if (!id) return null;
  if (id.includes('gemini')) return 1_000_000;
  if (id.includes('claude')) return 200_000;
  return 200_000;
}
