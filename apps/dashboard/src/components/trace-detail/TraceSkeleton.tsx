export default function TraceSkeleton() {
  return (
    <div className="flex h-full">
      <div className="w-[380px] border-r p-4 space-y-3">
        <div className="h-6 w-32 bg-muted animate-pulse rounded" />
        <div className="h-8 w-full bg-muted animate-pulse rounded" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2" style={{ paddingLeft: `${(i % 3) * 16}px` }}>
            <div className="h-4 w-4 bg-muted animate-pulse rounded" />
            <div className="h-4 bg-muted animate-pulse rounded" style={{ width: `${120 + (i * 37) % 100}px` }} />
          </div>
        ))}
      </div>
      <div className="flex-1 p-4 space-y-3">
        <div className="h-6 w-48 bg-muted animate-pulse rounded" />
        <div className="h-4 w-32 bg-muted animate-pulse rounded" />
        <div className="h-24 w-full bg-muted animate-pulse rounded" />
        <div className="h-32 w-full bg-muted animate-pulse rounded" />
      </div>
    </div>
  );
}
