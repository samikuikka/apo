/**
 * Local span-durability sidecar: an upstream OpenTelemetry Collector
 * (otelcol-contrib, pinned) managed by the CLI.
 *
 * Why: task spans are only durable once the backend accepts them. A run
 * against a remote backend over a flaky network, or while the backend is
 * restarting, loses every span whose export retry window (seconds) expires —
 * silently. The collector sits on loopback, impersonates apo's ingest path
 * (`/api/public/otel/v1/traces`), and forwards through a bounded disk queue
 * that retries forever: the task process only has to reach localhost.
 *
 * Design contract (keep when editing):
 *   - The Authorization header reaches the collector via environment variable
 *     only — never written to the config file, never passed in argv.
 *   - The queue is a buffer, not a log: hard `max_size` cap, entries deleted
 *     on backend ack, drops (when full) counted by the collector's own
 *     `otelcol_exporter_enqueue_failed_spans` metric instead of filling disk.
 *   - Failures never block a run: callers fall back to direct export, which
 *     is exactly the pre-collector behavior.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

/** Pinned upstream release — validated config values below target this. */
export const COLLECTOR_VERSION = "0.160.0";

/** apo's canonical OTLP traces path; the receiver impersonates it. */
export const APO_TRACES_PATH = "/api/public/otel/v1/traces";

// NOT the OTLP-conventional 4318: anything on the machine exporting to the
// standard localhost OTLP port (other collectors' SDKs, replay tooling)
// would be silently captured by apo's collector and forwarded to the user's
// apo project. A dedicated port keeps the sidecar apo-only; every consumer
// is env-driven by the CLI, so nothing needs the conventional port.
//
// Not 14318/13133/18888 either: CLIs before the shared-ownership protocol
// (registered users, last one out stops it, spawn lock) ran their collector
// there, from the collector root itself, and stopped it from the spawning
// command regardless of who else used it. Separate ports and state keep an
// older CLI on the same machine from ever sharing — or stopping — this one.
const DEFAULT_OTLP_PORT = 14319;
const DEFAULT_HEALTH_PORT = 13134;
const DEFAULT_METRICS_PORT = 18889;
const DEFAULT_MAX_QUEUE_BYTES = 512 * 1024 * 1024;
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
// > the batch processor's 1s timeout: a partial batch can sit in the batch
// stage for that long after the last export, invisible to the queue gauge.
const DEFAULT_SETTLE_MS = 2_500;
const DEFAULT_EMPTY_WINDOW_MS = 1_000;
const STOP_TIMEOUT_MS = 10_000;
// How often a live handle checks that the collector still answers, and
// restarts it when not (another command's stop, a crash).
const DEFAULT_WATCHDOG_MS = 5_000;
// A spawned child that is still alive this long after the health check
// passed is the one serving — a loser of a bind race exits well before.
const SPAWN_CONFIRM_MS = 1_000;

export interface CollectorPaths {
  home: string;
  bin: string;
  config: string;
  log: string;
  pid: string;
  /** Fingerprint of the forwarding target the running collector was built for. */
  target: string;
  queueDir: string;
  /** One file per live command using the collector: `<pid>-<n>`. The last one out stops it. */
  users: string;
  /** Held while one command spawns, so concurrent spawners never race for the ports. */
  spawnLock: string;
}

export function collectorPaths(): CollectorPaths {
  // APO_COLLECTOR_DATA_DIR overrides the whole collector root — the seam
  // tests use to keep spawned collectors out of the developer's ~/.apo.
  const root = process.env.APO_COLLECTOR_DATA_DIR
    ?? join(homedir(), ".apo", "collector");
  // The binary is shared with older CLIs (same pinned release); the running
  // collector's state is not — see DEFAULT_OTLP_PORT.
  const home = join(root, "shared");
  return {
    home,
    bin: join(root, "bin", "otelcol-contrib"),
    config: join(home, "config.yaml"),
    log: join(home, "collector.log"),
    pid: join(home, "collector.pid"),
    target: join(home, "target.fingerprint"),
    queueDir: join(home, "queue"),
    users: join(home, "users"),
    spawnLock: join(home, "spawn.lock"),
  };
}

/**
 * Stable fingerprint of (backend, credential): a left-running collector is
 * only reusable when the next command forwards to the same target under the
 * same identity — otherwise it would ship spans to the previous backend or
 * project, silently.
 */
