// Fixture server for the public-ingress smoke contract.
//
// Three modes, selected by argv[2]:
//   basic-gate — the former broken ingress: every route except public health
//                answers 401 with `WWW-Authenticate: Basic realm="restricted"`.
//                The smoke script must FAIL against this.
//   app        — the target: admission shells and public auth routes answer
//                as Apo would; the anonymous project list carries only the
//                public demo workspace. The smoke script must PASS.
//   app-leak   — like app, but the anonymous project list also contains a
//                member project. The smoke script must FAIL and name the leak.
//
// Usage: node tests/deployment/public-ingress-smoke-fixture.mjs <port> <mode>
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const mode = process.argv[3];
if (!Number.isInteger(port) || port <= 0 || !["basic-gate", "app", "app-leak"].includes(mode)) {
  throw new Error("usage: node public-ingress-smoke-fixture.mjs <port> <basic-gate|app|app-leak>");
}

const BASIC_CHALLENGE = { "WWW-Authenticate": 'Basic realm="restricted"' };
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Routes that emulate the backend's bounded public/unauth responses in app mode. */
function appResponse(req, res) {
  const path = new URL(req.url, "http://fixture.invalid").pathname;

  if (path === "/api/public/health") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ status: "ready" }));
    return;
  }

  // Admission shells — the dashboard serves these unauthenticated.
  if (path === "/login" || path === "/join") {
    res.writeHead(200, { "Content-Type": "text/html", "Strict-Transport-Security": "max-age=31536000" });
    res.end("<!doctype html><title>apo fixture</title>");
    return;
  }

  // Public auth route — bounded installation status.
  if (path === "/auth/has-users") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ has_users: true, setup_available: false }));
    return;
  }

  // CLI bootstrap — Apo's own credential validation (invalid → 401 JSON).
  if (path === "/v1/api-keys/bootstrap") {
    res.writeHead(401, JSON_HEADERS);
    res.end(JSON.stringify({ detail: "Invalid credentials" }));
    return;
  }

  // Anonymous project list — the public demo workspace only. Anonymous
  // callers may see demo, never a member project; app-leak mode simulates
  // the violation the smoke probe must catch.
  if (path === "/v1/projects" && req.method === "GET") {
    const projects = [
      { id: "demo", name: "Demo workspace", current_user_role: "viewer" },
      ...(mode === "app-leak"
        ? [{ id: "prod-member", name: "Member workspace", current_user_role: null }]
        : []),
    ];
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(projects));
    return;
  }

  // Anonymous demo surface — readable, read-only, never cached.
  if (path === "/v1/projects/demo" && req.method === "GET") {
    res.writeHead(200, { ...JSON_HEADERS, "Cache-Control": "no-store" });
    res.end(JSON.stringify({ id: "demo", name: "Demo workspace", current_user_role: "viewer" }));
    return;
  }

  // Anonymous demo mutation — credential-required 401 JSON.
  if (path === "/v1/agent-task-batch-runs" && req.method === "POST") {
    res.writeHead(401, JSON_HEADERS);
    res.end(JSON.stringify({ detail: "Not authenticated" }));
    return;
  }

  // OTLP ingest — Apo 401 JSON, never a Basic challenge.
  if (path === "/api/public/otel/v1/traces") {
    res.writeHead(401, JSON_HEADERS);
    res.end(JSON.stringify({ detail: "Not authenticated" }));
    return;
  }

  // Raw operator diagnostics and removed legacy routes — terminal denial.
  // Any unhandled /v1/* path is a removed backend route.
  if (
    path.startsWith("/backend-proxy/") ||
    path === "/api/health/ready" ||
    path.startsWith("/public/traces/") ||
    (path.startsWith("/v1/") && path !== "/v1/api-keys/bootstrap" && path !== "/v1/projects")
  ) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  // Dashboard fallback.
  res.writeHead(200, { "Content-Type": "text/html", "Strict-Transport-Security": "max-age=31536000" });
  res.end("<!doctype html><title>apo fixture</title>");
}

const server = createServer((req, res) => {
  if (mode === "basic-gate" && req.url !== "/api/public/health") {
    // The legacy Caddy layer: one installation-wide password in front
    // of every browser and CLI admission path.
    res.writeHead(401, { "Content-Type": "text/plain", ...BASIC_CHALLENGE });
    res.end("401 Unauthorized");
    return;
  }
  appResponse(req, res);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fixture:${mode}:${port}\n`);
});
