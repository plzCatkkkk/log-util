/**
 * 对外入口（UMD）。
 *
 * 脚本一加载就会自动开始工作，不需要手动调用 init：
 *   1. 立即拦截 console / my.request，把最早的日志全部缓存下来；
 *   2. 等宿主（如 Cocos 的 web-adapter）建好自己的上屏 canvas 之后，再创建离屏画布
 *      挂出可拖拽悬浮按钮，避免抢占“第一个 canvas 即上屏画布”的名额。
 *
 * 想手动控制：
 *   LogPanel.init({ maxLogs: 1000, displayLimit: 300 });  // 可重复调用，用于补充配置
 *   LogPanel.setMaxLogs(500)                         // 运行时改内存条数上限
 *   LogPanel.setDisplayLimit(300)                    // 运行时改渲染条数
 *   LogPanel.addIgnoreKeywords(['xxx'])              // 追加排除词（命中不入库、不占上限）
 *   LogPanel.setIncludeKeywords(['yyy'])             // 只显示含 yyy 的日志（含已存历史）
 *   LogPanel.show() / hide() / toggle() / clear() / destroy()
 * 想关掉自动初始化，请在加载本文件之前设置：
 *   globalThis.__LOG_PANEL_AUTO_INIT__ = false
 */
import { bindResize, bindTouch, createOverlayCanvas, getMyApi, getScreenSize, readStorage, resizeCanvas, writeStorage } from './env';
import { LogStore, interceptConsole } from './console';
import type { ConsolePatch } from './console';
import { LogPanelView } from './ui';
import { createPresenter } from './presenter';
import type { Presenter } from './presenter';
import { interceptNetwork, NetStore } from './network';
import type { NetRecord, NetworkPatch } from './network';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';
import type { PanelSettings } from './settings';

export interface LogPanelOptions {
  /** 内存里最多保留多少条日志，超出丢弃最旧的，默认 1000 */
  maxLogs?: number;
  /**
   * 面板最多往回显示多少条，默认 300。
   * 只限制渲染，不影响内存里保留的历史；配合 includeKeywords 能翻到更早的日志。
   */
  displayLimit?: number;
  /** 最多保留多少条网络记录，默认 100 */
  maxNetRecords?: number;
  /** 承载面板的 canvas（宿主只允许一个 canvas 上屏时，可传入自己可用的 canvas） */
  canvas?: any;
  /** 是否拦截 console.log/info/warn/error/debug，默认 true */
  intercept?: boolean;
  /** 是否拦截 my.request 并记录 method/url/耗时/响应，默认 true */
  interceptNetwork?: boolean;
  /** 悬浮按钮半径，默认 22 */
  buttonRadius?: number;
  /** 悬浮按钮初始位置（屏幕坐标，原点左上角） */
  buttonPosition?: { x?: number; y?: number };
  /** 面板打开后再挂载界面（默认 false，会自动打开） */
  open?: boolean;
  /**
   * 面板画布的像素比上限，默认 2。
   * 画布是按 dpr 放的，3 倍屏上一帧就要上传约 10MB 纹理；
   * 封到 2 能省掉一半左右的绘制与上传开销，文字略微不如原生锐利。
   * 传 0 表示不限制（按设备原生 dpr 绘制）。
   */
  maxPixelRatio?: number;
  /**
   * 追加排除词：命中的日志整条丢弃，不格式化、不入库、也不占 maxLogs 的名额，
   * 控制台照常输出。内置已排除 window.dispatchEvent / getStorageInfoSync。
   * 面板里的增删会写进本地存储，重启后自动恢复。
   */
  ignoreKeywords?: string[];
  /**
   * 筛选词：非空时只显示命中的日志。作用在展示层，内存里的历史不会被丢掉，
   * 加一个词就能把之前存下的老日志筛出来。
   */
  includeKeywords?: string[];
}

