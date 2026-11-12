import { readFileSync } from 'node:fs';
import typescript from '@rollup/plugin-typescript';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/** 把源码里的 __LOG_PANEL_VERSION__ 替换成 package.json 的版本号 */
function injectVersion() {
  return {
    name: 'inject-version',
    transform(code) {
      if (code.indexOf('__LOG_PANEL_VERSION__') < 0) return null;
      return { code: code.replace(/__LOG_PANEL_VERSION__/g, pkg.version), map: null };
    },
  };
}

const banner = `/*! ${pkg.name} v${pkg.version} | 支付宝小游戏 console 日志面板 */`;

export default {
  input: 'src/index.ts',
  output: {
    // 文件名带版本号，方便在真机上确认跑的是哪一版
    file: `dist/log-panel-${pkg.version}.umd.js`,
    format: 'umd',
    name: 'LogPanel',
    exports: 'default',
    banner,
  },
  plugins: [typescript({ tsconfig: './tsconfig.json' }), injectVersion()],
};
