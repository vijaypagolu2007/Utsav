import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // The original demo script is kept byte-for-byte; it pokes at error payloads with `as any`.
  { files: ["src/demo.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"]),
]);
