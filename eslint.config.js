import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  { files: ['apps/web/**/*.{ts,tsx}'], languageOptions: { globals: { window: 'readonly', document: 'readonly', navigator: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } } }
);
