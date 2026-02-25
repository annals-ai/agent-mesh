import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQueueSnapshot = vi.fn(async () => ({
  active: 3,
  queued: 7,
  config: {
    maxActiveRequests: 100,
    queueWaitTimeoutMs: 600000,
    queueMaxLength: 1000,
  },
}));

vi.mock('../../packages/cli/src/utils/config.js', () => ({
  DEFAULT_RUNTIME_CONFIG: {
    max_active_requests: 100,
    queue_wait_timeout_ms: 600000,
    queue_max_length: 1000,
  },
  getRuntimeConfig: vi.fn(() => ({
    max_active_requests: 100,
    queue_wait_timeout_ms: 600000,
    queue_max_length: 1000,
  })),
  updateRuntimeConfig: vi.fn((partial: Record<string, unknown>) => ({
    max_active_requests: partial.max_active_requests ?? 100,
    queue_wait_timeout_ms: partial.queue_wait_timeout_ms ?? 600000,
    queue_max_length: partial.queue_max_length ?? 1000,
  })),
  resetRuntimeConfig: vi.fn(() => ({
    max_active_requests: 100,
    queue_wait_timeout_ms: 600000,
    queue_max_length: 1000,
  })),
}));

vi.mock('../../packages/cli/src/utils/local-runtime-queue.js', () => ({
  createLocalRuntimeQueue: vi.fn(() => ({
    snapshot: mockQueueSnapshot,
  })),
}));

vi.mock('../../packages/cli/src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    banner: vi.fn(),
  },
}));

describe('runtime command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  async function run(args: string[]) {
    const { Command } = await import('commander');
    const { registerRuntimeCommand } = await import('../../packages/cli/src/commands/runtime.js');
    const program = new Command();
    program.exitOverride();
    registerRuntimeCommand(program);
    await program.parseAsync(['node', 'agent-mesh', 'runtime', ...args]);
  }

  it('exports registerRuntimeCommand', async () => {
    const { registerRuntimeCommand } = await import('../../packages/cli/src/commands/runtime.js');
    expect(registerRuntimeCommand).toBeTypeOf('function');
  });

  it('shows current runtime settings and queue snapshot', async () => {
    const { getRuntimeConfig } = await import('../../packages/cli/src/utils/config.js');

    await run(['show']);

    expect(getRuntimeConfig).toHaveBeenCalled();
    expect(mockQueueSnapshot).toHaveBeenCalled();
  });

  it('updates runtime settings with parsed values', async () => {
    const { updateRuntimeConfig } = await import('../../packages/cli/src/utils/config.js');
    const { log } = await import('../../packages/cli/src/utils/logger.js');

    await run([
      'set',
      '--max-active-requests', '123',
      '--queue-wait-timeout', '45',
      '--queue-max-length', '999',
    ]);

    expect(updateRuntimeConfig).toHaveBeenCalledWith({
      max_active_requests: 123,
      queue_wait_timeout_ms: 45000,
      queue_max_length: 999,
    });
    expect(log.success).toHaveBeenCalled();
  });

  it('resets runtime settings to defaults', async () => {
    const { resetRuntimeConfig } = await import('../../packages/cli/src/utils/config.js');
    const { log } = await import('../../packages/cli/src/utils/logger.js');

    await run(['reset']);

    expect(resetRuntimeConfig).toHaveBeenCalled();
    expect(log.success).toHaveBeenCalled();
  });

  it('exits with error when set is called without options', async () => {
    const { log } = await import('../../packages/cli/src/utils/logger.js');

    await expect(run(['set'])).rejects.toThrow('process.exit(1)');
    expect(log.error).toHaveBeenCalled();
  });
});

