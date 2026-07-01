import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAuth } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const booksDir = path.join(__dirname, "books");
const port = Number(process.env.PORT || 3000);
const execFileAsync = promisify(execFile);
const maxBookUploadSize = 50 * 1024 * 1024;
const auth = createAuth({ baseDir: __dirname });

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

async function handleApi(req, res) {
  if (req.method === "GET" && req.url.match(/^\/api\/books\/?$/)) {
    sendJson(res, 200, await listBooks());
    return true;
  }

  const bookMatch = req.url.match(/^\/api\/books\/([^/?#]+)$/);

  if (req.method === "GET" && bookMatch) {
    const { book } = await loadBook(bookMatch[1]);
    sendJson(res, 200, book);
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
    const url = new URL(req.url, `http://${req.headers.host}`);
    const isPublicStyle = req.method === "GET" && url.pathname === "/styles.css";
    const isAdminBookPost = req.method === "POST" && url.pathname.startsWith("/books/");

    if (req.method === "GET" && url.pathname === "/healthz") {
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

    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "Unexpected server error." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`LivBookReader is running at http://localhost:${port}`);
  console.log(`Network access is enabled on port ${port}`);
});
