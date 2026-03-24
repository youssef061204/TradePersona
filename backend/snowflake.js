import snowflake from "snowflake-sdk";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export async function getConnection({
  database = process.env.SNOWFLAKE_DATABASE,
  schema = process.env.SNOWFLAKE_SCHEMA,
  warehouse = process.env.SNOWFLAKE_WAREHOUSE,
} = {}) {
  // These must exist:
  const account = required("SNOWFLAKE_ACCOUNT");
  const username = required("SNOWFLAKE_USERNAME");
  const password = required("SNOWFLAKE_PASSWORD");

  // These should exist for predictable behavior:
  if (!database) throw new Error("Missing SNOWFLAKE_DATABASE (or pass database to getConnection)");
  if (!schema) throw new Error("Missing SNOWFLAKE_SCHEMA (or pass schema to getConnection)");
  if (!warehouse) throw new Error("Missing SNOWFLAKE_WAREHOUSE");

  const conn = snowflake.createConnection({
    account,
    username,
    password,
    warehouse,
    database,
    schema,
  });

  return new Promise((resolve, reject) => {
    conn.connect((err) => (err ? reject(err) : resolve(conn)));
  });
}
