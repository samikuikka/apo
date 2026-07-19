import { describe, it, expect } from "vitest";
import {
  APO_OBSERVATION_TYPE,
  APO_RUN_ID,
  APO_RUN_FLOW_NAME,
  APO_RUN_TASK_ID,
  APO_RUN_VERSION,
  APO_RUN_TAGS,
  APO_COST,
  OBSERVATION_TYPES,
  SCORE_DATA_TYPES,
  SCORE_SOURCES,
} from "../src/semconv.ts";

describe("apo.* semantic conventions", () => {
  describe("attribute keys", () => {
    it("exports observation type attribute", () => {
      expect(APO_OBSERVATION_TYPE).toBe("apo.observation.type");
    });

    it("exports run identity attributes", () => {
      expect(APO_RUN_ID).toBe("apo.run.id");
      expect(APO_RUN_FLOW_NAME).toBe("apo.run.flow_name");
      expect(APO_RUN_TASK_ID).toBe("apo.run.task_id");
      expect(APO_RUN_VERSION).toBe("apo.run.version");
      expect(APO_RUN_TAGS).toBe("apo.run.tags");
    });

    it("exports cost attribute", () => {
      expect(APO_COST).toBe("apo.cost");
    });
  });

  describe("enumeration values", () => {
    it("exports all observation types", () => {
      expect(OBSERVATION_TYPES).toContain("GENERATION");
      expect(OBSERVATION_TYPES).toContain("TOOL");
      expect(OBSERVATION_TYPES).toContain("CHAIN");
      expect(OBSERVATION_TYPES).toContain("AGENT");
      expect(OBSERVATION_TYPES).toContain("RETRIEVER");
      expect(OBSERVATION_TYPES).toContain("EVALUATOR");
      expect(OBSERVATION_TYPES).toContain("EMBEDDING");
      expect(OBSERVATION_TYPES).toContain("GUARDRAIL");
      expect(OBSERVATION_TYPES).toContain("SPAN");
      expect(OBSERVATION_TYPES.length).toBe(9);
    });

    it("exports score data types", () => {
      expect(SCORE_DATA_TYPES).toEqual(["NUMERIC", "CATEGORICAL", "BOOLEAN"]);
    });

    it("exports score sources", () => {
      expect(SCORE_SOURCES).toEqual(["API", "EVAL", "ANNOTATION"]);
    });
  });
});
