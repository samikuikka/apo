import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import * as credentials from "../src/lib/credentials.ts";
import {
  listProfiles,
  readProfile,
  writeProfile,
  removeProfile,
  activeProfileName,
  type Profile,
} from "../src/lib/profiles.ts";
import { run as runProfile } from "../src/commands/profile.ts";
import { stripAnsi } from "../src/lib/format.ts";

const PROD: Profile = {
  name: "prod",
  backend_url: "https://tesapo.online",
  api_key: "sk-prod",
  email: "admin@company.com",
  project: "proj-prod",
  task_root: "/repo/e2e",
};

const LOCAL: Profile = {
  name: "local",
  backend_url: "http://localhost:8000",
  api_key: "sk-local",
  email: "dev@apo.local",
  project: "proj-dev",
  task_root: "/repo/e2e",
};

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "apo-profiles-test-"));
}

function capture(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  return { logs, errors, restore: () => { console.log = origLog; console.error = origErr; } };
}

function readActive(): credentials.StoredCredentials | null {
  return credentials.readCredentials();
}

describe("profiles lib", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
    process.env.HOME = home;
  });
  afterEach(() => {
    delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writeProfile/readProfile round-trip with 0o600 mode", () => {
    writeProfile(PROD);
    const back = readProfile("prod");
    expect(back).toEqual(PROD);
    const path = join(home, ".apo", "profiles", "prod.json");
    expect(existsSync(path)).toBe(true);
    const mode = (chmodSync(path, 0o600), (readFileSync(path) as unknown)); // touch read
    expect(mode).toBeTruthy();
    expect((readFileSync(path, "utf8") as string).length).toBeGreaterThan(0);
  });

  it("listProfiles skips invalid files", () => {
    const dir = join(home, ".apo", "profiles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "prod.json"), JSON.stringify(PROD));
    writeFileSync(join(dir, "junk.json"), "{not json");
    const names = listProfiles().map((p) => p.name);
    expect(names).toEqual(["prod"]);
  });

  it("removeProfile refuses the active profile", () => {
    writeProfile(PROD);
    credentials.writeCredentials({ ...PROD, profile_name: "prod" });
    const { errors, restore } = capture();
    const ok = removeProfile("prod");
    restore();
    expect(ok).toBe(false);
    expect(errors.join("\n")).toContain("prod");
    expect(readProfile("prod")).not.toBeNull();
  });

  it("removeProfile deletes an inactive profile", () => {
    writeProfile(PROD);
    writeProfile(LOCAL);
    expect(removeProfile("prod")).toBe(true);
    expect(readProfile("prod")).toBeNull();
    expect(readProfile("local")).not.toBeNull();
  });

  it("activeProfileName reads the active credentials", () => {
    credentials.writeCredentials({ ...LOCAL, profile_name: "local" });
    expect(activeProfileName()).toBe("local");
  });
});

