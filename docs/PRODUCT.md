# Veridical Product Model

Veridical is an Agent product, not a workflow editor. The default journey is deliberately short:

```text
Choose an Agent → describe the task → review the result and artifacts
```

The Studio, invocation graph, replay manifest, and release controls exist to make that simple experience trustworthy. They are not the first concepts presented to a normal user.

## Three users

| User     | Primary question                                             | Primary surface   |
| -------- | ------------------------------------------------------------ | ----------------- |
| Operator | What do I need this Agent to finish?                         | Agent App         |
| Builder  | What may this Agent do, and how should it behave?            | Studio            |
| Reviewer | What changed, what can it access, and is it safe to publish? | Publish and Trace |

## Product vocabulary

- **Agent**: a named worker with instructions, a model, and a governed ability set.
- **Task**: a durable multi-turn conversation with an Agent.
- **Capability**: a user-facing umbrella for Tools, MCP connections, Skills, Memory, and Knowledge.
- **Install**: make a capability available to the workspace.
- **Enable**: allow one Agent draft to consider a capability.
- **Approve**: allow a particular capability version to enter production.
- **Publish**: freeze the Agent and its capability manifest into an immutable Release.

Technical terms such as Invocation, Spec, Manifest, schema hash, and fixture belong in advanced diagnostics.

## Capability behavior

An Agent never receives the whole workspace catalog. It can only select from its Release manifest. The runtime ranks that fixed set for the current task, injects a small shortlist, then records the candidates, filtering reasons, selected capability, input, output, version, and permission decision.

Skills teach a method but grant no tool permission. MCP connects an external capability source but does not automatically grant every discovered tool. A newly generated Tool is always a draft and cannot run in the task that proposed it.

## Definition of a coherent screen

Every screen must answer, without exposing implementation detail:

1. Where am I?
2. What is happening now?
3. What is the next useful action?

The Agent App optimizes for task progress, Studio for configuration, Trace for diagnosis, and Settings for capability selection and governance.
