import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Works locally and on Render. Render injects DATABASE_URL from the managed
 * PostgreSQL service during build and runtime; no host or password is
 * hardcoded into the repository.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
  strict: true,
  verbose: true,
});
