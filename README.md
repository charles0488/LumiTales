# LumiTales

A local web reader for illustrated books with synchronized page audio.

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

## Authentication

The reader requires sign-in before serving the app, book APIs, uploaded book files, images, or audio. Local email/password sign-in is enabled by default. Google and Apple sign-in use server-side OpenID Connect with signed session cookies.

Set a stable session secret and the public URL users open in their browser:

```sh
export SESSION_SECRET="replace-with-a-long-random-secret"
export PUBLIC_BASE_URL="http://localhost:3000"
```

For local sign-in, open `/signup` to create an account with an email address and password. The app sends a confirmation link, and users must confirm their email before signing in at `/login`. The first created account in an empty auth database is assigned the `admin` role; later accounts are assigned the `parent` role. Accounts explicitly assigned the `kid` role are locked to reading mode. Passwords are stored as salted `scrypt` hashes in `data/users.sqlite3`.

Parents use **Parent library** to check out up to five books from the `books` folder. Checkouts and returns are recorded in the `book_checkouts` table. Kid reading mode only serves books that are currently checked out; when five are active, a book must be returned before another can be added.

Administrators can permanently delete a Public Library book from its card in Parent Library. Deletion removes the book files and all matching checkout and private-order records for every user.

All books currently loaded from `books/` are treated as Public Library titles. They can be checked out directly and always show either **Check out** or **Return**. Family Library's **+** button submits a prompt, ordered PNG/JPG images, or a PDF into the durable local book-job queue. Administrators also see a **+** button in Public Library that reuses the same creator and records the job with `visibility = public`; family jobs use `visibility = private`. Job metadata is stored in the `family_book_jobs` SQLite table and submission payloads are stored in `data/book-job-payloads`, so both survive application restarts. The server rejects public submissions from non-administrators.

Create an administrator API token as described below. A remote worker polls the oldest accepted job using that token:

```text
GET https://your-lumitales.example/api/book-jobs/next
Authorization: Bearer lumitales_...
```

The response is `{ "job": {...}, "book": {...} }`, or HTTP 204 when no accepted job is waiting. Polling atomically claims the oldest accepted job and returns it with status `working`, preventing two workers from receiving the same job. Binary image and PDF data in `book` is base64 encoded.

See [REMOTE_WORKER_SPEC.md](REMOTE_WORKER_SPEC.md) for the complete worker contract, processing sequence, retry guidance, and acceptance criteria.

The worker reports progress and completion to:

```text
https://your-lumitales.example/api/books/status-callback
Authorization: Bearer lumitales_...
```

The callback does not accept session cookies or tokens in the URL. Only a valid, unrevoked API token belonging to an administrator is accepted.

Status callbacks must include the same `visibility` value as the original submission
and are correlated through the local `job_id`. Valid transitions are `accepted` to
`working`, then `working` to `succeeded` or `failed`; repeated current-status updates
are accepted. Once the worker knows the final book ID, it sends a `working` callback
with `book_id`, publishes the finished ZIP through `POST /books/:bookId`, and then
sends `succeeded` with the same `book_id` (and optionally `output_path`). This order
ensures private ownership is applied during publication. Completed job records are
retained until the user deletes them.

Failed and succeeded family-book job cards show a Delete button immediately. Other
job cards show it after three minutes by default. Change that non-terminal delay
with `FAMILY_BOOK_JOB_DELETE_AFTER_MINUTES`; the server enforces it even if the UI is bypassed:

```sh
export FAMILY_BOOK_JOB_DELETE_AFTER_MINUTES=3
```

The browser and server both enforce the upload limits: every image must be smaller than 1 MB and a PDF must be smaller than 10 MB. The server is authoritative even if browser validation is bypassed.

Shared accounts open in Kid Reading mode after every login or refresh. The first adult entering Parent Library creates a 4–8 digit parent PIN. That PIN is required by both the interface and checkout APIs, is stored as a salted `scrypt` hash, and is cleared from the browser when Parent mode closes or after five minutes of inactivity.

While Parent mode is unlocked, the Profile menu can change the parent PIN. The reset endpoint verifies the current PIN before replacing its salted hash.

Parents can permanently delete books owned by their family from Family Library while Parent mode is unlocked. Administrators can also delete Public Library books. Deletion requires the parent PIN, and parents cannot delete another family's books or public books.

If the PIN is forgotten, **Forgot PIN?** on the Parents Only gate verifies the local account password before accepting a new PIN. Five failed password attempts lock recovery for five minutes.

By default, confirmation and password reset emails are printed to the server console for local development. For real delivery, configure Resend or SMTP.

Resend API:

```sh
export RESEND_API_KEY="re_..."
export AUTH_EMAIL_FROM="LumiTales <no-reply@your-domain.example>"
```

SMTP:

```sh
export SMTP_HOST="smtp.example.com"
export SMTP_PORT=587
export SMTP_USER="smtp-user"
export SMTP_PASS="smtp-password"
export AUTH_EMAIL_FROM="LumiTales <no-reply@your-domain.example>"
```

Use `SMTP_SECURE=1` for implicit TLS, usually port 465. For port 587, keep `SMTP_SECURE=0` and `SMTP_STARTTLS=1` so the connection upgrades with STARTTLS. Set `SMTP_STARTTLS=0` only for SMTP servers that do not support STARTTLS.

Users can request a password reset at `/forgot-password`.

To disable local sign-in:

```sh
export LOCAL_AUTH_ENABLED=0
```

