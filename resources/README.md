# Bundled resources

At package time, the following binaries and models must live here:

```
resources/
├── bin/
│   └── whisper.cpp/
│       └── main.exe         ← built from https://github.com/ggerganov/whisper.cpp
├── models/
│   └── ggml-base.en.bin     ← ~150MB, from https://huggingface.co/ggerganov/whisper.cpp
└── icons/
    ├── app.ico              ← app icon
    └── tray.png             ← tray icon (16×16, 32×32)
```

ffmpeg is supplied by the `ffmpeg-static` npm dependency and lives under `node_modules/` at build time; electron-builder picks it up automatically via `asar` unpacking rules.

These files are listed in `.gitignore` because they're large and/or platform-specific. A release-prep script (TODO, M6) will fetch them into place before running `electron-builder`.
