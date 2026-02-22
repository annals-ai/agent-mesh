import type { BridgeErrorCode } from './errors.js';

// ============================================================
// Bridge → Platform (sent by agent-mesh CLI to Bridge Worker)
// ============================================================

/** Sent immediately after WebSocket connection to authenticate */
export interface Register {
  type: 'register';
  agent_id: string;
  token: string;
  bridge_version: string;
  agent_type: 'openclaw' | 'claude' | 'codex' | 'gemini' | string;
  capabilities: string[];
}

/** Chunk kind — determines how the chunk is handled by the platform */
export type ChunkKind = 'text' | 'tool_start' | 'tool_input' | 'tool_result' | 'thinking' | 'status';

/** Incremental chunk from agent (text or tool activity) */
export interface Chunk {
  type: 'chunk';
  session_id: string;
  request_id: string;
  delta: string;
  /** Chunk kind. Omitted or 'text' = normal text content. */
  kind?: ChunkKind;
  /** Tool name (e.g. 'Write', 'Bash') — present when kind is tool_* */
  tool_name?: string;
  /** Unique tool call ID — groups tool_start/tool_input/tool_result */
  tool_call_id?: string;
}

/** Agent finished responding */
export interface Done {
  type: 'done';
  session_id: string;
  request_id: string;
  /** Files produced by the agent during this request (auto-uploaded from workspace) */
  attachments?: Attachment[];
  /** Complete response text (used by async mode — Worker forwards to Platform callback) */
  result?: string;
}

/** Agent encountered an error */
export interface BridgeError {
  type: 'error';
  session_id: string;
  request_id: string;
  code: BridgeErrorCode | string;
  message: string;
}

/** Periodic heartbeat from bridge CLI */
export interface Heartbeat {
  type: 'heartbeat';
  active_sessions: number;
  uptime_ms: number;
}

/** A2A: Request agent discovery from the network */
export interface DiscoverAgents {
  type: 'discover_agents';
  capability?: string;
  limit?: number;
}

/** A2A: Call another agent on the network */
export interface CallAgent {
  type: 'call_agent';
  target_agent_id: string;
  task_description: string;
  call_id?: string;
}

/** All messages sent from Bridge CLI to Worker */
export type BridgeToWorkerMessage = Register | Chunk | Done | BridgeError | Heartbeat | DiscoverAgents | CallAgent;

// ============================================================
// Platform → Bridge (sent by Bridge Worker to agent-mesh CLI)
// ============================================================

/** Registration acknowledgment */
export interface Registered {
  type: 'registered';
  status: 'ok' | 'error';
  error?: string;
}

/** User message forwarded to agent */
export interface Message {
  type: 'message';
  session_id: string;
  request_id: string;
  content: string;
  attachments: Attachment[];
  /** Upload endpoint for agent to auto-upload workspace output files */
  upload_url?: string;
  /** One-time token for authenticating uploads */
  upload_token?: string;
  /** Stable client identifier for per-client workspace isolation */
  client_id?: string;
}

/** Cancel an in-progress request */
export interface Cancel {
  type: 'cancel';
  session_id: string;
  request_id: string;
}

/** A2A: Discovery result — list of available agents */
export interface DiscoverAgentsResult {
  type: 'discover_agents_result';
  agents: Array<{
    id: string;
    name: string;
    agent_type: string;
    capabilities: string[];
    is_online: boolean;
  }>;
}

/** A2A: Streaming chunk from called agent */
export interface CallAgentChunk {
  type: 'call_agent_chunk';
  call_id: string;
  delta: string;
  kind?: ChunkKind;
}

/** A2A: Called agent finished */
export interface CallAgentDone {
  type: 'call_agent_done';
  call_id: string;
  attachments?: Attachment[];
}

/** A2A: Called agent error */
export interface CallAgentError {
  type: 'call_agent_error';
  call_id: string;
  code: string;
  message: string;
}

/** All messages sent from Worker to Bridge CLI */
export type WorkerToBridgeMessage = Registered | Message | Cancel | DiscoverAgentsResult | CallAgentChunk | CallAgentDone | CallAgentError;

// ============================================================
// Shared types
// ============================================================

export interface Attachment {
  name: string;
  url: string;
  type: string;
}

/** Any Bridge Protocol message */
export type BridgeMessage = BridgeToWorkerMessage | WorkerToBridgeMessage;

// ============================================================
// Relay API types (Platform ↔ Bridge Worker HTTP)
// ============================================================

/** POST /api/relay request body */
export interface RelayRequest {
  agent_id: string;
  session_id: string;
  request_id: string;
  content: string;
  attachments?: Attachment[];
  /** Upload endpoint for agent to auto-upload workspace output files */
  upload_url?: string;
  /** One-time token for authenticating uploads */
  upload_token?: string;
  /** Stable client identifier for per-client workspace isolation */
  client_id?: string;
  /** Async mode: Worker returns 202 immediately, calls back when done */
  mode?: 'stream' | 'async';
  /** Async mode: Platform task ID to include in callback */
  task_id?: string;
  /** Async mode: URL to POST result when agent finishes */
  callback_url?: string;
}

/** SSE event from relay endpoint */
export interface RelayChunkEvent {
  type: 'chunk';
  delta: string;
  kind?: ChunkKind;
  tool_name?: string;
  tool_call_id?: string;
}

export interface RelayDoneEvent {
  type: 'done';
  /** Files produced by the agent during this request */
  attachments?: Attachment[];
}

export interface RelayErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

/** Periodic keepalive forwarded from agent heartbeat — resets platform timeout */
export interface RelayKeepaliveEvent {
  type: 'keepalive';
}

export type RelayEvent = RelayChunkEvent | RelayDoneEvent | RelayErrorEvent | RelayKeepaliveEvent;

// ============================================================
// A2A API types (Agent-to-Agent calls via Bridge Worker)
// ============================================================

/** POST /api/a2a/call request body */
export interface A2ACallRequest {
  caller_agent_id: string;
  target_agent_id: string;
  task_description: string;
}

/** A2A call SSE events (same shape as relay events) */
export type A2ACallEvent = RelayChunkEvent | RelayDoneEvent | RelayErrorEvent | RelayKeepaliveEvent;
