import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
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
const defaultAudioConvertCommand = process.env.AUDIO_CONVERT_COMMAND || "ffmpeg";
const maxBookUploadSize = 50 * 1024 * 1024;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".mp3": "audio/mpeg"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

async function readBinaryRequestBody(req, maxSize) {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength >= maxSize) {
    throw httpError(413, "Zip upload must be smaller than 50 MB.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size >= maxSize) {
      throw httpError(413, "Zip upload must be smaller than 50 MB.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function multipartBoundary(contentType) {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] || match?.[2] || "";
}

function readMultipartZip(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  let cursor = body.indexOf(delimiter);

  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    if (body.subarray(partStart, partStart + 2).toString("latin1") === "--") {
      break;
    }
    if (body.subarray(partStart, partStart + 2).toString("latin1") === "\r\n") {
      partStart += 2;
    }

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd === -1) {
      break;
    }

    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd === -1) {
      break;
    }

    const headers = body.subarray(partStart, headerEnd).toString("latin1");
    if (/content-disposition:/i.test(headers) && /filename=/i.test(headers)) {
      return Buffer.from(body.subarray(contentStart, contentEnd));
    }

    cursor = body.indexOf(delimiter, contentEnd + 2);
  }

  throw httpError(400, "Multipart upload must include a zip file field.");
}

function extractZipUpload(req, body) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const boundary = multipartBoundary(contentType);
    if (!boundary) {
      throw httpError(400, "Multipart upload is missing a boundary.");
    }
    return readMultipartZip(body, boundary);
  }

  return body;
}

function validateBookId(bookId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bookId)) {
    throw httpError(400, "Invalid book id.");
  }
}

async function loadBook(bookId) {
  validateBookId(bookId);

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

function validateZipEntries(entries) {
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(normalized) ||
      parts.includes("..")
    ) {
      throw httpError(400, "Zip file contains an unsafe path.");
    }
  }
}

async function unzipBook(zipPath, extractDir) {
  let entriesOutput;
  try {
    ({ stdout: entriesOutput } = await execFileAsync("unzip", ["-Z1", zipPath], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10
    }));
  } catch {
    throw httpError(400, "Uploaded file is not a readable zip archive.");
  }

  const entries = entriesOutput.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) {
    throw httpError(400, "Zip file is empty.");
  }
  validateZipEntries(entries);

  await mkdir(extractDir, { recursive: true });
  try {
    await execFileAsync("unzip", ["-q", zipPath, "-d", extractDir], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10
    });
  } catch {
    throw httpError(400, "Zip file could not be extracted.");
  }
}

