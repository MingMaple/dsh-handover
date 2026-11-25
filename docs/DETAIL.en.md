# Plugin details

For readers evaluating this plugin, the workflow is complete. Under pressure, the context is compacted with key points kept. A heavy task gets a plan before execution. A task or a whole project can also be handed to a session outside DeepSeek Harness (DSH). The plugin also provides a file system reference, plus snapshot, backup and migration tools.

## Tasks

- A light task runs directly, with no plan and no verification pass.
- A heavy task gets a plan first; its depth follows the weight of the task.
- A larger task is split across subagents; the assistant only coordinates and closes it out.
- The next stage on the same set of files goes back to whoever handled them.

## Context

- When the context comes under pressure, the assistant decides on its own whether to compact or to rotate.
- Before compacting, the assistant brings the task to a sensible stopping point, then settles the goal, the plan, the next step and the pitfalls.
- At the hard line the plugin performs the compaction itself.
- Rotation rewrites the handover document, and the successor session continues from it.

## File system

- A file system reference for each project: the plan lives at the task root, and each batch leaves a ledger inside the task.
- Handover documents are filed by scope (global, project, misc); rotation archives the old one, writes the new one and checks its structure in one step.
- Snapshots and backups: a library snapshot comes with a manifest and can be checked item by item; migration has packing and restore.
- Archive and cleanup: handovers, plans and snapshots sit in agreed directories; old backups and deleted items are cleaned up only after confirmation.

## Assignment

- A task or a whole project can be handed to a session outside DeepSeek Harness (DSH).
- The handover rules go into the prompt given to it; the return procedure applies when it hands the work back.
- During a temporary assignment the handover and the office register stay as they were.

## Limits

- The plugin changes no model capability and replaces no host tool.
- Rotation requires the user's authorization; deletion requires the user's confirmation.
