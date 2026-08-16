import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'off',
      eqeqeq: ['error', 'smart'],
      'no-console': 'error',
    },
  },
  {
    files: ['prisma/seed.ts', 'src/jobs/**/*.ts', 'src/server.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
