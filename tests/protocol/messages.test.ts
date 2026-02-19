import { describe, it, expect } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeErrorCode,
  type Register,
  type Chunk,
  type Done,
  type BridgeError,
  type Heartbeat,
  type Registered,
  type Message,
  type Cancel,
  type BridgeMessage,
  type RelayRequest,
  type RelayEvent,
} from '../../packages/protocol/src/index.js';

describe('Bridge Protocol', () => {
  describe('version', () => {
    it('should be version 1', () => {
      expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
    });
  });

  describe('error codes', () => {
    it('should define standard error codes', () => {
      expect(BridgeErrorCode.TIMEOUT).toBe('timeout');
      expect(BridgeErrorCode.ADAPTER_CRASH).toBe('adapter_crash');
      expect(BridgeErrorCode.AGENT_BUSY).toBe('agent_busy');
      expect(BridgeErrorCode.AUTH_FAILED).toBe('auth_failed');
      expect(BridgeErrorCode.AGENT_OFFLINE).toBe('agent_offline');
      expect(BridgeErrorCode.INVALID_MESSAGE).toBe('invalid_message');
      expect(BridgeErrorCode.SESSION_NOT_FOUND).toBe('session_not_found');
      expect(BridgeErrorCode.RATE_LIMITED).toBe('rate_limited');
      expect(BridgeErrorCode.INTERNAL_ERROR).toBe('internal_error');
    });
  });

  describe('Bridge → Worker messages', () => {
    it('should serialize Register message', () => {
      const msg: Register = {
        type: 'register',
        agent_id: 'agent-123',
        token: 'sb_test_token',
        bridge_version: '0.1.0',
        agent_type: 'openclaw',
        capabilities: ['streaming', 'file_upload'],
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json) as Register;

      expect(parsed.type).toBe('register');
      expect(parsed.agent_id).toBe('agent-123');
      expect(parsed.capabilities).toEqual(['streaming', 'file_upload']);
    });

    it('should serialize Chunk message', () => {
      const msg: Chunk = {
        type: 'chunk',
        session_id: 'session-1',
        request_id: 'req-1',
        delta: 'Hello ',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as Chunk;
      expect(parsed.type).toBe('chunk');
      expect(parsed.delta).toBe('Hello ');
    });

    it('should serialize Done message', () => {
      const msg: Done = {
        type: 'done',
        session_id: 'session-1',
        request_id: 'req-1',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as Done;
      expect(parsed.type).toBe('done');
    });

    it('should serialize Error message', () => {
      const msg: BridgeError = {
        type: 'error',
        session_id: 'session-1',
        request_id: 'req-1',
        code: BridgeErrorCode.TIMEOUT,
        message: 'Agent timed out',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as BridgeError;
      expect(parsed.type).toBe('error');
      expect(parsed.code).toBe('timeout');
    });

    it('should serialize Heartbeat message', () => {
      const msg: Heartbeat = {
        type: 'heartbeat',
        active_sessions: 2,
        uptime_ms: 60000,
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as Heartbeat;
      expect(parsed.type).toBe('heartbeat');
      expect(parsed.active_sessions).toBe(2);
    });
  });

  describe('Worker → Bridge messages', () => {
    it('should serialize Registered ok', () => {
      const msg: Registered = {
        type: 'registered',
        status: 'ok',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as Registered;
      expect(parsed.status).toBe('ok');
    });

    it('should serialize Registered error', () => {
      const msg: Registered = {
        type: 'registered',
        status: 'error',
        error: 'Invalid token',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as Registered;
      expect(parsed.status).toBe('error');
      expect(parsed.error).toBe('Invalid token');
    });

    it('should serialize Message', () => {
      const msg: Message = {
        type: 'message',
        session_id: 'session-1',
        request_id: 'req-1',
        content: 'Hello agent!',
        attachments: [
          { name: 'file.txt', url: 'https://files.agents.hot/abc', type: 'text/plain' },
        ],
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as Message;
      expect(parsed.content).toBe('Hello agent!');
      expect(parsed.attachments).toHaveLength(1);
      expect(parsed.attachments[0].name).toBe('file.txt');
    });

    it('should serialize Cancel', () => {
      const msg: Cancel = {
        type: 'cancel',
        session_id: 'session-1',
        request_id: 'req-1',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as Cancel;
      expect(parsed.type).toBe('cancel');
    });
  });

  describe('BridgeMessage union type', () => {
    it('should accept all message types including A2A', () => {
      const messages: BridgeMessage[] = [
        { type: 'register', agent_id: 'a', token: 't', bridge_version: '1', agent_type: 'claude', capabilities: [] },
        { type: 'chunk', session_id: 's', request_id: 'r', delta: 'x' },
        { type: 'done', session_id: 's', request_id: 'r' },
        { type: 'error', session_id: 's', request_id: 'r', code: 'timeout', message: 'err' },
        { type: 'heartbeat', active_sessions: 0, uptime_ms: 0 },
        { type: 'registered', status: 'ok' },
        { type: 'message', session_id: 's', request_id: 'r', content: 'hi', attachments: [] },
        { type: 'cancel', session_id: 's', request_id: 'r' },
        // A2A messages
        { type: 'discover_agents' },
        { type: 'call_agent', target_agent_id: 'a', task_description: 'test' },
        { type: 'discover_agents_result', agents: [] },
        { type: 'call_agent_chunk', call_id: 'c', delta: '' },
        { type: 'call_agent_done', call_id: 'c' },
        { type: 'call_agent_error', call_id: 'c', code: 'e', message: 'm' },
      ];

      expect(messages).toHaveLength(14);

      // Verify type discriminant works
      for (const msg of messages) {
        expect(msg.type).toBeTruthy();
      }
    });
  });

  describe('Relay API types', () => {
    it('should serialize RelayRequest', () => {
      const req: RelayRequest = {
        agent_id: 'agent-1',
        session_id: 'session-1',
        request_id: 'req-1',
        content: 'Hello',
        attachments: [],
      };

      const parsed = JSON.parse(JSON.stringify(req)) as RelayRequest;
      expect(parsed.agent_id).toBe('agent-1');
      expect(parsed.content).toBe('Hello');
    });

    it('should serialize RelayEvents', () => {
      const events: RelayEvent[] = [
        { type: 'chunk', delta: 'text' },
        { type: 'done' },
        { type: 'error', code: 'timeout', message: 'timed out' },
      ];

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('chunk');
      expect(events[1].type).toBe('done');
      expect(events[2].type).toBe('error');
    });
  });
});
