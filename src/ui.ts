/**
 * 面板视图：全部用 Canvas 2D 绘制（支付宝小游戏没有 DOM），
 * 命中检测自己算，触摸由 env.bindTouch 统一喂进来。
 */
import { matchesFilter } from './console';
import type { LogEntry, LogFilter, LogLevel, LogStore, TextStyle } from './console';
import { bindNetworkState, getMyApi, resizeCanvas } from './env';
import type { NetworkState, ScreenSize } from './env';
import type { NetRecord, NetStore } from './network';
import { DEFAULT_SETTINGS, nextSettingValue, saveSettings, settingValueText } from './settings';
import type { PanelSettings } from './settings';

type Rect = { x: number; y: number; w: number; h: number };

/**
 * 字号相关的几个值由设置面板改写，所以是 let 而不是 const。
 * 全部绘制都在同一个模块里同步完成，改完立即生效。
 */
let FONT = '12px sans-serif';
let FONT_BOLD = 'bold 13px sans-serif';
/** 富文本里加粗用同字号，避免行高对不齐 */
let FONT_RUN_BOLD = 'bold 12px sans-serif';
let FONT_SMALL = '11px sans-serif';
let LINE_HEIGHT = 17;
/** 可展开的行在正文下面留出的「展开全文」提示带高度 */
let EXPAND_HINT_H = 15;
const ROW_GAP = 6;
const MAX_LINES_PER_ENTRY = 40;
/** 收起状态下每条日志最多显示几行（0 = 不折叠），由设置面板切换 */
let collapsedLines = DEFAULT_SETTINGS.collapsedLines;
/** 是否在每条日志前面画时间戳 */
let showTime = DEFAULT_SETTINGS.showTime;
/** 滚上去看旧日志时，新日志到达是否保持当前查看位置 */
let followTail = DEFAULT_SETTINGS.followTail;

/** 收起态实际可见行数：设成 0 表示不折叠 */
function visibleLines(expanded: boolean): number {
  if (expanded) return MAX_LINES_PER_ENTRY;
  return collapsedLines > 0 ? Math.min(collapsedLines, MAX_LINES_PER_ENTRY) : MAX_LINES_PER_ENTRY;
}

/** 把设置里的字号换算成绘图用的字体与行高 */
function applyFontSize(fontSize: number): void {
  const size = fontSize > 0 ? fontSize : DEFAULT_SETTINGS.fontSize;
  const ratio = size / DEFAULT_SETTINGS.fontSize;
  FONT = size + 'px sans-serif';
  FONT_RUN_BOLD = 'bold ' + size + 'px sans-serif';
  FONT_BOLD = 'bold ' + Math.round(13 * ratio) + 'px sans-serif';
  FONT_SMALL = Math.max(10, Math.round(11 * ratio)) + 'px sans-serif';
  LINE_HEIGHT = Math.round(17 * ratio);
  EXPAND_HINT_H = Math.max(13, Math.round(15 * ratio));
}

/** 网络卡片：行高、卡片间距、上下内边距 */
const NET_LINE_HEIGHT = 15;
const NET_CARD_GAP = 8;
const NET_CARD_PAD = 8;
const NET_COLLAPSED_H = 47;
const NET_DETAIL_TOP = 45;
const MAX_DETAIL_LINES = 80;
/** 有请求进行中时的实时刷新间隔 */
const NET_TICK_INTERVAL = 400;
/**
 * 日志密集写入时两帧之间至少隔这么久。
 * 触摸交互走 requestAnimationFrame 保持跟手，只有日志驱动的重绘才限速。
 */
const LOG_FRAME_GAP = 50;

/** 设置弹窗每段最多列出多少个词，超出的给一行提示 */
const DIALOG_MAX_WORDS = 6;
/** 设置弹窗里一行关键词的高度 */
const DIALOG_ROW_H = 26;
/** 设置弹窗里一行设置项的高度 */
const DIALOG_SETTING_H = 30;
/** 设置弹窗顶部那一排小 tab 的高度 */
const DIALOG_TAB_H = 30;
/** 设置项右侧取值胶囊的宽度 */
const DIALOG_VALUE_W = 62;

const COLORS = {
  maskBg: 'rgba(0, 0, 0, 0.38)',
  panelBg: 'rgba(22, 23, 27, 0.96)',
  panelBorder: 'rgba(255, 255, 255, 0.14)',
  headerBg: '#262a31',
  toolbarBg: '#1d1f24',
  title: '#8ef0b0',
  text: '#c9d1d9',
  info: '#9ecbff',
  warn: '#ffcc66',
  error: '#ff7b72',
  dim: '#8b93a1',
  success: '#7ee787',
  purple: '#d2a8ff',
  chipBg: 'rgba(255, 255, 255, 0.10)',
  chipActiveBg: '#2f7d52',
  chipActiveText: '#ffffff',
  buttonBg: 'rgba(0, 0, 0, 0.62)',
  buttonBorder: 'rgba(124, 255, 178, 0.9)',
  buttonText: '#7cffb2',
  cardBg: 'rgba(255, 255, 255, 0.05)',
};

const FILTERS: Array<{ level: LogFilter; label: string }> = [
  { level: 'all', label: '全部' },
  { level: 'log', label: 'log' },
  { level: 'info', label: 'info' },
  { level: 'warn', label: 'warn' },
  { level: 'error', label: 'error' },
  { level: 'net', label: 'net' },
];

export interface LogPanelViewOptions {
  /** 产物版本号，显示在标题栏 */
  version?: string;
  buttonRadius?: number;
  buttonPosition?: { x?: number; y?: number };
  /** 每帧绘制结束后回调，用于把离屏画布贴到屏幕 */
  onFrame?: () => void;
  /** 面板打开 / 收起回调，用于控制触摸穿透 */
  onOpenChange?: (open: boolean) => void;
  /** 当前生效的设置（一般由 index 从本地存储读出来传进来） */
  settings?: PanelSettings;
  /** 设置被改动后回调，容量类设置需要 index 帮忙应用到底层仓库 */
  onSettingsChange?: (settings: PanelSettings) => void;
}

interface ChipHit {
  level: LogFilter;
  label: string;
  rect: Rect;
}

interface Layout {
  panel: Rect;
  header: Rect;
  toolbar: Rect;
  /** net tab 的网络状态条，其他 tab 高度为 0 */
  netBar: Rect;
  list: Rect;
  /** 标题栏左侧的「设置」按钮，打开设置弹窗 */
  filterBtn: Rect;
  clear: Rect;
  close: Rect;
  chips: ChipHit[];
}

/** 设置弹窗里的三个分页：显示 / 容量 / 词表 */
type DialogTab = 'view' | 'capacity' | 'words';

const DIALOG_TABS: Array<{ tab: DialogTab; label: string }> = [
  { tab: 'view', label: '显示' },
  { tab: 'capacity', label: '容量' },
  { tab: 'words', label: '词表' },
];

/** 两个设置页的行定义，点整行循环切换取值 */
const VIEW_ROWS: Array<{ key: keyof PanelSettings; label: string }> = [
  { key: 'collapsedLines', label: '收起行数' },
  { key: 'fontSize', label: '字号' },
  { key: 'showTime', label: '时间戳' },
  { key: 'followTail', label: '跟随最新' },
];

const CAPACITY_ROWS: Array<{ key: keyof PanelSettings; label: string }> = [
  { key: 'maxLogs', label: '内存上限' },
  { key: 'displayLimit', label: '显示上限' },
  { key: 'maxNetRecords', label: '网络记录' },
  { key: 'maxPixelRatio', label: '像素比' },
];

/** 设置弹窗里一行关键词（含右侧删除按钮） */
interface DialogRow {
  kind: 'include' | 'ignore';
  index: number;
  word: string;
  y: number;
}

/** 设置弹窗里一行设置项，整行都是命中区 */
interface DialogSettingRow {
  key: keyof PanelSettings;
  label: string;
  value: string;
  y: number;
  rect: Rect;
}

interface DialogTabHit {
  tab: DialogTab;
  label: string;
  rect: Rect;
}

interface DialogLayout {
  box: Rect;
  close: Rect;
  tabs: DialogTabHit[];
  settings: DialogSettingRow[];
  addInclude: Rect;
  addIgnore: Rect;
  includeTitleY: number;
  ignoreTitleY: number;
  /** 两段各自的内容起始 y（行中心点） */
  includeTop: number;
  ignoreTop: number;
  rows: DialogRow[];
  tipY: number;
}

/** 设置弹窗的内存状态：词表改动立即回写 store，tab 只影响弹窗自己 */
interface SettingsDialogState {
  tab: DialogTab;
  include: string[];
  ignore: string[];
}

interface NetHit {
  id: number;
  rect: Rect;
}

/** 日志行的命中区，只在画出来的可见行上记录 */
interface LogRowHit {
  id: number;
  rect: Rect;
  /** 内容超过收起行数，点头可以展开 / 收起 */
  expandable: boolean;
}

/** 富文本换行后的一个片段：x 相对正文左边界，padX 是左右内边距 */
interface RunPiece {
  text: string;
  style?: TextStyle;
  x: number;
  w: number;
  padX: number;
}

interface RunLine {
  pieces: RunPiece[];
}

