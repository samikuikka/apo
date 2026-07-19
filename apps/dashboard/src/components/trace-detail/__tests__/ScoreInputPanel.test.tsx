import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ScoreInputPanel } from "../ScoreInputPanel";

vi.mock("@/lib/config", () => ({
  getProjectId: () => "test-project",
}));

vi.mock("@/lib/scores-api", () => ({
  getScoreConfigs: vi.fn(),
  createTraceScore: vi.fn(),
  createObservationScore: vi.fn(),
}));

import {
  getScoreConfigs,
  createTraceScore,
  createObservationScore,
} from "@/lib/scores-api";

const mockedGetScoreConfigs = vi.mocked(getScoreConfigs);
const mockedCreateTraceScore = vi.mocked(createTraceScore);
const mockedCreateObservationScore = vi.mocked(createObservationScore);

const numericConfig = {
  id: 1,
  name: "Correctness",
  data_type: "NUMERIC" as const,
  min_value: 0,
  max_value: 1,
  categories: null,
  description: "How correct is the output?",
};

const booleanConfig = {
  id: 2,
  name: "Helpful",
  data_type: "BOOLEAN" as const,
  min_value: null,
  max_value: null,
  categories: null,
  description: null,
};

const categoricalConfig = {
  id: 3,
  name: "Sentiment",
  data_type: "CATEGORICAL" as const,
  min_value: null,
  max_value: null,
  categories: { positive: 1, neutral: 0.5, negative: 0 },
  description: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScoreInputPanel", () => {
  it("shows loading state", () => {
    mockedGetScoreConfigs.mockReturnValue(new Promise(() => {}));
    render(
      <ScoreInputPanel targetType="trace" targetId="trace-1" />,
    );
    expect(screen.getByText("Loading score configs...")).toBeInTheDocument();
  });

  it("shows empty state when no configs", async () => {
    mockedGetScoreConfigs.mockResolvedValueOnce([]);
    render(
      <ScoreInputPanel targetType="trace" targetId="trace-1" />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("No score configs available. Create a score config first to enable scoring."),
      ).toBeInTheDocument();
    });
  });

  it("renders all config types", async () => {
    mockedGetScoreConfigs.mockResolvedValueOnce([
      numericConfig,
      booleanConfig,
      categoricalConfig,
    ]);
    render(
      <ScoreInputPanel targetType="trace" targetId="trace-1" />,
    );
    await waitFor(() => {
      expect(screen.getByText("Correctness")).toBeInTheDocument();
      expect(screen.getByText("Helpful")).toBeInTheDocument();
      expect(screen.getByText("Sentiment")).toBeInTheDocument();
    });
  });

  it("renders existing score badges", async () => {
    mockedGetScoreConfigs.mockResolvedValueOnce([numericConfig]);
    render(
      <ScoreInputPanel
        targetType="trace"
        targetId="trace-1"
        existingScores={[
          {
            id: 10,
            trace_id: "trace-1",
            observation_id: null,
            name: "Correctness",
            value: 0.85,
            string_value: null,
            data_type: "NUMERIC",
            source: "ANNOTATION",
            config_id: 1,
            comment: null,
            created_at: "2026-01-01",
          },
        ]}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Correctness").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("0.85").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("submits boolean score on click", async () => {
    const user = userEvent.setup();
    const onScoreCreated = vi.fn();
    mockedGetScoreConfigs.mockResolvedValueOnce([booleanConfig]);
    mockedCreateTraceScore.mockResolvedValueOnce({
      id: 1,
      trace_id: "trace-1",
      observation_id: null,
      name: "Helpful",
      value: true,
      string_value: null,
      data_type: "BOOLEAN",
      source: "ANNOTATION",
      config_id: 2,
      comment: null,
      created_at: "2026-01-01",
    });

    render(
      <ScoreInputPanel
        targetType="trace"
        targetId="trace-1"
        onScoreCreated={onScoreCreated}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Helpful")).toBeInTheDocument();
    });

    const thumbsUp = screen.getByLabelText("Score Helpful thumbs up");
    await user.click(thumbsUp);

    expect(mockedCreateTraceScore).toHaveBeenCalledWith(
      "trace-1",
      expect.objectContaining({
        name: "Helpful",
        value: true,
        data_type: "BOOLEAN",
        source: "ANNOTATION",
        config_id: 2,
      }),
    );
    expect(onScoreCreated).toHaveBeenCalled();
  });

  it("submits observation score via correct endpoint", async () => {
    const user = userEvent.setup();
    mockedGetScoreConfigs.mockResolvedValueOnce([booleanConfig]);
    mockedCreateObservationScore.mockResolvedValueOnce({
      id: 2,
      trace_id: null,
      observation_id: "obs-1",
      name: "Helpful",
      value: false,
      string_value: null,
      data_type: "BOOLEAN",
      source: "ANNOTATION",
      config_id: 2,
      comment: null,
      created_at: "2026-01-01",
    });

    render(
      <ScoreInputPanel targetType="observation" targetId="obs-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Helpful")).toBeInTheDocument();
    });

    const thumbsDown = screen.getByLabelText("Score Helpful thumbs down");
    await user.click(thumbsDown);

    expect(mockedCreateObservationScore).toHaveBeenCalledWith(
      "obs-1",
      expect.objectContaining({ value: false }),
    );
  });

  it("submits numeric score", async () => {
    const user = userEvent.setup();
    mockedGetScoreConfigs.mockResolvedValueOnce([numericConfig]);
    mockedCreateTraceScore.mockResolvedValueOnce({
      id: 3,
      trace_id: "trace-1",
      observation_id: null,
      name: "Correctness",
      value: 0.5,
      string_value: null,
      data_type: "NUMERIC",
      source: "ANNOTATION",
      config_id: 1,
      comment: null,
      created_at: "2026-01-01",
    });

    render(
      <ScoreInputPanel targetType="trace" targetId="trace-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Correctness")).toBeInTheDocument();
    });

    const submitBtn = screen.getByText("Submit score");
    await user.click(submitBtn);

    expect(mockedCreateTraceScore).toHaveBeenCalledWith(
      "trace-1",
      expect.objectContaining({
        name: "Correctness",
        data_type: "NUMERIC",
        source: "ANNOTATION",
        config_id: 1,
      }),
    );
  });

  it("submits categorical score", async () => {
    const user = userEvent.setup();
    mockedGetScoreConfigs.mockResolvedValueOnce([categoricalConfig]);
    mockedCreateTraceScore.mockResolvedValueOnce({
      id: 4,
      trace_id: "trace-1",
      observation_id: null,
      name: "Sentiment",
      value: 1,
      string_value: null,
      data_type: "CATEGORICAL",
      source: "ANNOTATION",
      config_id: 3,
      comment: null,
      created_at: "2026-01-01",
    });

    render(
      <ScoreInputPanel targetType="trace" targetId="trace-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Sentiment")).toBeInTheDocument();
    });

    const positiveBtn = screen.getByText("positive");
    await user.click(positiveBtn);

    const submitBtn = screen.getByText("Submit score");
    await user.click(submitBtn);

    expect(mockedCreateTraceScore).toHaveBeenCalledWith(
      "trace-1",
      expect.objectContaining({
        name: "Sentiment",
        value: 1,
        data_type: "CATEGORICAL",
        config_id: 3,
      }),
    );
  });

  it("disables categorical submit when nothing selected", async () => {
    mockedGetScoreConfigs.mockResolvedValueOnce([categoricalConfig]);

    render(
      <ScoreInputPanel targetType="trace" targetId="trace-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Sentiment")).toBeInTheDocument();
    });

    const submitBtn = screen.getByText("Submit score");
    expect(submitBtn).toBeDisabled();
  });

  it("updates existing score label", async () => {
    mockedGetScoreConfigs.mockResolvedValueOnce([numericConfig]);

    render(
      <ScoreInputPanel
        targetType="trace"
        targetId="trace-1"
        existingScores={[
          {
            id: 10,
            trace_id: "trace-1",
            observation_id: null,
            name: "Correctness",
            value: 0.5,
            string_value: null,
            data_type: "NUMERIC",
            source: "ANNOTATION",
            config_id: 1,
            comment: null,
            created_at: "2026-01-01",
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Update score")).toBeInTheDocument();
    });
  });
});
