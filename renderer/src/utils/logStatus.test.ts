import { describe, expect, it } from 'vitest';
import { nextLogStatus } from './logStatus';

describe('log status reducer', () => {
  it('does not treat a dropped stream as stopped when the container is running', () => {
    expect(nextLogStatus('live', { running: true })).toBe('interrupted');
  });

  it('marks a real stop event stopped', () => {
    expect(nextLogStatus('interrupted', { stopEvent: true })).toBe('stopped');
  });

  it('stays stopped once stopped', () => {
    expect(nextLogStatus('stopped', { running: true })).toBe('stopped');
  });
});