/** console 列表的过滤 + 换行结果缓存 */
interface ListCache {
  version: number;
  filter: LogFilter;
  width: number;
  /** 展开态集合的快照，变了就要重建 */
  expandedKey: string;
  entries: LogEntry[];
  heights: number[];
  lines: string[][];
  runs: RunLine[][];
  /** 每条日志的内容是否超过收起行数 */
  expandable: boolean[];
  /** 筛选后各级别的条数（不受显示上限截断），给标题栏和 tab 用 */
  counts: Record<string, number>;
  contentHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 耗时：小于 1s 显示毫秒，超过显示秒 */
function formatCost(ms: number): string {
  const cost = ms > 0 ? ms : 0;
  if (cost < 1000) return cost + 'ms';
  return (cost / 1000).toFixed(2) + 's';
}

function levelColor(level: LogLevel): string {
  if (level === 'warn') return COLORS.warn;
  if (level === 'error') return COLORS.error;
  if (level === 'info') return COLORS.info;
  return COLORS.text;
}

function roundRectPath(ctx: any, x: number, y: number, w: number, h: number, r: number, topOnly?: boolean): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  if (topOnly) {
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
  } else {
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  }
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function insideRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export class LogPanelView {
  private ctx: any;
  private canvas: any;
  private store: LogStore;
  private net: NetStore;
  private size: ScreenSize;

  private visible = false;
  private filter: LogFilter = 'all';
  private scroll = 0;
  private maxScroll = 0;

  /** 当前展开的网络记录 id */
  private expandedNetId: number | null = null;
  /** 上一帧渲染出来的网络卡片命中区 */
  private netHits: NetHit[] = [];
  /** 按下时落在哪张网络卡片上，抬手没滑动就切换展开 */
  private pendingCardId: number | null = null;
  /** 内容超过收起行数、被手动展开的日志 id（只记少数几条） */
  private expandedLogIds: number[] = [];
  /** 上一帧渲染出来的日志行命中区 */
  private rowHits: LogRowHit[] = [];
  /** 按下时落在哪条日志上，抬手没滑动就切换展开 */
  private pendingRowId: number | null = null;
  private netState: NetworkState = { online: true, type: 'unknown' };
  private netStateTimer: any = null;
  private tickTimer: any = null;
  /** 布局与 console 列表缓存，避免每帧重复计算 */
  private layoutCache: Layout | null = null;
  private layoutKey = '';
  private listCache: ListCache | null = null;
  /** 上一帧的状态快照，相同就跳过重画 */
  private frameKey = '';
  /** 上一帧绘制时刻，用于日志驱动的重绘限速 */
  private lastRenderAt = 0;
  /** 限速等待中的定时器；交互来了可以提前取消 */
  private throttleTimer: any = null;

  /** 设置弹窗，null 表示未打开 */
  private settingsDialog: SettingsDialogState | null = null;
  /** 弹窗底部的一行提示（比如当前环境不支持输入） */
  private dialogTip = '';
  private dialogTipTimer: any = null;

  /** 当前生效的设置，容量项改动会通过 onSettingsChange 交给 index 应用 */
  private settings: PanelSettings;
  private onSettingsChange?: (settings: PanelSettings) => void;
  /** 上一帧的列表总高度，用来在「不跟随最新」时补偿新日志带来的位移 */
  private lastContentHeight = 0;

  private button: { x: number; y: number; r: number };
  private layout: Layout | null = null;
  /** 标题栏右侧的版本号文本，空串表示不显示 */
  private versionLabel: string;

  private touchMode: 'none' | 'button' | 'scroll' | 'consumed' = 'none';
  private touchStart = { x: 0, y: 0 };
  private buttonStart = { x: 0, y: 0 };
  private scrollStart = 0;

  private pending = false;
  private onFrame?: () => void;
  private onOpenChange?: (open: boolean) => void;

  constructor(store: LogStore, net: NetStore, canvas: any, size: ScreenSize, options: LogPanelViewOptions) {
    this.store = store;
    this.net = net;
    this.canvas = canvas;
    this.size = size;
    this.ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    this.onFrame = options.onFrame;
    this.onOpenChange = options.onOpenChange;
    this.onSettingsChange = options.onSettingsChange;
    this.versionLabel = options.version ? 'v' + options.version : '';

    // 设置先落到模块级的绘制参数上，后面所有测量 / 绘制都按这套字号和行数走
    this.settings = { ...(options.settings || DEFAULT_SETTINGS) };
    applyFontSize(this.settings.fontSize);
    collapsedLines = this.settings.collapsedLines;
    showTime = this.settings.showTime;
    followTail = this.settings.followTail;

    const radius = options.buttonRadius && options.buttonRadius > 0 ? options.buttonRadius : 22;
    const defaultX = size.width - radius - 12;
    const defaultY = Math.round(size.height * 0.42);
    this.button = {
      r: radius,
      x: options.buttonPosition && typeof options.buttonPosition.x === 'number' ? options.buttonPosition.x : defaultX,
      y: options.buttonPosition && typeof options.buttonPosition.y === 'number' ? options.buttonPosition.y : defaultY,
    };

    this.clampButton();
    // 网络状态（在线/断网、wifi/4g）实时反映到 net tab 顶部
    this.netStateTimer = bindNetworkState((state) => this.applyNetState(state));
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  /** 屏幕尺寸变化（横竖屏切换）后重建画布尺寸与布局 */
  resize(size: ScreenSize): void {
    this.size = size;
    resizeCanvas(this.canvas, size);
    this.clampButton();
    this.layoutCache = null;
    this.layout = this.getLayout();
    this.invalidate();
  }

  /** 外部（LogPanel.setMaxLogs 等 API）改了设置后同步进来，弹窗里的取值才不会过期 */
  syncSettings(next: PanelSettings): void {
    this.applySettings(next);
    this.invalidate();
  }

  isOpen(): boolean {
    return this.visible;
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.scroll = 0;
    this.layout = this.getLayout();
    if (this.onOpenChange) this.onOpenChange(true);
    this.invalidate();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.touchMode = 'none';
    this.settingsDialog = null;
    this.dialogTip = '';
    this.clearDialogTipTimer();
    if (this.onOpenChange) this.onOpenChange(false);
    this.invalidate();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** console 日志变化：net tab 里不显示日志内容，不用重画 */
  onStoreChange(): void {
    if (!this.visible || this.filter === 'net') return;
    this.invalidateThrottled();
  }

  /** 网络记录变化：只有 net tab 会用到 */
  onNetChange(): void {
    if (!this.visible || this.filter !== 'net') return;
    this.invalidateThrottled();
  }

  /**
   * 数据变化触发的重绘：日志成批刷屏时限制到 LOG_FRAME_GAP 一帧，
   * 避免每条日志都带来一次全屏纹理上传。
   */
  invalidateThrottled(): void {
    if (this.pending) return;
    const now = Date.now();
    const wait = LOG_FRAME_GAP - (now - this.lastRenderAt);
    if (wait <= 0) {
      this.invalidate();
      return;
    }

    this.pending = true;
    const g: any = globalThis as any;
    if (typeof g.setTimeout !== 'function') {
      this.pending = false;
      this.invalidate();
      return;
    }
    this.throttleTimer = g.setTimeout(() => {
      this.throttleTimer = null;
      this.pending = false;
      this.render();
    }, wait);
  }

  invalidate(): void {
    if (this.pending) {
      // 交互触发的重绘要跟手：把限速中的等待提前到下一帧
      if (this.throttleTimer === null) return;
      const g: any = globalThis as any;
      if (typeof g.clearTimeout === 'function') g.clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
      this.pending = false;
    }
    this.pending = true;

    const g: any = globalThis as any;
    if (typeof g.requestAnimationFrame === 'function') {
      g.requestAnimationFrame(() => {
        this.pending = false;
        this.render();
      });
      return;
    }
    if (typeof g.setTimeout === 'function') {
      g.setTimeout(() => {
        this.pending = false;
        this.render();
      }, 0);
      return;
    }
    this.pending = false;
    this.render();
  }

  render(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // 内容和上一帧完全一样就直接跳过：一次重画 = 一次清屏 + 一次全屏纹理上传
    const key = this.frameKeyOf();
    if (key === this.frameKey) return;
    this.frameKey = key;
    this.lastRenderAt = Date.now();

    const dpr = this.size.pixelRatio || 1;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.size.width, this.size.height);

    if (this.visible) this.renderPanel();
    else this.renderButton();
    if (this.visible && this.settingsDialog) this.renderSettingsDialog();

    // 滚动位置在绘制里可能被夹紧，按夹紧后的状态记录，避免下一帧白画一次
    this.frameKey = this.frameKeyOf();

    if (this.onFrame) {
      try {
        this.onFrame();
      } catch (e) {
        // 上屏失败不能影响绘制
      }
    }
  }

  /** 决定这一帧画面内容的状态快照；相同就说明重画没有意义 */
  private frameKeyOf(): string {
    let key =
      (this.visible ? '1' : '0') +
      '|' + this.filter +
      '|' + this.scroll +
      '|' + this.store.version +
      '|' + (this.netState.online ? '1' : '0') + this.netState.type +
      '|' + this.size.width + 'x' + this.size.height + '@' + this.size.pixelRatio;

    if (this.visible) {
      // net tab 的内容全在 NetStore 里；console tab 不依赖它
      if (this.filter === 'net') {
        key += '|' + this.net.version + ':' + this.net.total();
        // 有请求在跑时耗时是实时跳的，按 tick 周期变化让去重放行
        if (this.net.pending() > 0) key += '|t' + Math.floor(Date.now() / NET_TICK_INTERVAL);
      }
      key += '|' + (this.expandedNetId === null ? '' : this.expandedNetId);
      // 日志行的展开状态会影响行高和内容，必须进签名
      if (this.expandedLogIds.length) key += '|e' + this.expandedLogIds.join(',');
      if (this.settingsDialog) {
        key +=
          '|d' +
          this.settingsDialog.tab +
          ';' +
          this.settingsDialog.include.join(',') +
          ';' +
          this.settingsDialog.ignore.join(',') +
          ';' +
          this.dialogTip;
      }
      // 设置直接影响排版和取值显示，任一改动都要重画
      const s = this.settings;
      key +=
        '|s' +
        s.collapsedLines +
        ',' +
        s.fontSize +
        ',' +
        (s.showTime ? 1 : 0) +
        ',' +
        (s.followTail ? 1 : 0) +
        ',' +
        s.maxLogs +
        ',' +
        s.displayLimit +
        ',' +
        s.maxNetRecords +
        ',' +
        s.maxPixelRatio;
    } else {
      // 收起态只画悬浮按钮，位置变了才需要重画
      key += '|' + this.button.x + ',' + this.button.y + ',' + this.button.r;
    }
    return key;
  }

  /** 触摸分发，返回 true 表示面板消费了这一次触摸 */
  handleTouch(x: number, y: number, phase: 'start' | 'move' | 'end'): boolean {
    if (phase === 'start') {
      this.touchStart = { x, y };

      if (!this.visible) {
        if (this.hitButton(x, y)) {
          this.touchMode = 'button';
          this.buttonStart = { x: this.button.x, y: this.button.y };
          return true;
        }
        return false;
      }

      const layout = this.layout;
      if (!layout) return false;

      // 筛选词弹窗在最上层：打开时所有触摸都归它，点弹窗外即关闭
      if (this.settingsDialog) {
        this.touchMode = 'consumed';
        this.handleDialogTouch(x, y);
        return true;
      }

      // 点在面板外的遮罩上（上方留白区域）：直接收起
      if (!insideRect(layout.panel, x, y)) {
        this.hide();
        this.touchMode = 'consumed';
        return true;
      }

      if (insideRect(layout.close, x, y)) {
        this.hide();
        this.touchMode = 'consumed';
        return true;
      }
      if (insideRect(layout.filterBtn, x, y)) {
        this.openSettingsDialog();
        this.touchMode = 'consumed';
        return true;
      }
      if (insideRect(layout.clear, x, y)) {
        this.store.clear();
        this.net.clear();
        this.expandedNetId = null;
        this.expandedLogIds.length = 0;
        this.touchMode = 'consumed';
        return true;
      }
      for (let i = 0; i < layout.chips.length; i++) {
        if (insideRect(layout.chips[i].rect, x, y)) {
          this.setFilter(layout.chips[i].level);
          this.touchMode = 'consumed';
          return true;
        }
      }
      if (insideRect(layout.list, x, y)) {
        this.touchMode = 'scroll';
        this.scrollStart = this.scroll;
        // 按下落在某张网络卡片 / 某条日志上：抬手时若没滑动就展开/收起
        if (this.filter === 'net') {
          this.pendingCardId = this.hitNetCard(x, y);
          this.pendingRowId = null;
        } else {
          this.pendingCardId = null;
          this.pendingRowId = this.hitLogRow(x, y);
        }
        return true;
      }
      // 面板空白区域也吃掉，避免误触到下面的游戏
      this.touchMode = 'consumed';
      return true;
    }

    if (phase === 'move') {
      if (this.touchMode === 'button') {
        this.button.x = this.buttonStart.x + (x - this.touchStart.x);
        this.button.y = this.buttonStart.y + (y - this.touchStart.y);
        this.clampButton();
        this.invalidate();
        return true;
      }
      if (this.touchMode === 'scroll') {
        this.scroll = clamp(this.scrollStart + (y - this.touchStart.y), 0, this.maxScroll);
        this.invalidate();
        return true;
      }
      return this.touchMode === 'consumed';
    }

    // end
    if (this.touchMode === 'button') {
      const moved = Math.abs(x - this.touchStart.x) + Math.abs(y - this.touchStart.y);
      if (moved < 8) this.show();
      this.touchMode = 'none';
      return true;
    }
    if (this.touchMode === 'scroll' || this.touchMode === 'consumed') {
      if (this.touchMode === 'scroll') {
        const moved = Math.abs(x - this.touchStart.x) + Math.abs(y - this.touchStart.y);
        const cardId = this.pendingCardId;
        const rowId = this.pendingRowId;
        this.pendingCardId = null;
        this.pendingRowId = null;
        if (moved < 8 && cardId !== null) {
          this.expandedNetId = this.expandedNetId === cardId ? null : cardId;
          this.scroll = clamp(this.scroll, 0, this.maxScroll);
          this.invalidate();
        } else if (moved < 8 && rowId !== null) {
          this.toggleLogRow(rowId);
        }
      }
      this.touchMode = 'none';
      return true;
    }
    return this.visible;
  }

  private hitNetCard(x: number, y: number): number | null {
    for (let i = this.netHits.length - 1; i >= 0; i--) {
      if (insideRect(this.netHits[i].rect, x, y)) return this.netHits[i].id;
    }
    return null;
  }

  /** 只把内容确实超过收起行数的行算作可点头的区域 */
  private hitLogRow(x: number, y: number): number | null {
    for (let i = this.rowHits.length - 1; i >= 0; i--) {
      const hit = this.rowHits[i];
      if (hit.expandable && insideRect(hit.rect, x, y)) return hit.id;
    }
    return null;
  }

  /** 切换一条日志的展开状态；展开后仍受 MAX_LINES_PER_ENTRY 行数上限约束 */
  private toggleLogRow(id: number): void {
    const index = this.expandedLogIds.indexOf(id);
    if (index >= 0) {
      this.expandedLogIds.splice(index, 1);
    } else {
      this.expandedLogIds.push(id);
      // 展开的内容可能很长，把上限收紧一点，防止无限攒
      if (this.expandedLogIds.length > 20) this.expandedLogIds.shift();
    }
    // 展开会让内容变高，滚动位置跟着夹紧到新的范围
    this.scroll = clamp(this.scroll, 0, this.maxScroll);
    this.invalidate();
  }

  private setFilter(level: LogFilter): void {
    this.filter = level;
    this.scroll = 0;
    this.pendingCardId = null;
    this.pendingRowId = null;
    this.invalidate();
  }

  /** 打开设置弹窗：词表取 store 的当前快照，容量 / 显示项直接读设置 */
  private openSettingsDialog(): void {
    this.settingsDialog = {
      tab: 'view',
      include: this.store.includeKeywords(),
      ignore: this.store.ignoreKeywords(),
    };
    this.dialogTip = '';
    this.clearDialogTipTimer();
    this.invalidate();
  }

  private closeSettingsDialog(): void {
    this.settingsDialog = null;
    this.dialogTip = '';
    this.clearDialogTipTimer();
    this.invalidate();
  }

  /** 弹窗里的增删立即回写 store；注意只影响之后的新日志，历史日志需要清空 */
  private applyDialogKeywords(): void {
    const dialog = this.settingsDialog;
    if (!dialog) return;
    this.store.setIncludeKeywords(dialog.include);
    this.store.setIgnoreKeywords(dialog.ignore);
    this.invalidate();
  }

  /** 点一行设置就切到下一个可选值，改完立即落盘并生效 */
  private cycleSetting(key: keyof PanelSettings): void {
    const next = { ...this.settings };
    (next as any)[key] = nextSettingValue(this.settings, key);
    this.commitSettings(next);
  }

  /** 保存 + 应用；容量类设置由 index 通过 onSettingsChange 应用到底层仓库 */
  private commitSettings(next: PanelSettings): void {
    saveSettings(next);
    this.applySettings(next);
    this.invalidate();
  }

  private applySettings(next: PanelSettings): void {
    const prev = this.settings;
    this.settings = next;

    applyFontSize(next.fontSize);
    collapsedLines = next.collapsedLines;
    showTime = next.showTime;
    followTail = next.followTail;

    // 换行结果是按「宽度 + 字号 + 收起行数 + 有没有时间戳」算出来的，这几项变了就得全部作废
    if (prev.fontSize !== next.fontSize || prev.collapsedLines !== next.collapsedLines || prev.showTime !== next.showTime) {
      this.dropWrapCaches();
      this.listCache = null;
      this.lastContentHeight = 0;
    }

    if (this.onSettingsChange) this.onSettingsChange(next);
  }

  private dropWrapCaches(): void {
    const entries = this.store.list();
    for (let i = 0; i < entries.length; i++) {
      entries[i].wrapCache = undefined;
      entries[i].runWrapCache = undefined;
    }
  }

  private removeKeyword(kind: 'include' | 'ignore', index: number): void {
    const dialog = this.settingsDialog;
    if (!dialog) return;
    const words = kind === 'include' ? dialog.include : dialog.ignore;
    if (index < 0 || index >= words.length) return;
    words.splice(index, 1);
    this.applyDialogKeywords();
  }

  /** 新增关键词：小游戏里没有 DOM 输入框，走宿主的 my.prompt */
  private promptAddKeyword(kind: 'include' | 'ignore'): void {
    const dialog = this.settingsDialog;
    if (!dialog) return;

    const my = getMyApi();
    if (!my || typeof my.prompt !== 'function') {
      this.setDialogTip('当前环境不支持输入，请用 LogPanel.addIncludeKeywords() 配置');
      return;
    }

    my.prompt({
      title: kind === 'include' ? '添加筛选词' : '添加排除词',
      message: kind === 'include' ? '只显示包含该词的日志（含已存历史）' : '包含该词的日志整条丢弃',
      placeholder: '例如 [BATTLE]',
      success: (res: any) => {
        // 输入期间弹窗被关掉就丢弃这次输入
        if (this.settingsDialog !== dialog) return;
        if (!res || !res.ok) return;
        const word = String(res.inputValue === undefined ? '' : res.inputValue).trim();
        if (!word) return;

        const target = kind === 'include' ? dialog.include : dialog.ignore;
        const other = kind === 'include' ? dialog.ignore : dialog.include;
        // 同一个词不能既筛又排，出现在另一段里就先挪过来
        const otherIndex = other.indexOf(word);
        if (otherIndex >= 0) other.splice(otherIndex, 1);
        if (target.indexOf(word) < 0) target.push(word);
        this.applyDialogKeywords();
      },
    });
  }

  private setDialogTip(text: string): void {
    this.dialogTip = text;
    this.clearDialogTipTimer();
    const g: any = globalThis as any;
    if (typeof g.setTimeout === 'function') {
      this.dialogTipTimer = g.setTimeout(() => {
        this.dialogTipTimer = null;
        this.dialogTip = '';
        this.invalidate();
      }, 4000);
    }
    this.invalidate();
  }

  private clearDialogTipTimer(): void {
    const g: any = globalThis as any;
    if (this.dialogTipTimer !== null) {
      if (typeof g.clearTimeout === 'function') g.clearTimeout(this.dialogTipTimer);
      this.dialogTipTimer = null;
    }
  }

  private dialogRemoveRect(rowY: number, box: Rect): Rect {
    return { x: box.x + box.w - 12 - 22, y: rowY - 11, w: 22, h: 22 };
  }

  /** 弹窗几何：触摸与绘制共用一个纯函数，保证命中区和画出来的位置一致 */
  private getDialogLayout(dialog: SettingsDialogState): DialogLayout {
    const w = Math.max(220, Math.min(this.size.width - 32, 320));
    const titleH = 36;
    const secTitleH = 20;
    const emptyH = 20;
    const secGap = 8;
    const btnH = 28;
    const tipH = 22;

    const rowCount = (n: number): number =>
      n ? Math.min(n, DIALOG_MAX_WORDS) + (n > DIALOG_MAX_WORDS ? 1 : 0) : 0;
    const secH = (n: number): number => secTitleH + (n ? rowCount(n) * DIALOG_ROW_H : emptyH);

    const settingRows = dialog.tab === 'capacity' ? CAPACITY_ROWS : VIEW_ROWS;
    const contentH =
      dialog.tab === 'words'
        ? secH(dialog.include.length) + secGap + secH(dialog.ignore.length) + secGap + btnH
        : settingRows.length * DIALOG_SETTING_H + 6;

    const h = titleH + DIALOG_TAB_H + contentH + tipH;
    const x = Math.round((this.size.width - w) / 2);
    const y = Math.round((this.size.height - h) / 2);
    const box: Rect = { x, y, w, h };
    const close: Rect = { x: x + w - 8 - 30, y: y + 4, w: 30, h: 26 };

    // 标题下面那排小 tab
    const tabs: DialogTabHit[] = [];
    const tabInset = 12;
    const tabGap = 6;
    const tabW = Math.floor((w - tabInset * 2 - tabGap * 2) / 3);
    for (let i = 0; i < DIALOG_TABS.length; i++) {
      tabs.push({
        tab: DIALOG_TABS[i].tab,
        label: DIALOG_TABS[i].label,
        rect: {
          x: x + tabInset + i * (tabW + tabGap),
          y: y + titleH,
          w: tabW,
          h: DIALOG_TAB_H - 8,
        },
      });
    }

    const settings: DialogSettingRow[] = [];
    const rows: DialogRow[] = [];
    let includeTitleY = 0;
    let ignoreTitleY = 0;
    let includeTop = 0;
    let ignoreTop = 0;
    let addInclude: Rect = { x: 0, y: 0, w: 0, h: 0 };
    let addIgnore: Rect = { x: 0, y: 0, w: 0, h: 0 };

    let cursor = y + titleH + DIALOG_TAB_H;

    if (dialog.tab === 'words') {
      includeTitleY = cursor + secTitleH / 2;
      cursor += secTitleH;
      includeTop = cursor + DIALOG_ROW_H / 2;
      const includeShown = Math.min(dialog.include.length, DIALOG_MAX_WORDS);
      for (let i = 0; i < includeShown; i++) {
        rows.push({ kind: 'include', index: i, word: dialog.include[i], y: includeTop + i * DIALOG_ROW_H });
      }
      cursor += dialog.include.length ? rowCount(dialog.include.length) * DIALOG_ROW_H : emptyH;

      cursor += secGap;
      ignoreTitleY = cursor + secTitleH / 2;
      cursor += secTitleH;
      ignoreTop = cursor + DIALOG_ROW_H / 2;
      const ignoreShown = Math.min(dialog.ignore.length, DIALOG_MAX_WORDS);
      for (let i = 0; i < ignoreShown; i++) {
        rows.push({ kind: 'ignore', index: i, word: dialog.ignore[i], y: ignoreTop + i * DIALOG_ROW_H });
      }
      cursor += dialog.ignore.length ? rowCount(dialog.ignore.length) * DIALOG_ROW_H : emptyH;

      cursor += secGap;
      const btnW = Math.floor((w - 12 * 2 - 8) / 2);
      addInclude = { x: x + 12, y: cursor, w: btnW, h: btnH };
      addIgnore = { x: x + 12 + btnW + 8, y: cursor, w: btnW, h: btnH };
      cursor += btnH;
    } else {
      cursor += 3;
      for (let i = 0; i < settingRows.length; i++) {
        const rowY = cursor + DIALOG_SETTING_H / 2 + i * DIALOG_SETTING_H;
        settings.push({
          key: settingRows[i].key,
          label: settingRows[i].label,
          value: settingValueText(settingRows[i].key, this.settings),
          y: rowY,
          rect: { x: x + 10, y: rowY - DIALOG_SETTING_H / 2 + 2, w: w - 20, h: DIALOG_SETTING_H - 4 },
        });
      }
      cursor += settingRows.length * DIALOG_SETTING_H;
    }

    const tipY = cursor + 12;
    return { box, close, tabs, settings, addInclude, addIgnore, includeTitleY, ignoreTitleY, includeTop, ignoreTop, rows, tipY };
  }

  /** 每个分页底部的一句说明 */
  private dialogHint(tab: DialogTab): string {
    if (tab === 'words') return '排除词会存本地；筛选只影响显示';
    if (tab === 'capacity') return '调小内存上限会立即丢掉最旧的日志';
    return '点一行切换取值，设置会存本地';
  }

  private handleDialogTouch(x: number, y: number): void {
    const dialog = this.settingsDialog;
    if (!dialog) return;
    const geo = this.getDialogLayout(dialog);

    if (!insideRect(geo.box, x, y) || insideRect(geo.close, x, y)) {
      this.closeSettingsDialog();
      return;
    }

    // 切换分页
    for (let i = 0; i < geo.tabs.length; i++) {
      if (insideRect(geo.tabs[i].rect, x, y)) {
        if (dialog.tab !== geo.tabs[i].tab) {
          dialog.tab = geo.tabs[i].tab;
          this.invalidate();
        }
        return;
      }
    }

    // 点设置项：整行都是命中区，点一下切到下一个取值
    for (let i = 0; i < geo.settings.length; i++) {
      if (insideRect(geo.settings[i].rect, x, y)) {
        this.cycleSetting(geo.settings[i].key);
        return;
      }
    }

    if (dialog.tab !== 'words') return;

    if (insideRect(geo.addInclude, x, y)) {
      this.promptAddKeyword('include');
      return;
    }
    if (insideRect(geo.addIgnore, x, y)) {
      this.promptAddKeyword('ignore');
      return;
    }
    for (let i = 0; i < geo.rows.length; i++) {
      const row = geo.rows[i];
      if (insideRect(this.dialogRemoveRect(row.y, geo.box), x, y)) {
        this.removeKeyword(row.kind, row.index);
        return;
      }
    }
  }

  private renderSettingsDialog(): void {
    const dialog = this.settingsDialog;
    const ctx = this.ctx;
    if (!dialog || !ctx) return;

    const geo = this.getDialogLayout(dialog);
    const left = geo.box.x + 12;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, this.size.width, this.size.height);

    roundRectPath(ctx, geo.box.x, geo.box.y, geo.box.w, geo.box.h, 10);
    ctx.fillStyle = COLORS.panelBg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.panelBorder;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = FONT_BOLD;
    ctx.fillStyle = COLORS.title;
    ctx.fillText('面板设置', left, geo.box.y + 20);
    this.renderFlatButton(geo.close, '×', '#e0e0e0', 16);

    // 标题下面那排分页
    for (let i = 0; i < geo.tabs.length; i++) {
      const tab = geo.tabs[i];
      const active = tab.tab === dialog.tab;
      roundRectPath(ctx, tab.rect.x, tab.rect.y, tab.rect.w, tab.rect.h, 6);
      ctx.fillStyle = active ? COLORS.chipActiveBg : COLORS.chipBg;
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.font = FONT_SMALL;
      ctx.fillStyle = active ? COLORS.chipActiveText : COLORS.dim;
      ctx.fillText(tab.label, tab.rect.x + tab.rect.w / 2, tab.rect.y + tab.rect.h / 2);
    }

    if (dialog.tab === 'words') {
      this.renderDialogWords(dialog, geo, left);
    } else {
      for (let i = 0; i < geo.settings.length; i++) {
        const row = geo.settings[i];
        const rect = row.rect;
        roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 5);
        ctx.fillStyle = COLORS.cardBg;
        ctx.fill();

        ctx.textAlign = 'left';
        ctx.font = FONT;
        ctx.fillStyle = COLORS.text;
        ctx.fillText(row.label, rect.x + 8, row.y);

        const valueW = Math.min(DIALOG_VALUE_W, rect.w - 90);
        const valueX = rect.x + rect.w - valueW - 6;
        roundRectPath(ctx, valueX, rect.y + 3, valueW, rect.h - 6, 5);
        ctx.fillStyle = COLORS.chipBg;
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.font = FONT_SMALL;
        ctx.fillStyle = COLORS.title;
        ctx.fillText(row.value, valueX + valueW / 2, row.y);
      }
    }

    ctx.textAlign = 'left';
    ctx.font = FONT_SMALL;
    ctx.fillStyle = this.dialogTip ? COLORS.warn : COLORS.dim;
    ctx.fillText(this.dialogTip || this.dialogHint(dialog.tab), left, geo.tipY);
  }

