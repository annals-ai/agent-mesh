import { listAgents, findAgentByAgentId } from '../utils/config.js';
import type { PlatformClient } from './api-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AgentListResponse {
  agents: Array<{ id: string; name: string }>;
}

/**
 * Resolve a user-provided identifier to an agent UUID.
 *
 * Resolution order:
 * 1. UUID format → use directly
 * 2. Local config alias (key in ~/.agent-bridge/config.json agents map) → get agentId
 * 3. Remote name match (case-insensitive) → fetch from platform API
 */
export async function resolveAgentId(
  input: string,
  client: PlatformClient,
): Promise<{ id: string; name: string }> {
  // 1. UUID → direct
  if (UUID_RE.test(input)) {
    return { id: input, name: input };
  }

  // 2. Local alias
  const local = listAgents();
  if (input in local) {
    return { id: local[input].agentId, name: input };
  }

  // Also try finding by agentId in case the input matches a stored agentId
  const byId = findAgentByAgentId(input);
  if (byId) {
    return { id: byId.entry.agentId, name: byId.name };
  }

  // 3. Remote name match
  const data = await client.get<AgentListResponse>('/api/developer/agents');
  const lower = input.toLowerCase();
  const match = data.agents.find((a) => a.name.toLowerCase() === lower);
  if (match) {
    return { id: match.id, name: match.name };
  }

  throw new Error(`Agent not found: "${input}". Use a UUID, local alias, or exact agent name.`);
}
