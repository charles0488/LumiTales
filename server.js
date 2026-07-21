import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAuth } from "./auth.js";
import { createLogger } from "./logger.js";
import { createLibraryStore } from "./library.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const booksDir = path.join(__dirname, "books");
const port = Number(process.env.PORT || 3000);
const execFileAsync = promisify(execFile);
const maxBookUploadSize = 50 * 1024 * 1024;
const maximumImageBytes = 1_000_000;
const maximumPdfBytes = 10_000_000;
const dataDir = process.env.AUTH_DATA_DIR || path.join(__dirname, "data");
const bookJobPayloadDir = path.join(dataDir, "book-job-payloads");
const familyBookJobDeleteAfterMinutes = Number(process.env.FAMILY_BOOK_JOB_DELETE_AFTER_MINUTES || 3);
if (!Number.isFinite(familyBookJobDeleteAfterMinutes) || familyBookJobDeleteAfterMinutes < 0) {
  throw new Error("FAMILY_BOOK_JOB_DELETE_AFTER_MINUTES must be a non-negative number.");
}
const familyBookJobDeleteAfterMs = familyBookJobDeleteAfterMinutes * 60 * 1000;
const logger = createLogger({ service: "lumitales" });
const auth = createAuth({ baseDir: __dirname, logger: logger.child({ component: "auth" }) });
const library = createLibraryStore({ baseDir: __dirname });
let nextRequestId = 1;
const parentPinAttempts = new Map();
const parentPasswordAttempts = new Map();
const maxParentPinAttempts = 5;
const parentPinLockMs = 5 * 60 * 1000;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg"
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function requestId() {
  return `${Date.now().toString(36)}-${nextRequestId++}`;
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

async function readBinaryRequestBody(req, maxSize, sizeMessage = "Request body is too large.") {
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength >= maxSize) {
    throw httpError(413, sizeMessage);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size >= maxSize) {
      throw httpError(413, sizeMessage);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function multipartParts(body, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw httpError(400, "Multipart upload is missing a boundary.");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString("latin1") === "--") break;
    if (body.subarray(start, start + 2).toString("latin1") === "\r\n") start += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    if (contentEnd === -1) break;
    const headers = body.subarray(start, headerEnd).toString("latin1");
    const name = headers.match(/name="([^"]+)"/i)?.[1] || "";
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    const contentType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
    parts.push({ name, filename, contentType, data: body.subarray(contentStart, contentEnd) });
    cursor = contentEnd + 2;
  }
  return parts;
}

function publicBaseUrl(req) {
  return String(process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`).replace(/\/$/, "");
}

function bookStatusCallbackUrl(req) {
  return new URL("/api/books/status-callback", publicBaseUrl(req)).toString();
}

async function submitBookJob(req, sourceType, visibility = "private") {
  const maximumBody = sourceType === "prompt" ? 64 * 1024 : maximumPdfBytes + 512 * 1024;
  const body = await readBinaryRequestBody(req, maximumBody, "Book submission is too large.");
  let title = "Untitled family book";
  let book;
  if (sourceType === "prompt") {
    const contentType = req.headers["content-type"] || "";
    const prompt = (contentType.toLowerCase().startsWith("multipart/form-data")
      ? multipartParts(body, contentType).find((part) => part.name === "prompt")?.data.toString("utf8")
      : new URLSearchParams(body.toString("utf8")).get("prompt"))?.trim();
    if (!prompt) throw httpError(400, "A story prompt is required.");
    title = prompt.length > 72 ? `${prompt.slice(0, 69)}…` : prompt;
    book = { prompt };
  } else {
    const parts = multipartParts(body, req.headers["content-type"] || "");
    const files = parts.filter((part) => part.filename !== undefined);
    if (sourceType === "images") {
      if (!files.length) throw httpError(400, "Choose at least one image.");
      const oversized = files.filter((part) => part.data.length >= maximumImageBytes).map((part) => part.filename);
      if (oversized.length) throw httpError(413, `Each image must be smaller than 1 MB: ${oversized.join(", ")}`);
      title = parts.find((part) => part.name === "title")?.data.toString("utf8").trim() || title;
      book = {
        title,
        images: files.map((file) => ({
          filename: file.filename,
          contentType: file.contentType || "application/octet-stream",
          data: file.data.toString("base64")
        }))
      };
    } else {
      if (files.length !== 1) throw httpError(400, "Choose one PDF file.");
      if (files[0].data.length >= maximumPdfBytes) throw httpError(413, `The PDF must be smaller than 10 MB: ${files[0].filename}`);
      title = files[0].filename?.replace(/\.pdf$/i, "") || title;
      book = {
        pdf: {
          filename: files[0].filename,
          contentType: files[0].contentType || "application/pdf",
          data: files[0].data.toString("base64")
        }
      };
    }
  }

  const id = randomUUID();
  await mkdir(bookJobPayloadDir, { recursive: true });
  const payloadPath = path.join(bookJobPayloadDir, `${id}.json`);
  const temporaryPath = path.join(bookJobPayloadDir, `.${id}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(book), { mode: 0o600 });
    await rename(temporaryPath, payloadPath);
    await library.createFamilyBookJob({
      id, userId: req.user.id, remoteJobId: id, sourceType, visibility, title, status: "accepted",
      detail: "Submission accepted."
    });
  } catch (error) {
    await rm(temporaryPath, { force: true });
    await rm(payloadPath, { force: true });
    throw error;
  }
  return { job_id: id, status: "accepted", callback_url: bookStatusCallbackUrl(req) };
}

