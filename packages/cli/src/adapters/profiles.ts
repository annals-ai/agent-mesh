import type { ToolEvent, OutputAttachment } from './base.js';
import { homedir } from 'node:os';
import { log } from '../utils/logger.js';

// ── ParsedEvent + OutputParser interface ────────────────

export type ParsedEvent =
  | { type: 'chunk'; text: string }
  | { type: 'tool'; event: ToolEvent }
  | { type: 'done'; attachments?: OutputAttachment[] }
  | { type: 'error'; message: string };

export interface OutputParser {
  parseLine(line: string): ParsedEvent | null;
}

// ── CliProfile interface ────────────────────────────────

export interface CliProfile {
  command: string;
  displayName: string;
  buildArgs(message: string): string[];
  createParser(): OutputParser;
  /** Extra paths the sandbox should allow writing (e.g. ~/.claude) */
  runtimeWritePaths: string[];
  /** Env vars to pass through the sandbox shell wrapper */
  envPassthroughKeys: string[];
  /** Directories to deny reading in the sandbox (beyond SENSITIVE_PATHS) */
  configDirs: string[];
  /** If true, process exit with code 0 auto-emits done (some CLIs lack a result event) */
  autoEmitDoneOnExit?: boolean;
}

// ── ClaudeOutputParser ──────────────────────────────────

type AnyEvent = Record<string, any>;

export class ClaudeOutputParser implements OutputParser {
  private currentBlockType: 'thinking' | 'text' | null = null;
  private activeToolCallId: string | null = null;
  private activeToolName: string | null = null;

  parseLine(line: string): ParsedEvent | null {
    if (!line.trim()) return null;

    let event: AnyEvent;
    try {
      event = JSON.parse(line);
    } catch {
      log.debug(`Claude non-JSON line: ${line}`);
      return null;
    }

    return this.handleEvent(event);
  }

  private handleEvent(event: AnyEvent): ParsedEvent | null {
    // ── stream_event wrapper (--include-partial-messages mode) ──

    if (event.type === 'stream_event' && event.event) {
      const inner = event.event;

      // Track current block type (thinking vs text) from content_block_start
      if (inner.type === 'content_block_start') {
        const blockType = inner.content_block?.type as string | undefined;
        if (blockType === 'thinking') {
          this.currentBlockType = 'thinking';
        } else if (blockType === 'text') {
          this.currentBlockType = 'text';
        }
        // tool_use handled separately below
      }

      // Text delta — route to thinking or actual output based on current block
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
        if (this.currentBlockType === 'thinking') {
          return { type: 'tool', event: { kind: 'thinking', tool_name: '', tool_call_id: '', delta: inner.delta.text } };
        }
        return { type: 'chunk', text: inner.delta.text };
      }

      // Thinking delta — extended thinking API (thinking_delta type)
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta' && inner.delta.thinking) {
        return { type: 'tool', event: { kind: 'thinking', tool_name: '', tool_call_id: '', delta: inner.delta.thinking } };
      }

      // Tool use start — content_block_start with tool_use type
      if (inner.type === 'content_block_start' && inner.content_block?.type === 'tool_use') {
        const toolCallId = inner.content_block.id || `tool-${Date.now()}`;
        const toolName = inner.content_block.name || 'unknown';
        this.activeToolCallId = toolCallId;
        this.activeToolName = toolName;
        return { type: 'tool', event: { kind: 'tool_start', tool_name: toolName, tool_call_id: toolCallId, delta: '' } };
      }

      // Tool input delta — streaming JSON fragments of tool parameters
      if (inner.type === 'content_block_delta' && inner.delta?.type === 'input_json_delta' && inner.delta.partial_json !== undefined) {
        if (this.activeToolCallId && this.activeToolName) {
          return { type: 'tool', event: { kind: 'tool_input', tool_name: this.activeToolName, tool_call_id: this.activeToolCallId, delta: inner.delta.partial_json } };
        }
        return null;
      }

      // Content block stop — tool input complete
      if (inner.type === 'content_block_stop') {
        this.activeToolCallId = null;
        this.activeToolName = null;
        return null;
      }

      // Drop known Anthropic bookkeeping events that should never reach the UI
      // (message_start, message_stop, message_delta, signature_delta, ping, etc.)
      return null;
    }

    // ── Tool result (user event with tool_result content) ──

    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const toolCallId = block.tool_use_id || 'unknown';
          const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          const isError = !!block.is_error;
          // Return the first tool_result found — multiple results per line are rare
          return { type: 'tool', event: { kind: 'tool_result', tool_name: '', tool_call_id: toolCallId, delta: isError ? `[error] ${resultText}` : resultText } };
        }
      }
      return null;
    }

    // ── Legacy formats (for Claude Code versions without --include-partial-messages) ──

    if (event.type === 'assistant' && event.subtype === 'text_delta' && event.delta?.text) {
      return { type: 'chunk', text: event.delta.text };
    }

    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
      return { type: 'chunk', text: event.delta.text };
    }

    // Full assistant message — return as chunk (caller decides whether to skip if already streaming)
    if (event.type === 'assistant' && event.message?.content) {
      if (event.error) return null;
      const texts: string[] = [];
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) {
        return { type: 'chunk', text: texts.join('') };
      }
      return null;
    }

    // Result event — completion
    if (event.type === 'result') {
      if (event.is_error) {
        const errorText = typeof event.result === 'string' && event.result
          ? event.result
          : 'Claude returned an error';
        return { type: 'error', message: errorText };
      }

      if (typeof event.result === 'string' && event.result) {
        // Return result text as a chunk — caller will emit done after
        return { type: 'chunk', text: event.result };
      }
      return { type: 'done' };
    }

    // End subtype
    if (event.type === 'assistant' && event.subtype === 'end') {
      return { type: 'done' };
    }

    return null;
  }
}

// ── Claude Code Profile ─────────────────────────────────

const HOME_DIR = homedir();

const CLAUDE_RUNTIME_WRITE_PATHS = [
  `${HOME_DIR}/.claude`,
  `${HOME_DIR}/.claude.json`,
  `${HOME_DIR}/.claude.json.lock`,
  `${HOME_DIR}/.claude.json.tmp`,
  `${HOME_DIR}/.local/state/claude`,
];

const CLAUDE_ENV_PASSTHROUGH_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'HAPPY_CLAUDE_PATH',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'AGENT_BRIDGE_AGENT_ID',
];

export const CLAUDE_PROFILE: CliProfile = {
  command: 'claude',
  displayName: 'Claude Code',
  buildArgs: (msg) => [
    '-p', msg,
    '--continue',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ],
  createParser: () => new ClaudeOutputParser(),
  runtimeWritePaths: CLAUDE_RUNTIME_WRITE_PATHS,
  envPassthroughKeys: CLAUDE_ENV_PASSTHROUGH_KEYS,
  configDirs: [], // Claude's config dirs are already in SENSITIVE_PATHS
};

// ── Profile registry ────────────────────────────────────

export const PROFILES: Record<string, CliProfile> = {
  claude: CLAUDE_PROFILE,
};

export function getProfile(type: string): CliProfile {
  const profile = PROFILES[type];
  if (!profile) {
    const supported = Object.keys(PROFILES).join(', ');
    throw new Error(`Unknown agent type: ${type}. Supported: ${supported}`);
  }
  return profile;
}
