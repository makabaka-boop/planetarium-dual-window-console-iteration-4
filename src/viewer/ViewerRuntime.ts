/**
 * 观众窗运行时：协议状态机 + BroadcastChannel + IndexedDB 取图 + Canvas 呈现。
 * 画面只允许从两个来源产生：
 *   1. 恢复完成时控制台快照里的 confirmed；
 *   2. live 期间被接受（严格相邻序号）的命令。
 *
 * 所有取 Blob / 解码都是异步的。为保证“任一时刻只有当前有效画面能够提交”，
 * 运行时维护单调递增的代次 epoch：
 *   - 新快照、新命令、SESSION_ENDED 都会让旧代次作废；
 *   - 任何异步绘制在真正落到 Canvas 前必须仍是当前代次，否则一律丢弃
 *     （旧快照、窗口缩放触发的旧帧重绘、失败后的旧回退绘制、停映前的迟到
 *     结果都不得再改动画布）。
 * 状态机内的 inFlight 再提供一层同序号/同目标校验，双重防线。
 */
import { MessageBus } from '../bus';
import { StorageError, getBlob, loadFrozen } from '../db';
import { decodeBlob, drawCover } from '../image';
import {
  AbortMessage,
  CommandMessage,
  ConfirmMode,
  ConfirmedMessage,
  ScreenRole,
  ShowMessage,
  SnapshotResponse,
  WireMessage
} from '../protocol/types';
import {
  RenderTarget,
  ViewerState,
  applySnapshot,
  beginRecovery,
  initViewer,
  receiveCommand,
  receiveWire,
  resolveRender
} from '../protocol/viewer';
import {
  AbortResult,
  DualViewerState,
  applyDualSnapshot,
  beginDualRecovery,
  endDual,
  initDualViewer,
  receiveAbort,
  receiveConfirmed,
  receivePrepareCommand,
  receiveShow,
  replayShown,
  resolvePrepare,
  resolveShow
} from '../protocol/dual-viewer';

function makeViewerId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `viewer_${rand}`;
}

/** 从 URL ?role=main|backup 读取双屏角色；缺省为主屏（单屏路径不使用该值）。 */
function roleFromUrl(): ScreenRole {
  try {
    const r = new URL(window.location.href).searchParams.get('role');
    if (r === 'backup') return 'backup';
  } catch {
    /* ignore */
  }
  return 'main';
}

export type DualStageView =
  | 'idle'
  | 'preparing'
  | 'prepared'
  | 'showing'
  | 'displayed'
  | 'failed-prepare';

export type PresentStatus =
  | { phase: 'standby' }
  | { phase: 'recovering' }
  | {
      phase: 'live';
      page: number;
      total: number;
      blackout: boolean;
      seq: number;
      imageError: boolean;
    }
  | { phase: 'ended' }
  | {
      phase: 'dual-live';
      role: ScreenRole;
      /** 穹顶当前实际显示的页/遮黑（可能是未确认的目标画面）。 */
      page: number;
      blackout: boolean;
      total: number;
      /** 权威（已确认）页与序号。 */
      confirmedPage: number;
      confirmedSeq: number;
      confirmedBlackout: boolean;
      /** 本次切换所处阶段；UI 据此区分 准备中/部分显示/已确认。 */
      stage: DualStageView;
      pendingSeq: number | null;
      imageError: boolean;
    };

export class ViewerRuntime {
  private bus: MessageBus;
  private state: ViewerState;
  /** 双屏确认模式下的协议状态；mode==='dual' 快照恢复后非空，与 state 二选一。 */
  private dual: DualViewerState | null = null;
  private mode: ConfirmMode = 'single';
  private readonly role: ScreenRole;
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<number, HTMLImageElement>();
  private blobIdByPage: string[] = [];
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private resizeHandler: (() => void) | null = null;
  private total = 0;
  /** 当前呈现失败标记（imageError），用于 UI 提示，画面仍停留在最后成功页。 */
  private imageError = false;
  /**
   * 画面代次：每次“有效画面来源切换”（快照恢复、接受新命令、停映）递增。
   * 异步绘制提交时比对，代次不符的迟到结果既不画 Canvas，也不推进状态/确认。
   */
  private epoch = 0;

