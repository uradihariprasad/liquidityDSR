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
    url: process.env.DATABASE_URL ?? "postgresql://trading_e9kp_user:JkHpR7enrsOYLXAvgMmhuIQvQNzIKkCk@dpg-dbf2vqnavr4c73ckmdv0-a/trading_e9kp",
  },
  strict: true,
  verbose: true,
});
