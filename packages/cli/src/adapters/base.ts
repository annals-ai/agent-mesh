export interface AdapterConfig {
  project?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  /** Path to srt sandbox config file. When set, spawned agents run inside a sandbox. */
  sandboxConfigPath?: string;
}

export interface SessionHandle {
  send(message: string, attachments?: { name: string; url: string; type: string }[]): void;
  onChunk(cb: (delta: string) => void): void;
  onDone(cb: () => void): void;
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
