"use client";

// THROWAWAY demo page for reviewing the provider-grouped model filter menu.
// Not committed — deleted after screenshots. Renders the real ModelFilterMenu
// with a production-like facet list (15 models across 7 providers).

import { useState } from "react";
import { ModelFilterMenu } from "@/components/model-filter-menu";
import { ChevronsUpDown } from "lucide-react";
import type { ModelPickerOption } from "@/lib/model-filter-options";

const demoOptions: ModelPickerOption[] = [
  { model: "anthropic/claude-opus-4.5", count: 89, archived: false },
  { model: "openai/gpt-5.2", count: 64, archived: false },
  { model: "deepseek/deepseek-v4.1-flash", count: 57, archived: false },
  { model: "anthropic/claude-haiku-4.5", count: 41, archived: false },
  { model: "z-ai/glm-5.3", count: 38, archived: false },
  { model: "google/gemini-3.0-pro", count: 31, archived: false },
  { model: "openai/gpt-5.2-mini", count: 28, archived: false },
  { model: "deepseek/deepseek-r2", count: 22, archived: false },
  { model: "anthropic/claude-sonnet-4.5", count: 19, archived: false },
  { model: "moonshot/kimi-k3", count: 12, archived: true },
  { model: "z-ai/glm-5.3-flash", count: 9, archived: false },
  { model: "google/gemini-2.5-flash", count: 7, archived: false },
  { model: "openai/o4-mini", count: 5, archived: false },
  { model: "x-ai/grok-4.2", count: 3, archived: true },
  { model: "gpt-4o", count: 2, archived: false },
];

export default function DemoModelMenuPage() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  return (
    <main className="min-h-screen bg-background p-10">
      <h1 className="text-[18px] font-semibold tracking-tight text-foreground">
        Model filter — provider sections demo
      </h1>
      <p className="mt-2 max-w-xl text-[13px] text-muted-foreground">
        15 models, so the list sections by provider. One archived model
        (moonshot/kimi-k3) is selected — it stays listed so the active filter
        stays visible and clearable.
      </p>
      <div className="mt-6 w-fit">
        <ModelFilterMenu
          trigger={
            <button
              type="button"
              className="flex h-8 items-center gap-2 border border-border bg-card px-3 text-[13px] text-foreground"
            >
              <span className="font-mono text-[12px]">Model</span>
              <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
            </button>
          }
          options={demoOptions}
          selected={new Set(["moonshot/kimi-k3"])}
          multiple
          onToggle={(model) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(model)) next.delete(model);
              else next.add(model);
              return next;
            })
          }
          onClear={() => setSelected(new Set())}
          onSetArchived={(model, archived) => {
            demoOptions.find((o) => o.model === model)!.archived = archived;
          }}
        />
      </div>
    </main>
  );
}
