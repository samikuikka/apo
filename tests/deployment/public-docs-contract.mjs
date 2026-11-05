// Contract assertions for the public docs deployment overlay: the
// application host carries no ingress Basic Auth gate (identity is
// delegated to Apo application auth).
//
// Reads the rendered tunnel+docs Compose JSON plus the raw Caddyfile and
// cloudflared config, and asserts:
//   7. The docs service exists, is hardened, exposes only container port 8080,
//      and Caddy depends on its health.
//   8. Caddy routing is host-terminal: the docs host block precedes the app
//      block, proxies only to docs:8080; the app block delegates identity to
//      Apo application auth (no Basic Auth anywhere).
//   9. The Cloudflare Tunnel publishes both hostnames, docs first, terminal 404
//      last.
import { readFileSync } from "node:fs";

const DOCS_HOST = "docs.test-apo.online";
const APP_HOST = "test-apo.online";
const UMAMI_HOST = "umami.test-apo.online";

const renderedPath = process.argv[2];
if (!renderedPath) {
  throw new Error(
    "usage: node tests/deployment/public-docs-contract.mjs <rendered-compose.json> [rendered-umami-compose.json]",
  );
}
const rendered = JSON.parse(readFileSync(renderedPath, "utf8"));

// ---------------------------------------------------------------------------
// 7. Rendered deployment includes an isolated, hardened docs service.
// ---------------------------------------------------------------------------
const docs = rendered.services?.docs;
assert(docs, "public-docs overlay must define a 'docs' service");

assertNoHostPorts(docs, "docs service must expose no host ports");
assertContainerPort(docs, 8080, "docs service must expose container port 8080");

assert(
  docs.read_only === true,
  "docs service must be read_only: true",
);
assert(
  Array.isArray(docs.cap_drop) && docs.cap_drop.includes("ALL"),
  "docs service must cap_drop: [ALL]",
);
assert(
  Array.isArray(docs.security_opt) &&
    docs.security_opt.includes("no-new-privileges:true"),
  "docs service must set no-new-privileges:true",
);

// Caddy writes to /data and /config at startup; under read_only those need tmpfs.
assert(
  Array.isArray(docs.tmpfs) && docs.tmpfs.includes("/data"),
  "docs service must mount a writable tmpfs at /data for the read-only root",
);

assert(
  !docs.ports || docs.ports.length === 0,
  "docs service must publish no host ports",
);

// No source/repository mount — only the built dist is served.
const sourceMount = docs.volumes?.some(
  (v) =>
    typeof v === "string" &&
    (v.includes(":/app") || v.includes("repo") || v.includes(".env")),
);
assert(!sourceMount, "docs service must not mount repository source or .env");

// No application secrets leak into the docs container.
const docsEnv = docs.environment ?? {};
const SECRET_KEYS = [
  "AUTH_SECRET",
  "APO_CLOUDFLARE_TUNNEL_TOKEN",
  "DATABASE_URL",
  "APO_BACKEND_URL",
  "TUNNEL_TOKEN",
];
for (const key of SECRET_KEYS) {
  assert(
    !(key in docsEnv),
    `docs service must not receive secret ${key}`,
  );
}

// Healthcheck against the docs container's own /start.md.
const hc = Array.isArray(docs.healthcheck?.test) ? docs.healthcheck.test.join(" ") : "";
assert(
  hc.includes("8080") && hc.includes("start.md"),
  "docs healthcheck must probe http://localhost:8080/start.md",
);

// Caddy depends on docs health before accepting the docs route.
const caddy = rendered.services?.caddy;
assert(caddy, "tunnel overlay must include caddy");
const caddyDocsDep = caddy.depends_on?.docs;
assert(
  caddyDocsDep?.condition === "service_healthy",
  "caddy must depend on docs service_healthy",
);

