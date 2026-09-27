// Flat ESLint config for the whole pnpm workspace (spec 43).
//
// Type-aware linting is deliberately NOT used: the dashboard and the API have
// separate tsconfigs, and a single type-aware run would either skip the
// dashboard or report cross-project errors that the typecheck already owns.
// This file is .mjs rather than .js so it is unambiguously ESM regardless of
// the root package.json "type" field.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/*.d.ts',
  '**/vite.config.ts',
  '**/drizzle.config.ts',
  // Editor/agent scratch checkouts that live inside the repo but are not part
  // of this project. Linting a stale copy of the workspace reports errors that
  // belong to code nobody is shipping.
  '.kilo/**',
  '.git/**',
];

export default tseslint.config(
  { ignores },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- Node / TypeScript: the API, the packages, and the test harness -------
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // Unused args are common in hooks and framework callbacks; a leading
      // underscore marks the deliberate ones.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // any is allowed only where a third-party type is genuinely untyped;
      // everywhere else the compiler's own inference is the safer default.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-return-await': 'error',
    },
  },

  // --- Browser / React: the dashboard --------------------------------------
  // Same TypeScript rules plus JSX parsing. eslint-plugin-react is not
  // installed, so the hook rules are unavailable; this scope enforces the
  // correctness rules that do not need the plugin.
  {
    files: ['apps/dashboard/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser },
    },
    rules: {
      // TypeScript resolves identifiers; the base config's no-undef does not
      // understand the TS type/namespace split.
      'no-undef': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // --- Test files ---------------------------------------------------------
  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // --- CLI entry points and config files ---------------------------------
  {
    files: [
      'packages/database/src/migrate.ts',
      'packages/database/src/seed.ts',
      'scripts/**/*',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
    rules: { 'no-console': 'off' },
  },
);
