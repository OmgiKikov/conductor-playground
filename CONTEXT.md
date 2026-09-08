# Agent Lab

A native Pi package for reviewed user goals, prompt-based user cards, interactive dialogues and evidence-backed metrics.

## Language

**Experiment**: One task, its sources, one agent configuration and reviewed scenario cards. The normal workflow evaluates that agent without optimizing it. Historical comparison experiments remain inspectable.

**Goal**: An outcome a user wants to achieve. Each scenario presents its goal, explicit success criteria and source-linked requirements.

**User card**: A prompt-based description containing persona, relevant characteristics, goal, known facts, behavior, opening and a follow-up limit. Assumptions are disclosed. Private backend state is separate.

**Scenario**: A user card, initial environment state, objective checks and editable rubric metrics. A scenario describes an interaction, not a prerecorded dialogue.

**Draft review**: A real human confirms the exact configuration and scenario content shown in Pi. Model edits cannot approve a draft. Changed content requires new confirmation.

**Trial**: One dialogue with fresh target state/session. Events include user/assistant messages, simulator decisions and actual tool calls/results.

**Objective result**: Trusted code checks facts and actions. Without objective checks the result is ungraded, not implicitly successful.

**Metric assessment**: A provisional model estimate against a reviewed rubric, with rationale and references to real event sequence numbers. Agent and simulator subjects are distinct.

**Human annotation**: A separate append-only judgment about a dialogue, check or metric. It does not erase the original result.

**Result review**: A human confirms the current results and annotations after inspecting evidence. It does not certify model calibration or real-user performance.

**Invalid trial**: Simulation or infrastructure failed to produce a usable measurement. Failure to accomplish a valid task is an agent failure; a judge failure is recorded separately.

**Family**: A declared group of related scenarios. Different IDs do not prove distinct or independent failure mechanisms.

**Comparison**: The older optional developer workflow for baseline/candidate measurements. Related cases belong together; held-out results must not guide optimization. It is not required for ordinary evaluation.