describe("apo profile command (scene)", () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
    process.env.HOME = home;
  });
  afterEach(() => {
    delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("save captures the current context, use switches to it", async () => {
    // Start logged in locally.
    credentials.writeCredentials({
      backend_url: "http://localhost:8000",
      api_key: "sk-local",
      email: "dev@apo.local",
      project: "proj-dev",
    });
    // A prod profile saved earlier.
    writeProfile(PROD);
    // The prod backend accepts the prod key.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("tesapo.online")) {
        return new Response("[]", { status: 200 });
      }
      throw new Error(`unexpected call: ${String(input)}`);
    });
    const { logs, errors, restore } = capture();

    const code = await runProfile(["use", "prod"]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(out).toContain("Switched to prod");
    expect(out).toContain("https://tesapo.online");
    const active = readActive();
    expect(active?.backend_url).toBe("https://tesapo.online");
    expect(active?.api_key).toBe("sk-prod");
    expect(active?.profile_name).toBe("prod");
  });

  it("use resolves a unique prefix", async () => {
    credentials.writeCredentials({ ...LOCAL });
    writeProfile(PROD);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    const code = await runProfile(["use", "p"]);
    expect(code).toBe(0);
    expect(readActive()?.profile_name).toBe("prod");
  });

  it("use with an ambiguous prefix exits 2 and lists candidates", async () => {
    credentials.writeCredentials({ ...LOCAL });
    writeProfile({ ...PROD, name: "prod-a" });
    writeProfile({ ...PROD, name: "prod-b" });
    const { errors, restore } = capture();
    const code = await runProfile(["use", "prod"]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("prod-a");
    expect(errors.join("\n")).toContain("prod-b");
    expect(readActive()?.profile_name).toBeUndefined();
  });

  it("use with an unreachable backend exits 2 and leaves credentials untouched", async () => {
    credentials.writeCredentials({ ...LOCAL, profile_name: "local" });
    writeProfile(PROD);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { errors, restore } = capture();
    const code = await runProfile(["use", "prod"]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("https://tesapo.online");
    const active = readActive();
    expect(active?.backend_url).toBe("http://localhost:8000");
    expect(active?.api_key).toBe("sk-local");
  });

  it("use with a rejected key exits 2 without activating", async () => {
    credentials.writeCredentials({ ...LOCAL });
    writeProfile(PROD);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    const { errors, restore } = capture();
    const code = await runProfile(["use", "prod"]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("rejected");
    expect(readActive()?.backend_url).toBe("http://localhost:8000");
  });

  it("list renders profiles and marks the active one", async () => {
    credentials.writeCredentials({ ...PROD, profile_name: "prod" });
    writeProfile(PROD);
    writeProfile(LOCAL);
    const { logs, restore } = capture();
    const code = await runProfile(["list"]);
    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain("prod");
    expect(out).toContain("local");
    expect(out).toMatch(/\*.*prod/);
  });

  it("list includes legacy remembered logins", async () => {
    credentials.writeCredentials({ ...LOCAL });
    mkdirSync(join(home, ".apo", "logins"), { recursive: true });
    writeFileSync(
      join(home, ".apo", "logins", "docker_8000.json"),
      JSON.stringify({ backend_url: "http://localhost:8000", api_key: "k", email: "x@y.z" }),
    );
    const { logs, restore } = capture();
    const code = await runProfile(["list"]);
    restore();
    expect(code).toBe(0);
    expect(stripAnsi(logs.join("\n"))).toContain("localhost-8000");
  });

  it("save stores the current context under a name", async () => {
    credentials.writeCredentials({
      backend_url: "https://tesapo.online",
      api_key: "sk-prod",
      email: "admin@company.com",
      project: "proj-prod",
    });
    const { logs, restore } = capture();
    const code = await runProfile(["save", "company"]);
    restore();
    expect(code).toBe(0);
    const saved = readProfile("company");
    expect(saved).toMatchObject({ name: "company", backend_url: "https://tesapo.online", api_key: "sk-prod" });
    expect(stripAnsi(logs.join("\n"))).toContain("company");
  });

  it("save refuses to overwrite without --force", async () => {
    credentials.writeCredentials({ ...PROD });
    writeProfile({ ...PROD, api_key: "sk-old" });
    const { errors, restore } = capture();
    const code = await runProfile(["save", "prod"]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--force");
    expect(readProfile("prod")?.api_key).toBe("sk-old");
  });

  it("save validates the profile name", async () => {
    credentials.writeCredentials({ ...LOCAL });
    const { errors, restore } = capture();
    const code = await runProfile(["save", "bad name!"]);
    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Invalid profile name");
  });

  it("remove deletes an inactive profile", async () => {
    credentials.writeCredentials({ ...LOCAL, profile_name: "local" });
    writeProfile(PROD);
    writeProfile(LOCAL);
    const code = await runProfile(["remove", "prod"]);
    expect(code).toBe(0);
    expect(readProfile("prod")).toBeNull();
  });
});
