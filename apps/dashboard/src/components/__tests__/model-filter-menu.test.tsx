/**
 * The model filter list's visibility rule.
 *
 * Archiving retires a model from the Runs and Tasks dropdowns, but the list
 * must still show one the active filter selects — a saved view or a shared
 * `?model=` link can name a model that was archived afterwards, and hiding it
 * would leave the filter applied but invisible and unclearable.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelFilterMenu } from "../model-filter-menu";
import {
  groupModelsByProvider,
  visibleModels,
  type ModelPickerOption,
} from "../../lib/model-filter-options";

const option = (
  model: string,
  archived = false,
  count = 1,
): ModelPickerOption => ({ model, count, archived });

const names = (options: ModelPickerOption[]) => options.map((o) => o.model);

// Nine models: over the flat limit, with two providers at 2+ models each.
const crowded: ModelPickerOption[] = [
  option("deepseek/deepseek-v4.1-flash", false, 7),
  option("google/gemini-2.5-flash-lite", false, 11),
  option("anthropic/claude-haiku-4-5", false, 10),
  option("z-ai/glm-5.3-flash", false, 9),
  option("deepseek/deepseek-v4-flash-0731", false, 11),
  option("claude-haiku-4-5-20251001", false, 2),
  option("deepseek/deepseek-r1", false, 1),
  option("google/gemini-2.5-pro", false, 4),
  option("kimi-k3", false, 3),
];

describe("visibleModels", () => {
  it("lists every model when none are archived", () => {
    const options = [option("claude-opus-5"), option("kimi-k3")];
    expect(names(visibleModels(options, new Set()))).toEqual([
      "claude-opus-5",
      "kimi-k3",
    ]);
  });

  it("drops archived models from the list", () => {
    const options = [option("claude-opus-5"), option("pi:claude-opus-5", true)];
    expect(names(visibleModels(options, new Set()))).toEqual(["claude-opus-5"]);
  });

  it("keeps an archived model that the filter selects", () => {
    const options = [option("claude-opus-5"), option("pi:claude-opus-5", true)];
    const selected = new Set(["pi:claude-opus-5"]);
    expect(names(visibleModels(options, selected))).toEqual([
      "claude-opus-5",
      "pi:claude-opus-5",
    ]);
  });

  it("keeps only the selected archived model, not every archived one", () => {
    const options = [
      option("claude-opus-5"),
      option("pi:claude-opus-5", true),
      option("pi:kimi-k3", true),
    ];
    const selected = new Set(["pi:claude-opus-5"]);
    expect(names(visibleModels(options, selected))).toEqual([
      "claude-opus-5",
      "pi:claude-opus-5",
    ]);
  });

  it("can empty the list when everything is archived and nothing is selected", () => {
    const options = [option("pi:claude-opus-5", true), option("pi:kimi-k3", true)];
    expect(visibleModels(options, new Set())).toEqual([]);
  });

  it("preserves the caller's ordering and the counts", () => {
    const options = [option("kimi-k3", false, 53), option("glm-5.2", false, 9)];
    expect(visibleModels(options, new Set())).toEqual(options);
  });
});

describe("groupModelsByProvider", () => {
  it("keeps a short list flat", () => {
    const options = [option("deepseek/deepseek-v4.1-flash"), option("kimi-k3")];
    expect(groupModelsByProvider(options)).toBeNull();
  });

  it("stays flat when nearly every model is its own provider", () => {
    // Nine models, but only deepseek repeats — sections would be pure chrome.
    const mostlyUnique = crowded.slice(0, 5).concat([
      option("moonshot/kimi-k3"),
      option("qwen/qwen3-max"),
      option("mistral/mistral-large"),
      option("grok/grok-4"),
    ]);
    expect(groupModelsByProvider(mostlyUnique)).toBeNull();
  });

  it("sections by provider prefix and sums each group's runs", () => {
    const groups = groupModelsByProvider(crowded);
    expect(groups?.map((g) => g.provider)).toEqual([
      "deepseek",
      "google",
      "anthropic",
      "z-ai",
      "other",
    ]);
    const deepseek = groups?.find((g) => g.provider === "deepseek");
    expect(deepseek?.models.map((m) => m.model)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-flash-0731",
      "deepseek/deepseek-r1",
    ]);
    expect(deepseek?.totalRuns).toBe(19);
  });

  it("follows the last slash, matching shortModel's split", () => {
    const groups = groupModelsByProvider([
      option("openrouter/deepseek/deepseek-v4.1-flash"),
      option("openrouter/deepseek/deepseek-r1"),
      option("openai/gpt-5.1", false, 5),
      option("openai/gpt-5.1-mini", false, 5),
      option("openai/gpt-5", false, 5),
      option("openai/gpt-4.1", false, 5),
      option("google/gemini-2.5-pro", false, 5),
      option("google/gemini-2.5-flash", false, 5),
      option("anthropic/claude-haiku-4-5", false, 5),
    ]);
    expect(groups?.map((g) => g.provider)).toEqual([
      "openrouter/deepseek",
      "openai",
      "google",
      "anthropic",
    ]);
  });

  it("puts the no-prefix section last even when a bare model leads the list", () => {
    const bareFirst = [
      option("kimi-k3", false, 50),
      ...crowded.filter((o) => o.model !== "kimi-k3"),
    ];
    const groups = groupModelsByProvider(bareFirst);
    expect(groups?.at(-1)?.provider).toBe("other");
    expect(groups?.at(-1)?.models.map((m) => m.model)).toEqual([
      "kimi-k3",
      "claude-haiku-4-5-20251001",
    ]);
  });
});

describe("ModelFilterMenu sections", () => {
  const openMenu = async (options: ModelPickerOption[]) => {
    const user = userEvent.setup();
    render(
      <ModelFilterMenu
        trigger={<button type="button">Model</button>}
        options={options}
        selected={new Set()}
        multiple
        onToggle={() => {}}
        onClear={() => {}}
        onSetArchived={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    return screen.findByText("Filter by model");
  };

  it("sections a long list by provider, rows without their prefix", async () => {
    await openMenu(crowded);
    // Provider headers carry the group's total run count.
    expect(screen.getByText("19")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v4.1-flash")).toBeInTheDocument();
    expect(screen.getByText("gemini-2.5-flash-lite")).toBeInTheDocument();
    expect(screen.getByText("kimi-k3")).toBeInTheDocument();
    // A header exists for each provider; the bare names share `other`.
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  it("keeps a short list flat — no provider headers", async () => {
    await openMenu([option("deepseek/deepseek-v4.1-flash"), option("kimi-k3")]);
    expect(screen.getByText("deepseek-v4.1-flash")).toBeInTheDocument();
    expect(screen.queryByText("other")).not.toBeInTheDocument();
    expect(screen.queryByText("deepseek")).not.toBeInTheDocument();
  });
});
