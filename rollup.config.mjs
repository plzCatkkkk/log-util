import { readFileSync } from 'node:fs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

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
  plugins: [
    typescript({ tsconfig: './tsconfig.json' }),
    injectVersion(),
    // 压缩 + 混淆标识符：产物变小，同时让堆栈里的内部变量名失去可读性。
    // 注意不能开 drop_console：面板本身要靠输出 console 日志来工作
    terser({
      ecma: 2015,
      compress: {
        ecma: 2015,
        passes: 3,
        booleans_as_integers: false,
        drop_debugger: true,
        // 关掉这些会改变语义或吞掉日志的选项
        drop_console: false,
        unsafe: false,
        unsafe_arrows: false,
        unsafe_methods: false,
      },
      mangle: {
        toplevel: true,
        // 属性名不动：面板要读写宿主对象（my.*、canvas、ctx）
        properties: false,
      },
      format: {
        ecma: 2015,
        // 只保留 banner 这种 /*! ... */ 注释
        comments: /^!/,
      },
    }),
  ],
};
