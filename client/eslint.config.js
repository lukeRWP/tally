// Client lint gate (#350). Mirrors the server config's shape: recommended
// rule sets, unused-vars as a warning with the `_` escape hatch, and nothing
// stylistic — formatting is not a CI concern here. tsc already enforces
// noUnusedLocals/noUnusedParameters (tsconfig), so the TS unused-vars rule is
// off to avoid double-reporting the same line.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'tsconfig.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Only the classic pair. react-hooks v7's `recommended` also enables
      // ~14 React-Compiler-backed rules (immutability, purity, refs, …) whose
      // dataflow pass exhausts a 2 GB heap on pages/print-queue.tsx in ~14 s;
      // these two lint the same file in under a second.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Vitest files run in node + jsdom; the config file itself is plain node.
    files: ['**/*.test.{ts,tsx}', 'vite.config.ts', 'src/test/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  }
);