function targetFingerprint(backendUrl: string, authHeader: string): string {
  return createHash("sha256").update(`${backendUrl}\n${authHeader}`).digest("hex");
}

export interface CollectorRenderOptions {
  /** Backend base URL, e.g. https://apo.example.com — spans are forwarded there. */
  backendUrl: string;
  otlpPort: number;
  healthPort: number;
  metricsPort: number;
  queueDir: string;
  maxQueueBytes: number;
}

/**
 * Render the collector YAML. Values are resolved from the caller's
 * environment decisions at render time; the only environment placeholder left
 * in the file is the auth header, so the secret never lands on disk.
 */
export function renderCollectorConfig(opts: CollectorRenderOptions): string {
  const exportUrl = `${opts.backendUrl.replace(/\/$/, "")}${APO_TRACES_PATH}`;
  return `# apo local span-durability sidecar — managed by the apo CLI.
#
# Receives OTLP/HTTP from apo task processes on localhost and forwards to the
# apo backend through a bounded, persistent (write-ahead-log) queue, so spans
# survive backend outages, flaky networks, and collector restarts without
# unbounded local growth. Entries are deleted as soon as the backend acks; in
# steady state the queue directory is nearly empty.
#
# Validated against otelcol-contrib ${COLLECTOR_VERSION}. Regenerated by the
# CLI on every start — manual edits are overwritten.

extensions:
  file_storage:
    directory: ${opts.queueDir}
    create_directory: true
    # Hard cap on disk. When reached, new batches are dropped and counted in
    # otelcol_exporter_enqueue_failed_spans instead of filling the disk.
    max_size: ${opts.maxQueueBytes}
    timeout: 1s
    compaction:
      on_start: true
      on_rebound: true
      directory: ${opts.queueDir}
  health_check:
    endpoint: 127.0.0.1:${opts.healthPort}

receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:${opts.otlpPort}
        # Impersonate the apo ingest path so pointing a run at the collector
        # is one env var: AGENT_TASK_TRACE_ENDPOINT=http://127.0.0.1:<port>.
        traces_url_path: ${APO_TRACES_PATH}

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 512
    spike_limit_mib: 128
  batch:
    send_batch_size: 512
    send_batch_max_size: 1024
    # Short timeout so a finished run's tail spans reach the exporter queue
    # well inside stop()'s settle window.
    timeout: 1s

exporters:
  otlphttp/apo:
    traces_endpoint: ${exportUrl}
    encoding: json
    # apo's ingest decompresses gzip with a bounded reader.
    compression: gzip
    headers:
      # Secret via environment only — never persisted to this file.
      Authorization: "\${env:APO_COLLECTOR_AUTH}"
    timeout: 30s
    sending_queue:
      enabled: true
      storage: file_storage
      # Batches kept while the backend is unreachable (also bounded by
      # file_storage max_size above).
      queue_size: 10000
      num_consumers: 4
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 60s
      # Never give up on a batch; the queue bounds are the only limit.
      max_elapsed_time: 0s

service:
  extensions: [file_storage, health_check]
  # Queue-depth gauge scraped by stop() so a finished run's late spans drain
  # to the backend before the collector shuts down.
  telemetry:
    metrics:
      level: normal
      readers:
        - pull:
            exporter:
              prometheus:
                host: 127.0.0.1
                port: ${opts.metricsPort}
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlphttp/apo]
`;
}

/**
 * Decide whether the collector should run for a given backend. Auto-on only
 * where it pays (remote backends — localhost handoff to a local backend is
 * the same reliability class); APO_COLLECTOR=1/0 forces the decision either
 * way so it can be enabled in local tests and disabled on remote setups.
 */
export function decideCollectorEnabled(backendUrl: string): boolean {
  const forced = process.env.APO_COLLECTOR;
  if (forced !== undefined) {
    return forced === "1" || forced.toLowerCase() === "true";
  }
  try {
    return !isLoopbackHost(new URL(backendUrl));
  } catch {
    return false;
  }
}

function isLoopbackHost(url: URL): boolean {
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Map the current platform onto the upstream release asset naming. */
export function collectorPlatform(): { os: string; arch: string } | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : null;
  return os && arch ? { os, arch } : null;
}

