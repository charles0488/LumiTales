import { execFile } from "node:child_process";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(scrypt);

function sqlValue(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function createLibraryStore({ baseDir }) {
  const dataDir = process.env.AUTH_DATA_DIR || path.join(baseDir, "data");
  const dbPath = path.join(dataDir, "users.sqlite3");
  let ready;
  let mutationQueue = Promise.resolve();

  async function run(sql, { json = false } = {}) {
    const args = json
      ? ["-cmd", ".timeout 5000", "-json", dbPath, sql]
      : ["-cmd", ".timeout 5000", dbPath, sql];
    const { stdout } = await execFileAsync("sqlite3", args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  }

  async function ensureReady() {
    if (!ready) {
      ready = (async () => {
        await mkdir(dataDir, { recursive: true });
        await run(`
          pragma journal_mode = wal;
          create table if not exists book_checkouts (
            id integer primary key autoincrement,
            parent_user_id text not null,
            book_id text not null,
            checked_out_at text not null,
            returned_at text,
            foreign key(parent_user_id) references users(id)
          );
          create unique index if not exists book_checkouts_active_unique
            on book_checkouts(parent_user_id, book_id) where returned_at is null;
          create index if not exists book_checkouts_parent_active
            on book_checkouts(parent_user_id, returned_at);
          create table if not exists parent_pins (
            user_id text primary key,
            pin_hash text not null,
            created_at text not null,
            updated_at text not null,
            foreign key(user_id) references users(id)
          );
          create table if not exists book_orders (
            id integer primary key autoincrement,
            user_id text not null,
            book_id text not null,
            ordered_at text not null,
            status text not null default 'owned',
            unique(user_id, book_id),
            foreign key(user_id) references users(id)
          );
          create index if not exists book_orders_user_status
            on book_orders(user_id, status);
          create unique index if not exists book_orders_private_book
            on book_orders(book_id) where status = 'owned';
        `);
      })();
    }
    await ready;
  }

  async function activeBookIds(userId) {
    await ensureReady();
    const output = await run(`
      select book_id from book_checkouts
      where parent_user_id = ${sqlValue(userId)} and returned_at is null
      order by checked_out_at asc, id asc
    `, { json: true });
    return (output ? JSON.parse(output) : []).map((row) => row.book_id);
  }

  async function ownedBookIds(userId) {
    await ensureReady();
    const output = await run(`select book_id from book_orders where user_id = ${sqlValue(userId)} and status = 'owned' order by ordered_at asc, id asc`, { json: true });
    return (output ? JSON.parse(output) : []).map((row) => row.book_id);
  }

  async function visibleBookIds(userId) {
    await ensureReady();
    const owned = await ownedBookIds(userId);
    const claimedOutput = await run("select book_id from book_orders where status = 'owned'", { json: true });
    const claimed = (claimedOutput ? JSON.parse(claimedOutput) : []).map((row) => row.book_id);
    return { owned, claimed };
  }

  function validatePin(pin) {
    if (!/^\d{4,8}$/.test(String(pin || ""))) {
      throw Object.assign(new Error("Parent PIN must contain 4 to 8 digits."), { statusCode: 400 });
    }
  }

  async function parentPinStatus(userId) {
    await ensureReady();
    const output = await run(`select count(*) as count from parent_pins where user_id = ${sqlValue(userId)}`, { json: true });
    return { configured: Boolean((output ? JSON.parse(output) : [])[0]?.count) };
  }

  async function setParentPin(userId, pin) {
    validatePin(pin);
    await ensureReady();
    const status = await parentPinStatus(userId);
    if (status.configured) {
      throw Object.assign(new Error("A parent PIN is already configured."), { statusCode: 409 });
    }
    const pinHash = await hashParentPin(pin);
    const now = new Date().toISOString();
    await run(`insert into parent_pins (user_id, pin_hash, created_at, updated_at) values (${sqlValue(userId)}, ${sqlValue(pinHash)}, ${sqlValue(now)}, ${sqlValue(now)})`);
  }

  async function hashParentPin(pin) {
    validatePin(pin);
    const salt = randomBytes(18).toString("base64url");
    const hash = Buffer.from(await scryptAsync(String(pin), salt, 64)).toString("base64url");
    return `scrypt:${salt}:${hash}`;
  }

  async function resetParentPin(userId, pin) {
    await ensureReady();
    const pinHash = await hashParentPin(pin);
    await run(`update parent_pins set pin_hash = ${sqlValue(pinHash)}, updated_at = ${sqlValue(new Date().toISOString())} where user_id = ${sqlValue(userId)}`);
  }

  async function verifyParentPin(userId, pin) {
    await ensureReady();
    const output = await run(`select pin_hash from parent_pins where user_id = ${sqlValue(userId)} limit 1`, { json: true });
    const stored = (output ? JSON.parse(output) : [])[0]?.pin_hash || "";
    const [scheme, salt, hash] = stored.split(":");
    if (scheme !== "scrypt" || !salt || !hash || !/^\d{4,8}$/.test(String(pin || ""))) return false;
    const candidate = Buffer.from(await scryptAsync(String(pin), salt, 64));
    const expected = Buffer.from(hash, "base64url");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  async function withMutationLock(operation) {
    const previous = mutationQueue;
    let release;
    mutationQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async function checkout(userId, bookIds) {
    return withMutationLock(() => checkoutLocked(userId, bookIds));
  }

  async function checkoutLocked(userId, bookIds) {
    await ensureReady();
    const uniqueIds = [...new Set(bookIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 5) {
      throw Object.assign(new Error("Choose between 1 and 5 books."), { statusCode: 400 });
    }
    const active = await activeBookIds(userId);
    const additions = uniqueIds.filter((id) => !active.includes(id));
    if (active.length + additions.length > 5) {
      throw Object.assign(new Error("Return a book before checking out another. Families may have up to 5 books."), { statusCode: 409 });
    }
    const now = new Date().toISOString();
    if (additions.length) {
      await run(`begin immediate; ${additions.map((id) => `insert into book_checkouts (parent_user_id, book_id, checked_out_at) values (${sqlValue(userId)}, ${sqlValue(id)}, ${sqlValue(now)});`).join(" ")} commit;`);
    }
    return activeBookIds(userId);
  }

  async function returnBook(userId, bookId) {
    return withMutationLock(async () => {
      await ensureReady();
      await run(`update book_checkouts set returned_at = ${sqlValue(new Date().toISOString())} where parent_user_id = ${sqlValue(userId)} and book_id = ${sqlValue(bookId)} and returned_at is null`);
      return activeBookIds(userId);
    });
  }

  return { activeBookIds, ownedBookIds, visibleBookIds, checkout, returnBook, parentPinStatus, setParentPin, resetParentPin, verifyParentPin };
}
