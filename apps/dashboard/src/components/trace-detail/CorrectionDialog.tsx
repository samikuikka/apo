"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface CorrectionDialogProps {
  original: string;
  currentCorrection: string | null;
  onSave: (text: string | null) => void;
  onClose: () => void;
}

export function CorrectionDialog({
  original,
  currentCorrection,
  onSave,
  onClose,
}: CorrectionDialogProps) {
  const [text, setText] = useState(currentCorrection ?? "");
  const [warning, setWarning] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleSave() {
    if (!text.trim()) {
      setWarning("Correction cannot be empty");
      return;
    }
    if (text.trim() === original.trim()) {
      setWarning("Correction is identical to original");
      return;
    }
    onSave(text);
  }

  function handleClear() {
    onSave(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-2xl border border-border bg-background shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Correct Output</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div>
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
              Original
            </span>
            <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words border border-border/60 bg-muted/10 px-3 py-2 text-xs font-mono text-foreground">
              {original}
            </pre>
          </div>

          <div>
            <label
              htmlFor="correction-input"
              className="mb-1 block text-[11px] font-medium text-muted-foreground"
            >
              Correction
            </label>
            <textarea
              id="correction-input"
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setWarning(null);
              }}
              className="min-h-[120px] w-full resize-y border border-border/60 bg-muted/10 px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Enter the corrected output..."
            />
          </div>

          {warning && (
            <p className="text-[11px] text-warning">
              {warning}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          {currentCorrection ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClear}
              className="text-destructive hover:text-destructive"
            >
              Remove correction
            </Button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
