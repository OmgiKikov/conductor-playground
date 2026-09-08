# Agent Lab — Pi cards and human review

Status: implemented the approved v0.2 workflow. Pi is the interface; all methodology is embedded. The initial three independent reviews were gstack plan-eng-review, Matt Pocock improve-codebase-architecture and thermo-nuclear-code-quality-review. Their reports remain in `.context/reviews/`.

## Product flow

1. Derive concrete user goals and success criteria from task materials, golden cases and authorized real examples when supplied.
2. Generate simple prompt-based user cards: persona, characteristics, known facts, behavior, opening and bounded follow-ups. Show assumptions separately from requirements.
3. Present one editable pre-run package: agent, sources, goals, users, environment and metrics. A human confirms its exact version through native Pi UI.
4. Run one unchanged agent against the approved scenarios. One goal and one user are enough; no optimization or independent-family minimum is imposed on ordinary evaluation.
5. Return objective checks and provisional rubric assessments with trace references. Preserve judge errors, ungraded dialogues and unknown evidence explicitly.
6. Let the human inspect dialogues, annotate checks/metrics independently and confirm the result set. Any new annotation invalidates the prior final review, while original scores remain intact.

## Native interface

A keyboard-driven Pi card board presents summaries, status, editable details, dialogues, metrics and human annotations. It uses Pi's existing terminal components and theme. Width handling, long text, Unicode, cancellation and noninteractive mode are verified.

Model-facing tools prepare, edit and inspect drafts. They cannot call a human approval action. `/agent-lab` owns actual human confirmations through Pi UI. Confirmation is tied to a content hash, so an edited or stale card cannot be launched using an earlier approval.

## Reused implementation

- Existing Pi SDK role isolation, model configuration and OAuth.
- Existing dialogue runner, registered record tools, fresh state, call/time/turn limits and trace journal.
- Existing atomic experiment store, with backward-compatible optional card/review fields.
- Separate ordinary evaluation and historical comparison paths in the same orchestrator.
- Source-grounded generation, literal/objective checks, plus a small isolated rubric-assessment call.

No generic workflow framework, external service, database or universal agent connector is introduced. A concrete external pilot adapter depends on the supplied endpoint and session/state contract.

## Review integrity

- Human confirmation applies to agent/configuration, scenarios, criteria and sources as a whole.
- Editing and starting reserve a single writer operation, including reads and first checkpoint; shutdown retains ownership until pending saves finish.
- Running/completed inputs are immutable. Changed conditions require a new experiment.
- The assessor receives the approved rubric and recorded evidence; the simulator receives only its user projection and actual conversation.
- Metric results must cover requested IDs exactly once and cite existing trace events. Such validation does not establish semantic correctness.
- Human annotations append to history. Automatic checks, provisional model estimates and human opinions remain distinguishable.
- A completed review is not a claim of judge calibration, independent scenario families or production improvement.

## Pilot and acceptance

The supplied product notes call for one real agent, a reviewed golden set, decision-driving metrics and authorized deidentified production traces. These have not been supplied; the included appointment and conversation fixtures remain demonstrations.

The first pilot should review five real scenarios, then compare static messages, scripted multi-turn and reactive simulation under the same agent, initial states, criteria and budgets. Useful new failure mechanisms and fidelity matter more than generating many dialogues.

Acceptance: one goal/persona reaches the entire native prepare→edit→human approval→dialogue→assessment→human annotation→final review flow; unapproved/stale drafts never run; original evidence survives edits, cancellation and restart; cards remain readable in narrow and wide terminals; installed-package loading and meaningful error paths pass.

Verification on 2026-09-08: 66 automated checks passed, including scripted native confirmation/annotation flow, stale-approval and cancellation boundaries, actual SDK role isolation and malformed assessor evidence. Strict type checking includes the extension. A live fictional café check used two user and two agent messages, preserved the final clarification, and produced two separate rubric assessments citing actual events (4 model calls, observed cost $0.02233). This was an engineering runtime smoke, not a human-reviewed product run or proof of production quality. The generated draft exposed answer leakage into user facts; it was corrected for the fixture and the generator instructions were tightened. Human review remains necessary for semantic mistakes.

## Sources shaping the implementation

- [Anthropic agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): outcome, trajectory, repeats, objective checks and regression suites.
- [Anthropic tool improvement](https://www.anthropic.com/engineering/writing-tools-for-agents): improve tools from observed development failures; validate on held-out cases.
- [Bloom](https://alignment.anthropic.com/2025/bloom-auto-evals/): scenario-first generation and dynamic rollout; simulated tools cannot establish actual action correctness.
- [Anthropic statistics](https://www.anthropic.com/research/statistical-approach-to-model-evals): paired comparisons and clustered uncertainty.
- [OpenAI evaluation practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) and [simulation guide](https://developers.openai.com/cookbook/examples/realtime_eval_guide): task-specific criteria, human calibration, pinned simulation and retained traces.
- [Hyper-tau](https://arxiv.org/html/2609.04611v1): agent construction from business evidence and independent final scoring.
- [Simulation gap](https://arxiv.org/html/2601.17087v1): distinguish synthetic evidence from human-user performance.
- [User's harness article](https://hugobowne.substack.com/p/how-evals-are-central-to-harness), [shared discussion](https://x.com/lotte_verheyden/status/2089838277729890437) and [Langfuse metric selection](https://langfuse.com/academy/evaluate/choosing-what-to-evaluate): requirements and observed failures determine useful metrics.
