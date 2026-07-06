const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const configuredLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const minimumLevel = levels[configuredLevel] ?? levels.info;
const prettyLogs = process.env.LOG_FORMAT === "pretty";
const redactKeys = /authorization|cookie|password|secret|token|key|pass/i;

function shouldLog(level) {
  return (levels[level] ?? levels.info) >= minimumLevel;
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const safe = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    safe[key] = redactKeys.test(key) ? "[redacted]" : redact(nestedValue);
  }
  return safe;
}

function serializeError(error) {
  if (!error) {
    return undefined;
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code,
    statusCode: error.statusCode,
    stack: error.stack
  };
}

function write(level, message, fields = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...redact(fields)
  };

  if (fields.error instanceof Error) {
    entry.error = serializeError(fields.error);
  }

  if (prettyLogs) {
    const details = { ...entry };
    delete details.time;
    delete details.level;
    delete details.message;
    const suffix = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[${entry.time}] ${level.toUpperCase()} ${message}${suffix}`);
    return;
  }

  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](JSON.stringify(entry));
}

export function createLogger(context = {}) {
  const childContext = redact(context);

  return {
    debug(message, fields) {
      write("debug", message, { ...childContext, ...fields });
    },
    info(message, fields) {
      write("info", message, { ...childContext, ...fields });
    },
    warn(message, fields) {
      write("warn", message, { ...childContext, ...fields });
    },
    error(message, fields) {
      write("error", message, { ...childContext, ...fields });
    },
    child(nextContext = {}) {
      return createLogger({ ...childContext, ...nextContext });
    }
  };
}
