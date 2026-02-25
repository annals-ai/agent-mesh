import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('LocalRuntimeQueue', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function createQueue(overrides: Partial<{
    maxActiveRequests: number;
    queueWaitTimeoutMs: number;
    queueMaxLength: number;
    pollIntervalMs: number;
    leaseTtlMs: number;
    leaseHeartbeatMs: number;
  }> = {}) {
    const baseDir = mkdtempSync(join(tmpdir(), 'agent-mesh-queue-'));
    tempDirs.push(baseDir);
    return import('../../packages/cli/src/utils/local-runtime-queue.js').then(({ LocalRuntimeQueue }) => {
      return new LocalRuntimeQueue({
        maxActiveRequests: overrides.maxActiveRequests ?? 1,
        queueWaitTimeoutMs: overrides.queueWaitTimeoutMs ?? 500,
        queueMaxLength: overrides.queueMaxLength ?? 10,
      }, {
        baseDir,
        pollIntervalMs: overrides.pollIntervalMs ?? 10,
        leaseTtlMs: overrides.leaseTtlMs ?? 120,
        leaseHeartbeatMs: overrides.leaseHeartbeatMs ?? 40,
      });
    });
  }

  function req(n: number) {
    return {
      agentId: 'agent-1',
      sessionId: `s-${n}`,
      requestId: `r-${n}`,
      pid: process.pid,
    };
  }

  it('acquires immediately and releases', async () => {
    const queue = await createQueue();
    const lease = await queue.acquire(req(1));
    const snap1 = await queue.snapshot();
    expect(snap1.active).toBe(1);
    expect(snap1.queued).toBe(0);

    await lease.release('done');
    const snap2 = await queue.snapshot();
    expect(snap2.active).toBe(0);
    expect(snap2.queued).toBe(0);
  });

  it('queues requests FIFO and promotes after release', async () => {
    const queue = await createQueue({ maxActiveRequests: 1, queueWaitTimeoutMs: 1000 });
    const lease1 = await queue.acquire(req(1));

    const lease2Promise = queue.acquire(req(2));
    await new Promise((r) => setTimeout(r, 30));
    const snapQueued = await queue.snapshot();
    expect(snapQueued.active).toBe(1);
    expect(snapQueued.queued).toBe(1);

    await lease1.release('done');
    const lease2 = await lease2Promise;
    const snap2 = await queue.snapshot();
    expect(snap2.active).toBe(1);
    expect(snap2.queued).toBe(0);

    await lease2.release('done');
  });

  it('rejects when queue is full', async () => {
    const { LocalRuntimeQueueError } = await import('../../packages/cli/src/utils/local-runtime-queue.js');
    const queue = await createQueue({ maxActiveRequests: 1, queueMaxLength: 1, queueWaitTimeoutMs: 1000 });
    const lease1 = await queue.acquire(req(1));
    const waitPromise = queue.acquire(req(2));
    await new Promise((r) => setTimeout(r, 30));

    await expect(queue.acquire(req(3))).rejects.toMatchObject<Partial<LocalRuntimeQueueError>>({
      code: 'queue_full',
    });

    await lease1.release('done');
    const lease2 = await waitPromise;
    await lease2.release('done');
  });

  it('times out while waiting in queue', async () => {
    const { LocalRuntimeQueueError } = await import('../../packages/cli/src/utils/local-runtime-queue.js');
    const queue = await createQueue({ maxActiveRequests: 1, queueWaitTimeoutMs: 80, pollIntervalMs: 10 });
    const lease1 = await queue.acquire(req(1));

    await expect(queue.acquire(req(2))).rejects.toMatchObject<Partial<LocalRuntimeQueueError>>({
      code: 'queue_timeout',
    });

    await lease1.release('done');
  });

  it('supports cancelQueued for waiting requests', async () => {
    const { LocalRuntimeQueueError } = await import('../../packages/cli/src/utils/local-runtime-queue.js');
    const queue = await createQueue({ maxActiveRequests: 1, queueWaitTimeoutMs: 1000 });
    const lease1 = await queue.acquire(req(1));
    const acquire2 = queue.acquire(req(2));

    await new Promise((r) => setTimeout(r, 30));
    expect(await queue.cancelQueued(req(2))).toBe(true);

    await expect(acquire2).rejects.toMatchObject<Partial<LocalRuntimeQueueError>>({
      code: 'queue_cancelled',
    });

    await lease1.release('done');
  });

  it('reclaims stale leases after ttl expiry', async () => {
    const queue = await createQueue({
      maxActiveRequests: 1,
      queueWaitTimeoutMs: 500,
      leaseTtlMs: 60,
      pollIntervalMs: 10,
    });

    await queue.acquire(req(1)); // intentionally do not heartbeat or release
    await new Promise((r) => setTimeout(r, 90));

    const lease2 = await queue.acquire(req(2));
    const snap = await queue.snapshot();
    expect(snap.active).toBe(1);
    expect(snap.queued).toBe(0);
    await lease2.release('done');
  });
});
