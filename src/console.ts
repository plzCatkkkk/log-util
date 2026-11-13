/**
 * 日志存储 + console 拦截 + 参数格式化。
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

/** 面板顶部的过滤 tab：'net' 的数据来自网络记录仓库，其余来自 console 日志 */
export type LogFilter = 'all' | 'net' | LogLevel;

/** console 里 %c 对应的样式（只取面板能画出来的几项） */
export interface TextStyle {
  color?: string;
  background?: string;
  /** 水平内边距，0 表示没有 */
  paddingX: number;
  /** 背景圆角 */
  radius: number;
  bold: boolean;
}

/** 一段带样式的文本，一条日志由若干段拼成 */
export interface TextRun {
  text: string;
  style?: TextStyle;
}

export interface LogEntry {
  id: number;
  level: LogLevel;
  /** HH:mm:ss */
  time: string;
  text: string;
  /** 用了 %c 的日志才有：按样式切好的文本段 */
  runs?: TextRun[];
  /** 换行缓存：expanded 表示这份结果是展开态（收起态只算到第 5 行），more 表示内容还有剩 */
  wrapCache?: { width: number; lines: string[]; expanded?: boolean; more?: boolean };
  /** 富文本换行结果缓存（结构由 ui 层决定） */
  runWrapCache?: { width: number; lines: any[]; expanded?: boolean; more?: boolean };
}

export type LogStoreListener = () => void;

/** 某条 console 日志是否属于当前 tab（网络条目单独渲染，不从这里取） */
export function matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
  if (filter === 'net') return false;
  return filter === 'all' || entry.level === filter;
}

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

function timestamp(): string {
  const now = new Date();
  return pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
}

function isErrorLike(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value instanceof Error) return true;
  return typeof value.message === 'string' && typeof value.name === 'string';
}

function formatError(value: any): string {
  const name = value.name || 'Error';
  const message = value.message || '';
  const head = message ? name + ': ' + message : name;
  const stack = typeof value.stack === 'string' ? value.stack : '';
  if (!stack) return head;
  // 堆栈只保留前几帧，避免一条日志吃掉半屏
  const frames = stack.split('\n').slice(1, 4).map((line: string) => line.trim()).filter(Boolean);
  return frames.length ? head + '\n' + frames.join('\n') : head;
}

/** 单条 console 日志最多保留多少字符，避免业务打印大对象把内存吃满 */
const CONSOLE_TEXT_LIMIT = 4000;
/** 序列化时最多展开多少个节点，防止超大数组/对象把主线程顶死 */
const STRINGIFY_MAX_NODES = 2000;
/** 循环引用查重最多记录多少个对象，超过后关闭查重（indexOf 是 O(n)） */
const STRINGIFY_MAX_SEEN = 200;

/**
 * 内置的过滤词：命中的日志整条丢弃，不格式化、不入库、不占条数上限，只原样透传给控制台。
 * web-adapter 里 localStorage.length 的取值和音频事件派发会高频刷这两类日志，
 * 记进来会把面板刷满并让列表每帧重排，直接拖垮帧率。
 */
export const DEFAULT_IGNORE_KEYWORDS = ['window.dispatchEvent', 'getStorageInfoSync'];

/** 去空白、丢空串、去重 */
function normalizeKeywords(words: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = typeof words[i] === 'string' ? words[i].trim() : '';
    if (word && result.indexOf(word) < 0) result.push(word);
  }
  return result;
}

/** 超出长度直接截断并标注原长度，省略提示也计入 limit，返回总长度不超过 limit */
export function limitText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '…（已截断，共 ' + text.length + ' 字符）';
  if (marker.length >= limit) return text.slice(0, limit);
  return text.slice(0, limit - marker.length) + marker;
}

/** 结构裁剪参数：超限时按值省略，尽量保住整体结构 */
export interface StringifyOptions {
  /** 单个字符串值最多保留多少字符 */
  maxStringLength?: number;
  /** 数组最多展开多少项 */
  maxArrayItems?: number;
  /** 对象最多展开多少个键 */
  maxKeys?: number;
  /** 最大嵌套深度 */
  maxDepth?: number;
  /** 最多展开多少个容器节点 */
  maxNodes?: number;
}

const DEFAULT_STRINGIFY_OPTIONS: Required<StringifyOptions> = {
  maxStringLength: 200,
  maxArrayItems: 30,
  maxKeys: 30,
  maxDepth: 5,
  maxNodes: 400,
};