  /** 词表分页：两段关键词，各自可增删 */
  private renderDialogWords(dialog: SettingsDialogState, geo: DialogLayout, left: number): void {
    const ctx = this.ctx;
    const sections = [
      {
        title: '筛选（只显示命中）',
        color: COLORS.info,
        words: dialog.include,
        titleY: geo.includeTitleY,
        top: geo.includeTop,
        empty: '空 · 全部日志都显示',
      },
      {
        title: '排除（整条丢弃 · 存本地）',
        color: COLORS.error,
        words: dialog.ignore,
        titleY: geo.ignoreTitleY,
        top: geo.ignoreTop,
        empty: '空 · 所有日志都会记录',
      },
    ];

    for (let s = 0; s < sections.length; s++) {
      const sec = sections[s];
      ctx.textAlign = 'left';
      ctx.font = FONT_SMALL;
      ctx.fillStyle = sec.color;
      ctx.fillText(sec.title, left, sec.titleY);

      if (!sec.words.length) {
        ctx.fillStyle = COLORS.dim;
        ctx.fillText(sec.empty, left + 4, sec.top);
        continue;
      }

      const shown = Math.min(sec.words.length, DIALOG_MAX_WORDS);
      for (let i = 0; i < shown; i++) {
        const rowY = sec.top + i * DIALOG_ROW_H;
        roundRectPath(ctx, left, rowY - DIALOG_ROW_H / 2 + 3, geo.box.w - 24, DIALOG_ROW_H - 6, 5);
        ctx.fillStyle = COLORS.cardBg;
        ctx.fill();

        ctx.textAlign = 'left';
        ctx.font = FONT;
        ctx.fillStyle = sec.color;
        ctx.fillText(this.ellipsis(sec.words[i], geo.box.w - 24 - 32), left + 8, rowY);

        const remove = this.dialogRemoveRect(rowY, geo.box);
        ctx.textAlign = 'center';
        ctx.fillStyle = COLORS.dim;
        ctx.fillText('×', remove.x + remove.w / 2, remove.y + remove.h / 2);
      }

      if (sec.words.length > DIALOG_MAX_WORDS) {
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.dim;
        ctx.fillText(
          '还有 ' + (sec.words.length - DIALOG_MAX_WORDS) + ' 个，用 API 查看全部',
          left + 8,
          sec.top + DIALOG_MAX_WORDS * DIALOG_ROW_H
        );
      }
    }

    this.renderFlatButton(geo.addInclude, '+ 筛选词', COLORS.info);
    this.renderFlatButton(geo.addIgnore, '+ 排除词', COLORS.error);
  }

