import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger.js';

const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

/**
 * 从 ~/.openclaw/openclaw.json 读取 gateway token
 * 返回 null 如果文件不存在或格式无效
 */
export function readOpenClawToken(configPath?: string): string | null {
  const path = configPath || OPENCLAW_CONFIG_PATH;
  try {
    const raw = readFileSync(path, 'utf-8');
    const config = JSON.parse(raw);
    const token = config?.gateway?.auth?.token;
    if (typeof token === 'string' && token.length > 0) {
      return token;
    }
    log.warn('OpenClaw config found but gateway.auth.token is missing or empty');
    return null;
  } catch {
    return null;
  }
}
