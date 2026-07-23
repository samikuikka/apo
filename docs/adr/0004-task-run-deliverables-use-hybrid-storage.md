# Task Run Deliverables use hybrid storage

**Status: Proposed.** apo will keep Deliverable identity, metadata, and small
JSON values in its relational database while storing large JSON bodies and
Artifact bytes through a replaceable artifact-store boundary. The default
artifact store is a directory under apo's existing persistent data volume; an
S3-compatible store is optional, never a required self-hosting service. Task
conversation content remains canonical in the Task Run's OpenTelemetry Trace,
so new runs do not persist a second full `transcript_json` copy.

## Considered Options

- Keep complete transcripts and deliverables on `agent_task_runs`: rejected
  because unrelated queries can materialize multi-megabyte columns, this has
  already caused a production OOM, and arbitrary files do not belong in JSON.
- Put every value in object storage: rejected because small structured
  Deliverables benefit from transactional database storage and requiring a
  second service would violate apo's simple single-node self-hosting contract.
- Require MinIO and copy Langfuse's Redis, ClickHouse, and S3 topology: rejected
  because that topology serves Langfuse's ingestion volume and analytics
  workload, while apo currently supports one backend node and one relational
  database.
- Store a separate durable Task Transcript: rejected because the Trace already
  owns the full conversation under the Project's content policy and the
  dashboard already derives Conversation History from that Trace.

## Consequences

- A Deliverable manifest is always database-readable without loading its body.
- Storage placement (`inline` or `object`) is internal and does not change
  whether a Deliverable is a JSON value or an Artifact.
- Local self-hosting gains one directory inside the existing persistent volume,
  not a required MinIO container.
- Task Run retention, backup, restore, and deletion must cover both database
  rows and artifact-store objects.
- Legacy `transcript_json` and `deliverables_json` rows remain readable during a
  compatibility window, but new writers use the new contract.
