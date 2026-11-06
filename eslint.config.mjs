// Only the checks that find real mistakes: names used but never defined (a missing import), and values never used.
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'out/**', 'app/vendor/**', 'models/**', 'site/gallery/**'] },
  {
    files: ['app/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node, OffscreenCanvas: 'readonly', ImageData: 'readonly' } },
  },
  {
    files: ['electron/**/*.cjs', 'build/**/*.cjs', 'electron/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
];
