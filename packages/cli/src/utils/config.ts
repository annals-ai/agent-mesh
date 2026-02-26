import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AgentEntry {
  agentId: string;
  agentType: string;          // claude
  bridgeUrl: string;
  bridgeToken?: string;       // bt_ prefix (legacy, kept for config compat)
  gatewayUrl?: string;
  gatewayToken?: string;
  projectPath?: string;       // working directory (Claude adapter needs)
  sandbox?: boolean;
  addedAt: string;            // ISO timestamp
  startedAt?: number;         // Unix ms, set by spawnBackground each time agent starts
}

export interface BridgeConfig {
  token?: string;                          // platform auth token (login writes)
  agents: Record<string, AgentEntry>;      // key = agent alias (slug)
  runtime?: RuntimeConfig;
}

export interface RuntimeConfig {
  max_active_requests?: number;
  queue_wait_timeout_ms?: number;
  queue_max_length?: number;
}

export interface ResolvedRuntimeConfig {
  max_active_requests: number;
  queue_wait_timeout_ms: number;
  queue_max_length: number;
}

export const DEFAULT_RUNTIME_CONFIG: ResolvedRuntimeConfig = {
  max_active_requests: 100,
  queue_wait_timeout_ms: 10 * 60_000,
  queue_max_length: 1000,
};

const CONFIG_DIR = join(homedir(), '.agent-mesh');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PIDS_DIR = join(CONFIG_DIR, 'pids');
const LOGS_DIR = join(CONFIG_DIR, 'logs');

function ensureDir(): void {
  for (const dir of [CONFIG_DIR, PIDS_DIR, LOGS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

export function loadConfig(): BridgeConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { agents: {} };
  }
}

export function saveConfig(config: BridgeConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

export function updateConfig(partial: Partial<BridgeConfig>): void {
  const existing = loadConfig();
  saveConfig({ ...existing, ...partial });
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const n = Math.floor(raw);
  return n > 0 ? n : undefined;
}

export function resolveRuntimeConfig(config?: BridgeConfig): ResolvedRuntimeConfig {
  const runtime = (config || loadConfig()).runtime || {};

  return {
    max_active_requests: parsePositiveInt(runtime.max_active_requests) ?? DEFAULT_RUNTIME_CONFIG.max_active_requests,
    queue_wait_timeout_ms: parsePositiveInt(runtime.queue_wait_timeout_ms) ?? DEFAULT_RUNTIME_CONFIG.queue_wait_timeout_ms,
    queue_max_length: parsePositiveInt(runtime.queue_max_length) ?? DEFAULT_RUNTIME_CONFIG.queue_max_length,
  };
}

export function getRuntimeConfig(): ResolvedRuntimeConfig {
  return resolveRuntimeConfig(loadConfig());
}

export function updateRuntimeConfig(partial: Partial<RuntimeConfig>): ResolvedRuntimeConfig {
  const config = loadConfig();
  config.runtime = { ...(config.runtime || {}), ...partial };
  saveConfig(config);
  return resolveRuntimeConfig(config);
}

export function resetRuntimeConfig(): ResolvedRuntimeConfig {
  const config = loadConfig();
  config.runtime = { ...DEFAULT_RUNTIME_CONFIG };
  saveConfig(config);
  return resolveRuntimeConfig(config);
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getPidsDir(): string {
  ensureDir();
  return PIDS_DIR;
}

export function getLogsDir(): string {
  ensureDir();
  return LOGS_DIR;
}

// --- Agent registry ---

export function getAgent(name: string): AgentEntry | undefined {
  return loadConfig().agents[name];
}

export function addAgent(name: string, entry: AgentEntry): void {
  const config = loadConfig();
  config.agents[name] = entry;
  saveConfig(config);
}

export function removeAgent(name: string): void {
  const config = loadConfig();
  delete config.agents[name];
  saveConfig(config);
}

export function saveAgentStartTime(name: string, ts: number): void {
  const config = loadConfig();
  if (config.agents[name]) {
    config.agents[name].startedAt = ts;
    saveConfig(config);
  }
}

export function listAgents(): Record<string, AgentEntry> {
  return loadConfig().agents;
}

export function findAgentByAgentId(agentId: string): { name: string; entry: AgentEntry } | undefined {
  const agents = loadConfig().agents;
  for (const [name, entry] of Object.entries(agents)) {
    if (entry.agentId === agentId) return { name, entry };
  }
  return undefined;
}

// --- Agent workspace ---

const AGENTS_DIR = join(CONFIG_DIR, 'agents');

/**
 * Get (and create) the dedicated workspace directory for an agent.
 * Each agent gets `~/.agent-mesh/agents/<name>/` as its project root.
 * Developer defines role + skills here: `CLAUDE.md` + `.claude/skills/`
 */
export function getAgentWorkspaceDir(name: string): string {
  const dir = join(AGENTS_DIR, name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// --- Slug helpers ---

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')  // non-letter/digit → hyphen
    .replace(/^-+|-+$/g, '')             // trim leading/trailing hyphens
    || 'agent';
}

export function uniqueSlug(base: string): string {
  const agents = loadConfig().agents;
  const slug = slugify(base);
  if (!(slug in agents)) return slug;
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!(candidate in agents)) return candidate;
  }
}
