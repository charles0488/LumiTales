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

## Docker

Build and run the reader with Coqui XTTS custom voice generation:

```sh
docker compose up --build
```

If your Docker setup reports `unknown flag: --build`, build and run as two commands:

```sh
docker compose build
docker compose up
```

For older Docker Compose v1 installs, use:

```sh
docker-compose build
docker-compose up
```

If Compose is not installed, use plain Docker:

```sh
docker build -t liv-book-reader .
docker run --rm -it \
  -p 3000:3000 \
  -e TTS_PROVIDER=coqui_xtts_v2 \
  -e TTS_SPEAKER_WAV=/app/voices/satisfaction.wav \
  -e TTS_LANGUAGE=en \
  -e TTS_MODEL=tts_models/multilingual/multi-dataset/xtts_v2 \
  -v livbookreader-books:/app/books \
  -v livbookreader-tts-cache:/models \
  liv-book-reader
```

Then open:

```text
http://localhost:3000/
```

The image includes the current `voices/` folder, including `voices/satisfaction.wav` at `/app/voices/satisfaction.wav`. Docker stores `/app/books` in the named `livbookreader-books` volume, so uploaded books and edited page files survive container rebuilds and image updates. New books should be added through the app or copied into the Docker volume. The compose file still mounts local `voices/` read-only so you can change reference WAV files without rebuilding the image. By default, edited pages are regenerated with:

```text
voices/satisfaction.wav
```

Change `TTS_SPEAKER_WAV` in `docker-compose.yml` to use another mounted reference WAV, such as `/app/voices/king_love.wav` or `/app/voices/groovy.wav`.

To use local folders instead of the named Docker volumes when using plain Docker, replace the volume flags with:

```sh
-v "$PWD/books:/app/books" \
-v "$PWD/voices:/app/voices:ro"
```

To inspect or back up the persistent books data, use the `livbookreader-books` Docker volume.

If XTTS asks for model license confirmation, review the license and then set `COQUI_TOS_AGREED: "1"` in `docker-compose.yml`.

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

Voice regeneration defaults to the macOS `say` command with the `Samantha` voice and converts output to 16-bit mono 24 kHz WAV using `afconvert`. Docker runs should use `TTS_PROVIDER=coqui_xtts_v2`; Linux containers do not include macOS `say`.

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
