#!/usr/bin/env python3
# pyright: reportAny=false, reportUnusedCallResult=false

"""Generate mock runs data for testing and development.

This script creates realistic mock data for runs and calls, then
ingests them into the backend via the ingestion API.

Usage:
    python scripts/generate_mock_runs.py           # Use cached data if available
    python scripts/generate_mock_runs.py --regenerate  # Force regeneration
    python scripts/generate_mock_runs.py --runs 50  # Generate 50 runs
"""

import asyncio
import random
import uuid
import argparse
from pathlib import Path
from datetime import datetime, timedelta, timezone
import httpx
import json

# Configuration
BACKEND_URL = "http://localhost:8000"
PROJECT = "example-service"
FLOW_NAME = "joke-flow"
NUM_RUNS = 30
DELAY_BETWEEN_RUNS = 0.5  # Seconds to wait between each run ingestion to avoid rate limiting
CACHE_FILE = Path(__file__).parent.parent / "data" / "mock_runs_cache.json"

# Mock data templates
TOPICS = [
    "programming", "cats", "coffee", "space exploration",
    "AI", "startup life", "photography", "cooking",
    "gardening", "music", "travel", "books",
]

MODELS = [
    "gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307", "llama-3.1-70b",
]

OUTPUT_TEMPLATES = [
    "Why did the {topic} enthusiast cross the road? To get to the better implementation on the other side! 🎯",
    "I asked my computer to tell me a joke about {topic}. It said: '404: Humor not found.' But then it processed a funny one about debugging and coffee! ☕💻",
    "Here's a joke about {topic}: Why do programmers prefer dark mode? Because light attracts bugs! 🐛😂",
    "The best thing about {topic}? It's like a good commit message - clear, concise, and makes everyone smile! 😄",
    "Want to hear a joke about {topic}? It's a bit like AI training data - you'll need a lot of iterations to get it right! 🤖",
]

ENVIRONMENTS = ["production", "staging", "development"]
STATUSES = ["success", "success", "success", "success", "error"]  # Weighted towards success


def generate_mock_run_data(run_idx: int) -> list[dict[str, object]]:
    """Generate mock data for a single run with calls."""
    run_id = str(uuid.uuid4())
    topic = random.choice(TOPICS)
    model = random.choice(MODELS)
    environment = random.choice(ENVIRONMENTS)
    status = random.choice(STATUSES)
    num_calls = random.randint(1, 3)

    created_at = datetime.now(timezone.utc) - timedelta(
        hours=random.randint(0, 72),
        minutes=random.randint(0, 59)
    )

    # Generate run
    run_timestamp = datetime.now(timezone.utc).isoformat()
    events: list[dict[str, object]] = [{
        "id": str(uuid.uuid4()),
        "timestamp": run_timestamp,
        "type": "run-create",
        "body": {
            "id": run_id,
            "project": PROJECT,
            "flow_name": FLOW_NAME,
            "task_id": f"task-{run_idx}",
            "version": "1.0.0",
            "user_id": f"user-{random.randint(1, 5)}",
            "environment": environment,
            "external_id": f"external-{run_idx}",
            "tags": ["mock", "generated", environment],
            "run_metadata": {
                "source": "mock_generator",
                "test_data": True,
            },
        },
    }]

    # Generate calls for this run
    for call_idx in range(num_calls):
        call_id = str(uuid.uuid4())
        prompt_tokens = random.randint(50, 200)
        completion_tokens = random.randint(30, 150)
        latency_ms = random.randint(500, 3000)

        call_created_at = created_at + timedelta(milliseconds=call_idx * 100)
        completion_start = call_created_at + timedelta(milliseconds=100)
        end_time = completion_start + timedelta(milliseconds=latency_ms)

        input_data = {
            "topic": topic,
            "style": random.choice(["funny", "witty", "dry", "pun"]),
            "length": random.choice(["short", "medium", "long"]),
        }

        if status == "error":
            output_data = {
                "error": "Failed to generate joke",
                "error_type": "RateLimitError",
            }
            status_message = "ERROR"
        else:
            output_data = {
                "joke": random.choice(OUTPUT_TEMPLATES).format(topic=topic),
                "topic": topic,
            }
            status_message = "SUCCESS"

        events.append({
            "id": str(uuid.uuid4()),
            "timestamp": call_created_at.isoformat(),
            "type": "call-create",
            "body": {
                "id": call_id,
                "project": PROJECT,
                "run_id": run_id,
                "flow_name": FLOW_NAME,
                "task_id": f"task-{run_idx}",
                "step_name": "generate-joke",
                "step_index": call_idx,
                "model": model,
                "observation_type": "GENERATION",
                "level": "DEFAULT",
                "created_at": call_created_at.isoformat(),
                "completion_start_time": completion_start.isoformat(),
                "end_time": end_time.isoformat(),
                "latency_ms": latency_ms,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "cost": round((prompt_tokens / 1000) * 0.00015 + (completion_tokens / 1000) * 0.0006, 6),
                "status_message": status_message,
                "environment": environment,
                "tags": [f"call-{call_idx}", "generation"],
                "input": input_data,
                "output": output_data,
                "messages": [
                    {"role": "user", "content": json.dumps(input_data)},
                    {"role": "assistant", "content": json.dumps(output_data)},
                ],
            },
        })

    return events


