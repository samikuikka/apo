#!/usr/bin/env python3
"""Regenerate the campaign report from campaign-sessions/*.json.

Sessions may span projects (each batch ran with its own token); gold and
question/expected lookups try every configured credential until one can see
the run. Credentials: ~/.apo/credentials first, then any APO_CAMPAIGN_KEY
(additional keys, comma-separated in APO_CAMPAIGN_EXTRA_KEYS).
"""
import glob
import json
import os
import re
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))


def load_creds():
    creds = [json.load(open(os.path.expanduser("~/.apo/credentials")))]
    extra = os.environ.get("APO_CAMPAIGN_EXTRA_KEYS", "")
    for key in [k.strip() for k in extra.split(",") if k.strip()]:
        creds.append({"backend_url": creds[0]["backend_url"], "api_key": key})
    return creds


CREDENTIALS = load_creds()


def api_any(path):
    """Try the path with each credential; raise the last error if all fail."""
    last = None
    for c in CREDENTIALS:
        try:
            req = urllib.request.Request(
                c["backend_url"] + path, headers={"Authorization": "Bearer " + c["api_key"]})
            return json.load(urllib.request.urlopen(req))
        except Exception as e:  # noqa: BLE001 - try next credential
            last = e
    raise last


def gold_from_checks(checks, corrected):
    # Two eval generations: newer runs call it "answer-matches-benchmark",
    # older (bind project) revisions "<task>-upstream-answer" — same
    # deterministic benchmark comparison either way.
    gold = next(
        (c for c in checks if "answer-matches-benchmark" in str(c.get("id", ""))),
        None,
    ) or next(
        (c for c in checks if str(c.get("id", "")).endswith("-upstream-answer")),
        None,
    )
    if gold is None:
        return {"ok": False}
    a0 = (gold.get("assertions") or [{}])[0]
    expected = str(a0.get("expected") or "")
    m = re.search(r'ground truth "(.*?)"', expected)
    return {
        "ok": True,
        "pass": gold.get("pass") is True,
        "corrected": bool(corrected),
        "expected": m.group(1) if m else expected[:40],
        "received": str(a0.get("received"))[:40],
    }


def question_for_task(task_id):
    # task_id -> question text, cached on disk (definition-source per run).
    return None  # questions resolved per-run below


golds, questions = {}, {}
for f in sorted(glob.glob(os.path.join(HERE, "campaign-sessions", "*.json"))):
    d = json.load(open(f))
    rid = "_".join(os.path.basename(f).split("_")[:2])
    if rid not in golds:
        try:
            det = api_any(f"/v1/agent-task-runs/{rid}")
            checks = det.get("checks_json")
            if isinstance(checks, str):
                checks = json.loads(checks)
            golds[rid] = gold_from_checks(checks or [], det.get("corrected_tests"))
            src = api_any(f"/v1/agent-task-runs/{rid}/definition-source")
            ev = next((x for x in (src.get("files") or []) if x["path"].endswith(".eval.ts")), None)
            m = re.search(r'description: "(.*?)"', ev["content"]) if ev else None
            questions[rid] = m.group(1) if m else det.get("task_id", "?")
        except Exception as e:  # noqa: BLE001 - run may be unreachable; mark gold missing
            golds[rid] = {"ok": False, "error": str(e)}
            questions[rid] = "?"

results = []
for f in sorted(glob.glob(os.path.join(HERE, "campaign-sessions", "*.json"))):
    d = json.load(open(f))
    # Session files are named <run_id>_<judge>_<model>_s<sample>.json; the
    # JSON body itself carries judge/model/outcome but not the run id. Run
    # ids are themselves "run_<hex>", so the id is the first two parts.
    d["run_id"] = "_".join(os.path.basename(f).split("_")[:2])
    results.append(d)

arms = sorted({(x["judge"], x["model"]) for x in results})


def confusion(rows):
    m = dict(both_pass=0, false_pass=0, false_fail=0, both_fail=0, unknown=0)
    for x in rows:
        g = golds.get(x["run_id"], {"ok": False})
        if not g.get("ok") or x["outcome"] != "verdict":
            m["unknown"] += 1
            continue
        if g["pass"] and x["pass"]:
            m["both_pass"] += 1
        elif not g["pass"] and x["pass"]:
            m["false_pass"] += 1
        elif not g["pass"] and not x["pass"]:
            m["both_fail"] += 1
        else:
            m["false_fail"] += 1
    decided = m["both_pass"] + m["false_pass"] + m["both_fail"] + m["false_fail"]
    m["agreement"] = (m["both_pass"] + m["both_fail"]) / decided if decided else None
    return m