export function collectorDownloadUrls(): { tarball: string; checksum: string } | null {
  const platform = collectorPlatform();
  if (!platform) return null;
  const base =
    `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download` +
    `/v${COLLECTOR_VERSION}/otelcol-contrib_${COLLECTOR_VERSION}_${platform.os}_${platform.arch}`;
  return { tarball: `${base}.tar.gz`, checksum: `${base}.tar.gz.sha256` };
}

/**
 * Resolve the collector binary: an explicit override wins, then a previously
 * installed copy, then a checksum-verified one-time download. Returns null
 * when the platform has no upstream release (caller falls back to direct
 * export).
 */
export async function ensureCollectorBinary(
  onNotice?: (message: string) => void,
): Promise<string | null> {
  const override = process.env.APO_COLLECTOR_BIN;
  if (override) return override;

  const paths = collectorPaths();
  if (existsSync(paths.bin)) return paths.bin;

  const urls = collectorDownloadUrls();
  if (!urls) return null;

  onNotice?.(
    `Downloading otelcol-contrib v${COLLECTOR_VERSION} (one-time, ~95 MB)…`,
  );
  mkdirSync(dirname(paths.bin), { recursive: true });
  await downloadAndExtract(urls, paths, onNotice);
  return existsSync(paths.bin) ? paths.bin : null;
}

async function downloadAndExtract(
  urls: { tarball: string; checksum: string },
  paths: CollectorPaths,
  onNotice?: (message: string) => void,
): Promise<void> {
  const response = await fetch(urls.tarball, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) {
    throw new Error(`collector download failed: HTTP ${response.status}`);
  }
  const tarball = join(dirname(paths.bin), "otelcol-contrib.tar.gz");
  await pipeline(response.body, createWriteStream(tarball));

  // Verify against the published checksum; a mismatch means a corrupted or
  // tampered download — discard rather than execute.
  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  let expected: string | null = null;
  try {
    const checksumResponse = await fetch(urls.checksum, { signal: AbortSignal.timeout(30_000) });
    if (checksumResponse.ok) {
      expected = (await checksumResponse.text()).trim().split(/\s+/)[0] ?? null;
    }
  } catch {
    // fall through to unverified — logged below
  }
  if (!expected) {
    onNotice?.("Warning: collector checksum could not be fetched — download NOT verified");
  }
  if (expected && expected !== actual) {
    rmSync(tarball, { force: true });
    throw new Error(
      `collector checksum mismatch: expected ${expected}, got ${actual} — download discarded`,
    );
  }

  const extracted = spawnSync("tar", ["-xzf", tarball, "-C", dirname(paths.bin)], {
    stdio: "pipe",
  });
  rmSync(tarball, { force: true });
  if (extracted.status !== 0) {
    throw new Error(
      `collector extraction failed: ${extracted.stderr?.toString().trim() || "tar error"}`,
    );
  }
}

export interface StartCollectorOptions {
  backendUrl: string;
  /** Full Authorization header value, e.g. "Bearer apo_...". Env-only. */
  authHeader: string;
  /** Progress notices (one-time download, startup) — user-facing. */
  onNotice?: (message: string) => void;
}

export interface CollectorHandle {
  /** Loopback base URL the task trace endpoint should be pointed at. */
  traceEndpoint: string;
  /** True when an already-running collector was reused instead of started. */
  reused: boolean;
  /**
   * Release this command's use of the collector, and stop the collector when
   * no other live command is using it and its queue is provably drained.
   * Resolves with "stopped", or "left-running" — when another apo command
   * (spawner or reuser alike) still uses it, or the backend is unreachable,
   * or the queue will not drain (bounded: in-flight retries are dropped at
   * collector shutdown). Whoever spawned it does not matter: stopping a
   * collector a sibling is still exporting through loses that sibling's
   * spans and fails its run's trace persistence.
   */
  stop(): Promise<"stopped" | "left-running">;
}

/**
 * Start (or reuse) the local collector and wait until it is healthy.
 *
 * Throws on any failure — callers treat that as "fall back to direct export",
 * which is never worse than the pre-collector behavior.
 */
