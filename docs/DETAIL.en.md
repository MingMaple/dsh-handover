# Plugin details

A complete workflow: when the context is under pressure it is compacted with its key points kept, and a heavy task gets a plan before execution. A task or a whole project can also be handed to a session outside DeepSeek Harness (DSH). The plugin also provides a file system reference, plus snapshot, backup and migration tools.

## Context

- At 35% and 50% of the window the assistant writes down the goal, the settled plan, the next step and the pitfalls (a capsule), then compacts the context.
- At the hard line the plugin performs the compaction itself.
- Rotation rewrites the handover document: archive the old one, write the new body, and the successor session continues.

## Tasks

- A heavy task, or one touching several files, gets a plan before execution.
- Plan, handover and ledger are stored with the task; a successor reads them by path.

## Assignment

- A task or a whole project can be handed to a session outside DeepSeek Harness (DSH); the rules go into the prompt given to it.
- When the outside session hands the work back, the return procedure applies; the handover and the office register stay as they were.

## Limits

- The plugin changes no model capability and replaces no host tool.
- Rotation requires the user's authorization; deletion requires the user's confirmation.
