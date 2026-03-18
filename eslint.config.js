import js from "@eslint/js";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "examples/**",
      ".worktrees/**",
      ".opencode/**",
      "src/ui/**",
      "*.config.ts",
      "*.config.js",
      "thoughts/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      sonarjs,
      unicorn,
    },
    rules: {
      // --- Disable rules that overlap with Biome or conflict with codebase ---
      indent: "off",
      quotes: "off",
      semi: "off",
      "comma-dangle": "off",
      "no-unused-vars": "off",
      "sort-imports": "off",
      "no-multiple-empty-lines": "off",
      "eol-last": "off",

      // --- Empty blocks and class prohibition ---
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ClassDeclaration:not([superClass.name='Error'])",
          message: "No classes for business logic. Use factory functions with closed-over state.",
        },
      ],

      // --- Structural limits ---
      "max-depth": ["error", 2],
      "max-lines-per-function": ["error", { max: 40, skipBlankLines: true, skipComments: true }],

      // --- TypeScript-specific ---
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      // OFF: OpenCode plugin framework requires async signatures even for sync hooks
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "default", format: ["camelCase"], leadingUnderscore: "allow" },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE", "snake_case", "PascalCase"],
          leadingUnderscore: "allow",
          filter: {
            regex: "(Map|Object|String|Array|List|Set|Dict|Number|Boolean|Fn|Func|Callback)$",
            match: false,
          },
        },
        {
          selector: "function",
          format: ["camelCase"],
          filter: {
            regex: "(Map|Object|String|Array|List|Set|Dict|Number|Boolean|Fn|Func|Callback)$",
            match: false,
          },
        },
        {
          selector: "parameter",
          format: ["camelCase"],
          leadingUnderscore: "allow",
          filter: {
            regex: "(Map|Object|String|Array|List|Set|Dict|Number|Boolean|Fn|Func|Callback)$",
            match: false,
          },
        },
        { selector: "typeLike", format: ["PascalCase"] },
        {
          selector: "objectLiteralProperty",
          format: null,
        },
        {
          selector: "objectLiteralMethod",
          format: null,
        },
        {
          selector: "typeProperty",
          format: null,
        },
        {
          selector: "typeMethod",
          format: null,
        },
      ],
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          ignore: [0, 1, -1, 2],
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "sonarjs/sonar-prefer-optional-chain": "off",

      // --- Sonarjs (complexity and duplication) ---
      "sonarjs/cognitive-complexity": ["error", 10],
      "sonarjs/no-duplicate-string": ["error", { threshold: 3 }],
      "sonarjs/no-identical-functions": "error",

      // --- Unicorn (patterns) ---
      "unicorn/no-nested-ternary": "error",
    },
  },
  {
    // Relax rules for test files
    files: ["tests/**/*.ts", "src/**/*.test.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/prefer-readonly": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-identical-functions": "off",
      "sonarjs/cognitive-complexity": "off",
      "max-depth": "off",
      "max-lines-per-function": "off",
    },
  },
];