  private hitButton(x: number, y: number): boolean {
    const dx = x - this.button.x;
    const dy = y - this.button.y;
    const radius = this.button.r + 8; // 稍微放大命中范围，手指好点
    return dx * dx + dy * dy <= radius * radius;
  }

  private clampButton(): void {
    const r = this.button.r;
    this.button.x = clamp(this.button.x, r + 4, Math.max(r + 4, this.size.width - r - 4));
    this.button.y = clamp(this.button.y, r + 4, Math.max(r + 4, this.size.height - r - 4));
  }

  /** 布局只在屏幕尺寸或当前 tab 变化时重算，其余帧直接复用 */
  private getLayout(): Layout {
    const key = this.size.width + 'x' + this.size.height + '|' + this.filter;
    if (this.layoutCache && this.layoutKey === key) {
      this.layout = this.layoutCache;
      return this.layoutCache;
    }
    this.layoutCache = this.computeLayout();
    this.layoutKey = key;
    this.layout = this.layoutCache;
    return this.layoutCache;
  }

  private computeLayout(): Layout {
    const margin = 10;
    const headerHeight = 40;
    const toolbarHeight = 34;

    // 面板不铺满整屏：高度取屏幕的 75%，底部贴边，上方留出遮罩区域，点一下就收起
    const panelHeight = Math.min(
      this.size.height - margin * 2,
      Math.max(200, Math.round(this.size.height * 0.75))
    );
    const panel: Rect = {
      x: margin,
      y: this.size.height - margin - panelHeight,
      w: Math.max(120, this.size.width - margin * 2),
      h: panelHeight,
    };

    const header: Rect = { x: panel.x, y: panel.y, w: panel.w, h: headerHeight };
    const toolbar: Rect = { x: panel.x, y: panel.y + headerHeight, w: panel.w, h: toolbarHeight };

    // net tab 顶部多一条网络状态栏（在线状态、进行中数量），列表相应下移
    const netBarH = this.filter === 'net' ? 24 : 0;
    const netBar: Rect = { x: panel.x, y: toolbar.y + toolbarHeight, w: panel.w, h: netBarH };
    const list: Rect = {
      x: panel.x,
      y: netBar.y + netBarH,
      w: panel.w,
      h: panel.h - headerHeight - toolbarHeight - netBarH,
    };

    const close: Rect = { x: panel.x + panel.w - 8 - 30, y: panel.y + 6, w: 30, h: 28 };
    const clear: Rect = { x: close.x - 8 - 48, y: panel.y + 8, w: 48, h: 24 };
    // 「设置」放在「清空」左边；窄屏时先保证标题区还剩 90px
    const filterW = Math.max(30, Math.min(46, clear.x - 6 - panel.x - 90));
    const filterBtn: Rect = { x: clear.x - 6 - filterW, y: panel.y + 8, w: filterW, h: 24 };

    const chips: ChipHit[] = [];
    // 六个 tab，窄屏时自动缩窄，避免挤出面板
    const chipGap = 6;
    const available = Math.max(60, toolbar.w - 20);
    const chipW = Math.max(
      30,
      Math.min(48, Math.floor((available - chipGap * (FILTERS.length - 1)) / FILTERS.length))
    );
    const chipH = 24;
    let chipX = toolbar.x + 10;
    const chipY = toolbar.y + (toolbar.h - chipH) / 2;
    FILTERS.forEach((item) => {
      chips.push({ level: item.level, label: item.label, rect: { x: chipX, y: chipY, w: chipW, h: chipH } });
      chipX += chipW + chipGap;
    });

    return { panel, header, toolbar, netBar, list, filterBtn, clear, close, chips };
  }

