# Design QA — Turn Context UI

## Source of truth

- Reference mock: `/Users/willer/.codex/generated_images/019fb233-a1ae-7991-9722-118ea62aaf3e/exec-ac0beb76-f68b-4831-8c80-bff13e88ab94.png`
- Follow-up annotation source: `/var/folders/bf/3lxb7bjd3yz4htdhr_2lk7yc0000gn/T/codex-clipboard-8d2922a8-2d4f-46c1-9113-9bbddd6e3591.png` (2014 × 358), identifying the per-turn dominant-category strip to replace.
- Reference size: 1487 × 1058, normalized to 1440 × 1024 for comparison.
- Latest implementation capture: `artifacts/ui-audit/11-session-total-composition.png` (1280 × 720, browser CSS viewport 1280 × 720, device density 1).
- Handoff implementation capture: `artifacts/ui-audit/19-copy-handoff-topbar.png` (1280 × 720, browser CSS viewport 1280 × 720, device density 1).
- Turn/phase drill-down capture: `artifacts/ui-audit/20-turn-phase-drilldown.png` (live session with `Tool calls` selected and the right inspector scoped to that phase).
- Tested follow-up state: light theme, session `019fb0f9-5a87-7803-a6a4-85eb7a5b9fe3`, `Turns > Compact`, T17 selected and expanded, Summary inspector visible. Both payload-size and event-count composition metrics were exercised.

## Combined comparison evidence

- Full surface, reference left / implementation right: `artifacts/ui-audit/09-source-vs-final.png`
- Turn ledger and inspector focus, reference left / implementation right: `artifacts/ui-audit/10-source-vs-final-focus.png`
- Follow-up overview comparison, annotated prior state above / session-total implementation below: `artifacts/ui-audit/13-session-overview-comparison.png`. The states intentionally differ only in the requested visualization semantics, so this evidence is used for scoped component comparison rather than pixel matching.

## Comparison history

1. Initial implementation: `artifacts/ui-audit/06-turns-compact-1440x1024.png`
2. Initial combined comparison: `artifacts/ui-audit/07-source-vs-implementation.png`
3. P2 findings:
   - Token values inherited the system locale and mixed Chinese `万` notation into an otherwise English data UI.
   - Native focus styling could introduce an off-palette orange outline.
   - Turn collection declared table semantics although interaction behavior is a selectable list.
4. Fixes:
   - Token formatting now uses a stable `en-US` compact formatter.
   - Interactive controls use the product blue `:focus-visible` outline.
   - Turn collection now exposes list/listitem semantics.
5. Final comparison: `artifacts/ui-audit/09-source-vs-final.png` and `artifacts/ui-audit/10-source-vs-final-focus.png`.
6. Follow-up finding: the equal-width, dominant-category strip was ambiguous and did not expose session totals.
7. Follow-up fix: replaced it with a single session-total stacked composition bar. Large segments show inline percentages; the legend shows every category percentage; hover exposes percentage plus absolute payload/event totals.
8. Follow-up evidence: `artifacts/ui-audit/11-session-total-composition.png` and `artifacts/ui-audit/13-session-overview-comparison.png`.
9. Handoff P2 finding: placing `Copy handoff` inside the narrow overview band crowded the metric controls at the 1280px breakpoint.
10. Handoff fix: moved the action to the persistent top bar and kept the overview focused on aggregate context data. The final 1280px evidence is `artifacts/ui-audit/19-copy-handoff-topbar.png`.
11. Drill-down P1 finding: selecting a phase only filtered the initial Raw list; Raw record clicks were ignored by the Turn inspector and Structured exposed only the lightweight Turn summary.
12. Drill-down fix: Turn rows now reset the inspector to the whole-turn Summary, while Input context, Agent work, Tool calls, and Final answer establish an explicit phase scope shared by Summary, Structured, Raw, and Related. Raw records open inline and Structured renders every in-scope event as an independent expandable node.
13. Scope finding: the top bar reads as global session chrome, so a file-scoped action such as `Copy handoff` — and the new tail-command action — did not belong there.
14. Scope fix: both file-scoped actions now sit on the active-file row of the stream toolbar as `Copy tail ▾` plus `Copy handoff`. The split button copies `tail -F <abs path> | jq -Rr -C --unbuffered 'fromjson? // .'`; the caret menu offers follow, new lines only (`-n 0`), replay from start (`-n +1`), and raw tail (no jq), and the chosen variant persists as the main button's default. Evidence: `artifacts/ui-audit/21-tail-command-menu-1440.png`.
15. Layout P2 finding (pre-existing, surfaced by 14): `.stream-panel` is a grid whose implicit `auto` column grew to the widest row, so at 1280px the toolbar's right side — previously `Compact / Narrative`, now also `Copy handoff` — was pushed outside the clipped panel. Measured before the fix: panel 637px wide, toolbar 813px, `.file-actions` right edge 909px against a panel right edge of 892px.
16. Layout fix: `.stream-panel` declares `grid-template-columns: minmax(0, 1fr)`, so every row respects the panel width. At 1280px the file actions wrap under the file name (right edge 461px, inside the panel) and horizontal scrolling stays inside the event stream where the turn ledger already opts into it. Evidence: `artifacts/ui-audit/22-tail-command-1280.png`.

