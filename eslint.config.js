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

  // 两条华为扫描规则的本地位：G.FMT.12（语句末尾必须有分号）与 G.NAM.03
  // （变量小驼峰）。eslint-config-prettier 会关掉 semi，所以这段必须排在
  // skipFormatting 之后；oxlint 不实现 semi / camelcase，只能由 eslint 兜。
  // camelcase 默认不检查全大写常量（MAX_COUNT 之类），与扫描器行为一致。
  {
    name: 'app/huawei-style',
    rules: {
      semi: ['error', 'always'],
      camelcase: 'error',
    },
  },
]);
