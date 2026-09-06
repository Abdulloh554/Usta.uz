module.exports = {
  root: true,
  env: { node: true, es2022: true, jest: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { project: './tsconfig.json', tsconfigRootDir: __dirname, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'airbnb-base',
    'airbnb-typescript/base',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'prettier',
  ],
  rules: {
    // The codebase is ESM-style TypeScript compiled to CommonJS; default
    // exports make refactoring and tree-shaking worse, so every module uses
    // named exports and this rule would only ever fire on single-export files.
    'import/prefer-default-export': 'off',
    'import/extensions': ['error', 'ignorePackages', { ts: 'never' }],
    'no-underscore-dangle': ['error', { allow: ['_id', '__v'] }],
    'no-void': ['error', { allowAsStatement: true }],
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

    /*
     * Enums are modelled as a frozen object plus a type of the same name — the
     * standard alternative to `enum`, which TypeScript itself discourages. A
     * type and a value occupy different declaration spaces, so this is legal and
     * intentional, but the rule counts it as a redeclaration and its
     * `ignoreDeclarationMerge` option does not cover the const + type pair.
     */
    '@typescript-eslint/no-redeclare': 'off',

    /*
     * Comparisons like `mongoose.connection.readyState === 1` and
     * `redis.status === 'ready'` read a library's own state field against the
     * literal its documentation specifies. The rule sees an enum on one side
     * only and cannot tell these apart from a genuine mismatch.
     */
    '@typescript-eslint/no-unsafe-enum-comparison': 'off',

    /*
     * Deliberately off: this rule cannot tell that a merged `const X` + `type X`
     * needs a *value* import, and its autofixer rewrites those to `import type`,
     * which breaks the build. The pattern is used throughout `common/types`, so
     * the rule is a net liability here.
     */
    '@typescript-eslint/consistent-type-imports': 'off',

    // The error hierarchy in `common/errors` and the provider adapters in
    // `config/` are each one concept; splitting them across files to satisfy a
    // count would make them harder to read, not easier.
    'max-classes-per-file': 'off',

    // Some loops must be sequential: the job-code retry has to see whether the
    // previous attempt collided, and a Redis SCAN cursor is serial by nature.
    'no-await-in-loop': 'off',
  },
  overrides: [
    {
      // Socket.IO has no supported way to carry per-connection data other than
      // attaching it to the socket, which is what the auth middleware does.
      files: ['src/sockets/index.ts'],
      rules: { 'no-param-reassign': ['error', { props: false }] },
    },
    {
      // Provider adapters implement an interface, so a method that happens not
      // to touch `this` or `await` is still the right shape.
      files: ['src/config/*.ts'],
      rules: {
        'class-methods-use-this': 'off',
        '@typescript-eslint/require-await': 'off',
      },
    },
    {
      files: ['tests/**/*.ts'],
      rules: {
        'import/no-extraneous-dependencies': 'off',
        'no-restricted-syntax': 'off',
        'no-plusplus': 'off',
        // The Redis fake mirrors ioredis's async signatures even where the
        // in-memory implementation needs no await.
        '@typescript-eslint/require-await': 'off',
        'class-methods-use-this': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', 'coverage', 'jest.config.js', '.eslintrc.cjs'],
};
