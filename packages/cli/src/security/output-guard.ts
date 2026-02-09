/**
 * OutputGuard — CLI 层轻量输出兜底
 *
 * 仅做格式化 regex 匹配（API Key、JWT、Private Key 等明确格式）。
 * 无状态、无缓冲，不干扰正常传输。
 *
 * 主要安全扫描已移至 Bridge Worker 服务端。
 */

import { log } from '../utils/logger.js';

/** High-confidence patterns — only match obvious secret formats */
const REDACT_PATTERNS: { name: string; pat: RegExp }[] = [
  // Universal
  { name: 'JWT', pat: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { name: 'PrivateKey', pat: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g },
  { name: 'AWSKey', pat: /AKIA[0-9A-Z]{16}/g },
  // AI / LLM providers
  { name: 'OpenAI', pat: /sk-proj-[A-Za-z0-9]{20,}/g },
  { name: 'Anthropic', pat: /sk-ant-[A-Za-z0-9-]{20,}/g },
  { name: 'GoogleAI', pat: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'Groq', pat: /gsk_[a-zA-Z0-9]{20,}/g },
  { name: 'HuggingFace', pat: /hf_[a-zA-Z0-9]{20,}/g },
  { name: 'Replicate', pat: /r8_[a-zA-Z0-9]{20,}/g },
  { name: 'xAI', pat: /xai-[a-zA-Z0-9]{20,}/g },
  { name: 'APIKey_sk', pat: /sk[-_][a-zA-Z0-9]{20,}/g },
  // Platform / SaaS
  { name: 'BridgeToken', pat: /bt_[a-zA-Z0-9]{16,}/g },
  { name: 'ConnectTicket', pat: /ct_[a-zA-Z0-9]{16,}/g },
  { name: 'GitHubToken', pat: /gh[pousr]_[a-zA-Z0-9]{16,}/g },
];

export class OutputGuard {
  private redactCount = 0;

  /**
   * Sanitize a text chunk. Stateless — no buffering, no side effects.
   * Only catches high-confidence secret formats (long, distinctive patterns).
   */
  sanitize(text: string): string {
    if (!text) return text;
    let result = text;

    for (const { name, pat } of REDACT_PATTERNS) {
      pat.lastIndex = 0;
      if (pat.test(result)) {
        pat.lastIndex = 0;
        result = result.replace(pat, `[${name}_REDACTED]`);
        this.redactCount++;
        log.warn(`OutputGuard: redacted ${name} pattern`);
      }
    }

    return result;
  }

  get totalRedactions(): number {
    return this.redactCount;
  }
}
