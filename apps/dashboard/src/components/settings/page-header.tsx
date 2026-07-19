import { cn } from "@/lib/utils";

export function SettingsPageHeader({
  title,
  description,
  icon: Icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b border-border bg-background px-6 py-5", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {Icon && <Icon className="size-4 text-muted-foreground" />}
            <h1 className="text-[18px] font-semibold tracking-tight">{title}</h1>
          </div>
          {description && (
            <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
