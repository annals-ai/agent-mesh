import { AgentAdapter, type AdapterConfig, type SessionHandle } from './base.js';
import { log } from '../utils/logger.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18789';

/**
 * Normalize legacy ws:// / wss:// URLs to http:// / https://
 */
function normalizeUrl(url: string): string {
  if (url.startsWith('wss://')) return url.replace('wss://', 'https://');
  if (url.startsWith('ws://')) return url.replace('ws://', 'http://');
  return url;
}

class OpenClawSession implements SessionHandle {
  private messages: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private baseUrl: string;
  private token: string;
  private sessionKey: string;
  private chunkCallbacks: ((delta: string) => void)[] = [];
  private doneCallbacks: (() => void)[] = [];
  private errorCallbacks: ((error: Error) => void)[] = [];

  constructor(
    sessionId: string,
    private config: AdapterConfig
  ) {
    this.baseUrl = normalizeUrl(config.gatewayUrl || DEFAULT_GATEWAY_URL);
    this.token = config.gatewayToken || '';
    this.sessionKey = sessionId;
  }

  send(message: string, _attachments?: { name: string; url: string; type: string }[]): void {
    // Attachments are silently ignored (OpenClaw does not support them natively)
    this.sendRequest(message);
  }

  onChunk(cb: (delta: string) => void): void {
    this.chunkCallbacks.push(cb);
  }

  onDone(cb: () => void): void {
    this.doneCallbacks.push(cb);
  }

  onError(cb: (error: Error) => void): void {
    this.errorCallbacks.push(cb);
  }

  kill(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async sendRequest(message: string): Promise<void> {
    this.messages.push({ role: 'user', content: message });
    this.abortController = new AbortController();

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'x-openclaw-session-key': this.sessionKey,
        },
        body: JSON.stringify({
          model: 'openclaw:main',
          messages: [...this.messages],
          stream: true,
        }),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.emitError(new Error(`OpenClaw HTTP ${response.status}: ${text || response.statusText}`));
        return;
      }

      if (!response.body) {
        this.emitError(new Error('OpenClaw response has no body'));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            if (fullText) {
              this.messages.push({ role: 'assistant', content: fullText });
            }
            for (const cb of this.doneCallbacks) cb();
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
              for (const cb of this.chunkCallbacks) cb(content);
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }

      // Stream ended without [DONE] — still save and notify
      if (fullText) {
        this.messages.push({ role: 'assistant', content: fullText });
      }
      for (const cb of this.doneCallbacks) cb();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return; // killed, stay silent
      }
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private emitError(err: Error): void {
    if (this.errorCallbacks.length > 0) {
      for (const cb of this.errorCallbacks) cb(err);
    } else {
      log.error(err.message);
    }
  }
}

export class OpenClawAdapter extends AgentAdapter {
  readonly type = 'openclaw';
  readonly displayName = 'OpenClaw Gateway';

  private sessions = new Map<string, OpenClawSession>();
  private config: AdapterConfig;

  constructor(config: AdapterConfig = {}) {
    super();
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    const baseUrl = normalizeUrl(this.config.gatewayUrl || DEFAULT_GATEWAY_URL);
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openclaw:main',
          messages: [],
          stream: false,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.status === 404) {
        log.warn(
          'OpenClaw endpoint not found. Enable chatCompletions in openclaw.json.'
        );
        return false;
      }

      // Any other response (200, 400, 401, 500) means the endpoint exists
      return true;
    } catch {
      return false;
    }
  }

  createSession(id: string, config: AdapterConfig): SessionHandle {
    const merged = { ...this.config, ...config };
    const session = new OpenClawSession(id, merged);
    this.sessions.set(id, session);
    return session;
  }

  destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.kill();
      this.sessions.delete(id);
    }
  }
}
