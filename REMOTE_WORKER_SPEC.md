# LumiTales Remote Book Worker Specification

## 1. Purpose

The remote worker converts queued prompts, image sets, or PDFs into publishable LumiTales book packages. LumiTales owns the durable queue, source payloads, user ownership, and published library. The worker owns generation and packaging.

The worker must:

1. Poll for one queued job.
2. Decode and validate its source payload.
3. Generate the book assets and reading-level manifests.
4. Associate the final book ID with the job.
5. Upload the completed ZIP package.
6. Report success or failure.

All worker endpoints require an administrator API token. Session cookies are not accepted for worker operations.

## 2. Configuration

The worker needs:

| Setting | Example | Description |
| --- | --- | --- |
| `LUMITALES_BASE_URL` | `https://books.example.com` | LumiTales server origin, without a trailing slash. |
| `LUMITALES_API_TOKEN` | `lumitales_...` | Unrevoked API token belonging to an administrator. |
| `POLL_INTERVAL_SECONDS` | `5` | Delay after an empty poll or recoverable server error. |
| `WORK_DIR` | `/var/lib/lumitales-worker` | Durable local workspace for active jobs and generated artifacts. |

Send the token on every worker request:

```http
Authorization: Bearer lumitales_...
```

Treat the token as a secret. Do not put it in URLs, job logs, generated packages, or error details.

## 3. Queue API

### Claim the next job

```http
GET /api/book-jobs/next
Authorization: Bearer lumitales_...
Accept: application/json
```

Possible responses:

- `200 OK`: a job was atomically claimed and moved from `accepted` to `working`.
- `204 No Content`: no accepted job is waiting. Sleep for the configured poll interval and poll again.
- `401 Unauthorized`: the bearer token is missing.
- `403 Forbidden`: the token is invalid, revoked, or does not belong to an administrator.
- `500 Internal Server Error`: the queued payload could not be read. The server marks that job failed.

Only one worker can claim a given job. A successful response has this shape:

```json
{
  "job": {
    "id": "7ef83d7e-66b7-4d67-bf15-cd170ee764e2",
    "remoteJobId": "7ef83d7e-66b7-4d67-bf15-cd170ee764e2",
    "sourceType": "prompt",
    "visibility": "private",
    "bookId": null,
    "outputPath": null,
    "title": "A shy moon moth learns to ask for help",
    "status": "working",
    "detail": "Book generation is in progress.",
    "createdAt": "2026-07-20T20:00:00.000Z",
    "updatedAt": "2026-07-20T20:00:05.000Z"
  },
  "book": {
    "prompt": "A shy moon moth learns to ask for help"
  }
}
```

Use `job.id` as the callback `job_id`. `remoteJobId` currently has the same value but workers should not depend on that implementation detail.

## 4. Source Payloads

The value of `job.sourceType` determines the `book` schema.

### Prompt

```json
{
  "prompt": "A shy moon moth learns to ask for help"
}
```

### Images

Images remain in the order selected by the user. `data` is standard padded Base64.

```json
{
  "title": "Our Camping Trip",
  "images": [
    {
      "filename": "page-1.jpg",
      "contentType": "image/jpeg",
      "data": "/9j/4AAQSkZJRg..."
    }
  ]
}
```

Decode each image without changing its order. Do not trust filenames as filesystem paths; replace directory separators and generate safe local names.

### PDF

```json
{
  "pdf": {
    "filename": "source.pdf",
    "contentType": "application/pdf",
    "data": "JVBERi0xLjcK..."
  }
}
```

Decode `pdf.data` before processing. Apply normal PDF safety limits in the worker as well, including page-count, decompression, processing-time, and memory limits.

## 5. Job Lifecycle

The supported states are:

```text
accepted -> working -> succeeded
                    -> failed
```

Polling performs the `accepted -> working` transition atomically. Repeating the current state is allowed, so progress callbacks with `status: "working"` are idempotent. Regressions and changes from a terminal state return `409 Conflict`.

The worker should persist the complete claimed response in `WORK_DIR/<job_id>/job.json` before beginning expensive work. Keep generated files in the same job directory until success is acknowledged.

### Status callback

```http
POST /api/books/status-callback
Authorization: Bearer lumitales_...
Content-Type: application/json
```

Working callback:

```json
{
  "job_id": "7ef83d7e-66b7-4d67-bf15-cd170ee764e2",
  "status": "working",
  "visibility": "private"
}
```

Once the final book ID is known, send another working callback before uploading:

```json
{
  "job_id": "7ef83d7e-66b7-4d67-bf15-cd170ee764e2",
  "status": "working",
  "visibility": "private",
  "book_id": "the_moon_moths_lesson"
}
```

This callback-before-upload ordering is required for private books. It lets LumiTales associate the uploaded book with its owner before publication.

Successful callback:

```json
{
  "job_id": "7ef83d7e-66b7-4d67-bf15-cd170ee764e2",
  "status": "succeeded",
  "visibility": "private",
  "book_id": "the_moon_moths_lesson",
  "output_path": "the_moon_moths_lesson.zip"
}
```

`book_id` is required for `succeeded`. `output_path` is optional metadata.

Failure callback:

```json
{
  "job_id": "7ef83d7e-66b7-4d67-bf15-cd170ee764e2",
  "status": "failed",
  "visibility": "private",
  "return_code": 1
}
```

