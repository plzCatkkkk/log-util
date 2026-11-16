# log-util

支付宝小游戏里的 console 日志面板。打包成一个 UMD 单文件，加载即生效，不需要改引擎代码，也不依赖 DOM。

面板全部用 Canvas 2D 手绘（小游戏没有 DOM），通过 `my.createCanvas` 创建离屏画布，再上传纹理贴到屏幕上，因此可以叠在 Cocos 等引擎画面之上；同时自己接管触摸，做命中检测与滚动。

## 特性

- **加载即用**：`game.js` 第一行加载就自动开始拦截，引擎初始化、SDK、资源加载的日志都能抓到；UI 等宿主上屏 canvas 就绪后再挂载，不抢「第一个 canvas」的名额
- **console + 网络**：拦截 `console.log/info/warn/error/debug` 与 `my.request`，四个日志级别 + 独立的 `net` tab
- **分层过滤**：排除词在拦截层整条丢弃，筛选词在展示层过滤（能翻到筛选前已存下的历史），显示上限只限制渲染条数
- **长文本友好**：单条日志默认收起为 4 行，点击展开全部；`%c` 富文本按样式分段绘制
- **排除词持久化**：面板里增删的排除词写入本地存储，重启后继续生效
- **设置可调**：`设置` 弹窗里能改折叠行数、字号、时间戳、跟随最新、内存/显示/网络条数上限、像素比，全部落盘
- **开销可控**：视口裁剪只画可见行，数据驱动重绘限速 50ms，触摸交互走 `requestAnimationFrame` 保持跟手；画布像素比默认封顶 2

## 快速开始

把 `dist/log-panel-<version>.umd.js` 放进项目（例如 `assets/lib/`），在游戏入口最前面加载：

```js
// game.js
require('./assets/lib/log-panel-1.0.0.umd.js');
```

加载后会立即开始拦截并自动挂出一个可拖拽的悬浮按钮，点开即面板。无需任何 init 调用。

需要自定义时：

```js
LogPanel.init({
  maxLogs: 1000,       // 内存里保留多少条
  displayLimit: 300,   // 面板最多往回显示多少条
  includeKeywords: ['[BATTLE]'],
});
```

`init` 可以重复调用，只补充本次传入的字段，不会重置已有配置。

小游戏里第一个 canvas 通常被引擎占用。如果你用的是 Cocos，`web-adapter` 会先把上屏 canvas 建好，插件会自动等待并复用；没有引擎占位时则自己创建。两个都取不到时，可以通过 `init({ canvas })` 显式传入一个可用的 2D canvas。

想关掉自动初始化（改为完全手动控制），要在加载本文件**之前**设置：

```js
globalThis.__LOG_PANEL_AUTO_INIT__ = false;
require('./assets/lib/log-panel-1.0.0.umd.js');
globalThis.LogPanel.init({ open: true });
```

## 面板操作

| 操作 | 说明 |
| --- | --- |
| 拖拽悬浮按钮 | 移动按钮位置，位置会被限制在屏幕内 |
| 点击悬浮按钮 | 打开 / 收起面板 |
| 顶部 tab | `全部` / `log` / `info` / `warn` / `error` / `net`，当前级别的条数显示在标题栏 |
| `设置` 按钮 | 打开设置弹窗，分「显示 / 容量 / 词表」三页；点一行切换取值，点词右侧 `×` 删除 |
| `清空` 按钮 | 清空内存里的日志和网络记录 |
| 上下滑动 | 滚动列表 |
| 点击日志 | 内容超过折叠行数时展开 / 收起，点短日志不会有反应 |
| `net` tab 点击卡片 | 展开请求/响应详情（method、url、状态码、耗时、头部、body） |

标题栏的计数规则：

- `1000`：全部日志都在显示
- `300/1000`：显示上限截断，正在显示最新的 300 条，内存里共 1000 条
- `111/1000`：有筛选词，1000 条历史里命中 111 条
- 切到具体级别 tab 时是「该级别命中数 / 命中总数」

`net` tab 顶部还会显示在线状态、网络类型，以及进行中的请求数。

## 面板设置

标题栏的 `设置` 弹窗分三页，点一行就在候选值之间循环切换：

