import { describe, it, expect } from "vitest";

import { taskDetailHref } from "../task-routes";

describe("taskDetailHref", () => {
  describe("project id is interpolated verbatim", () => {
    it("places a plain project id into the path", () => {
      expect(taskDetailHref("demo", "data-extraction")).toBe(
        "/project/demo/tasks/data-extraction",
      );
    });

    it("does not double-encode an already-path-safe project id", () => {
      expect(taskDetailHref("54086649e413", "meeting-summary")).toBe(
        "/project/54086649e413/tasks/meeting-summary",
      );
    });
  });

  describe("hierarchical task ids keep one path segment per slash", () => {
    it("encodes a bare task name as a single segment", () => {
      expect(taskDetailHref("demo", "data-extraction")).toBe(
        "/project/demo/tasks/data-extraction",
      );
    });

    it("keeps a folder-scoped id as two segments (the navigation bug case)", () => {
      // `ai-sdk-agent/data-extraction` must become
      // `ai-sdk-agent/data-extraction` in the URL — NOT
      // `ai-sdk-agent%2Fdata-extraction`. The detail route is a catch-all
      // (`tasks/[...taskId]`); encoding the slash would collapse both
      // segments into one and the page would see the wrong task id.
      expect(taskDetailHref("54086649e413", "ai-sdk-agent/data-extraction")).toBe(
        "/project/54086649e413/tasks/ai-sdk-agent/data-extraction",
      );
    });

    it("keeps a deeply nested id as one segment per path part", () => {
      expect(
        taskDetailHref("demo", "real-agent/documents/data-extraction"),
      ).toBe("/project/demo/tasks/real-agent/documents/data-extraction");
    });
  });

  describe("reserved characters within a segment are still encoded", () => {
    it("encodes spaces inside a segment but leaves the separating slash alone", () => {
      expect(taskDetailHref("demo", "folder name/task id")).toBe(
        "/project/demo/tasks/folder%20name/task%20id",
      );
    });

    it("encodes a query-like segment without touching the path slash", () => {
      expect(taskDetailHref("demo", "a/b?c=d")).toBe(
        "/project/demo/tasks/a/b%3Fc%3Dd",
      );
    });
  });
});
