# Trace Projection storage uses surrogate identity

**Status: Accepted.** OTel trace and span IDs remain the public identifiers for
Traces and Spans, but Trace Projection rows use surrogate primary keys and are
unique by `(Project, trace_id)` or `(Project, span_id)`. Every dependent write
and lookup must carry the Project or an internal surrogate reference. This lets
independent tenants export identical valid OTel IDs without changing the OTLP
contract or exposing storage identifiers through APIs.

## Considered Options

- Composite primary keys were rejected because they would spread Project
  columns through existing foreign keys and ORM identity handling.
- Globally unique public OTel IDs were rejected because tenant isolation cannot
  depend on probabilistic uniqueness or well-behaved instrumentation.
- Project-derived public IDs were rejected because they would break OTel ID
  fidelity and parent/link compatibility.

## Consequences

- A trace or span ID alone is never a storage lookup key across Projects.
- Metrics, scores, comments, and compatibility views that depend on projected
  rows must use Project scope or an internal surrogate reference too.
- Existing public routes can keep returning original OTel IDs.
