"use client";

import { useState, useEffect, useCallback, useMemo, memo } from "react";
import type { Row } from "@tanstack/react-table";
import { useRouter, useSearchParams } from "next/navigation";
import { useSelection } from "@/components/trace-detail";
import {
  toggleBookmark,
  bulkDeleteTraces,
  exportTraces,
  type TraceSummary,
} from "@/lib/traces-api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Columns3,
  Pin,
  RefreshCw,
  RotateCcw,
  Search,
  Star,
  Waypoints,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnSizingState,
  type RowSelectionState,
} from "@tanstack/react-table";
import { useTableSelectionManager, DataTablePagination, ColumnResizeHandle, getPinnedColumnStyle, getPinnedColumnAttrs } from "@/components/table";
import { TableToolbar, TableActionDialog } from "@/components/table";
import type { TableAction } from "@/components/table";
import { usePersistentTablePreferences } from "@/hooks/use-persistent-table-preferences";
import { cn } from "@/lib/utils";
import { useIsDemo } from "@/lib/project-router";
import { COLUMN_LABELS, COLUMN_SORT_MAP, SortableHeader, createTraceColumns } from "./columns";
import { bulkActions } from "./bulk-actions";

interface PaginationData {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface TracesTablePanelProps {
  projectId: string;
  traces: TraceSummary[];
  error?: string | null;
  pagination?: PaginationData;
}

const autoRefreshOptions = [
  { label: "Off", value: 0 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
];

const DEFAULT_HIDDEN: Record<string, boolean> = {
  environment: false,
  primary_model: false,
};

const TABLE_PREFERENCES_STORAGE_KEY = "trace-table-preferences";

const DEFAULT_COLUMN_PINNING = {
  left: ["select", "bookmark", "status", "name"],
};

const TraceTableRow = memo(function TraceTableRow({
  row,
  isSelected,
  onSelect,
}: {
  row: Row<TraceSummary>;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <TableRow
      key={row.id}
      className={cn(
        "group cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/30",
        isSelected && "bg-muted/40",
      )}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('[role="checkbox"]') && !(e.target as HTMLElement).closest("a")) {
          onSelect(row.original.id);
        }
      }}
      data-state={isSelected ? "selected" : undefined}
    >
      {row.getVisibleCells().map((cell) => {
        const col = cell.column;
        return (
          <TableCell
            key={cell.id}
            className="whitespace-nowrap"
            style={getPinnedColumnStyle(col)}
            {...getPinnedColumnAttrs(col)}
          >
            {flexRender(col.columnDef.cell, cell.getContext())}
          </TableCell>
        );
      })}
    </TableRow>
  );
});

