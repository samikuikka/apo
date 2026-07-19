import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ViewPreferencesProvider,
  useViewPreferences,
} from "../contexts/ViewPreferencesContext";

const STORAGE_KEY = "trace-view-preferences:v1";

function createLocalStorageMock() {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      Object.keys(store).forEach((k) => delete store[k]);
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((_index: number) => null),
    _store: store,
  };
}

let mockStorage: ReturnType<typeof createLocalStorageMock>;

function Consumer() {
  const { preferences, updatePreference } = useViewPreferences();
  return (
    <div>
      <span data-testid="showDuration">{String(preferences.showDuration)}</span>
      <span data-testid="showCostTokens">{String(preferences.showCostTokens)}</span>
      <span data-testid="showScores">{String(preferences.showScores)}</span>
      <span data-testid="colorCodeMetrics">{String(preferences.colorCodeMetrics)}</span>
      <span data-testid="minLevel">{preferences.minObservationLevel}</span>
      <button
        type="button"
        data-testid="toggle-duration"
        onClick={() => updatePreference("showDuration", !preferences.showDuration)}
      />
      <button
        type="button"
        data-testid="set-level-error"
        onClick={() => updatePreference("minObservationLevel", "ERROR")}
      />
    </div>
  );
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<ViewPreferencesProvider>{ui}</ViewPreferencesProvider>);
}

describe("ViewPreferencesContext", () => {
  beforeEach(() => {
    mockStorage = createLocalStorageMock();
    vi.stubGlobal("localStorage", mockStorage);
  });

  it("provides default preferences when localStorage is empty", () => {
    renderWithProvider(<Consumer />);

    expect(screen.getByTestId("showDuration").textContent).toBe("true");
    expect(screen.getByTestId("showCostTokens").textContent).toBe("true");
    expect(screen.getByTestId("showScores").textContent).toBe("false");
    expect(screen.getByTestId("colorCodeMetrics").textContent).toBe("false");
    expect(screen.getByTestId("minLevel").textContent).toBe("DEFAULT");
  });

  it("loads preferences from localStorage", () => {
    mockStorage._store[STORAGE_KEY] = JSON.stringify({
      showDuration: false,
      showCostTokens: false,
      showScores: true,
      colorCodeMetrics: true,
      minObservationLevel: "ERROR",
    });

    renderWithProvider(<Consumer />);

    expect(screen.getByTestId("showDuration").textContent).toBe("false");
    expect(screen.getByTestId("showCostTokens").textContent).toBe("false");
    expect(screen.getByTestId("showScores").textContent).toBe("true");
    expect(screen.getByTestId("colorCodeMetrics").textContent).toBe("true");
    expect(screen.getByTestId("minLevel").textContent).toBe("ERROR");
  });

  it("falls back to defaults for partial localStorage data", () => {
    mockStorage._store[STORAGE_KEY] = JSON.stringify({ showDuration: false });

    renderWithProvider(<Consumer />);

    expect(screen.getByTestId("showDuration").textContent).toBe("false");
    expect(screen.getByTestId("showCostTokens").textContent).toBe("true");
    expect(screen.getByTestId("showScores").textContent).toBe("false");
    expect(screen.getByTestId("colorCodeMetrics").textContent).toBe("false");
    expect(screen.getByTestId("minLevel").textContent).toBe("DEFAULT");
  });

  it("persists preference changes to localStorage", async () => {
    const user = userEvent.setup();
    renderWithProvider(<Consumer />);

    await user.click(screen.getByTestId("toggle-duration"));

    expect(screen.getByTestId("showDuration").textContent).toBe("false");
    expect(mockStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      expect.any(String),
    );
    const stored = JSON.parse(mockStorage._store[STORAGE_KEY]);
    expect(stored.showDuration).toBe(false);
  });

  it("persists minObservationLevel changes", async () => {
    const user = userEvent.setup();
    renderWithProvider(<Consumer />);

    await user.click(screen.getByTestId("set-level-error"));

    expect(screen.getByTestId("minLevel").textContent).toBe("ERROR");
    const stored = JSON.parse(mockStorage._store[STORAGE_KEY]);
    expect(stored.minObservationLevel).toBe("ERROR");
  });

  it("handles corrupted localStorage gracefully", () => {
    mockStorage._store[STORAGE_KEY] = "not-valid-json{{{";

    renderWithProvider(<Consumer />);

    expect(screen.getByTestId("showDuration").textContent).toBe("true");
    expect(screen.getByTestId("showCostTokens").textContent).toBe("true");
    expect(screen.getByTestId("showScores").textContent).toBe("false");
    expect(screen.getByTestId("colorCodeMetrics").textContent).toBe("false");
    expect(screen.getByTestId("minLevel").textContent).toBe("DEFAULT");
  });

  it("throws when useViewPreferences is used outside provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<Consumer />);
    }).toThrow("useViewPreferences must be used within ViewPreferencesProvider");

    consoleError.mockRestore();
  });

  it("maintains other preferences when updating one", async () => {
    mockStorage._store[STORAGE_KEY] = JSON.stringify({
      showDuration: true,
      showCostTokens: true,
      showScores: true,
      colorCodeMetrics: true,
      minObservationLevel: "WARNING",
    });

    const user = userEvent.setup();
    renderWithProvider(<Consumer />);

    await user.click(screen.getByTestId("toggle-duration"));

    expect(screen.getByTestId("showDuration").textContent).toBe("false");
    expect(screen.getByTestId("showCostTokens").textContent).toBe("true");
    expect(screen.getByTestId("showScores").textContent).toBe("true");
    expect(screen.getByTestId("colorCodeMetrics").textContent).toBe("true");
    expect(screen.getByTestId("minLevel").textContent).toBe("WARNING");
  });
});
