"use client";

import { useState, useRef, useEffect } from "react";
import { type Table } from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  isLoading?: boolean;
  paginationOptions?: number[];
  hideTotalCount?: boolean;
  canJumpPages?: boolean;
  onChange?: (pageIndex: number, pageSize: number) => void;
}

export function DataTablePagination<TData>({
  table,
  isLoading = false,
  paginationOptions = [10, 20, 30, 40, 50],
  hideTotalCount = false,
  canJumpPages = true,
  onChange,
}: DataTablePaginationProps<TData>) {
  const currentPage = table.getState().pagination.pageIndex + 1;
  const [inputState, setInputState] = useState<number | string>(currentPage);
  const prevCurrentPageRef = useRef(currentPage);
  if (currentPage !== prevCurrentPageRef.current) {
    // Sanctioned "adjust state during render" pattern (react.dev/reference/react/useState).
    // The ref write is coupled to a same-component setInputState; cannot move to an effect.
    // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
    prevCurrentPageRef.current = currentPage;
    setInputState(currentPage);
  }

  const pageCount = table.getPageCount();

  // Clamp the page index when the data shrinks so the current page no longer
  // exists. Done in an effect (not during render) because setPageIndex updates
  // the parent table's state — calling another component's setState during
  // render is unsafe (React can replay or discard the render).
  useEffect(() => {
    const { pageIndex } = table.getState().pagination;
    if (pageCount > 0 && pageIndex >= pageCount) {
      table.setPageIndex(0);
    }
  }, [table, pageCount]);

  const handlePageNavigation = (newValue: string) => {
    if (newValue === "") {
      table.setPageIndex(0);
      setInputState(1);
      onChange?.(0, table.getState().pagination.pageSize);
      return;
    }

    // if nan, reset to current page
    if (isNaN(Number(newValue))) {
      setInputState(currentPage);
      return;
    }

    const newPageIndex = Number(newValue) - 1;
    if (newPageIndex < 0 || newPageIndex >= pageCount) {
      setInputState(currentPage);
      return;
    }

    table.setPageIndex(newPageIndex);
    setInputState(newPageIndex + 1);
    onChange?.(newPageIndex, table.getState().pagination.pageSize);
  };

  const handlePageSizeChange = (newPageSize: number) => {
    table.setPageSize(newPageSize);
    onChange?.(table.getState().pagination.pageIndex, newPageSize);
  };

  const handlePageIndexChange = (newPageIndex: number) => {
    table.setPageIndex(newPageIndex);
    onChange?.(newPageIndex, table.getState().pagination.pageSize);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-2 min-w-max">
      <div className="flex-1 text-sm text-muted-foreground">
        {table.getFilteredSelectedRowModel().rows.length > 0 && (
          <span>
            {table.getFilteredSelectedRowModel().rows.length} of{" "}
            {table.getFilteredRowModel().rows.length} row(s) selected.
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:gap-6">
        <div className="flex items-center gap-2">
          <p className="whitespace-nowrap text-sm font-medium md:hidden">
            Rows
          </p>
          <p className="hidden whitespace-nowrap text-sm font-medium md:block">
            Rows per page
          </p>
          <Select
            value={`${table.getState().pagination.pageSize}`}
            onValueChange={(value) => {
              handlePageSizeChange(Number(value));
            }}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue placeholder={table.getState().pagination.pageSize} />
            </SelectTrigger>
            <SelectContent side="top">
              {paginationOptions.map((pageSize) => (
                <SelectItem key={pageSize} value={`${pageSize}`}>
                  {pageSize}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-center gap-1 whitespace-nowrap text-sm font-medium">
          {table.getPageCount() !== -1 ? (
            <>
              Page
              {canJumpPages && (
                <Input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={inputState}
                  onChange={(e) => {
                    setInputState(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handlePageNavigation(e.currentTarget.value);
                    }
                  }}
                  onBlur={(e) => {
                    handlePageNavigation(e.target.value);
                  }}
                  className="h-8 w-16 appearance-none"
                />
              )}
              {!canJumpPages && <span>{currentPage}</span>}
            </>
          ) : (
            `Page ${currentPage}`
          )}
          {!hideTotalCount && (
            <>
              {pageCount !== -1 ? (
                <span>of {pageCount}</span>
              ) : (
                <span>of {isLoading ? "..." : 1}</span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          {canJumpPages && (
            <Button type="button"
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex"
              onClick={() => {
                handlePageIndexChange(0);
              }}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to first page</span>
              <ChevronsLeft className="h-4 w-4" />
            </Button>
          )}
          <Button type="button"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => {
              handlePageIndexChange(table.getState().pagination.pageIndex - 1);
            }}
            disabled={!table.getCanPreviousPage()}
          >
            <span className="sr-only">Go to previous page</span>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button type="button"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => {
              handlePageIndexChange(table.getState().pagination.pageIndex + 1);
            }}
            disabled={!table.getCanNextPage() || pageCount === -1}
          >
            <span className="sr-only">Go to next page</span>
            <ChevronRight className="h-4 w-4" />
          </Button>
          {canJumpPages && (
            <Button type="button"
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex"
              onClick={() => {
                handlePageIndexChange(pageCount - 1);
              }}
              disabled={!table.getCanNextPage() || pageCount === -1}
            >
              <span className="sr-only">Go to last page</span>
              <ChevronsRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
