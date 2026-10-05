import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '_site/'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest' },
    rules: {
      'no-unused-vars': ['error', { args: 'all', caughtErrors: 'all' }],
      'no-shadow': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'consistent-return': 'warn',
      'require-await': 'warn',
    },
  },
  // Generator and tooling run on Node
  {
    files: ['**/*.{js,mjs}'],
    ignores: ['site/**'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
  // The landing page script runs in the browser as a classic <script>
  {
    files: ['site/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
];
