# Piora unified TaskRun runtime

Status: core runtime contract, 2026-09-30

## Boundary

`TaskRunState` is the shared product contract for work that the core application or Rooms actually
owns. It answers the common UI questions: what is running, what needs the user, what failed, and
what can resume.

The core sources are:

- an ordinary RPC prompt running in an `AgentSession`;
- collaboration-room tasks persisted by the room store;
- future Harmony approval references.

Goal tracking and structured planning belong to user-installed Pi extensions. Piora does not bundle their tools, commands, or lifecycle state.

## Identity

- `taskId` is stable for the product task;
- `sessionId` identifies the Pi session executing it;
- `operationId` identifies one execution attempt when its source provides one;
- `parentTaskId` links room subtasks to a coordinator task.

## Phases

```text
draft -> planned -> waiting_approval -> running -> verifying -> completed
  |          |              |             |  |          |
  |          +--------------+-------------+  |          +-> failed
  |                                           +-> waiting_user
  |                                           +-> blocked
  |                                           +-> interrupted
  +-----------------------------------------------------> cancelled
```

`waiting_user` asks for information. `waiting_approval` asks for authority to perform a known
action. Replay never repeats external side effects; an unfinished runtime becomes `interrupted`
unless the owning subsystem proves it can resume safely.

## Runtime projection and UI attention

For ordinary core work, phase is selected from the active approval request, current RPC runtime,
and last prompt failure. Room tasks use their room-owned durable state.

UI attention priority remains:

```text
needs_approval > needs_input > failed > unread > none
```

Viewing a task may clear a presentation badge. It must not mutate the owning TaskRun phase.

## Non-goals

- adding Goal or Plan flags to prompt requests;
- automatically continuing a Goal after a model turn;
- automatically executing saved Plan output;
- treating extension tool selection as an operating-system sandbox;
- merging room worktrees automatically.
