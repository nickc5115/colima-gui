import { describe, expect, it } from 'vitest';
import { RefreshCoordinator } from './refreshCoordinator';

describe('RefreshCoordinator', () => {
  it('queues one follow-up refresh while a refresh is running', async () => {
    let resolveFirst!: () => void;
    let calls = 0;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const c = new RefreshCoordinator(async () => {
      calls += 1;
      if (calls === 1) await first;
    });
    const p1 = c.request();
    await c.request();
    await c.request();
    expect(calls).toBe(1);
    resolveFirst();
    await p1;
    expect(calls).toBe(2);
  });
});
