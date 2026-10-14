# Xiaoyuzhou integration

Public podcast and episode URLs are supported; RSS is not required. We-Read
discovers public episodes, downloads audio locally, transcribes with MLX Whisper,
and uses the configured Codex CLI to generate a summary and paragraph-based
Chinese manuscript. Original transcription segments remain local for review.

```bash
cd podcast
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

The default transcription backend requires a compatible Apple Silicon Mac.
Audio and initial model downloads may be large; transcription and model-based
editing can take time. Codex CLI calls consume the configured account's quota.

Private/paywalled audio is skipped. This module does not sign in, follow accounts,
comment, or change state on Xiaoyuzhou. All subscriptions, audio, transcription
and manuscript files belong in the ignored project `data/` directory.
