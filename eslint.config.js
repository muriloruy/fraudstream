// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.lighthouseci/**',
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '.nx/**',
      'apps/web/src/lib/api-types.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md: no `any`, ever.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // NestJS modules are empty classes carrying a @Module() decorator.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // SPEC §7: parameterized SQL only. Interpolating values into a SQL string
      // passed to `.query()` is the classic injection vector, so forbid it outright.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='query'] > TemplateLiteral.arguments[expressions.length>0]",
          message:
            'Do not interpolate values into SQL. Use parameterized queries ($1, $2, ...) instead (SPEC §7).',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/__fixtures__/**/*.ts'],
    rules: {
      // Test fixtures are read from known, repository-local paths.
      'security/detect-non-literal-fs-filename': 'off',
      // Tests index fixtures with typed, literal keys; the rule cannot see that.
      'security/detect-object-injection': 'off',
    },
  },
  {
    // CLI scripts read and write fixed paths inside the repository.
    files: ['scripts/**/*.ts'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  {
    // Dashboard (SPEC §8.3): browser code, React hooks rules and accessibility lint.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.strict.rules,
      // Scrollable regions must be keyboard-focusable to be scrolled (WCAG 2.1.1, axe
      // scrollable-region-focusable), so a labelled region may take tabIndex={0}.
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'], tags: [] }],
      // JSX event handlers commonly return promises from mutations.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    files: ['apps/web/**/*.test.{ts,tsx}', 'apps/web/e2e/**/*.ts', 'apps/web/scripts/**/*.ts'],
    rules: {
      'security/detect-object-injection': 'off',
      // e2e scripts read and write fixed paths inside the repository.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
