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

For local sign-in, open `/signup` to create an account with an email address and password. The app sends a confirmation link, and users must confirm their email before signing in at `/login`. The first created account in an empty auth database is assigned the `admin` role; later accounts are assigned the `user` role. Passwords are stored as salted `scrypt` hashes in `data/users.sqlite3`.

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

Book uploads with `POST /books/:id` require the `admin` role. Authenticated users can read book files under `/books/...`.

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