async function findBookRoot(extractDir) {
  try {
    await stat(path.join(extractDir, "book.json"));
    return extractDir;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const entries = await readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("__MACOSX"));
  if (directories.length === 1) {
    const nestedRoot = path.join(extractDir, directories[0].name);
    try {
      await stat(path.join(nestedRoot, "book.json"));
      return nestedRoot;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw httpError(400, "Book upload must contain book.json at the zip root or inside one top-level folder.");
}

async function assertDirectory(dirPath, label) {
  try {
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) {
      throw httpError(400, `${label} must be a folder.`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw httpError(400, `Book upload must contain ${label}.`);
    }
    throw error;
  }
}

async function directFileNames(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function fileStem(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

function compareAssetFiles(imageFiles, voiceFiles) {
  const imageStems = new Set(imageFiles.map(fileStem));
  const voiceNames = new Set(voiceFiles);
  const voiceStems = new Set(voiceFiles.map(fileStem));
  const missingVoices = [...imageStems].filter((stem) => !voiceNames.has(`${stem}.mp3`));
  const missingImages = [...voiceStems].filter((stem) => !imageStems.has(stem));
  const nonMp3Voices = voiceFiles.filter((fileName) => path.extname(fileName).toLowerCase() !== ".mp3");

  if (missingVoices.length > 0 || missingImages.length > 0 || nonMp3Voices.length > 0) {
    throw httpError(400, "Each image file must have a matching .mp3 file in voices, for example images/page_002.png requires voices/page_002.mp3.");
  }
}

function imageFileForPage(page, imageFiles) {
  const configuredName = path.basename(page.image?.path || "");
  if (imageFiles.includes(configuredName)) {
    return configuredName;
  }

  if (Number.isInteger(page.page_number)) {
    const pagePrefix = `page_${String(page.page_number).padStart(3, "0")}`;
    return imageFiles.find((fileName) => fileStem(fileName) === pagePrefix) || configuredName;
  }

  return configuredName;
}

function voiceFileForPage(page, voiceFiles) {
  const configuredName = path.basename(page.audio?.path || "");
  if (voiceFiles.includes(configuredName)) {
    return configuredName;
  }

  if (Number.isInteger(page.page_number)) {
    const pagePrefix = `page_${String(page.page_number).padStart(3, "0")}`;
    return voiceFiles.find((fileName) => fileStem(fileName) === pagePrefix) || configuredName;
  }

  return configuredName;
}

async function normalizeBookAssetPaths(bookJsonPath, book, imageFiles, voiceFiles) {
  if (!Array.isArray(book.pages)) {
    return;
  }

  for (const page of book.pages) {
    if (!page.image || typeof page.image !== "object") {
      page.image = {};
    }
    if (!page.audio || typeof page.audio !== "object") {
      page.audio = {};
    }

    const imageFile = imageFileForPage(page, imageFiles);
    const voiceFile = voiceFileForPage(page, voiceFiles);
    if (!imageFile || !voiceFile) {
      throw httpError(400, "Each book page must have an image path, audio path, or page_number.");
    }

    page.image.path = `images/${imageFile}`;
    page.image.filename = imageFile;
    page.audio.path = `voices/${voiceFile}`;
    page.audio.filename = voiceFile;
  }

  await saveBook(bookJsonPath, book);
}

async function validateBookUpload(bookRoot) {
  const bookJsonPath = path.join(bookRoot, "book.json");
  const imagesDir = path.join(bookRoot, "images");
  const voicesDir = path.join(bookRoot, "voices");
  let book;

  try {
    book = JSON.parse(await readFile(bookJsonPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw httpError(400, "Book upload must contain book.json.");
    }
    throw httpError(400, "book.json must be valid JSON.");
  }

  await assertDirectory(imagesDir, "images");
  await assertDirectory(voicesDir, "voices");

  const imageFiles = await directFileNames(imagesDir);
  const voiceFiles = await directFileNames(voicesDir);
  if (imageFiles.length === 0 || voiceFiles.length === 0) {
    throw httpError(400, "Images and voices folders must contain files.");
  }

  compareAssetFiles(imageFiles, voiceFiles);
  await normalizeBookAssetPaths(bookJsonPath, book, imageFiles, voiceFiles);
}

async function installBookUpload(bookId, bookRoot) {
  const targetDir = path.join(booksDir, bookId);
  const stagingDir = path.join(booksDir, `.${bookId}.upload-${Date.now()}`);

  await rm(stagingDir, { recursive: true, force: true });
  await cp(bookRoot, stagingDir, { recursive: true, force: true });
  await rm(targetDir, { recursive: true, force: true });
  await rename(stagingDir, targetDir);
}

async function handleBookUpload(req, res) {
  const bookUploadMatch = new URL(req.url, `http://${req.headers.host}`).pathname.match(/^\/books\/([^/?#]+)$/);
  if (req.method !== "POST" || !bookUploadMatch) {
    return false;
  }

  const bookId = bookUploadMatch[1];
  validateBookId(bookId);

  const uploadBytes = extractZipUpload(req, await readBinaryRequestBody(req, maxBookUploadSize));
  if (uploadBytes.length === 0) {
    throw httpError(400, "Zip upload is empty.");
  }
  if (uploadBytes.length >= maxBookUploadSize) {
    throw httpError(413, "Zip upload must be smaller than 50 MB.");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "livbook-upload-"));
  const zipPath = path.join(tempDir, "book.zip");
  const extractDir = path.join(tempDir, "extract");

  try {
    await writeFile(zipPath, uploadBytes);
    await unzipBook(zipPath, extractDir);
    const bookRoot = await findBookRoot(extractDir);
    await validateBookUpload(bookRoot);
    await installBookUpload(bookId, bookRoot);
    sendJson(res, 201, { ok: true, id: bookId });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return true;
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
    speakerMp3: process.env.TTS_SPEAKER_MP3 || bookTts.speaker_mp3 || "",
    language: process.env.TTS_LANGUAGE || bookTts.language || defaultTtsLanguage,
    model: process.env.TTS_MODEL || bookTts.model || defaultTtsModel,
    command: process.env.TTS_COMMAND || bookTts.command || "tts",
    macosVoice: process.env.MACOS_TTS_VOICE || bookTts.macos_voice || "Samantha"
  };
}

async function convertToReaderMp3(inputPath, outputPath) {
  await execFileAsync(defaultAudioConvertCommand, ["-y", "-i", inputPath, "-ac", "1", "-ar", "24000", "-codec:a", "libmp3lame", "-b:a", "96k", outputPath], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
}

async function synthesizeWithMacosSay(text, tmpAiff, tmpMp3, targetPath, page, settings) {
  if (process.platform !== "darwin") {
    throw new Error("macos_say TTS requires macOS. Set TTS_PROVIDER=coqui_xtts_v2 in Docker.");
  }

  await execFileAsync("/usr/bin/say", ["-v", settings.macosVoice, "-o", tmpAiff, text], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024
  });
  await convertToReaderMp3(tmpAiff, tmpMp3);
  await rename(tmpMp3, targetPath);

  page.audio.provider = "macos_say";
  page.audio.voice = settings.macosVoice;
  page.audio.model = "macOS say";
  page.audio.content_type = "audio/mpeg";
}

async function synthesizeWithCoquiXtts(bookId, text, tmpRawAudio, tmpMp3, targetPath, page, settings) {
  const speakerMp3 = await resolveLocalPath(bookId, settings.speakerMp3);
  if (!speakerMp3) {
    throw new Error("TTS speaker_mp3 is required for coqui_xtts_v2.");
  }

  await stat(speakerMp3);
  await execFileAsync(
    settings.command,
    [
      "--model_name",
      settings.model,
      "--text",
      text,
      "--speaker_wav",
      speakerMp3,
      "--language_idx",
      settings.language,
      "--out_path",
      tmpRawAudio
    ],
    {
      timeout: 600_000,
      maxBuffer: 1024 * 1024 * 10
    }
  );
  await convertToReaderMp3(tmpRawAudio, tmpMp3);
  await rename(tmpMp3, targetPath);

  page.audio.provider = "coqui_xtts_v2";
  page.audio.voice = path.basename(speakerMp3);
  page.audio.speaker_mp3 = path.relative(path.join(booksDir, bookId), speakerMp3);
  page.audio.language = settings.language;
  page.audio.model = settings.model;
  page.audio.content_type = "audio/mpeg";
}

async function synthesizeVoice(bookId, text, page, book) {
  const targetPath = audioFilePath(bookId, page);
  const tmpBase = `${targetPath}.${Date.now()}`;
  const tmpAiff = `${tmpBase}.aiff`;
  const tmpRawAudio = `${tmpBase}.raw.mp3`;
  const tmpMp3 = `${tmpBase}.mp3`;
  const settings = ttsSettings(book);

  try {
    if (settings.provider === "coqui_xtts_v2") {
      await synthesizeWithCoquiXtts(bookId, text, tmpRawAudio, tmpMp3, targetPath, page, settings);
    } else if (settings.provider === "macos_say") {
      await synthesizeWithMacosSay(text, tmpAiff, tmpMp3, targetPath, page, settings);
    } else {
      throw new Error(`Unsupported TTS provider: ${settings.provider}`);
    }
  } finally {
    await removeIfExists(tmpAiff);
    await removeIfExists(tmpRawAudio);
    await removeIfExists(tmpMp3);
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
    if (req.url.startsWith("/books/") && (await handleBookUpload(req, res))) {
      return;
    }

    if (req.url.startsWith("/api/") && (await handleApi(req, res))) {
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "Unexpected server error." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`LivBookReader is running at http://localhost:${port}`);
  console.log(`Network access is enabled on port ${port}`);
});
