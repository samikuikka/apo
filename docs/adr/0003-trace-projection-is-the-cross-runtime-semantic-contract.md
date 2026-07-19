# Trace Projection is the cross-runtime semantic contract

**Status: Proposed.** apo keeps separate Python and TypeScript projection
implementations because canonical server-side persistence and offline local
assertions have different runtime constraints, but both must produce the same
versioned `TraceProjectionSnapshot`. The Python model exports the normative JSON
Schema, TypeScript bindings are generated from it, and a shared corpus of raw
OTel trace graphs with expected snapshots enforces semantic parity. Backend-launched
runs evaluate the canonical backend snapshot after OTLP flush and projection;
offline runs use the conformant local projector. Per-language normalized-span
objects remain internal and are neither persisted nor exposed as another domain
model.

## Considered Options

- A backend-only projector was rejected because local agent-task assertions must
  work synchronously without a network or running apo service.
- Sending locally projected observations as canonical data was rejected because
  it would make apo-specific derived data authoritative and prevent replay when
  OTel conventions evolve.
- A shared Python/Node runtime, WASM normalizer, or fully data-driven rule engine
  was rejected because cross-runtime deployment complexity exceeds the value;
  graph rewriting and message extraction remain real code.
- Hand-mirrored types or schema-only validation were rejected because they do
  not detect semantic disagreement about classification, extraction, wrapper
  filtering, hierarchy, or evidence availability.

## Consequences

- Full-trace fixtures, not individual classifier examples, are the executable
  normalization contract.
- Required-persistence runs fail closed if their canonical projection cannot be
  read; they never silently evaluate a different local interpretation.
- Local and backend projectors may have different internal organization, but a
  behavior change is incomplete until both pass the shared fixture corpus.
- `TraceProjectionSnapshot.schemaVersion` changes only for transport shape;
  `projectionVersion` changes whenever normalization semantics change.