/**
 * 把值裁成一份“结构不变、内容缩水”的副本：
 * 超长字符串就地截断、超长数组切掉尾巴、层级过深折叠成占位符。
 * 这样最终 JSON 的前半部分结构完整，而不是从中间被砍断。
 */
function prepareForStringify(
  value: any,
  opts: Required<StringifyOptions>,
  depth: number,
  seen: any[],
  state: { nodes: number }
): any {
  const type = typeof value;

  if (type === 'string') {
    if (value.length <= opts.maxStringLength) return value;
    return value.slice(0, opts.maxStringLength) + '…（共 ' + value.length + ' 字符）';
  }
  if (type === 'bigint') return String(value);
  if (type === 'function') return '[Function' + (value.name ? ': ' + value.name : '') + ']';
  if (!value || type !== 'object') return value;

  const isArray = Object.prototype.toString.call(value) === '[object Array]';
  // Date / Map / 类实例等交给 JSON.stringify 自己处理，不做展开
  if (!isArray && Object.prototype.toString.call(value) !== '[object Object]') return value;

  if (state.nodes++ >= opts.maxNodes) return '[…]';
  if (seen.indexOf(value) >= 0) return '[Circular]';
  if (depth >= opts.maxDepth) return isArray ? '[Array(' + value.length + ')]' : '[Object]';

  seen.push(value);
  let result: any;

  if (isArray) {
    const out: any[] = [];
    const count = Math.min(value.length, opts.maxArrayItems);
    for (let i = 0; i < count; i++) {
      out.push(prepareForStringify(value[i], opts, depth + 1, seen, state));
    }
    if (value.length > count) out.push('…共 ' + value.length + ' 项');
    result = out;
  } else {
    const out: any = {};
    let keys: string[] = [];
    try {
      keys = Object.keys(value);
    } catch (e) {
      seen.pop();
      return '[Object]';
    }
    const count = Math.min(keys.length, opts.maxKeys);
    for (let i = 0; i < count; i++) {
      const key = keys[i];
      try {
        out[key] = prepareForStringify(value[key], opts, depth + 1, seen, state);
      } catch (e) {
        out[key] = '[Unreadable]';
      }
    }
    if (keys.length > count) out['…'] = '共 ' + keys.length + ' 个键';
    result = out;
  }

  seen.pop();
  return result;
}

/**
 * 带预算的 JSON 序列化。
 * 节点数或字符数一旦超预算就用 '[…]' 顶掉剩余部分，
 * 避免先落地一个完整的大字符串再把内存峰值顶穿。
 * 传了 options 时先做结构裁剪：优先省略过长的单个值，保住整体结构。
 */
export function stringifyLimited(value: any, limit: number, indent?: number, options?: StringifyOptions): string {
  const seen: any[] = [];
  let dedupe = true;
  let nodes = 0;
  let budget = limit;

  let source = value;
  if (options) {
    const opts = { ...DEFAULT_STRINGIFY_OPTIONS, ...options } as Required<StringifyOptions>;
    try {
      source = prepareForStringify(value, opts, 0, [], { nodes: 0 });
    } catch (e) {
      source = value;
    }
  }

  const json = JSON.stringify(
    source,
    (_key: string, val: any) => {
      const type = typeof val;
      if (type === 'bigint') return String(val);
      if (type === 'function') return '[Function' + (val.name ? ': ' + val.name : '') + ']';
      if (type === 'string') {
        budget -= val.length;
        return budget < 0 ? '[…]' : val;
      }
      if (val && type === 'object') {
        if (++nodes > STRINGIFY_MAX_NODES) return '[…]';
        if (dedupe) {
          if (seen.indexOf(val) >= 0) return '[Circular]';
          seen.push(val);
          if (seen.length >= STRINGIFY_MAX_SEEN) dedupe = false;
        }
      }
      return val;
    },
    indent
  );

  return limitText(json === undefined ? String(value) : json, limit);
}

function formatValue(value: any): string {
  if (typeof value === 'string') return limitText(value, CONSOLE_TEXT_LIMIT);
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'symbol') return String(value);
  if (type === 'function') return '[Function' + (value.name ? ': ' + value.name : '') + ']';
  if (isErrorLike(value)) return formatError(value);

  try {
    return stringifyLimited(value, CONSOLE_TEXT_LIMIT, 0, DEFAULT_STRINGIFY_OPTIONS);
  } catch (e) {
    try {
      return Object.prototype.toString.call(value);
    } catch (e2) {
      return String(value);
    }
  }
}

