import { describe, it, expect } from 'vitest';
import { parseSseChunk } from '../../packages/cli/src/utils/sse-parser.js';

describe('parseSseChunk', () => {
  it('should parse a single complete SSE event', () => {
    const raw = 'data: {"type":"chunk","delta":"hello"}\n\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual(['{"type":"chunk","delta":"hello"}']);
    expect(result.carry).toBe('');
  });

  it('should parse multiple SSE events', () => {
    const raw = 'data: {"type":"chunk","delta":"a"}\n\ndata: {"type":"chunk","delta":"b"}\n\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual([
      '{"type":"chunk","delta":"a"}',
      '{"type":"chunk","delta":"b"}',
    ]);
    expect(result.carry).toBe('');
  });

  it('should carry incomplete events to next chunk', () => {
    const raw = 'data: {"type":"ch';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual([]);
    expect(result.carry).toBe('data: {"type":"ch');
  });

  it('should merge carry with next chunk', () => {
    const carry = 'data: {"type":"ch';
    const raw = 'unk","delta":"x"}\n\n';
    const result = parseSseChunk(raw, carry);
    expect(result.events).toEqual(['{"type":"chunk","delta":"x"}']);
    expect(result.carry).toBe('');
  });

  it('should handle multi-line data fields', () => {
    const raw = 'data: line1\ndata: line2\n\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual(['line1\nline2']);
  });

  it('should ignore non-data lines', () => {
    const raw = 'event: message\ndata: hello\nid: 123\n\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual(['hello']);
  });

  it('should handle empty events', () => {
    const raw = '\n\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual([]);
  });

  it('should handle Windows-style line endings', () => {
    const raw = 'data: hello\r\n\r\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual(['hello']);
  });

  it('should trim whitespace from data payloads', () => {
    const raw = 'data:  hello world  \n\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual(['hello world']);
  });

  it('should handle [DONE] signal', () => {
    const raw = 'data: {"type":"chunk","delta":"x"}\n\ndata: [DONE]\n\n';
    const result = parseSseChunk(raw, '');
    expect(result.events).toEqual(['{"type":"chunk","delta":"x"}', '[DONE]']);
  });

  it('should handle multiple chunks building up a complete event', () => {
    // Simulate reading in 3 chunks
    const r1 = parseSseChunk('data: {"typ', '');
    expect(r1.events).toEqual([]);
    expect(r1.carry).toBe('data: {"typ');

    const r2 = parseSseChunk('e":"chunk","del', r1.carry);
    expect(r2.events).toEqual([]);
    expect(r2.carry).toBe('data: {"type":"chunk","del');

    const r3 = parseSseChunk('ta":"ok"}\n\n', r2.carry);
    expect(r3.events).toEqual(['{"type":"chunk","delta":"ok"}']);
    expect(r3.carry).toBe('');
  });
});
