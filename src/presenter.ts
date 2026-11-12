/**
 * 上屏通道。
 *
 * 支付宝小游戏只允许第一个 canvas 上屏，而 Cocos 的 web-adapter 加载时就把这个
 * canvas 交给了 WebGL 渲染器。所以 my.createCanvas() 拿到的必然是离屏画布：
 * 2D 绘正常但永远不显示。
 *
 * 解决办法是把离屏 2D 画布当作纹理，通过 Cocos 场景里的一个全屏 Sprite 贴上去。
 * Cocos 3.x 构建产物里 cc 不挂全局，只能 System.import('cc') 异步获取。
 */
import type { ScreenSize } from './env';

const MAX_BOOT_RETRIES = 120;
const BOOT_RETRY_INTERVAL = 100;

export interface Presenter {
  /** 把离屏 2D 画布内容贴到屏幕上 */
  present(canvas: any): void;
  resize(canvas: any, size: ScreenSize): void;
  /** 面板打开时挡住触摸，避免点击穿透到游戏 UI */
  setBlocking(active: boolean): void;
  destroy(): void;
  /** Cocos 通道就绪后回调，用于触发一次重绘 */
  onReady?: () => void;
}

class CocosPresenter implements Presenter {
  onReady?: () => void;

  private cc: any = null;
  private node: any = null;
  private sprite: any = null;
  private texture: any = null;
  private transform: any = null;
  private blocker: any = null;
  private sceneHandler: any = null;

  private size: ScreenSize;
  private canvas: any = null;
  private blocking = false;
  private textureWidth = 0;
  private textureHeight = 0;
  /** 上一次设置的 UI 尺寸，没变就不重复 setContentSize（会触发 UI 重算） */
  private uiWidth = 0;
  private uiHeight = 0;
  private booting = false;
  private destroyed = false;
  private retries = 0;
  private timer: any = null;

  constructor(size: ScreenSize) {
    this.size = size;
  }

  /** 异步拿 cc 并建节点；拿不到就静默退出，保持原来的直接上屏行为 */
  boot(): void {
    if (this.booting || this.cc || this.destroyed) return;
    const g: any = globalThis as any;
    const system = g.System;
    if (!system || typeof system.import !== 'function') {
      // 脚本可能被很早加载（引擎还没起来），隔一会儿再试
      this.scheduleRetry();
      return;
    }

    this.booting = true;
    system
      .import('cc')
      .then((mod: any) => {
        this.booting = false;
        if (this.destroyed) return;
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
        if (this.onReady) this.onReady();
      })
      .catch(() => {
        // 引擎还没加载完时 import 可能失败，继续重试
        this.booting = false;
        this.scheduleRetry();
      });
  }

  private scheduleRetry(): void {
    if (this.retries >= MAX_BOOT_RETRIES || this.destroyed) return;
    const g: any = globalThis as any;
    if (typeof g.setTimeout !== 'function') return;
    this.retries++;
    this.timer = g.setTimeout(() => {
      this.timer = null;
      this.boot();
    }, BOOT_RETRY_INTERVAL);
  }

  /** 切换场景会销毁节点，需要重建 */
  private watchScene(): void {
    const cc = this.cc;
    if (!cc.director || !cc.Director) return;
    const event = cc.Director.EVENT_AFTER_SCENE_LAUNCH;
    this.sceneHandler = () => this.rebuild();
    cc.director.on(event, this.sceneHandler);
  }

  private rebuild(): void {
    if (this.node && this.node.isValid !== false) return;
    this.node = null;
    this.createNodes();
    if (this.canvas) this.present(this.canvas);
  }

  private createNodes(): void {
    const cc = this.cc;
    const scene = cc.director && cc.director.getScene ? cc.director.getScene() : null;
    if (!scene) return;

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
    if (cc.Sprite.SizeMode) this.sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    if (cc.Sprite.Type) this.sprite.type = cc.Sprite.Type.SIMPLE;

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

  private applySize(): void {
    const cc = this.cc;
    if (!this.texture || !this.transform) return;

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
        if (cc.Rect) frame.rect = new cc.Rect(0, 0, width, height);
        this.sprite.spriteFrame = frame;
      }
    }

    // Cocos 的 UI 坐标是设计分辨率，不是屏幕逻辑像素
    const visible = cc.view && typeof cc.view.getVisibleSize === 'function' ? cc.view.getVisibleSize() : null;
    const uiWidth = visible && visible.width ? visible.width : this.size.width;
    const uiHeight = visible && visible.height ? visible.height : this.size.height;
    // 每帧都设一遍会一直把 UI 标脏、反复重算顶点，没变化就跳过
    if (uiWidth === this.uiWidth && uiHeight === this.uiHeight) return;
    this.uiWidth = uiWidth;
    this.uiHeight = uiHeight;
    this.transform.setContentSize(uiWidth, uiHeight);
    if (typeof this.node.setPosition === 'function') this.node.setPosition(0, 0, 0);
  }

  present(canvas: any): void {
    this.canvas = canvas;
    if (!this.cc || !this.texture) return;
    if (this.node && this.node.isValid === false) this.node = null;
    if (!this.node) this.createNodes();
    if (!this.texture) return;

    this.applySize();
    try {
      this.texture.uploadData(canvas, 0);
    } catch (e) {
      // 某些版本 uploadData 对 canvas 有限制，退回到 ImageAsset 重建纹理
      this.uploadViaImageAsset(canvas);
    }
  }

  private uploadViaImageAsset(canvas: any): void {
    const cc = this.cc;
    if (!cc.ImageAsset || !this.sprite) return;
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
    } catch (e) {
      // 贴不上去就放弃，避免影响游戏本身
    }
  }

  resize(canvas: any, size: ScreenSize): void {
    this.size = size;
    this.canvas = canvas;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.uiWidth = 0;
    this.uiHeight = 0;
    if (this.texture) this.applySize();
  }

  setBlocking(active: boolean): void {
    this.blocking = active;
    if (this.blocker) this.blocker.enabled = active;
  }

  destroy(): void {
    this.destroyed = true;
    const cc = this.cc;
    const g: any = globalThis as any;
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
export function createPresenter(size: ScreenSize): Presenter | null {
  const g: any = globalThis as any;
  const my = g.my;
  // 只有小游戏环境才可能出现"第一个 canvas 被引擎占用"的问题
  const isMiniGame = !!my && typeof my.createCanvas === 'function';
  const system = g.System;

  if (!isMiniGame || !system || typeof system.import !== 'function') return null;

  const presenter = new CocosPresenter(size);
  presenter.boot();
  return presenter;
}