export interface LogPanelApi {
  /** 产物版本号，构建时从 package.json 注入 */
  readonly version: string;
  init(options?: LogPanelOptions): LogPanelApi;
  show(): void;
  hide(): void;
  toggle(): void;
  clear(): void;
  isOpen(): boolean;
  /** 取当前网络记录快照（只读，供业务侧上报 / 排查） */
  net(): NetRecord[];
  /** 运行时调整日志条数上限，超出部分立即丢弃最旧的 */
  setMaxLogs(maxLogs: number): void;
  /** 运行时调整显示条数（只影响渲染，内存里的历史不变） */
  setDisplayLimit(limit: number): void;
  /** 运行时调整网络记录条数上限 */
  setMaxNetRecords(maxRecords: number): void;
  /** 追加排除词（被排除的日志不占条数上限）；改动会写进本地存储，下次启动继续生效 */
  addIgnoreKeywords(words: string[]): void;
  /** 整体替换排除词，传空数组表示不再排除（内置的也会被清掉）；同样持久化 */
  setIgnoreKeywords(words: string[]): void;
  /** 当前生效的排除词（含本地存下来的） */
  ignoreKeywords(): string[];
  /** 追加筛选词：配置后只显示命中的日志（能筛到已存的历史） */
  addIncludeKeywords(words: string[]): void;
  /** 整体替换筛选词，传空数组表示不筛选 */
  setIncludeKeywords(words: string[]): void;
  /** 当前生效的筛选词 */
  includeKeywords(): string[];
  destroy(): void;
}

/** 等待宿主上屏 canvas 的最长时间：超过就认为没有引擎占位，自己直接建 canvas */
const HOST_WAIT_TIMEOUT = 1000;
const HOST_POLL_INTERVAL = 50;
/** 排除词存在本地存储里的 key，重启后自动读回来 */
const IGNORE_STORAGE_KEY = '__LOG_PANEL_IGNORE_KEYWORDS__';

/** 读本地存过的排除词；null 表示从没存过（用内置默认词） */
function loadIgnoreKeywords(): string[] | null {
  const raw = readStorage(IGNORE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return null;
    const words: string[] = [];
    for (let i = 0; i < data.length; i++) {
      if (typeof data[i] === 'string' && data[i]) words.push(data[i]);
    }
    // 空数组也要认：用户把词全删了，下次启动就该保持不排除
    return words;
  } catch (e) {
    return null;
  }
}

function saveIgnoreKeywords(words: string[]): void {
  writeStorage(IGNORE_STORAGE_KEY, JSON.stringify(words || []));
}

/** 构建时由 rollup 从 package.json 注入，运行时可以通过 LogPanel.version 读到 */
const VERSION = '__LOG_PANEL_VERSION__';

let store: LogStore | null = null;
let netStore: NetStore | null = null;
let view: LogPanelView | null = null;
let presenter: Presenter | null = null;
let consolePatch: ConsolePatch | null = null;
let networkPatch: NetworkPatch | null = null;
let unbindTouch: (() => void) | null = null;
let unbindResize: (() => void) | null = null;
let offStoreChange: (() => void) | null = null;
let offNetChange: (() => void) | null = null;

let started = false;
let attachTimer: any = null;
let pendingOptions: LogPanelOptions = {};
/** 当前生效的设置：本地存过就整体以本地为准，否则用 init 选项覆盖默认值 */
let settings: PanelSettings = { ...DEFAULT_SETTINGS };
/** 面板画布，像素比改动后要按新尺寸重建 */
let panelCanvas: any = null;

/** 首次启动时的设置来源：本地记录优先，没有记录才用 init 里的容量/像素比配置 */
function resolveSettings(opts: LogPanelOptions): PanelSettings {
  const saved = loadSettings();
  if (saved) return saved;
  const base: PanelSettings = { ...DEFAULT_SETTINGS };
  if (opts.maxLogs && opts.maxLogs > 0) base.maxLogs = Math.floor(opts.maxLogs);
  if (opts.displayLimit && opts.displayLimit > 0) base.displayLimit = Math.floor(opts.displayLimit);
  if (opts.maxNetRecords && opts.maxNetRecords > 0) base.maxNetRecords = Math.floor(opts.maxNetRecords);
  if (opts.maxPixelRatio !== undefined && opts.maxPixelRatio >= 0) base.maxPixelRatio = opts.maxPixelRatio;
  return base;
}

