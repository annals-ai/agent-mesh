import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ResolvedRuntimeConfig } from './config.js';
import { log } from './logger.js';

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_LEASE_HEARTBEAT_MS = 5_000;

interface QueueState {
  version: 1;
  config: ResolvedRuntimeConfig;
  active: Record<string, ActiveLease>;
  queue: QueueEntry[];
  updated_at: number;
}

interface ActiveLease {
  lease_id: string;
  request_key: string;
  agent_id: string;
  session_id: string;
  request_id: string;
  pid: number;
  acquired_at: number;
  lease_expires_at: number;
}

interface QueueEntry {
  queue_id: string;
  request_key: string;
  agent_id: string;
  session_id: string;
  request_id: string;
  pid: number;
  enqueued_at: number;
  deadline_at: number;
}

export interface RuntimeQueueConfig {
  maxActiveRequests: number;
  queueWaitTimeoutMs: number;
  queueMaxLength: number;
}

export interface QueueAcquireInput {
  agentId: string;
  sessionId: string;
  requestId: string;
  pid: number;
}

export interface QueueLease {
  leaseId: string;
  requestKey: string;
  release(reason: 'done' | 'error' | 'cancel' | 'shutdown'): Promise<void>;
  startHeartbeat(): () => void;
}

export interface RuntimeQueueController {
  acquire(input: QueueAcquireInput, opts?: { signal?: AbortSignal }): Promise<QueueLease>;
  cancelQueued(input: QueueAcquireInput): Promise<boolean>;
  snapshot(): Promise<{ active: number; queued: number; config: RuntimeQueueConfig }>;
}

type QueueErrorCode = 'queue_full' | 'queue_timeout' | 'queue_aborted' | 'queue_cancelled';

export class LocalRuntimeQueueError extends Error {
  code: QueueErrorCode;

  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LocalRuntimeQueueError';
  }
}

export interface LocalRuntimeQueueOptions {
  baseDir?: string;
  lockStaleMs?: number;
  lockWaitMs?: number;
  lockRetryMs?: number;
  pollIntervalMs?: number;
  leaseTtlMs?: number;
  leaseHeartbeatMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toRequestKey(input: QueueAcquireInput): string {
  return `${input.agentId}:${input.sessionId}:${input.requestId}`;
}

function toRuntimeQueueConfig(config: ResolvedRuntimeConfig): RuntimeQueueConfig {
  return {
    maxActiveRequests: config.max_active_requests,
    queueWaitTimeoutMs: config.queue_wait_timeout_ms,
    queueMaxLength: config.queue_max_length,
  };
}

function fromRuntimeQueueConfig(config: RuntimeQueueConfig): ResolvedRuntimeConfig {
  return {
    max_active_requests: config.maxActiveRequests,
    queue_wait_timeout_ms: config.queueWaitTimeoutMs,
    queue_max_length: config.queueMaxLength,
  };
}

export class LocalRuntimeQueue implements RuntimeQueueController {
  private runtimeRoot: string;
  private statePath: string;
  private lockPath: string;
  private config: RuntimeQueueConfig;
  private lockStaleMs: number;
  private lockWaitMs: number;
  private lockRetryMs: number;
  private pollIntervalMs: number;
  private leaseTtlMs: number;
  private leaseHeartbeatMs: number;

  constructor(config: RuntimeQueueConfig, opts: LocalRuntimeQueueOptions = {}) {
    this.config = config;
    const baseDir = opts.baseDir || join(homedir(), '.agent-mesh');
    this.runtimeRoot = join(baseDir, 'runtime');
    this.statePath = join(this.runtimeRoot, 'queue-state.json');
    this.lockPath = join(this.runtimeRoot, 'queue.lock');
    this.lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockWaitMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockRetryMs = opts.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.leaseHeartbeatMs = opts.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS;
    this.ensureRuntimeDir();
  }