// ---------------------------------------------------------------------------
// 8. Caddy routing is host-terminal.
// ---------------------------------------------------------------------------
const caddyfile = readFileSync("deploy/self-host/Caddyfile", "utf8");
const docsBlockIdx = caddyfile.indexOf("{$APO_DOCS_HOST}");
const appBlockIdx = caddyfile.indexOf("{$APO_CADDY_SITE_ADDRESS}");
assert(docsBlockIdx !== -1, "Caddyfile must define a {$APO_DOCS_HOST} site block");
assert(appBlockIdx !== -1, "Caddyfile must define the {$APO_CADDY_SITE_ADDRESS} app block");
assert(
  docsBlockIdx < appBlockIdx,
  "docs host block must precede the application block",
);

const docsBlock = caddyfile.slice(docsBlockIdx, appBlockIdx);
assert(
  docsBlock.includes("reverse_proxy docs:8080"),
  "docs host block must proxy only to docs:8080",
);
assert(
  !docsBlock.includes("auth.fragment"),
  "docs host block must not import the Basic Auth fragment",
);
assert(
  !docsBlock.includes("backend:8000"),
  "docs host block must never reach the backend",
);
// The application host block delegates identity to Apo application
// auth — no ingress Basic Auth gate remains anywhere in the Caddyfile.
const appBlock = caddyfile.slice(appBlockIdx);
assert(
  !appBlock.includes("auth.fragment"),
  "application host block must not import the Basic Auth fragment",
);
assert(
  !appBlock.includes("basic_auth"),
  "application host block must not contain a basic_auth directive",
);
assert(
  appBlock.includes("reverse_proxy frontend:3000"),
  "application host block must still proxy the frontend",
);
assertEnvironment(caddy, "APO_DOCS_HOST", DOCS_HOST);

// ---------------------------------------------------------------------------
// 9. Locally managed tunnel publishes both hostnames.
// ---------------------------------------------------------------------------
const tunnelConfig = readFileSync(
  "deploy/self-host/cloudflared-config.yml",
  "utf8",
);
const docsIngressIdx = tunnelConfig.indexOf(`hostname: ${DOCS_HOST}`);
const appIngressIdx = tunnelConfig.indexOf(`hostname: ${APP_HOST}`);
const catch404Idx = tunnelConfig.indexOf("http_status:404");
assert(docsIngressIdx !== -1, `tunnel ingress must include ${DOCS_HOST}`);
assert(appIngressIdx !== -1, `tunnel ingress must include ${APP_HOST}`);
assert(catch404Idx !== -1, "tunnel ingress must end with a terminal 404");
assert(
  docsIngressIdx < appIngressIdx && appIngressIdx < catch404Idx,
  "tunnel ingress must list docs host first, app host second, 404 last",
);
assert(
  tunnelConfig.includes("service: http://caddy:8080"),
  "both hostnames must target http://caddy:8080",
);

// ---------------------------------------------------------------------------
// 10. Without the umami overlay, the umami host falls back to the reserved
//     never-resolving TLD so the shared Caddyfile stays valid.
// ---------------------------------------------------------------------------
assertEnvironment(caddy, "APO_UMAMI_HOST", "umami-disabled.invalid");

