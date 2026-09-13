# Feature Map

The Feature Map is the **agent-friendly projection of the committed Knowledge
Registry** (roadmap V0.2). It answers one question for an agent in
low-token form:

> What does this app know about itself, and what behaviors are proven?

## Relationship to Knowledge

```text
Structured Knowledge (only Source of Truth)
        ↓
Feature Map Projection (derived, read-only, deterministic)
        ↓
Low-token Agent Context (JSON or Markdown)
```

Hard rules:

- Knowledge is the only Source of Truth. The Feature Map is never edited:
  every field is computed from the bundle.
- The bundle's `knowledgeHash` and `revision` are carried in the projection so
  consumers can detect drift (`knowledge evolve` changes the hash).
- Projection is deterministic: ids sort lexicographically, no timestamps, no
  model calls. Core never narrates in natural language; the Markdown renderer
  is a faithful 1:1 mapping of the structured JSON.
- A projection never invents facts. Screens, Transitions, Anchors, statuses,
  and observation counts come straight from Knowledge.

## Derivation rules

### Features

- **Entry Screen**: a Screen with no incoming Transition. When every Screen
  has an incoming Transition (a pure cycle), the lexicographically smallest
  Screen becomes the single entry.
- **Feature**: the set of Screens reachable (through Transitions) from one
  entry Screen. A Screen reachable from several entries is claimed by the
  entry whose reachability set was computed first, in sorted order.
- **Feature id**: the entry Screen id.
- Transitions and Anchors belong to the feature of their source Screen.

### Entries

`entryScreens` lists every entry Screen with its status. An agent uses this as
the set of trusted cold-start points for a Journey.

### Behaviors

Transitions carry their folded `observations` (`attempts`, `successes`,
`recoveryCost`). `successes > 0` means the behavior was observed at least once
on a real device and folded back by `knowledge evolve`; this is the closest
deterministic signal of "verified behavior" this projection can express.

## CLI

```bash
# structured projection (one JSON value, deterministic)
taphound knowledge feature-map --project /path/to/android-project --json

# low-token Markdown for agent context
taphound knowledge feature-map --project /path/to/android-project --markdown

# one-line summary
taphound knowledge feature-map --project /path/to/android-project
```

## Where agents consume it

- Verification Agent context (cold context input, see
  `docs/verification-agent.md`);
- Journey generator orientation before writing a Contract (read-only);
- Diff-aware verification (`verify --diff`) may later select the Features
  touched by a code change.

The projection never modifies device state and never touches
`.taphound/knowledge/`.