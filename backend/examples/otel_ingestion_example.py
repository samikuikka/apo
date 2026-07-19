"""Example: Send OTLP/JSON traces to the apo backend.

Demonstrates how to send standard OTLP trace data that would be
produced by Vercel AI SDK's built-in OTel telemetry or any
OTel-instrumented application.
"""

import requests

BASE_URL = "http://localhost:8000"


def send_genai_trace():
    """Send a GenAI semantic convention trace."""
    response = requests.post(
        f"{BASE_URL}/api/public/otel/v1/traces",
        json={
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": "a1b2c3d4e5f6a1b2" * 2,
                                    "spanId": "b1c2d3e4f5a1b1" * 1 + "b1",
                                    "name": "ai.generateText",
                                    "startTime": "2026-06-01T12:00:00.000000Z",
                                    "endTime": "2026-06-01T12:00:02.500000Z",
                                    "attributes": [
                                        {
                                            "key": "gen_ai.request.model",
                                            "value": {"stringValue": "gpt-4o"},
                                        },
                                        {
                                            "key": "gen_ai.usage.input_tokens",
                                            "value": {"intValue": "20"},
                                        },
                                        {
                                            "key": "gen_ai.usage.output_tokens",
                                            "value": {"intValue": "50"},
                                        },
                                        {
                                            "key": "deployment.environment",
                                            "value": {"stringValue": "production"},
                                        },
                                        {
                                            "key": "service.namespace",
                                            "value": {"stringValue": "my-app"},
                                        },
                                    ],
                                }
                            ]
                        }
                    ]
                }
            ]
        },
    )
    print(f"GenAI trace: {response.status_code} -> {response.json()}")


def send_vercel_ai_sdk_trace():
    """Send a Vercel AI SDK style trace."""
    response = requests.post(
        f"{BASE_URL}/api/public/otel/v1/traces",
        json={
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": "vercel_trace_001" + "x" * 12,
                                    "spanId": "vercel_span_001" + "x" * 8,
                                    "name": "ai.generateText",
                                    "attributes": [
                                        {
                                            "key": "ai.model.id",
                                            "value": {"stringValue": "claude-3.5-sonnet"},
                                        },
                                        {
                                            "key": "ai.usage.promptTokens",
                                            "value": {"intValue": "150"},
                                        },
                                    ],
                                }
                            ]
                        }
                    ]
                }
            ]
        },
    )
    print(f"Vercel trace: {response.status_code} -> {response.json()}")


def send_tool_call_trace():
    """Send a trace with tool call spans."""
    trace_id = "tool_call_trace" + "x" * 8
    parent_id = "parent_span_" + "x" * 7
    child_id = "child_tool_sp" + "x" * 7

    response = requests.post(
        f"{BASE_URL}/api/public/otel/v1/traces",
        json={
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": trace_id,
                                    "spanId": parent_id,
                                    "name": "ai.generateText",
                                    "attributes": [
                                        {
                                            "key": "gen_ai.request.model",
                                            "value": {"stringValue": "gpt-4o"},
                                        },
                                    ],
                                },
                                {
                                    "traceId": trace_id,
                                    "spanId": child_id,
                                    "parentSpanId": parent_id,
                                    "name": "tool execution",
                                    "attributes": [
                                        {
                                            "key": "gen_ai.tool.name",
                                            "value": {"stringValue": "web_search"},
                                        },
                                    ],
                                },
                            ]
                        }
                    ]
                }
            ]
        },
    )
    print(f"Tool trace: {response.status_code} -> {response.json()}")


def send_custom_attributes():
    """Send a trace with apo.* custom attributes."""
    response = requests.post(
        f"{BASE_URL}/api/public/otel/v1/traces",
        json={
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {
                            "spans": [
                                {
                                    "traceId": "custom_trace_01" + "x" * 10,
                                    "spanId": "custom_span_01" + "x" * 8,
                                    "name": "my workflow step",
                                    "attributes": [
                                        {
                                            "key": "apo.observation.type",
                                            "value": {"stringValue": "CHAIN"},
                                        },
                                        {
                                            "key": "apo.custom_field",
                                            "value": {"stringValue": "custom value"},
                                        },
                                    ],
                                }
                            ]
                        }
                    ]
                }
            ]
        },
    )
    print(f"Custom trace: {response.status_code} -> {response.json()}")


if __name__ == "__main__":
    print("Sending OTLP traces to apo backend...\n")
    send_genai_trace()
    send_vercel_ai_sdk_trace()
    send_tool_call_trace()
    send_custom_attributes()
    print("\nCheck http://localhost:3000 to see the traces in the dashboard.")
