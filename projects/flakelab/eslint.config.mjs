import hono from "@hono/eslint-config"
import sonarjs from "eslint-plugin-sonarjs"
import tseslint from "typescript-eslint"

export default [
  ...hono,
  sonarjs.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    rules: {
      complexity: ["error", 10],
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "bin/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      parserOptions: {
        ...tseslint.configs.disableTypeChecked.languageOptions?.parserOptions,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAnyKeyword",
          message: "Use a specific type instead of 'any'.",
        },
        {
          selector: "TSUnknownKeyword",
          message: "Use a specific type instead of 'unknown'.",
        },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", ".flakelab/**", "eslint.config.mjs"],
  },
]