function TracesToolbar({
  table,
  searchQuery,
  onSearchQueryChange,
  onSearch,
  onRefresh,
  isRefreshing,
  autoRefreshInterval,
  onAutoRefreshChange,
  isBookmarked,
  onToggleBookmarked,
  onResetPreferences,
}: {
  table: ReturnType<typeof useReactTable<TraceSummary>>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  autoRefreshInterval: number;
  onAutoRefreshChange: (value: number) => void;
  isBookmarked: boolean;
  onToggleBookmarked: () => void;
  onResetPreferences: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border bg-background px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Waypoints className="h-4 w-4 text-primary" />
            <h1 className="text-sm font-semibold">Traces</h1>
          </div>
          <Button
            type="button"
            variant={isBookmarked ? "secondary" : "ghost"}
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={onToggleBookmarked}
          >
            <Star className="h-3 w-3" />
            Starred
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSearch()}
              placeholder="Search traces..."
              className="h-7 w-48 border-border pl-7 text-xs"
            />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing} className="h-7 w-7 p-0">
            <RefreshCw className={cn("h-3 w-3", isRefreshing && "animate-spin")} />
          </Button>
          <Select value={String(autoRefreshInterval)} onValueChange={(v) => onAutoRefreshChange(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-[60px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {autoRefreshOptions.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0">
                <Columns3 className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 max-h-64 overflow-y-auto">
              {table.getAllLeafColumns().map((column) => {
                const label = COLUMN_LABELS[column.id] || column.id;
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
                            const label = COLUMN_LABELS[column.id] || column.id;
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
                onClick={onResetPreferences}
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
  );
}

function TracesTableContent({
  table,
  rowSelection,
  selectedCount,
  actions,
  onSelectRun,
  onClearSelection,
  onActionSelect,
  onSortChange,
  onPaginationChange,
}: {
  table: ReturnType<typeof useReactTable<TraceSummary>>;
  rowSelection: RowSelectionState;
  selectedCount: number;
  actions: TableAction[];
  onSelectRun: (id: string) => void;
  onClearSelection: () => void;
  onActionSelect: (action: TableAction) => void;
  onSortChange: (columnId: string, desc: boolean | null) => void;
  onPaginationChange: (pageIndex: number, pageSize: number) => void;
}) {
  return (
    <>
      {selectedCount > 0 && (
        <TableToolbar
          selectedCount={selectedCount}
          itemName="trace"
          actions={actions}
          onClearSelection={onClearSelection}
          onActionSelect={onActionSelect}
        >
          <div className="flex items-center gap-4">
            <div>
              <p className="text-sm text-muted-foreground">
                {selectedCount} selected
              </p>
            </div>
          </div>
        </TableToolbar>
      )}

      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="border-border hover:bg-transparent">
                {hg.headers.map((header) => {
                  const col = header.column;
                  const isSortable = col.columnDef.enableSorting;
                  const label = COLUMN_LABELS[col.id] || (typeof col.columnDef.header === "string" ? col.columnDef.header : col.id);
                  return (
                    <TableHead
                      key={header.id}
                      className="whitespace-nowrap border-b text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                      style={{ width: header.getSize(), ...getPinnedColumnStyle(col) }}
                      {...getPinnedColumnAttrs(col)}
                    >
                      {header.isPlaceholder
                        ? null
                        : isSortable
                          ? <SortableHeader
                              column={col}
                              label={label}
                              onSort={() => {
                                const sorted = col.getIsSorted();
                                if (sorted === "desc") onSortChange(col.id, false);
                                else if (sorted === "asc") onSortChange(col.id, null);
                                else onSortChange(col.id, true);
                              }}
                            />
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
              <TraceTableRow
                key={row.id}
                row={row}
                isSelected={rowSelection[row.id] === true}
                onSelect={onSelectRun}
              />
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
          onChange={onPaginationChange}
        />
      </div>
    </>
  );
}

export function TracesTablePanel({ projectId, traces, error, pagination }: TracesTablePanelProps) {
  const isDemo = useIsDemo();
  const { selectRun } = useSelection();
  const handleSelectRun = useCallback((id: string) => selectRun(id), [selectRun]);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedAction, setSelectedAction] = useState<TableAction | null>(null);
  const [isActionDialogOpen, setIsActionDialogOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState("");
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

  const handleResetAll = useCallback(() => {
    resetPreferences();
  }, [resetPreferences]);

  const [urlSortBy, urlSortOrder] = typeof window !== "undefined"
    ? [new URLSearchParams(searchParams.toString()).get("sort_by"), new URLSearchParams(searchParams.toString()).get("sort_order")]
    : [null, null];

  const sortingState = urlSortBy
    ? [{ id: Object.entries(COLUMN_SORT_MAP).find(([, v]) => v === urlSortBy)?.[0] ?? urlSortBy, desc: urlSortOrder !== "asc" }]
    : [];

  const currentPage = pagination?.page ?? 0;
  const pageSize = pagination?.pageSize ?? 40;
  const totalPages = pagination?.totalPages ?? 1;

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    router.refresh();
    setTimeout(() => setIsRefreshing(false), 500);
  }, [router]);

  useEffect(() => {
    if (autoRefreshInterval === 0) return;
    const id = setInterval(() => router.refresh(), autoRefreshInterval);
    return () => clearInterval(id);
  }, [autoRefreshInterval, router]);

  const updateQueryParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value == null) params.delete(key);
      else params.set(key, value);
    }
    router.push(`?${params.toString()}`);
  }, [router, searchParams]);

  const handlePaginationChange = (newPageIndex: number, newPageSize: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(newPageIndex));
    params.set("page_size", String(newPageSize));
    if (searchQuery) params.set("search", searchQuery);
    router.push(`?${params.toString()}`);
  };

  const handleSearch = () => {
    const params = new URLSearchParams(searchParams.toString());
    if (searchQuery) params.set("search", searchQuery);
    else params.delete("search");
    params.set("page", "0");
    router.push(`?${params.toString()}`);
  };

  const handleSortChange = useCallback((columnId: string, desc: boolean | null) => {
    if (desc == null) {
      updateQueryParams({ sort_by: null, sort_order: null });
    } else {
      const backendField = COLUMN_SORT_MAP[columnId] || columnId;
      updateQueryParams({ sort_by: backendField, sort_order: desc ? "desc" : "asc" });
    }
  }, [updateQueryParams]);

  const { selectActionColumn } = useTableSelectionManager<TraceSummary>({
    projectId: "default",
    tableName: "traces",
    setSelectedRows: setRowSelection,
    disabled: isDemo,
  });

  const handleActionSelect = (action: TableAction) => {
    setSelectedAction(action);
    setIsActionDialogOpen(true);
  };

  const handleActionConfirm = async () => {
    if (!selectedAction) return;
    const selectedIds = Object.keys(rowSelection);
    try {
      if (selectedAction.id === "delete") {
        await bulkDeleteTraces(selectedIds);
        window.location.reload();
      } else if (selectedAction.id === "export") {
        const result = await exportTraces(selectedIds);
        const blob = new Blob([result.data], { type: result.media_type });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
      setRowSelection({});
    } catch (error) {
      console.error("Action failed:", error);
      throw error;
    }
  };

  const handleToggleBookmark = useCallback(async (runId: string) => {
    try {
      await toggleBookmark(runId);
      router.refresh();
    } catch (err) {
      console.error("Failed to toggle bookmark:", err);
    }
  }, [router]);

  const columns = useMemo(
    () => createTraceColumns(selectActionColumn, handleToggleBookmark, projectId, isDemo),
    [selectActionColumn, handleToggleBookmark, projectId, isDemo],
  );

  const actions = useMemo(() => {
    if (isDemo) return [];
    return bulkActions;
  }, [isDemo]);

  const table = useReactTable({
    data: traces,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    state: {
      rowSelection,
      columnVisibility: preferences.columnVisibility ?? {},
      columnSizing: (preferences.columnSizing ?? {}) as ColumnSizingState,
      columnPinning: preferences.columnPinning ?? {},
      sorting: sortingState,
      pagination: { pageIndex: currentPage, pageSize },
    },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onColumnPinningChange: setColumnPinning,
    columnResizeMode: "onChange",
    enableColumnPinning: true,
    pageCount: totalPages,
    manualPagination: true,
    manualSorting: true,
  });

  const selectedCount = Object.keys(rowSelection).length;

  return (
    <div className="flex h-full w-full flex-col">
      <TracesToolbar
        table={table}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSearch={handleSearch}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
        autoRefreshInterval={autoRefreshInterval}
        onAutoRefreshChange={setAutoRefreshInterval}
        isBookmarked={typeof window !== "undefined" && new URLSearchParams(searchParams.toString()).get("bookmarked") === "true"}
        onToggleBookmarked={() => {
          const params = new URLSearchParams(searchParams.toString());
          if (params.get("bookmarked") === "true") {
            params.delete("bookmarked");
          } else {
            params.set("bookmarked", "true");
          }
          params.set("page", "0");
          router.push(`?${params.toString()}`);
        }}
        onResetPreferences={handleResetAll}
      />

      {error ? (
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTitle>Error loading traces</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : traces.length === 0 ? (
        <div className="p-6">
          <Card className="border-dashed border-border/60 bg-card/60">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No traces found.
            </CardContent>
          </Card>
        </div>
      ) : (
        <TracesTableContent
          table={table}
          rowSelection={rowSelection}
          selectedCount={selectedCount}
          actions={actions}
          onSelectRun={handleSelectRun}
          onClearSelection={() => setRowSelection({})}
          onActionSelect={handleActionSelect}
          onSortChange={handleSortChange}
          onPaginationChange={handlePaginationChange}
        />
      )}

      {selectedAction && (
        <TableActionDialog
          isOpen={isActionDialogOpen}
          onClose={() => {
            setIsActionDialogOpen(false);
            setSelectedAction(null);
          }}
          action={selectedAction}
          selectedIds={Object.keys(rowSelection)}
          itemName="trace"
          onConfirm={handleActionConfirm}
        />
      )}
    </div>
  );
}
