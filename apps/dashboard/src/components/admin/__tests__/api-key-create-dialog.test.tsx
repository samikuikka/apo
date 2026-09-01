/**
 * Issue #73: the Create API key dialog must offer the user's accessible
 * projects as a selector instead of a free-text Project ID input, and must
 * default to the project currently selected in the API Keys section.
 *
 * Tests cover: default selection, initial fallback to the first project,
 * changing selection + the exact Project ID submitted, and the no-project
 * empty state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-keys-api", () => ({
  createApiKey: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createApiKey } from "@/lib/api-keys-api";
import { ApiKeyCreateDialog } from "@/components/admin/api-key-create-dialog";
import type { Project } from "@/lib/projects-api";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-a",
    name: "Alpha",
    created_by: "u1",
    created_at: "2026-07-01",
    current_user_role: "admin",
    ...overrides,
  };
}

const reveal = {
  id: "k1",
  name: "Production",
  prefix: "pk-apo-",
  project: "proj-a",
  created_by: "u1",
  scope: "ingest",
  created_at: "2026-07-30T00:00:00",
  last_used_at: null,
  expires_at: null,
  publicKey: "pk-apo-abc",
  secretKey: "sk-apo-secret",
  displaySecretKey: "sk-apo-se••",
};

beforeEach(() => {
  vi.mocked(createApiKey).mockReset();
  vi.mocked(createApiKey).mockResolvedValue(reveal);
});

describe("ApiKeyCreateDialog project selector (issue #73)", () => {
  it("selects the parent's current project by default", () => {
    const projects = [
      project({ id: "proj-a", name: "Alpha" }),
      project({ id: "proj-b", name: "Beta" }),
    ];
    render(
      <ApiKeyCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
        projects={projects}
        defaultProject="proj-b"
      />,
    );

    const select = screen.getByLabelText("Project") as HTMLSelectElement;
    expect(select.value).toBe("proj-b");
  });

  it("falls back to the first accessible project when none is passed", () => {
    const projects = [
      project({ id: "proj-a", name: "Alpha" }),
      project({ id: "proj-b", name: "Beta" }),
    ];
    render(
      <ApiKeyCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
        projects={projects}
      />,
    );

    const select = screen.getByLabelText("Project") as HTMLSelectElement;
    expect(select.value).toBe("proj-a");
  });

  it("submits the selected Project ID (not the display name)", async () => {
    const user = userEvent.setup();
    const projects = [
      project({ id: "proj-a", name: "Alpha" }),
      project({ id: "proj-b", name: "Beta" }),
    ];
    render(
      <ApiKeyCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
        projects={projects}
        defaultProject="proj-a"
      />,
    );

    await user.selectOptions(screen.getByLabelText("Project"), "proj-b");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(createApiKey).toHaveBeenCalledWith(
      "Default",
      "proj-b",
      "ingest",
      undefined,
      null,
    );
  });

  it("disables creation and shows an empty state when there are no eligible projects", () => {
    render(
      <ApiKeyCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
        projects={[]}
      />,
    );

    expect(screen.getByLabelText("Project")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Create key" }),
    ).toBeDisabled();
  });
});