| 分页 | 设置项 | 取值 | 说明 |
| --- | --- | --- | --- |
| 显示 | 收起行数 | `4 行` / `8 行` / `不折叠` | 长日志收起时显示几行，改小能省测量开销 |
| 显示 | 字号 | `11px` / `12px` / `14px` | 全局面板字号 |
| 显示 | 时间戳 | `开` / `关` | 是否在行首画 `[hh:mm:ss]` 前缀 |
| 显示 | 跟随最新 | `开` / `关` | 关掉后新日志进来不会把画面顶走，方便停在老日志上看 |
| 容量 | 内存上限 | `300` / `1000` / `3000` 条 | 调小会立刻丢掉最旧的日志 |
| 容量 | 显示上限 | `100` / `300` / `500` / `1000` 条 | 只限制渲染条数，历史仍留在内存里 |
| 容量 | 网络记录 | `50` / `100` / `200` 条 | `net` tab 保留多少条 |
| 容量 | 像素比 | `1x` / `2x` / `原生` | 画布像素比上限，改完按新尺寸重建画布 |
| 词表 | 筛选词 / 排除词 | - | 见下方「筛选词」「排除词」两节 |

所有设置都会**写入本地存储**，key 为 `__LOG_PANEL_SETTINGS__`，重启后自动恢复。容量类设置会立刻作用到仓库（调小内存上限会丢日志），显示类设置会作废换行缓存并重绘。

启动时的取值顺序是「本地设置 → 代码里的 `init` 选项 → 内置默认值」：只要本地存过设置，就以本地为准；没存过才用 `init` 里传的 `maxLogs` / `displayLimit` / `maxNetRecords` / `maxPixelRatio` 作为初始值。想回到默认值，清掉这个 key 即可。

## API

```js
LogPanel.version          // 产物版本号，构建时注入
LogPanel.init(options)    // 补充配置，可重复调用
LogPanel.show()           // 打开面板
LogPanel.hide()           // 收起面板
LogPanel.toggle()         // 切换
LogPanel.isOpen()         // 是否打开
LogPanel.clear()          // 清空日志与网络记录
LogPanel.net()            // 取网络记录快照（只读）
LogPanel.destroy()        // 解绑拦截、触摸与画布，恢复原始 console / my.request
```

### 条数上限

```js
LogPanel.setMaxLogs(500);        // 内存上限，超出立即丢弃最旧的
LogPanel.setDisplayLimit(300);   // 只影响渲染，内存里的历史不变
```

这两个接口和面板里的「容量」设置是同一份数据：调用后会落盘，面板打开时设置弹窗里显示的也是新值。

两者的区别：

| 项 | 默认值 | 作用 |
| --- | --- | --- |
| `maxLogs` | `1000` | 内存里保留多少条，超出丢最旧的 |
| `displayLimit` | `300` | 面板最多往回画多少条，更早的留在内存里，靠筛选词翻出来 |

### 排除词

命中的日志**整条丢弃**：不格式化、不入库、不占 `maxLogs` 名额，控制台照常输出。

```js
LogPanel.addIgnoreKeywords(['[NOISE]']);
LogPanel.setIgnoreKeywords(['[NOISE]']);  // 整体替换，传 [] 表示不再排除（内置词也会被清掉）
LogPanel.ignoreKeywords();                // 当前生效的全部排除词
```

内置已排除 `window.dispatchEvent` 和 `getStorageInfoSync`：`web-adapter` 里这两个调用会高频刷日志，记进来会把列表刷满并拖垮帧率。

排除词会**写入本地存储**，key 为 `__LOG_PANEL_IGNORE_KEYWORDS__`，重启后自动恢复，所以引擎启动阶段最早的日志也能被过滤。恢复顺序是「本地记录 → 叠加代码里配置的排除词」，因此代码里配的词不会被本地记录冲掉；反过来，用户在面板里把词删光后，内置默认词也不会再自动回来。

### 筛选词

非空时只显示命中的日志，作用在**展示层**：内存里的历史一条都不会丢，加一个词就能把早于显示窗口的老日志筛出来。

```js
LogPanel.addIncludeKeywords(['[NET]']);
LogPanel.setIncludeKeywords(['[BATTLE]', '[NET]']);  // 整体替换
LogPanel.includeKeywords();
```

筛选词只对本次运行有效，不落盘。