def med(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def p95(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, (len(xs) * 95 + 99) // 100 - 1))] if xs else None


def pct(x):
    return "—" if x is None else f"{x * 100:.1f}%"


report = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "samples": 1,
    "runs": len(golds),
    "gold_summary": {
        "fail": sum(1 for g in golds.values() if g.get("ok") and not g["pass"]),
        "pass": sum(1 for g in golds.values() if g.get("ok") and g["pass"]),
        "missing": sum(1 for g in golds.values() if not g.get("ok")),
    },
    "arms": {},
}
md = (
    f"# Judge campaign report\n\n"
    f"Generated {report['generated_at']} · {len(golds)} gold runs · 1 sample per arm.\n\n"
    "Gold: recorded deterministic `answer-matches-benchmark` check. Agentic arm = the real SDK "
    "`runAgentSession` (productized t.agent) with the full evidence plane (all deliverables + frozen "
    "history incl. prior runs and human corrections). Single-shot arm sees task description + the "
    "answer deliverable only — exactly what a `t.judge` author stages today. Rubric: the validated "
    "demo family (\"does the answer respond to the question the task actually asked\").\n\n"
)

for judge, model in arms:
    rows = [x for x in results if x["judge"] == judge and x["model"] == model]
    m = confusion(rows)
    costs = [x["cost_usd"] for x in rows if isinstance(x.get("cost_usd"), (int, float))]
    lats = [x["latency_ms"] for x in rows if isinstance(x.get("latency_ms"), (int, float))]
    steps = [x["steps"] for x in rows if isinstance(x.get("steps"), (int, float))]
    hist = sum(1 for x in rows if x.get("used_history_tools"))
    arm = {
        "n": len(rows), **m,
        "cost": {"total": sum(costs), "p50": med(costs), "p95": p95(costs)},
        "latency_ms": {"p50": med(lats), "p95": p95(lats)},
        "steps": {"p50": med(steps), "max": max(steps) if steps else 0},
        "used_history_tools": hist,
    }
    report["arms"][f"{judge}|{model}"] = arm
    md += (
        f"## {judge} · {model}\n\n"
        "| agreement | false-PASS | false-FAIL | both-pass | both-fail | no-verdict/unknown | cost p50/p95 | latency p50/p95 | steps p50/max | used history |\n"
        "|---|---|---|---|---|---|---|---|---|---|\n"
        f"| {pct(m['agreement'])} | {m['false_pass']} | {m['false_fail']} | {m['both_pass']} | {m['both_fail']} | {m['unknown']} "
        f"| ${med(costs) or 0:.4f}/${p95(costs) or 0:.4f} "
        f"| {(med(lats) or 0) / 1000:.0f}s/{(p95(lats) or 0) / 1000:.0f}s "
        f"| {med(steps) if steps else '—'}/{max(steps) if steps else 0} "
        f"| {f'{hist}/{len(rows)}' if judge == 'agent' else 'n/a'} |\n\n"
    )

FAIR = "deepseek/deepseek-v4.1-flash"
s = report["arms"].get(f"single|{FAIR}")
a = report["arms"].get(f"agent|{FAIR}")
if s and a:
    gates = {
        "overall_agentic_ge_single": a["agreement"] >= s["agreement"],
        "false_pass_strictly_lower": a["false_pass"] < s["false_pass"],
        "gold_agreement_85pct": a["agreement"] is not None and a["agreement"] >= 0.85,
    }
    report["decision_gates"] = gates
    md += (
        f"## Decision gates (fair pair on {FAIR})\n\n"
        f"- agentic agreement ≥ single-shot: **{'PASS' if gates['overall_agentic_ge_single'] else 'FAIL'}** ({pct(a['agreement'])} vs {pct(s['agreement'])})\n"
        f"- false-PASS strictly lower: **{'PASS' if gates['false_pass_strictly_lower'] else 'FAIL'}** ({a['false_pass']} vs {s['false_pass']})\n"
        f"- gold agreement ≥ 85%: **{'PASS' if gates['gold_agreement_85pct'] else 'FAIL'}** ({pct(a['agreement'])})\n"
    )

open(os.path.join(HERE, "campaign-report.json"), "w").write(json.dumps(report, indent=2))
open(os.path.join(HERE, "CAMPAIGN.md"), "w").write(md)
print(md)
print("gold:", report["gold_summary"])
print("gates:", report.get("decision_gates"))
