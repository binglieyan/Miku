import { defineConfig } from 'eslint/config';
import globals from 'globals';
import js from '@eslint/js';
import pluginOxlint from 'eslint-plugin-oxlint';
import skipFormatting from 'eslint-config-prettier/flat';

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

  // 只有 eslint 能提供的两条规则：semi（分号属于格式化，oxlint 不实现格式化
  // 规则）与 camelcase（oxlint 无此规则）。eslint-config-prettier 会关掉
  // semi，所以本块必须排在 skipFormatting 之后；camelcase 默认不检查全大写
  // 常量（MAX_COUNT 之类）。
  {
    name: 'app/eslint-only-style',
    rules: {
      semi: ['error', 'always'],
      camelcase: 'error',
    },
  },
]);
