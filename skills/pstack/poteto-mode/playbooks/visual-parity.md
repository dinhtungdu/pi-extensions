# Visual parity

1. Capture reference screenshots from the exact target viewport, scale, theme, data, and state before changing code.
2. Enumerate components and interaction states. Include empty, loading, error, focus, hover, and responsive states when relevant.
3. Delegate isolated components only when their files do not overlap; otherwise use one writer.
4. Exercise the real browser or app surface with the available authorized browser/simulator tools. Compare like-for-like screenshots with an image diff.
5. Investigate every material delta. Iterate until the requested tolerance is met; do not call a nonzero delta "close enough" without user-defined tolerance.
6. Run accessibility basics and functional checks so pixel parity does not hide broken behavior.

Return screenshot paths, conditions, diff results, interaction checks, and unavailable surfaces as explicit gaps.
