"use client"

import * as React from "react"
import { Group, Panel, Separator, type Layout } from "react-resizable-panels"

import { cn } from "@/lib/utils"

interface UseDefaultLayoutOptions {
  id: string;
  storage?: Storage;
  defaultLayout?: Layout;
}

interface UseDefaultLayoutReturn {
  defaultLayout: Layout;
  onLayoutChange: (layout: Layout) => void;
}

function useDefaultLayout(options: UseDefaultLayoutOptions): UseDefaultLayoutReturn {
  const { id, storage, defaultLayout: initialLayout = {} } = options;
  
  const [layout, setLayout] = React.useState<Layout>(() => {
    if (storage) {
      const stored = storage.getItem(`panel-layout:${id}`);
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch {
          return initialLayout;
        }
      }
    }
    return initialLayout;
  });
  
  const onLayoutChange = React.useCallback((newLayout: Layout) => {
    setLayout(newLayout);
    if (storage) {
      storage.setItem(`panel-layout:${id}`, JSON.stringify(newLayout));
    }
  }, [id, storage]);
  
  return { defaultLayout: layout, onLayoutChange };
}

interface ResizablePanelGroupProps extends React.ComponentProps<typeof Group> {
  direction?: "horizontal" | "vertical";
}

function ResizablePanelGroup({
  className,
  direction,
  ...props
}: ResizablePanelGroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={direction}
      className={cn(
        "flex h-full w-full",
        direction === "vertical" && "!flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean
}) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "bg-border hover:bg-foreground/20 focus-visible:ring-ring relative flex items-center justify-center focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden transition-colors duration-200",
        "w-px h-full after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
        "[&[data-panel-group-direction=vertical]]:h-px [&[data-panel-group-direction=vertical]]:w-full [&[data-panel-group-direction=vertical]]:after:left-0 [&[data-panel-group-direction=vertical]]:after:h-1 [&[data-panel-group-direction=vertical]]:after:w-full [&[data-panel-group-direction=vertical]]:after:translate-x-0 [&[data-panel-group-direction=vertical]]:after:-translate-y-1/2",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="bg-foreground/20 hover:bg-foreground/40 h-6 w-1 rounded-none z-10 flex shrink-0 transition-colors duration-200" />
      )}
    </Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle, useDefaultLayout }
