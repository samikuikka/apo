export function getMinTraceCountFromSearchParams(
  searchParams: URLSearchParams,
): number | undefined {
  const value =
    searchParams.get("min_trace_count") || searchParams.get("min_run_count");
  return value ? Number(value) : undefined;
}

export function getMaxTraceCountFromSearchParams(
  searchParams: URLSearchParams,
): number | undefined {
  const value =
    searchParams.get("max_trace_count") || searchParams.get("max_run_count");
  return value ? Number(value) : undefined;
}
