/**
 * 运行环境适配层。
 * 支付宝小游戏没有 DOM / BOM，屏幕、canvas、触摸全部走 my API；
 * 另外保留一条 DOM 兜底分支，方便在浏览器 / WebView 容器里调试同一份产物。
 */

export interface ScreenSize {
  width: number;
  height: number;
  pixelRatio: number;
}

export type TouchPhase = 'start' | 'move' | 'end';

/** 返回 true 表示这一下被面板消费掉了（DOM 环境下会阻止事件继续传给游戏） */
export type TouchListener = (x: number, y: number, phase: TouchPhase) => boolean;

export function getMyApi(): any {
  const g: any = globalThis as any;
  return g.my || null;
}

/**
 * 取逻辑像素的屏幕尺寸（不含 dpr 缩放）。
 * maxPixelRatio > 0 时把 dpr 封顶：画布物理尺寸（以及纹理上传量）会显著变小，
 * 代价是文字略微不如原生 dpr 锐利。
 */
export function getScreenSize(maxPixelRatio?: number): ScreenSize {
  const g: any = globalThis as any;
  const my = getMyApi();

  let width = 0;
  let height = 0;
  let pixelRatio = 0;

  if (my && typeof my.getSystemInfoSync === 'function') {
    try {
      const info = my.getSystemInfoSync() || {};
      width = Number(info.windowWidth || info.screenWidth) || 0;
      height = Number(info.windowHeight || info.screenHeight) || 0;
      pixelRatio = Number(info.pixelRatio) || 0;
    } catch (e) {
      // 忽略：宿主可能未实现该方法，继续走后面的兜底
    }
  }

  if (!width || !height) {
    width = Number(g.innerWidth) || 0;
    height = Number(g.innerHeight) || 0;
  }

  if (!width || !height) {
    const canvas = g.canvas || (g.GameGlobal && g.GameGlobal.canvas);
    if (canvas && canvas.width && canvas.height) {
      width = canvas.width;
      height = canvas.height;
      pixelRatio = pixelRatio || 1;
    }
  }

  if (!width || !height) {
    width = 375;
    height = 667;
  }

  const ratio = pixelRatio || Number(g.devicePixelRatio) || 1;
  return {
    width,
    height,
    pixelRatio: maxPixelRatio && maxPixelRatio > 0 ? Math.min(ratio, maxPixelRatio) : ratio,
  };
}

/**
 * 创建面板用的叠加 canvas。
 * 小游戏里用 my.createCanvas()：注意宿主通常只把第一个 canvas 上屏，
 * 若该 canvas 已被游戏引擎占用（WebGL），请在 init({ canvas }) 里显式传入可用的 canvas。
 */
export function createOverlayCanvas(): any {
  const g: any = globalThis as any;
  const my = getMyApi();

  if (my && typeof my.createCanvas === 'function') {
    try {
      const canvas = my.createCanvas();
      if (canvas) return canvas;
    } catch (e) {
      // 落回 DOM 分支
    }
  }

  const doc = g.document;
  if (doc && typeof doc.createElement === 'function') {
    const canvas = doc.createElement('canvas');
    if (!canvas) return null;
    if (canvas.style) {
      canvas.style.position = 'fixed';
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.zIndex = '999999';
      // 不拦截游戏本身的触摸，事件在 window 捕获阶段自行判断是否消费
      canvas.style.pointerEvents = 'none';
    }
    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(canvas);
    }
    return canvas;
  }

  return null;
}

function readNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** 从触摸/鼠标事件里取出第一个触点的屏幕坐标 */
function pickPoint(event: any): { x: number; y: number } | null {
  if (!event) return null;

  const touches: any[] = event.touches && event.touches.length
    ? event.touches
    : event.changedTouches && event.changedTouches.length
      ? event.changedTouches
      : [];

  const touch = touches[0];
  if (touch) {
    const x = readNumber(touch.clientX != null ? touch.clientX : touch.pageX != null ? touch.pageX : touch.x);
    const y = readNumber(touch.clientY != null ? touch.clientY : touch.pageY != null ? touch.pageY : touch.y);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return { x, y };
  }

  const x = readNumber(event.clientX != null ? event.clientX : event.pageX);
  const y = readNumber(event.clientY != null ? event.clientY : event.pageY);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return { x, y };

  return null;
}

/**
 * 绑定屏幕级触摸事件。
 * 优先用 my.onTouch*（小游戏），没有就退回 DOM 事件（浏览器 / WebView 容器）。
 * 返回解绑函数。
 */