async function readJsonRequestBody(req, maxSize = 64 * 1024) {
  const body = await readBinaryRequestBody(req, maxSize);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function isParent(user) {
  return user?.role === "parent" || user?.role === "admin";
}

function requireParent(req) {
  if (!isParent(req.user)) {
    throw httpError(403, "Parent access required.");
  }
}

async function requireParentPin(req) {
  requireParent(req);
  await verifyParentPinWithLimit(req.user.id, req.headers["x-parent-pin"]);
}

async function verifyParentPinWithLimit(userId, pin) {
  const attempt = parentPinAttempts.get(userId);
  if (attempt?.lockedUntil > Date.now()) {
    throw httpError(429, "Too many incorrect PIN attempts. Try again in 5 minutes.");
  }
  if (await library.verifyParentPin(userId, pin)) {
    parentPinAttempts.delete(userId);
    return;
  }
  const failures = (attempt?.failures || 0) + 1;
  parentPinAttempts.set(userId, {
    failures,
    lockedUntil: failures >= maxParentPinAttempts ? Date.now() + parentPinLockMs : 0
  });
  if (failures >= maxParentPinAttempts) {
    throw httpError(429, "Too many incorrect PIN attempts. Try again in 5 minutes.");
  }
  throw httpError(403, "Incorrect parent PIN.");
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

async function availableBookLevels(bookId) {
  validateBookId(bookId);

  const entries = await readdir(path.join(booksDir, bookId), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.match(/^book_level_(\d+)\.json$/))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((level) => Number.isInteger(level) && level > 0)
    .sort((a, b) => a - b);
}

async function loadBook(bookId, requestedLevel) {
  validateBookId(bookId);

  const levels = await availableBookLevels(bookId);
  if (levels.length === 0) {
    throw httpError(404, "Book has no reading levels.");
  }

  const level = requestedLevel === undefined ? levels[0] : Number(requestedLevel);
  if (!Number.isInteger(level) || !levels.includes(level)) {
    throw httpError(404, "Reading level not found.");
  }

  const bookPath = path.join(booksDir, bookId, `book_level_${level}.json`);
  const raw = await readFile(bookPath, "utf8");
  return { book: JSON.parse(raw), bookPath, level, levels };
}

async function listBooks() {
  await mkdir(booksDir, { recursive: true });
  const entries = await readdir(booksDir, { withFileTypes: true });
  const books = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const { book, levels } = await loadBook(entry.name);
          const pages = [...(book.pages || [])].sort((a, b) => a.page_number - b.page_number);
          return {
            id: entry.name,
            title: book.title || entry.name,
            pageCount: pages.length,
            cover: pages[0]?.image || null,
            levels
          };
        } catch (error) {
          logger.warn("Skipping invalid book while listing books", { bookId: entry.name, error });
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
  } catch (error) {
    logger.warn("Uploaded zip could not be inspected", { error });
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
  } catch (error) {
    logger.warn("Uploaded zip could not be extracted", { error });
    throw httpError(400, "Zip file could not be extracted.");
  }
}

async function findBookRoot(extractDir) {
  if (await containsBookJson(extractDir)) {
    return extractDir;
  }

  const entries = await readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("__MACOSX"));
  if (directories.length === 1) {
    const nestedRoot = path.join(extractDir, directories[0].name);
    if (await containsBookJson(nestedRoot)) {
      return nestedRoot;
    }
  }

  throw httpError(400, "Book upload must contain book_level_<n>.json at the zip root or inside one top-level folder.");
}

