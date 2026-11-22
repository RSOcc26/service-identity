// Minimal stand-in for a pg pool: answers queries by matching the SQL text
// and records every statement, so tests can check what was written.
export const fakeDb = (handlers = []) => {
  const log = [];
  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    log.push({ sql: text, params });
    for (const [pattern, respond] of handlers) {
      if (pattern.test(text)) return { rows: (await respond(params, text)) ?? [] };
    }
    return { rows: [] };
  };
  return {
    log,
    query,
    connect: async () => ({ query, release() {} }),
    statements: (pattern) => log.filter((q) => pattern.test(q.sql)),
  };
};

export const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
