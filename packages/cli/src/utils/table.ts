export const RESET = '\x1b[0m';
export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const GRAY = '\x1b[90m';
export const BOLD = '\x1b[1m';

export interface Column {
  key: string;
  label: string;
  width: number;
  align?: 'left' | 'right';
  format?: (val: string) => string;
}

function pad(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  // Strip ANSI codes for length calculation
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = width - plain.length;
  if (diff <= 0) return text;
  const padding = ' '.repeat(diff);
  return align === 'right' ? padding + text : text + padding;
}

export function renderTable(columns: Column[], rows: Record<string, string>[]): string {
  const lines: string[] = [];

  // Header
  const header = columns
    .map((col) => pad(col.label, col.width, col.align))
    .join('');
  lines.push(`  ${BOLD}${GRAY}${header}${RESET}`);

  // Rows
  for (const row of rows) {
    const cells = columns.map((col) => {
      const raw = row[col.key] ?? '';
      const formatted = col.format ? col.format(raw) : raw;
      return pad(formatted, col.width, col.align);
    });
    lines.push(`  ${cells.join('')}`);
  }

  return lines.join('\n');
}
