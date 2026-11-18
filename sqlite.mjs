// Adapts local SQLite to the transactional statement interface used by the exporter.
export function sqliteBinding(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      const execute = (args) => () => statement.columns().length
        ? { results: statement.all(...args) }
        : { meta: { changes: statement.run(...args).changes } };
      return { execute: execute([]), bind: (...args) => ({ execute: execute(args) }) };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
