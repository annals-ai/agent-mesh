import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface BridgeConfig {
  token?: string;
  agentId?: string;
  defaultAgentType?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  bridgeUrl?: string;
}

const CONFIG_DIR = join(homedir(), '.agent-bridge');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): BridgeConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveConfig(config: BridgeConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function updateConfig(partial: Partial<BridgeConfig>): void {
  const existing = loadConfig();
  saveConfig({ ...existing, ...partial });
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
