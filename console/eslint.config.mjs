import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      // wasm-bindgen output (built by infra/build-mint-engine.sh)
      "public/mint-engine/**",
      "public/mint-engine-mt/**",
      "public/verify-engine/**",
    ],
  },
];

export default config;
