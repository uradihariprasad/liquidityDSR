import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("responsive application shell contract", () => {
  const terminal = read("src/components/Terminal.tsx");
  const css = read("src/app/globals.css");
  const workspace = read("src/components/panels/WorkspacePanel.tsx");
  const scanner = read("src/components/panels/ScannerPanel.tsx");

  it("uses dynamic viewport height instead of legacy fixed mobile vh", () => {
    expect(terminal).toContain("h-[100dvh]");
  });

  it("changes the desktop rail to horizontal mobile navigation", () => {
    expect(terminal).toContain("flex-row lg:flex-col");
    expect(terminal).toContain("overflow-x-auto");
    expect(terminal).toContain("mobile-nav");
  });

  it("provides full-width mobile search and viewport-safe results", () => {
    expect(terminal).toContain("w-full sm:w-auto");
    expect(terminal).toContain("fixed sm:absolute");
    expect(terminal).toContain("max-h-[55dvh]");
  });

  it("stacks the synchronized workspace and uses responsive metric columns", () => {
    expect(workspace).toContain("flex-col xl:flex-row");
    expect(workspace).toContain("grid-cols-2 sm:grid-cols-3 xl:grid-cols-6");
    expect(workspace).toContain("w-full xl:w-[360px]");
  });

  it("stacks scanner candidates on phones and expands progressively", () => {
    expect(scanner).toContain("grid-cols-1 lg:grid-cols-2");
    expect(scanner).toContain("grid-cols-1 sm:grid-cols-2 xl:grid-cols-4");
  });

  it("supports notches, momentum scrolling and coarse pointer targets", () => {
    expect(css).toContain("env(safe-area-inset-left)");
    expect(css).toContain("-webkit-overflow-scrolling: touch");
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain("min-height: 44px");
  });

  it("prevents iOS input focus zoom on phones", () => {
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*font-size: 16px/);
  });
});

describe("Render deployment contract", () => {
  const render = read("render.yaml");
  const drizzle = read("drizzle.config.ts");
  const health = read("src/app/api/health/route.ts");

  it("ships a Render Blueprint with web service and PostgreSQL", () => {
    expect(existsSync("render.yaml")).toBe(true);
    expect(render).toContain("type: web");
    expect(render).toContain("databases:");
    expect(render).toContain("pulsegrid-db");
  });

  it("runs schema push and production build during deploy", () => {
    expect(render).toContain("npx drizzle-kit push --force");
    expect(render).toContain("npm run build");
    expect(render).toContain("startCommand: npm run start");
  });

  it("connects DATABASE_URL from the managed database", () => {
    expect(render).toContain("property: connectionString");
    expect(drizzle).toContain("process.env.DATABASE_URL");
  });

  it("keeps the Upstox token as a user-supplied Render secret", () => {
    expect(render).toMatch(/UPSTOX_ACCESS_TOKEN[\s\S]*sync: false/);
    expect(render).not.toMatch(/UPSTOX_ACCESS_TOKEN\s*\n\s*value:/);
  });

  it("declares the application health endpoint", () => {
    expect(render).toContain("healthCheckPath: /api/health");
    expect(health).toContain("ok: true");
  });
});
