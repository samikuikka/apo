"use client"

import * as React from "react"

import { cn } from '@/lib/utils'

export type TableDensity = "compact" | "comfortable";

const TableDensityContext = React.createContext<TableDensity>("comfortable");

export function useTableDensity(): TableDensity {
  // React.use (not useContext) — the React 19 context read, same as sidebar.tsx.
  return React.use(TableDensityContext);
}

const DENSITY_HEAD_CLASS: Record<TableDensity, string> = {
  compact: "h-7 px-2",
  comfortable: "h-10 px-3",
};

const DENSITY_CELL_CLASS: Record<TableDensity, string> = {
  compact: "px-2 py-1",
  comfortable: "px-3 py-2.5",
};

interface TableProps extends React.ComponentProps<"table"> {
  density?: TableDensity;
}

function Table({ className, density = "comfortable", ...props }: TableProps) {
  return (
    <TableDensityContext.Provider value={density}>
      <div data-slot="table-container" data-density={density} className="relative w-full overflow-x-auto">
        <table
          data-slot="table"
          className={cn("w-full table-fixed caption-bottom text-xs", className)}
          {...props}
        />
      </div>
    </TableDensityContext.Provider>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("bg-white/5 border-t border-gray-800 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("hover:bg-accent/70 data-[state=selected]:bg-accent border-b border-gray-800 transition-colors duration-200", className)}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  const density = useTableDensity();
  return (
    <th
      data-slot="table-head"
      className={cn(
        "relative overflow-hidden text-white text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        DENSITY_HEAD_CLASS[density],
        "data-[pinned=left]:bg-background data-[pinned=right]:bg-background",
        "data-[pinned-edge=last-left]:shadow-[3px_0_5px_-2px_rgba(0,0,0,0.15)]",
        "data-[pinned-edge=first-right]:shadow-[-3px_0_5px_-2px_rgba(0,0,0,0.15)]",
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  const density = useTableDensity();
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "overflow-hidden align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        DENSITY_CELL_CLASS[density],
        "data-[pinned=left]:bg-background data-[pinned=right]:bg-background",
        // Opaque hover/selected shades matching the row ladder (bg-accent/70,
        // bg-accent) — translucent ones here would let horizontally scrolled
        // cells bleed through the sticky pinned cells.
        "group-hover:data-[pinned=left]:bg-accent-hover group-hover:data-[pinned=right]:bg-accent-hover",
        "group-data-[state=selected]:data-[pinned=left]:bg-accent group-data-[state=selected]:data-[pinned=right]:bg-accent",
        "data-[pinned-edge=last-left]:shadow-[3px_0_5px_-2px_rgba(0,0,0,0.15)]",
        "data-[pinned-edge=first-right]:shadow-[-3px_0_5px_-2px_rgba(0,0,0,0.15)]",
        className,
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-xs", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
