# Tasks Overview Prototype

## Question

How should the main Tasks page show one trustworthy current state while still
making history, model experiments, execution revisions, and Task Definition
changes discoverable across the whole Project?

## Variants

- `modes`: Overview, Trends, and Breakdown are explicit page modes.
- `rows`: every Task row shows baseline, history, and model evidence together.
- `lens`: a persistent analysis sidebar changes the table's comparison axis.

## Verdict

`modes` is the leading page structure: current Overview, boundary-aware Trends,
and controlled Breakdown. The prototype has not answered how apo defines the
“current trustworthy state.” Its hardcoded Project-wide definition, execution,
and model scope is an assumption that the next exploration must challenge,
especially for mixed-model Projects. See `HANDOFF.md`.

This fixture-backed code is disposable and must not be promoted directly into
production.
