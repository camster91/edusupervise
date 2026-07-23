import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.react-router/**',
      '**/coverage/**',
      'apps/mobile/expo-env.d.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // The existing codebase predates ESLint flat config and carries a
      // known unused-symbol backlog. TypeScript remains authoritative;
      // new cleanup can tighten this after the backlog is removed.
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
];
