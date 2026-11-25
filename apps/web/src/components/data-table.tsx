'use client';

import type { ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface ServerTableProps<T> {
  /** Column ids of sortable columns are the server's `sort` keys. */
  columns: ColumnDef<T>[];
  data: T[] | undefined;
  isLoading: boolean;
  isFetching?: boolean;
  error: unknown;
  onRetry?: () => void;
  page: number;
  pageSize: number;
  total: number | undefined;
  totalPages: number | undefined;
  sort: string;
  order: 'asc' | 'desc';
  onSortChange: (sort: string, order: 'asc' | 'desc') => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Shown when the query succeeded with no rows. */
  empty: { title: string; description?: string; action?: ReactNode };
  /** Accessible table name. */
  label: string;
  rowKey: (row: T) => string;
}

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * A TanStack Table whose paging and sorting are done by the server: the table only renders the
 * current page and reports what the user asked for.
 */
export function ServerTable<T>(props: ServerTableProps<T>) {
  const { columns, data, page, pageSize, sort, order } = props;
  const sorting: SortingState = [{ id: sort, desc: order === 'desc' }];

  const table = useReactTable({
    data: data ?? [],
    columns,
    state: { sorting, pagination: { pageIndex: page - 1, pageSize } },
    manualPagination: true,
    manualSorting: true,
    enableSortingRemoval: false,
    pageCount: props.totalPages ?? -1,
    getCoreRowModel: getCoreRowModel(),
    getRowId: props.rowKey,
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      const first = next[0];
      if (first) props.onSortChange(first.id, first.desc ? 'desc' : 'asc');
    },
  });

  const total = props.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col" aria-busy={props.isLoading || props.isFetching}>
      <Table aria-label={props.label}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => {
                const sortable = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    scope="col"
                    aria-sort={
                      dir === 'asc'
                        ? 'ascending'
                        : dir === 'desc'
                          ? 'descending'
                          : sortable
                            ? 'none'
                            : undefined
                    }
                  >
                    {header.isPlaceholder ? null : sortable ? (
                      <button
                        type="button"
                        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {dir === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        ) : dir === 'desc' ? (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {props.isLoading &&
            Array.from({ length: Math.min(pageSize, 8) }, (_, i) => (
              <TableRow key={`s${i}`} className="hover:bg-transparent">
                {columns.map((_c, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-full max-w-32" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {!props.isLoading &&
            !props.error &&
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className={props.isFetching ? 'opacity-60' : undefined}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
        </TableBody>
      </Table>

      {props.error ? (
        <ErrorState error={props.error} onRetry={props.onRetry} />
      ) : !props.isLoading && (data?.length ?? 0) === 0 ? (
        <EmptyState {...props.empty} />
      ) : null}

      {!props.error && (props.isLoading || total > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-3 text-sm">
          <p className="text-muted-foreground" aria-live="polite">
            {props.isLoading
              ? 'Loading…'
              : `${from.toLocaleString('en')}–${to.toLocaleString('en')} of ${total.toLocaleString('en')}`}
          </p>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-muted-foreground">
              Rows
              <Select
                className="h-8 w-[4.5rem]"
                value={pageSize}
                onChange={(e) => props.onPageSizeChange(Number(e.target.value))}
                aria-label="Rows per page"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            <nav className="flex items-center gap-1" aria-label="Pagination">
              <Button
                variant="outline"
                size="sm"
                onClick={() => props.onPageChange(page - 1)}
                disabled={page <= 1 || props.isLoading}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <span className="min-w-20 text-center tabular-nums">
                Page {page} of {props.totalPages ?? 1}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => props.onPageChange(page + 1)}
                disabled={page >= (props.totalPages ?? 1) || props.isLoading}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}