For Google sign-in, create an OAuth 2.0 web client in Google Cloud and add this authorized redirect URI:

```text
http://localhost:3000/auth/google/callback
```

Then set:

```sh
export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
```

For Apple sign-in, configure a Services ID for web sign-in in Apple Developer and add this return URL:

```text
https://your-domain.example/auth/apple/callback
```

Then create a Sign in with Apple private key and set:

```sh
export APPLE_CLIENT_ID="com.example.your-services-id"
export APPLE_TEAM_ID="..."
export APPLE_KEY_ID="..."
export APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Apple web sign-in normally requires a verified HTTPS domain, so use your deployed HTTPS URL for `PUBLIC_BASE_URL` and the Apple return URL.

Authenticated users and roles are stored in `data/users.sqlite3`. Set `AUTH_DATA_DIR` to use a different directory. If a legacy `data/users.json` file exists and the SQLite database is empty, the app imports those users on startup and makes the first imported user an admin. Sessions are stored in memory and are cleared when the server restarts.

Book uploads with `POST /books/:id` require the `admin` role. Publishing checks the book id against the originating family-book job: private books are assigned to that job's user and appear only in their Family Library, while books without private ownership appear in the Public Library. Authenticated users can read checked-out book files under `/books/...`.

An uploaded zip may contain the book files at its root or inside one top-level folder. Multi-level books use this layout:

```text
book_level_1.json
book_level_2.json
images/page_000.png
images/page_001.png
voices/book_level_1/page_000.mp3
voices/book_level_1/page_001.mp3
voices/book_level_2/page_000.mp3
voices/book_level_2/page_001.mp3
```

Every `book_level_<n>.json` must have a matching `voices/book_level_<n>` folder, and each page must resolve to an image plus a same-named `.mp3` for that level. The uploader normalizes page image and audio paths. A package must contain at least one level file; `book.json` is not a supported upload manifest.

Admins can create API tokens for scripted uploads:

```sh
curl -c cookies.txt -X POST "http://localhost:3000/auth/local" \
  --data-urlencode "email=admin@example.com" \
  --data-urlencode "password=admin-password" \
  --data-urlencode "returnTo=/"

curl -b cookies.txt -X POST "http://localhost:3000/api/admin/tokens" \
  --data-urlencode "name=upload script"
```

The token is returned once. Use it as a bearer token for admin-only uploads:

```sh
curl -X POST "http://localhost:3000/books/my_new_book" \
  -H "Authorization: Bearer lumitales_..." \
  -F "file=@/path/to/book.zip"
```

## Logging

Logs are emitted to stdout as JSON lines by default. Each request gets an `x-request-id`, and completion logs include method, path, status code, duration, and authenticated user metadata when available.

Set `LOG_LEVEL=debug` for verbose diagnostics, or `LOG_FORMAT=pretty` for local human-readable logs.

```sh
LOG_LEVEL=debug LOG_FORMAT=pretty node server.js
```

## Docker

Build and run the reader:

```sh
docker compose -f docker-compose.yml -f dev.yml up --build
```

If your Docker setup reports `unknown flag: --build`, build and run as two commands:

```sh
docker compose -f docker-compose.yml -f dev.yml build
docker compose -f docker-compose.yml -f dev.yml up
```

For older Docker Compose v1 installs, use:

```sh
docker-compose -f docker-compose.yml -f dev.yml build
docker-compose -f docker-compose.yml -f dev.yml up
```

Use `dev.yml` for local defaults and `prd.yml` for production-required configuration:

```sh
docker compose -f docker-compose.yml -f prd.yml up --build
```

Both files read values from environment variables or a `.env` file. Production requires `PUBLIC_BASE_URL`, `SESSION_SECRET`, and `AUTH_EMAIL_FROM`; optional OAuth and email delivery settings are declared in `prd.yml`.

Common production settings:

```sh
PUBLIC_BASE_URL=https://your-domain.example
SESSION_SECRET=replace-with-a-long-random-secret
AUTH_EMAIL_FROM="LumiTales <no-reply@your-domain.example>"
LOCAL_AUTH_ENABLED=1
```

For email delivery, set either Resend:

```sh
RESEND_API_KEY=re_...
```

Or SMTP:

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=smtp-user
SMTP_PASS=smtp-password
SMTP_SECURE=0
SMTP_STARTTLS=1
```

If Compose is not installed, use plain Docker:

```sh
docker build -t lumitales .
docker run --rm -it \
  -p 3000:3000 \
    -v lumitales-books:/app/books \
    -v lumitales-data:/app/data \
    lumitales
```

Then open:

```text
http://localhost:3000/
```

Docker stores `/app/books` in the named `lumitales-books` volume and `/app/data` in the named `lumitales-data` volume, so uploaded books and known users survive container rebuilds and image updates. New books should be added through the app or copied into the Docker volume.

To use local folders instead of the named Docker volumes when using plain Docker, replace the volume flags with:

```sh
-v "$PWD/books:/app/books"
```

To inspect or back up the persistent books data, use the `lumitales-books` Docker volume.

## Features

- Lists every valid book folder under `books/`.
- Opens books from a visual bookshelf.
- Displays each page image one at a time.
- Plays each page's MP3 narration.
- Auto-advances after audio ends.
- Supports manual previous/next page controls.
- Shows optional before/after-reading questions; the Questions toggle is off by default.
- Taps or clicks the page background to show or hide playback controls.