  constructor(canvas: HTMLCanvasElement, bus?: MessageBus) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.bus = bus ?? new MessageBus();
    this.role = roleFromUrl();
    this.state = initViewer(makeViewerId());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  getStatus(): PresentStatus {
    if (this.mode === 'dual' && this.dual) {
      const d = this.dual;
      switch (d.phase) {
        case 'standby':
          return { phase: 'standby' };
        case 'recovering':
          return { phase: 'recovering' };
        case 'ended':
          return { phase: 'ended' };
        case 'live':
          return {
            phase: 'dual-live',
            role: d.role,
            page: d.display?.page ?? 0,
            blackout: d.display?.blackout ?? false,
            total: this.total,
            confirmedPage: d.frame?.page ?? 0,
            confirmedSeq: d.frame?.seq ?? 0,
            confirmedBlackout: d.frame?.blackout ?? false,
            stage: d.stage === 'idle' ? 'idle' : d.stage,
            pendingSeq: d.pending?.target.seq ?? null,
            imageError: this.imageError
          };
      }
    }
    switch (this.state.phase) {
      case 'standby':
        return { phase: 'standby' };
      case 'recovering':
        return { phase: 'recovering' };
      case 'ended':
        return { phase: 'ended' };
      case 'live':
        return {
          phase: 'live',
          page: this.state.frame?.page ?? 0,
          total: this.total,
          blackout: this.state.frame?.blackout ?? false,
          seq: this.state.frame?.seq ?? 0,
          imageError: this.imageError
        };
    }
  }

  start() {
    // React StrictMode 开发双挂载：dispose 关闭了总线，第二次挂载需重建。
    if (this.bus.closed) this.bus = new MessageBus();
    this.unsubscribe = this.bus.subscribe((m) => this.onMessage(m));
    this.state = beginRecovery(this.state);
    this.dual = beginDualRecovery(initDualViewer(this.state.viewerId, this.role));
    // 恢复即新代次：上一代残留的异步绘制（若有）一律作废。
    this.epoch++;
    this.emit();
    this.requestSnapshot();
    // 重开后主动取得快照；控制台缺席时持续轮询，直到拿到运行中会话的快照。
    this.poll = setInterval(() => {
      if (this.isAwaitingSnapshot()) {
        this.requestSnapshot();
      }
    }, 1000);
    // 缩放只重绘“当前有效帧”；重绘本身携带代次，过期窗口/停映后的迟到重绘无效。
    this.resizeHandler = () => this.repaintCurrent(this.epoch);
    window.addEventListener('resize', this.resizeHandler);
  }

  private isAwaitingSnapshot(): boolean {
    return this.mode === 'dual'
      ? this.dual?.phase === 'recovering' || this.dual?.phase === 'standby'
      : this.state.phase === 'recovering' || this.state.phase === 'standby';
  }

  dispose() {
    this.unsubscribe?.();
    if (this.poll) clearInterval(this.poll);
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    this.bus.close();
  }

  private requestSnapshot() {
    this.bus.post({
      kind: 'SNAPSHOT_REQ',
      viewerId: this.state.viewerId,
      role: this.role
    });
  }

  private onMessage(msg: WireMessage) {
    // 双屏路径与单屏路径在快照恢复确定 mode 后完全分流。
    if (this.mode === 'dual') {
      this.onDualMessage(msg);
      return;
    }
    switch (msg.kind) {
      case 'SNAPSHOT_RES':
        void this.handleSnapshot(msg);
        break;
      case 'CMD':
        void this.handleCommand(msg);
        break;
      case 'SESSION_ENDED': {
        const prev = this.state.phase;
        this.state = receiveWire(this.state, msg);
        if (prev !== this.state.phase) {
          // 旧代次的一切异步绘制立即作废；持续黑屏，迟到图片不得再出现。
          this.epoch++;
          this.cache.clear();
          this.blobIdByPage = [];
          this.imageError = false;
          this.paintBlack();
          this.emit();
        }
        break;
      }
      default:
        break;
    }
  }

