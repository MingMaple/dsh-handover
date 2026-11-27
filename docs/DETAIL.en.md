# Plugin details

This page gives readers an overview of what the plugin does. Context is compacted with key points kept when it comes under pressure. A heavy task gets a plan before execution. A task or project can be handed to a session outside DeepSeek Harness (DSH). The plugin also provides a file system reference. It also covers snapshot, backup and migration tools.

## Tasks

- A light task runs directly, with no plan and no verification pass.
- A heavy task gets a plan first; its depth follows the weight of the task.
- A larger task is split across subagents. The assistant only coordinates and closes it out.
- The next stage on the same set of files goes back to whoever handled them.

## Context

- Under context pressure, the assistant decides whether to compact or rotate.
- Before compacting, the assistant stops at a sensible point. It then settles the goal, plan, next step and pitfalls.
- At the hard line the plugin performs the compaction itself.
- Rotation rewrites the handover document. The successor session continues from it.

## File system

- Each project gets a file system reference. The plan lives at the task root. Each batch leaves a ledger inside the task.
- Handover documents are filed by scope: global, project or misc. Rotation archives the old file and writes the new one. It also checks the structure.
- A library snapshot comes with a manifest and can be checked item by item. Migration provides packing and restore.
- Handovers, plans and snapshots sit in agreed directories. Old backups and deleted items are removed only after confirmation.

## Assignment

- A task or a whole project can be handed to a session outside DeepSeek Harness (DSH).
- The handover rules go into the prompt given to it. The return procedure applies when it hands the work back.
- During a temporary assignment the handover and the office register stay as they were.

## Limits

- The plugin changes no model capability and replaces no host tool.
- Rotation requires the user's authorization; deletion requires the user's confirmation.
