import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/unit/**/*.spec.ts", "tests/integration/**/*.spec.ts"],
  },
});