  private renderButton(): void {
    const ctx = this.ctx;
    const { x, y, r } = this.button;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.buttonBg;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.buttonBorder;
    ctx.stroke();

    ctx.fillStyle = COLORS.buttonText;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('LOG', x, y);
  }

  private renderPanel(): void {
    const ctx = this.ctx;
    const layout = this.getLayout();

    // 标题栏要显示筛选后的条数，先把列表缓存算出来；renderList 会命中同一份
    if (this.filter !== 'net') this.getListCache(Math.max(40, layout.list.w - 26));

    ctx.fillStyle = COLORS.maskBg;
    ctx.fillRect(0, 0, this.size.width, this.size.height);

    // 面板底
    roundRectPath(ctx, layout.panel.x, layout.panel.y, layout.panel.w, layout.panel.h, 12);
    ctx.fillStyle = COLORS.panelBg;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.panelBorder;
    ctx.stroke();

    // 标题栏
    roundRectPath(ctx, layout.header.x, layout.header.y, layout.header.w, layout.header.h, 12, true);
    ctx.fillStyle = COLORS.headerBg;
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = FONT_BOLD;
    ctx.fillStyle = COLORS.title;
    const titleY = layout.header.y + layout.header.h / 2;
    ctx.fillText('Console', layout.header.x + 12, titleY);

    const titleWidth = ctx.measureText('Console').width;
    ctx.font = FONT_SMALL;
    ctx.fillStyle = COLORS.dim;
    const countText = this.countText();
    ctx.fillText(countText, layout.header.x + 12 + titleWidth + 8, titleY + 1);

    // 版本号跟在计数后面，方便在真机上确认装的是哪个产物
    if (this.versionLabel) {
      const countWidth = ctx.measureText(countText).width;
      ctx.fillText(this.versionLabel, layout.header.x + 12 + titleWidth + 8 + countWidth + 8, titleY + 1);
    }

    this.renderFlatButton(layout.filterBtn, '设置', '#9ecbff');
    this.renderFlatButton(layout.clear, '清空', '#e0e0e0');
    this.renderFlatButton(layout.close, '×', '#e0e0e0', 16);

    // 过滤条
    ctx.fillStyle = COLORS.toolbarBg;
    ctx.fillRect(layout.toolbar.x, layout.toolbar.y, layout.toolbar.w, layout.toolbar.h);

    ctx.font = FONT_SMALL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    layout.chips.forEach((chip) => {
      const active = chip.level === this.filter;
      roundRectPath(ctx, chip.rect.x, chip.rect.y, chip.rect.w, chip.rect.h, 12);
      ctx.fillStyle = active ? COLORS.chipActiveBg : COLORS.chipBg;
      ctx.fill();
      ctx.fillStyle = active ? COLORS.chipActiveText : COLORS.dim;
      ctx.fillText(chip.label, chip.rect.x + chip.rect.w / 2, chip.rect.y + chip.rect.h / 2);
    });

    if (this.filter === 'net') this.renderNetBar(layout.netBar);
    this.renderList(layout);
  }

