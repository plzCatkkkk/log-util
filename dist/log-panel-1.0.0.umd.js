/*! alipay-log-panel v1.0.0 | 支付宝小游戏 console 日志面板 */
(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.LogPanel = factory());
})(this, (function () { 'use strict';

    /**
     * 运行环境适配层。
     * 支付宝小游戏没有 DOM / BOM，屏幕、canvas、触摸全部走 my API；
     * 另外保留一条 DOM 兜底分支，方便在浏览器 / WebView 容器里调试同一份产物。
     */
    function getMyApi() {
        const g = globalThis;
        return g.my || null;
    }
    /**
     * 取逻辑像素的屏幕尺寸（不含 dpr 缩放）。
     * maxPixelRatio > 0 时把 dpr 封顶：画布物理尺寸（以及纹理上传量）会显著变小，
     * 代价是文字略微不如原生 dpr 锐利。
     */
    function getScreenSize(maxPixelRatio) {
        const g = globalThis;
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
            }
            catch (e) {
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
    function createOverlayCanvas() {
        const g = globalThis;
        const my = getMyApi();
        if (my && typeof my.createCanvas === 'function') {
            try {
                const canvas = my.createCanvas();
                if (canvas)
                    return canvas;
            }
            catch (e) {
                // 落回 DOM 分支
            }
        }
        const doc = g.document;
        if (doc && typeof doc.createElement === 'function') {
            const canvas = doc.createElement('canvas');
            if (!canvas)
                return null;
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
    function readNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : NaN;
    }
    /** 从触摸/鼠标事件里取出第一个触点的屏幕坐标 */
    function pickPoint(event) {
        if (!event)
            return null;
        const touches = event.touches && event.touches.length
            ? event.touches
            : event.changedTouches && event.changedTouches.length
                ? event.changedTouches
                : [];
        const touch = touches[0];
        if (touch) {
            const x = readNumber(touch.clientX != null ? touch.clientX : touch.pageX != null ? touch.pageX : touch.x);
            const y = readNumber(touch.clientY != null ? touch.clientY : touch.pageY != null ? touch.pageY : touch.y);
            if (!Number.isNaN(x) && !Number.isNaN(y))
                return { x, y };
        }
        const x = readNumber(event.clientX != null ? event.clientX : event.pageX);
        const y = readNumber(event.clientY != null ? event.clientY : event.pageY);
        if (!Number.isNaN(x) && !Number.isNaN(y))
            return { x, y };
        return null;
    }
    /**
     * 绑定屏幕级触摸事件。
     * 优先用 my.onTouch*（小游戏），没有就退回 DOM 事件（浏览器 / WebView 容器）。
     * 返回解绑函数。
     */
    function bindTouch(canvas, listener) {
        const g = globalThis;
        const my = getMyApi();
        const cleanups = [];
        let active = false;
        const emit = (x, y, phase) => {
            try {
                return listener(x, y, phase) === true;
            }
            catch (e) {
                return false;
            }
        };
        const onMyTouch = (phase) => (event) => {
            const point = pickPoint(event);
            if (!point)
                return;
            if (phase === 'start') {
                active = emit(point.x, point.y, 'start');
                return;
            }
            if (!active)
                return;
            emit(point.x, point.y, phase);
            if (phase === 'end')
                active = false;
        };
        const hasMyTouch = my && typeof my.onTouchStart === 'function';
        if (hasMyTouch) {
            const start = onMyTouch('start');
            const move = onMyTouch('move');
            const end = onMyTouch('end');
            my.onTouchStart(start);
            my.onTouchMove(move);
            my.onTouchEnd(end);
            if (typeof my.onTouchCancel === 'function')
                my.onTouchCancel(end);
            cleanups.push(() => {
                if (typeof my.offTouchStart === 'function')
                    my.offTouchStart(start);
                if (typeof my.offTouchMove === 'function')
                    my.offTouchMove(move);
                if (typeof my.offTouchEnd === 'function')
                    my.offTouchEnd(end);
                if (typeof my.offTouchCancel === 'function')
                    my.offTouchCancel(end);
            });
        }
        const target = g.window && typeof g.window.addEventListener === 'function' ? g.window : null;
        const isDomCanvas = canvas && typeof canvas.addEventListener === 'function';
        if (target && (isDomCanvas || !hasMyTouch)) {
            const block = (event) => {
                // 面板吃掉了这一下，避免同一触摸继续驱动游戏
                if (event && typeof event.stopPropagation === 'function')
                    event.stopPropagation();
                if (event && typeof event.preventDefault === 'function' && event.cancelable !== false) {
                    event.preventDefault();
                }
            };
            const onStart = (event) => {
                const point = pickPoint(event);
                if (!point)
                    return;
                active = emit(point.x, point.y, 'start');
                if (active)
                    block(event);
            };
            const onMove = (event) => {
                if (!active)
                    return;
                const point = pickPoint(event);
                if (!point)
                    return;
                emit(point.x, point.y, 'move');
                block(event);
            };
            const onEnd = (event) => {
                if (!active)
                    return;
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
                }
                catch (e) {
                    // ignore
                }
            });
        };
    }
    /** 按 dpr 设置 canvas 的物理像素尺寸 */
    function resizeCanvas(canvas, size) {
        if (!canvas)
            return;
        const width = Math.max(1, Math.round(size.width * size.pixelRatio));
        const height = Math.max(1, Math.round(size.height * size.pixelRatio));
        if (canvas.width !== width)
            canvas.width = width;
        if (canvas.height !== height)
            canvas.height = height;
    }
    /** 监听屏幕尺寸变化（横竖屏切换），返回解绑函数 */
    function bindResize(callback) {
        const g = globalThis;
        const my = getMyApi();
        const cleanups = [];
        if (my && typeof my.onWindowResize === 'function') {
            my.onWindowResize(callback);
            cleanups.push(() => {
                if (typeof my.offWindowResize === 'function')
                    my.offWindowResize(callback);
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
                }
                catch (e) {
                    // ignore
                }
            });
        };
    }
    /**
     * 监听网络状态（在线 / 断网、网络类型变化）。
     * 小游戏用 my.getNetworkType + my.onNetworkStatusChange，浏览器退回 navigator.onLine。
     * 返回解绑函数。
     */
    function bindNetworkState(callback) {
        const g = globalThis;
        const my = getMyApi();
        const cleanups = [];
        const emit = (online, type) => {
            try {
                callback({ online, type: type || 'unknown' });
            }
            catch (e) {
                // ignore
            }
        };
        if (my && typeof my.getNetworkType === 'function') {
            try {
                my.getNetworkType({
                    success(res) {
                        emit(true, String((res && res.networkType) || 'unknown'));
                    },
                    fail() {
                        // 取不到就当未知，不影响后面的变化监听
                    },
                });
            }
            catch (e) {
                // ignore
            }
        }
        if (my && typeof my.onNetworkStatusChange === 'function') {
            const handler = (res) => {
                emit(!(res && res.isConnected === false), String((res && res.networkType) || 'unknown'));
            };
            my.onNetworkStatusChange(handler);
            cleanups.push(() => {
                if (typeof my.offNetworkStatusChange === 'function')
                    my.offNetworkStatusChange(handler);
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
                }
                catch (e) {
                    // ignore
                }
            });
        };
    }

    /**
     * 日志存储 + console 拦截 + 参数格式化。
     */
    /** 某条 console 日志是否属于当前 tab（网络条目单独渲染，不从这里取） */
    function matchesFilter(entry, filter) {
        if (filter === 'net')
            return false;
        return filter === 'all' || entry.level === filter;
    }
    function pad2$1(value) {
        return value < 10 ? '0' + value : String(value);
    }
    function timestamp$1() {
        const now = new Date();
        return pad2$1(now.getHours()) + ':' + pad2$1(now.getMinutes()) + ':' + pad2$1(now.getSeconds());
    }
    function isErrorLike(value) {
        if (!value || typeof value !== 'object')
            return false;
        if (value instanceof Error)
            return true;
        return typeof value.message === 'string' && typeof value.name === 'string';
    }
    function formatError(value) {
        const name = value.name || 'Error';
        const message = value.message || '';
        const head = message ? name + ': ' + message : name;
        const stack = typeof value.stack === 'string' ? value.stack : '';
        if (!stack)
            return head;
        // 堆栈只保留前几帧，避免一条日志吃掉半屏
        const frames = stack.split('\n').slice(1, 4).map((line) => line.trim()).filter(Boolean);
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
    const DEFAULT_IGNORE_KEYWORDS = ['window.dispatchEvent', 'getStorageInfoSync'];
    /** 去空白、丢空串、去重 */
    function normalizeKeywords(words) {
        const result = [];
        for (let i = 0; i < words.length; i++) {
            const word = typeof words[i] === 'string' ? words[i].trim() : '';
            if (word && result.indexOf(word) < 0)
                result.push(word);
        }
        return result;
    }
    /** 超出长度直接截断并标注原长度，省略提示也计入 limit，返回总长度不超过 limit */
    function limitText(text, limit) {
        if (text.length <= limit)
            return text;
        const marker = '…（已截断，共 ' + text.length + ' 字符）';
        if (marker.length >= limit)
            return text.slice(0, limit);
        return text.slice(0, limit - marker.length) + marker;
    }
    const DEFAULT_STRINGIFY_OPTIONS = {
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
    function prepareForStringify(value, opts, depth, seen, state) {
        const type = typeof value;
        if (type === 'string') {
            if (value.length <= opts.maxStringLength)
                return value;
            return value.slice(0, opts.maxStringLength) + '…（共 ' + value.length + ' 字符）';
        }
        if (type === 'bigint')
            return String(value);
        if (type === 'function')
            return '[Function' + (value.name ? ': ' + value.name : '') + ']';
        if (!value || type !== 'object')
            return value;
        const isArray = Object.prototype.toString.call(value) === '[object Array]';
        // Date / Map / 类实例等交给 JSON.stringify 自己处理，不做展开
        if (!isArray && Object.prototype.toString.call(value) !== '[object Object]')
            return value;
        if (state.nodes++ >= opts.maxNodes)
            return '[…]';
        if (seen.indexOf(value) >= 0)
            return '[Circular]';
        if (depth >= opts.maxDepth)
            return isArray ? '[Array(' + value.length + ')]' : '[Object]';
        seen.push(value);
        let result;
        if (isArray) {
            const out = [];
            const count = Math.min(value.length, opts.maxArrayItems);
            for (let i = 0; i < count; i++) {
                out.push(prepareForStringify(value[i], opts, depth + 1, seen, state));
            }
            if (value.length > count)
                out.push('…共 ' + value.length + ' 项');
            result = out;
        }
        else {
            const out = {};
            let keys = [];
            try {
                keys = Object.keys(value);
            }
            catch (e) {
                seen.pop();
                return '[Object]';
            }
            const count = Math.min(keys.length, opts.maxKeys);
            for (let i = 0; i < count; i++) {
                const key = keys[i];
                try {
                    out[key] = prepareForStringify(value[key], opts, depth + 1, seen, state);
                }
                catch (e) {
                    out[key] = '[Unreadable]';
                }
            }
            if (keys.length > count)
                out['…'] = '共 ' + keys.length + ' 个键';
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
    function stringifyLimited(value, limit, indent, options) {
        const seen = [];
        let dedupe = true;
        let nodes = 0;
        let budget = limit;
        let source = value;
        if (options) {
            const opts = Object.assign(Object.assign({}, DEFAULT_STRINGIFY_OPTIONS), options);
            try {
                source = prepareForStringify(value, opts, 0, [], { nodes: 0 });
            }
            catch (e) {
                source = value;
            }
        }
        const json = JSON.stringify(source, (_key, val) => {
            const type = typeof val;
            if (type === 'bigint')
                return String(val);
            if (type === 'function')
                return '[Function' + (val.name ? ': ' + val.name : '') + ']';
            if (type === 'string') {
                budget -= val.length;
                return budget < 0 ? '[…]' : val;
            }
            if (val && type === 'object') {
                if (++nodes > STRINGIFY_MAX_NODES)
                    return '[…]';
                if (dedupe) {
                    if (seen.indexOf(val) >= 0)
                        return '[Circular]';
                    seen.push(val);
                    if (seen.length >= STRINGIFY_MAX_SEEN)
                        dedupe = false;
                }
            }
            return val;
        }, indent);
        return limitText(json === undefined ? String(value) : json, limit);
    }
    function formatValue(value) {
        if (typeof value === 'string')
            return limitText(value, CONSOLE_TEXT_LIMIT);
        if (value === undefined)
            return 'undefined';
        if (value === null)
            return 'null';
        const type = typeof value;
        if (type === 'number' || type === 'boolean' || type === 'bigint')
            return String(value);
        if (type === 'symbol')
            return String(value);
        if (type === 'function')
            return '[Function' + (value.name ? ': ' + value.name : '') + ']';
        if (isErrorLike(value))
            return formatError(value);
        try {
            return stringifyLimited(value, CONSOLE_TEXT_LIMIT, 0, DEFAULT_STRINGIFY_OPTIONS);
        }
        catch (e) {
            try {
                return Object.prototype.toString.call(value);
            }
            catch (e2) {
                return String(value);
            }
        }
    }
    /** 把 console.log 的多个参数拼成一行日志 */
    function formatArgs(args) {
        // 单参数时 formatValue 已经截断过，再截一次会把“共 N 字符”提示成截断后的长度
        if (args.length === 1)
            return formatValue(args[0]);
        const parts = [];
        for (let i = 0; i < args.length; i++) {
            parts.push(formatValue(args[i]));
        }
        return limitText(parts.join(' '), CONSOLE_TEXT_LIMIT);
    }
    /** canvas 认的颜色值：十六进制 / rgb(a) / hsl(a) / 具名颜色 */
    function safeColorValue(raw) {
        const value = raw.trim().replace(/!important$/i, '').trim();
        if (!value || value.length > 32)
            return undefined;
        if (/^#[0-9a-f]{3,8}$/i.test(value))
            return value;
        if (/^(rgb|rgba|hsl|hsla)\(\s*[0-9.%,\s/]+\)$/i.test(value))
            return value;
        if (/^[a-z]+$/i.test(value))
            return value.toLowerCase() === 'transparent' ? undefined : value;
        return undefined;
    }
    /** 从 "1px 6px" 这类值里取最后一个像素数 */
    function parsePx(raw) {
        const matched = raw.match(/[\d.]+px/g);
        if (!matched || !matched.length)
            return 0;
        const value = parseFloat(matched[matched.length - 1]);
        return Number.isFinite(value) ? value : 0;
    }
    const CSS_DECL = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i;
    /**
     * 解析 %c 后面的 CSS 字符串。
     * 只认面板能画出来的几项（颜色、背景、加粗、内边距、圆角），
     * 其余属性直接忽略，避免把乱七八糟的样式带到 canvas 上。
     */
    function parseCssStyle(css) {
        const style = { paddingX: 0, radius: 0, bold: false };
        let used = false;
        const decls = String(css).split(';');
        for (let i = 0; i < decls.length; i++) {
            const matched = CSS_DECL.exec(decls[i]);
            if (!matched)
                continue;
            const key = matched[1].toLowerCase();
            const value = matched[2];
            if (key === 'color') {
                const color = safeColorValue(value);
                if (color) {
                    style.color = color;
                    used = true;
                }
            }
            else if (key === 'background' || key === 'background-color') {
                const color = safeColorValue(value);
                if (color) {
                    style.background = color;
                    used = true;
                }
            }
            else if (key === 'font-weight') {
                const weight = value.trim().toLowerCase();
                if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) {
                    style.bold = true;
                    used = true;
                }
            }
            else if (key === 'padding' || key === 'padding-inline' || key === 'padding-left' || key === 'padding-right') {
                const px = parsePx(value);
                if (px > 0) {
                    // 面板空间有限，内边距最多 8px
                    style.paddingX = Math.min(px, 8);
                    used = true;
                }
            }
            else if (key === 'border-radius') {
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
    function formatJson(value) {
        try {
            return stringifyLimited(value, CONSOLE_TEXT_LIMIT, 0, DEFAULT_STRINGIFY_OPTIONS);
        }
        catch (e) {
            return formatValue(value);
        }
    }
    /**
     * 按浏览器 console 的规则处理格式串：
     * %c 消费一个 CSS 字符串并给后续文本上样式（直到下一个 %c 或空样式重置），
     * %s/%d/%i/%f/%o/%O/%j 消费一个值，%% 输出百分号。
     * 没有样式时只返回纯文本，渲染层走原来的快路径。
     */
    function formatConsoleArgs(args) {
        if (!args.length)
            return { text: '' };
        const first = args[0];
        if (typeof first !== 'string' || first.indexOf('%') < 0) {
            return { text: formatArgs(args) };
        }
        const runs = [];
        let text = '';
        let style;
        let styled = false;
        let truncated = false;
        let argIndex = 1;
        let last = 0;
        const append = (value, runStyle) => {
            if (!value)
                return;
            let piece = value;
            // 留一个字符给末尾的省略号，保证最终长度不超上限
            if (text.length + piece.length > CONSOLE_TEXT_LIMIT) {
                piece = piece.slice(0, Math.max(0, CONSOLE_TEXT_LIMIT - 1 - text.length));
                truncated = true;
            }
            if (!piece)
                return;
            text += piece;
            const prev = runs[runs.length - 1];
            if (prev && prev.style === runStyle)
                prev.text += piece;
            else
                runs.push({ text: piece, style: runStyle });
        };
        FORMAT_SPEC.lastIndex = 0;
        let matched;
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
                if (style)
                    styled = true;
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
            if (tail && tail.style === style)
                tail.text += '…';
            else
                runs.push({ text: '…', style });
        }
        return styled ? { text, runs } : { text };
    }
    class LogStore {
        constructor(maxLogs) {
            this.entries = [];
            this.listeners = [];
            this.seq = 0;
            /** 按级别维护条数，避免每次渲染都全量扫一遍 */
            this.counts = { log: 0, info: 0, warn: 0, error: 0 };
            /** 排除词：命中的日志整条丢弃，被丢弃的不占条数上限 */
            this.keywords = DEFAULT_IGNORE_KEYWORDS.slice();
            /** 筛选词：非空时只保留命中的日志，同样不占条数上限 */
            this.includeWords = [];
            /** 内容版本号，UI 靠它判断能否复用上一帧的过滤/换行结果 */
            this.version = 0;
            this.maxLogs = maxLogs;
        }
        /** 整体替换过滤词，传空数组表示不再过滤任何日志 */
        setIgnoreKeywords(words) {
            this.keywords = normalizeKeywords(words || []);
        }
        addIgnoreKeywords(words) {
            if (!words || !words.length)
                return;
            this.keywords = normalizeKeywords(this.keywords.concat(words));
        }
        ignoreKeywords() {
            return this.keywords.slice();
        }
        /** 整体替换筛选词，传空数组表示不筛选（所有未命中的排除词的日志都保留） */
        setIncludeKeywords(words) {
            this.includeWords = normalizeKeywords(words || []);
        }
        addIncludeKeywords(words) {
            if (!words || !words.length)
                return;
            this.includeWords = normalizeKeywords(this.includeWords.concat(words));
        }
        includeKeywords() {
            return this.includeWords.slice();
        }
        /** 先扫原始参数：命中就不用再走格式化了（日志有长度上限，关键字可能落在被截断的部分） */
        shouldIgnore(args) {
            const keywords = this.keywords;
            if (!keywords.length)
                return false;
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (typeof arg !== 'string' || !arg)
                    continue;
                for (let k = 0; k < keywords.length; k++) {
                    if (arg.indexOf(keywords[k]) >= 0)
                        return true;
                }
            }
            return false;
        }
        /** 关键字可能只出现在对象字段里，格式化结果再兜一次 */
        isIgnoredText(text) {
            const keywords = this.keywords;
            for (let k = 0; k < keywords.length; k++) {
                if (text.indexOf(keywords[k]) >= 0)
                    return true;
            }
            return false;
        }
        /** 没有筛选词时全部通过；有筛选词时先扫原始参数 */
        shouldInclude(args) {
            const words = this.includeWords;
            if (!words.length)
                return true;
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (typeof arg !== 'string' || !arg)
                    continue;
                for (let k = 0; k < words.length; k++) {
                    if (arg.indexOf(words[k]) >= 0)
                        return true;
                }
            }
            return false;
        }
        /** 筛选词也可能只出现在对象字段里，格式化结果再兜一次 */
        isIncludedText(text) {
            const words = this.includeWords;
            if (!words.length)
                return true;
            for (let k = 0; k < words.length; k++) {
                if (text.indexOf(words[k]) >= 0)
                    return true;
            }
            return false;
        }
        /** 运行时调整上限，超出部分立即丢弃最旧的 */
        setMaxLogs(maxLogs) {
            if (!(maxLogs > 0))
                return;
            this.maxLogs = Math.floor(maxLogs);
            this.trim();
            this.version++;
            this.emit();
        }
        push(level, text, runs) {
            const entry = {
                id: ++this.seq,
                level,
                time: timestamp$1(),
                // 入库就截短：内存里不留完整长文本
                text: limitText(text, CONSOLE_TEXT_LIMIT),
            };
            if (runs && runs.length)
                entry.runs = runs;
            this.entries.push(entry);
            this.counts[level] = (this.counts[level] || 0) + 1;
            this.trim();
            this.version++;
            this.emit();
        }
        /** 超出上限就丢最旧的，同时维护按级别计数 */
        trim() {
            const overflow = this.entries.length - this.maxLogs;
            if (overflow <= 0)
                return;
            const dropped = this.entries.splice(0, overflow);
            for (let i = 0; i < dropped.length; i++) {
                const key = dropped[i].level;
                this.counts[key] = Math.max(0, (this.counts[key] || 0) - 1);
            }
        }
        clear() {
            if (!this.entries.length)
                return;
            this.entries = [];
            this.counts = { log: 0, info: 0, warn: 0, error: 0 };
            this.version++;
            this.emit();
        }
        list() {
            return this.entries;
        }
        count(filter) {
            // 网络日志独立存放，不参与 console 的统计
            if (filter === 'net')
                return 0;
            if (filter === 'all')
                return this.entries.length;
            return this.counts[filter] || 0;
        }
        onChange(listener) {
            this.listeners.push(listener);
            return () => {
                const index = this.listeners.indexOf(listener);
                if (index >= 0)
                    this.listeners.splice(index, 1);
            };
        }
        emit() {
            for (let i = 0; i < this.listeners.length; i++) {
                try {
                    this.listeners[i]();
                }
                catch (e) {
                    // 渲染异常不能反过来影响业务日志
                }
            }
        }
    }
    /** 拦截 console.log/info/warn/error/debug，转发给 store，同时保留原始输出 */
    function interceptConsole(store) {
        const target = typeof console !== 'undefined' ? console : null;
        if (!target)
            return { restore() { } };
        const mapping = [
            { method: 'log', level: 'log' },
            { method: 'info', level: 'info' },
            { method: 'warn', level: 'warn' },
            { method: 'error', level: 'error' },
            { method: 'debug', level: 'log' },
        ];
        const originals = [];
        mapping.forEach((item) => {
            const original = target[item.method];
            originals.push({ method: item.method, original });
            target[item.method] = function patched(...args) {
                // 命中排除词时连格式化都不做，直接透传给原函数；这条也不占条数上限
                if (!store.shouldIgnore(args)) {
                    try {
                        const formatted = formatConsoleArgs(args);
                        // 排除优先：先看格式化文本是否命中排除词，再看是否命中筛选词
                        const keep = !store.isIgnoredText(formatted.text)
                            && (store.shouldInclude(args) || store.isIncludedText(formatted.text));
                        if (keep)
                            store.push(item.level, formatted.text, formatted.runs);
                    }
                    catch (e) {
                        // 格式化失败也要保证原始日志照常输出
                    }
                }
                if (typeof original === 'function') {
                    try {
                        original.apply(target, args);
                    }
                    catch (e) {
                        // ignore
                    }
                }
            };
        });
        return {
            restore() {
                originals.forEach((item) => {
                    if (item.original !== undefined)
                        target[item.method] = item.original;
                });
            },
        };
    }

    /**
     * 面板视图：全部用 Canvas 2D 绘制（支付宝小游戏没有 DOM），
     * 命中检测自己算，触摸由 env.bindTouch 统一喂进来。
     */
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
        chipBg: 'rgba(255, 255, 255, 0.10)',
        chipActiveBg: '#2f7d52',
        chipActiveText: '#ffffff',
        buttonBg: 'rgba(0, 0, 0, 0.62)',
        buttonBorder: 'rgba(124, 255, 178, 0.9)',
        buttonText: '#7cffb2',
        cardBg: 'rgba(255, 255, 255, 0.05)',
    };
    const FILTERS = [
        { level: 'all', label: '全部' },
        { level: 'log', label: 'log' },
        { level: 'info', label: 'info' },
        { level: 'warn', label: 'warn' },
        { level: 'error', label: 'error' },
        { level: 'net', label: 'net' },
    ];
    function clamp(value, min, max) {
        if (value < min)
            return min;
        if (value > max)
            return max;
        return value;
    }
    /** 耗时：小于 1s 显示毫秒，超过显示秒 */
    function formatCost(ms) {
        const cost = ms > 0 ? ms : 0;
        if (cost < 1000)
            return cost + 'ms';
        return (cost / 1000).toFixed(2) + 's';
    }
    function levelColor(level) {
        if (level === 'warn')
            return COLORS.warn;
        if (level === 'error')
            return COLORS.error;
        if (level === 'info')
            return COLORS.info;
        return COLORS.text;
    }
    function roundRectPath(ctx, x, y, w, h, r, topOnly) {
        const radius = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + w - radius, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
        if (topOnly) {
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x, y + h);
        }
        else {
            ctx.lineTo(x + w, y + h - radius);
            ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
            ctx.lineTo(x + radius, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
        }
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }
    function insideRect(rect, x, y) {
        return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
    }
    class LogPanelView {
        constructor(store, net, canvas, size, options) {
            this.visible = false;
            this.filter = 'all';
            this.scroll = 0;
            this.maxScroll = 0;
            /** 当前展开的网络记录 id */
            this.expandedNetId = null;
            /** 上一帧渲染出来的网络卡片命中区 */
            this.netHits = [];
            /** 按下时落在哪张网络卡片上，抬手没滑动就切换展开 */
            this.pendingCardId = null;
            this.netState = { online: true, type: 'unknown' };
            this.netStateTimer = null;
            this.tickTimer = null;
            /** 布局与 console 列表缓存，避免每帧重复计算 */
            this.layoutCache = null;
            this.layoutKey = '';
            this.listCache = null;
            this.layout = null;
            this.touchMode = 'none';
            this.touchStart = { x: 0, y: 0 };
            this.buttonStart = { x: 0, y: 0 };
            this.scrollStart = 0;
            this.pending = false;
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
        get ready() {
            return !!this.ctx;
        }
        /** 屏幕尺寸变化（横竖屏切换）后重建画布尺寸与布局 */
        resize(size) {
            this.size = size;
            resizeCanvas(this.canvas, size);
            this.clampButton();
            this.layoutCache = null;
            this.layout = this.getLayout();
            this.invalidate();
        }
        isOpen() {
            return this.visible;
        }
        show() {
            if (this.visible)
                return;
            this.visible = true;
            this.scroll = 0;
            this.layout = this.getLayout();
            if (this.onOpenChange)
                this.onOpenChange(true);
            this.invalidate();
        }
        hide() {
            if (!this.visible)
                return;
            this.visible = false;
            this.touchMode = 'none';
            if (this.onOpenChange)
                this.onOpenChange(false);
            this.invalidate();
        }
        toggle() {
            if (this.visible)
                this.hide();
            else
                this.show();
        }
        addLog() {
            if (this.visible)
                this.invalidate();
        }
        invalidate() {
            if (this.pending)
                return;
            this.pending = true;
            const g = globalThis;
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
        render() {
            const ctx = this.ctx;
            if (!ctx)
                return;
            const dpr = this.size.pixelRatio || 1;
            if (typeof ctx.setTransform === 'function')
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, this.size.width, this.size.height);
            if (this.visible)
                this.renderPanel();
            else
                this.renderButton();
            if (this.onFrame) {
                try {
                    this.onFrame();
                }
                catch (e) {
                    // 上屏失败不能影响绘制
                }
            }
        }
        /** 触摸分发，返回 true 表示面板消费了这一次触摸 */
        handleTouch(x, y, phase) {
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
                if (!layout)
                    return false;
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
                if (moved < 8)
                    this.show();
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
        hitNetCard(x, y) {
            for (let i = this.netHits.length - 1; i >= 0; i--) {
                if (insideRect(this.netHits[i].rect, x, y))
                    return this.netHits[i].id;
            }
            return null;
        }
        setFilter(level) {
            this.filter = level;
            this.scroll = 0;
            this.pendingCardId = null;
            this.invalidate();
        }
        hitButton(x, y) {
            const dx = x - this.button.x;
            const dy = y - this.button.y;
            const radius = this.button.r + 8; // 稍微放大命中范围，手指好点
            return dx * dx + dy * dy <= radius * radius;
        }
        clampButton() {
            const r = this.button.r;
            this.button.x = clamp(this.button.x, r + 4, Math.max(r + 4, this.size.width - r - 4));
            this.button.y = clamp(this.button.y, r + 4, Math.max(r + 4, this.size.height - r - 4));
        }
        /** 布局只在屏幕尺寸或当前 tab 变化时重算，其余帧直接复用 */
        getLayout() {
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
        computeLayout() {
            const margin = 10;
            const headerHeight = 40;
            const toolbarHeight = 34;
            // 面板不铺满整屏：高度取屏幕的 75%，底部贴边，上方留出遮罩区域，点一下就收起
            const panelHeight = Math.min(this.size.height - margin * 2, Math.max(200, Math.round(this.size.height * 0.75)));
            const panel = {
                x: margin,
                y: this.size.height - margin - panelHeight,
                w: Math.max(120, this.size.width - margin * 2),
                h: panelHeight,
            };
            const header = { x: panel.x, y: panel.y, w: panel.w, h: headerHeight };
            const toolbar = { x: panel.x, y: panel.y + headerHeight, w: panel.w, h: toolbarHeight };
            // net tab 顶部多一条网络状态栏（在线状态、进行中数量），列表相应下移
            const netBarH = this.filter === 'net' ? 24 : 0;
            const netBar = { x: panel.x, y: toolbar.y + toolbarHeight, w: panel.w, h: netBarH };
            const list = {
                x: panel.x,
                y: netBar.y + netBarH,
                w: panel.w,
                h: panel.h - headerHeight - toolbarHeight - netBarH,
            };
            const close = { x: panel.x + panel.w - 8 - 30, y: panel.y + 6, w: 30, h: 28 };
            const clear = { x: close.x - 8 - 48, y: panel.y + 8, w: 48, h: 24 };
            const chips = [];
            // 六个 tab，窄屏时自动缩窄，避免挤出面板
            const chipGap = 6;
            const available = Math.max(60, toolbar.w - 20);
            const chipW = Math.max(30, Math.min(48, Math.floor((available - chipGap * (FILTERS.length - 1)) / FILTERS.length)));
            const chipH = 24;
            let chipX = toolbar.x + 10;
            const chipY = toolbar.y + (toolbar.h - chipH) / 2;
            FILTERS.forEach((item) => {
                chips.push({ level: item.level, label: item.label, rect: { x: chipX, y: chipY, w: chipW, h: chipH } });
                chipX += chipW + chipGap;
            });
            return { panel, header, toolbar, netBar, list, clear, close, chips };
        }
        renderButton() {
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
        renderPanel() {
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
            if (this.filter === 'net')
                this.renderNetBar(layout.netBar);
            this.renderList(layout);
        }
        countText() {
            if (this.filter === 'net') {
                const pending = this.net.pending();
                const total = this.net.total();
                return pending > 0 ? total + ' · ' + pending + ' 进行中' : String(total);
            }
            const consoleTotal = this.store.count('all');
            if (this.filter === 'all')
                return String(consoleTotal);
            return this.store.count(this.filter) + '/' + consoleTotal;
        }
        /** net tab 顶部状态栏：在线状态 + 网络类型 + 进行中/总数 */
        renderNetBar(rect) {
            const ctx = this.ctx;
            if (rect.h <= 0)
                return;
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
        netStateText() {
            if (!this.netState.online)
                return '离线';
            const type = String(this.netState.type || 'unknown').toLowerCase();
            if (type === 'unknown' || type === 'none')
                return '在线 · 网络未知';
            if (type === 'wifi')
                return '在线 · WIFI';
            return '在线 · ' + type.toUpperCase();
        }
        /** 网络状态变化（宿主回调 / 轮询兜底），只在面板打开时触发重绘 */
        applyNetState(state) {
            this.netState = state;
            this.addLog();
        }
        /** 有请求进行中时按固定间隔重绘，让耗时实时跳动 */
        scheduleTick() {
            if (this.tickTimer !== null)
                return;
            const g = globalThis;
            if (typeof g.setTimeout !== 'function')
                return;
            this.tickTimer = g.setTimeout(() => {
                this.tickTimer = null;
                if (!this.visible || this.filter !== 'net')
                    return;
                if (this.net.pending() <= 0)
                    return;
                this.invalidate();
            }, NET_TICK_INTERVAL);
        }
        /** 清掉定时器并解绑网络状态监听 */
        destroy() {
            const g = globalThis;
            if (this.tickTimer !== null && typeof g.clearTimeout === 'function') {
                g.clearTimeout(this.tickTimer);
                this.tickTimer = null;
            }
            if (this.netStateTimer) {
                try {
                    this.netStateTimer();
                }
                catch (e) {
                    // ignore
                }
                this.netStateTimer = null;
            }
            this.netHits.length = 0;
        }
        renderFlatButton(rect, label, color, fontSize) {
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
        renderList(layout) {
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
                if (filtered[i].runs)
                    this.renderRichRow(filtered[i], cache.runs[i], listRect.x, top, rowHeight);
                else
                    this.renderRow(filtered[i], cache.lines[i], listRect.x, top, rowHeight);
                bottom = top;
                if (top < topEdge)
                    break;
            }
            ctx.restore();
        }
        /**
         * 过滤 + 换行结果缓存。
         * 日志只增不改，只要版本号、当前 tab、可用宽度都没变就直接复用，
         * 拖动滚动条时不再重复分配这些数组。
         */
        getListCache(maxWidth) {
            const cache = this.listCache;
            if (cache &&
                cache.version === this.store.version &&
                cache.filter === this.filter &&
                cache.width === maxWidth) {
                return cache;
            }
            const entries = this.store.list();
            const filtered = [];
            const heights = [];
            const lines = [];
            const runs = [];
            let contentHeight = 0;
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                if (!matchesFilter(entry, this.filter))
                    continue;
                filtered.push(entry);
                if (entry.runs) {
                    const runLines = this.layoutRuns(entry, maxWidth);
                    runs.push(runLines);
                    lines.push([]);
                    const height = runLines.length * LINE_HEIGHT + ROW_GAP;
                    heights.push(height);
                    contentHeight += height;
                }
                else {
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
        emptyText() {
            if (this.filter === 'all')
                return '暂无日志';
            if (this.filter === 'net')
                return '暂无网络日志';
            return '当前级别暂无日志';
        }
        /**
         * 网络 tab：每条请求一张卡片，收起时显示 method / url / 状态 / 耗时，
         * 点开显示 url、请求头、请求体、响应头、响应体、错误。
         */
        renderNetList(listRect) {
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
            const heights = [];
            const details = [];
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
                if (top < topEdge)
                    break;
            }
            ctx.restore();
            // 有请求还在跑，定时重绘让耗时实时跳动
            if (this.net.pending() > 0)
                this.scheduleTick();
        }
        renderNetCard(record, detailLines, x, top, cardH, cardW) {
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
            const badge = { x: x + cardW - NET_CARD_PAD - 46, y: top + NET_CARD_PAD, w: 46, h: 16 };
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
        netDetailLines(record, maxWidth) {
            const cache = record.wrapCache;
            if (cache && cache.expanded && cache.width === maxWidth)
                return cache.lines;
            const ctx = this.ctx;
            ctx.font = FONT_SMALL;
            const lines = [];
            const pushSection = (title, body) => {
                if (!body)
                    return;
                lines.push('▸ ' + title);
                const wrapped = this.wrapPlain(body, maxWidth);
                for (let i = 0; i < wrapped.length; i++)
                    lines.push('  ' + wrapped[i]);
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
        wrapPlain(text, maxWidth) {
            const ctx = this.ctx;
            const lines = [];
            const paragraphs = text.replace(/\r\n/g, '\n').split('\n');
            for (let p = 0; p < paragraphs.length; p++) {
                if (lines.length >= MAX_DETAIL_LINES)
                    break;
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
                        if (lines.length >= MAX_DETAIL_LINES)
                            break;
                    }
                    else {
                        line = next;
                    }
                }
                if (line && lines.length < MAX_DETAIL_LINES)
                    lines.push(line);
            }
            return lines;
        }
        /** 折叠态单行 url 的省略结果：宽度不变就复用，省掉每帧几十次 measureText */
        netUrlText(record, maxWidth) {
            const cache = record.urlCache;
            if (cache && cache.width === maxWidth)
                return cache.text;
            const text = this.ellipsis(record.url, maxWidth);
            record.urlCache = { width: maxWidth, text };
            return text;
        }
        /** 单行截断，二分查找省掉逐字测量 */
        ellipsis(text, maxWidth) {
            const ctx = this.ctx;
            if (ctx.measureText(text).width <= maxWidth)
                return text;
            let low = 0;
            let high = text.length;
            while (low < high) {
                const mid = (low + high + 1) >> 1;
                if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth)
                    low = mid;
                else
                    high = mid - 1;
            }
            return text.slice(0, low) + '…';
        }
        netBadgeText(record) {
            if (record.status === 'pending')
                return '···';
            if (record.status === 'fail')
                return 'ERR';
            return record.statusCode > 0 ? String(record.statusCode) : 'OK';
        }
        netMetaText(record) {
            const cost = record.status === 'pending' ? Date.now() - record.startedAt : record.cost;
            const parts = [record.time, formatCost(cost)];
            if (record.status === 'pending')
                parts.push('请求中…');
            else if (record.status === 'fail')
                parts.push('失败');
            const size = record.responseBody.length;
            if (size > 0)
                parts.push(size >= 1024 ? (size / 1024).toFixed(1) + 'KB' : size + 'B');
            return parts.join(' · ');
        }
        netStatusColor(record) {
            if (record.status === 'pending')
                return COLORS.warn;
            if (record.status === 'fail')
                return COLORS.error;
            if (record.statusCode >= 500)
                return COLORS.error;
            if (record.statusCode >= 400)
                return COLORS.warn;
            return COLORS.success;
        }
        netMethodColor(method) {
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
        renderRow(entry, lines, listX, top, height) {
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
        renderRichRow(entry, lines, listX, top, height) {
            const ctx = this.ctx;
            ctx.fillStyle = levelColor(entry.level);
            ctx.fillRect(listX + 8, top + 3, 2, Math.max(4, height - ROW_GAP - 2));
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.font = FONT;
            let boldFont = false;
            for (let i = 0; i < lines.length; i++) {
                const pieces = lines[i].pieces;
                if (!pieces.length)
                    continue;
                const lineTop = top + 3 + i * LINE_HEIGHT;
                // 背景先整体画完，避免后一段的背景盖住前一段文字
                for (let p = 0; p < pieces.length; p++) {
                    const style = pieces[p].style;
                    if (!style || !style.background)
                        continue;
                    const bx = listX + 16 + pieces[p].x;
                    const bw = pieces[p].padX * 2 + pieces[p].w;
                    const bh = LINE_HEIGHT - 3;
                    ctx.fillStyle = style.background;
                    if (style.radius > 0) {
                        roundRectPath(ctx, bx, lineTop - 1, bw, bh, style.radius);
                        ctx.fill();
                    }
                    else {
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
        layoutRuns(entry, maxWidth) {
            const cache = entry.runWrapCache;
            if (cache && cache.width === maxWidth)
                return cache.lines;
            const ctx = this.ctx;
            const runs = entry.runs || [];
            const lines = [{ pieces: [] }];
            let current = lines[0];
            let x = 0;
            let open = null;
            let openStyle;
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
            const feed = (text, style) => {
                if (!text)
                    return;
                if (style !== openStyle) {
                    closePiece();
                    openStyle = style;
                }
                const padX = style && style.paddingX ? style.paddingX : 0;
                ctx.font = style && style.bold ? FONT_RUN_BOLD : FONT;
                for (let i = 0; i < text.length; i++) {
                    if (lines.length > MAX_LINES_PER_ENTRY)
                        return;
                    const ch = text.charAt(i);
                    if (ch === '\n') {
                        newLine();
                        continue;
                    }
                    const charWidth = ctx.measureText(ch).width;
                    if (open) {
                        if (x + charWidth > maxWidth)
                            newLine();
                    }
                    else if (current.pieces.length && x + padX + charWidth > maxWidth) {
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
            for (let i = 0; i < runs.length; i++)
                feed(runs[i].text, runs[i].style);
            closePiece();
            while (lines.length && !lines[lines.length - 1].pieces.length)
                lines.pop();
            ctx.font = FONT;
            entry.runWrapCache = { width: maxWidth, lines };
            return lines;
        }
        /** 按面板宽度换行，结果缓存在 entry 上，日志不变就不重复测量 */
        wrapEntry(entry, maxWidth) {
            const cache = entry.wrapCache;
            if (cache && cache.width === maxWidth)
                return cache.lines;
            const ctx = this.ctx;
            const content = '[' + entry.time + '] ' + entry.text;
            const lines = [];
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
                        if (lines.length >= MAX_LINES_PER_ENTRY)
                            break;
                    }
                    else {
                        line = next;
                    }
                }
                if (lines.length >= MAX_LINES_PER_ENTRY)
                    break;
                if (line)
                    lines.push(line);
            }
            if (lines.length >= MAX_LINES_PER_ENTRY) {
                lines.length = MAX_LINES_PER_ENTRY;
                lines[MAX_LINES_PER_ENTRY - 1] = lines[MAX_LINES_PER_ENTRY - 1] + ' …';
            }
            entry.wrapCache = { width: maxWidth, lines };
            return lines;
        }
    }

    const MAX_BOOT_RETRIES = 120;
    const BOOT_RETRY_INTERVAL = 100;
    class CocosPresenter {
        constructor(size) {
            this.cc = null;
            this.node = null;
            this.sprite = null;
            this.texture = null;
            this.transform = null;
            this.blocker = null;
            this.sceneHandler = null;
            this.canvas = null;
            this.blocking = false;
            this.textureWidth = 0;
            this.textureHeight = 0;
            /** 上一次设置的 UI 尺寸，没变就不重复 setContentSize（会触发 UI 重算） */
            this.uiWidth = 0;
            this.uiHeight = 0;
            this.booting = false;
            this.destroyed = false;
            this.retries = 0;
            this.timer = null;
            this.size = size;
        }
        /** 异步拿 cc 并建节点；拿不到就静默退出，保持原来的直接上屏行为 */
        boot() {
            if (this.booting || this.cc || this.destroyed)
                return;
            const g = globalThis;
            const system = g.System;
            if (!system || typeof system.import !== 'function') {
                // 脚本可能被很早加载（引擎还没起来），隔一会儿再试
                this.scheduleRetry();
                return;
            }
            this.booting = true;
            system
                .import('cc')
                .then((mod) => {
                this.booting = false;
                if (this.destroyed)
                    return;
                const cc = mod && mod.Texture2D ? mod : mod && mod.default;
                if (!cc || !cc.Texture2D || !cc.Sprite || !cc.Node) {
                    this.scheduleRetry();
                    return;
                }
                this.cc = cc;
                this.retries = 0;
                this.watchScene();
                this.rebuild();
                // 就绪前可能已经绘制过（那时纹理还没建），这里补一次重绘
                if (this.onReady)
                    this.onReady();
            })
                .catch(() => {
                // 引擎还没加载完时 import 可能失败，继续重试
                this.booting = false;
                this.scheduleRetry();
            });
        }
        scheduleRetry() {
            if (this.retries >= MAX_BOOT_RETRIES || this.destroyed)
                return;
            const g = globalThis;
            if (typeof g.setTimeout !== 'function')
                return;
            this.retries++;
            this.timer = g.setTimeout(() => {
                this.timer = null;
                this.boot();
            }, BOOT_RETRY_INTERVAL);
        }
        /** 切换场景会销毁节点，需要重建 */
        watchScene() {
            const cc = this.cc;
            if (!cc.director || !cc.Director)
                return;
            const event = cc.Director.EVENT_AFTER_SCENE_LAUNCH;
            this.sceneHandler = () => this.rebuild();
            cc.director.on(event, this.sceneHandler);
        }
        rebuild() {
            if (this.node && this.node.isValid !== false)
                return;
            this.node = null;
            this.createNodes();
            if (this.canvas)
                this.present(this.canvas);
        }
        createNodes() {
            const cc = this.cc;
            const scene = cc.director && cc.director.getScene ? cc.director.getScene() : null;
            if (!scene)
                return;
            const canvasComp = scene.getComponentInChildren ? scene.getComponentInChildren(cc.Canvas) : null;
            const parent = canvasComp && canvasComp.node ? canvasComp.node : scene;
            const node = new cc.Node('LogPanelOverlay');
            node.layer = parent.layer;
            parent.addChild(node);
            if (typeof node.setSiblingIndex === 'function' && parent.children) {
                node.setSiblingIndex(parent.children.length - 1);
            }
            this.transform = node.addComponent(cc.UITransform);
            this.sprite = node.addComponent(cc.Sprite);
            if (cc.Sprite.SizeMode)
                this.sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
            if (cc.Sprite.Type)
                this.sprite.type = cc.Sprite.Type.SIMPLE;
            this.texture = new cc.Texture2D();
            if (cc.BlockInputEvents) {
                this.blocker = node.addComponent(cc.BlockInputEvents);
                this.blocker.enabled = this.blocking;
            }
            this.node = node;
            // 节点是新建的，UI 尺寸必须重新设一次
            this.uiWidth = 0;
            this.uiHeight = 0;
            this.applySize();
        }
        applySize() {
            const cc = this.cc;
            if (!this.texture || !this.transform)
                return;
            const width = Math.max(1, Math.round(this.size.width * (this.size.pixelRatio || 1)));
            const height = Math.max(1, Math.round(this.size.height * (this.size.pixelRatio || 1)));
            if (width !== this.textureWidth || height !== this.textureHeight) {
                this.textureWidth = width;
                this.textureHeight = height;
                const format = cc.Texture2D.PixelFormat ? cc.Texture2D.PixelFormat.RGBA8888 : undefined;
                this.texture.reset({ width, height, format, mipmapLevel: 1 });
                if (this.sprite) {
                    const frame = new cc.SpriteFrame();
                    frame.texture = this.texture;
                    // 不设置 rect 的话 UV 会全 0，贴出来是错的
                    if (cc.Rect)
                        frame.rect = new cc.Rect(0, 0, width, height);
                    this.sprite.spriteFrame = frame;
                }
            }
            // Cocos 的 UI 坐标是设计分辨率，不是屏幕逻辑像素
            const visible = cc.view && typeof cc.view.getVisibleSize === 'function' ? cc.view.getVisibleSize() : null;
            const uiWidth = visible && visible.width ? visible.width : this.size.width;
            const uiHeight = visible && visible.height ? visible.height : this.size.height;
            // 每帧都设一遍会一直把 UI 标脏、反复重算顶点，没变化就跳过
            if (uiWidth === this.uiWidth && uiHeight === this.uiHeight)
                return;
            this.uiWidth = uiWidth;
            this.uiHeight = uiHeight;
            this.transform.setContentSize(uiWidth, uiHeight);
            if (typeof this.node.setPosition === 'function')
                this.node.setPosition(0, 0, 0);
        }
        present(canvas) {
            this.canvas = canvas;
            if (!this.cc || !this.texture)
                return;
            if (this.node && this.node.isValid === false)
                this.node = null;
            if (!this.node)
                this.createNodes();
            if (!this.texture)
                return;
            this.applySize();
            try {
                this.texture.uploadData(canvas, 0);
            }
            catch (e) {
                // 某些版本 uploadData 对 canvas 有限制，退回到 ImageAsset 重建纹理
                this.uploadViaImageAsset(canvas);
            }
        }
        uploadViaImageAsset(canvas) {
            const cc = this.cc;
            if (!cc.ImageAsset || !this.sprite)
                return;
            try {
                const image = new cc.ImageAsset(canvas);
                const texture = new cc.Texture2D();
                texture.image = image;
                const frame = new cc.SpriteFrame();
                frame.texture = texture;
                this.sprite.spriteFrame = frame;
                this.texture = texture;
                this.textureWidth = 0;
                this.textureHeight = 0;
            }
            catch (e) {
                // 贴不上去就放弃，避免影响游戏本身
            }
        }
        resize(canvas, size) {
            this.size = size;
            this.canvas = canvas;
            this.textureWidth = 0;
            this.textureHeight = 0;
            this.uiWidth = 0;
            this.uiHeight = 0;
            if (this.texture)
                this.applySize();
        }
        setBlocking(active) {
            this.blocking = active;
            if (this.blocker)
                this.blocker.enabled = active;
        }
        destroy() {
            this.destroyed = true;
            const cc = this.cc;
            const g = globalThis;
            if (this.timer !== null && typeof g.clearTimeout === 'function') {
                g.clearTimeout(this.timer);
                this.timer = null;
            }
            if (cc && cc.director && this.sceneHandler) {
                cc.director.off(cc.Director.EVENT_AFTER_SCENE_LAUNCH, this.sceneHandler);
            }
            if (this.node && this.node.isValid !== false && typeof this.node.destroy === 'function') {
                this.node.destroy();
            }
            this.sceneHandler = null;
            this.node = null;
            this.sprite = null;
            this.texture = null;
            this.transform = null;
            this.blocker = null;
            this.cc = null;
        }
    }
    /**
     * 创建上屏通道。
     * 返回 null 表示不需要：canvas 自己就是上屏画布（浏览器 / 非 Cocos 小游戏）。
     */
    function createPresenter(size) {
        const g = globalThis;
        const my = g.my;
        // 只有小游戏环境才可能出现"第一个 canvas 被引擎占用"的问题
        const isMiniGame = !!my && typeof my.createCanvas === 'function';
        const system = g.System;
        if (!isMiniGame || !system || typeof system.import !== 'function')
            return null;
        const presenter = new CocosPresenter(size);
        presenter.boot();
        return presenter;
    }

    /**
     * my.request 拦截 + 网络记录仓库。
     *
     * 只做「记录 + 原样转发」：不改请求参数、不吞回调异常、不影响返回值。
     * 每条请求在发起时先落一条 pending 记录（面板可实时看到进行中），
     * 拿到 success / fail 后再就地补全状态码、耗时、响应头和响应体。
     */
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
    function pad2(value) {
        return value < 10 ? '0' + value : String(value);
    }
    function timestamp() {
        const now = new Date();
        return pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
    }
    function truncate(text, limit) {
        if (text.length <= limit)
            return text;
        return text.slice(0, limit) + '\n…（已截断，共 ' + text.length + ' 字符）';
    }
    /** 把 url 里敏感参数的值替换成 ***，解析失败时原样返回 */
    function sanitizeUrl(url) {
        const index = url.indexOf('?');
        if (index < 0)
            return url;
        const head = url.slice(0, index);
        const params = url.slice(index + 1).split('&');
        for (let i = 0; i < params.length; i++) {
            const param = params[i];
            const eq = param.indexOf('=');
            if (eq < 0)
                continue;
            let name = param.slice(0, eq);
            try {
                name = decodeURIComponent(name);
            }
            catch (e) {
                // 非法编码就按原文匹配
            }
            if (SENSITIVE_KEY.test(name)) {
                params[i] = param.slice(0, eq + 1) + '***';
            }
        }
        return head + '?' + params.join('&');
    }
    /** 请求体 / 响应体：对象按两空格缩进展开，方便直接读 */
    function formatBody(value) {
        if (value === undefined || value === null)
            return '';
        if (typeof value === 'string')
            return truncate(value.replace(/\r\n/g, '\n'), DETAIL_LIMIT);
        // 序列化阶段就按预算裁剪，避免先落地一个完整的大字符串；
        // 超长的单个值就地省略，整体 JSON 结构保持完整
        try {
            const text = stringifyLimited(value, DETAIL_LIMIT, 2, {
                maxStringLength: BODY_STRING_LIMIT,
                maxArrayItems: BODY_ARRAY_ITEMS,
                maxKeys: BODY_MAX_KEYS,
                maxDepth: BODY_MAX_DEPTH,
            });
            if (text)
                return text;
        }
        catch (e) {
            // 落到下面的兜底
        }
        try {
            return formatArgs([value]);
        }
        catch (e) {
            return truncate(String(value), DETAIL_LIMIT);
        }
    }
    /** 请求头 / 响应头：一行一个，值过长截断，条数也有上限 */
    function formatHeaders(headers) {
        if (!headers || typeof headers !== 'object')
            return '';
        const keys = Object.keys(headers);
        if (!keys.length)
            return '';
        const lines = [];
        const count = Math.min(keys.length, MAX_HEADERS);
        for (let i = 0; i < count; i++) {
            const key = keys[i];
            lines.push(key + ': ' + truncate(String(headers[key]), HEADER_VALUE_LIMIT));
        }
        if (keys.length > count)
            lines.push('…（还有 ' + (keys.length - count) + ' 个头部未显示）');
        return lines.join('\n');
    }
    /** 网络记录仓库：先进先出，超出上限丢弃最旧的 */
    class NetStore {
        constructor(maxRecords) {
            this.items = [];
            this.listeners = [];
            this.seq = 0;
            /** 进行中的条数，实时刷新时每帧都要读，不能每次遍历 */
            this.pendingCount = 0;
            this.maxRecords = maxRecords;
        }
        /** 请求发出时调用，返回记录 id，成功后用 finish 补全 */
        start(input) {
            const record = {
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
                    if (dropped[i].status === 'pending')
                        this.pendingCount--;
                }
            }
            this.emit();
            return record.id;
        }
        finish(id, patch) {
            const record = this.find(id);
            if (!record)
                return;
            if (record.status === 'pending' && this.pendingCount > 0)
                this.pendingCount--;
            record.status = patch.status || record.status;
            if (patch.statusCode !== undefined)
                record.statusCode = patch.statusCode;
            record.cost = Date.now() - record.startedAt;
            if (patch.responseHeaders !== undefined)
                record.responseHeaders = patch.responseHeaders;
            if (patch.responseBody !== undefined)
                record.responseBody = patch.responseBody;
            if (patch.error !== undefined)
                record.error = patch.error;
            // 内容变了，旧的换行缓存必须失效
            record.wrapCache = undefined;
            this.emit();
        }
        list() {
            return this.items;
        }
        total() {
            return this.items.length;
        }
        pending() {
            return this.pendingCount;
        }
        clear() {
            if (!this.items.length)
                return;
            this.items = [];
            this.pendingCount = 0;
            this.emit();
        }
        /** 运行时调整上限，超出部分立即丢弃最旧的 */
        setMaxRecords(maxRecords) {
            if (!(maxRecords > 0))
                return;
            this.maxRecords = Math.floor(maxRecords);
            const overflow = this.items.length - this.maxRecords;
            if (overflow <= 0)
                return;
            const dropped = this.items.splice(0, overflow);
            for (let i = 0; i < dropped.length; i++) {
                if (dropped[i].status === 'pending' && this.pendingCount > 0)
                    this.pendingCount--;
            }
            this.emit();
        }
        onChange(listener) {
            this.listeners.push(listener);
            return () => {
                const index = this.listeners.indexOf(listener);
                if (index >= 0)
                    this.listeners.splice(index, 1);
            };
        }
        find(id) {
            for (let i = this.items.length - 1; i >= 0; i--) {
                if (this.items[i].id === id)
                    return this.items[i];
            }
            return null;
        }
        emit() {
            for (let i = 0; i < this.listeners.length; i++) {
                try {
                    this.listeners[i]();
                }
                catch (e) {
                    // 渲染异常不能反过来影响业务请求
                }
            }
        }
    }
    function setProperty(target, key, value) {
        try {
            target[key] = value;
            if (target[key] === value)
                return true;
        }
        catch (e) {
            // 有的运行时属性只读，接着尝试 defineProperty
        }
        try {
            Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
            return target[key] === value;
        }
        catch (e) {
            return false;
        }
    }
    function pickStatus(res) {
        const raw = res && (res.status !== undefined ? res.status : res.statusCode);
        const status = typeof raw === 'string' ? parseInt(raw, 10) : raw;
        return typeof status === 'number' && isFinite(status) ? status : 0;
    }
    /** 拦截 my.request，返回 restore；环境不支持时返回空实现 */
    function interceptNetwork(store, net) {
        const g = globalThis;
        const my = g && g.my;
        if (!my || typeof my.request !== 'function')
            return { restore() { } };
        const original = my.request;
        const patched = function patchedRequest(options) {
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
            }
            catch (e) {
                // 记录失败不能影响请求
            }
            // 复制一份再替换回调，绝不修改调用方传进来的对象
            const next = {};
            for (const key in opts) {
                if (Object.prototype.hasOwnProperty.call(opts, key))
                    next[key] = opts[key];
            }
            next.success = function onSuccess(res) {
                try {
                    const status = pickStatus(res);
                    net.finish(id, {
                        status: 'success',
                        statusCode: status,
                        responseHeaders: formatHeaders(res && res.headers),
                        responseBody: formatBody(res && res.data),
                    });
                }
                catch (e) {
                    // 记录失败不影响业务回调
                }
                if (typeof opts.success === 'function')
                    return opts.success.apply(source, arguments);
                return undefined;
            };
            next.fail = function onFail(err) {
                try {
                    const message = (err && (err.errorMessage || err.errMsg || err.message || err.error)) || 'request failed';
                    const code = err && (err.error !== undefined ? err.error : err.status);
                    net.finish(id, {
                        status: 'fail',
                        statusCode: pickStatus(err),
                        error: String(message) + (code !== undefined ? '（' + code + '）' : ''),
                    });
                }
                catch (e) {
                    // 同上
                }
                if (typeof opts.fail === 'function')
                    return opts.fail.apply(source, arguments);
                return undefined;
            };
            next.complete = function onComplete() {
                if (typeof opts.complete === 'function')
                    return opts.complete.apply(source, arguments);
                return undefined;
            };
            try {
                return original.call(g.my, next);
            }
            catch (e) {
                // 同步抛错也要把记录收尾，否则会永远停在“进行中”
                try {
                    net.finish(id, { status: 'fail', error: String(e) });
                }
                catch (e2) {
                    // ignore
                }
                throw e;
            }
        };
        if (!setProperty(my, 'request', patched)) {
            store.push('error', '[log-panel] my.request 不可写，网络日志未启用');
            return { restore() { } };
        }
        return {
            restore() {
                setProperty(my, 'request', original);
            },
        };
    }

    /**
     * 对外入口（UMD）。
     *
     * 脚本一加载就会自动开始工作，不需要手动调用 init：
     *   1. 立即拦截 console / my.request，把最早的日志全部缓存下来；
     *   2. 等宿主（如 Cocos 的 web-adapter）建好自己的上屏 canvas 之后，再创建离屏画布
     *      挂出可拖拽悬浮按钮，避免抢占“第一个 canvas 即上屏画布”的名额。
     *
     * 想手动控制：
     *   LogPanel.init({ maxLogs: 500 });                 // 可重复调用，用于补充配置
     *   LogPanel.setMaxLogs(200)                         // 运行时改条数上限
     *   LogPanel.addIgnoreKeywords(['xxx'])              // 追加排除词（命中不入库、不占上限）
     *   LogPanel.setIncludeKeywords(['yyy'])             // 只保留含 yyy 的日志（同样不占上限）
     *   LogPanel.show() / hide() / toggle() / clear() / destroy()
     * 想关掉自动初始化，请在加载本文件之前设置：
     *   globalThis.__LOG_PANEL_AUTO_INIT__ = false
     */
    /** 等待宿主上屏 canvas 的最长时间：超过就认为没有引擎占位，自己直接建 canvas */
    const HOST_WAIT_TIMEOUT = 1000;
    const HOST_POLL_INTERVAL = 50;
    /** 面板画布默认的像素比上限，见 LogPanelOptions.maxPixelRatio */
    const DEFAULT_MAX_PIXEL_RATIO = 2;
    /** 构建时由 rollup 从 package.json 注入，运行时可以通过 LogPanel.version 读到 */
    const VERSION = '1.0.0';
    let store = null;
    let netStore = null;
    let view = null;
    let presenter = null;
    let consolePatch = null;
    let networkPatch = null;
    let unbindTouch = null;
    let unbindResize = null;
    let offStoreChange = null;
    let offNetChange = null;
    let started = false;
    let attachTimer = null;
    let pendingOptions = {};
    function mergeOptions(target, source) {
        const merged = Object.assign({}, target);
        const keys = Object.keys(source);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (source[key] !== undefined)
                merged[key] = source[key];
        }
        return merged;
    }
    /** 宿主已经建好的上屏 canvas（Cocos 的 web-adapter 会挂在 window/GameGlobal 上） */
    function hostCanvas() {
        const g = globalThis;
        return g.canvas || (g.window && g.window.canvas) || (g.GameGlobal && g.GameGlobal.canvas) || null;
    }
    /**
     * 立即开始拦截，但不碰 canvas。
     * 这样 game.js 最开头加载本文件时，引擎初始化、SDK、资源加载的日志都能抓到。
     */
    function startIntercept() {
        if (started)
            return;
        started = true;
        const opts = pendingOptions;
        const logs = new LogStore(opts.maxLogs && opts.maxLogs > 0 ? opts.maxLogs : 300);
        const net = new NetStore(opts.maxNetRecords && opts.maxNetRecords > 0 ? opts.maxNetRecords : 100);
        if (opts.ignoreKeywords && opts.ignoreKeywords.length)
            logs.addIgnoreKeywords(opts.ignoreKeywords);
        if (opts.includeKeywords && opts.includeKeywords.length)
            logs.addIncludeKeywords(opts.includeKeywords);
        store = logs;
        netStore = net;
        if (opts.intercept !== false) {
            consolePatch = interceptConsole(logs);
        }
        if (opts.interceptNetwork !== false) {
            networkPatch = interceptNetwork(logs, net);
        }
    }
    function clearAttachTimer() {
        const g = globalThis;
        if (attachTimer !== null) {
            if (typeof g.clearTimeout === 'function')
                g.clearTimeout(attachTimer);
            attachTimer = null;
        }
    }
    /** 真正创建画布、挂出按钮。之前缓存的日志会在首帧一次性画出来 */
    function attachView() {
        clearAttachTimer();
        if (view || !store || !netStore)
            return;
        const logs = store;
        const net = netStore;
        const opts = pendingOptions;
        const canvas = opts.canvas || createOverlayCanvas();
        if (!canvas) {
            logs.push('error', '[log-panel] 创建 canvas 失败，无法显示日志面板');
            return;
        }
        const size = getScreenSize(opts.maxPixelRatio === undefined ? DEFAULT_MAX_PIXEL_RATIO : opts.maxPixelRatio);
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
        });
        view = panelView;
        if (!panelView.ready) {
            logs.push('error', '[log-panel] canvas 取不到 2d 上下文（可能已被游戏引擎作为 WebGL 使用），请通过 init({ canvas }) 传入独立 canvas');
            return;
        }
        if (screen)
            screen.onReady = () => panelView.invalidate();
        offStoreChange = logs.onChange(() => panelView.addLog());
        offNetChange = net.onChange(() => panelView.addLog());
        unbindTouch = bindTouch(canvas, (x, y, phase) => panelView.handleTouch(x, y, phase));
        unbindResize = bindResize(() => {
            const next = getScreenSize(opts.maxPixelRatio === undefined ? DEFAULT_MAX_PIXEL_RATIO : opts.maxPixelRatio);
            if (screen)
                screen.resize(canvas, next);
            panelView.resize(next);
        });
        panelView.render();
        if (opts.open)
            panelView.show();
    }
    /**
     * 决定什么时候可以安全地建 canvas：
     * - 浏览器 / 有 DOM：直接建，不会跟引擎抢
     * - 小游戏：先等一个宏任务，看宿主（Cocos 的 web-adapter 等）有没有先把上屏 canvas 建好；
     *   有就马上挂载，没有且也没有适配层痕迹，就当作纯小游戏自己建
     */
    function scheduleAttach() {
        if (attachTimer !== null || view)
            return;
        if (pendingOptions.canvas) {
            attachView();
            return;
        }
        const my = getMyApi();
        if (!my || typeof my.createCanvas !== 'function') {
            attachView();
            return;
        }
        const g = globalThis;
        const begin = Date.now();
        let firstTick = true;
        const tick = () => {
            attachTimer = null;
            if (view)
                return;
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
            if (attachTimer === null)
                attachView();
        };
        attachTimer = typeof g.setTimeout === 'function' ? g.setTimeout(tick, 0) : null;
        if (attachTimer === null)
            attachView();
    }
    function init(options) {
        const opts = options || {};
        pendingOptions = mergeOptions(pendingOptions, opts);
        if (!started) {
            startIntercept();
        }
        else if (store) {
            // 已经自动初始化过，这里只补充配置
            if (opts.maxLogs && opts.maxLogs > 0)
                store.setMaxLogs(opts.maxLogs);
            if (opts.maxNetRecords && opts.maxNetRecords > 0 && netStore)
                netStore.setMaxRecords(opts.maxNetRecords);
            if (opts.ignoreKeywords && opts.ignoreKeywords.length)
                store.addIgnoreKeywords(opts.ignoreKeywords);
            if (opts.includeKeywords && opts.includeKeywords.length)
                store.addIncludeKeywords(opts.includeKeywords);
        }
        if (view) {
            if (opts.open)
                view.show();
            return api;
        }
        // 显式给了 canvas 就不用等宿主
        if (opts.canvas)
            attachView();
        else
            scheduleAttach();
        return api;
    }
    function destroy() {
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
        started = false;
    }
    const api = {
        version: VERSION,
        init,
        show() {
            if (view)
                view.show();
        },
        hide() {
            if (view)
                view.hide();
        },
        toggle() {
            if (view)
                view.toggle();
        },
        clear() {
            if (store)
                store.clear();
            if (netStore)
                netStore.clear();
        },
        isOpen() {
            return !!view && view.isOpen();
        },
        net() {
            return netStore ? netStore.list().slice() : [];
        },
        setMaxLogs(maxLogs) {
            if (store)
                store.setMaxLogs(maxLogs);
        },
        setMaxNetRecords(maxRecords) {
            if (netStore)
                netStore.setMaxRecords(maxRecords);
        },
        addIgnoreKeywords(words) {
            if (store)
                store.addIgnoreKeywords(words || []);
        },
        setIgnoreKeywords(words) {
            if (store)
                store.setIgnoreKeywords(words || []);
        },
        ignoreKeywords() {
            return store ? store.ignoreKeywords() : [];
        },
        addIncludeKeywords(words) {
            if (store)
                store.addIncludeKeywords(words || []);
        },
        setIncludeKeywords(words) {
            if (store)
                store.setIncludeKeywords(words || []);
        },
        includeKeywords() {
            return store ? store.includeKeywords() : [];
        },
        destroy,
    };
    // 无论宿主用 require 还是直接加载，都保证能通过 globalThis.LogPanel 访问
    const globalScope = typeof globalThis !== 'undefined' ? globalThis : undefined;
    // 同一份脚本可能被加载两次（game.js 里手动 require + 引擎插件列表各加载一次），
    // 这时直接复用第一份实例，避免 console 被重复包装导致日志翻倍
    const existing = globalScope && globalScope.__LOG_PANEL_API__ ? globalScope.__LOG_PANEL_API__ : null;
    if (globalScope && !existing) {
        globalScope.__LOG_PANEL_API__ = api;
        globalScope.LogPanel = api;
    }
    // 默认自动初始化：加载即开始拦截，UI 等宿主就绪后再挂载
    if (!existing && globalScope && globalScope.__LOG_PANEL_AUTO_INIT__ !== false) {
        try {
            init();
        }
        catch (e) {
            // 自动初始化失败不能影响游戏启动
        }
    }
    var index = existing || api;

    return index;

}));
