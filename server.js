import { createServer } from "node:http";
import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const booksDir = path.join(__dirname, "books");
const port = Number(process.env.PORT || 3000);
const execFileAsync = promisify(execFile);
const defaultTtsModel = "tts_models/multilingual/multi-dataset/xtts_v2";
const defaultTtsLanguage = "en";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".wav": "audio/wav"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFileRange(req, res, filePath, fileStat, contentType) {
  const range = req.headers.range;
  const baseHeaders = {
    "accept-ranges": "bytes",
    "content-type": contentType
  };

  if (!range) {
    res.writeHead(200, {
      ...baseHeaders,
      "content-length": fileStat.size
    });
    createReadStream(filePath).pipe(res);
    return;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.writeHead(416, {
      ...baseHeaders,
      "content-range": `bytes */${fileStat.size}`
    });
    res.end();
    return;
  }

  const requestedStart = match[1] === "" ? undefined : Number(match[1]);
  const requestedEnd = match[2] === "" ? undefined : Number(match[2]);
  const start = requestedStart ?? Math.max(fileStat.size - (requestedEnd ?? 0), 0);
  const end = Math.min(requestedEnd ?? fileStat.size - 1, fileStat.size - 1);

  if (start > end || start < 0 || end >= fileStat.size) {
    res.writeHead(416, {
      ...baseHeaders,
      "content-range": `bytes */${fileStat.size}`
    });
    res.end();
    return;
  }

  res.writeHead(206, {
    ...baseHeaders,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${fileStat.size}`
  });
  createReadStream(filePath, { start, end }).pipe(res);
}

function resolveInside(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const resolved = path.resolve(root, `.${decoded}`);
  if (!resolved.startsWith(root)) {
    return null;
  }
  return resolved;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).byteLength > 1_000_000) {
      throw new Error("Request body is too large.");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadBook(bookId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bookId)) {
    throw new Error("Invalid book id.");
  }

  const bookPath = path.join(booksDir, bookId, "book.json");
  const raw = await readFile(bookPath, "utf8");
  return { book: JSON.parse(raw), bookPath };
}

async function listBooks() {
  const entries = await readdir(booksDir, { withFileTypes: true });
  const books = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const { book } = await loadBook(entry.name);
          const pages = [...(book.pages || [])].sort((a, b) => a.page_number - b.page_number);
          return {
            id: entry.name,
            title: book.title || entry.name,
            pageCount: pages.length,
            cover: pages[0]?.image || null
          };
        } catch {
          return null;
        }
      })
  );

  return books
    .filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

async function saveBook(bookPath, book) {
  const tmpPath = `${bookPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(book, null, 2)}\n`, "utf8");
  await rename(tmpPath, bookPath);
}

async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function audioFilePath(bookId, page) {
  const audioPath = page.audio?.path;
  if (!audioPath) {
    throw new Error("Page has no audio path.");
  }

  const normalizedAudioPath = audioPath.replace(/^\.\//, "");
  const resolved = normalizedAudioPath.startsWith("books/")
    ? path.resolve(__dirname, normalizedAudioPath)
    : path.resolve(booksDir, bookId, normalizedAudioPath);
  if (!resolved.startsWith(booksDir)) {
    throw new Error("Audio path is outside the books folder.");
  }
  return resolved;
}

async function resolveLocalPath(bookId, configuredPath) {
  if (!configuredPath) {
    return null;
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const normalizedPath = configuredPath.replace(/^\.\//, "");
  const candidates = [
    path.resolve(booksDir, bookId, normalizedPath),
    path.resolve(__dirname, normalizedPath)
  ];

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return candidates[0];
}

function ttsSettings(book) {
  const bookTts = book.tts || {};
  return {
    provider: process.env.TTS_PROVIDER || bookTts.provider || "macos_say",
    speakerWav: process.env.TTS_SPEAKER_WAV || bookTts.speaker_wav || "",
    language: process.env.TTS_LANGUAGE || bookTts.language || defaultTtsLanguage,
    model: process.env.TTS_MODEL || bookTts.model || defaultTtsModel,
    command: process.env.TTS_COMMAND || bookTts.command || "tts",
    macosVoice: process.env.MACOS_TTS_VOICE || bookTts.macos_voice || "Samantha"
  };
}

async function synthesizeWithMacosSay(text, tmpAiff, tmpWav, targetPath, page, settings) {
  await execFileAsync("/usr/bin/say", ["-v", settings.macosVoice, "-o", tmpAiff, text], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  await execFileAsync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@24000", tmpAiff, tmpWav], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  await rename(tmpWav, targetPath);

  page.audio.provider = "macos_say";
  page.audio.voice = settings.macosVoice;
  page.audio.model = "macOS say";
  page.audio.content_type = "audio/wav";
}

async function synthesizeWithCoquiXtts(bookId, text, tmpRawWav, tmpWav, targetPath, page, settings) {
  const speakerWav = await resolveLocalPath(bookId, settings.speakerWav);
  if (!speakerWav) {
    throw new Error("TTS speaker_wav is required for coqui_xtts_v2.");
  }

  await stat(speakerWav);
  await execFileAsync(
    settings.command,
    [
      "--model_name",
      settings.model,
      "--text",
      text,
      "--speaker_wav",
      speakerWav,
      "--language_idx",
      settings.language,
      "--out_path",
      tmpRawWav
    ],
    {
      timeout: 600_000,
      maxBuffer: 1024 * 1024 * 10
    }
  );
  await execFileAsync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@24000", tmpRawWav, tmpWav], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  await rename(tmpWav, targetPath);

  page.audio.provider = "coqui_xtts_v2";
  page.audio.voice = path.basename(speakerWav);
  page.audio.speaker_wav = path.relative(path.join(booksDir, bookId), speakerWav);
  page.audio.language = settings.language;
  page.audio.model = settings.model;
  page.audio.content_type = "audio/wav";
}

async function synthesizeVoice(bookId, text, page, book) {
  const targetPath = audioFilePath(bookId, page);
  const tmpBase = `${targetPath}.${Date.now()}`;
  const tmpAiff = `${tmpBase}.aiff`;
  const tmpRawWav = `${tmpBase}.raw.wav`;
  const tmpWav = `${tmpBase}.wav`;
  const settings = ttsSettings(book);

  try {
    if (settings.provider === "coqui_xtts_v2") {
      await synthesizeWithCoquiXtts(bookId, text, tmpRawWav, tmpWav, targetPath, page, settings);
    } else if (settings.provider === "macos_say") {
      await synthesizeWithMacosSay(text, tmpAiff, tmpWav, targetPath, page, settings);
    } else {
      throw new Error(`Unsupported TTS provider: ${settings.provider}`);
    }
  } finally {
    await removeIfExists(tmpAiff);
    await removeIfExists(tmpRawWav);
    await removeIfExists(tmpWav);
  }
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url.match(/^\/api\/books\/?$/)) {
    sendJson(res, 200, await listBooks());
    return true;
  }

  const bookMatch = req.url.match(/^\/api\/books\/([^/?#]+)$/);
  const pageMatch = req.url.match(/^\/api\/books\/([^/?#]+)\/pages\/(\d+)$/);

  if (req.method === "GET" && bookMatch) {
    const { book } = await loadBook(bookMatch[1]);
    sendJson(res, 200, book);
    return true;
  }

  if (req.method === "PATCH" && pageMatch) {
    const bookId = pageMatch[1];
    const pageNumber = Number(pageMatch[2]);
    const body = JSON.parse(await readRequestBody(req));

    if (typeof body.content !== "string") {
      sendJson(res, 400, { error: "Expected a string content field." });
      return true;
    }

    const { book, bookPath } = await loadBook(bookId);
    const page = book.pages.find((candidate) => candidate.page_number === pageNumber);
    if (!page) {
      sendJson(res, 404, { error: "Page not found." });
      return true;
    }

    page.content = body.content;
    await synthesizeVoice(bookId, body.content, page, book);
    await saveBook(bookPath, book);
    sendJson(res, 200, { ok: true, page, audioUpdatedAt: Date.now() });
    return true;
  }

  return false;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const staticRoot = url.pathname.startsWith("/books/") ? __dirname : publicDir;
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolveInside(staticRoot, requestPath);

  if (!filePath) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    sendFileRange(req, res, filePath, fileStat, mimeTypes[ext] || "application/octet-stream");
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/") && (await handleApi(req, res))) {
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unexpected server error." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`LivBookReader is running at http://localhost:${port}`);
  console.log(`Network access is enabled on port ${port}`);
});
