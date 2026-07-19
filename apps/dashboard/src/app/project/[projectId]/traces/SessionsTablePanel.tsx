"use client";

import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Columns3,
  GitBranch,
  Pin,
  RotateCcw,
} from "lucide-react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnSizingState,
} from "@tanstack/react-table";
import { DataTablePagination, ColumnResizeHandle, getPinnedColumnStyle, getPinnedColumnAttrs } from "@/components/table";
import { usePersistentTablePreferences } from "@/hooks/use-persistent-table-preferences";
import { usdFormat, tokenFormat } from "@/lib/format";
import type { TraceSessionSummary } from "@/lib/traces-api";

interface PaginationData {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface SessionsTablePanelProps {
  sessions: TraceSessionSummary[];
  pagination?: PaginationData;
  onSelectSession: (sessionId: string) => void;
}

const COLUMN_LABELS: Record<string, string> = {
  id: "Session",
  traceCount: "Traces",
  totalTokens: "Tokens",
  totalCost: "Cost",
  firstTraceAt: "Started",
  lastTraceAt: "Last Activity",
};

const DEFAULT_HIDDEN: Record<string, boolean> = {
  firstTraceAt: false,
};

const TABLE_PREFERENCES_STORAGE_KEY = "session-table-preferences";

const DEFAULT_COLUMN_PINNING = {
  left: ["id"],
};

function createSessionColumns(): ColumnDef<TraceSessionSummary>[] {
  return [
    {
      accessorKey: "id",
      header: "Session",
      size: 200,
      minSize: 100,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-primary">
          {row.original.id}
        </span>
      ),
    },
    {
      accessorKey: "traceCount",
      header: "Traces",
      size: 80,
      minSize: 50,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs tabular-nums text-foreground">
          {row.original.traceCount}
        </span>
      ),
    },
    {
      accessorKey: "totalTokens",
      header: "Tokens",
      size: 120,
      minSize: 60,
      enableSorting: false,
      cell: ({ row }) => {
        const tokens = row.original.totalTokens;
        if (!tokens) return <span className="text-muted-foreground/50">—</span>;
        return (
          <span className="text-nowrap font-mono text-xs tabular-nums text-foreground">
            {tokenFormat(tokens)}
          </span>
        );
      },
    },
    {
      accessorKey: "totalCost",
      header: "Cost",
      size: 100,
      minSize: 60,
      enableSorting: false,
      cell: ({ row }) => {
        const cost = row.original.totalCost;
        if (!cost || cost <= 0) return <span className="text-muted-foreground/50">—</span>;
        return (
          <span className="font-mono text-xs tabular-nums text-foreground">
            {usdFormat(cost)}
          </span>
        );
      },
    },
    {
      accessorKey: "lastTraceAt",
      header: "Last Activity",
      size: 140,
      minSize: 80,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground tabular-nums">
          {row.original.lastTraceAt
            ? new Date(row.original.lastTraceAt).toLocaleDateString("en-US", {
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "—"}
        </span>
      ),
    },
    {
      accessorKey: "firstTraceAt",
      header: "Started",
      size: 140,
      minSize: 80,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground tabular-nums">
          {row.original.firstTraceAt
            ? new Date(row.original.firstTraceAt).toLocaleDateString("en-US", {
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "—"}
        </span>
      ),
    },
  ];
}

export function SessionsTablePanel({
  sessions,
  pagination,
  onSelectSession,
}: SessionsTablePanelProps) {
  const router = useRouter();

  const {
    preferences,
    setColumnVisibility,
    setColumnSizing,
    setColumnPinning,
    resetPreferences,
  } = usePersistentTablePreferences({
    storageKey: TABLE_PREFERENCES_STORAGE_KEY,
    defaults: {
      columnVisibility: { ...DEFAULT_HIDDEN },
      columnPinning: DEFAULT_COLUMN_PINNING,
    },
  });

  const currentPage = pagination?.page ?? 0;
  const pageSize = pagination?.pageSize ?? 20;
  const totalPages = pagination?.totalPages ?? 1;

  const handlePaginationChange = (newPageIndex: number, newPageSize: number) => {
    const params = new URLSearchParams(window.location.search);
    params.set("page", String(newPageIndex));
    params.set("page_size", String(newPageSize));
    router.push(`?${params.toString()}`);
  };

  const columns = createSessionColumns();

  const table = useReactTable({
    data: sessions,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    state: {
      columnVisibility: preferences.columnVisibility ?? {},
      columnSizing: (preferences.columnSizing ?? {}) as ColumnSizingState,
      columnPinning: preferences.columnPinning ?? {},
      pagination: { pageIndex: currentPage, pageSize },
    },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onColumnPinningChange: setColumnPinning,
    columnResizeMode: "onChange",
    enableColumnPinning: true,
    pageCount: totalPages,
    manualPagination: true,
  });

  const totalCount = pagination?.totalCount ?? sessions.length;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="shrink-0 border-b border-border bg-background px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-primary" />
              <h1 className="text-sm font-semibold">Sessions</h1>
            </div>
            <span className="text-xs text-muted-foreground">
              {totalCount} {totalCount === 1 ? "session" : "sessions"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0">
                  <Columns3 className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 max-h-64 overflow-y-auto">
                {table.getAllLeafColumns().map((column) => {
                  const label = COLUMN_LABELS[column.id] ?? column.id;
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      onCheckedChange={(checked) => column.toggleVisibility(!!checked)}
                      className="text-xs"
                    >
                      {label}
                    </DropdownMenuCheckboxItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="text-xs">
                    <Pin className="mr-2 h-3 w-3" />
                    Pin columns
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                    {table.getAllLeafColumns().flatMap((column) =>
                      column.getCanPin()
                        ? [
                            (() => {
                              const label = COLUMN_LABELS[column.id] ?? column.id;
                              return (
                                <DropdownMenuCheckboxItem
                                  key={column.id}
                                  checked={column.getIsPinned() === "left"}
                                  onCheckedChange={() =>
                                    column.pin(column.getIsPinned() ? false : "left")
                                  }
                                  className="text-xs"
                                >
                                  {label}
                                </DropdownMenuCheckboxItem>
                              );
                            })(),
                          ]
                        : [],
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => resetPreferences()}
                  className="cursor-pointer text-xs text-muted-foreground"
                >
                  <RotateCcw className="mr-2 h-3 w-3" />
                  Reset preferences
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="p-6">
          <Card className="border-dashed border-border/60 bg-card/60">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No sessions found.
            </CardContent>
          </Card>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id} className="border-border hover:bg-transparent">
                    {hg.headers.map((header) => {
                      const col = header.column;
                      return (
                        <TableHead
                          key={header.id}
                          className="h-8 whitespace-nowrap border-b px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                          style={{ width: header.getSize(), ...getPinnedColumnStyle(col) }}
                          {...getPinnedColumnAttrs(col)}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(col.columnDef.header, header.getContext())}
                          {col.getCanResize() && (
                            <ColumnResizeHandle header={header} />
                          )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="group cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/30"
                    onClick={() => onSelectSession(row.original.id)}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const col = cell.column;
                      return (
                        <TableCell
                          key={cell.id}
                          className="whitespace-nowrap px-2 py-1.5"
                          style={getPinnedColumnStyle(col)}
                          {...getPinnedColumnAttrs(col)}
                        >
                          {flexRender(col.columnDef.cell, cell.getContext())}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="shrink-0 border-t border-border bg-background px-4 py-2">
            <DataTablePagination
              table={table}
              isLoading={false}
              paginationOptions={[10, 20, 30, 40, 50]}
              canJumpPages={true}
              onChange={handlePaginationChange}
            />
          </div>
        </>
      )}
    </div>
  );
}