export async function startCollector(opts: StartCollectorOptions): Promise<CollectorHandle> {
  const ports: CollectorPorts = {
    otlpPort: intEnv("APO_COLLECTOR_PORT", DEFAULT_OTLP_PORT),
    healthPort: intEnv("APO_COLLECTOR_HEALTH_PORT", DEFAULT_HEALTH_PORT),
    metricsPort: intEnv("APO_COLLECTOR_METRICS_PORT", DEFAULT_METRICS_PORT),
  };
  const wanted = targetFingerprint(opts.backendUrl, opts.authHeader);

  // Registered before probing: a last user stopping at this moment re-checks
  // the users right before its kill, so a command mid-start is stopped under
  // only in that last instant — and its watchdog restarts the collector.
  const user = registerUser();
  let reused: boolean;
  try {
    reused = await ensureCollector(opts, ports, wanted);
  } catch (error) {
    rmSync(user, { force: true });
    throw error;
  }
  const watchdog = startWatchdog(opts, ports, wanted);
  return {
    traceEndpoint: `http://127.0.0.1:${ports.otlpPort}`,
    reused,
    stop: async () => {
      await watchdog.stop();
      return releaseAndMaybeStop(user, ports, opts.backendUrl);
    },
  };
}

interface CollectorPorts {
  otlpPort: number;
  healthPort: number;
  metricsPort: number;
}

/**
 * A healthy collector is reused whatever started it: the config is ours
 * (same path impersonation), and a second start would fail to bind anyway.
 * Both ports are probed — a foreign service answering on the health port
 * alone must not trick us into pointing traces at a dead receiver.
 */
async function isServing(ports: CollectorPorts): Promise<boolean> {
  return (await isHealthy(ports.healthPort)) && (await isReceiverUp(ports.otlpPort));
}

/**
 * Reuse the running collector — only when it forwards to this command's
 * backend under its credential, since a mismatched one would ship this run's
 * spans to the previous target, silently — or spawn one. Returns true when
 * reused.
 */
async function ensureCollector(
  opts: StartCollectorOptions,
  ports: CollectorPorts,
  wanted: string,
): Promise<boolean> {
  const reuse = (): true => {
    if (readFingerprint() !== wanted) {
      throw new Error(
        "a collector for a different backend/credential is already running " +
          "(left over after an outage) — export directly; it keeps draining its own target",
      );
    }
    return true;
  };
  if (await isServing(ports)) return reuse();
  // Resolved (and on first use downloaded) outside the lock: concurrent
  // starters must not wait out a download.
  const bin = await resolveCollectorBinary(opts);
  return withSpawnLock(async () => {
    // Another command may have spawned it while this one waited for the lock.
    if (await isServing(ports)) return reuse();
    return (await spawnCollector(opts, ports, bin)) ? false : reuse();
  });
}

async function resolveCollectorBinary(opts: StartCollectorOptions): Promise<string> {
  const bin = await ensureCollectorBinary(opts.onNotice);
  if (!bin) {
    throw new Error("no otelcol-contrib release for this platform");
  }
  if (!existsSync(bin)) {
    // Fail before touching disk — a bad APO_COLLECTOR_BIN or a broken
    // install must not leave half-written state behind.
    throw new Error(`collector binary not found at ${bin}`);
  }
  return bin;
}

/**
 * Run `fn` holding the spawn lock: an exclusively created file naming its
 * holder's pid. Concurrent spawners would otherwise both start a child; the
 * loser fails to bind only after loading its config, by which time it may
 * have recorded its own, soon-dead pid as the collector's.
 *
 * A lock is stale when its holder is dead or it is older than any spawn can
 * take (a dead holder's pid may have been recycled by a live process). It is
 * taken over by renaming it aside — atomic, so two takers cannot both remove
 * it — and put back when what was renamed (told apart by inode) turns out to
 * be a fresh lock another taker created meanwhile. `abort` ends the wait (a stopping
 * watchdog).
 */