// ---------------------------------------------------------------------------
// 11. Umami overlay: isolated analytics service, own database, no Apo secrets.
// ---------------------------------------------------------------------------
const umamiRenderedPath = process.argv[3];
if (!umamiRenderedPath) {
  console.log("public docs contract: ok (umami overlay not rendered)");
} else {
  const umamiStack = JSON.parse(readFileSync(umamiRenderedPath, "utf8"));

  const umami = umamiStack.services?.umami;
  assert(umami, "umami overlay must define a 'umami' service");
  assertNoHostPorts(umami, "umami service must expose no host ports");
  assertContainerPort(umami, 3000, "umami service must expose container port 3000");
  assert(umami.read_only === true, "umami service must be read_only: true");
  assert(
    Array.isArray(umami.cap_drop) && umami.cap_drop.includes("ALL"),
    "umami service must cap_drop: [ALL]",
  );
  assert(
    Array.isArray(umami.security_opt) &&
      umami.security_opt.includes("no-new-privileges:true"),
    "umami service must set no-new-privileges:true",
  );

  const umamiEnv = umami.environment ?? {};
  assert(
    typeof umamiEnv.DATABASE_URL === "string" &&
      umamiEnv.DATABASE_URL.startsWith("postgresql://umami:"),
    "umami DATABASE_URL must target the overlay's own postgres, not an Apo database",
  );
  assert(
    umamiEnv.UMAMI_DISABLE_TELEMETRY === "1",
    "umami service must disable its own telemetry collection",
  );
  for (const key of ["AUTH_SECRET", "APO_CLOUDFLARE_TUNNEL_TOKEN", "TUNNEL_TOKEN"]) {
    assert(!(key in umamiEnv), `umami service must not receive secret ${key}`);
  }

  const umamiDb = umamiStack.services?.["umami-db"];
  assert(umamiDb, "umami overlay must define a 'umami-db' service");
  assertNoHostPorts(umamiDb, "umami-db service must expose no host ports");

  const umamiCaddy = umamiStack.services?.caddy;
  assertEnvironment(umamiCaddy, "APO_UMAMI_HOST", UMAMI_HOST);
  const caddyUmamiDep = umamiCaddy.depends_on?.umami;
  assert(
    caddyUmamiDep?.condition === "service_healthy",
    "caddy must depend on umami service_healthy",
  );

  const docsBuildArgs = umamiStack.services?.docs?.build?.args ?? {};
  assert(
    docsBuildArgs.PUBLIC_UMAMI_URL === `https://${UMAMI_HOST}`,
    "docs build must receive PUBLIC_UMAMI_URL when the umami overlay is active",
  );
  assert(
    typeof docsBuildArgs.PUBLIC_UMAMI_WEBSITE_ID === "string" &&
      docsBuildArgs.PUBLIC_UMAMI_WEBSITE_ID.length > 0,
    "docs build must receive PUBLIC_UMAMI_WEBSITE_ID when the umami overlay is active",
  );

  // Caddy routes the umami host terminally, never reaching the backend.
  const umamiBlockIdx = caddyfile.indexOf("{$APO_UMAMI_HOST}");
  assert(umamiBlockIdx !== -1, "Caddyfile must define a {$APO_UMAMI_HOST} site block");
  const umamiBlock = caddyfile.slice(umamiBlockIdx, appBlockIdx);
  assert(
    umamiBlock.includes("reverse_proxy umami:3000"),
    "umami host block must proxy only to umami:3000",
  );
  assert(
    !umamiBlock.includes("backend:8000"),
    "umami host block must never reach the backend",
  );

  // Tunnel publishes the umami hostname before the terminal 404.
  const umamiIngressIdx = tunnelConfig.indexOf(`hostname: ${UMAMI_HOST}`);
  assert(umamiIngressIdx !== -1, `tunnel ingress must include ${UMAMI_HOST}`);
  assert(
    docsIngressIdx < umamiIngressIdx && umamiIngressIdx < catch404Idx,
    "tunnel ingress must list the umami host between docs and the terminal 404",
  );

  console.log("public docs contract: ok");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEnvironment(service, name, expected) {
  const actual = service.environment?.[name];
  assert(actual === expected, `${name} must equal ${expected} on caddy`);
}

function assertNoHostPorts(service, message) {
  const hostPorts = service.ports?.filter(
    (p) => p.published !== undefined && String(p.published) !== "",
  );
  assert(!hostPorts || hostPorts.length === 0, message);
}

function assertContainerPort(service, port, message) {
  const found = service.expose?.some(
    (e) => Number(String(e).split(":")[0]) === port,
  );
  assert(found, message);
}