/**
 * 设置变化后真正落地：容量类作用到仓库，像素比变化要按新尺寸重建画布。
 * 显示类（字号 / 折叠行数 / 时间戳 / 跟随最新）由 ui 自己应用。
 */
function applySettings(next: PanelSettings): void {
  const pixelRatioChanged = next.maxPixelRatio !== settings.maxPixelRatio;
  settings = next;
  if (store) {
    store.setMaxLogs(next.maxLogs);
    store.setDisplayLimit(next.displayLimit);
  }
  if (netStore) netStore.setMaxRecords(next.maxNetRecords);
  if (pixelRatioChanged && panelCanvas) {
    const size = getScreenSize(next.maxPixelRatio);
    if (presenter) presenter.resize(panelCanvas, size);
    if (view) view.resize(size);
  }
}

/** 运行时通过 API 改容量类设置：落盘 + 落到仓库，面板设置弹窗里的取值也跟着变 */
function updateSettings(patch: Partial<PanelSettings>): void {
  const next: PanelSettings = { ...settings, ...patch };
  saveSettings(next);
  if (view) view.syncSettings(next);
  else applySettings(next);
}

function mergeOptions(target: LogPanelOptions, source: LogPanelOptions): LogPanelOptions {
  const merged: LogPanelOptions = { ...target };
  const keys = Object.keys(source) as Array<keyof LogPanelOptions>;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (source[key] !== undefined) (merged as any)[key] = source[key];
  }
  return merged;
}

/** 宿主已经建好的上屏 canvas（Cocos 的 web-adapter 会挂在 window/GameGlobal 上） */
function hostCanvas(): any {
  const g: any = globalThis as any;
  return g.canvas || (g.window && g.window.canvas) || (g.GameGlobal && g.GameGlobal.canvas) || null;
}

/**
 * 立即开始拦截，但不碰 canvas。
 * 这样 game.js 最开头加载本文件时，引擎初始化、SDK、资源加载的日志都能抓到。
 */
function startIntercept(): void {
  if (started) return;
  started = true;

  const opts = pendingOptions;
  settings = resolveSettings(opts);
  const logs = new LogStore(settings.maxLogs);
  logs.displayLimit = settings.displayLimit;
  const net = new NetStore(settings.maxNetRecords);
  // 本地存的排除词优先恢复，这样引擎启动阶段最早的日志就能被过滤掉；
  // 代码里配置的排除词每次都重新叠加，不会被本地记录冲掉
  const savedKeywords = loadIgnoreKeywords();
  if (savedKeywords) logs.setIgnoreKeywords(savedKeywords);
  if (opts.ignoreKeywords && opts.ignoreKeywords.length) logs.addIgnoreKeywords(opts.ignoreKeywords);
  // 之后面板里的增删（含 init 补的配置）都写回本地，重启仍然生效
  logs.onIgnoreKeywordsChange = saveIgnoreKeywords;
  if (opts.includeKeywords && opts.includeKeywords.length) logs.addIncludeKeywords(opts.includeKeywords);
  store = logs;
  netStore = net;

  if (opts.intercept !== false) {
    consolePatch = interceptConsole(logs);
  }
  if (opts.interceptNetwork !== false) {
    networkPatch = interceptNetwork(logs, net);
  }
}

function clearAttachTimer(): void {
  const g: any = globalThis as any;
  if (attachTimer !== null) {
    if (typeof g.clearTimeout === 'function') g.clearTimeout(attachTimer);
    attachTimer = null;
  }
}

