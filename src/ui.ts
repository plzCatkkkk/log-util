/**
 * 面板视图：全部用 Canvas 2D 绘制（支付宝小游戏没有 DOM），
 * 命中检测自己算，触摸由 env.bindTouch 统一喂进来。
 */
import { matchesFilter } from './console';
import type { LogEntry, LogFilter, LogLevel, LogStore, TextStyle } from './console';
import { bindNetworkState, resizeCanvas } from './env';
import type { NetworkState, ScreenSize } from './env';
import type { NetRecord, NetStore } from './network';

type Rect = { x: number; y: number; w: number; h: number };

const FONT = '12px sans-serif';
const FONT_BOLD = 'bold 13px sans-serif';
/** 富文本里加粗用同字号，避免行高对不齐 */
const FONT_RUN_BOLD = 'bold 12px sans-serif';
const FONT_SMALL = '11px sans-serif';
const LINE_HEIGHT = 17;
const ROW_GAP = 6;
const MAX_LINES_PER_ENTRY = 40;

/** 网络卡片：行高、卡片间距、上下内边距 */
const NET_LINE_HEIGHT = 15;
const NET_CARD_GAP = 8;
const NET_CARD_PAD = 8;
const NET_COLLAPSED_H = 47;
const NET_DETAIL_TOP = 45;
const MAX_DETAIL_LINES = 80;
/** 有请求进行中时的实时刷新间隔 */
const NET_TICK_INTERVAL = 400;

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
  clear: Rect;
  close: Rect;
  chips: ChipHit[];
}

interface NetHit {
  id: number;
  rect: Rect;
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
  entries: LogEntry[];
  heights: number[];
  lines: string[][];
  runs: RunLine[][];
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
  private netState: NetworkState = { online: true, type: 'unknown' };
  private netStateTimer: any = null;
  private tickTimer: any = null;
  /** 布局与 console 列表缓存，避免每帧重复计算 */
  private layoutCache: Layout | null = null;
  private layoutKey = '';
  private listCache: ListCache | null = null;

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
    this.versionLabel = options.version ? 'v' + options.version : '';

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
    if (this.onOpenChange) this.onOpenChange(false);
    this.invalidate();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  addLog(): void {
    if (this.visible) this.invalidate();
  }

  invalidate(): void {
    if (this.pending) return;
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

    const dpr = this.size.pixelRatio || 1;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.size.width, this.size.height);

    if (this.visible) this.renderPanel();
    else this.renderButton();

    if (this.onFrame) {
      try {
        this.onFrame();
      } catch (e) {
        // 上屏失败不能影响绘制
      }
    }
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
      if (insideRect(layout.clear, x, y)) {
        this.store.clear();
        this.net.clear();
        this.expandedNetId = null;
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
        // 网络 tab 里按下落在某张卡片上：抬手时若没滑动就展开/收起详情
        this.pendingCardId = this.filter === 'net' ? this.hitNetCard(x, y) : null;
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
        this.pendingCardId = null;
        if (moved < 8 && cardId !== null) {
          this.expandedNetId = this.expandedNetId === cardId ? null : cardId;
          this.scroll = clamp(this.scroll, 0, this.maxScroll);
          this.invalidate();
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

  private setFilter(level: LogFilter): void {
    this.filter = level;
    this.scroll = 0;
    this.pendingCardId = null;
    this.invalidate();
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

    return { panel, header, toolbar, netBar, list, clear, close, chips };
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
    const consoleTotal = this.store.count('all');
    if (this.filter === 'all') return String(consoleTotal);
    return this.store.count(this.filter) + '/' + consoleTotal;
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

  /** 网络状态变化（宿主回调 / 轮询兜底），只在面板打开时触发重绘 */
  private applyNetState(state: NetworkState): void {
    this.netState = state;
    this.addLog();
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
      if (filtered[i].runs) this.renderRichRow(filtered[i], cache.runs[i], listRect.x, top, rowHeight);
      else this.renderRow(filtered[i], cache.lines[i], listRect.x, top, rowHeight);
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
    const cache = this.listCache;
    if (
      cache &&
      cache.version === this.store.version &&
      cache.filter === this.filter &&
      cache.width === maxWidth
    ) {
      return cache;
    }

    const entries = this.store.list();
    const filtered: LogEntry[] = [];
    const heights: number[] = [];
    const lines: string[][] = [];
    const runs: RunLine[][] = [];
    let contentHeight = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!matchesFilter(entry, this.filter)) continue;

      filtered.push(entry);
      if (entry.runs) {
        const runLines = this.layoutRuns(entry, maxWidth);
        runs.push(runLines);
        lines.push([]);
        const height = runLines.length * LINE_HEIGHT + ROW_GAP;
        heights.push(height);
        contentHeight += height;
      } else {
        const wrapped = this.wrapEntry(entry, maxWidth);
        lines.push(wrapped);
        runs.push([]);
        const height = wrapped.length * LINE_HEIGHT + ROW_GAP;
        heights.push(height);
        contentHeight += height;
      }
    }

    this.listCache = { version: this.store.version, filter: this.filter, width: maxWidth, entries: filtered, heights, lines, runs, contentHeight };
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

  private renderRow(entry: LogEntry, lines: string[], listX: number, top: number, height: number): void {
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
  }

  /** 富文本渲染：带 %c 样式的日志走这条路径，先铺背景再画文字 */
  private renderRichRow(entry: LogEntry, lines: RunLine[], listX: number, top: number, height: number): void {
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
  }

  /**
   * 富文本换行：按字符累加宽度，样式切换或超宽时切段/换行。
   * 时间前缀作为无样式的一段拼在最前面，结果缓存在 entry 上。
   */
  private layoutRuns(entry: LogEntry, maxWidth: number): RunLine[] {
    const cache = entry.runWrapCache;
    if (cache && cache.width === maxWidth) return cache.lines as RunLine[];

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
        if (lines.length > MAX_LINES_PER_ENTRY) return;
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

    feed('[' + entry.time + '] ', undefined);
    for (let i = 0; i < runs.length; i++) feed(runs[i].text, runs[i].style);
    closePiece();

    while (lines.length && !lines[lines.length - 1].pieces.length) lines.pop();
    ctx.font = FONT;

    entry.runWrapCache = { width: maxWidth, lines };
    return lines;
  }

  /** 按面板宽度换行，结果缓存在 entry 上，日志不变就不重复测量 */
  private wrapEntry(entry: LogEntry, maxWidth: number): string[] {
    const cache = entry.wrapCache;
    if (cache && cache.width === maxWidth) return cache.lines;

    const ctx = this.ctx;
    const content = '[' + entry.time + '] ' + entry.text;
    const lines: string[] = [];
    const paragraphs = content.split('\n');

    ctx.font = FONT;
    for (let p = 0; p < paragraphs.length; p++) {
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
        const next = line + paragraph[i];
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line);
          line = paragraph[i];
          if (lines.length >= MAX_LINES_PER_ENTRY) break;
        } else {
          line = next;
        }
      }
      if (lines.length >= MAX_LINES_PER_ENTRY) break;
      if (line) lines.push(line);
    }

    if (lines.length >= MAX_LINES_PER_ENTRY) {
      lines.length = MAX_LINES_PER_ENTRY;
      lines[MAX_LINES_PER_ENTRY - 1] = lines[MAX_LINES_PER_ENTRY - 1] + ' …';
    }

    entry.wrapCache = { width: maxWidth, lines };
    return lines;
  }
}
