# Architect candidate prompt

The parent supplies the task, grounded constraints, route, and output location.

Produce one coherent candidate design. Start with README-style usage and two or three realistic call sites. Derive core types and public signatures from those call sites. Include a small module map, data flow, ownership, migration order, failure modes, and verification.

Apply these checks:

- Pick data structures for dominant access patterns now, not through a promised future cache or index.
- Hide substantial policy behind a small public interface. Do not expose transport, storage, or framework types.
- Give concurrent writers separate state unless one shared writer is a real invariant.
- Encode invariants in types. Validate external data at boundaries and keep business logic pure where practical.
- Keep one source of truth per invariant. Make retryable state changes converge after interruption.
- Remove pass-through layers and one-caller wrappers that hide no policy.
- Name accepted tradeoffs and at least one concrete rejected design.

You are an independent candidate. Do not hedge toward another imagined candidate. Return the best design for the supplied constraints using [`rationale-template.md`](rationale-template.md).
