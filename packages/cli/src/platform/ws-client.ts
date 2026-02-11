import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type {
  BridgeToWorkerMessage,
  WorkerToBridgeMessage,
  Register,
} from '@annals/bridge-protocol';
import { BRIDGE_PROTOCOL_VERSION, WS_CLOSE_REPLACED, WS_CLOSE_TOKEN_REVOKED } from '@annals/bridge-protocol';
import { log } from '../utils/logger.js';

const HEARTBEAT_INTERVAL = 20_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

export interface BridgeWSClientOptions {
  url: string;
  token: string;
  agentId: string;
  agentType: string;
  capabilities?: string[];
}

export class BridgeWSClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private startTime = Date.now();
  private activeSessions = 0;
  private intentionalClose = false;
  private registered = false;
  private sendWarnSuppressed = false;

  private opts: BridgeWSClientOptions;

  constructor(opts: BridgeWSClientOptions) {
    super();
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      this.registered = false;

      try {
        // Append agent_id as query parameter (required by Durable Object routing)
        const wsUrl = new URL(this.opts.url);
        wsUrl.searchParams.set('agent_id', this.opts.agentId);
        this.ws = new WebSocket(wsUrl.toString());
      } catch (err) {
        reject(new Error(`Failed to create WebSocket: ${err}`));
        return;
      }

      const onFirstRegistered = (msg: WorkerToBridgeMessage) => {
        if (msg.type === 'registered') {
          this.off('_raw', onFirstRegistered);
          if (msg.status === 'ok') {
            this.registered = true;
            this.reconnectDelay = INITIAL_RECONNECT_DELAY;
            this.startHeartbeat();
            resolve();
          } else {
            reject(new Error(`Registration failed: ${msg.error || 'unknown'}`));
          }
        }
      };
      this.on('_raw', onFirstRegistered);

      this.ws.on('open', () => {
        log.debug('WebSocket connected, sending register...');
        const reg: Register = {
          type: 'register',
          agent_id: this.opts.agentId,
          token: this.opts.token,
          bridge_version: String(BRIDGE_PROTOCOL_VERSION),
          agent_type: this.opts.agentType,
          capabilities: this.opts.capabilities || [],
        };
        this.ws!.send(JSON.stringify(reg));
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WorkerToBridgeMessage;
          this.emit('_raw', msg);
          if (this.registered) {
            this.emit('message', msg);
          }
        } catch {
          log.debug('Failed to parse message from worker');
        }
      });

      this.ws.on('close', (code, reason) => {
        this.stopHeartbeat();
        this.registered = false;
        if (this.intentionalClose) {
          log.info('Connection closed');
          this.emit('close');
        } else if (code === WS_CLOSE_REPLACED) {
          // Another CLI connected for this agent — do NOT reconnect
          log.error('Another CLI has connected for this agent. This instance is being replaced.');
          this.emit('replaced');
        } else if (code === WS_CLOSE_TOKEN_REVOKED) {
          // Token was revoked by user — do NOT reconnect
          log.error('Your CLI token has been revoked. Please create a new token and reconnect.');
          this.emit('token_revoked');
        } else {
          const reasonStr = reason ? reason.toString() : '';
          log.warn(`Connection lost (${code}: ${reasonStr}), reconnecting in ${this.reconnectDelay}ms...`);
          this.emit('disconnect');
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        log.error(`WebSocket error: ${err.message}`);
        // Don't emit 'error' on EventEmitter — Node.js crashes if no listener.
        // The 'close' event always fires after 'error' and handles reconnection.
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!this.registered) {
          this.off('_raw', onFirstRegistered);
          reject(new Error('Registration timed out'));
          this.ws?.close();
        }
      }, 15_000);
    });
  }

  send(msg: BridgeToWorkerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendWarnSuppressed = false;
      this.ws.send(JSON.stringify(msg));
    } else {
      // Log once per disconnection to avoid spamming when chunks arrive rapidly
      if (!this.sendWarnSuppressed) {
        log.warn('Cannot send: WebSocket not connected (suppressing further warnings until reconnect)');
        this.sendWarnSuppressed = true;
      }
    }
  }

  onMessage(cb: (msg: WorkerToBridgeMessage) => void): void {
    this.on('message', cb);
  }

  setActiveSessions(count: number): void {
    this.activeSessions = count;
  }

  close(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.registered && this.ws?.readyState === WebSocket.OPEN;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Application-level heartbeat (tracked by DO for online status)
      this.send({
        type: 'heartbeat',
        active_sessions: this.activeSessions,
        uptime_ms: Date.now() - this.startTime,
      });
      // WS-level ping keeps the TCP connection alive through proxies/LBs
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch {}
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // Ensure old WebSocket is cleaned up before reconnecting
      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
      try {
        log.info('Attempting reconnect...');
        await this.connect();
        log.success('Reconnected to bridge worker');
        this.emit('reconnect');
      } catch (err) {
        log.error(`Reconnect failed: ${err}`);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }
}
