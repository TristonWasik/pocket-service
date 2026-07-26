import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime/worker-thread.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  outDir: "dist",
});
