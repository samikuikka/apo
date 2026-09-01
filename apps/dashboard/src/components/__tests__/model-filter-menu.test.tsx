/**
 * The model filter list's visibility rule.
 *
 * Archiving retires a model from the Runs and Tasks dropdowns, but the list
 * must still show one the active filter selects — a saved view or a shared
 * `?model=` link can name a model that was archived afterwards, and hiding it
 * would leave the filter applied but invisible and unclearable.
 */

import { describe, expect, it } from "vitest";
import { visibleModels, type ModelPickerOption } from "../../lib/model-filter-options";

const option = (
  model: string,
  archived = false,
  count = 1,
): ModelPickerOption => ({ model, count, archived });

const names = (options: ModelPickerOption[]) => options.map((o) => o.model);

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
