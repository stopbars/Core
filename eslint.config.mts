import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import { fileURLToPath } from 'node:url';

export default defineConfig([
	{
		ignores: [
			'**/worker-configuration.d.ts',
			'.wrangler/**',
			'**/.wrangler/**',
			'node_modules/**',
			'dist/**',
			'build/**',
			'coverage/**',
			'.git/**',
			'.vscode/**',
			'.idea/**',
		],
	},

	{ files: ['**/*.{js,mjs,cjs,ts,mts,cts}'], plugins: { js }, extends: ['js/recommended'], languageOptions: { globals: globals.browser } },
	tseslint.configs.recommended,
	{ languageOptions: { parserOptions: { tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)) } } },
]);