async function containsBookJson(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && /^book_level_[1-9]\d*\.json$/.test(entry.name));
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

async function normalizeBookAssetPaths(bookJsonPath, book, imageFiles, voiceFiles, voicePathPrefix = "voices") {
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
    if (!imageFile || !imageFiles.includes(imageFile)) {
      throw httpError(400, `Page ${page.page_number ?? "with no number"} references an image that is missing from images.`);
    }
    if (!voiceFile || !voiceFiles.includes(voiceFile) || path.extname(voiceFile).toLowerCase() !== ".mp3") {
      throw httpError(400, `Page ${page.page_number ?? "with no number"} must have a matching .mp3 file in ${voicePathPrefix}.`);
    }

    page.image.path = `images/${imageFile}`;
    page.image.filename = imageFile;
    page.audio.path = `${voicePathPrefix}/${voiceFile}`;
    page.audio.filename = voiceFile;
  }

  await saveBook(bookJsonPath, book);
}

async function validateBookUpload(bookRoot) {
  const imagesDir = path.join(bookRoot, "images");
  const voicesDir = path.join(bookRoot, "voices");

  await assertDirectory(imagesDir, "images");
  await assertDirectory(voicesDir, "voices");

  const imageFiles = await directFileNames(imagesDir);
  if (imageFiles.length === 0) {
    throw httpError(400, "Images folder must contain files.");
  }

  const rootEntries = await readdir(bookRoot, { withFileTypes: true });
  const levelFiles = rootEntries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ entry, match: entry.name.match(/^book_level_(\d+)\.json$/) }))
    .filter(({ match }) => match && Number(match[1]) > 0)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  for (const { entry, match } of levelFiles) {
    const level = Number(match[1]);
    if (entry.name !== `book_level_${level}.json`) {
      throw httpError(400, `Reading level filename must be book_level_${level}.json.`);
    }
  }

  const bookFiles = levelFiles.map(({ entry, match }) => ({
    fileName: entry.name,
    level: Number(match[1])
  }));

  if (bookFiles.length === 0) {
    throw httpError(400, "Book upload must contain at least one book_level_<n>.json file.");
  }

  for (const { fileName, level } of bookFiles) {
    const bookJsonPath = path.join(bookRoot, fileName);
    let book;
    try {
      book = JSON.parse(await readFile(bookJsonPath, "utf8"));
    } catch (error) {
      throw httpError(400, `${fileName} must be valid JSON.`);
    }

    const levelVoiceDirName = `book_level_${level}`;
    const levelVoicesDir = path.join(voicesDir, levelVoiceDirName);
    await assertDirectory(levelVoicesDir, `voices/${levelVoiceDirName}`);
    const voiceFiles = await directFileNames(levelVoicesDir);
    if (voiceFiles.length === 0) {
      throw httpError(400, `Voices/${levelVoiceDirName} folder must contain files.`);
    }

    const voicePathPrefix = `voices/${levelVoiceDirName}`;
    await normalizeBookAssetPaths(bookJsonPath, book, imageFiles, voiceFiles, voicePathPrefix);
  }
}

