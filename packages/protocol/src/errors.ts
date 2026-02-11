/** Standard Bridge Protocol error codes */
export const BridgeErrorCode = {
  TIMEOUT: 'timeout',
  ADAPTER_CRASH: 'adapter_crash',
  AGENT_BUSY: 'agent_busy',
  AUTH_FAILED: 'auth_failed',
  AGENT_OFFLINE: 'agent_offline',
  INVALID_MESSAGE: 'invalid_message',
  SESSION_NOT_FOUND: 'session_not_found',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type BridgeErrorCode = (typeof BridgeErrorCode)[keyof typeof BridgeErrorCode];

/** WebSocket close codes (4000-4999 = application-specific) */
export const WS_CLOSE_REPLACED = 4001;
export const WS_CLOSE_TOKEN_REVOKED = 4002;
