# Exit-time Screenshot Feature Plan

## Goal

For each real trade row, automatically extract a still image at the actual exit time and embed it in `trade_log.md`, even when the user did not press the trade marker hotkey or HUD marker button at that moment.

## Feasibility

This is feasible with the current architecture. Trade rows already have:

- `recordingStartedAtMs`
- finalized `recording.mp4`
- `mockape_timestamp_ms` for the actual exit time
- `trade_log.md` generation after MockApe join

The frame offset is:

```text
exitOffsetMs = mockape_timestamp_ms - recordingStartedAtMs
```

If that offset is inside the recording duration, the pipeline can call the existing `extractFrameAt()` helper from `src/main/pipeline.ts` and write a PNG under `Inputs/trade-screenshots/`.

## Proposed Output

Keep user-created marker screenshots distinct from automatic exit frames:

```text
Inputs/
  trade-screenshots/
    marker-1.png
    exit-trade-1.png
    exit-trade-2.png
```

In `trade_log.md`, show both when available:

```markdown
**Trade screenshots:**

![Entry / marker screenshot](Inputs/trade-screenshots/marker-1.png)
![Exit screenshot](Inputs/trade-screenshots/exit-trade-1.png)
```

## Implementation Steps

1. Export or move a reusable frame-extraction helper from `src/main/pipeline.ts` so `src/main/trade-pipeline.ts` can request frames without duplicating ffmpeg code.
2. After MockApe join and before Markdown generation, iterate over real matched trades.
3. For each trade with `mockape_timestamp_ms`, calculate `exitOffsetMs`.
4. Skip frame extraction if the offset is missing, negative, or beyond `durationMs`.
5. Write `Inputs/trade-screenshots/exit-trade-${trade.trade_id}.png`.
6. Add an optional `exit_screenshot_path` field to `TradeEvent` or maintain a local map during Markdown generation.
7. Update `trade_log.md` to embed marker screenshots plus exit screenshots with clear labels.
8. Add warnings/logs for any extraction failures without failing the whole trade pipeline.

## Risks / Details

- MockApe timestamps may represent close/settlement time rather than the visual chart moment. The feature should label images as "Exit screenshot" rather than imply exact fill-frame certainty.
- If a trade timestamp is outside the video window, skip and log it. Do not produce misleading images.
- Extracting several PNGs is cheap compared with GIF/Whisper/Gemini, so this should not materially slow processing.