## Required fidelity surfaces

### Typography

- Passed. Dense technical typography, compact labels, hierarchy between title, turn question, metadata, and inspector sections matches the reference intent.

### Spacing and layout

- Passed. Three-column shell, compact turn ledger, inline expansion, aggregate overview band, and sticky inspector preserve the reference structure while fitting the existing product shell.
- At 1280px the secondary Duration, Tools, and Status columns collapse to protect the question and composition columns.

### Colors and surfaces

- Passed. Warm off-white canvas, muted borders, blue selection, and semantic composition colors are consistent across overview, rows, expanded phases, and inspector.

### Images and assets

- Passed. The reference does not require raster illustrations or custom iconography. No placeholder images, improvised SVGs, or synthetic decorative assets were introduced.

### Copy and content

- Passed. Real JSONL session data drives questions, summaries, token deltas, tool counts, status, timestamps, and composition. The overview now states session-total percentages while each row retains per-turn composition.

### Interactions

- Passed. Verified file switching, Compact/Narrative modes, turn selection and expansion, Summary/Structured/Raw/Related inspector tabs, phase-level raw-event drill-down, full Events fallback, and copy-context action.
- Turn raw data is loaded lazily from byte ranges rather than loading every event into the default view.

### Responsive and accessibility

- Passed for the primary desktop workflow. Semantic buttons and tabs are retained, turn rows expose list semantics, and focus-visible styling is present.
- Residual P3: broader keyboard-only and assistive-technology testing remains useful; this QA pass did not validate every control with a screen reader.

## Functional verification

- `npm test`: Node 12/12 passed; Python 21/21 passed.
- Python compile check passed as part of the test suite.
- `git diff --check`: passed.
- Browser console after the primary journey: 0 errors.
- Follow-up browser console after switching payload/event metrics: 0 errors.
- `Copy handoff` was exercised against the active coding session; the UI confirmed `Handoff copied`, the API supplied the recorded absolute `cwd`, and the browser console reported 0 errors.
- Turn/phase linkage was exercised against a live 167-event turn: `Tool calls` selected 94 in-scope records, both Raw and Structured rendered all 94, a Raw record opened its exact JSON inline, and the browser console reported 0 errors.
- `Copy tail` was driven through the Chrome DevTools Protocol against a live session: all four variants produced the expected command for the selected file, the caret menu toggled `aria-expanded`, outside click and `Escape` closed it, the chosen variant persisted to `localStorage` and became the main button's default, an empty date disabled both file actions, and the browser console reported 0 errors.
- The generated `tail -F … | jq -Rr -C --unbuffered 'fromjson? // .'` command was pasted into a real terminal against a live rollout file and streamed colorized pretty-printed JSON.
- Residual P3: very small payload categories can round visually to 0%; exact byte values remain available in the inspector.
- Residual P3: the tail command assumes `jq` is installed and on `PATH`; the `Raw tail (no jq)` variant covers environments without it.

## Severity result

- P0: 0
- P1: 0
- P2: 0
- P3: 3 documented residuals

final result: passed
