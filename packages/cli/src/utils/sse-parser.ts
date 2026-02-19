/**
 * Shared SSE chunk parser
 *
 * Splits raw SSE text into complete data payloads.
 * Handles partial chunks across read boundaries via carry buffer.
 */
export function parseSseChunk(raw: string, carry: string): { events: string[]; carry: string } {
  const merged = carry + raw;
  const blocks = merged.split(/\r?\n\r?\n/);
  const nextCarry = blocks.pop() || '';
  const events: string[] = [];

  for (const block of blocks) {
    let data = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        data += line.slice(5).trimStart() + '\n';
      }
    }
    const trimmed = data.trim();
    if (trimmed) events.push(trimmed);
  }

  return { events, carry: nextCarry };
}
