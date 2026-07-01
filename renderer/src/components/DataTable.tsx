import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { sizeToBytes } from '../utils/format';

export type SortType = 'text' | 'size' | 'date' | 'num' | null;
export interface Column<T> {
  title: string;
  type?: SortType;
  className?: string;
  value?: (row: T) => string | number;
  render: (row: T) => ComponentChildren;
}

function sortValue<T>(row: T, col: Column<T>): string | number {
  if (col.value) return col.value(row);
  return '';
}

function coerce(v: string | number, type?: SortType): string | number {
  if (typeof v === 'number') return v;
  if (type === 'size') return sizeToBytes(v);
  if (type === 'date') return Date.parse(v) || 0;
  if (type === 'num') return parseFloat(v) || 0;
  return v.toLowerCase();
}

export function DataTable<T>({
  id,
  rows,
  columns,
  empty,
  filter,
  rowKey,
}: {
  id: string;
  rows: T[];
  columns: Column<T>[];
  empty: string;
  filter: string;
  rowKey: (row: T) => string;
}) {
  const [sort, setSort] = useState<{ idx: number; dir: 'asc' | 'desc' } | null>(null);
  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    const base = q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : rows;
    if (!sort || !columns[sort.idx]?.type) return base;
    const col = columns[sort.idx];
    return [...base].sort((a, b) => {
      const av = coerce(sortValue(a, col), col.type);
      const bv = coerce(sortValue(b, col), col.type);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort.dir === 'desc' ? -cmp : cmp;
    });
  }, [rows, filter, sort, columns]);

  if (!filtered.length) return <div class="empty">{empty}</div>;

  return (
    <div class="table-wrap">
      <table class="grid" id={id}>
        <thead>
          <tr>
            {columns.map((col, idx) => (
              <th
                key={col.title || idx}
                class={`${col.type ? 'sortable' : ''}${sort?.idx === idx ? ` sort-${sort.dir}` : ''}`}
                onClick={() => {
                  if (!col.type) return;
                  setSort((cur) => ({ idx, dir: cur?.idx === idx && cur.dir === 'asc' ? 'desc' : 'asc' }));
                }}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col, idx) => <td key={idx} class={col.className}>{col.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
