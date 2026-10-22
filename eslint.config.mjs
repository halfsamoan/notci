export default [{
    files: ['extension/**/*.js'],
    languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        globals: {
            global: 'readonly', console: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
            imports: 'readonly', log: 'readonly', logError: 'readonly',
            setTimeout: 'readonly', clearTimeout: 'readonly',
        },
    },
    rules: {
        'no-undef': 'error',
        'no-unused-vars': ['warn', {args: 'none', caughtErrorsIgnorePattern: '^_',
            argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
    },
}];
