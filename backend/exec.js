export function exec(conn, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => {
        if (err) {
          console.error("\n--- SNOWFLAKE ERROR ---");
          console.error("Message:", err.message);
          console.error("Code:", err.code, "SQLState:", err.sqlState);
          console.error("QueryId:", err.data?.queryId);
          console.error("\n--- SQL ---\n" + sqlText);
          console.error("\n--- BINDS ---\n", binds);
          console.error("\n--- CONNECTION CONTEXT ---");
          try {
            // stmt may exist even on error sometimes
            if (stmt?.getSqlText) console.error("Stmt SQL:", stmt.getSqlText());
          } catch {}
          return reject(err);
        }
        resolve(rows || []);
      },
    });
  });
}