## 配置项

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxLogs` | `number` | `1000` | 内存里最多保留多少条日志 |
| `displayLimit` | `number` | `300` | 面板一次最多渲染多少条 |
| `maxNetRecords` | `number` | `100` | 最多保留多少条网络记录 |
| `canvas` | `any` | - | 承载面板的 canvas |
| `intercept` | `boolean` | `true` | 是否拦截 console |
| `interceptNetwork` | `boolean` | `true` | 是否拦截 `my.request` |
| `buttonRadius` | `number` | `22` | 悬浮按钮半径 |
| `buttonPosition` | `{x?, y?}` | 右侧、约 42% 高度 | 悬浮按钮初始位置（屏幕坐标，原点左上角） |
| `open` | `boolean` | `false` | 挂载后是否直接打开面板 |
| `maxPixelRatio` | `number` | `2` | 画布像素比上限，`0` 表示按设备原生 dpr |
| `ignoreKeywords` | `string[]` | - | 追加排除词 |
| `includeKeywords` | `string[]` | - | 筛选词 |

`maxPixelRatio` 值得单独说一下：画布按 dpr 放置，3 倍屏上一帧要上传约 10MB 纹理，封到 2 能省掉一半左右的绘制与上传开销，代价是文字略微不如原生锐利。

## 数据处理

- 单条 console 日志最多保留 4000 字符，超出截断并标注原长度
- 对象序列化会做结构裁剪（单个字符串、数组项数、键数、层级、节点数都有上限），保证 JSON 前半部分结构完整，而不是从中间被砍断
- `%c` 只解析面板能画出来的样式：颜色、背景、内边距、圆角、加粗
- 网络记录里的 `token` / `sign` / `password` / `session` 等敏感 query 参数会替换成 `***`；请求/响应体、头部值都有长度上限

## 性能设计

- **视口裁剪**：只绘制可见区域内的行，单帧绘制量与存储条数无关（300 / 1000 / 3000 条测下来单帧 `fillText` 次数一致），存储条数只影响内存
- **重绘去重**：每帧算一个状态签名，和上一帧相同就跳过绘制
- **限速**：日志密集写入时两帧之间至少隔 50ms；触摸交互不受限速，走 `requestAnimationFrame` 保持跟手
- **换行缓存**：按「宽度 + 展开态」缓存换行结果，滚动时不重复 `measureText`
- **收起态只测折叠行数**：默认 4 行折叠，长日志的测量开销约为展开态的 1/8，折叠行数可在设置里调
- **读取存储不用 `localStorage.length`**：那个 getter 在 `web-adapter` 里每次都会调 `my.getStorageInfoSync` 并序列化全部数据，是本项目里最容易踩的卡顿源

冷启动时如果已缓存大量长日志，首次换行测量会是唯一明显尖峰（每条长日志最多 40 行的文本测量），之后都走缓存。

## 目录结构

```
src/
  index.ts       对外 API、初始化时机、排除词与设置的持久化装配
  console.ts     日志仓库、console 拦截、参数格式化
  network.ts     my.request 拦截、网络记录仓库、脱敏
  ui.ts          面板绘制与触摸交互（悬浮按钮、列表、设置弹窗）
  settings.ts    面板设置的默认值、循环取值与本地存储
  presenter.ts   离屏画布 → 屏幕的纹理上传
  env.ts         小游戏 / 浏览器环境适配（canvas、触摸、尺寸、存储）
rollup.config.mjs  UMD 打包，版本号注入
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # 产出 dist/log-panel-<version>.umd.js
```

产物文件名带版本号，方便在真机上确认跑的是哪一版；版本号来自 `package.json`，构建时注入到源码里的 `__LOG_PANEL_VERSION__`。

构建会用 terser 压缩并混淆顶层标识符，产物从约 146KB 降到约 52KB（gzip 约 17KB），堆栈里的内部变量名也失去可读性。几个刻意的取舍：

- 不开 `drop_console`：面板本身要靠输出 console 日志工作
- 不混淆属性名：面板要读写宿主对象（`my.*`、`canvas`、`ctx`），改属性名会直接跑不起来
- 只用不改变语义的压缩选项，`unsafe*` 系列全部关闭
- 只保留 `/*! ... */` 形式的 banner，其余注释全部去掉

## 注意事项

- 必须通过 `globalThis.LogPanel` 访问；同一份脚本被加载两次时会复用第一份实例，避免 console 被重复包装导致日志翻倍
- 面板会拦截落在自己区域内的触摸，其余触摸照常传给游戏
- 调试面板不应该影响游戏本身：拦截失败、存储失败、绘制失败都只静默降级，不抛出