async function withSpawnLock<T>(fn: () => Promise<T>, abort?: () => boolean): Promise<T> {
  const paths = collectorPaths();
  mkdirSync(paths.home, { recursive: true });
  const spawnBoundMs = intEnv("APO_COLLECTOR_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS) + SPAWN_CONFIRM_MS;
  const staleAfterMs = spawnBoundMs + 5_000;
  const deadline = Date.now() + staleAfterMs + 5_000;
  for (;;) {
    try {
      writeFileSync(paths.spawnLock, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (abort?.()) throw new Error("aborted while waiting for the collector spawn lock");
    let observed: { ino: number; mtimeMs: number };
    try {
      observed = statSync(paths.spawnLock);
    } catch {
      continue; // released meanwhile
    }
    const holder = readPid(paths.spawnLock);
    if (holder === null || !isProcessAlive(holder) || Date.now() - observed.mtimeMs > staleAfterMs) {
      takeOverStaleLock(paths.spawnLock, observed.ino);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the collector spawn lock (${paths.spawnLock})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    return await fn();
  } finally {
    rmSync(paths.spawnLock, { force: true });
  }
}

function takeOverStaleLock(lock: string, staleIno: number): void {
  const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // another taker moved it first
  }
  try {
    // Not the lock judged stale: another taker's fresh lock. Restore it
    // unless yet another lock exists (link never overwrites).
    if (statSync(aside).ino !== staleIno) linkSync(aside, lock);
  } catch {
    // a lock exists again: leave it
  }
  rmSync(aside, { force: true });
}

function readPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Spawn a collector on the given ports and wait until it is healthy. Returns
 * true when this child is the one serving, and only then records its pid and
 * forwarding target; false when it exited because another collector holds
 * the ports. Throws on any other failure, leaving no half-started process
 * behind.
 */
async function spawnCollector(opts: StartCollectorOptions, ports: CollectorPorts, bin: string): Promise<boolean> {
  const paths = collectorPaths();
  mkdirSync(paths.queueDir, { recursive: true });
  writeFileSync(
    paths.config,
    renderCollectorConfig({
      backendUrl: opts.backendUrl,
      otlpPort: ports.otlpPort,
      healthPort: ports.healthPort,
      metricsPort: ports.metricsPort,
      queueDir: paths.queueDir,
      maxQueueBytes: intEnv("APO_COLLECTOR_MAX_QUEUE_BYTES", DEFAULT_MAX_QUEUE_BYTES),
    }),
  );

  const logFd = openSync(paths.log, "a");
  const child = spawn(bin, ["--config", paths.config], {
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      // The one secret the collector needs — argv and config stay clean.
      APO_COLLECTOR_AUTH: opts.authHeader,
    },
    // Own process group: a terminal Ctrl+C (group SIGINT) or the CLI's own
    // death must not kill the collector mid-retry — in-flight retries are
    // dropped at shutdown, exactly what this sidecar exists to prevent. Only
    // the last user's stop() ends it, and only once the queue is provably
    // drained.
    detached: true,
  });
  // The child holds its own duplicate of the log fd; the parent's copy can go.
  closeSync(logFd);
  child.unref();

  // Fail fast when the collector dies during startup (bad config, bad
  // binary) instead of waiting out the whole health timeout.
  const earlyExit = new Promise<never>((_, reject) => {
    child.once("exit", (code) => {
      reject(new Error(`collector exited during startup (code ${code}; log: ${paths.log})`));
    });
  });

  try {
    await Promise.race([
      waitForHealth(ports.healthPort, intEnv("APO_COLLECTOR_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS)),
      earlyExit,
    ]);
  } catch (error) {
    // Never leave a half-started process behind.
    killCollector(child);
    throw error;
  }
  // A later exit (a stop, a crash) must not turn this settled promise into
  // an unhandled rejection.
  earlyExit.catch(() => undefined);

  // The health check passes for whichever collector answers the port. A child
  // that lost the bind to another one exits shortly after loading its config;
  // its pid must never be recorded as the collector's.
  await new Promise((resolve) => setTimeout(resolve, SPAWN_CONFIRM_MS));
  if (child.exitCode !== null || child.signalCode !== null) return false;

  writeFileSync(paths.pid, `${child.pid}\n`);
  writeFileSync(
    paths.target,
    targetFingerprint(opts.backendUrl, opts.authHeader) + "\n",
    { mode: 0o600 },
  );
  return true;
}

let userSeq = 0;

/** Register this command as a live user of the collector; returns its user file. */
function registerUser(): string {
  const { users } = collectorPaths();
  mkdirSync(users, { recursive: true });
  const file = join(users, `${process.pid}-${++userSeq}`);
  writeFileSync(file, "");
  return file;
}

/**
 * Users other than `self` whose process is still alive. A file whose pid is
 * gone (a command that crashed or was killed before its stop) is pruned, so
 * it never keeps a collector running forever. A recycled pid can only keep
 * the collector running longer — never stop it early.
 */
function otherLiveUsers(self: string): string[] {
  const { users } = collectorPaths();
  let names: string[];
  try {
    names = readdirSync(users);
  } catch {
    return [];
  }
  const live: string[] = [];
  for (const name of names) {
    const file = join(users, name);
    if (file === self) continue;
    const pid = Number.parseInt(name.split("-")[0] ?? "", 10);
    if (Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid)) {
      live.push(file);
    } else {
      rmSync(file, { force: true });
    }
  }
  return live;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Last one out stops the collector. Unregisters `self` first, so two users
 * releasing at once cannot both see the other and leave the collector
 * orphaned; then stops only when nobody else is live, the backend is up, the
 * queue provably drained — and still nobody else is live after that wait.
 */
async function releaseAndMaybeStop(
  self: string,
  ports: CollectorPorts,
  backendUrl: string,
): Promise<"stopped" | "left-running"> {
  rmSync(self, { force: true });
  if (otherLiveUsers(self).length > 0) return "left-running";
  if (!(await isBackendUp(backendUrl))) return "left-running";
  if (!(await waitForQueueDrain(ports.metricsPort))) return "left-running";
  // A command may have started using the collector while the queue drained.
  if (otherLiveUsers(self).length > 0) return "left-running";
  return (await terminateRunningCollector(ports.healthPort)) ? "stopped" : "left-running";
}

interface Watchdog {
  /** Stop ticking and wait for a tick already in flight, so it cannot respawn after the stop. */
  stop(): Promise<void>;
}

/**
 * Keep the collector answering for as long as this handle is live: if it is
 * gone (stopped from outside, crashed), spawn it again on the same ports
 * under the spawn lock, so this run's exporter — whose endpoint is fixed for
 * the run — reconnects. When the ports are answered by a collector for
 * another backend/credential, this run's spans go there: warn once and stop
 * watching for the rest of the run — respawning is impossible while that
 * collector holds the ports, and the run's endpoint cannot move.
 */
function startWatchdog(opts: StartCollectorOptions, ports: CollectorPorts, wanted: string): Watchdog {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    if (await isServing(ports)) {
      if (readFingerprint() !== wanted) {
        stopped = true;
        opts.onNotice?.(
          "The local collector now forwards to a different backend/credential — this run's remaining spans may not reach it",
        );
      }
      return;
    }
    const bin = await resolveCollectorBinary(opts);
    const restarted = await withSpawnLock(
      async () => !stopped && !(await isServing(ports)) && (await spawnCollector(opts, ports, bin)),
      () => stopped,
    );
    if (restarted) opts.onNotice?.("Local collector was gone — restarted it");
  };
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = tick()
      .catch(() => undefined) // a failed restart is retried next tick
      .finally(() => {
        inFlight = undefined;
      });
  }, intEnv("APO_COLLECTOR_WATCHDOG_MS", DEFAULT_WATCHDOG_MS));
  timer.unref();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

async function isHealthy(healthPort: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${healthPort}/`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether an OTLP/HTTP receiver answers on apo's traces path. Any HTTP
 * status counts (an empty probe body is a 400); only a dead port does not.
 */
async function isReceiverUp(otlpPort: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${otlpPort}${APO_TRACES_PATH}`, {
      method: "POST",
      signal: AbortSignal.timeout(1_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(healthPort: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(healthPort)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `collector not healthy after ${timeoutMs}ms (log: ${collectorPaths().log})`,
  );
}

/** The fingerprint of the target the running collector was built for, or null. */
function readFingerprint(): string | null {
  try {
    return readFileSync(collectorPaths().target, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * End the running collector by its recorded pid; true when it ended (or
 * nothing was running). Signals it only while something answers on its
 * health port: a pid file outliving its collector may name an unrelated
 * process by now. SIGTERM, then SIGKILL after the bound.
 *
 * Callers only get here once the queue is provably drained: in-flight
 * retries are DROPPED at otelcol shutdown (the persistent queue only covers
 * items not yet popped for sending), so a SIGTERM while the backend is
 * unreachable or throttling loses exactly the spans the sidecar exists to
 * protect.
 */
async function terminateRunningCollector(healthPort: number): Promise<boolean> {
  if (!(await isHealthy(healthPort))) return true; // nothing running
  const pid = readPid(collectorPaths().pid);
  if (pid === null) return false; // something answers, but not a collector we recorded
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The recorded pid is gone while something still answers the health
    // port: not ours to stop.
    return false;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return true;
}

async function isBackendUp(backendUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${backendUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait until the exporter queue is provably empty — not merely momentarily
 * empty: the queue-size gauge cannot see spans still sitting in the batch
 * processor (held for up to the batch timeout after the last export) nor
 * items mid-retry (visible only as a rising send-failure counter). So: a
 * settle window longer than the batch timeout, then sustained zero queue
 * size AND a stable send-failure counter.
 */
async function waitForQueueDrain(metricsPort: number): Promise<boolean> {
  const timeoutMs = intEnv("APO_COLLECTOR_DRAIN_TIMEOUT_MS", DEFAULT_DRAIN_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  if ((await scrapeExporterMetrics(metricsPort)) === null) {
    return false; // metrics unreachable — cannot prove drain
  }
  // Let any partial batch move from the batch processor into the exporter
  // queue first; only then does a zero reading mean anything.
  await new Promise((resolve) => setTimeout(resolve, DEFAULT_SETTLE_MS));
  let emptySince: number | null = null;
  let failedSpans = -1;
  while (Date.now() < deadline) {
    const metrics = await scrapeExporterMetrics(metricsPort);
    if (metrics === null) return false;
    if (metrics.failedSpans > failedSpans) {
      // A send just failed (throttle, transient) — items are mid-retry.
      failedSpans = metrics.failedSpans;
      emptySince = null;
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (metrics.queued > 0 || metrics.inFlight > 0) {
      emptySince = null;
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (emptySince === null) emptySince = Date.now();
    if (Date.now() - emptySince >= DEFAULT_EMPTY_WINDOW_MS) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Exporter queue depth, in-flight requests, and failed-span count, or null. */
async function scrapeExporterMetrics(
  metricsPort: number,
): Promise<{ queued: number; inFlight: number; failedSpans: number } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${metricsPort}/metrics`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    let queued: number | null = null;
    let inFlight = 0;
    let failedSpans = 0;
    for (const line of text.split("\n")) {
      const value = Number.parseFloat(line.slice(line.lastIndexOf(" ") + 1));
      if (!Number.isFinite(value)) continue;
      if (line.startsWith("otelcol_exporter_queue_size")) {
        queued = (queued ?? 0) + value;
      } else if (line.startsWith("otelcol_exporter_in_flight_requests")) {
        inFlight += value;
      } else if (line.startsWith("otelcol_exporter_send_failed_spans")) {
        failedSpans += value;
      }
    }
    return queued === null ? null : { queued, inFlight, failedSpans };
  } catch {
    return null;
  }
}

function killCollector(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ── command-facing facade ─────────────────────────────────────────────────

export interface MaybeCollector {
  /**
   * Loopback base URL task traces should be pointed at, or null when the
   * collector is off/unavailable — callers then use their backend URL
   * directly, exactly the pre-collector behavior.
   */
  traceEndpoint: string | null;
  /**
   * Safe stop: only ends the process once its queue is provably drained.
   * Returns "left-running" when it must keep retrying (backend down or
   * throttling) — safe to call unconditionally.
   */
  stop(): Promise<"stopped" | "left-running" | "off">;
}

/**
 * Start the collector when it should run for this backend, with the command's
 * logging. Never throws: any failure degrades to direct export with a
 * warning, which is never worse than not having a collector at all.
 */
export async function maybeStartCollector(input: {
  backendUrl: string;
  /** Full Authorization header value; without one the collector cannot forward. */
  authHeader: string | null;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}): Promise<MaybeCollector> {
  const off: MaybeCollector = { traceEndpoint: null, stop: async () => "off" };
  if (!decideCollectorEnabled(input.backendUrl)) return off;
  if (!input.authHeader) {
    input.warn?.("span buffering off: no stored credential to forward — exporting directly");
    return off;
  }
  try {
    const handle = await startCollector({
      backendUrl: input.backendUrl,
      authHeader: input.authHeader,
      onNotice: (message) => input.log?.(message),
    });
    input.log?.(
      handle.reused
        ? "Span buffering on — reusing the running local collector"
        : "Span buffering on — traces survive network drops and backend outages",
    );
    return handle;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.warn?.(`span buffering unavailable (${message}) — exporting traces directly`);
    return off;
  }
}