/** 真正创建画布、挂出按钮。之前缓存的日志会在首帧一次性画出来 */
function attachView(): void {
  clearAttachTimer();
  if (view || !store || !netStore) return;

  const logs = store;
  const net = netStore;
  const opts = pendingOptions;

  const canvas = opts.canvas || createOverlayCanvas();
  if (!canvas) {
    logs.push('error', '[log-panel] 创建 canvas 失败，无法显示日志面板');
    return;
  }
  panelCanvas = canvas;

  const size = getScreenSize(settings.maxPixelRatio);
  resizeCanvas(canvas, size);

  // 小游戏里第一个 canvas 通常被引擎占用，这里建一条“离屏 2D → 屏幕”的通道
  const screen = createPresenter(size);
  presenter = screen;

  const panelView = new LogPanelView(logs, net, canvas, size, {
    version: VERSION,
    buttonRadius: opts.buttonRadius,
    buttonPosition: opts.buttonPosition,
    onFrame: screen ? () => screen.present(canvas) : undefined,
    onOpenChange: screen ? (open) => screen.setBlocking(open) : undefined,
    settings,
    onSettingsChange: applySettings,
  });
  view = panelView;

  if (!panelView.ready) {
    logs.push('error', '[log-panel] canvas 取不到 2d 上下文（可能已被游戏引擎作为 WebGL 使用），请通过 init({ canvas }) 传入独立 canvas');
    return;
  }

  if (screen) screen.onReady = () => panelView.invalidate();

  offStoreChange = logs.onChange(() => panelView.onStoreChange());
  offNetChange = net.onChange(() => panelView.onNetChange());
  unbindTouch = bindTouch(canvas, (x, y, phase) => panelView.handleTouch(x, y, phase));
  unbindResize = bindResize(() => {
    const next = getScreenSize(settings.maxPixelRatio);
    if (screen) screen.resize(canvas, next);
    panelView.resize(next);
  });

  panelView.render();
  if (opts.open) panelView.show();
}

/**
 * 决定什么时候可以安全地建 canvas：
 * - 浏览器 / 有 DOM：直接建，不会跟引擎抢
 * - 小游戏：先等一个宏任务，看宿主（Cocos 的 web-adapter 等）有没有先把上屏 canvas 建好；
 *   有就马上挂载，没有且也没有适配层痕迹，就当作纯小游戏自己建
 */
function scheduleAttach(): void {
  if (attachTimer !== null || view) return;
  if (pendingOptions.canvas) {
    attachView();
    return;
  }

  const my = getMyApi();
  if (!my || typeof my.createCanvas !== 'function') {
    attachView();
    return;
  }

  const g: any = globalThis as any;
  const begin = Date.now();
  let firstTick = true;

  const tick = () => {
    attachTimer = null;
    if (view) return;

    if (hostCanvas()) {
      attachView();
      return;
    }

    // 已经跑过一轮宏任务：既没有宿主 canvas，也没有适配层的 document，
    // 说明这个环境里没人占第一个 canvas，可以自己建
    if (!firstTick && !g.document) {
      attachView();
      return;
    }

    if (!firstTick && Date.now() - begin >= HOST_WAIT_TIMEOUT) {
      attachView();
      return;
    }

    firstTick = false;
    attachTimer = typeof g.setTimeout === 'function' ? g.setTimeout(tick, HOST_POLL_INTERVAL) : null;
    if (attachTimer === null) attachView();
  };

  attachTimer = typeof g.setTimeout === 'function' ? g.setTimeout(tick, 0) : null;
  if (attachTimer === null) attachView();
}

function init(options?: LogPanelOptions): LogPanelApi {
  const opts = options || {};
  pendingOptions = mergeOptions(pendingOptions, opts);

  if (!started) {
    startIntercept();
  } else if (store) {
    // 已经自动初始化过，这里只补充配置
    const next = { ...settings };
    let capacityChanged = false;
    if (opts.maxLogs && opts.maxLogs > 0 && Math.floor(opts.maxLogs) !== next.maxLogs) {
      next.maxLogs = Math.floor(opts.maxLogs);
      capacityChanged = true;
    }
    if (opts.displayLimit && opts.displayLimit > 0 && Math.floor(opts.displayLimit) !== next.displayLimit) {
      next.displayLimit = Math.floor(opts.displayLimit);
      capacityChanged = true;
    }
    if (opts.maxNetRecords && opts.maxNetRecords > 0 && Math.floor(opts.maxNetRecords) !== next.maxNetRecords) {
      next.maxNetRecords = Math.floor(opts.maxNetRecords);
      capacityChanged = true;
    }
    if (opts.maxPixelRatio !== undefined && opts.maxPixelRatio >= 0 && opts.maxPixelRatio !== next.maxPixelRatio) {
      next.maxPixelRatio = opts.maxPixelRatio;
      capacityChanged = true;
    }
    if (capacityChanged) {
      // 跟面板里改设置一样落盘，避免下次启动又回到旧值
      saveSettings(next);
      applySettings(next);
    }
    if (opts.ignoreKeywords && opts.ignoreKeywords.length) store.addIgnoreKeywords(opts.ignoreKeywords);
    if (opts.includeKeywords && opts.includeKeywords.length) store.addIncludeKeywords(opts.includeKeywords);
  }

  if (view) {
    if (opts.open) view.show();
    return api;
  }

  // 显式给了 canvas 就不用等宿主
  if (opts.canvas) attachView();
  else scheduleAttach();

  return api;
}

