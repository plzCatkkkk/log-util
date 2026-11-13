/**
 * my.request 拦截 + 网络记录仓库。
 *
 * 只做「记录 + 原样转发」：不改请求参数、不吞回调异常、不影响返回值。
 * 每条请求在发起时先落一条 pending 记录（面板可实时看到进行中），
 * 拿到 success / fail 后再就地补全状态码、耗时、响应头和响应体。
 */
import { formatArgs, stringifyLimited } from './console';
import type { LogStore } from './console';

export interface NetworkPatch {
  restore(): void;
}

export type NetStatus = 'pending' | 'success' | 'fail';

export interface NetRecord {
  id: number;
  method: string;
  /** 已做敏感参数脱敏的完整 url */
  url: string;
  /** 发起时间 HH:mm:ss */
  time: string;
  /** 发起时刻，用于实时算进行中耗时 */
  startedAt: number;
  status: NetStatus;
  statusCode: number;
  /** 已完成时的耗时（ms） */
  cost: number;
  requestHeaders: string;
  requestBody: string;
  responseHeaders: string;
  responseBody: string;
  error: string;
  /** 展开态下的换行缓存 */
  wrapCache?: { width: number; expanded: boolean; lines: string[] };
  /** 折叠态单行 url 的省略结果缓存（宽度变化时失效） */
  urlCache?: { width: number; text: string };
}

export type NetStoreListener = () => void;

/** query 里这些参数的值需要脱敏，避免 token 直接显示在面板上 */
const SENSITIVE_KEY = /^(token|access_token|refresh_token|id_token|key|appkey|app_key|secret|sign|signature|password|passwd|pwd|session|sessionid|session_id|auth|authorization|cookie|ticket)$/i;

/** 详情里的 body / 单个头值最多保留多少字符，避免一条记录吃爆内存 */
const DETAIL_LIMIT = 2000;
const HEADER_VALUE_LIMIT = 300;
/** 一条记录最多保留多少个头部，防止超长头部列表把内存吃满 */
const MAX_HEADERS = 40;

/**
 * 请求/响应体的结构裁剪参数。
 * 优先省略过长的单个值（而不是把整个 JSON 从中间砍断），
 * 这样字段结构、层级、数组元素个数都还能看出来。
 */
const BODY_STRING_LIMIT = 120;
const BODY_ARRAY_ITEMS = 20;
const BODY_MAX_KEYS = 30;
const BODY_MAX_DEPTH = 5;

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

function timestamp(): string {
  const now = new Date();
  return pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n…（已截断，共 ' + text.length + ' 字符）';
}

/** 把 url 里敏感参数的值替换成 ***，解析失败时原样返回 */
export function sanitizeUrl(url: string): string {
  const index = url.indexOf('?');
  if (index < 0) return url;

  const head = url.slice(0, index);
  const params = url.slice(index + 1).split('&');
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    const eq = param.indexOf('=');
    if (eq < 0) continue;

    let name = param.slice(0, eq);
    try {
      name = decodeURIComponent(name);
    } catch (e) {
      // 非法编码就按原文匹配
    }
    if (SENSITIVE_KEY.test(name)) {
      params[i] = param.slice(0, eq + 1) + '***';
    }
  }
  return head + '?' + params.join('&');
}

/** 请求体 / 响应体：对象按两空格缩进展开，方便直接读 */
function formatBody(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return truncate(value.replace(/\r\n/g, '\n'), DETAIL_LIMIT);

  // 序列化阶段就按预算裁剪，避免先落地一个完整的大字符串；
  // 超长的单个值就地省略，整体 JSON 结构保持完整
  try {
    const text = stringifyLimited(value, DETAIL_LIMIT, 2, {
      maxStringLength: BODY_STRING_LIMIT,
      maxArrayItems: BODY_ARRAY_ITEMS,
      maxKeys: BODY_MAX_KEYS,
      maxDepth: BODY_MAX_DEPTH,
    });
    if (text) return text;
  } catch (e) {
    // 落到下面的兜底
  }
  try {
    return formatArgs([value]);
  } catch (e) {
    return truncate(String(value), DETAIL_LIMIT);
  }
}

/** 请求头 / 响应头：一行一个，值过长截断，条数也有上限 */
function formatHeaders(headers: any): string {
  if (!headers || typeof headers !== 'object') return '';
  const keys = Object.keys(headers);
  if (!keys.length) return '';
  const lines: string[] = [];
  const count = Math.min(keys.length, MAX_HEADERS);
  for (let i = 0; i < count; i++) {
    const key = keys[i];
    lines.push(key + ': ' + truncate(String(headers[key]), HEADER_VALUE_LIMIT));
  }
  if (keys.length > count) lines.push('…（还有 ' + (keys.length - count) + ' 个头部未显示）');
  return lines.join('\n');
}

export interface NetStartInput {
  method: string;
  url: string;
  requestHeaders: string;
  requestBody: string;
}

/** 网络记录仓库：先进先出，超出上限丢弃最旧的 */
export class NetStore {
  private items: NetRecord[] = [];
  private listeners: NetStoreListener[] = [];
  private seq = 0;
  /** 进行中的条数，实时刷新时每帧都要读，不能每次遍历 */
  private pendingCount = 0;

  maxRecords: number;
  /** 内容版本号，UI 靠它判断这一帧是否和上一帧一样、能否直接跳过重绘 */
  version = 0;

  constructor(maxRecords: number) {
    this.maxRecords = maxRecords;
  }

