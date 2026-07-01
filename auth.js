import { createHash, createHmac, createPublicKey, createSign, createVerify, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const sessionCookieName = "livbook_session";
const oauthCookieName = "livbook_oauth";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 14;
const oauthStateTtlMs = 1000 * 60 * 10;
const jwksTtlMs = 1000 * 60 * 60;
const maxBodyBytes = 1024 * 1024;
const scryptAsync = promisify(scrypt);
const execFileAsync = promisify(execFile);

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64Url(input) {
  const padded = `${input}${"=".repeat((4 - (input.length % 4)) % 4)}`;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function jsonBase64Url(payload) {
  return base64Url(JSON.stringify(payload));
}

function randomToken(byteLength = 32) {
  return base64Url(randomBytes(byteLength));
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies[rawName] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  return parts.join("; ");
}

function appendSetCookie(res, cookie) {
  const previous = res.getHeader("set-cookie");
  if (!previous) {
    res.setHeader("set-cookie", cookie);
  } else if (Array.isArray(previous)) {
    res.setHeader("set-cookie", [...previous, cookie]);
  } else {
    res.setHeader("set-cookie", [previous, cookie]);
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function providerEnabled(config) {
  return Boolean(config.clientId && config.clientSecret);
}

function appleEnabled(config) {
  return Boolean(config.clientId && config.teamId && config.keyId && config.privateKey);
}

function localEnabled() {
  return process.env.LOCAL_AUTH_ENABLED !== "0";
}

function normalizePrivateKey(value) {
  return value?.replace(/\\n/g, "\n") || "";
}

function signValue(secret, value) {
  return base64Url(createHmac("sha256", secret).update(value).digest());
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function signCookie(secret, value) {
  return `${value}.${signValue(secret, value)}`;
}

function verifyCookie(secret, signedValue) {
  const separator = signedValue.lastIndexOf(".");
  if (separator === -1) {
    return null;
  }

  const value = signedValue.slice(0, separator);
  const signature = signedValue.slice(separator + 1);
  return safeEqual(signature, signValue(secret, value)) ? value : null;
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) {
      throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function validateLocalCredentials(login, password) {
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login);
  const isUsername = /^[a-z0-9_-]{3,64}$/.test(login);
  if (!isEmail && !isUsername) {
    throw new Error("Enter a valid username or email address.");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
}

async function hashPassword(password) {
  const salt = randomToken(18);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${base64Url(hash)}`;
}

async function verifyPassword(password, passwordHash) {
  const [scheme, salt, storedHash] = String(passwordHash || "").split(":");
  if (scheme !== "scrypt" || !salt || !storedHash) {
    return false;
  }

  const candidate = await scryptAsync(password, salt, 64);
  return safeEqual(base64Url(candidate), storedHash);
}

function derToJose(signature, size) {
  const bytes = Buffer.from(signature);
  let offset = 2;
  if (bytes[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature.");
  }
  offset += 1;
  const rLength = bytes[offset];
  offset += 1;
  let r = bytes.subarray(offset, offset + rLength);
  offset += rLength;
  if (bytes[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature.");
  }
  offset += 1;
  const sLength = bytes[offset];
  offset += 1;
  let s = bytes.subarray(offset, offset + sLength);

  if (r[0] === 0) {
    r = r.subarray(1);
  }
  if (s[0] === 0) {
    s = s.subarray(1);
  }

  return Buffer.concat([Buffer.concat([Buffer.alloc(size - r.length), r]), Buffer.concat([Buffer.alloc(size - s.length), s])]);
}

function createJwt({ header, payload, privateKey }) {
  const signingInput = `${jsonBase64Url(header)}.${jsonBase64Url(payload)}`;
  const signature = createSign("sha256").update(signingInput).end().sign(privateKey);
  return `${signingInput}.${base64Url(derToJose(signature, 32))}`;
}

function createAppleClientSecret(config) {
  const now = Math.floor(Date.now() / 1000);
  return createJwt({
    header: {
      alg: "ES256",
      kid: config.keyId
    },
    payload: {
      iss: config.teamId,
      iat: now,
      exp: now + 300,
      aud: "https://appleid.apple.com",
      sub: config.clientId
    },
    privateKey: config.privateKey
  });
}

function verifyJwtSignature(token, jwk, alg) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const verifier = createVerify(alg === "RS256" ? "RSA-SHA256" : "sha256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  return verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, decodeBase64Url(encodedSignature));
}

function parseJwt(token) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("ID token is malformed.");
  }

  return {
    header: JSON.parse(decodeBase64Url(encodedHeader).toString("utf8")),
    payload: JSON.parse(decodeBase64Url(encodedPayload).toString("utf8"))
  };
}

function validateClaims(payload, provider, config, nonce) {
  const expectedIssuer = provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com";
  const issuers = provider === "google" ? [expectedIssuer, "accounts.google.com"] : [expectedIssuer];
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const now = Math.floor(Date.now() / 1000);

  if (!issuers.includes(payload.iss)) {
    throw new Error("ID token issuer is invalid.");
  }
  if (!audience.includes(config.clientId)) {
    throw new Error("ID token audience is invalid.");
  }
  if (!payload.sub) {
    throw new Error("ID token subject is missing.");
  }
  if (payload.exp < now) {
    throw new Error("ID token has expired.");
  }
  if (payload.iat && payload.iat > now + 300) {
    throw new Error("ID token was issued in the future.");
  }
  if (!payload.nonce || payload.nonce !== nonce) {
    throw new Error("ID token nonce is invalid.");
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function sqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runSql(dbPath, sql, { json = false } = {}) {
  const args = json
    ? ["-cmd", ".timeout 5000", "-json", dbPath, sql]
    : ["-cmd", ".timeout 5000", dbPath, sql];
  const { stdout } = await execFileAsync("sqlite3", args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

async function allRows(dbPath, sql) {
  const output = await runSql(dbPath, sql, { json: true });
  return output ? JSON.parse(output) : [];
}

function rowToUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    provider: row.provider,
    providerSub: row.provider_sub,
    email: row.email || "",
    emailVerified: row.email_verified === 1,
    name: row.name || "",
    picture: row.picture || "",
    passwordHash: row.password_hash || "",
    role: row.role || "user",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function userSelectSql(where) {
  return `select id, provider, provider_sub, email, email_verified, name, picture, password_hash, role, created_at, updated_at from users where ${where} limit 1`;
}

export function createAuth({ baseDir }) {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL || "";
  const sessionSecret = process.env.SESSION_SECRET || randomToken(48);
  const secureCookies = (configuredBaseUrl || "").startsWith("https://");
  const dataDir = process.env.AUTH_DATA_DIR || path.join(baseDir, "data");
  const usersDbPath = path.join(dataDir, "users.sqlite3");
  const legacyUsersPath = path.join(dataDir, "users.json");
  const sessions = new Map();
  const oauthStates = new Map();
  const jwksCache = new Map();
  let userDbReady;
  let localAuthQueue = Promise.resolve();

  if (!process.env.SESSION_SECRET) {
    console.warn("SESSION_SECRET is not set. Sessions will be invalidated whenever the server restarts.");
  }

  const providers = {
    google: {
      name: "Google",
      issuer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      scopes: "openid email profile"
    },
    apple: {
      name: "Apple",
      issuer: "https://appleid.apple.com",
      authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
      tokenEndpoint: "https://appleid.apple.com/auth/token",
      jwksUri: "https://appleid.apple.com/auth/keys",
      clientId: process.env.APPLE_CLIENT_ID || "",
      teamId: process.env.APPLE_TEAM_ID || "",
      keyId: process.env.APPLE_KEY_ID || "",
      privateKey: normalizePrivateKey(process.env.APPLE_PRIVATE_KEY),
      scopes: "name email"
    }
  };

  function baseUrl(req) {
    if (configuredBaseUrl) {
      return configuredBaseUrl.replace(/\/$/, "");
    }

    const proto = req.headers["x-forwarded-proto"] || "http";
    return `${proto}://${req.headers.host}`;
  }

  function providerConfig(provider) {
    const config = providers[provider];
    if (!config) {
      throw Object.assign(new Error("Unknown authentication provider."), { statusCode: 404 });
    }
    if (provider === "apple" ? !appleEnabled(config) : !providerEnabled(config)) {
      throw Object.assign(new Error(`${config.name} authentication is not configured.`), { statusCode: 503 });
    }
    return config;
  }

  function sessionFromRequest(req) {
    const cookies = parseCookies(req);
    const sessionId = verifyCookie(sessionSecret, cookies[sessionCookieName] || "");
    if (!sessionId) {
      return null;
    }

    const session = sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      sessions.delete(sessionId);
      return null;
    }

    session.expiresAt = Date.now() + sessionTtlMs;
    return session;
  }

  function setSessionCookie(res, sessionId) {
    appendSetCookie(res, serializeCookie(sessionCookieName, signCookie(sessionSecret, sessionId), {
      maxAge: Math.floor(sessionTtlMs / 1000),
      secure: secureCookies
    }));
  }

  function startSession(res, user) {
    const sessionId = randomToken();
    sessions.set(sessionId, {
      user: publicUser(user),
      expiresAt: Date.now() + sessionTtlMs
    });
    setSessionCookie(res, sessionId);
  }

  function clearAuthCookies(res) {
    appendSetCookie(res, serializeCookie(sessionCookieName, "", { maxAge: 0, secure: secureCookies }));
    appendSetCookie(res, serializeCookie(oauthCookieName, "", { maxAge: 0, secure: secureCookies }));
  }

  function requireAuth(req, res) {
    const session = sessionFromRequest(req);
    if (session) {
      req.user = session.user;
      return true;
    }

    if (req.url.startsWith("/api/")) {
      res.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({ error: "Authentication required." }));
      return false;
    }

    redirect(res, `/login?returnTo=${encodeURIComponent(req.url || "/")}`);
    return false;
  }

  async function requireAdmin(req, res) {
    const session = sessionFromRequest(req);
    if (session?.user?.role === "admin") {
      req.user = session.user;
      return true;
    }

    const tokenUser = await userForBearerToken(req);
    if (tokenUser?.role === "admin") {
      req.user = tokenUser;
      return true;
    }

    if (!session && !req.headers.authorization) {
      if (req.url.startsWith("/api/")) {
        res.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required." }));
      } else {
        redirect(res, `/login?returnTo=${encodeURIComponent(req.url || "/")}`);
      }
      return false;
    }

    res.writeHead(403, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify({ error: "Admin access required." }));
    return false;
  }

  function renderLogin(req, error = "") {
    const session = sessionFromRequest(req);
    if (session) {
      return null;
    }

    const url = new URL(req.url, baseUrl(req));
    const returnTo = url.searchParams.get("returnTo") || "/";
    const googleReady = providerEnabled(providers.google);
    const appleReady = appleEnabled(providers.apple);
    const localReady = localEnabled();
    const safeReturnTo = returnTo.startsWith("/") ? returnTo : "/";
    const setupMessage = googleReady || appleReady || localReady
      ? ""
      : "<p class=\"login-hint\">Authentication is enabled, but no provider credentials are configured yet.</p>";
    const errorMessage = error ? `<p class="login-error">${escapeHtml(error)}</p>` : "";
    const localForm = localReady
      ? `<form class="local-login" action="/auth/local" method="post">
          <input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo)}">
          <label>
            <span>Username or email</span>
            <input name="email" type="text" autocomplete="username" required>
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" required minlength="8">
          </label>
          <button type="submit">Continue</button>
          <p class="login-hint">Use a local account or a configured sign-in provider.</p>
        </form>`
      : "";

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in - LivBookReader</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body class="login-body">
    <main class="login-shell">
      <section class="login-panel" aria-labelledby="loginTitle">
        <p class="login-kicker">LivBookReader</p>
        <h1 id="loginTitle">Sign in to keep reading</h1>
        ${errorMessage}
        ${setupMessage}
        ${localForm}
        <div class="login-actions">
          <a class="login-button${googleReady ? "" : " is-disabled"}" href="/auth/google?returnTo=${encodeURIComponent(safeReturnTo)}" aria-disabled="${!googleReady}">Continue with Google</a>
          <a class="login-button${appleReady ? "" : " is-disabled"}" href="/auth/apple?returnTo=${encodeURIComponent(safeReturnTo)}" aria-disabled="${!appleReady}">Continue with Apple</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
  }

  async function fetchJwks(config) {
    const cached = jwksCache.get(config.jwksUri);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys;
    }

    const response = await fetch(config.jwksUri, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Could not fetch signing keys from ${config.name}.`);
    }

    const body = await response.json();
    jwksCache.set(config.jwksUri, {
      keys: body.keys || [],
      expiresAt: Date.now() + jwksTtlMs
    });
    return body.keys || [];
  }

  async function verifyIdToken({ token, provider, nonce }) {
    const config = providerConfig(provider);
    const { header, payload } = parseJwt(token);
    const keys = await fetchJwks(config);
    const jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      throw new Error("No matching ID token signing key was found.");
    }

    const supportedAlg = header.alg === "RS256" || header.alg === "ES256";
    if (!supportedAlg || !verifyJwtSignature(token, jwk, header.alg)) {
      throw new Error("ID token signature is invalid.");
    }

    validateClaims(payload, provider, config, nonce);
    return payload;
  }

  async function ensureUserDb() {
    if (!userDbReady) {
      userDbReady = (async () => {
        await mkdir(dataDir, { recursive: true });
        await runSql(usersDbPath, `
          pragma journal_mode = wal;
          create table if not exists users (
            id text primary key,
            provider text not null,
            provider_sub text not null,
            email text not null default '',
            email_verified integer not null default 0,
            name text not null default '',
            picture text not null default '',
            password_hash text not null default '',
            role text not null default 'user',
            created_at text not null,
            updated_at text not null,
            unique(provider, provider_sub)
          );
          create unique index if not exists users_local_email_unique
            on users(email)
            where provider = 'local';
          create table if not exists api_tokens (
            id text primary key,
            user_id text not null,
            token_hash text not null unique,
            name text not null default '',
            created_at text not null,
            last_used_at text,
            revoked_at text,
            foreign key(user_id) references users(id)
          );
        `);
        await addUserRoleColumnIfMissing();
        await migrateLegacyUsers();
        await removeBukadminUser();
        await ensureFirstUserAdmin();
      })();
    }

    await userDbReady;
  }

  async function addUserRoleColumnIfMissing() {
    const columns = await allRows(usersDbPath, "pragma table_info(users)");
    if (!columns.some((column) => column.name === "role")) {
      await runSql(usersDbPath, "alter table users add column role text not null default 'user'");
    }
  }

  async function removeBukadminUser() {
    await runSql(usersDbPath, "delete from users where provider = 'local' and provider_sub = 'bukadmin'");
  }

  async function ensureFirstUserAdmin() {
    const adminRows = await allRows(usersDbPath, "select count(*) as count from users where role = 'admin'");
    if ((adminRows[0]?.count || 0) > 0) {
      return;
    }

    await runSql(usersDbPath, `
      update users
      set role = 'admin'
      where id = (
        select id
        from users
        order by created_at asc, rowid asc
        limit 1
      )
    `);
  }

  async function migrateLegacyUsers() {
    const rows = await allRows(usersDbPath, "select count(*) as count from users");
    if ((rows[0]?.count || 0) > 0) {
      return;
    }

    const legacy = await readJsonFile(legacyUsersPath, null);
    if (!legacy?.users?.length) {
      return;
    }

    let isFirstImportedUser = true;
    for (const user of legacy.users) {
      await insertOrReplaceUser({
        id: user.id || randomToken(18),
        provider: user.provider,
        providerSub: user.providerSub,
        email: user.email || "",
        emailVerified: user.emailVerified === true,
        name: user.name || "",
        picture: user.picture || "",
        passwordHash: user.passwordHash || "",
        role: user.role || (isFirstImportedUser ? "admin" : "user"),
        createdAt: user.createdAt || new Date().toISOString(),
        updatedAt: user.updatedAt || new Date().toISOString()
      });
      isFirstImportedUser = false;
    }
  }

  async function insertOrReplaceUser(user) {
    await runSql(usersDbPath, `
      insert into users (
        id, provider, provider_sub, email, email_verified, name, picture, password_hash, role, created_at, updated_at
      ) values (
        ${sqlValue(user.id)},
        ${sqlValue(user.provider)},
        ${sqlValue(user.providerSub)},
        ${sqlValue(user.email)},
        ${sqlValue(user.emailVerified)},
        ${sqlValue(user.name)},
        ${sqlValue(user.picture)},
        ${sqlValue(user.passwordHash || "")},
        ${sqlValue(user.role || "user")},
        ${sqlValue(user.createdAt)},
        ${sqlValue(user.updatedAt)}
      )
      on conflict(provider, provider_sub) do update set
        email = excluded.email,
        email_verified = excluded.email_verified,
        name = excluded.name,
        picture = excluded.picture,
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at;
    `);
  }

  async function findUser(where) {
    await ensureUserDb();
    return findUserWithoutInit(where);
  }

  async function findUserWithoutInit(where) {
    const rows = await allRows(usersDbPath, userSelectSql(where));
    return rowToUser(rows[0]);
  }

  async function countUsers() {
    await ensureUserDb();
    const rows = await allRows(usersDbPath, "select count(*) as count from users");
    return rows[0]?.count || 0;
  }

  async function createApiToken(user, name = "") {
    await ensureUserDb();
    const token = `livbook_${randomToken(32)}`;
    const now = new Date().toISOString();
    const id = randomToken(18);

    await runSql(usersDbPath, `
      insert into api_tokens (
        id, user_id, token_hash, name, created_at
      ) values (
        ${sqlValue(id)},
        ${sqlValue(user.id)},
        ${sqlValue(tokenHash(token))},
        ${sqlValue(String(name || "").trim().slice(0, 120))},
        ${sqlValue(now)}
      )
    `);

    return {
      id,
      token,
      name: String(name || "").trim().slice(0, 120),
      createdAt: now
    };
  }

  async function userForBearerToken(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return null;
    }

    await ensureUserDb();
    const hash = tokenHash(match[1].trim());
    const rows = await allRows(usersDbPath, `
      select
        users.id,
        users.provider,
        users.provider_sub,
        users.email,
        users.email_verified,
        users.name,
        users.picture,
        users.password_hash,
        users.role,
        users.created_at,
        users.updated_at,
        api_tokens.id as token_id
      from api_tokens
      join users on users.id = api_tokens.user_id
      where api_tokens.token_hash = ${sqlValue(hash)}
        and api_tokens.revoked_at is null
      limit 1
    `);
    const row = rows[0];
    if (!row) {
      return null;
    }

    await runSql(usersDbPath, `
      update api_tokens
      set last_used_at = ${sqlValue(new Date().toISOString())}
      where id = ${sqlValue(row.token_id)}
    `);

    return publicUser(rowToUser(row));
  }

  async function saveUser(provider, claims, appleUserJson = "") {
    await ensureUserDb();
    const providerSub = String(claims.sub);
    let user = await findUser(`provider = ${sqlValue(provider)} and provider_sub = ${sqlValue(providerSub)}`);
    let appleUser = {};

    if (appleUserJson) {
      try {
        appleUser = JSON.parse(appleUserJson);
      } catch {
        appleUser = {};
      }
    }

    const nextUser = {
      id: user?.id || randomToken(18),
      provider,
      providerSub,
      email: claims.email || user?.email || appleUser.email || "",
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      name: claims.name || user?.name || [appleUser.name?.firstName, appleUser.name?.lastName].filter(Boolean).join(" "),
      picture: claims.picture || user?.picture || "",
      role: user?.role || ((await countUsers()) === 0 ? "admin" : "user"),
      updatedAt: new Date().toISOString(),
      createdAt: user?.createdAt || new Date().toISOString()
    };

    await insertOrReplaceUser(nextUser);
    return nextUser;
  }

  async function authenticateLocal(login, password) {
    const previousLocalAuth = localAuthQueue;
    let releaseLocalAuth;
    localAuthQueue = new Promise((resolve) => {
      releaseLocalAuth = resolve;
    });

    await previousLocalAuth;
    try {
      return await authenticateLocalLocked(login, password);
    } finally {
      releaseLocalAuth();
    }
  }

  async function authenticateLocalLocked(login, password) {
    if (!localEnabled()) {
      throw new Error("Local authentication is disabled.");
    }

    const normalizedLogin = normalizeLogin(login);
    validateLocalCredentials(normalizedLogin, password);

    await ensureUserDb();
    let user = await findUser(`provider = 'local' and email = ${sqlValue(normalizedLogin)}`);

    if (!user) {
      user = {
        id: randomToken(18),
        provider: "local",
        providerSub: normalizedLogin,
        email: normalizedLogin,
        emailVerified: true,
        name: normalizedLogin,
        picture: "",
        passwordHash: await hashPassword(password),
        role: (await countUsers()) === 0 ? "admin" : "user",
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
      await insertOrReplaceUser(user);
      return user;
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new Error("Invalid email or password.");
    }

    user.updatedAt = new Date().toISOString();
    await insertOrReplaceUser(user);
    return user;
  }

  async function exchangeCode({ provider, code, redirectUri }) {
    const config = providerConfig(provider);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: provider === "apple" ? createAppleClientSecret(config) : config.clientSecret
    });

    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body
    });

    const tokenResponse = await response.json();
    if (!response.ok || !tokenResponse.id_token) {
      throw new Error(tokenResponse.error_description || tokenResponse.error || "Could not exchange authorization code.");
    }

    return tokenResponse;
  }

  async function beginLogin(req, res, provider) {
    const config = providerConfig(provider);
    const url = new URL(req.url, baseUrl(req));
    const returnTo = url.searchParams.get("returnTo") || "/";
    const state = randomToken();
    const nonce = randomToken();
    const redirectUri = `${baseUrl(req)}/auth/${provider}/callback`;

    oauthStates.set(state, {
      provider,
      nonce,
      returnTo: returnTo.startsWith("/") ? returnTo : "/",
      redirectUri,
      expiresAt: Date.now() + oauthStateTtlMs
    });

    const authUrl = new URL(config.authorizationEndpoint);
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", config.scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("nonce", nonce);
    if (provider === "apple") {
      authUrl.searchParams.set("response_mode", "form_post");
    }

    appendSetCookie(res, serializeCookie(oauthCookieName, signCookie(sessionSecret, state), {
      maxAge: Math.floor(oauthStateTtlMs / 1000),
      secure: secureCookies
    }));
    redirect(res, authUrl.toString());
  }

  async function completeLogin(req, res, provider) {
    const cookies = parseCookies(req);
    const expectedState = verifyCookie(sessionSecret, cookies[oauthCookieName] || "");
    const params = req.method === "POST"
      ? new URLSearchParams(await readRequestBody(req))
      : new URL(req.url, baseUrl(req)).searchParams;
    const state = params.get("state") || "";
    const code = params.get("code") || "";
    const error = params.get("error") || "";

    if (error) {
      throw new Error(`Authentication failed: ${error}`);
    }
    if (!state || !code || !expectedState || state !== expectedState) {
      throw new Error("Authentication state is invalid.");
    }

    const oauthState = oauthStates.get(state);
    oauthStates.delete(state);
    if (!oauthState || oauthState.provider !== provider || oauthState.expiresAt < Date.now()) {
      throw new Error("Authentication state has expired.");
    }

    const tokenResponse = await exchangeCode({ provider, code, redirectUri: oauthState.redirectUri });
    const claims = await verifyIdToken({ token: tokenResponse.id_token, provider, nonce: oauthState.nonce });
    const user = await saveUser(provider, claims, params.get("user") || "");

    startSession(res, user);
    appendSetCookie(res, serializeCookie(oauthCookieName, "", { maxAge: 0, secure: secureCookies }));
    redirect(res, oauthState.returnTo || "/");
  }

  async function completeLocalLogin(req, res) {
    const params = new URLSearchParams(await readRequestBody(req));
    const returnTo = params.get("returnTo") || "/";
    const safeReturnTo = returnTo.startsWith("/") ? returnTo : "/";
    const user = await authenticateLocal(params.get("email") || "", params.get("password") || "");

    startSession(res, user);
    redirect(res, safeReturnTo);
  }

  async function readTokenRequestName(req) {
    if (Number(req.headers["content-length"] || 0) === 0) {
      return "";
    }

    const body = await readRequestBody(req);
    const contentType = req.headers["content-type"] || "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        return JSON.parse(body).name || "";
      } catch {
        throw Object.assign(new Error("Token request JSON is invalid."), { statusCode: 400 });
      }
    }

    return new URLSearchParams(body).get("name") || "";
  }

  async function handleAuth(req, res) {
    const url = new URL(req.url, baseUrl(req));

    if (req.method === "GET" && url.pathname === "/login") {
      const html = renderLogin(req);
      if (!html) {
        redirect(res, url.searchParams.get("returnTo") || "/");
      } else {
        sendHtml(res, 200, html);
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const session = sessionFromRequest(req);
      res.writeHead(session ? 200 : 401, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify(session ? { user: session.user } : { error: "Authentication required." }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/tokens") {
      try {
        if (!(await requireAdmin(req, res))) {
          return true;
        }

        const token = await createApiToken(req.user, await readTokenRequestName(req));
        res.writeHead(201, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify(token));
      } catch (error) {
        res.writeHead(error.statusCode || 500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify({ error: error.message || "Could not create API token." }));
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      const session = sessionFromRequest(req);
      if (session) {
        for (const [sessionId, storedSession] of sessions.entries()) {
          if (storedSession === session) {
            sessions.delete(sessionId);
            break;
          }
        }
      }
      clearAuthCookies(res);
      redirect(res, "/login");
      return true;
    }

    if (req.method === "POST" && url.pathname === "/auth/local") {
      try {
        await completeLocalLogin(req, res);
      } catch (error) {
        sendHtml(res, 400, renderLogin(req, error.message) || `<p>${escapeHtml(error.message)}</p>`);
      }
      return true;
    }

    const startMatch = url.pathname.match(/^\/auth\/(google|apple)$/);
    if (req.method === "GET" && startMatch) {
      await beginLogin(req, res, startMatch[1]);
      return true;
    }

    const callbackMatch = url.pathname.match(/^\/auth\/(google|apple)\/callback$/);
    if ((req.method === "GET" || req.method === "POST") && callbackMatch) {
      try {
        await completeLogin(req, res, callbackMatch[1]);
      } catch (error) {
        sendHtml(res, 400, renderLogin(req, error.message) || `<p>${escapeHtml(error.message)}</p>`);
      }
      return true;
    }

    return false;
  }

  return {
    handleAuth,
    requireAuth,
    requireAdmin
  };
}
