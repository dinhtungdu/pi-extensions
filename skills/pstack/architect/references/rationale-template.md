# Rationale template

One page. Replace guidance with actual content.

## Problem

The outcome, current constraints, invariants, and reason the shape is not obvious.

## Usage

README-style usage plus two or three realistic call sites. Write this before the type sketch.

## Shape

Core data structures, public signatures, ownership, data flow, validation boundaries, and deliberately unsupported behavior. State what complexity the interface hides.

## Migration and verification

Ordered units that each leave the repository valid, plus the behavior check and live evidence for each unit.

## Tradeoffs accepted

One bullet per cost accepted in exchange for a concrete benefit.

## Alternatives considered

At least one materially different shape and why it lost under the actual constraints.

## Open questions and risks

Only decisions the human must make and risks supported by current evidence.

## First implementation step

The first independently verifiable unit to build.
