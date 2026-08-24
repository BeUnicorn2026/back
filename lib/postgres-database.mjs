import pg from "pg";

const { Pool } = pg;
const databases = new Set();

export class PostgresDatabase {
  constructor(options = {}) {
    if (!options.connectionString && !options.pool) throw new Error("PostgreSQL에는 DATABASE_URL이 필요합니다.");
    this.pool = options.pool || new Pool({
      connectionString: options.connectionString,
      max: Number(options.maximumConnections) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: false
    });
    this.ownsPool = !options.pool;
    databases.add(this);
  }

  query(text, values = []) {
    return this.pool.query(text, values);
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck() {
    const result = await this.query("SELECT 1 AS ready");
    return Number(result.rows[0]?.ready) === 1;
  }

  async close() {
    databases.delete(this);
    if (this.ownsPool) await this.pool.end();
  }
}

export async function closePostgresDatabases() {
  await Promise.all([...databases].map((database) => database.close()));
}