async def ingest_batch(
    events: list[dict[str, object]], client: httpx.AsyncClient
) -> bool:
    """Ingest a batch of events to the backend."""
    try:
        response = await client.post(
            f"{BACKEND_URL}/api/v1/ingestion",
            json={"batch": events},
            timeout=30.0
        )
        response.raise_for_status()
        result = response.json()
        print(f"  ✓ Processed {result['processed']} events")
        if result.get("errors"):
            print(f"    Errors: {result['errors']}")
        return True
    except Exception as e:
        print(f"  ✗ Failed to ingest batch: {e}")
        return False


def save_to_cache(all_runs: list[list[dict[str, object]]]) -> None:
    """Save generated runs to cache file."""
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_FILE, "w") as f:
        json.dump(all_runs, f, indent=2)
    print(f"💾 Saved {len(all_runs)} runs to cache: {CACHE_FILE}")


def load_from_cache() -> list[list[dict[str, object]]] | None:
    """Load runs from cache file if it exists."""
    if not CACHE_FILE.exists():
        return None
    with open(CACHE_FILE) as f:
        return json.load(f)


def generate_all_runs(num_runs: int) -> list[list[dict[str, object]]]:
    """Generate all mock runs data."""
    return [generate_mock_run_data(i) for i in range(num_runs)]


async def main():
    """Generate and ingest mock runs."""
    parser = argparse.ArgumentParser(description="Generate mock runs data")
    parser.add_argument("--runs", type=int, default=NUM_RUNS, help="Number of runs to generate")
    parser.add_argument("--regenerate", action="store_true", help="Force regeneration, ignore cache")
    parser.add_argument("--cache-only", action="store_true", help="Only generate cache, don't ingest")
    args = parser.parse_args()

    num_runs = args.runs

    # Check cache first
    if not args.regenerate:
        cached = load_from_cache()
        if cached is not None:
            print(f"📦 Found {len(cached)} cached runs in {CACHE_FILE}")
            use_cache = input("Use cached data? (Y/n): ").strip().lower()
            if use_cache != "n":
                all_runs = cached[:num_runs]  # Limit to requested number
                print(f"✅ Using {len(all_runs)} cached runs")
            else:
                print("🔄 Regenerating...")
                all_runs = generate_all_runs(num_runs)
                save_to_cache(all_runs)
        else:
            print("📭 No cache found, generating new data...")
            all_runs = generate_all_runs(num_runs)
            save_to_cache(all_runs)
    else:
        print("🔄 Regenerating data...")
        all_runs = generate_all_runs(num_runs)
        save_to_cache(all_runs)

    if args.cache_only:
        print(f"✅ Cache updated with {len(all_runs)} runs")
        return

    print(f"🎯 Ingesting {len(all_runs)} mock runs for {PROJECT}/{FLOW_NAME}")
    print(f"📡 Target: {BACKEND_URL}")
    print()

    async with httpx.AsyncClient() as client:
        # Check if backend is running
        try:
            await client.get(f"{BACKEND_URL}/api/health", timeout=5.0)
            print("✓ Backend is running")
        except Exception as e:
            print(f"✗ Backend is not accessible: {e}")
            print("  Please start the backend first:")
            print("  cd backend && python -m uvicorn apo.main:app --reload")
            return

        print()

        # Ingest runs
        success_count = 0
        for i, events in enumerate(all_runs):
            print(f"[{i+1}/{len(all_runs)}] Ingesting run with {len(events)} events...")
            if await ingest_batch(events, client):
                success_count += 1

            # Add delay between runs to avoid rate limiting
            if i < len(all_runs) - 1:  # Don't sleep after the last run
                await asyncio.sleep(DELAY_BETWEEN_RUNS)

        print()
        print(f"✅ Successfully ingested {success_count}/{len(all_runs)} runs")
        print()
        print("📊 View your runs at:")
        print("   http://localhost:3002/runs")


if __name__ == "__main__":
    asyncio.run(main())
