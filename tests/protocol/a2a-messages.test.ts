import { describe, it, expect } from 'vitest';
import type {
  DiscoverAgents,
  DiscoverAgentsResult,
  CallAgent,
  CallAgentChunk,
  CallAgentDone,
  CallAgentError,
  A2ACallRequest,
  A2ACallEvent,
  BridgeToWorkerMessage,
  WorkerToBridgeMessage,
  BridgeMessage,
} from '../../packages/protocol/src/index.js';

describe('A2A Protocol Messages', () => {
  describe('Bridge → Worker (upstream)', () => {
    it('should serialize DiscoverAgents message', () => {
      const msg: DiscoverAgents = {
        type: 'discover_agents',
        capability: 'translation',
        limit: 10,
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as DiscoverAgents;
      expect(parsed.type).toBe('discover_agents');
      expect(parsed.capability).toBe('translation');
      expect(parsed.limit).toBe(10);
    });

    it('should serialize DiscoverAgents without optional fields', () => {
      const msg: DiscoverAgents = {
        type: 'discover_agents',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as DiscoverAgents;
      expect(parsed.type).toBe('discover_agents');
      expect(parsed.capability).toBeUndefined();
      expect(parsed.limit).toBeUndefined();
    });

    it('should serialize CallAgent message', () => {
      const msg: CallAgent = {
        type: 'call_agent',
        target_agent_id: '21599ddd-8ca6-4566-82ae-77d10e4611a7',
        task_description: 'Translate this text to Chinese',
        call_id: 'call-123',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as CallAgent;
      expect(parsed.type).toBe('call_agent');
      expect(parsed.target_agent_id).toBe('21599ddd-8ca6-4566-82ae-77d10e4611a7');
      expect(parsed.task_description).toBe('Translate this text to Chinese');
      expect(parsed.call_id).toBe('call-123');
    });

    it('should serialize CallAgent without optional call_id', () => {
      const msg: CallAgent = {
        type: 'call_agent',
        target_agent_id: '21599ddd-8ca6-4566-82ae-77d10e4611a7',
        task_description: 'Review this code',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as CallAgent;
      expect(parsed.call_id).toBeUndefined();
    });
  });

  describe('Worker → Bridge (downstream)', () => {
    it('should serialize DiscoverAgentsResult', () => {
      const msg: DiscoverAgentsResult = {
        type: 'discover_agents_result',
        agents: [
          {
            id: 'agent-1',
            name: 'SEO Bot',
            agent_type: 'claude',
            capabilities: ['seo', 'content'],
            is_online: true,
          },
          {
            id: 'agent-2',
            name: 'Translator',
            agent_type: 'claude',
            capabilities: ['translation'],
            is_online: false,
          },
        ],
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as DiscoverAgentsResult;
      expect(parsed.type).toBe('discover_agents_result');
      expect(parsed.agents).toHaveLength(2);
      expect(parsed.agents[0].name).toBe('SEO Bot');
      expect(parsed.agents[0].is_online).toBe(true);
      expect(parsed.agents[1].capabilities).toEqual(['translation']);
    });

    it('should serialize empty DiscoverAgentsResult', () => {
      const msg: DiscoverAgentsResult = {
        type: 'discover_agents_result',
        agents: [],
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as DiscoverAgentsResult;
      expect(parsed.agents).toHaveLength(0);
    });

    it('should serialize CallAgentChunk', () => {
      const msg: CallAgentChunk = {
        type: 'call_agent_chunk',
        call_id: 'call-123',
        delta: 'Here is the translation: ',
        kind: 'text',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as CallAgentChunk;
      expect(parsed.type).toBe('call_agent_chunk');
      expect(parsed.call_id).toBe('call-123');
      expect(parsed.delta).toBe('Here is the translation: ');
      expect(parsed.kind).toBe('text');
    });

    it('should serialize CallAgentDone', () => {
      const msg: CallAgentDone = {
        type: 'call_agent_done',
        call_id: 'call-123',
        attachments: [{ name: 'result.txt', url: 'https://files.agents.hot/xyz', type: 'text/plain' }],
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as CallAgentDone;
      expect(parsed.type).toBe('call_agent_done');
      expect(parsed.attachments).toHaveLength(1);
    });

    it('should serialize CallAgentDone without attachments', () => {
      const msg: CallAgentDone = {
        type: 'call_agent_done',
        call_id: 'call-123',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as CallAgentDone;
      expect(parsed.attachments).toBeUndefined();
    });

    it('should serialize CallAgentError', () => {
      const msg: CallAgentError = {
        type: 'call_agent_error',
        call_id: 'call-123',
        code: 'rate_limited',
        message: 'Target agent rate limit exceeded',
      };

      const parsed = JSON.parse(JSON.stringify(msg)) as CallAgentError;
      expect(parsed.type).toBe('call_agent_error');
      expect(parsed.code).toBe('rate_limited');
      expect(parsed.message).toBe('Target agent rate limit exceeded');
    });
  });

  describe('Union types include A2A messages', () => {
    it('should accept A2A messages in BridgeToWorkerMessage', () => {
      const messages: BridgeToWorkerMessage[] = [
        { type: 'discover_agents', capability: 'seo' },
        { type: 'call_agent', target_agent_id: 'a', task_description: 'test' },
      ];

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('discover_agents');
      expect(messages[1].type).toBe('call_agent');
    });

    it('should accept A2A messages in WorkerToBridgeMessage', () => {
      const messages: WorkerToBridgeMessage[] = [
        { type: 'discover_agents_result', agents: [] },
        { type: 'call_agent_chunk', call_id: 'c1', delta: 'hi' },
        { type: 'call_agent_done', call_id: 'c1' },
        { type: 'call_agent_error', call_id: 'c1', code: 'timeout', message: 'err' },
      ];

      expect(messages).toHaveLength(4);
    });

    it('should include all A2A types in BridgeMessage', () => {
      const messages: BridgeMessage[] = [
        { type: 'discover_agents' },
        { type: 'call_agent', target_agent_id: 'a', task_description: 'test' },
        { type: 'discover_agents_result', agents: [] },
        { type: 'call_agent_chunk', call_id: 'c1', delta: '' },
        { type: 'call_agent_done', call_id: 'c1' },
        { type: 'call_agent_error', call_id: 'c1', code: 'e', message: 'm' },
      ];

      expect(messages).toHaveLength(6);
      for (const msg of messages) {
        expect(msg.type).toBeTruthy();
      }
    });
  });

  describe('A2A API types', () => {
    it('should serialize A2ACallRequest', () => {
      const req: A2ACallRequest = {
        caller_agent_id: 'agent-1',
        target_agent_id: 'agent-2',
        task_description: 'Translate to French',
      };

      const parsed = JSON.parse(JSON.stringify(req)) as A2ACallRequest;
      expect(parsed.caller_agent_id).toBe('agent-1');
      expect(parsed.target_agent_id).toBe('agent-2');
      expect(parsed.task_description).toBe('Translate to French');
    });

    it('should serialize A2ACallEvents (same as RelayEvents)', () => {
      const events: A2ACallEvent[] = [
        { type: 'chunk', delta: 'translating...' },
        { type: 'done' },
        { type: 'error', code: 'timeout', message: 'timed out' },
        { type: 'keepalive' },
      ];

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('chunk');
      expect(events[3].type).toBe('keepalive');
    });
  });
});
