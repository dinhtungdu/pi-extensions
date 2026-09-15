# Eval

Build the smallest repeatable check that distinguishes the desired behavior from the failure.

1. State the behavior, input, expected observable result, and failure signal.
2. Prefer an existing test or benchmark. Add one fixture/check only when no current check covers the behavior.
3. Capture a baseline before implementation when comparing quality or performance.
4. Run candidates in isolated paths. Keep data, commands, versions, and scoring fixed.
5. Use independent `subagent` judges only for genuinely subjective output; blind labels and retain raw evidence.
6. Report variance, invalid runs, and limits. Do not promote a lucky run to proof.

Evaluation may read external systems only when authorized. It never publishes, deploys, or mutates production data.