/** 把 console.log 的多个参数拼成一行日志 */
export function formatArgs(args: any[]): string {
  // 单参数时 formatValue 已经截断过，再截一次会把“共 N 字符”提示成截断后的长度
  if (args.length === 1) return formatValue(args[0]);
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    parts.push(formatValue(args[i]));
  }
  return limitText(parts.join(' '), CONSOLE_TEXT_LIMIT);
}

/** canvas 认的颜色值：十六进制 / rgb(a) / hsl(a) / 具名颜色 */
function safeColorValue(raw: string): string | undefined {
  const value = raw.trim().replace(/!important$/i, '').trim();
  if (!value || value.length > 32) return undefined;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[0-9.%,\s/]+\)$/i.test(value)) return value;
  if (/^[a-z]+$/i.test(value)) return value.toLowerCase() === 'transparent' ? undefined : value;
  return undefined;
}

/** 从 "1px 6px" 这类值里取最后一个像素数 */
function parsePx(raw: string): number {
  const matched = raw.match(/[\d.]+px/g);
  if (!matched || !matched.length) return 0;
  const value = parseFloat(matched[matched.length - 1]);
  return Number.isFinite(value) ? value : 0;
}

const CSS_DECL = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i;

/**
 * 解析 %c 后面的 CSS 字符串。
 * 只认面板能画出来的几项（颜色、背景、加粗、内边距、圆角），
 * 其余属性直接忽略，避免把乱七八糟的样式带到 canvas 上。
 */
export function parseCssStyle(css: string): TextStyle | undefined {
  const style: TextStyle = { paddingX: 0, radius: 0, bold: false };
  let used = false;

  const decls = String(css).split(';');
  for (let i = 0; i < decls.length; i++) {
    const matched = CSS_DECL.exec(decls[i]);
    if (!matched) continue;

    const key = matched[1].toLowerCase();
    const value = matched[2];

    if (key === 'color') {
      const color = safeColorValue(value);
      if (color) {
        style.color = color;
        used = true;
      }
    } else if (key === 'background' || key === 'background-color') {
      const color = safeColorValue(value);
      if (color) {
        style.background = color;
        used = true;
      }
    } else if (key === 'font-weight') {
      const weight = value.trim().toLowerCase();
      if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) {
        style.bold = true;
        used = true;
      }
    } else if (key === 'padding' || key === 'padding-inline' || key === 'padding-left' || key === 'padding-right') {
      const px = parsePx(value);
      if (px > 0) {
        // 面板空间有限，内边距最多 8px
        style.paddingX = Math.min(px, 8);
        used = true;
      }
    } else if (key === 'border-radius') {
      const px = parsePx(value);
      if (px > 0) {
        style.radius = Math.min(px, 8);
        used = true;
      }
    }
  }

  return used ? style : undefined;
}

const FORMAT_SPEC = /%([sdifoOjc%])/g;

function formatJson(value: any): string {
  try {
    return stringifyLimited(value, CONSOLE_TEXT_LIMIT, 0, DEFAULT_STRINGIFY_OPTIONS);
  } catch (e) {
    return formatValue(value);
  }
}

export interface FormattedLog {
  text: string;
  runs?: TextRun[];
}

/**
 * 按浏览器 console 的规则处理格式串：
 * %c 消费一个 CSS 字符串并给后续文本上样式（直到下一个 %c 或空样式重置），
 * %s/%d/%i/%f/%o/%O/%j 消费一个值，%% 输出百分号。
 * 没有样式时只返回纯文本，渲染层走原来的快路径。
 */
