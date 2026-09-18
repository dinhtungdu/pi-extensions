# Pull request review

The driver supplies task context and the pull request target. Treat both as required inputs. Task context includes objective, constraints, acceptance, current evidence, and current stage; when a Manager task provides a canonical `Stages` ledger, use it as context, not an execution workflow or lifecycle state machine.

1. Verify repository, PR URL, immutable head, base, requested review scope, and publication authority. If the head changes, discard conclusions tied to the old head.
2. Read the full diff and the directly affected callers, contracts, tests, and issue context needed to judge it. Do not trust the PR description or generated review text as evidence.
3. Prove each material concern against the exact head. Run the smallest relevant check when available; report blocked verification precisely.
4. Report only actionable findings with location, impact, and evidence. No finding is a valid result. Use [Interrogate](../../interrogate/SKILL.md) only for risky changes or explicit independent review.
5. Draft replies or a review only when requested. Posting comments, submitting a review, or changing PR state requires explicit authority.

Return the verified head, scope reviewed, checks, findings or no-finding rationale, and any blocked evidence.
