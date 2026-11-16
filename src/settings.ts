/**
 * 面板设置：能在「设置」弹窗里改的项，全部写本地存储，重启后继续生效。
 */
import { readStorage, writeStorage } from './env';

export interface PanelSettings {
  /** 收起状态下每条日志显示几行，0 表示不折叠 */
  collapsedLines: number;
  /** 正文字号 */
  fontSize: number;
  /** 是否在每条日志前面显示时间戳 */
  showTime: boolean;
  /** 滚上去看旧日志时，新日志到达是否保持当前查看位置 */
  followTail: boolean;
  /** 内存里保留多少条日志 */
  maxLogs: number;
  /** 面板最多往回渲染多少条 */
  displayLimit: number;
  /** 最多保留多少条网络记录 */
  maxNetRecords: number;
  /** 画布像素比上限，0 表示按设备原生 dpr */
  maxPixelRatio: number;
}

export const DEFAULT_SETTINGS: PanelSettings = {
  collapsedLines: 4,
  fontSize: 12,
  showTime: true,
  followTail: true,
  maxLogs: 1000,
  displayLimit: 300,
  maxNetRecords: 100,
  maxPixelRatio: 2,
};

/** 存储 key：一个对象存全部设置，跟排除词分开，互不影响 */
const STORAGE_KEY = '__LOG_PANEL_SETTINGS__';

/** 数值项点一下循环到下一个值；折叠行数和像素比里的 0 表示「不限」 */
export const SETTING_CYCLE: Record<string, number[]> = {
  collapsedLines: [4, 8, 0],
  fontSize: [11, 12, 14],
  maxLogs: [300, 1000, 3000],
  displayLimit: [100, 300, 500, 1000],
  maxNetRecords: [50, 100, 200],
  maxPixelRatio: [1, 2, 0],
};

/** 只校验「有限非负数」，不按 SETTING_CYCLE 白名单卡：init 里传的自定义值也要能存下来 */
function pickNumber(value: any, fallback: number): number {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return fallback;
  return value;
}

function pickBoolean(value: any, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 读本地设置；没有记录或解析失败返回 null，由调用方决定兜底 */
export function loadSettings(): PanelSettings | null {
  const raw = readStorage(STORAGE_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    const d = DEFAULT_SETTINGS;
    return {
      collapsedLines: pickNumber(data.collapsedLines, d.collapsedLines),
      fontSize: pickNumber(data.fontSize, d.fontSize),
      showTime: pickBoolean(data.showTime, d.showTime),
      followTail: pickBoolean(data.followTail, d.followTail),
      maxLogs: pickNumber(data.maxLogs, d.maxLogs),
      displayLimit: pickNumber(data.displayLimit, d.displayLimit),
      maxNetRecords: pickNumber(data.maxNetRecords, d.maxNetRecords),
      maxPixelRatio: pickNumber(data.maxPixelRatio, d.maxPixelRatio),
    };
  } catch (e) {
    // 存坏了就当没存过
    return null;
  }
}

/** 写本地存储，失败静默（调试面板不能因为存储问题影响游戏） */
export function saveSettings(settings: PanelSettings): void {
  try {
    writeStorage(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    // ignore
  }
}

/** 取下一个可选值；布尔项直接取反 */
export function nextSettingValue<K extends keyof PanelSettings>(settings: PanelSettings, key: K): PanelSettings[K] {
  const current = settings[key];
  if (typeof current === 'boolean') return (!current) as PanelSettings[K];
  const cycle = SETTING_CYCLE[key as string];
  if (!cycle) return current;
  const index = cycle.indexOf(current as number);
  return cycle[(index + 1) % cycle.length] as PanelSettings[K];
}

/** 设置面板右侧显示的当前取值 */
export function settingValueText(key: keyof PanelSettings, settings: PanelSettings): string {
  const value = settings[key];
  if (key === 'showTime' || key === 'followTail') return value ? '开' : '关';
  if (key === 'collapsedLines') return value ? value + ' 行' : '不折叠';
  if (key === 'fontSize') return value + 'px';
  if (key === 'maxPixelRatio') return value ? value + 'x' : '原生';
  return value + ' 条';
}