async function installBookUpload(bookId, bookRoot) {
  await mkdir(booksDir, { recursive: true });
  const targetDir = path.join(booksDir, bookId);
  const stagingDir = path.join(booksDir, `.${bookId}.upload-${Date.now()}`);

  await rm(stagingDir, { recursive: true, force: true });
  await cp(bookRoot, stagingDir, { recursive: true, force: true });
  await rm(targetDir, { recursive: true, force: true });
  await rename(stagingDir, targetDir);
}

async function deleteBook(bookId) {
  validateBookId(bookId);
  const targetDir = path.join(booksDir, bookId);
  const targetStat = await stat(targetDir).catch(() => null);
  if (!targetStat?.isDirectory()) throw httpError(404, "Book not found.");

  const stagedDir = path.join(booksDir, `.${bookId}.delete-${Date.now()}`);
  await rename(targetDir, stagedDir);
  try {
    await library.deleteBookRecords(bookId);
  } catch (error) {
    await rename(stagedDir, targetDir);
    throw error;
  }
  await rm(stagedDir, { recursive: true, force: true });
}

async function handleBookUpload(req, res) {
  const bookUploadMatch = new URL(req.url, `http://${req.headers.host}`).pathname.match(/^\/books\/([^/?#]+)$/);
  if (req.method !== "POST" || !bookUploadMatch) {
    return false;
  }

  const bookId = bookUploadMatch[1];
  validateBookId(bookId);
  logger.info("Book upload started", { requestId: req.id, bookId });

  const uploadBytes = extractZipUpload(req, await readBinaryRequestBody(req, maxBookUploadSize));
  if (uploadBytes.length === 0) {
    throw httpError(400, "Zip upload is empty.");
  }
  if (uploadBytes.length >= maxBookUploadSize) {
    throw httpError(413, "Zip upload must be smaller than 50 MB.");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "lumitales-upload-"));
  const zipPath = path.join(tempDir, "book.zip");
  const extractDir = path.join(tempDir, "extract");

  try {
    await writeFile(zipPath, uploadBytes);
    await unzipBook(zipPath, extractDir);
    const bookRoot = await findBookRoot(extractDir);
    await validateBookUpload(bookRoot);
    await installBookUpload(bookId, bookRoot);
    const publication = await library.syncPublishedBookOwnership(bookId);
    logger.info("Book upload installed", { requestId: req.id, bookId, visibility: publication.visibility,
      targetUserId: publication.userId, bytes: uploadBytes.length });
    sendJson(res, 201, { ok: true, id: bookId, visibility: publication.visibility });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    logger.debug("Book upload temp directory removed", { requestId: req.id, bookId, tempDir });
  }

  return true;
}

async function handleApi(req, res) {
  if (req.method === "GET" && req.url.match(/^\/api\/books\/?$/)) {
    const activeIds = new Set(await library.activeBookIds(req.user.id));
    const { owned, claimed } = await library.visibleBookIds(req.user.id);
    sendJson(res, 200, (await listBooks()).filter((book) =>
      activeIds.has(book.id) && (!claimed.includes(book.id) || owned.includes(book.id))));
    return true;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/book-jobs") {
    await requireParentPin(req);
    const now = Date.now();
    const books = (await library.familyBookJobs(req.user.id)).map((job) => {
      const createdAtMs = Date.parse(job.createdAt);
      const deleteAvailableAtMs = createdAtMs + familyBookJobDeleteAfterMs;
      const isTerminal = job.status === "failed" || job.status === "succeeded";
      return {
        ...job,
        canDelete: isTerminal || (Number.isFinite(deleteAvailableAtMs) && now >= deleteAvailableAtMs),
        deleteAvailableAt: isTerminal ? null :
          Number.isFinite(deleteAvailableAtMs) ? new Date(deleteAvailableAtMs).toISOString() : null
      };
    });
    sendJson(res, 200, {
      books,
      configured: true,
      callbackUrl: bookStatusCallbackUrl(req),
      deleteAfterMs: familyBookJobDeleteAfterMs,
      limits: { imageBytes: maximumImageBytes, pdfBytes: maximumPdfBytes }
    });
    return true;
  }

  const familyJobMatch = url.pathname.match(/^\/api\/family-books\/([^/?#]+)$/);
  if (req.method === "DELETE" && familyJobMatch) {
    await requireParentPin(req);
    const jobId = familyJobMatch[1];
    const job = (await library.familyBookJobs(req.user.id)).find((item) => item.id === jobId);
    if (!job) throw httpError(404, "Family book job not found.");
    const eligibleAt = new Date(job.createdAt).getTime() + familyBookJobDeleteAfterMs;
    const isTerminal = job.status === "failed" || job.status === "succeeded";
    if (!isTerminal && Date.now() < eligibleAt) {
      const remainingSeconds = Math.max(1, Math.ceil((eligibleAt - Date.now()) / 1000));
      throw httpError(409, `This job can be deleted in ${remainingSeconds} seconds.`);
    }
    await library.deleteFamilyBookJob(req.user.id, jobId);
    await rm(path.join(bookJobPayloadDir, `${jobId}.json`), { force: true });
    sendJson(res, 200, { ok: true, id: jobId });
    return true;
  }

  const bookSubmitMatch = url.pathname.match(/^\/api\/books\/from-(prompt|images|pdf)$/);
  if (req.method === "POST" && bookSubmitMatch) {
    await requireParentPin(req);
    const visibility = url.searchParams.get("visibility") === "public" ? "public" : "private";
    if (visibility === "public" && req.user.role !== "admin") {
      throw httpError(403, "Administrator access required to create Public Library books.");
    }
    sendJson(res, 202, await submitBookJob(req, bookSubmitMatch[1], visibility));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/parent-pin") {
    requireParent(req);
    sendJson(res, 200, await library.parentPinStatus(req.user.id));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/parent-pin") {
    requireParent(req);
    const { pin } = await readJsonRequestBody(req);
    await library.setParentPin(req.user.id, pin);
    sendJson(res, 201, { configured: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/parent-pin/verify") {
    requireParent(req);
    const { pin } = await readJsonRequestBody(req);
    await verifyParentPinWithLimit(req.user.id, pin);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/parent-pin/reset") {
    await requireParentPin(req);
    const { pin } = await readJsonRequestBody(req);
    await library.resetParentPin(req.user.id, pin);
    parentPinAttempts.delete(req.user.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/parent-pin/forgot") {
    requireParent(req);
    const attempt = parentPasswordAttempts.get(req.user.id);
    if (attempt?.lockedUntil > Date.now()) throw httpError(429, "Too many incorrect password attempts. Try again in 5 minutes.");
    const { password, pin } = await readJsonRequestBody(req);
    if (!(await auth.verifyUserPassword(req.user.id, password))) {
      const failures = (attempt?.failures || 0) + 1;
      parentPasswordAttempts.set(req.user.id, {
        failures,
        lockedUntil: failures >= maxParentPinAttempts ? Date.now() + parentPinLockMs : 0
      });
      throw httpError(failures >= maxParentPinAttempts ? 429 : 403,
        failures >= maxParentPinAttempts ? "Too many incorrect password attempts. Try again in 5 minutes." : "Incorrect account password.");
    }
    parentPasswordAttempts.delete(req.user.id);
    await library.resetParentPin(req.user.id, pin);
    parentPinAttempts.delete(req.user.id);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/library") {
    await requireParentPin(req);
    const activeIds = new Set(await library.activeBookIds(req.user.id));
    const { owned, claimed } = await library.visibleBookIds(req.user.id);
    const ownedIds = new Set(owned);
    const claimedIds = new Set(claimed);
    sendJson(res, 200, {
      limit: 5,
      checkoutCount: activeIds.size,
      remainingCheckoutSlots: Math.max(0, 5 - activeIds.size),
      books: (await listBooks()).filter((book) => !claimedIds.has(book.id) || ownedIds.has(book.id)).map((book) => ({
        ...book,
        owned: ownedIds.has(book.id),
        checkedOut: activeIds.has(book.id)
      }))
    });
    return true;
  }

  const libraryCoverMatch = url.pathname.match(/^\/api\/library\/([^/?#]+)\/cover$/);
  if (req.method === "GET" && libraryCoverMatch) {
    await requireParentPin(req);
    const requestedBookId = libraryCoverMatch[1];
    validateBookId(requestedBookId);
    const { owned, claimed } = await library.visibleBookIds(req.user.id);
    if (claimed.includes(requestedBookId) && !owned.includes(requestedBookId)) throw httpError(404, "Cover not found.");
    const catalogBook = (await listBooks()).find((book) => book.id === requestedBookId);
    const coverPath = catalogBook?.cover?.path?.replace(/^\.\//, "");
    if (!coverPath) throw httpError(404, "Cover not found.");
    const bookRoot = path.join(booksDir, requestedBookId);
    const filePath = path.resolve(bookRoot, coverPath);
    if (!filePath.startsWith(`${bookRoot}${path.sep}`)) throw httpError(404, "Cover not found.");
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw httpError(404, "Cover not found.");
    sendFileRange(req, res, filePath, fileStat, mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    return true;
  }

  const libraryBookMatch = url.pathname.match(/^\/api\/library\/([^/?#]+)$/);
  if (req.method === "DELETE" && libraryBookMatch) {
    if (!(await auth.requireAdmin(req, res))) return true;
    await verifyParentPinWithLimit(req.user.id, req.headers["x-parent-pin"]);
    const bookId = libraryBookMatch[1];
    await deleteBook(bookId);
    logger.info("Book deleted", { requestId: req.id, bookId, userId: req.user.id });
    sendJson(res, 200, { ok: true, id: bookId });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/checkouts") {
    await requireParentPin(req);
    const { bookIds } = await readJsonRequestBody(req);
    if (!Array.isArray(bookIds) || bookIds.some((id) => typeof id !== "string")) {
      throw httpError(400, "bookIds must be an array of book ids.");
    }
    const { owned, claimed } = await library.visibleBookIds(req.user.id);
    const availableIds = new Set((await listBooks())
      .filter((book) => !claimed.includes(book.id) || owned.includes(book.id))
      .map((book) => book.id));
    if (bookIds.some((id) => !availableIds.has(id))) {
      throw httpError(404, "One or more books were not found.");
    }
    sendJson(res, 201, { bookIds: await library.checkout(req.user.id, bookIds) });
    return true;
  }

  const returnMatch = url.pathname.match(/^\/api\/checkouts\/([^/?#]+)\/return$/);
  if (req.method === "POST" && returnMatch) {
    await requireParentPin(req);
    validateBookId(returnMatch[1]);
    sendJson(res, 200, { bookIds: await library.returnBook(req.user.id, returnMatch[1]) });
    return true;
  }

  const bookMatch = url.pathname.match(/^\/api\/books\/([^/?#]+)$/);

  if (req.method === "GET" && bookMatch) {
    const activeIds = await library.activeBookIds(req.user.id);
    const { owned, claimed } = await library.visibleBookIds(req.user.id);
    if (!activeIds.includes(bookMatch[1]) || (claimed.includes(bookMatch[1]) && !owned.includes(bookMatch[1]))) {
      throw httpError(403, "This book must be checked out by a parent before it can be read.");
    }
    const { book, level, levels } = await loadBook(bookMatch[1], url.searchParams.get("level") ?? undefined);
    sendJson(res, 200, { ...book, level, levels });
    return true;
  }

  return false;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const isBookAsset = url.pathname.startsWith("/books/");
  const staticRoot = isBookAsset ? booksDir : publicDir;
  const requestPath = isBookAsset
    ? url.pathname.slice("/books".length)
    : url.pathname === "/" ? "/index.html" : url.pathname;
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
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("Static file lookup failed", { requestId: req.id, path: url.pathname, error });
    }
    sendJson(res, 404, { error: "Not found" });
  }
}

async function requireOwnedBookAsset(req, res, pathname) {
  const match = pathname.match(/^\/books\/([^/]+)\//);
  if (!match || req.method !== "GET") return true;
  try {
    validateBookId(match[1]);
    const activeIds = await library.activeBookIds(req.user.id);
    const { owned, claimed } = await library.visibleBookIds(req.user.id);
    if (activeIds.includes(match[1]) && (!claimed.includes(match[1]) || owned.includes(match[1]))) return true;
  } catch {}
  sendJson(res, 404, { error: "Not found" });
  return false;
}

const server = createServer(async (req, res) => {
  req.id = req.headers["x-request-id"] || requestId();
  res.setHeader("x-request-id", req.id);
  const startedAt = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info("Request completed", {
      requestId: req.id,
      method: req.method,
      path: url.pathname,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      userId: req.user?.id,
      userRole: req.user?.role
    });
  });

  try {
    const isPublicStyle = req.method === "GET" && url.pathname === "/styles.css";
    const isAdminBookPost = req.method === "POST" && url.pathname.startsWith("/books/");

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/book-jobs/next") {
      if (!(await auth.requireAdminBearer(req, res))) return;
      const job = await library.claimNextBookJob();
      if (!job) {
        res.writeHead(204);
        res.end();
        return;
      }
      let book;
      try {
        book = JSON.parse(await readFile(path.join(bookJobPayloadDir, `${job.id}.json`), "utf8"));
      } catch (error) {
        await library.updateFamilyBookJob(job.remoteJobId, {
          status: "failed",
          visibility: job.visibility,
          detail: "Stored book payload could not be read."
        });
        if (error.code === "ENOENT") throw httpError(500, "Book job payload is missing.");
        throw error;
      }
      sendJson(res, 200, { job, book });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/books/status-callback") {
      if (!(await auth.requireAdminBearer(req, res))) return;
      const payload = await readJsonRequestBody(req);
      if (!payload.job_id || !payload.status || !payload.visibility) {
        throw httpError(400, "job_id, status, and visibility are required.");
      }
      if (!["accepted", "working", "succeeded", "failed"].includes(String(payload.status))) {
        throw httpError(400, "Unsupported book job status.");
      }
      if (!["private", "public"].includes(String(payload.visibility))) {
        throw httpError(400, "Unsupported book job visibility.");
      }
      if (payload.status === "succeeded" && payload.book_id == null) {
        throw httpError(400, "book_id is required when a book job succeeds.");
      }
      const changes = await library.updateFamilyBookJob(payload.job_id, {
        status: String(payload.status),
        visibility: String(payload.visibility),
        bookId: payload.book_id == null ? null : String(payload.book_id),
        outputPath: payload.output_path == null ? null : String(payload.output_path),
        detail: payload.status === "succeeded" ? "Your book is ready." :
          payload.status === "failed" ? `Generation failed${payload.return_code == null ? "." : ` (exit code ${payload.return_code}).`}` : undefined
      });
      if (!changes) throw httpError(404, "Book job not found.");
      if (payload.book_id != null) await library.syncPublishedBookOwnership(String(payload.book_id));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (await auth.handleAuth(req, res)) {
      return;
    }

    if (isAdminBookPost && !(await auth.requireAdmin(req, res))) {
      return;
    }

    if (!isPublicStyle && !isAdminBookPost && !auth.requireAuth(req, res)) {
      return;
    }

    if (req.url.startsWith("/books/") && (await handleBookUpload(req, res))) {
      return;
    }

    if (req.url.startsWith("/api/") && (await handleApi(req, res))) {
      return;
    }

    if (!(await requireOwnedBookAsset(req, res, url.pathname))) return;

    await serveStatic(req, res);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const level = statusCode >= 500 ? "error" : "warn";
    logger[level]("Request failed", {
      requestId: req.id,
      method: req.method,
      path: url.pathname,
      statusCode,
      userId: req.user?.id,
      userRole: req.user?.role,
      error
    });
    sendJson(res, statusCode, { error: error.message || "Unexpected server error." });
  }
});

server.listen(port, "0.0.0.0", () => {
  logger.info("LumiTales started", { port, url: `http://localhost:${port}` });
  logger.info("Network access enabled", { port });
});

server.on("error", (error) => {
  logger.error("HTTP server error", { error });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { error: reason instanceof Error ? reason : new Error(String(reason)) });
  process.exitCode = 1;
});
