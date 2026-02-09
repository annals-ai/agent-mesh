/**
 * ContentScanner — Worker 层内容安全扫描
 *
 * 在 Bridge Worker (Durable Object) 中运行，所有 Agent 回复
 * 经过这里扫描后才通过 SSE 返回给用户。
 *
 * 特点：
 * - 服务端执行，规则不公开
 * - 支持 KV 热更新规则
 * - 无状态 per-chunk 扫描（不缓冲，不引入延迟）
 */

export interface ScanRule {
  /** Rule identifier */
  name: string;
  /** Regex pattern (string form, will be compiled with 'g' flag) */
  pattern: string;
  /** Replacement text. Defaults to [name_BLOCKED] */
  replacement?: string;
  /** Whether this rule is enabled */
  enabled?: boolean;
}

/** Compiled rule for runtime use */
interface CompiledRule {
  name: string;
  regex: RegExp;
  replacement: string;
}

/**
 * Default rules — high-confidence secret formats.
 * These are compiled at instantiation, not stored in code as RegExp literals
 * (so they can be overridden by KV rules using the same structure).
 */
const DEFAULT_RULES: ScanRule[] = [
  // --- Universal credential formats ---
  { name: 'JWT', pattern: 'eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}' },
  { name: 'PrivateKey', pattern: '-----BEGIN[A-Z ]*PRIVATE KEY-----' },
  { name: 'AWSKey', pattern: 'AKIA[0-9A-Z]{16}' },

  // --- AI / LLM provider API keys ---
  { name: 'OpenAI', pattern: 'sk-proj-[A-Za-z0-9]{20,}' },
  { name: 'Anthropic', pattern: 'sk-ant-[A-Za-z0-9-]{20,}' },
  { name: 'GoogleAI', pattern: 'AIza[0-9A-Za-z_-]{35}' },
  { name: 'Groq', pattern: 'gsk_[a-zA-Z0-9]{20,}' },
  { name: 'HuggingFace', pattern: 'hf_[a-zA-Z0-9]{20,}' },
  { name: 'Replicate', pattern: 'r8_[a-zA-Z0-9]{20,}' },
  { name: 'xAI', pattern: 'xai-[a-zA-Z0-9]{20,}' },
  { name: 'Cohere', pattern: 'co-[a-zA-Z0-9]{20,}' },
  // Catch-all for sk- keys not matched by more specific rules above
  { name: 'APIKey_sk', pattern: 'sk[-_][a-zA-Z0-9]{20,}' },

  // --- Platform tokens ---
  { name: 'BridgeToken', pattern: 'bt_[a-zA-Z0-9]{16,}' },
  { name: 'ConnectTicket', pattern: 'ct_[a-zA-Z0-9]{16,}' },

  // --- Code hosting / SaaS ---
  { name: 'GitHubToken', pattern: 'gh[pousr]_[a-zA-Z0-9]{16,}' },
  { name: 'Stripe', pattern: '[sp]k_(live|test)_[a-zA-Z0-9]{20,}' },
  { name: 'Slack', pattern: 'xox[pboas]-[0-9A-Za-z-]{20,}' },
  { name: 'GoogleOAuth', pattern: 'ya29\\.[0-9A-Za-z_-]{20,}' },
];

export class ContentScanner {
  private rules: CompiledRule[];
  private scanCount = 0;
  private blockCount = 0;

  constructor(rules?: ScanRule[]) {
    this.rules = ContentScanner.compile(rules ?? DEFAULT_RULES);
  }

  /**
   * Load rules from KV. Falls back to defaults if KV is empty or fails.
   *
   * KV key: `content-scanner:rules`
   * KV value: JSON array of ScanRule objects
   */
  static async fromKV(kv: KVNamespace): Promise<ContentScanner> {
    try {
      const raw = await kv.get('content-scanner:rules');
      if (raw) {
        const parsed = JSON.parse(raw) as ScanRule[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return new ContentScanner(parsed);
        }
      }
    } catch {
      // KV read failed, use defaults
    }
    return new ContentScanner();
  }

  /**
   * Scan a chunk of agent output. Returns the (possibly sanitized) text.
   * Stateless — no buffering, no cross-chunk state.
   */
  scan(text: string): string {
    if (!text) return text;
    this.scanCount++;

    let result = text;
    for (const rule of this.rules) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(result)) {
        rule.regex.lastIndex = 0;
        result = result.replace(rule.regex, rule.replacement);
        this.blockCount++;
      }
    }
    return result;
  }

  /** Stats for monitoring */
  get stats() {
    return { scanned: this.scanCount, blocked: this.blockCount, rules: this.rules.length };
  }

  private static compile(rules: ScanRule[]): CompiledRule[] {
    const compiled: CompiledRule[] = [];
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      try {
        compiled.push({
          name: rule.name,
          regex: new RegExp(rule.pattern, 'g'),
          replacement: rule.replacement ?? `[${rule.name}_BLOCKED]`,
        });
      } catch {
        // Invalid regex, skip
      }
    }
    return compiled;
  }
}
