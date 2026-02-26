export interface AdapterConfig {
  project?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  /** When true, spawned agents run inside a sandbox (srt programmatic API). */
  sandboxEnabled?: boolean;
  /** The agent's own UUID on the platform — injected into subprocess env as AGENT_BRIDGE_AGENT_ID for A2A caller tracking. */
  agentId?: string;
}

export type ToolEventKind = 'tool_start' | 'tool_input' | 'tool_result' | 'thinking' | 'status';

export interface ToolEvent {
  kind: ToolEventKind;
  tool_name: string;
  tool_call_id: string;
  /** JSON fragment for tool_input, result text for tool_result */
  delta: string;
}

export interface OutputAttachment {
  name: string;
  url: string;
  type: string;
}

export interface OutputFileManifestEntry {
  path: string;
  size: number;
  mtime_ms: number;
  type: string;
}

export type PlatformTask =
  | {
      type: 'upload_file';
      path: string;
    }
  | {
      type: 'upload_all_zip';
      zip_name?: string;
      max_bytes?: number;
    };

export interface SessionDonePayload {
  attachments?: OutputAttachment[];
  fileManifest?: OutputFileManifestEntry[];
}

export interface UploadCredentials {
  uploadUrl: string;
  uploadToken: string;
}

export interface SessionHandle {
  send(
    message: string,
    attachments?: { name: string; url: string; type: string }[],
    uploadCredentials?: UploadCredentials,
    clientId?: string,
    platformTask?: PlatformTask
  ): void;
  onChunk(cb: (delta: string) => void): void;
  onToolEvent(cb: (event: ToolEvent) => void): void;
  onDone(cb: (payload?: SessionDonePayload) => void): void;
  onError(cb: (error: Error) => void): void;
  kill(): void;
}

export abstract class AgentAdapter {
  abstract readonly type: string;
  abstract readonly displayName: string;

  abstract isAvailable(): Promise<boolean>;
  abstract createSession(id: string, config: AdapterConfig): SessionHandle;
  abstract destroySession(id: string): void;
}