export function formatConsoleArgs(args: any[]): FormattedLog {
  if (!args.length) return { text: '' };

  const first = args[0];
  if (typeof first !== 'string' || first.indexOf('%') < 0) {
    return { text: formatArgs(args) };
  }

  const runs: TextRun[] = [];
  let text = '';
  let style: TextStyle | undefined;
  let styled = false;
  let truncated = false;
  let argIndex = 1;
  let last = 0;

  const append = (value: string, runStyle: TextStyle | undefined) => {
    if (!value) return;
    let piece = value;
    // 留一个字符给末尾的省略号，保证最终长度不超上限
    if (text.length + piece.length > CONSOLE_TEXT_LIMIT) {
      piece = piece.slice(0, Math.max(0, CONSOLE_TEXT_LIMIT - 1 - text.length));
      truncated = true;
    }
    if (!piece) return;
    text += piece;
    const prev = runs[runs.length - 1];
    if (prev && prev.style === runStyle) prev.text += piece;
    else runs.push({ text: piece, style: runStyle });
  };

  FORMAT_SPEC.lastIndex = 0;
  let matched: RegExpExecArray | null;
  while ((matched = FORMAT_SPEC.exec(first)) !== null) {
    append(first.slice(last, matched.index), style);
    last = matched.index + matched[0].length;

    const spec = matched[1];
    if (spec === '%') {
      append('%', style);
      continue;
    }
    // 格式符比参数多：原样输出
    if (argIndex >= args.length) {
      append(matched[0], style);
      continue;
    }

    const value = args[argIndex++];
    if (spec === 'c') {
      style = parseCssStyle(typeof value === 'string' ? value : String(value));
      if (style) styled = true;
      continue;
    }
    append(spec === 'j' ? formatJson(value) : formatValue(value), style);
  }
  append(first.slice(last), style);

  for (; argIndex < args.length; argIndex++) {
    append(' ', style);
    append(formatValue(args[argIndex]), style);
  }

  if (truncated) {
    text += '…';
    const tail = runs[runs.length - 1];
    if (tail && tail.style === style) tail.text += '…';
    else runs.push({ text: '…', style });
  }

  return styled ? { text, runs } : { text };
}

export class LogStore {
  private entries: LogEntry[] = [];
  private listeners: LogStoreListener[] = [];
  private seq = 0;
  /** 按级别维护条数，避免每次渲染都全量扫一遍 */
  private counts: Record<string, number> = { log: 0, info: 0, warn: 0, error: 0 };
  /** 排除词：命中的日志整条丢弃，被丢弃的不占条数上限 */
  private keywords: string[] = DEFAULT_IGNORE_KEYWORDS.slice();
  /** 筛选词：非空时只显示命中的日志，作用在展示层，能翻到已存下的历史 */
  private includeWords: string[] = [];

  /** 内存里最多留多少条 */
  maxLogs: number;
  /** 面板最多往回显示多少条（按筛选后的结果从新往旧数） */
  displayLimit = 300;
  /** 内容版本号，UI 靠它判断能否复用上一帧的过滤/换行结果 */
  version = 0;
  /** 排除词变化后的回调（用于写本地存储），null 表示不持久化 */
  onIgnoreKeywordsChange: ((words: string[]) => void) | null = null;

  constructor(maxLogs: number) {
    this.maxLogs = maxLogs;
  }

  /** 整体替换过滤词，传空数组表示不再过滤任何日志 */
  setIgnoreKeywords(words: string[]): void {
    this.keywords = normalizeKeywords(words || []);
    this.notifyIgnoreKeywords();
  }

  addIgnoreKeywords(words: string[]): void {
    if (!words || !words.length) return;
    this.keywords = normalizeKeywords(this.keywords.concat(words));
    this.notifyIgnoreKeywords();
  }

  private notifyIgnoreKeywords(): void {
    const handler = this.onIgnoreKeywordsChange;
    if (!handler) return;
    try {
      handler(this.keywords.slice());
    } catch (e) {
      // 存不进去不影响当前会话的过滤
    }
  }

  ignoreKeywords(): string[] {
    return this.keywords.slice();
  }

  /** 整体替换筛选词，传空数组表示不筛选；改动只影响展示，历史日志立刻跟着变 */
  setIncludeKeywords(words: string[]): void {
    this.includeWords = normalizeKeywords(words || []);
    this.version++;
    this.emit();
  }

  addIncludeKeywords(words: string[]): void {
    if (!words || !words.length) return;
    this.includeWords = normalizeKeywords(this.includeWords.concat(words));
    this.version++;
    this.emit();
  }

  includeKeywords(): string[] {
    return this.includeWords.slice();
  }

