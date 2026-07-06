// ESLint flat config for the backend — minimal on purpose: eslint:recommended
// with no-unused-vars / no-undef tuned for our CommonJS + Node runtime. No
// style rules; formatting stays a human/diff concern.
//
// Run from backend/:  npm run lint
const js = require('@eslint/js');

// The Node/CommonJS globals this codebase actually uses (hand-listed instead
// of pulling in the `globals` package for a dozen names).
const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',           // Node 18+ global fetch (Stripe/Brevo/Supabase REST calls)
};

module.exports = [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      // Unused function ARGS are idiomatic here (Express (req, res, next)
      // signatures, destructured handler options) — flag variables only.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      // try { ... } catch {} guards around best-effort Stripe/email calls are
      // an established pattern in the webhook/routes code.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
