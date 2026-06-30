import { describe, expect, it } from 'vitest';
import { formatDate, humanSize, sizeToBytes } from './format';

describe('format utils', () => {
  it('formats byte sizes', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(1024 * 1024 * 12)).toBe('12 MB');
  });

  it('parses display sizes for sorting', () => {
    expect(sizeToBytes('1 KB')).toBe(1024);
    expect(sizeToBytes('1.5 MB')).toBe(1572864);
  });

  it('returns a dash for invalid dates', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });
});
