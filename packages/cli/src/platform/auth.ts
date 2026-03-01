import { loadConfig, updateConfig } from '../utils/config.js';

export function loadToken(): string | undefined {
  return process.env.AGENT_MESH_TOKEN || loadConfig().token;
}

export function saveToken(token: string): void {
  updateConfig({ token });
}

export function hasToken(): boolean {
  return !!loadToken();
}
