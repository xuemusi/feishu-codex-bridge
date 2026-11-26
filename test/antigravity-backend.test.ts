import { describe, expect, it } from 'vitest';
import { createAgyTurnMapper } from '../src/agent/antigravity-cli/event-map';
import { parseAgyModelsOutput } from '../src/agent/antigravity-cli/backend';
import { isRecoverableSessionError } from '../src/agent/antigravity-cli/thread';

describe('antigravity-cli event-map', () => {
  it('maps init, tool active/done, streaming text deltas, and result usage', () => {
    const mapper = createAgyTurnMapper({ cwd: '/work/demo' });

    expect(
      mapper.map({
        event: 'init',
        conversation_id: 'conv-123',
        init: { model: 'gemini-4-neon-medium', cwd: '/work/demo' },
      }),
    ).toEqual([{ type: 'system', threadId: 'conv-123' }]);

    expect(
      mapper.map({
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
        },
      }),
    ).toEqual([
      {
        type: 'tool_use',
        itemId: 'agy-tool-2',
        title: 'echo hi',
        detail: undefined,
        kind: 'command',
      },
    ]);

    expect(
      mapper.map({
        event: 'step_update',
        step_update: {
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: {
            name: 'run_command',
            parameters: { CommandLine: 'echo hi' },
            output: 'Command exited with code 0.\n\nhi',
          },
        },
      }),
    ).toEqual([
      {
        type: 'tool_result',
        itemId: 'agy-tool-2',
        output: 'Command exited with code 0.\n\nhi',
        exitCode: 0,
      },
    ]);

    expect(
      mapper.map({
        event: 'step_update',
        step_update: {
          step_index: 3,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Hello ',
        },
      }),
    ).toEqual([{ type: 'text_delta', itemId: 'agy-text-3', delta: 'Hello ' }]);

    expect(
      mapper.map({
        event: 'step_update',
        step_update: {
          step_index: 3,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'World',
          usage: {
            input_tokens: 200,
            output_tokens: 10,
            cache_read_tokens: 800,
          },
        },
      }),
    ).toEqual([
      { type: 'text_delta', itemId: 'agy-text-3', delta: 'World' },
      { type: 'text', itemId: 'agy-text-3', text: 'Hello World' },
    ]);

    expect(
      mapper.map({
        event: 'result',
        result: {
          conversation_id: 'conv-123',
          status: 'SUCCESS',
          response: 'Hello World',
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_tokens: 4000,
          },
        },
      }),
    ).toEqual([
      { type: 'usage', inputTokens: 1000, outputTokens: 50 },
      { type: 'context_usage', usedTokens: 1000, contextWindow: 1_000_000 },
    ]);
  });
});

describe('parseAgyModelsOutput', () => {
  it('parses tab-separated agy models output and marks gemini-4-neon-medium as default', () => {
    const out = [
      'Fetching available models...',
      'gemini-4-neon-high\tGemini 4 Neon (High)',
      'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
      'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
    ].join('\n');

    const models = parseAgyModelsOutput(out);
    expect(models.map((m) => m.id)).toEqual([
      'gemini-4-neon-high',
      'gemini-4-neon-medium',
      'claude-sonnet-5-5-medium',
    ]);
    expect(models[1]?.isDefault).toBe(true);
    expect(models[0]?.defaultEffort).toBe('high');
  });
});

describe('isRecoverableSessionError', () => {
  it('flags cross-account / missing conversation failures for transparent retry', () => {
    expect(isRecoverableSessionError('conversation not found')).toBe(true);
    expect(isRecoverableSessionError('403 Forbidden: permission denied')).toBe(true);
    expect(isRecoverableSessionError('syntax error in bash script')).toBe(false);
  });
});
