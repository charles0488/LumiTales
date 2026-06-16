# LivBookReader

A local web reader for illustrated books with synchronized page audio and editable page text.

## Run

```sh
node server.js
```

Then open:

```text
http://localhost:3000/
```

For network access from another device on the same LAN, use the host machine's IP address:

```text
http://<your-lan-ip>:3000/
```

## Features

- Lists every valid book folder under `books/`.
- Opens books from a visual bookshelf.
- Displays each page image one at a time.
- Plays each page's WAV narration.
- Auto-advances after audio ends.
- Supports manual previous/next page controls.
- Lets users edit page text.
- Regenerates and overwrites the page WAV after saving edited text.

## Notes

Voice regeneration defaults to the macOS `say` command with the `Samantha` voice and converts output to 16-bit mono 24 kHz WAV using `afconvert`.

To generate edited page audio from a custom reference voice WAV, install the Coqui TTS CLI and run with XTTS settings:

```sh
TTS_PROVIDER=coqui_xtts_v2 \
TTS_SPEAKER_WAV=/absolute/path/to/custom_voice.wav \
node server.js
```

You can also configure a book directly in `book.json`:

```json
{
  "tts": {
    "provider": "coqui_xtts_v2",
    "speaker_wav": "voices/custom_voice.wav",
    "language": "en",
    "model": "tts_models/multilingual/multi-dataset/xtts_v2"
  }
}
```

For local setup differences, `TTS_COMMAND`, `TTS_MODEL`, `TTS_LANGUAGE`, and `MACOS_TTS_VOICE` can be provided as environment variables.
