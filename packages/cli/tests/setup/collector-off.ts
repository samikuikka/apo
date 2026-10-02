/**
 * Suite-wide hermetic defaults.
 *
 * The local span-durability collector auto-starts for non-loopback backends;
 * several tests use fake remote hostnames (http://backend.test) and would
 * otherwise attempt a real 95 MB otelcol download into the developer's
 * ~/.apo. Off by default for the whole suite — tests that exercise collector
 * logic (tests/collector.test.ts) manage APO_COLLECTOR per-case.
 */
if (process.env.APO_COLLECTOR === undefined) {
  process.env.APO_COLLECTOR = "0";
}
