export const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  dim: '\x1b[90m',
  boldRed: '\x1b[1;31m',
};

export function colorizeLine(line: string, stream?: string): string {
  if (line.includes('\x1b')) return line;
  const jsonLevel = line.match(/"level":\s*"(\w+)"/);
  if (jsonLevel) {
    const lvl = jsonLevel[1].toLowerCase();
    if (lvl === 'error' || lvl === 'fatal' || lvl === 'panic') return `${ANSI.boldRed}${line}${ANSI.reset}`;
    if (lvl === 'warn' || lvl === 'warning') return `${ANSI.yellow}${line}${ANSI.reset}`;
    if (lvl === 'debug' || lvl === 'trace') return `${ANSI.dim}${line}${ANSI.reset}`;
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
