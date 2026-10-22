import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import tsParser from '@typescript-eslint/parser'

export default [
  {
    // `tools/.build` holds generated bundles plus *downloaded* third-party source files used by the
    // real-source diagnostics. They are not our code, so linting them only produces noise (and
    // noise is how a real warning gets ignored).
    ignores: ['out/**', 'release/**', 'node_modules/**', 'tools/.build/**'],
  },
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: { vue },
    rules: {
      ...vue.configs['flat/recommended'][0].rules,
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
    },
  },
]
