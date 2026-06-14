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

- Reads `books/doing_my_chores/book.json`.
- Displays each page image one at a time.
- Plays each page's WAV narration.
- Auto-advances after audio ends.
- Supports manual previous/next page controls.
- Lets users edit page text.
- Regenerates and overwrites the page WAV after saving edited text.

## Notes

Voice regeneration uses the macOS `say` command with the `Samantha` voice and converts output to 16-bit mono 24 kHz WAV using `afconvert`.