  async acquire(input: QueueAcquireInput, opts: { signal?: AbortSignal } = {}): Promise<QueueLease> {
    const requestKey = toRequestKey(input);
    const queueId = crypto.randomUUID();
    const deadlineAt = Date.now() + this.config.queueWaitTimeoutMs;
    const signal = opts.signal;

    if (signal?.aborted) {
      throw new LocalRuntimeQueueError('queue_aborted', 'Queue wait aborted');
    }

    await this.withLock(async (state) => {
      const now = Date.now();
      this.cleanupLockedState(state, now);

      if (state.active[requestKey]) {
        // Duplicate acquire after reconnect/race; treat as cancelled to avoid double-running.
        throw new LocalRuntimeQueueError('queue_cancelled', 'Request is already active');
      }

      if (state.queue.some((entry) => entry.request_key === requestKey)) {
        throw new LocalRuntimeQueueError('queue_cancelled', 'Request is already queued');
      }

      if (state.queue.length >= this.config.queueMaxLength) {
        throw new LocalRuntimeQueueError('queue_full', `Local queue full (${this.config.queueMaxLength})`);
      }

      state.queue.push({
        queue_id: queueId,
        request_key: requestKey,
        agent_id: input.agentId,
        session_id: input.sessionId,
        request_id: input.requestId,
        pid: input.pid,
        enqueued_at: now,
        deadline_at: deadlineAt,
      });
    });

    while (true) {
      if (signal?.aborted) {
        await this.removeQueuedByKey(requestKey);
        throw new LocalRuntimeQueueError('queue_aborted', 'Queue wait aborted');
      }

      let promotedLease: ActiveLease | null = null;
      let queuePosition = -1;
      let activeCount = 0;

      await this.withLock(async (state) => {
        const now = Date.now();
        this.cleanupLockedState(state, now);
        activeCount = Object.keys(state.active).length;
        queuePosition = state.queue.findIndex((entry) => entry.request_key === requestKey);

        if (queuePosition === -1) {
          if (state.active[requestKey]) {
            promotedLease = state.active[requestKey];
          }
          return;
        }

        const entry = state.queue[queuePosition];
        if (entry.deadline_at <= now) {
          state.queue.splice(queuePosition, 1);
          throw new LocalRuntimeQueueError('queue_timeout', `Local queue wait timeout (${Math.floor(this.config.queueWaitTimeoutMs / 1000)}s)`);
        }

        if (queuePosition === 0 && activeCount < this.config.maxActiveRequests) {
          state.queue.shift();
          const lease: ActiveLease = {
            lease_id: crypto.randomUUID(),
            request_key: requestKey,
            agent_id: input.agentId,
            session_id: input.sessionId,
            request_id: input.requestId,
            pid: input.pid,
            acquired_at: now,
            lease_expires_at: now + this.leaseTtlMs,
          };
          state.active[requestKey] = lease;
          promotedLease = lease;
          activeCount = Object.keys(state.active).length;
        }
      });

      if (promotedLease) {
        if (queuePosition > 0) {
          log.debug(`Queue promoted after race: request=${requestKey} active=${activeCount}/${this.config.maxActiveRequests}`);
        }
        return this.createLease(promotedLease);
      }

      if (queuePosition === -1) {
        if (Date.now() >= deadlineAt) {
          throw new LocalRuntimeQueueError('queue_timeout', `Local queue wait timeout (${Math.floor(this.config.queueWaitTimeoutMs / 1000)}s)`);
        }
        throw new LocalRuntimeQueueError('queue_cancelled', 'Request was removed from local queue');
      }

      await sleep(this.pollIntervalMs);
    }
  }

  async cancelQueued(input: QueueAcquireInput): Promise<boolean> {
    return this.removeQueuedByKey(toRequestKey(input));
  }

  async snapshot(): Promise<{ active: number; queued: number; config: RuntimeQueueConfig }> {
    let active = 0;
    let queued = 0;
    await this.withLock(async (state) => {
      this.cleanupLockedState(state, Date.now());
      active = Object.keys(state.active).length;
      queued = state.queue.length;
    });
    return {
      active,
      queued,
      config: { ...this.config },
    };
  }

  private async removeQueuedByKey(requestKey: string): Promise<boolean> {
    let removed = false;
    await this.withLock(async (state) => {
      const idx = state.queue.findIndex((entry) => entry.request_key === requestKey);
      if (idx >= 0) {
        state.queue.splice(idx, 1);
        removed = true;
      }
    });
    return removed;
  }

