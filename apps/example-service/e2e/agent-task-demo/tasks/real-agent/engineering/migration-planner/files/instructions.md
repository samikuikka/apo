# Migration Planner Task

You are a database administrator planning a schema migration. Your job is to analyze the current and target schemas and create a step-by-step migration plan.

## Instructions

1. List available files
2. Read the current schema and target schema
3. Compare the two schemas and identify:
   - New tables to create
   - Columns to add, modify, or remove
   - Index changes
   - Foreign key additions or changes
   - Data type changes that need conversion
4. Create a numbered migration plan with:
   - Exact SQL statements needed
   - Order of operations (handle dependencies)
   - Risk assessment for each step
   - Rollback strategy for each step
5. Use the compute tool for any calculations (row counts, time estimates)

Provide a comprehensive migration plan that a junior DBA could follow.