  /** 请求发出时调用，返回记录 id，成功后用 finish 补全 */
  start(input: NetStartInput): number {
    const record: NetRecord = {
      id: ++this.seq,
      method: input.method,
      url: input.url,
      time: timestamp(),
      startedAt: Date.now(),
      status: 'pending',
      statusCode: 0,
      cost: 0,
      requestHeaders: input.requestHeaders,
      requestBody: input.requestBody,
      responseHeaders: '',
      responseBody: '',
      error: '',
    };
    this.items.push(record);
    this.pendingCount++;
    const overflow = this.items.length - this.maxRecords;
    if (overflow > 0) {
      const dropped = this.items.splice(0, overflow);
      for (let i = 0; i < dropped.length; i++) {
        if (dropped[i].status === 'pending') this.pendingCount--;
      }
    }
    this.emit();
    return record.id;
  }

  finish(id: number, patch: Partial<NetRecord>): void {
    const record = this.find(id);
    if (!record) return;
    if (record.status === 'pending' && this.pendingCount > 0) this.pendingCount--;
    record.status = patch.status || record.status;
    if (patch.statusCode !== undefined) record.statusCode = patch.statusCode;
    record.cost = Date.now() - record.startedAt;
    if (patch.responseHeaders !== undefined) record.responseHeaders = patch.responseHeaders;
    if (patch.responseBody !== undefined) record.responseBody = patch.responseBody;
    if (patch.error !== undefined) record.error = patch.error;
    // 内容变了，旧的换行缓存必须失效
    record.wrapCache = undefined;
    this.emit();
  }

  list(): NetRecord[] {
    return this.items;
  }

  total(): number {
    return this.items.length;
  }

  pending(): number {
    return this.pendingCount;
  }

  clear(): void {
    if (!this.items.length) return;
    this.items = [];
    this.pendingCount = 0;
    this.emit();
  }

  /** 运行时调整上限，超出部分立即丢弃最旧的 */
  setMaxRecords(maxRecords: number): void {
    if (!(maxRecords > 0)) return;
    this.maxRecords = Math.floor(maxRecords);
    const overflow = this.items.length - this.maxRecords;
    if (overflow <= 0) return;
    const dropped = this.items.splice(0, overflow);
    for (let i = 0; i < dropped.length; i++) {
      if (dropped[i].status === 'pending' && this.pendingCount > 0) this.pendingCount--;
    }
    this.emit();
  }

  onChange(listener: NetStoreListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private find(id: number): NetRecord | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].id === id) return this.items[i];
    }
    return null;
  }

  private emit(): void {
    this.version++;
    for (let i = 0; i < this.listeners.length; i++) {
      try {
        this.listeners[i]();
      } catch (e) {
        // 渲染异常不能反过来影响业务请求
      }
    }
  }
}

function setProperty(target: any, key: string, value: any): boolean {
  try {
    target[key] = value;
    if (target[key] === value) return true;
  } catch (e) {
    // 有的运行时属性只读，接着尝试 defineProperty
  }
  try {
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
    return target[key] === value;
  } catch (e) {
    return false;
  }
}

function pickStatus(res: any): number {
  const raw = res && (res.status !== undefined ? res.status : res.statusCode);
  const status = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  return typeof status === 'number' && isFinite(status) ? status : 0;
}

/** 拦截 my.request，返回 restore；环境不支持时返回空实现 */
export function interceptNetwork(store: LogStore, net: NetStore): NetworkPatch {
  const g: any = globalThis as any;
  const my = g && g.my;
  if (!my || typeof my.request !== 'function') return { restore() {} };

  const original = my.request;

  const patched = function patchedRequest(this: any, options: any) {
    const opts = options && typeof options === 'object' ? options : {};
    const method = String(opts.method || 'GET').toUpperCase();
    const url = sanitizeUrl(typeof opts.url === 'string' ? opts.url : String(opts.url || ''));
    const source = this;

    let id = 0;
    try {
      id = net.start({
        method,
        url,
        requestHeaders: formatHeaders(opts.headers),
        requestBody: formatBody(opts.data),
      });
    } catch (e) {
      // 记录失败不能影响请求
    }

    // 复制一份再替换回调，绝不修改调用方传进来的对象
    const next: any = {};
    for (const key in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, key)) next[key] = opts[key];
    }

    next.success = function onSuccess(res: any) {
      try {
        const status = pickStatus(res);
        net.finish(id, {
          status: 'success',
          statusCode: status,
          responseHeaders: formatHeaders(res && res.headers),
          responseBody: formatBody(res && res.data),
        });
      } catch (e) {
        // 记录失败不影响业务回调
      }
      if (typeof opts.success === 'function') return opts.success.apply(source, arguments);
      return undefined;
    };

    next.fail = function onFail(err: any) {
      try {
        const message = (err && (err.errorMessage || err.errMsg || err.message || err.error)) || 'request failed';
        const code = err && (err.error !== undefined ? err.error : err.status);
        net.finish(id, {
          status: 'fail',
          statusCode: pickStatus(err),
          error: String(message) + (code !== undefined ? '（' + code + '）' : ''),
        });
      } catch (e) {
        // 同上
      }
      if (typeof opts.fail === 'function') return opts.fail.apply(source, arguments);
      return undefined;
    };

    next.complete = function onComplete() {
      if (typeof opts.complete === 'function') return opts.complete.apply(source, arguments);
      return undefined;
    };

    try {
      return original.call(g.my, next);
    } catch (e) {
      // 同步抛错也要把记录收尾，否则会永远停在“进行中”
      try {
        net.finish(id, { status: 'fail', error: String(e) });
      } catch (e2) {
        // ignore
      }
      throw e;
    }
  };

  if (!setProperty(my, 'request', patched)) {
    store.push('error', '[log-panel] my.request 不可写，网络日志未启用');
    return { restore() {} };
  }

  return {
    restore() {
      setProperty(my, 'request', original);
    },
  };
}
