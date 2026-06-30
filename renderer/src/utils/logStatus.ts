export type LogStatusState = 'live' | 'interrupted' | 'stopped';

export function nextLogStatus(current: LogStatusState, event: { running?: boolean; stopEvent?: boolean }): LogStatusState {
  if (current === 'stopped') return 'stopped';
  if (event.stopEvent) return 'stopped';
  if (event.running) return 'interrupted';
  return 'stopped';
}