function destroy(): void {
  clearAttachTimer();
  if (offStoreChange) {
    offStoreChange();
    offStoreChange = null;
  }
  if (offNetChange) {
    offNetChange();
    offNetChange = null;
  }
  if (unbindTouch) {
    unbindTouch();
    unbindTouch = null;
  }
  if (unbindResize) {
    unbindResize();
    unbindResize = null;
  }
  if (consolePatch) {
    consolePatch.restore();
    consolePatch = null;
  }
  if (networkPatch) {
    networkPatch.restore();
    networkPatch = null;
  }
  if (presenter) {
    presenter.destroy();
    presenter = null;
  }
  if (view) {
    view.destroy();
    view = null;
  }
  store = null;
  netStore = null;
  panelCanvas = null;
  started = false;
}

const api: LogPanelApi = {
  version: VERSION,
  init,
  show() {
    if (view) view.show();
  },
  hide() {
    if (view) view.hide();
  },
  toggle() {
    if (view) view.toggle();
  },
  clear() {
    if (store) store.clear();
    if (netStore) netStore.clear();
  },
  isOpen() {
    return !!view && view.isOpen();
  },
  net() {
    return netStore ? netStore.list().slice() : [];
  },
  setMaxLogs(maxLogs: number) {
    if (!(maxLogs > 0)) return;
    updateSettings({ maxLogs: Math.floor(maxLogs) });
  },
  setDisplayLimit(limit: number) {
    if (!(limit > 0)) return;
    updateSettings({ displayLimit: Math.floor(limit) });
  },
  setMaxNetRecords(maxRecords: number) {
    if (!(maxRecords > 0)) return;
    updateSettings({ maxNetRecords: Math.floor(maxRecords) });
  },
  addIgnoreKeywords(words: string[]) {
    if (store) store.addIgnoreKeywords(words || []);
  },
  setIgnoreKeywords(words: string[]) {
    if (store) store.setIgnoreKeywords(words || []);
  },
  ignoreKeywords() {
    return store ? store.ignoreKeywords() : [];
  },
  addIncludeKeywords(words: string[]) {
    if (store) store.addIncludeKeywords(words || []);
  },
  setIncludeKeywords(words: string[]) {
    if (store) store.setIncludeKeywords(words || []);
  },
  includeKeywords() {
    return store ? store.includeKeywords() : [];
  },
  destroy,
};

// 无论宿主用 require 还是直接加载，都保证能通过 globalThis.LogPanel 访问
const globalScope: any = typeof globalThis !== 'undefined' ? globalThis : undefined;
// 同一份脚本可能被加载两次（game.js 里手动 require + 引擎插件列表各加载一次），
// 这时直接复用第一份实例，避免 console 被重复包装导致日志翻倍
const existing: LogPanelApi | null = globalScope && globalScope.__LOG_PANEL_API__ ? globalScope.__LOG_PANEL_API__ : null;

if (globalScope && !existing) {
  globalScope.__LOG_PANEL_API__ = api;
  globalScope.LogPanel = api;
}

// 默认自动初始化：加载即开始拦截，UI 等宿主就绪后再挂载
if (!existing && globalScope && globalScope.__LOG_PANEL_AUTO_INIT__ !== false) {
  try {
    init();
  } catch (e) {
    // 自动初始化失败不能影响游戏启动
  }
}

export default existing || api;