  private createLease(activeLease: ActiveLease): QueueLease {
    let released = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    return {
      leaseId: activeLease.lease_id,
      requestKey: activeLease.request_key,
      release: async (_reason) => {
        if (released) return;
        released = true;
        stopHeartbeat();
        await this.withLock(async (state) => {
          const current = state.active[activeLease.request_key];
          if (current?.lease_id === activeLease.lease_id) {
            delete state.active[activeLease.request_key];
          }
        });
      },
      startHeartbeat: () => {
        if (released || heartbeatTimer) {
          return stopHeartbeat;
        }
        heartbeatTimer = setInterval(() => {
          void this.extendLease(activeLease.request_key, activeLease.lease_id);
        }, this.leaseHeartbeatMs);
        heartbeatTimer.unref?.();
        return stopHeartbeat;
      },
    };
  }

  private async extendLease(requestKey: string, leaseId: string): Promise<void> {
    try {
      await this.withLock(async (state) => {
        const lease = state.active[requestKey];
        if (lease && lease.lease_id === leaseId) {
          lease.lease_expires_at = Date.now() + this.leaseTtlMs;
        }
      });
    } catch (err) {
      log.debug(`Failed to extend local queue lease: ${err}`);
    }
  }

  private ensureRuntimeDir(): void {
    if (!existsSync(this.runtimeRoot)) {
      mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    }
  }

  private defaultState(): QueueState {
    return {
      version: 1,
      config: fromRuntimeQueueConfig(this.config),
      active: {},
      queue: [],
      updated_at: Date.now(),
    };
  }

  private readState(): QueueState {
    try {
      const raw = readFileSync(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<QueueState>;
      if (parsed && parsed.version === 1 && parsed.active && Array.isArray(parsed.queue)) {
        return {
          version: 1,
          config: fromRuntimeQueueConfig(this.config),
          active: parsed.active as Record<string, ActiveLease>,
          queue: parsed.queue as QueueEntry[],
          updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : Date.now(),
        };
      }
    } catch {
      // fallthrough
    }
    return this.defaultState();
  }

  private writeState(state: QueueState): void {
    state.config = fromRuntimeQueueConfig(this.config);
    state.updated_at = Date.now();
    const tmpPath = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmpPath, this.statePath);
  }

  private cleanupLockedState(state: QueueState, now: number): void {
    for (const [key, lease] of Object.entries(state.active)) {
      const expired = lease.lease_expires_at <= now;
      const deadPid = !isProcessAlive(lease.pid);
      if (expired || deadPid) {
        delete state.active[key];
      }
    }

    state.queue = state.queue.filter((entry) => {
      if (entry.deadline_at <= now) return false;
      if (!isProcessAlive(entry.pid)) return false;
      return true;
    });
  }

  private async withLock<T>(fn: (state: QueueState) => Promise<T> | T): Promise<T> {
    this.ensureRuntimeDir();
    const acquiredAt = Date.now();

    while (true) {
      try {
        mkdirSync(this.lockPath, { mode: 0o700 });
        break;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'EEXIST') {
          throw err;
        }

        try {
          const st = statSync(this.lockPath);
          if (Date.now() - st.mtimeMs > this.lockStaleMs) {
            rmSync(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() - acquiredAt >= this.lockWaitMs) {
          throw new Error('Timed out waiting for local runtime queue lock');
        }
        await sleep(this.lockRetryMs);
      }
    }

    try {
      const state = this.readState();
      try {
        const result = await fn(state);
        this.writeState(state);
        return result;
      } catch (err) {
        try {
          this.writeState(state);
        } catch {
          // Best-effort; preserve original error
        }
        throw err;
      }
    } finally {
      try {
        rmSync(this.lockPath, { recursive: true, force: true });
      } catch {
        // Ignore unlock failures
      }
    }
  }
}

export function createLocalRuntimeQueue(config: ResolvedRuntimeConfig): LocalRuntimeQueue {
  return new LocalRuntimeQueue(toRuntimeQueueConfig(config));
}
