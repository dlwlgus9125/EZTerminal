import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    workspace: [
      {
        // Unit tests — no DOM, pure Node.js logic
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.spec.ts"],
          environment: "node",
        },
      },
      {
        // Component tests — jsdom environment for React
        extends: true,
        test: {
          name: "component",
          include: ["tests/component/**/*.test.tsx", "tests/component/**/*.spec.tsx"],
          environment: "jsdom",
          setupFiles: ["tests/helpers/setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules", "tests/mocks/**", "tests/helpers/**"],
    },
  },
});
