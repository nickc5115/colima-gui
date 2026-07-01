export const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  dim: '\x1b[90m',
  boldRed: '\x1b[1;31m',
};

export type LogSeverity = 'error' | 'warn' | 'info' | 'debug';

function normalizeLevel(level: string): LogSeverity | null {
  const normalized = level.toLowerCase();
  if (/^(error|fatal|severe|panic)$/.test(normalized)) return 'error';
  if (/^warn(?:ing)?$/.test(normalized)) return 'warn';
  if (/^(debug|trace)$/.test(normalized)) return 'debug';
  if (/^(info|notice)$/.test(normalized)) return 'info';
  return null;
}

export function detectLogSeverity(line: string, stream?: string): LogSeverity {
  const jsonLevel = line.match(/"(?:level|severity|status)":\s*"(\w+)"/i);
  const explicitTextLevel = line.match(/(?:^|[\s<[{,])(?:level=)?(ERROR|FATAL|SEVERE|PANIC|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE)(?=\s*[:>\]},]|\s|$)/i);
  const explicit = normalizeLevel(jsonLevel?.[1] || explicitTextLevel?.[1] || '');
  if (explicit) return explicit;
  if (stream === 'stderr' || /\b(error|fatal|severe|exception|panic)\b/i.test(line)) return 'error';
  if (/\b(warn(?:ing)?|deprecated|retry(?:ing)?)\b/i.test(line)) return 'warn';
  return 'info';
}

export function colorizeLine(line: string, stream?: string): string {
  if (line.includes('\x1b')) return line;
  if (/"(?:level|severity|status)":\s*"\w+"/i.test(line)) {
    const severity = detectLogSeverity(line, stream);
    if (severity === 'error') return `${ANSI.boldRed}${line}${ANSI.reset}`;
    if (severity === 'warn') return `${ANSI.yellow}${line}${ANSI.reset}`;
    if (severity === 'debug') return `${ANSI.dim}${line}${ANSI.reset}`;
    return line;
  }
  let out = line;
  out = out.replace(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/g, `${ANSI.dim}$1${ANSI.reset}`);
  out = out.replace(/\b(ERROR|FATAL|SEVERE|PANIC)\b/g, `${ANSI.boldRed}$1${ANSI.reset}`);
  out = out.replace(/\b(WARN(?:ING)?)\b/g, `${ANSI.yellow}$1${ANSI.reset}`);
  out = out.replace(/\b(INFO|NOTICE)\b/g, `${ANSI.green}$1${ANSI.reset}`);
  out = out.replace(/\b(DEBUG|TRACE)\b/g, `${ANSI.cyan}$1${ANSI.reset}`);
  if (stream === 'stderr' && out === line) out = `${ANSI.red}${line}${ANSI.reset}`;
  return out;
}