export function bindTouch(canvas: any, listener: TouchListener): () => void {
  const g: any = globalThis as any;
  const my = getMyApi();
  const cleanups: Array<() => void> = [];
  let active = false;

  const emit = (x: number, y: number, phase: TouchPhase): boolean => {
    try {
      return listener(x, y, phase) === true;
    } catch (e) {
      return false;
    }
  };

  const onMyTouch = (phase: TouchPhase) => (event: any) => {
    const point = pickPoint(event);
    if (!point) return;
    if (phase === 'start') {
      active = emit(point.x, point.y, 'start');
      return;
    }
    if (!active) return;
    emit(point.x, point.y, phase);
    if (phase === 'end') active = false;
  };

  const hasMyTouch = my && typeof my.onTouchStart === 'function';

  if (hasMyTouch) {
    const start = onMyTouch('start');
    const move = onMyTouch('move');
    const end = onMyTouch('end');

    my.onTouchStart(start);
    my.onTouchMove(move);
    my.onTouchEnd(end);
    if (typeof my.onTouchCancel === 'function') my.onTouchCancel(end);

    cleanups.push(() => {
      if (typeof my.offTouchStart === 'function') my.offTouchStart(start);
      if (typeof my.offTouchMove === 'function') my.offTouchMove(move);
      if (typeof my.offTouchEnd === 'function') my.offTouchEnd(end);
      if (typeof my.offTouchCancel === 'function') my.offTouchCancel(end);
    });
  }

  const target = g.window && typeof g.window.addEventListener === 'function' ? g.window : null;
  const isDomCanvas = canvas && typeof canvas.addEventListener === 'function';

  if (target && (isDomCanvas || !hasMyTouch)) {
    const block = (event: any) => {
      // 面板吃掉了这一下，避免同一触摸继续驱动游戏
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (event && typeof event.preventDefault === 'function' && event.cancelable !== false) {
        event.preventDefault();
      }
    };

    const onStart = (event: any) => {
      const point = pickPoint(event);
      if (!point) return;
      active = emit(point.x, point.y, 'start');
      if (active) block(event);
    };
    const onMove = (event: any) => {
      if (!active) return;
      const point = pickPoint(event);
      if (!point) return;
      emit(point.x, point.y, 'move');
      block(event);
    };
    const onEnd = (event: any) => {
      if (!active) return;
      const point = pickPoint(event) || { x: 0, y: 0 };
      active = false;
      emit(point.x, point.y, 'end');
      block(event);
    };

    target.addEventListener('touchstart', onStart, { capture: true, passive: false });
    target.addEventListener('touchmove', onMove, { capture: true, passive: false });
    target.addEventListener('touchend', onEnd, { capture: true, passive: false });
    target.addEventListener('touchcancel', onEnd, { capture: true, passive: false });
    target.addEventListener('mousedown', onStart, true);
    target.addEventListener('mousemove', onMove, true);
    target.addEventListener('mouseup', onEnd, true);

    cleanups.push(() => {
      target.removeEventListener('touchstart', onStart, true);
      target.removeEventListener('touchmove', onMove, true);
      target.removeEventListener('touchend', onEnd, true);
      target.removeEventListener('touchcancel', onEnd, true);
      target.removeEventListener('mousedown', onStart, true);
      target.removeEventListener('mousemove', onMove, true);
      target.removeEventListener('mouseup', onEnd, true);
    });
  }

  return () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        // ignore
      }
    });
  };
}

/** 按 dpr 设置 canvas 的物理像素尺寸 */
export function resizeCanvas(canvas: any, size: ScreenSize): void {
  if (!canvas) return;
  const width = Math.max(1, Math.round(size.width * size.pixelRatio));
  const height = Math.max(1, Math.round(size.height * size.pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

/** 监听屏幕尺寸变化（横竖屏切换），返回解绑函数 */
export function bindResize(callback: () => void): () => void {
  const g: any = globalThis as any;
  const my = getMyApi();
  const cleanups: Array<() => void> = [];

  if (my && typeof my.onWindowResize === 'function') {
    my.onWindowResize(callback);
    cleanups.push(() => {
      if (typeof my.offWindowResize === 'function') my.offWindowResize(callback);
    });
  }

  if (g.window && typeof g.window.addEventListener === 'function') {
    g.window.addEventListener('resize', callback);
    cleanups.push(() => g.window.removeEventListener('resize', callback));
  }

  return () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        // ignore
      }
    });
  };
}

export interface NetworkState {
  /** 是否联网 */
  online: boolean;
  /** wifi / 4g / 5g / unknown 等，由宿主给出 */
  type: string;
}

/**
 * 监听网络状态（在线 / 断网、网络类型变化）。
 * 小游戏用 my.getNetworkType + my.onNetworkStatusChange，浏览器退回 navigator.onLine。
 * 返回解绑函数。
 */
export function bindNetworkState(callback: (state: NetworkState) => void): () => void {
  const g: any = globalThis as any;
  const my = getMyApi();
  const cleanups: Array<() => void> = [];

  const emit = (online: boolean, type: string) => {
    try {
      callback({ online, type: type || 'unknown' });
    } catch (e) {
      // ignore
    }
  };

  if (my && typeof my.getNetworkType === 'function') {
    try {
      my.getNetworkType({
        success(res: any) {
          emit(true, String((res && res.networkType) || 'unknown'));
        },
        fail() {
          // 取不到就当未知，不影响后面的变化监听
        },
      });
    } catch (e) {
      // ignore
    }
  }

  if (my && typeof my.onNetworkStatusChange === 'function') {
    const handler = (res: any) => {
      emit(!(res && res.isConnected === false), String((res && res.networkType) || 'unknown'));
    };
    my.onNetworkStatusChange(handler);
    cleanups.push(() => {
      if (typeof my.offNetworkStatusChange === 'function') my.offNetworkStatusChange(handler);
    });
  }

  if (g.window && typeof g.window.addEventListener === 'function') {
    const navigator = g.navigator || {};
    const notify = () => emit(navigator.onLine !== false, 'unknown');
    g.window.addEventListener('online', notify);
    g.window.addEventListener('offline', notify);
    cleanups.push(() => {
      g.window.removeEventListener('online', notify);
      g.window.removeEventListener('offline', notify);
    });
  }

  return () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        // ignore
      }
    });
  };
}
