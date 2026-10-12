// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.nx/**'],
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
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
