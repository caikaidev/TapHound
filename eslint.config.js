import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      ".build-tools/**",
      "eslint.config.js",
      "node_modules/**",
      "test/fixtures/bin/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error"
    }
  },
  {
    files: ["scripts/**/*.mjs", "assets/skills/**/scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked
  },
  {
    files: ["scripts/**/*.mjs", "assets/skills/**/scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off"
    }
  }
);
