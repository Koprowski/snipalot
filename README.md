# Snipalot

Portable Windows screen-feedback tool for vibe-coding with AI.

Press a hotkey, talk through feedback while drawing numbered annotations on screen in real time, press stop. Snipalot transcribes your audio, converts the recording to a GIF, and drops an LLM-ready prompt onto your clipboard. Paste into Claude Code (or any LLM CLI) and you're done.

Replaces: Snipping Tool + Snagit + custom screenshot annotator + any transcription-and-prompt glue you were using.

## Status

Early development. See [`snipalot_PRD.md`](./snipalot_PRD.md) for the product spec and `C:\Users\kopro\.claude\plans\zippy-weaving-meerkat.md` for the implementation plan.

## Quick start (dev)

Requires Node 20+.

```bash
npm install
npm run dev
```

The M1 proof-of-concept spike:

```bash
npm run spike:m1
```

This opens a transparent overlay, lets you draw a test rectangle, then records the screen for 10 seconds. The output webm lands in `./spike-output/` so you can verify the annotation was baked into the capture.

## License

MIT. See [`LICENSE`](./LICENSE).
