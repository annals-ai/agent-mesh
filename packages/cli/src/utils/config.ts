import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AgentEntry {
  agentId: string;
  agentType: string;          // openclaw | claude | codex | gemini
  bridgeUrl: string;
  bridgeToken?: string;       // bt_ prefix (legacy, kept for config compat)
  gatewayUrl?: string;
  gatewayToken?: string;
  projectPath?: string;       // working directory (Claude adapter needs)
  sandbox?: boolean;
  addedAt: string;            // ISO timestamp
}

export interface BridgeConfig {
  token?: string;                          // platform auth token (login writes)
  agents: Record<string, AgentEntry>;      // key = agent alias (slug)
}

const CONFIG_DIR = join(homedir(), '.agent-bridge');
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