The callback returns `200 {"ok":true}` when accepted. It may also return:

- `400` for missing fields, unsupported values, or a successful status without `book_id`.
- `404` when the job does not exist.
- `409` for a visibility mismatch or invalid state transition.

Always copy `visibility` exactly from the claimed job. Never infer or override it.

## 6. Book ID

Generate a stable, URL-safe ID matching:

```text
^[A-Za-z0-9_-]+$
```

A recommended algorithm is:

1. Normalize the title to lowercase ASCII.
2. Replace runs of non-alphanumeric characters with `_`.
3. Trim leading and trailing underscores.
4. Append a short deterministic suffix derived from `job.id` to prevent collisions.

Example: `the_moon_moths_lesson_7ef83d7e`.

Retrying the same job must produce the same book ID.

## 7. Output Package

Upload one ZIP containing the book files at the ZIP root or under one top-level directory. At least one `book_level_<n>.json` file is required; `book.json` is not supported.

Recommended layout:

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

Every manifest must have a matching `voices/book_level_<n>` directory. Each page must resolve to an image and a same-named MP3 for that reading level.

Representative manifest:

```json
{
  "title": "The Moon Moth's Lesson",
  "pages": [
    {
      "page_number": 0,
      "content": "Mina the moth needed help.",
      "source_page_number": 0,
      "image": {
        "path": "images/page_000.png",
        "filename": "page_000.png",
        "content_type": "image/png"
      },
      "audio": {
        "path": "voices/book_level_1/page_000.mp3",
        "filename": "page_000.mp3",
        "content_type": "audio/mpeg"
      }
    }
  ]
}
```

Before upload, verify that every referenced file exists, paths remain inside the package, page numbers are ordered, images are decodable, and audio files are valid MP3s.

## 8. Publishing

After sending the `working` callback with `book_id`, publish the ZIP:

```http
POST /books/the_moon_moths_lesson_7ef83d7e
Authorization: Bearer lumitales_...
Content-Type: multipart/form-data
```

The multipart request must contain one file field:

```sh
curl -X POST "$LUMITALES_BASE_URL/books/$BOOK_ID" \
  -H "Authorization: Bearer $LUMITALES_API_TOKEN" \
  -F "file=@$ZIP_PATH"
```

The maximum ZIP size is 50 MB. A successful upload returns `201`:

```json
{
  "ok": true,
  "id": "the_moon_moths_lesson_7ef83d7e",
  "visibility": "private"
}
```

Verify that the returned `id` and `visibility` match the job. Only after this response should the worker send `succeeded`.

## 9. Processing Algorithm

```text
loop:
  GET /api/book-jobs/next
  if 204:
    wait POLL_INTERVAL_SECONDS
    continue

  durably save job response

  try:
    decode source payload
    generate pages, images, reading-level text, and audio
    choose deterministic book_id
    validate and zip package
    callback working with book_id
    upload ZIP to /books/:book_id
    callback succeeded with book_id
    remove local job workspace
  catch error:
    preserve detailed diagnostics locally
    callback failed with a non-secret summary/return_code
    retain or quarantine local workspace according to policy
```

Process one job at a time per worker process unless resource limits and generation dependencies are explicitly designed for concurrency.

## 10. Retries and Recovery

Use bounded exponential backoff with jitter for network failures, `429`, and `5xx` responses. Respect `Retry-After` when supplied. Do not automatically retry validation errors or other `4xx` responses except `409` handling described below.

Operations should be idempotent:

- Derive `book_id` from `job.id`.
- Reuse the same local job directory after restart.
- A repeated `working` callback is valid.
- A repeated upload replaces the same book ID through the server's staged installation flow.
- A repeated `succeeded` callback is valid.

If a callback returns `409`, stop automatic state changes for that job and retain diagnostics for operator review.

Current queue limitation: claiming has no lease timeout. If a worker receives a job and disappears before durably recording it, that job remains `working` and is not returned by later polls. Production deployments should supervise workers closely. A future queue revision should add claim leases and an explicit recovery/requeue operation.

## 11. Observability

Log at least:

- Job ID, source type, visibility, and generated book ID.
- Poll, generation, packaging, upload, and callback durations.
- Retry count and HTTP status, without bearer tokens or source content.
- Generated page and reading-level counts.
- Final result and a local diagnostic reference.

Propagate or record the response `x-request-id` from LumiTales for support correlation.

Recommended metrics include queue polls, empty polls, claimed jobs, successful jobs, failed jobs, generation duration, upload duration, payload bytes, ZIP bytes, and retry counts.

## 12. Acceptance Criteria

A conforming worker must demonstrate:

1. `204` empty-queue polling without busy looping.
2. Successful processing of prompt, ordered-image, and PDF payloads.
3. Correct Base64 decoding and filename sanitization.
4. Deterministic book IDs across retries.
5. A valid multi-level ZIP accepted by `POST /books/:bookId`.
6. The working-with-book-ID callback occurs before upload.
7. `succeeded` is sent only after a confirmed `201` upload.
8. Failures produce a `failed` callback without leaking secrets or user content.
9. Private books appear only in the originating user's Family Library.
10. Public books appear in Public Library.
11. Restart recovery reuses the saved active-job workspace.
12. Logs and metrics contain enough identifiers to trace a job end to end.