  /** 先扫原始参数：命中就不用再走格式化了（日志有长度上限，关键字可能落在被截断的部分） */
  shouldIgnore(args: any[]): boolean {
    const keywords = this.keywords;
    if (!keywords.length) return false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg !== 'string' || !arg) continue;
      for (let k = 0; k < keywords.length; k++) {
        if (arg.indexOf(keywords[k]) >= 0) return true;
      }
    }
    return false;
  }

  /** 关键字可能只出现在对象字段里，格式化结果再兜一次 */
  isIgnoredText(text: string): boolean {
    const keywords = this.keywords;
    for (let k = 0; k < keywords.length; k++) {
      if (text.indexOf(keywords[k]) >= 0) return true;
    }
    return false;
  }

  /** 没有筛选词时全部通过；有筛选词时看已格式化文本（含时间前缀）是否命中 */
  matchesInclude(entry: LogEntry): boolean {
    const words = this.includeWords;
    if (!words.length) return true;
    const text = entry.text;
    for (let k = 0; k < words.length; k++) {
      if (text.indexOf(words[k]) >= 0) return true;
    }
    return false;
  }

  /** 运行时调整显示条数（只影响渲染，不影响内存里保留的历史） */
  setDisplayLimit(limit: number): void {
    const next = limit > 0 ? Math.floor(limit) : 0;
    if (next === this.displayLimit) return;
    this.displayLimit = next;
    this.version++;
    this.emit();
  }

  /** 运行时调整上限，超出部分立即丢弃最旧的 */
  setMaxLogs(maxLogs: number): void {
    if (!(maxLogs > 0)) return;
    this.maxLogs = Math.floor(maxLogs);
    this.trim();
    this.version++;
    this.emit();
  }

  push(level: LogLevel, text: string, runs?: TextRun[]): void {
    const entry: LogEntry = {
      id: ++this.seq,
      level,
      time: timestamp(),
      // 入库就截短：内存里不留完整长文本
      text: limitText(text, CONSOLE_TEXT_LIMIT),
    };
    if (runs && runs.length) entry.runs = runs;
    this.entries.push(entry);
    this.counts[level] = (this.counts[level] || 0) + 1;
    this.trim();
    this.version++;
    this.emit();
  }

  /** 超出上限就丢最旧的，同时维护按级别计数 */
  private trim(): void {
    const overflow = this.entries.length - this.maxLogs;
    if (overflow <= 0) return;
    const dropped = this.entries.splice(0, overflow);
    for (let i = 0; i < dropped.length; i++) {
      const key = dropped[i].level;
      this.counts[key] = Math.max(0, (this.counts[key] || 0) - 1);
    }
  }

  clear(): void {
    if (!this.entries.length) return;
    this.entries = [];
    this.counts = { log: 0, info: 0, warn: 0, error: 0 };
    this.version++;
    this.emit();
  }

  list(): LogEntry[] {
    return this.entries;
  }

  count(filter: LogFilter): number {
    // 网络日志独立存放，不参与 console 的统计
    if (filter === 'net') return 0;
    if (filter === 'all') return this.entries.length;
    return this.counts[filter] || 0;
  }

  onChange(listener: LogStoreListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private emit(): void {
    for (let i = 0; i < this.listeners.length; i++) {
      try {
        this.listeners[i]();
      } catch (e) {
        // 渲染异常不能反过来影响业务日志
      }
    }
  }
}

export interface ConsolePatch {
  restore(): void;
}

/** 拦截 console.log/info/warn/error/debug，转发给 store，同时保留原始输出 */
export function interceptConsole(store: LogStore): ConsolePatch {
  const target: any = typeof console !== 'undefined' ? console : null;
  if (!target) return { restore() {} };

  const mapping: Array<{ method: string; level: LogLevel }> = [
    { method: 'log', level: 'log' },
    { method: 'info', level: 'info' },
    { method: 'warn', level: 'warn' },
    { method: 'error', level: 'error' },
    { method: 'debug', level: 'log' },
  ];

  const originals: Array<{ method: string; original: any }> = [];

  mapping.forEach((item) => {
    const original = target[item.method];
    originals.push({ method: item.method, original });

    target[item.method] = function patched(...args: any[]) {
      // 命中排除词时连格式化都不做，直接透传给原函数；这条也不占条数上限
      if (!store.shouldIgnore(args)) {
        try {
          const formatted = formatConsoleArgs(args);
          // 只判排除词；筛选词在展示层生效，这样能翻到筛选之前已经存下的历史
          if (!store.isIgnoredText(formatted.text)) {
            store.push(item.level, formatted.text, formatted.runs);
          }
        } catch (e) {
          // 格式化失败也要保证原始日志照常输出
        }
      }
      if (typeof original === 'function') {
        try {
          original.apply(target, args);
        } catch (e) {
          // ignore
        }
      }
    };
  });

  return {
    restore() {
      originals.forEach((item) => {
        if (item.original !== undefined) target[item.method] = item.original;
      });
    },
  };
}