  private countText(): string {
    if (this.filter === 'net') {
      const pending = this.net.pending();
      const total = this.net.total();
      return pending > 0 ? total + ' · ' + pending + ' 进行中' : String(total);
    }
    // 用筛选后的条数：1000 条历史里只有命中的才显示，标题栏要跟着变
    const cache = this.listCache;
    const stored = this.store.count('all');
    const matched = cache ? cache.counts.all : stored;
    const shown = cache ? cache.entries.length : stored;
    if (this.filter === 'all') {
      // 显示上限截断时写成「显示 300 / 命中 1000」，否则容易误以为日志丢了；
      // 有筛选词时再带上库内总数「命中 111 / 共 1000」，说明历史还在
      if (shown < matched) return shown + '/' + matched;
      if (matched < stored) return matched + '/' + stored;
      return String(stored);
    }
    const total = matched;
    const current = cache ? cache.counts[this.filter] || 0 : this.store.count(this.filter);
    return current + '/' + total;
  }

  /** net tab 顶部状态栏：在线状态 + 网络类型 + 进行中/总数 */
  private renderNetBar(rect: Rect): void {
    const ctx = this.ctx;
    if (rect.h <= 0) return;

    ctx.fillStyle = COLORS.toolbarBg;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    const cy = rect.y + rect.h / 2;
    ctx.beginPath();
    ctx.arc(rect.x + 15, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = this.netState.online ? COLORS.success : COLORS.error;
    ctx.fill();

    ctx.font = FONT_SMALL;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(this.netStateText(), rect.x + 25, cy);

    ctx.textAlign = 'right';
    const pending = this.net.pending();
    ctx.fillStyle = pending > 0 ? COLORS.warn : COLORS.dim;
    ctx.fillText('进行中 ' + pending + ' / 共 ' + this.net.total(), rect.x + rect.w - 10, cy);
    ctx.textAlign = 'left';
  }

  private netStateText(): string {
    if (!this.netState.online) return '离线';
    const type = String(this.netState.type || 'unknown').toLowerCase();
    if (type === 'unknown' || type === 'none') return '在线 · 网络未知';
    if (type === 'wifi') return '在线 · WIFI';
    return '在线 · ' + type.toUpperCase();
  }

  /** 网络状态变化（宿主回调 / 轮询兜底），只在面板打开且状态真的变了才重绘 */
  private applyNetState(state: NetworkState): void {
    const changed = state.online !== this.netState.online || state.type !== this.netState.type;
    this.netState = state;
    if (changed) this.onNetChange();
  }

  /** 有请求进行中时按固定间隔重绘，让耗时实时跳动 */
  private scheduleTick(): void {
    if (this.tickTimer !== null) return;
    const g: any = globalThis as any;
    if (typeof g.setTimeout !== 'function') return;
    this.tickTimer = g.setTimeout(() => {
      this.tickTimer = null;
      if (!this.visible || this.filter !== 'net') return;
      if (this.net.pending() <= 0) return;
      this.invalidate();
    }, NET_TICK_INTERVAL);
  }

  /** 清掉定时器并解绑网络状态监听 */
  destroy(): void {
    const g: any = globalThis as any;
    if (this.tickTimer !== null && typeof g.clearTimeout === 'function') {
      g.clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.throttleTimer !== null && typeof g.clearTimeout === 'function') {
      g.clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.clearDialogTipTimer();
    this.settingsDialog = null;
    if (this.netStateTimer) {
      try {
        this.netStateTimer();
      } catch (e) {
        // ignore
      }
      this.netStateTimer = null;
    }
    this.netHits.length = 0;
  }

  private renderFlatButton(rect: Rect, label: string, color: string, fontSize?: number): void {
    const ctx = this.ctx;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 6);
    ctx.fillStyle = COLORS.chipBg;
    ctx.fill();

    ctx.fillStyle = color;
    ctx.font = fontSize ? 'bold ' + fontSize + 'px sans-serif' : FONT_SMALL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2);
  }

  private renderList(layout: Layout): void {
    const ctx = this.ctx;
    const listRect = layout.list;

    if (this.filter === 'net') {
      this.renderNetList(listRect);
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(listRect.x + 1, listRect.y, listRect.w - 2, listRect.h);
    ctx.clip();

    const maxWidth = Math.max(40, listRect.w - 26);
    const cache = this.getListCache(maxWidth);
    const filtered = cache.entries;
    this.rowHits.length = 0;

    if (!filtered.length) {
      ctx.fillStyle = COLORS.dim;
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyText(), listRect.x + listRect.w / 2, listRect.y + listRect.h / 2);
      this.maxScroll = 0;
      this.scroll = 0;
      ctx.restore();
      return;
    }

    // 「跟随最新」关掉时，新日志进来要把同样的位移补给 scroll，画面才不会自己往上跑
    if (!followTail && this.lastContentHeight > 0 && cache.contentHeight > this.lastContentHeight && this.scroll > 0) {
      this.scroll += cache.contentHeight - this.lastContentHeight;
    }
    this.lastContentHeight = cache.contentHeight;

    this.maxScroll = Math.max(0, cache.contentHeight - listRect.h);
    this.scroll = clamp(this.scroll, 0, this.maxScroll);

    // 从最新一条往上排：scroll = 0 时底部对齐最新日志
    let bottom = listRect.y + listRect.h + this.scroll;
    const topEdge = listRect.y - LINE_HEIGHT;

    for (let i = filtered.length - 1; i >= 0; i--) {
      const rowHeight = cache.heights[i];
      const top = bottom - rowHeight;
      if (top > listRect.y + listRect.h) {
        bottom = top;
        continue;
      }
      const expanded = this.expandedLogIds.indexOf(filtered[i].id) >= 0;
      if (cache.expandable[i]) {
        this.rowHits.push({
          id: filtered[i].id,
          rect: { x: listRect.x, y: top, w: listRect.w, h: rowHeight },
          expandable: true,
        });
      }
      if (filtered[i].runs) {
        this.renderRichRow(filtered[i], cache.runs[i], listRect.x, top, rowHeight, cache.expandable[i], expanded);
      } else {
        this.renderRow(filtered[i], cache.lines[i], listRect.x, top, rowHeight, cache.expandable[i], expanded);
      }
      bottom = top;
      if (top < topEdge) break;
    }

    ctx.restore();
  }

  /**
   * 过滤 + 换行结果缓存。
   * 日志只增不改，只要版本号、当前 tab、可用宽度都没变就直接复用，
   * 拖动滚动条时不再重复分配这些数组。
   */
  private getListCache(maxWidth: number): ListCache {
    const expandedKey = this.expandedLogIds.join(',');
    const cache = this.listCache;
    if (
      cache &&
      cache.version === this.store.version &&
      cache.filter === this.filter &&
      cache.width === maxWidth &&
      cache.expandedKey === expandedKey
    ) {
      return cache;
    }

    const entries = this.store.list();
    // 被上限淘汰掉的旧日志不再保留展开状态
    const oldest = entries.length ? entries[0].id : 0;
    for (let i = this.expandedLogIds.length - 1; i >= 0; i--) {
      if (this.expandedLogIds[i] < oldest) this.expandedLogIds.splice(i, 1);
    }

    const filtered: LogEntry[] = [];
    const heights: number[] = [];
    const lines: string[][] = [];
    const runs: RunLine[][] = [];
    const expandable: boolean[] = [];
    const counts: Record<string, number> = { all: 0, log: 0, info: 0, warn: 0, error: 0 };

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      // 筛选作用在展示层：内存里 1000 条全部保留，靠筛选词往回翻历史
      if (!this.store.matchesInclude(entry)) continue;
      counts.all++;
      counts[entry.level] = (counts[entry.level] || 0) + 1;
      if (!matchesFilter(entry, this.filter)) continue;

      const expanded = this.expandedLogIds.indexOf(entry.id) >= 0;

      filtered.push(entry);
      if (entry.runs) {
        const runLines = this.layoutRuns(entry, maxWidth, expanded);
        const canExpand = expanded ? runLines.length > visibleLines(false) : !!entry.runWrapCache?.more;
        runs.push(runLines);
        lines.push([]);
        heights.push(runLines.length * LINE_HEIGHT + ROW_GAP + (canExpand ? EXPAND_HINT_H : 0));
        expandable.push(canExpand);
      } else {
        const wrapped = this.wrapEntry(entry, maxWidth, expanded);
        const canExpand = expanded ? wrapped.length > visibleLines(false) : !!entry.wrapCache?.more;
        lines.push(wrapped);
        runs.push([]);
        heights.push(wrapped.length * LINE_HEIGHT + ROW_GAP + (canExpand ? EXPAND_HINT_H : 0));
        expandable.push(canExpand);
      }
    }

