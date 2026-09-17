// No connection is created during normal analysis. Both server enablement and
// explicit session consent are required by the route before this is called.
export function aggregateRecord(analysis) {
  return {
    schema_version: analysis.schema_version,
    model_version: analysis.prediction.model_version,
    status: analysis.prediction.status,
    label: analysis.prediction.label,
    confidence: analysis.prediction.confidence,
    usable_rows: analysis.quality.usable_rows,
  };
}

export async function persistAggregate(analysis, env = process.env) {
  if (env.ENABLE_AGGREGATE_ANALYTICS !== "true")
    throw new Error("Aggregate analytics disabled");
  const table = env.SNOWFLAKE_ANALYTICS_TABLE || "TRADEPERSONA_AGGREGATES";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(table))
    throw new Error("Invalid analytics table");
  for (const key of [
    "ACCOUNT",
    "USERNAME",
    "PASSWORD",
    "DATABASE",
    "SCHEMA",
    "WAREHOUSE",
  ]) {
    if (!env[`SNOWFLAKE_${key}`])
      throw new Error("Aggregate analytics configuration missing");
  }
  const { default: snowflake } = await import("snowflake-sdk");
  snowflake.configure({ logLevel: "OFF" });
  const connection = snowflake.createConnection({
    account: env.SNOWFLAKE_ACCOUNT,
    username: env.SNOWFLAKE_USERNAME,
    password: env.SNOWFLAKE_PASSWORD,
    database: env.SNOWFLAKE_DATABASE,
    schema: env.SNOWFLAKE_SCHEMA,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    timeout: 10_000,
  });
  try {
    await new Promise((resolve, reject) =>
      connection.connect((error) => (error ? reject(error) : resolve())),
    );
    const record = aggregateRecord(analysis);
    await new Promise((resolve, reject) =>
      connection.execute({
        sqlText: `INSERT INTO ${table} (CREATED_AT, SCHEMA_VERSION, MODEL_VERSION, STATUS, LABEL, CONFIDENCE, USABLE_ROWS) VALUES (CURRENT_TIMESTAMP(), ?, ?, ?, ?, ?, ?)`,
        binds: Object.values(record),
        complete: (error) => (error ? reject(error) : resolve()),
      }),
    );
  } finally {
    await new Promise((resolve) => connection.destroy(() => resolve()));
  }
}