  private onDualMessage(msg: WireMessage) {
    const d = this.dual;
    if (!d) return;
    switch (msg.kind) {
      case 'SNAPSHOT_RES':
        void this.handleDualSnapshot(msg);
        break;
      case 'CMD':
        if (msg.phase === 'prepare') void this.handlePrepare(msg);
        break;
      case 'SHOW':
        void this.handleShow(msg);
        break;
      case 'ABORT':
        this.handleAbort(msg);
        break;
      case 'CONFIRMED':
        this.handleConfirmed(msg);
        break;
      case 'SESSION_ENDED': {
        const prev = d.phase;
        this.dual = endDual(d, msg.sessionId);
        if (prev !== this.dual.phase) {
          this.epoch++;
          this.cache.clear();
          this.blobIdByPage = [];
          this.imageError = false;
          this.paintBlack();
          this.emit();
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleSnapshot(res: SnapshotResponse) {
    if (res.viewerId !== this.state.viewerId) return;
    if (this.state.phase !== 'recovering') return;
    if (!res.running) return; // 保持待命，继续轮询

    // 双屏确认模式的会话：切到 dual 协议路径恢复（状态互不混淆）。
    if (res.mode === 'dual') {
      await this.handleDualSnapshot(res);
      return;
    }

    // 节目单顺序在冻结时已随会话写入 IndexedDB；消息通道只传权威画面。
    const program =
      (await loadFrozen(res.sessionId).catch(() => null)) ??
      (await loadFrozen('latest').catch(() => null));
    const ids = program?.items.map((i) => i.blobId) ?? [];
    if (ids.length === 0) {
      // 本地存储缺失（如用户清了站点数据）：无法恢复，继续保持恢复态并重试。
      return;
    }
    // 快照可能晚到：await 期间若已被别的快照/停映取代，旧快照整个作废。
    // start()/beginRecovery 已为本代次预留了 epoch；快照沿用它，之后的命令才 +1。
    const gen = this.epoch;
    if (this.state.phase !== 'recovering') return;
    this.mode = 'single';
    this.total = ids.length;
    this.blobIdByPage = ids;
    this.state = applySnapshot(this.state, res);
    this.epoch = gen; // 占用本代次；之后第一条命令 ++epoch 进入下一代
    this.imageError = false;
    // 测试钩子：在“快照已切 live、首帧绘制提交前”插入一个可控异步门，
    // 用于确定性地复现“恢复刚完成、图片仍在解码时连续切页/遮黑/停映”。
    await this.testGate('snapshotLive');
    await this.paintConfirmed(gen);
    this.emit();
  }

  /** 双屏模式快照恢复：窗口（重）载后先同步最后确认状态，画面直接画权威帧。 */
  private async handleDualSnapshot(res: SnapshotResponse) {
    const d0 = this.dual;
    if (!d0 || res.viewerId !== d0.viewerId) return;
    if (d0.phase !== 'recovering') return;
    if (!res.running) return;

    const program =
      (await loadFrozen(res.sessionId).catch(() => null)) ??
      (await loadFrozen('latest').catch(() => null));
    const ids = program?.items.map((i) => i.blobId) ?? [];
    if (ids.length === 0) return;

    const gen = this.epoch;
    if (!this.dual || this.dual.phase !== 'recovering') return;
    this.mode = 'dual';
    this.total = ids.length;
    this.blobIdByPage = ids;
    this.dual = applyDualSnapshot(this.dual, res);
    this.epoch = gen;
    this.imageError = false;
    await this.testGate('snapshotLive');
    await this.paintDualConfirmed(gen);
    this.emit();
  }

  /**
   * 仅测试用钩子：window.__domeTestHooks.gates[point] 存在时，在此处等待其 promise。
   * 生产环境不存在该对象，零开销。用于把“状态已切换、绘制尚未提交”的瞬间显式撑开。
   */
  private async testGate(
    point: 'snapshotLive' | 'beforePresent' | 'afterError'
  ): Promise<void> {
    type Hooks = { gates?: Record<string, { promise: Promise<void> } | undefined> };
    const hooks = (window as unknown as { __domeTestHooks?: Hooks }).__domeTestHooks;
    const gate = hooks?.gates?.[point];
    if (gate) await gate.promise;
  }

  private async handleCommand(msg: CommandMessage) {
    // 恢复期间旧命令、其它会话消息在状态机内统一无效；这里再加一道保险。
    if (this.state.phase === 'recovering') return;
    const accept = receiveCommand(this.state, msg);
    this.state = accept.state;
    if (accept.resendAck) {
      // 重复命令：画面不动，只重放 ACK（控制台超时重试的常见收敛路径）。
      this.bus.post(accept.resendAck);
      return;
    }
    if (!accept.render) return;
    const gen = ++this.epoch;
    await this.testGate('beforePresent');
    // 门等待期间可能已被新快照/停映取代：过期呈现直接丢弃。
    if (gen !== this.epoch || this.state.inFlight?.seq !== accept.render.seq) return;
    await this.present(accept.render, gen);
  }

  /** 呈现一帧：取 Blob -> 解码 -> 绘制；任何一步后都校验代次，过期结果直接丢弃。 */
  private async present(target: RenderTarget, gen: number) {
    try {
      if (target.blackout) {
        if (!this.commitAllowed(gen, target)) return;
        this.paintBlack();
      } else {
        const img = await this.loadImage(target.page);
        if (!this.commitAllowed(gen, target)) return; // 解码期间已切页/遮黑/停映
        this.drawImage(img);
      }
      if (!this.commitAllowed(gen, target)) return;
      const resolved = resolveRender(this.state, target, true);
      if (!resolved) return;
      this.state = resolved.state;
      this.imageError = false;
      this.bus.post(resolved.ack);
      this.emit();
    } catch (err) {
      console.error('present failed', err);
      if (!this.commitAllowed(gen, target)) return; // 失败结果本身也可能已过期
      // 测试钩子：坏图 error 之后、回退绘制之前撑开（复现“回退异步绘制晚于
      // 下一条同序号替代命令/停映”的真实解码窗口）。生产无钩子、零开销。
      await this.testGate('afterError');
      if (!this.commitAllowed(gen, target)) return;
      // 回退画面：重绘最后成功帧（可能本身是遮黑），同样受代次保护。
      await this.repaintLastSuccess(gen);
      if (!this.commitAllowed(gen, target)) return;
      const resolved = resolveRender(this.state, target, false);
      if (!resolved) return;
      this.state = resolved.state;
      this.imageError = true;
      this.bus.post(resolved.ack);
      this.emit();
    }
  }

  /**
   * 一次绘制提交是否仍有效：代次未推进、仍在 live、且该呈现仍是当前未决目标
   * （序号 + 页码 + 遮黑完全一致）。保证旧快照、旧缩放、旧失败回退、停映前的
   * 迟到结果都不能提交。
   */
  private commitAllowed(gen: number, target?: RenderTarget): boolean {
    if (gen !== this.epoch) return false;
    if (this.state.phase !== 'live') return false;
    if (target) {
      const inFlight = this.state.inFlight;
      if (
        !inFlight ||
        inFlight.seq !== target.seq ||
        inFlight.page !== target.page ||
        inFlight.blackout !== target.blackout
      ) {
        return false;
      }
    }
    return true;
  }

  // ---- 双屏确认模式：prepare / show / abort / confirmed -------------------

  private dualStill(gen: number): boolean {
    return gen === this.epoch && this.mode === 'dual' && this.dual?.phase === 'live';
  }

  /** 装载阶段：只预解码目标资源（黑屏/遮黑无需取图），绝不切换画面。 */
  private async handlePrepare(msg: CommandMessage) {
    const d0 = this.dual;
    if (!d0 || d0.phase !== 'live') return;
    const accept = receivePrepareCommand(d0, msg);
    this.dual = accept.state;
    const target = accept.preload;
    if (!target) return;
    // 已进入装载阶段：立即让界面反映“准备中”（屏幕画面此刻仍停在权威帧）。
    this.emit();
    const attempt = msg.attempt!;
    const gen = ++this.epoch;
    await this.testGate('beforePresent');
    if (!this.dualStill(gen)) return;
    if (!this.dual.pending || this.dual.pending.attempt !== attempt) return;
    try {
      if (!target.blackout) {
        // 预装载：解码后进入缓存即完成，画面保持权威帧不动。
        await this.loadImage(target.page);
      }
      if (!this.dualStill(gen)) return;
      const resolved = resolvePrepare(this.dual, target, attempt, true);
      if (!resolved) return;
      this.dual = resolved.state;
      this.imageError = false;
      this.bus.post(resolved.ack);
      this.emit();
    } catch (err) {
      console.error('dual prepare failed', err);
      if (!this.dualStill(gen)) return;
      await this.testGate('afterError');
      if (!this.dualStill(gen)) return;
      const resolved = resolvePrepare(this.dual, target, attempt, false);
      if (!resolved) return;
      this.dual = resolved.state;
      this.imageError = true;
      this.bus.post(resolved.ack);
      this.emit();
    }
  }

  /** 显示阶段：两侧准备齐备后控制台才下发；真正切换穹顶画面。 */
  private async handleShow(msg: ShowMessage) {
    const d0 = this.dual;
    if (!d0 || d0.phase !== 'live') return;
    const accept = receiveShow(d0, msg);
    // 已显示状态收到重复 SHOW：画面不动，重放 SHOWN（幂等收敛）。
    if (accept.render === null && accept.state.stage === 'displayed') {
      const replay = replayShown(accept.state);
      if (replay) this.bus.post(replay);
      return;
    }
    this.dual = accept.state;
    const target = accept.render;
    if (!target) return;
    this.emit(); // 界面进入“切换中”
    const attempt = msg.attempt;
    const gen = ++this.epoch;
    await this.testGate('beforePresent');
    if (!this.dualStill(gen)) return;
    try {
      if (target.blackout) {
        this.paintBlack();
      } else {
        const img = await this.loadImage(target.page);
        if (!this.dualStill(gen)) return;
        this.drawImage(img);
      }
      if (!this.dualStill(gen)) return;
      const resolved = resolveShow(this.dual, target, attempt, true);
      if (!resolved) return;
      this.dual = resolved.state;
      this.imageError = false;
      this.bus.post(resolved.ack);
      this.emit();
    } catch (err) {
      console.error('dual show failed', err);
      if (!this.dualStill(gen)) return;
      await this.testGate('afterError');
      if (!this.dualStill(gen)) return;
      // 显示失败：状态机已把画面回退到最后确认帧，这里补绘回退帧。
      const resolved = resolveShow(this.dual, target, attempt, false);
      if (!resolved) return;
      this.dual = resolved.state;
      await this.repaintDualConfirmed(gen);
      this.imageError = true;
      this.bus.post(resolved.ack);
      this.emit();
    }
  }

  /** 回滚：已先行显示的一侧必须回到上一张已确认画面。 */
  private handleAbort(msg: AbortMessage) {
    const d0 = this.dual;
    if (!d0 || d0.phase !== 'live') return;
    const result: AbortResult = receiveAbort(d0, msg);
    if (result.state === d0) return;
    this.dual = result.state;
    if (result.repaintConfirmed) {
      // 回滚切换画面来源：旧代次的迟到绘制作废，用新代次重绘权威帧。
      const gen = ++this.epoch;
      void this.repaintDualConfirmed(gen);
    }
    this.imageError = false;
    this.emit();
  }

  /** 权威固化：两侧显示匹配且控制台持久化成功后到达。 */
  private handleConfirmed(msg: ConfirmedMessage) {
    const d0 = this.dual;
    if (!d0 || d0.phase !== 'live') return;
    const next = receiveConfirmed(d0, msg);
    if (next === d0) return;
    this.dual = next;
    this.imageError = false;
    this.emit();
  }

  /** 双屏恢复/回滚后绘制权威帧（上一张已确认画面）；受代次保护。 */
  private async paintDualConfirmed(gen: number) {
    await this.repaintDualConfirmed(gen);
  }

  private async repaintDualConfirmed(gen: number) {
    const d = this.dual;
    if (!this.dualStill(gen) || !d || !d.frame) return;
    const frame = d.frame;
    if (frame.blackout) {
      this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      if (!this.dualStill(gen) || !this.dual?.frame) return;
      if (this.dual.frame !== frame) return;
      this.drawImage(img);
    } catch {
      if (!this.dualStill(gen)) return;
      this.paintBlack();
    }
  }

  private async loadImage(page: number): Promise<HTMLImageElement> {
    const cached = this.cache.get(page);
    if (cached) return cached;
    const blobId = this.blobIdByPage[page];
    if (!blobId) throw new Error('blob missing for page');
    // 存储瞬时失败（事务中止/权限抖动）不应被误判为“图片坏了”而回报
    // IMAGE_FAILED：短暂退避后重读；记录不存在/解码失败等业务错误立即抛出，
    // 保持“单张坏图只标记该项”的既有语义与速度。
    let attempt = 0;
    for (;;) {
      try {
        const blob = await getBlob(blobId);
        if (!blob) throw new Error('blob not found in IndexedDB');
        const img = await decodeBlob(blob);
        this.cache.set(page, img);
        return img;
      } catch (err) {
        if (err instanceof StorageError && attempt < 2) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 60 * attempt));
          continue;
        }
        throw err instanceof Error ? err : new Error('image load failed');
      }
    }
  }

  /** 恢复完成时绘制快照确认帧；仅当代次仍有效时提交。 */
  private async paintConfirmed(gen: number) {
    if (gen !== this.epoch || this.state.phase !== 'live' || !this.state.frame) return;
    const frame = this.state.frame;
    if (frame.blackout) {
      this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      if (this.state.frame !== frame) return;
      this.drawImage(img);
    } catch {
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      // 快照页自身解码异常（理论上导入时已探测）：保持黑屏等待新命令，不改权威。
      this.paintBlack();
    }
  }

  /** 缩放触发：只重绘当前有效帧；捕获调用时代次，过期窗口的迟到重绘丢弃。 */
  private async repaintCurrent(gen: number) {
    if (this.mode === 'dual') {
      const d = this.dual;
      if (gen !== this.epoch || !d || d.phase !== 'live' || !d.display) return;
      const frame = d.display;
      if (frame.blackout) {
        this.paintBlack();
        return;
      }
      try {
        const img = await this.loadImage(frame.page);
        if (gen !== this.epoch || this.dual?.phase !== 'live') return;
        if (this.dual.display !== frame) return;
        this.drawImage(img);
      } catch {
        if (gen !== this.epoch || this.dual?.phase !== 'live') return;
        this.paintBlack();
      }
      return;
    }
    if (gen !== this.epoch || this.state.phase !== 'live' || !this.state.frame) return;
    const frame = this.state.frame;
    if (frame.blackout) {
      this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      if (this.state.frame !== frame) return;
      this.drawImage(img);
    } catch {
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      this.paintBlack();
    }
  }

  /** 呈现失败后的回退绘制：重绘最后成功帧，且不得越过更新的代次/未决呈现。 */
  private async repaintLastSuccess(gen: number) {
    if (gen !== this.epoch || this.state.phase !== 'live' || !this.state.frame) return;
    const frame = this.state.frame;
    if (frame.blackout) {
      this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      if (this.state.frame !== frame) return;
      this.drawImage(img);
    } catch {
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      this.paintBlack();
    }
  }

  private paintBlack() {
    const { width, height } = this.canvasSize();
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
  }

  private drawImage(img: HTMLImageElement) {
    const { width, height } = this.canvasSize();
    drawCover(this.ctx, img, width, height);
  }

  private canvasSize() {
    const canvas = this.ctx.canvas;
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== Math.floor(width * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    return { width, height };
  }
}
