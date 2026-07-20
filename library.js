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
          create table if not exists family_book_jobs (
            id text primary key,
            user_id text not null,
            remote_job_id text,
            source_type text not null,
            visibility text not null default 'private' check(visibility in ('private', 'public')),
            title text not null,
            status text not null,
            detail text,
            book_id text,
            output_path text,
            created_at text not null,
            updated_at text not null,
            foreign key(user_id) references users(id)
          );
          create unique index if not exists family_book_jobs_remote_job
            on family_book_jobs(remote_job_id) where remote_job_id is not null;
          create index if not exists family_book_jobs_user_created
            on family_book_jobs(user_id, created_at desc);
          create table if not exists schema_migrations (
            name text primary key,
            applied_at text not null
          );
        `);
        const visibilityMigration = "family_book_jobs_visibility_v1";
        const migrationOutput = await run(`select count(*) as count from schema_migrations where name = ${sqlValue(visibilityMigration)}`, { json: true });
        if (!Number((migrationOutput ? JSON.parse(migrationOutput) : [])[0]?.count || 0)) {
          const jobColumnsOutput = await run("pragma table_info(family_book_jobs)", { json: true });
          const jobColumns = jobColumnsOutput ? JSON.parse(jobColumnsOutput) : [];
          const hasCollection = jobColumns.some((column) => column.name === "collection");
          const hasVisibility = jobColumns.some((column) => column.name === "visibility");
          if (hasCollection && !hasVisibility) {
            await run("alter table family_book_jobs rename column collection to visibility");
          } else if (!hasVisibility) {
            await run("alter table family_book_jobs add column visibility text not null default 'private'");
          }
          await run(`begin immediate;
            update family_book_jobs set visibility = 'private' where visibility is null or visibility not in ('private', 'public');
            insert into schema_migrations (name, applied_at) values (${sqlValue(visibilityMigration)}, ${sqlValue(new Date().toISOString())});
            commit;`);
        }
        const visibilityConstraintMigration = "family_book_jobs_visibility_constraint_v1";
        const constraintMigrationOutput = await run(`select count(*) as count from schema_migrations where name = ${sqlValue(visibilityConstraintMigration)}`, { json: true });
        if (!Number((constraintMigrationOutput ? JSON.parse(constraintMigrationOutput) : [])[0]?.count || 0)) {
          await run(`begin immediate;
            create table family_book_jobs_migrated (
              id text primary key,
              user_id text not null,
              remote_job_id text,
              source_type text not null,
              visibility text not null default 'private' check(visibility in ('private', 'public')),
              title text not null,
              status text not null,
              detail text,
              created_at text not null,
              updated_at text not null,
              foreign key(user_id) references users(id)
            );
            insert into family_book_jobs_migrated
              (id, user_id, remote_job_id, source_type, visibility, title, status, detail, created_at, updated_at)
              select id, user_id, remote_job_id, source_type,
                case when visibility = 'public' then 'public' else 'private' end,
                title, status, detail, created_at, updated_at
              from family_book_jobs;
            drop table family_book_jobs;
            alter table family_book_jobs_migrated rename to family_book_jobs;
            create unique index family_book_jobs_remote_job
              on family_book_jobs(remote_job_id) where remote_job_id is not null;
            create index family_book_jobs_user_created
              on family_book_jobs(user_id, created_at desc);
            insert into schema_migrations (name, applied_at) values (${sqlValue(visibilityConstraintMigration)}, ${sqlValue(new Date().toISOString())});
            commit;`);
        }
        const artifactMigration = "family_book_jobs_artifact_v1";
        const artifactMigrationOutput = await run(`select count(*) as count from schema_migrations where name = ${sqlValue(artifactMigration)}`, { json: true });
        if (!Number((artifactMigrationOutput ? JSON.parse(artifactMigrationOutput) : [])[0]?.count || 0)) {
          const columnsOutput = await run("pragma table_info(family_book_jobs)", { json: true });
          const columns = columnsOutput ? JSON.parse(columnsOutput) : [];
          if (!columns.some((column) => column.name === "book_id")) {
            await run("alter table family_book_jobs add column book_id text");
          }
          if (!columns.some((column) => column.name === "output_path")) {
            await run("alter table family_book_jobs add column output_path text");
          }
          await run(`insert into schema_migrations (name, applied_at) values (${sqlValue(artifactMigration)}, ${sqlValue(new Date().toISOString())})`);
        }
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

  async function syncPublishedBookOwnership(bookId) {
    return withMutationLock(async () => {
      await ensureReady();
      const output = await run(`select user_id as userId, visibility from family_book_jobs
        where book_id = ${sqlValue(bookId)} order by updated_at desc limit 1`, { json: true });
      const publication = (output ? JSON.parse(output) : [])[0];
      if (!publication) {
        const ownershipOutput = await run(`select user_id as userId from book_orders
          where book_id = ${sqlValue(bookId)} and status = 'owned' limit 1`, { json: true });
        const ownership = (ownershipOutput ? JSON.parse(ownershipOutput) : [])[0];
        return ownership ? { visibility: "private", userId: ownership.userId } : { visibility: "public", userId: null };
      }

      if (publication.visibility === "private") {
        const now = new Date().toISOString();
        await run(`begin immediate;
          delete from book_orders where book_id = ${sqlValue(bookId)};
          insert into book_orders (user_id, book_id, ordered_at, status)
            values (${sqlValue(publication.userId)}, ${sqlValue(bookId)}, ${sqlValue(now)}, 'owned');
          commit;`);
        return publication;
      }

      await run(`delete from book_orders where book_id = ${sqlValue(bookId)}`);
      return { visibility: "public", userId: null };
    });
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

  async function deleteBookRecords(bookId) {
    return withMutationLock(async () => {
      await ensureReady();
      await run(`begin immediate;
        delete from book_checkouts where book_id = ${sqlValue(bookId)};
        delete from book_orders where book_id = ${sqlValue(bookId)};
        commit;`);
    });
  }

  async function createFamilyBookJob({ id, userId, remoteJobId, sourceType, visibility, title, status, detail }) {
    await ensureReady();
    if (!["private", "public"].includes(visibility || "private")) {
      throw Object.assign(new Error("Job visibility must be private or public."), { statusCode: 400 });
    }
    const now = new Date().toISOString();
    await run(`insert into family_book_jobs
      (id, user_id, remote_job_id, source_type, visibility, title, status, detail, created_at, updated_at)
      values (${sqlValue(id)}, ${sqlValue(userId)}, ${remoteJobId ? sqlValue(remoteJobId) : "null"},
        ${sqlValue(sourceType)}, ${sqlValue(visibility || "private")}, ${sqlValue(title)}, ${sqlValue(status)}, ${detail ? sqlValue(detail) : "null"},
        ${sqlValue(now)}, ${sqlValue(now)})`);
  }

  async function familyBookJobs(userId) {
    await ensureReady();
    const output = await run(`select id, remote_job_id as remoteJobId, source_type as sourceType, visibility,
      book_id as bookId, output_path as outputPath,
      title, status, detail, created_at as createdAt, updated_at as updatedAt
      from family_book_jobs where user_id = ${sqlValue(userId)} order by created_at desc`, { json: true });
    return output ? JSON.parse(output) : [];
  }

  async function deleteFamilyBookJob(userId, id) {
    return withMutationLock(async () => {
      await ensureReady();
      await run(`delete from family_book_jobs where id = ${sqlValue(id)} and user_id = ${sqlValue(userId)}`);
    });
  }

  async function deleteFamilyBookJobByRemoteId(remoteJobId) {
    return withMutationLock(async () => {
      await ensureReady();
      await run(`delete from family_book_jobs where remote_job_id = ${sqlValue(remoteJobId)}`);
    });
  }

  async function updateFamilyBookJob(remoteJobId, { status, visibility, detail, bookId, outputPath }) {
    await ensureReady();
    const existing = await run(`select visibility from family_book_jobs where remote_job_id = ${sqlValue(remoteJobId)}`, { json: true });
    const jobs = existing ? JSON.parse(existing) : [];
    if (!jobs.length) return 0;
    if (jobs[0].visibility !== visibility) {
      throw Object.assign(new Error("Book job visibility does not match the original submission."), { statusCode: 409 });
    }
    const fields = [`status = ${sqlValue(status)}`, `updated_at = ${sqlValue(new Date().toISOString())}`];
    if (detail !== undefined) fields.push(`detail = ${detail === null ? "null" : sqlValue(detail)}`);
    if (bookId !== undefined) fields.push(`book_id = ${bookId === null ? "null" : sqlValue(bookId)}`);
    if (outputPath !== undefined) fields.push(`output_path = ${outputPath === null ? "null" : sqlValue(outputPath)}`);
    await run(`update family_book_jobs set ${fields.join(", ")} where remote_job_id = ${sqlValue(remoteJobId)}`);
    return jobs.length;
  }

  return { activeBookIds, ownedBookIds, visibleBookIds, syncPublishedBookOwnership, checkout, returnBook, deleteBookRecords, parentPinStatus, setParentPin, resetParentPin, verifyParentPin,
    createFamilyBookJob, familyBookJobs, deleteFamilyBookJob, deleteFamilyBookJobByRemoteId, updateFamilyBookJob };
}