    // 显示上限：只往回画最近 N 条，更早的历史留在内存里，靠筛选词才能看到
    const limit = this.store.displayLimit;
    if (limit > 0 && filtered.length > limit) {
      const overflow = filtered.length - limit;
      filtered.splice(0, overflow);
      heights.splice(0, overflow);
      lines.splice(0, overflow);
      runs.splice(0, overflow);
      expandable.splice(0, overflow);
    }

    let contentHeight = 0;
    for (let i = 0; i < heights.length; i++) contentHeight += heights[i];

    this.listCache = {
      version: this.store.version,
      filter: this.filter,
      width: maxWidth,
      expandedKey,
      entries: filtered,
      heights,
      lines,
      runs,
      expandable,
      counts,
      contentHeight,
    };
    return this.listCache;
  }

  private emptyText(): string {
    if (this.filter === 'all') return '暂无日志';
    if (this.filter === 'net') return '暂无网络日志';
    return '当前级别暂无日志';
  }

  /**
   * 网络 tab：每条请求一张卡片，收起时显示 method / url / 状态 / 耗时，
   * 点开显示 url、请求头、请求体、响应头、响应体、错误。
   */
  private renderNetList(listRect: Rect): void {
    const ctx = this.ctx;
    const records = this.net.list();
    this.netHits.length = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(listRect.x + 1, listRect.y, listRect.w - 2, listRect.h);
    ctx.clip();

    if (!records.length) {
      ctx.fillStyle = COLORS.dim;
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无网络日志', listRect.x + listRect.w / 2, listRect.y + listRect.h / 2);
      this.maxScroll = 0;
      this.scroll = 0;
      ctx.restore();
      return;
    }

    const cardX = listRect.x + 8;
    const cardW = Math.max(80, listRect.w - 16);
    const detailWidth = cardW - NET_CARD_PAD * 2 - 10;
    const heights: number[] = [];
    const details: string[][] = [];
    let contentHeight = 0;

    for (let i = 0; i < records.length; i++) {
      const expanded = records[i].id === this.expandedNetId;
      const lines = expanded ? this.netDetailLines(records[i], detailWidth) : [];
      const cardH = expanded ? NET_DETAIL_TOP + lines.length * NET_LINE_HEIGHT + NET_CARD_PAD : NET_COLLAPSED_H;
      heights.push(cardH);
      details.push(lines);
      contentHeight += cardH + NET_CARD_GAP;
    }

    this.maxScroll = Math.max(0, contentHeight - listRect.h);
    this.scroll = clamp(this.scroll, 0, this.maxScroll);

    // 与日志列表一致：底部对齐最新一条
    let bottom = listRect.y + listRect.h + this.scroll;
    const topEdge = listRect.y - NET_COLLAPSED_H * 2;

    for (let i = records.length - 1; i >= 0; i--) {
      const rowHeight = heights[i] + NET_CARD_GAP;
      const top = bottom - rowHeight;
      if (top > listRect.y + listRect.h) {
        bottom = top;
        continue;
      }
      this.renderNetCard(records[i], details[i], cardX, top, heights[i], cardW);
      bottom = top;
      if (top < topEdge) break;
    }

    ctx.restore();

    // 有请求还在跑，定时重绘让耗时实时跳动
    if (this.net.pending() > 0) this.scheduleTick();
  }

  private renderNetCard(record: NetRecord, detailLines: string[], x: number, top: number, cardH: number, cardW: number): void {
    const ctx = this.ctx;
    const statusColor = this.netStatusColor(record);

    roundRectPath(ctx, x, top, cardW, cardH, 8);
    ctx.fillStyle = COLORS.cardBg;
    ctx.fill();

    // 左侧状态色条
    ctx.fillStyle = statusColor;
    ctx.fillRect(x + 1, top + NET_CARD_PAD, 2, 16);

    const line1Y = top + NET_CARD_PAD + 8;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.netMethodColor(record.method);
    const methodX = x + NET_CARD_PAD + 4;
    ctx.fillText(record.method, methodX, line1Y);
    const methodWidth = ctx.measureText(record.method).width;

    // 状态徽标靠右
    const badge: Rect = { x: x + cardW - NET_CARD_PAD - 46, y: top + NET_CARD_PAD, w: 46, h: 16 };
    roundRectPath(ctx, badge.x, badge.y, badge.w, badge.h, 5);
    ctx.fillStyle = COLORS.chipBg;
    ctx.fill();
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'center';
    ctx.fillStyle = statusColor;
    ctx.fillText(this.netBadgeText(record), badge.x + badge.w / 2, badge.y + badge.h / 2);
    ctx.textAlign = 'left';

    const urlX = methodX + methodWidth + 8;
    const urlMax = Math.max(24, badge.x - 8 - urlX);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(this.netUrlText(record, urlMax), urlX, line1Y);

    // 第二行：时间 · 耗时 · 大小 + 展开提示
    const metaY = top + NET_CARD_PAD + 23;
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(this.netMetaText(record), x + NET_CARD_PAD + 4, metaY);
    ctx.textAlign = 'right';
    ctx.fillText(record.id === this.expandedNetId ? '收起' : '详情 +', x + cardW - NET_CARD_PAD, metaY);
    ctx.textAlign = 'left';

    if (record.id === this.expandedNetId && detailLines.length) {
      ctx.textBaseline = 'top';
      let dy = top + NET_DETAIL_TOP;
      for (let i = 0; i < detailLines.length; i++) {
        const line = detailLines[i];
        ctx.fillStyle = line.charAt(0) === '▸' ? COLORS.title : COLORS.text;
        ctx.fillText(line, x + NET_CARD_PAD + 4, dy);
        dy += NET_LINE_HEIGHT;
      }
      ctx.textBaseline = 'middle';
    }

    this.netHits.push({ id: record.id, rect: { x, y: top, w: cardW, h: cardH } });
  }

  /** 展开详情：按「▸ 标题 + 缩进内容」拼接，结果缓存在记录上 */
  private netDetailLines(record: NetRecord, maxWidth: number): string[] {
    const cache = record.wrapCache;
    if (cache && cache.expanded && cache.width === maxWidth) return cache.lines;

    const ctx = this.ctx;
    ctx.font = FONT_SMALL;

    const lines: string[] = [];
    const pushSection = (title: string, body: string) => {
      if (!body) return;
      lines.push('▸ ' + title);
      const wrapped = this.wrapPlain(body, maxWidth);
      for (let i = 0; i < wrapped.length; i++) lines.push('  ' + wrapped[i]);
    };

    pushSection('URL', record.url);
    pushSection('请求头', record.requestHeaders);
    pushSection('请求体', record.requestBody);
    pushSection('响应头', record.responseHeaders);
    pushSection('响应体', record.responseBody);
    pushSection('错误', record.error);

    const result = lines.length > MAX_DETAIL_LINES ? lines.slice(0, MAX_DETAIL_LINES).concat(['  …']) : lines;
    record.wrapCache = { width: maxWidth, expanded: true, lines: result };
    return result;
  }

  /** 纯文本换行（网络详情用，不需要 entry 结构） */
  private wrapPlain(text: string, maxWidth: number): string[] {
    const ctx = this.ctx;
    const lines: string[] = [];
    const paragraphs = text.replace(/\r\n/g, '\n').split('\n');

    for (let p = 0; p < paragraphs.length; p++) {
      if (lines.length >= MAX_DETAIL_LINES) break;
      const paragraph = paragraphs[p];
      if (!paragraph) {
        lines.push('');
        continue;
      }
      if (ctx.measureText(paragraph).width <= maxWidth) {
        lines.push(paragraph);
        continue;
      }

      let line = '';
      for (let i = 0; i < paragraph.length; i++) {
        const next = line + paragraph.charAt(i);
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line);
          line = paragraph.charAt(i);
          if (lines.length >= MAX_DETAIL_LINES) break;
        } else {
          line = next;
        }
      }
      if (line && lines.length < MAX_DETAIL_LINES) lines.push(line);
    }

    return lines;
  }

  /** 折叠态单行 url 的省略结果：宽度不变就复用，省掉每帧几十次 measureText */
  private netUrlText(record: NetRecord, maxWidth: number): string {
    const cache = record.urlCache;
    if (cache && cache.width === maxWidth) return cache.text;
    const text = this.ellipsis(record.url, maxWidth);
    record.urlCache = { width: maxWidth, text };
    return text;
  }

  /** 单行截断，二分查找省掉逐字测量 */
  private ellipsis(text: string, maxWidth: number): string {
    const ctx = this.ctx;
    if (ctx.measureText(text).width <= maxWidth) return text;

    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low) + '…';
  }

  private netBadgeText(record: NetRecord): string {
    if (record.status === 'pending') return '···';
    if (record.status === 'fail') return 'ERR';
    return record.statusCode > 0 ? String(record.statusCode) : 'OK';
  }

  private netMetaText(record: NetRecord): string {
    const cost = record.status === 'pending' ? Date.now() - record.startedAt : record.cost;
    const parts = [record.time, formatCost(cost)];
    if (record.status === 'pending') parts.push('请求中…');
    else if (record.status === 'fail') parts.push('失败');

    const size = record.responseBody.length;
    if (size > 0) parts.push(size >= 1024 ? (size / 1024).toFixed(1) + 'KB' : size + 'B');
    return parts.join(' · ');
  }

  private netStatusColor(record: NetRecord): string {
    if (record.status === 'pending') return COLORS.warn;
    if (record.status === 'fail') return COLORS.error;
    if (record.statusCode >= 500) return COLORS.error;
    if (record.statusCode >= 400) return COLORS.warn;
    return COLORS.success;
  }

  private netMethodColor(method: string): string {
    switch (method) {
      case 'GET':
        return COLORS.success;
      case 'POST':
        return COLORS.info;
      case 'PUT':
      case 'PATCH':
        return COLORS.warn;
      case 'DELETE':
        return COLORS.error;
      default:
        return COLORS.dim;
    }
  }

  private renderRow(
    entry: LogEntry,
    lines: string[],
    listX: number,
    top: number,
    height: number,
    expandable: boolean,
    expanded: boolean
  ): void {
    const ctx = this.ctx;
    const color = levelColor(entry.level);

    ctx.fillStyle = color;
    ctx.fillRect(listX + 8, top + 3, 2, Math.max(4, height - ROW_GAP - 2));

    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], listX + 16, top + 3 + i * LINE_HEIGHT);
    }

    if (expandable) this.renderExpandHint(top, lines.length, expanded);
  }

  /** 可展开的行在最后一行下面留一条窄带标出「展开 / 收起」，不压正文 */
  private renderExpandHint(top: number, lineCount: number, expanded: boolean): void {
    const ctx = this.ctx;
    const listRect = this.layout ? this.layout.list : null;
    if (!listRect) return;
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(expanded ? '收起' : '展开全文', listRect.x + 16, top + 2 + lineCount * LINE_HEIGHT);
    ctx.font = FONT;
  }

  /** 富文本渲染：带 %c 样式的日志走这条路径，先铺背景再画文字 */
  private renderRichRow(
    entry: LogEntry,
    lines: RunLine[],
    listX: number,
    top: number,
    height: number,
    expandable: boolean,
    expanded: boolean
  ): void {
    const ctx = this.ctx;

    ctx.fillStyle = levelColor(entry.level);
    ctx.fillRect(listX + 8, top + 3, 2, Math.max(4, height - ROW_GAP - 2));

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = FONT;
    let boldFont = false;

    for (let i = 0; i < lines.length; i++) {
      const pieces = lines[i].pieces;
      if (!pieces.length) continue;
      const lineTop = top + 3 + i * LINE_HEIGHT;

      // 背景先整体画完，避免后一段的背景盖住前一段文字
      for (let p = 0; p < pieces.length; p++) {
        const style = pieces[p].style;
        if (!style || !style.background) continue;
        const bx = listX + 16 + pieces[p].x;
        const bw = pieces[p].padX * 2 + pieces[p].w;
        const bh = LINE_HEIGHT - 3;
        ctx.fillStyle = style.background;
        if (style.radius > 0) {
          roundRectPath(ctx, bx, lineTop - 1, bw, bh, style.radius);
          ctx.fill();
        } else {
          ctx.fillRect(bx, lineTop - 1, bw, bh);
        }
      }

      for (let p = 0; p < pieces.length; p++) {
        const piece = pieces[p];
        const style = piece.style;
        // 一行的片段大多同字号，只有加粗状态变化时才重新设字体
        const bold = !!(style && style.bold);
        if (bold !== boldFont) {
          ctx.font = bold ? FONT_RUN_BOLD : FONT;
          boldFont = bold;
        }
        ctx.fillStyle = (style && style.color) || levelColor(entry.level);
        ctx.fillText(piece.text, listX + 16 + piece.x + piece.padX, lineTop);
      }
    }

    ctx.font = FONT;
    if (expandable) this.renderExpandHint(top, lines.length, expanded);
  }

  /**
   * 富文本换行：按字符累加宽度，样式切换或超宽时切段/换行。
   * 时间前缀作为无样式的一段拼在最前面，结果缓存在 entry 上。
   */
  private layoutRuns(entry: LogEntry, maxWidth: number, expanded: boolean): RunLine[] {
    const cache = entry.runWrapCache;
    if (cache && cache.width === maxWidth && !!cache.expanded === expanded) return cache.lines as RunLine[];

    // 收起时多算一行用于判断「是否还有更多」
    const limit = expanded ? MAX_LINES_PER_ENTRY : visibleLines(false) + 1;
    const ctx = this.ctx;
    const runs = entry.runs || [];
    const lines: RunLine[] = [{ pieces: [] }];
    let current = lines[0];
    let x = 0;
    let open: RunPiece | null = null;
    let openStyle: TextStyle | undefined;

    const closePiece = () => {
      if (open) {
        x += open.padX;
        open = null;
      }
    };

    const newLine = () => {
      closePiece();
      current = { pieces: [] };
      lines.push(current);
      x = 0;
    };

    const feed = (text: string, style: TextStyle | undefined) => {
      if (!text) return;
      if (style !== openStyle) {
        closePiece();
        openStyle = style;
      }
      const padX = style && style.paddingX ? style.paddingX : 0;
      ctx.font = style && style.bold ? FONT_RUN_BOLD : FONT;

      for (let i = 0; i < text.length; i++) {
        if (lines.length > limit) return;
        const ch = text.charAt(i);
        if (ch === '\n') {
          newLine();
          continue;
        }
        const charWidth = ctx.measureText(ch).width;
        if (open) {
          if (x + charWidth > maxWidth) newLine();
        } else if (current.pieces.length && x + padX + charWidth > maxWidth) {
          newLine();
        }
        if (!open) {
          open = { text: '', style, x, w: 0, padX };
          current.pieces.push(open);
          x += padX;
        }
        open.text += ch;
        open.w += charWidth;
        x += charWidth;
      }
    };

    if (showTime) feed('[' + entry.time + '] ', undefined);
    for (let i = 0; i < runs.length; i++) feed(runs[i].text, runs[i].style);
    closePiece();

    while (lines.length && !lines[lines.length - 1].pieces.length) lines.pop();
    ctx.font = FONT;

    // 超出可见行数就截断，并在最后一行补一个省略号片段
    const visible = visibleLines(expanded);
    const more = lines.length > visible;
    if (more) {
      lines.length = visible;
      const last = lines[visible - 1];
      const tail = last.pieces[last.pieces.length - 1];
      const tailX = tail ? tail.x + tail.padX * 2 + tail.w : 0;
      last.pieces.push({ text: ' …', x: tailX, w: 0, padX: 0 });
    }

    entry.runWrapCache = { width: maxWidth, expanded, more, lines };
    return lines;
  }

  /** 按面板宽度换行，结果缓存在 entry 上，日志不变就不重复测量 */
  private wrapEntry(entry: LogEntry, maxWidth: number, expanded: boolean): string[] {
    const cache = entry.wrapCache;
    if (cache && cache.width === maxWidth && !!cache.expanded === expanded) return cache.lines;

    // 收起时只要判断「是否还有更多」，多量一行就够，不必量满 40 行
    const limit = expanded ? MAX_LINES_PER_ENTRY : visibleLines(false) + 1;
    const ctx = this.ctx;
    const content = (showTime ? '[' + entry.time + '] ' : '') + entry.text;
    const lines: string[] = [];
    const paragraphs = content.split('\n');
    let more = false;

    ctx.font = FONT;
    for (let p = 0; p < paragraphs.length && !more; p++) {
      const paragraph = paragraphs[p];
      if (!paragraph) {
        lines.push('');
        if (lines.length >= limit) more = true;
        continue;
      }
      if (ctx.measureText(paragraph).width <= maxWidth) {
        lines.push(paragraph);
        if (lines.length >= limit) more = true;
        continue;
      }
      let line = '';
      for (let i = 0; i < paragraph.length; i++) {
        const next = line + paragraph[i];
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line);
          line = paragraph[i];
          if (lines.length >= limit) {
            more = true;
            break;
          }
        } else {
          line = next;
        }
      }
      if (more) break;
      if (line) {
        lines.push(line);
        if (lines.length >= limit) more = true;
      }
    }

    if (!expanded) {
      const visible = visibleLines(false);
      if (more && lines.length > visible) {
        lines.length = visible;
        lines[visible - 1] = lines[visible - 1] + ' …';
      }
    } else if (lines.length >= MAX_LINES_PER_ENTRY) {
      lines.length = MAX_LINES_PER_ENTRY;
      lines[MAX_LINES_PER_ENTRY - 1] = lines[MAX_LINES_PER_ENTRY - 1] + ' …';
    }

    entry.wrapCache = { width: maxWidth, expanded, more, lines };
    return lines;
  }
}
