import { describe, expect, it } from 'vitest';
import { detectLogSeverity } from './colors';

describe('detectLogSeverity', () => {
  it('respects explicit text levels before fallback keywords', () => {
    expect(detectLogSeverity('[2026-06-30 11:54:09,688] INFO : Retry COMPLETED. No failed Items found.')).toBe('info');
    expect(detectLogSeverity('[2026-06-30 11:54:25,621] ERROR: Could not get data')).toBe('error');
  });

  it('respects explicit json severity fields', () => {
    expect(detectLogSeverity('{"severity":"ERROR","text":"Search Error"}')).toBe('error');
    expect(detectLogSeverity('{"level":"info","text":"failed count is zero"}')).toBe('info');
  });
});
