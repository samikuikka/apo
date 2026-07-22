import { readFileSync } from "node:fs";

const publicUrl = "https://apo.example.com";
const renderedPath = process.argv[2];
if (!renderedPath) {
  throw new Error("usage: node scripts/test-public-ingress-contract.mjs <rendered-compose.json>");
}
const rendered = JSON.parse(readFileSync(renderedPath, "utf8"));

assert(rendered.services.caddy, "Server Profile must include Caddy");
assertEnvironment(rendered.services.caddy, "APO_PUBLIC_URL", publicUrl);
assertEnvironment(rendered.services.frontend, "NEXTAUTH_URL", publicUrl);
assertEnvironment(rendered.services.frontend, "BACKEND_URL", "http://backend:8000");
assertEnvironment(rendered.services.backend, "APO_DEPLOYMENT_PROFILE", "server");
assertEnvironment(rendered.services.backend, "APO_PUBLIC_URL", publicUrl);
assertEnvironment(rendered.services.backend, "FRONTEND_URL", publicUrl);

assertPublishedPort(rendered.services.caddy, 80, "tcp");
assertPublishedPort(rendered.services.caddy, 443, "tcp");
assertPublishedPort(rendered.services.caddy, 443, "udp");
assertLoopbackOnly(rendered.services.frontend, 3000);
assertLoopbackOnly(rendered.services.backend, 8000);

const caddyfile = readFileSync("deploy/self-host/Caddyfile", "utf8");
assert(caddyfile.includes("{$APO_PUBLIC_URL}"), "Caddy must use APO_PUBLIC_URL");
assert(caddyfile.includes("reverse_proxy frontend:3000"), "Caddy must proxy only to the frontend");

console.log("public ingress contract: ok");

function assertEnvironment(service, name, expected) {
  assert(service.environment?.[name] === expected, `${name} must equal ${expected}`);
}

function assertPublishedPort(service, port, protocol) {
  const found = service.ports?.some(
    (entry) => Number(entry.published) === port && entry.protocol === protocol,
  );
  assert(found, `Caddy must publish ${port}/${protocol}`);
}

function assertLoopbackOnly(service, port) {
  const entries = service.ports?.filter((entry) => Number(entry.published) === port) ?? [];
  assert(entries.length === 1, `${service.name ?? "service"} must publish ${port} exactly once`);
  assert(entries[0].host_ip === "127.0.0.1", `${port} must bind only to 127.0.0.1`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
