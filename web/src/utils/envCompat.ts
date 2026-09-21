/**
 * 环境兼容垫片（无头 / 嵌入式 Chromium 观察下发现的两个问题）：
 *
 * 1. HTMLImageElement.decode() 永不 settle：
 *    onload 正常触发、img.complete=true，但 decode() 的 Promise 挂起。
 *    Excalibur Loader.onBeforeLoad 依赖 decode() 加载 loading 层 logo，
 *    会卡死 engine.start()，/play 整页停在「正在启动」。
 *    → 包一层兜底：图片已 complete 即视为可绘制；原生 decode 正常时行为不变。
 *
 * 2. 窗口未聚焦 / 被遮挡时 requestAnimationFrame 完全停发：
 *    Excalibur 的游戏时钟靠 rAF 驱动，rAF 停摆 → 时钟冻结 →
 *    Loader 的 delay(…, clock) 永不 resolve，装载流程卡死，游戏画面静止。
 *    → 看门狗：装载前探测 500ms，rAF 一帧未跑则切换 setTimeout(≈60fps) 回退。
 *      原生 rAF 正常的环境（真实用户桌面）不会触发回退，行为不变。
 */

interface DecodeShimFlag {
  __imgDecodeShim?: boolean
}

export function installImageDecodeShim(): void {
  if (
    typeof HTMLImageElement === 'undefined' ||
    (HTMLImageElement.prototype as unknown as DecodeShimFlag).__imgDecodeShim
  ) {
    return
  }
  const nativeDecode = HTMLImageElement.prototype.decode
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        nativeDecode.call(this).then(settle, (err: unknown) => {
          if (settled) return
          settled = true
          reject(err)
        })
      } catch (err) {
        settled = true
        reject(err)
        return
      }
      if (this.complete) {
        settle()
        return
      }
      this.addEventListener('load', settle, { once: true })
      window.setTimeout(settle, 1500)
    })
  }
  ;(HTMLImageElement.prototype as unknown as DecodeShimFlag).__imgDecodeShim = true
}

/**
 * 混合 rAF：原生 requestAnimationFrame 优先，同一帧挂一个 ≈60fps 的定时器兜底。
 *
 * 背景：窗口未聚焦 / 被遮挡的嵌入式 Chromium 会完全停发 rAF（visibility 仍为
 * visible），而 Excalibur 的游戏时钟完全由 rAF 驱动——rAF 停摆 → 时钟冻结 →
 * Loader 的 delay(…, clock) 永不 resolve，装载流程卡死，游戏画面静止。
 *
 * 实现：每次调度同时登记原生 rAF 与一个一次性定时器，先到者执行、后到者忽略。
 * - 真实桌面（rAF 正常）：帧由原生 rAF 驱动，定时器全部空转，行为不变；
 * - rAF 停发环境：帧由定时器驱动（≈60fps），引擎与装载流程照常推进。
 * cancelAnimationFrame 只能取消原生半边，兜底回调最多再空跑一帧
 * （Clock mainloop 首行检查 _running，安全）。
 */
export function installHybridRaf(): void {
  if (typeof window === 'undefined') return
  if ((window as unknown as { __hybridRaf?: boolean }).__hybridRaf) return
  ;(window as unknown as { __hybridRaf?: boolean }).__hybridRaf = true
  const native = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    let fired = false
    const once = (ts: number): void => {
      if (fired) return
      fired = true
      cb(ts)
    }
    const nativeId = native((ts) => once(ts))
    window.setTimeout(() => once(performance.now()), 1000 / 60)
    return nativeId
  }) as typeof window.requestAnimationFrame
}
