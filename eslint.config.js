import { defineConfig } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import pluginOxlint from 'eslint-plugin-oxlint'
import skipFormatting from 'eslint-config-prettier/flat'

export default defineConfig([
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,mjs,jsx}'],
  },

  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  js.configs.recommended,

  ...pluginOxlint.buildFromOxlintConfigFile('.oxlintrc.json'),

  skipFormatting,
])
