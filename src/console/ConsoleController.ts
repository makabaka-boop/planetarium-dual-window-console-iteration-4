/**
 * 控制台控制器：把纯协议状态机与 BroadcastChannel / IndexedDB / 定时器粘合。
 * 这是全系统的权威状态持有者（authoritative state holder）。
 *
 * 存储失败纪律（authoritative state on failure）：
 *  1. 未持久化的会话/命令绝不被宣布成功 —— 所有状态变更遵循“先落库、后宣布”：
 *     内存权威状态只在对应 IndexedDB 事务完整 oncomplete 后才推进；
 *     落库失败时内存状态原样回退到“磁盘上最后可恢复记录”，并给出可重试标记。
 *  2. 失败期间不得覆盖最后可恢复记录 —— 会话写入经单一串行队列提交，
 *     每条变更携带其“磁盘前置状态”，队列执行时前置不符即拒绝写入
 *     （失败后的旧变更不会在重试之后晚到并覆盖更新的权威记录）。
 *  3. 已结束会话不得复活 —— 停映先删除会话记录并以事务完成作为成功信号，
 *     删除失败时会话仍在运行（刷新恢复的仍是该运行会话），讲解员可重试停映。
 *  4. 确认消息到达但持久化失败：页面不得显示“已确认”，磁盘仍保留未确认命令；
 *     讲解员可经“重试”（沿用原序号）重新收敛，刷新后控制台与观众窗一致。
 */
import { MessageBus } from '../bus';
import {
  clearSession,
  deleteBlob,
  loadDraft,
  loadSession,
  putBlobsAndDraft,
  saveDraft,
  saveFrozenAndSession,
  saveSession
} from '../db';
import {
  Ack,
  AbortMessage,
  CommandAction,
  CommandMessage,
  ConfirmMode,
  ConfirmedMessage,
  PendingCommand,
  Program,
  ScreenRole,
  SessionRecord,
  ShowMessage,
  SlideItem,
  SnapshotRequest,
  SnapshotResponse,
  WireMessage,
  emptyDualProgress,
  makeSessionId
} from '../protocol/types';
import {
  expirePending,
  issue,
  receiveAck,
  retryPending,
  startSession
} from '../protocol/console';
import {
  expireDualPending,
  issueDual,
  receivePreparedAck,
  receiveShownAck,
  retryDual,
  rollbackAfterConfirmFailure
} from '../protocol/dual-console';
import { DEFAULT_ACK_TIMEOUT_MS } from '../protocol/types';

export type PopupStatus = 'none' | 'open' | 'blocked';

/** 双屏模式下两块屏幕各自的开窗状态（弹窗是否成功接住）。 */
export type DualPopupStatus = Record<ScreenRole, PopupStatus>;

/** 存储失败的可重试上下文：operation 决定重试按钮重放哪个动作。 */
export type StorageOperation =
  | { kind: 'startShow'; mode?: ConfirmMode }
  | { kind: 'command'; action: CommandAction }
  | { kind: 'retry' }
  | { kind: 'ack' }
  | { kind: 'expire' }
  | { kind: 'endShow' }
  | { kind: 'draft' }
  | { kind: 'addFiles' }
  | { kind: 'init' }
  | { kind: 'dualRollback' };

export interface StorageError {
  operation: StorageOperation;
  message: string;
  at: number;
}

export interface ConsoleState {
  draft: Program;
  session: SessionRecord | null;
  /** 冻结后对草稿的编辑只影响下一会话。 */
  frozen: boolean;
  popup: PopupStatus;
  /** 恢复中的观众窗数量（收到 SNAPSHOT_REQ 即计数，用于展示“观众窗同步中”）。 */
  recoveringViewers: number;
  /** 最近一次存储失败（null 表示存储健康）；存在时 UI 给出可重试状态。 */
  storageError: StorageError | null;
  /**
   * 尚未落库、刷新后仍需用户决定重发的操作（仅存 sessionStorage，绝不写入
   * 权威会话记录）：命令写入失败时内存/磁盘权威都停在旧页，但观众窗可能已经
   * 收到过该操作；刷新后用它恢复“可重试”入口，避免用户失去收敛手段。
   */
  unsynced: UnsyncedOperation | null;
}

/** 未持久化操作的可重放描述（sessionStorage 中按会话 id 关联）。 */
interface UnsyncedOperation {
  sessionId: string;
  action: CommandAction;
  kind: 'command' | 'retry' | 'ack';
  at: number;
}

const UNSYNCED_KEY = 'dome-unsynced-op';

function readUnsynced(): UnsyncedOperation | null {
  try {
    const raw = window.sessionStorage.getItem(UNSYNCED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UnsyncedOperation;
    if (!parsed || typeof parsed !== 'object' || !parsed.action) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeUnsynced(op: UnsyncedOperation | null): void {
  try {
    if (op) window.sessionStorage.setItem(UNSYNCED_KEY, JSON.stringify(op));
    else window.sessionStorage.removeItem(UNSYNCED_KEY);
  } catch {
    // sessionStorage 自身不可用（极端隐私模式）：退化为仅当次内存可重试。
  }
}

export class ConsoleController {
  private bus: MessageBus;
  private state: ConsoleState = {
    draft: { items: [] },
    session: null,
    frozen: false,
    popup: 'none',
    recoveringViewers: 0,
    storageError: null,
    unsynced: null
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 恢复中的观众窗（按 viewerId 去重；轮询快照不会重复计数）。 */
  private recovering = new Set<string>();
  /**
   * 双屏模式：角色 -> 最近一次申报该角色的 viewerId。窗口重载后新 viewerId
   * 会取代旧值；控制台据此判断“某块屏幕中途换了窗口”，并令未完成的切换
   * 回到未确认（旧窗口的迟到回执按 viewerId 不再代表该角色）。
   */
  private roleViewers: Partial<Record<ScreenRole, string>> = {};
  /**
   * 会话持久化串行队列。每个排队项携带它所基于的“磁盘前置会话”：
   * 真正落库时若内存会话已不是该前置（说明它已被一次失败/后续操作取代），
   * 该项作废，绝不把陈旧状态写到当前记录之上。
   */
  private sessionQueue: Promise<void> = Promise.resolve();
  /**
   * 已在处理（含排队/落库中）的确认指纹。StrictMode 双订阅或多通道投递等
   * 情况下同一条 ACK 可能进入两次：第二条直接忽略，保证一条确认至多触发
   * 一次落库（不会出现“首个提交失败、重复提交随后成功”导致的内存/磁盘分裂）。
   */
  private acksInFlight = new Set<string>();
  /** 双屏：进行中的“两侧齐备 → 权威落库”指纹（防止重复 SHOWN 触发二次落库）。 */
  private dualConfirmsInFlight = new Set<string>();
  /** 双屏：已处理的阶段失败回执（同 attempt+stage+role 的重复失败只回滚一次）。 */
  private dualFailuresSeen = new Set<string>();

  constructor(bus?: MessageBus) {
    this.bus = bus ?? new MessageBus();
  }

  async init(): Promise<void> {
    // React StrictMode 开发双挂载 / 上次 init 中途失败：保证总线与定时器只挂一份。
    if (this.bus.closed) this.bus = new MessageBus();
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    try {
      const [draft, session] = await Promise.all([loadDraft(), loadSession()]);
      if (draft) this.state = { ...this.state, draft };
      if (session) {
        // 刷新恢复：会话仍是权威来源；未决命令在恢复后一律视为未确认（不自动重试，
        // 由讲解员决定，序号沿用原序号）。
        let restored = session.pending
          ? { ...session, pending: { ...session.pending, status: 'unconfirmed' as const } }
          : session;
        if (restored.mode === 'dual' && restored.pending) {
          // 双屏模式的两侧回执只是当次进程内的临时进度：刷新后一律清空，
          // 重试必须重新走完整的“两侧准备 → 两侧显示”握手，绝不借用旧回执。
          restored = {
            ...restored,
            pending: {
              ...restored.pending,
              dual: { prepared: emptyDualProgress(), shown: emptyDualProgress() }
            }
          };
        }
        // 恢复“已尝试但未持久化”的操作提示：仅当它属于当前磁盘会话
        // （旧会话/已结束会话的残留一律丢弃，不复活任何状态）。
        const unsynced = readUnsynced();
        const validUnsynced = unsynced && unsynced.sessionId === restored.sessionId ? unsynced : null;
        if (unsynced && !validUnsynced) writeUnsynced(null);
        this.roleViewers = {};
        this.state = {
          ...this.state,
          session: restored,
          frozen: restored.running,
          unsynced: validUnsynced
        };
      } else {
        // 磁盘上没有会话：任何未同步操作都失去意义（会话可能已停映），清除。
        writeUnsynced(null);
      }
      this.clearStorageError();
    } catch (err) {
      // 存储打不开（权限收回等）：不卡死 UI，以空内存进入可操作但带可重试标记的状态。
      this.failStorage({ kind: 'init' }, err);
    }
    this.unsubscribe = this.bus.subscribe((m) => this.onMessage(m));
    this.timer = setInterval(() => this.tick(), 200);
    this.emit();
  }

  getState(): ConsoleState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  // ---- 存储失败与串行持久化 ----------------------------------------------

  private failStorage(operation: StorageOperation, err: unknown): StorageError {
    const storageError: StorageError = {
      operation,
      message: err instanceof Error ? err.message : String(err),
      at: Date.now()
    };
    this.state = { ...this.state, storageError };
    this.emit();
    return storageError;
  }

  private clearStorageError() {
    if (this.state.storageError) {
      this.state = { ...this.state, storageError: null };
    }
  }

  /** 登记一个“已尝试但未持久化”的命令类操作（刷新后仍给出重试入口）。 */
  private rememberUnsynced(
    sessionId: string,
    action: CommandAction,
    kind: UnsyncedOperation['kind']
  ): void {
    const op: UnsyncedOperation = { sessionId, action, kind, at: Date.now() };
    writeUnsynced(op);
    this.state = { ...this.state, unsynced: op };
  }

  /** 操作已确认持久化（或会话结束/切换）：清除未同步标记。 */
  private forgetUnsynced(): void {
    if (this.state.unsynced || readUnsynced()) {
      writeUnsynced(null);
      this.state = { ...this.state, unsynced: null };
    }
  }

  /**
   * 串行提交一次会话变更（唯一的会话状态提交口）。
   * - expectPrev：该变更所基于的磁盘前置（null=磁盘无会话）。落库前若
   *   内存会话已不再是 expectPrev，则该变更作废（典型：落库失败后讲解员重试，
   *   旧 ACK/旧超时回调晚到，不得再把旧状态覆盖到新记录上）；
   * - 落库成功后才把 next 提交进内存并广播 emit；
   * - 落库失败：内存保持磁盘现状（= expectPrev），登记可重试存储错误，
   *   绝不自动重放（重放由用户显式触发，避免在存储持续故障时形成写入风暴/误提交）。
   */
  private commitSession(
    next: SessionRecord | null,
    expectPrev: SessionRecord | null,
    operation: StorageOperation,
    persist: (s: SessionRecord | null) => Promise<void>
  ): Promise<boolean> {
    const task = async (): Promise<boolean> => {
      if (this.state.session !== expectPrev) {
        // 前置已被取代：陈旧变更作废，不触碰磁盘上的当前记录。
        return false;
      }
      try {
        await persist(next);
      } catch (err) {
        if (this.state.session === expectPrev) this.failStorage(operation, err);
        return false;
      }
      // 落库与提交内存之间不允许插入其它会话变更（本队列串行 + 同步状态段）。
      if (this.state.session !== expectPrev) return false;
      this.state = {
        ...this.state,
        session: next,
        frozen: next ? next.running : this.state.frozen,
        storageError: null
      };
      this.emit();
      return true;
    };
    // 串行链：前一项（成功或失败）落定后才执行下一项；链本身永不 reject。
    const run: Promise<boolean> = this.sessionQueue.then(() => task());
    this.sessionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** 重放最近一次失败的存储操作；返回是否重试成功。 */
  async retryStorage(): Promise<boolean> {
    const op = this.state.storageError?.operation;
    // 刷新后横幅可能已不在，但未同步操作仍需可重放。
    if (!op) {
      if (this.state.unsynced) {
        await this.retryUnsynced();
        return this.state.storageError === null;
      }
      return true;
    }
    switch (op.kind) {
      case 'init':
        await this.init();
        return this.state.storageError === null;
      case 'startShow':
        await this.justStartShow(op.mode ?? 'single');
        return this.state.storageError === null;
      case 'command':
        await this.command(op.action);
        return this.state.storageError === null;
      case 'retry':
        await this.retry();
        return this.state.storageError === null;
      case 'ack':
        // ACK 对应的观众窗画面可能已呈现：以“重放未同步操作”收敛。
        // 内存/磁盘权威仍是未确认状态，观众窗对重复命令只重放 ACK 或重新呈现。
        if (this.state.unsynced) await this.retryUnsynced();
        else await this.retry();
        return this.state.storageError === null;
      case 'dualRollback':
        // 双屏阶段失败后的回滚命令（ABORT）落库失败：重试先收敛回滚态，
        // 再由讲解员显式重试切换（新 attempt，不借用旧回执）。
        await this.retryDualRollback();
        return this.state.storageError === null;
      case 'expire':
        this.tick(true);
        return this.state.storageError === null;
      case 'endShow':
        await this.endShow();
        return this.state.storageError === null;
      case 'draft':
        await this.saveDraftNow();
        return this.state.storageError === null;
      case 'addFiles':
        // 已导入文件的 File 句柄无法跨交互重建：讲解员直接重新选择图片即可，
        // 横幅在此仅作告知，点击即清除（节目单与 Blob 均已随事务回滚）。
        this.state = { ...this.state, storageError: null };
        this.emit();
        return true;
      default:
        return false;
    }
  }

  // ---- 节目单编排（草稿） -------------------------------------------------

  async addFiles(files: File[]): Promise<void> {
    const prepared: SlideItem[] = [];
    const blobs: Array<{ blobId: string; blob: Blob; name: string }> = [];
    // 先逐张探测解码（只读操作，不落任何数据）；单张失败只标记该项。
    for (const file of files) {
      const blobId = `blob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      let decodeFailed = false;
      try {
        decodeFailed = await probeDecode(file).then(
          () => false,
          () => true
        );
      } catch {
        decodeFailed = true;
      }
      blobs.push({ blobId, blob: file, name: file.name });
      prepared.push({
        id: blobId,
        blobId,
        name: file.name,
        type: file.type || 'image/*',
        size: file.size,
        decodeFailed
      });
    }
    if (prepared.length === 0) return;
    const nextItems = [...this.state.draft.items, ...prepared];
    // Blob 与草稿在同一事务内原子提交：事务中止则两者都不可见，
    // 内存节目单保持磁盘现状（不出现半份导入）。
    try {
      await putBlobsAndDraft({ items: nextItems, blobs });
    } catch (err) {
      this.failStorage({ kind: 'addFiles' }, err);
      return;
    }
    this.state = { ...this.state, draft: { items: nextItems }, storageError: null };
    this.emit();
  }

  async reorder(from: number, to: number): Promise<void> {
    if (this.state.frozen) return; // 放映中冻结，编辑仅供下一会话
    const items = [...this.state.draft.items];
    if (from < 0 || from >= items.length || to < 0 || to >= items.length) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    await this.persistDraft(items);
  }

  async move(id: string, delta: number): Promise<void> {
    const idx = this.state.draft.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    await this.reorder(idx, idx + delta);
  }

  async removeItem(id: string): Promise<void> {
    if (this.state.frozen) return;
    const exists = this.state.draft.items.some((i) => i.id === id);
    if (!exists) return;
    const items = this.state.draft.items.filter((i) => i.id !== id);
    const ok = await this.persistDraft(items);
    if (!ok) return;
    // 草稿已提交后再回收 Blob（best-effort；失败不影响权威状态）。
    deleteBlob(id).catch(() => undefined);
  }

  /** 先落库后改内存；失败保留磁盘最后草稿并登记可重试。 */
  private async persistDraft(items: SlideItem[]): Promise<boolean> {
    try {
      await saveDraft({ items });
    } catch (err) {
      this.failStorage({ kind: 'draft' }, err);
      return false;
    }
    this.state = { ...this.state, draft: { items }, storageError: null };
    this.emit();
    return true;
  }

  private async saveDraftNow(): Promise<boolean> {
    return this.persistDraft(this.state.draft.items);
  }

  // ---- 放映会话 ----------------------------------------------------------

  /**
   * 开始放映：冻结节目单 + 会话记录在同一 IDB 事务内原子落库。
   * 只有事务完整成功后，控制台才进入“运行/冻结”状态并打开观众窗；
   * 落库失败（配额不足/权限收回/事务中止）时控制台仍是编辑模式，
   * 磁盘上的上一场会话与冻结节目单原封不动（最后可恢复记录不被覆盖），
   * 讲解员可在修复存储后重试。
   * 弹窗受阻时：会话已建立并持久化（保留会话），popup = 'blocked'，
   * 讲解员可稍后“重试打开观众窗”，观众窗打开后通过快照收敛。
   */
  async startShow(mode: ConfirmMode = 'single'): Promise<PopupStatus> {
    return this.justStartShow(mode);
  }

  private async justStartShow(mode: ConfirmMode): Promise<PopupStatus> {
    if (this.state.session?.running) return this.state.popup;
    const usable = this.state.draft.items;
    if (usable.length === 0) return this.state.popup;

    const sessionId = makeSessionId();
    let session = startSession(sessionId, usable.length, Date.now(), mode);
    session = { ...session, frozenProgram: { items: usable } };
    this.recovering.clear();
    this.roleViewers = {};
    try {
      // 冻结节目单（frozen:<sid>、frozen:latest）与 current 会话同一事务：
      // 任一写入最终中止则全部回滚，绝不会只冻结没会话、或有会话没节目单。
      await saveFrozenAndSession(session);
    } catch (err) {
      this.failStorage({ kind: 'startShow', mode }, err);
      return this.state.popup;
    }
    // 落库已确定成功：现在才宣布运行与冻结。新会话不携带任何旧的未同步操作。
    this.forgetUnsynced();
    this.state = {
      ...this.state,
      session,
      frozen: true,
      recoveringViewers: 0,
      storageError: null,
      unsynced: null
    };
    const status = mode === 'dual' ? this.openDualViewers() : this.openViewer();
    this.state = { ...this.state, popup: status };
    this.emit();
    return status;
  }

  /** 尝试（重新）打开观众窗；返回弹窗状态。 */
  openViewer(): PopupStatus {
    const url = `${window.location.origin}/viewer`;
    let win: Window | null = null;
    try {
      win = window.open(url, 'dome-viewer');
    } catch {
      win = null;
    }
    if (!win) {
      this.state = { ...this.state, popup: 'blocked' };
      this.emit();
      return 'blocked';
    }
    this.state = { ...this.state, popup: 'open' };
    this.emit();
    return 'open';
  }

  /**
   * 双屏模式：在同一次用户手势内连续打开主投影与备用投影两个窗口
   * （命名窗口 dome-viewer-main / dome-viewer-backup，刷新/重试复用同一窗口）。
   * 任一被拦截都报告 POPUP_BLOCKED，但会话已建立并持久保留，讲解员放行后
   * 可逐块重试打开；窗口打开后仍通过快照精确同步。
   */
  private openDualViewers(): PopupStatus {
    const results: DualPopupStatus = { main: 'none', backup: 'none' };
    (['main', 'backup'] as ScreenRole[]).forEach((role) => {
      results[role] = this.openRoleWindow(role);
    });
    return results.main === 'blocked' || results.backup === 'blocked' ? 'blocked' : 'open';
  }

  private openRoleWindow(role: ScreenRole): PopupStatus {
    const url = `${window.location.origin}/viewer?role=${role}`;
    let win: Window | null = null;
    try {
      win = window.open(url, `dome-viewer-${role}`);
    } catch {
      win = null;
    }
    return win ? 'open' : 'blocked';
  }

  /** 重试打开指定角色的观众窗（POPUP_BLOCKED 解除后使用）。 */
  openRole(role: ScreenRole): PopupStatus {
    const status = this.openRoleWindow(role);
    this.state = {
      ...this.state,
      popup: status === 'open' && this.state.popup === 'blocked' ? 'open' : this.state.popup
    };
    this.emit();
    return status;
  }

  /** 当前会话是否为双屏确认模式。 */
  isDualMode(): boolean {
    return this.state.session?.mode === 'dual';
  }

  /** 双屏模式下各角色当前对应的 viewerId（供 UI 展示在线状态）。 */
  roleViewerIds(): Partial<Record<ScreenRole, string>> {
    return { ...this.roleViewers };
  }

  private post(msg: WireMessage) {
    this.bus.post(msg);
  }

  private tick(manual = false) {
    const s = this.state.session;
    if (!s?.running || !s.pending) return;
    if (s.mode === 'dual') {
      this.tickDual(s, manual);
      return;
    }
    if (s.pending.status !== 'pending') return;
    const next = expirePending(s);
    if (next === s) return;
    void this.commitSession(next, s, { kind: 'expire' }, (v) =>
      saveSession(v!, 'expire')
    ).then((ok) => {
      if (!ok && manual) this.emit();
    });
  }

  /**
   * 双屏超时：preparing（两侧未准备齐）或 partial（只有一侧显示）超时，
   * 权威画面不变，命令保持未确认；回滚状态先落库，随后 ABORT 让已先行
   * 显示的一侧回到上一张已确认画面。落库失败则只挂存储错误（不发 ABORT，
   * 由重试入口再次收敛）。
   */
  private tickDual(s: SessionRecord, manual: boolean) {
    const next = expireDualPending(s, Date.now(), DEFAULT_ACK_TIMEOUT_MS);
    if (next === s) return;
    const abort: AbortMessage = {
      kind: 'ABORT',
      sessionId: s.sessionId,
      seq: s.pending!.seq,
      page: s.pending!.target.page,
      blackout: s.pending!.target.blackout,
      attempt: s.pending!.attempts
    };
    void this.commitSession(next, s, { kind: 'expire' }, (v) => saveSession(v!, 'expire')).then(
      (ok) => {
        if (ok) this.post(abort);
        else if (manual) this.emit();
      }
    );
  }

  /**
   * 讲解员发出一条命令：先持久化（待确认命令随会话落库），落库成功后才把
   * 命令发往观众窗并宣布“待确认”。持久化失败则不发命令、内存权威不变
   * （观众窗不会收到一个刷新后无法解释的新画面），给出可重试状态。
   * 双屏模式发出的是装载阶段命令（phase=prepare），UI 进入“准备中”。
   */
  async command(action: CommandAction): Promise<void> {
    const s = this.state.session;
    if (!s?.running) return;
    if (s.mode === 'dual') {
      await this.commandDual(action);
      return;
    }
    const { session: next, command } = issue(s, action);
    if (!command || next === s) return; // 叠加拒绝 / 空操作
    const ok = await this.commitSession(next, s, { kind: 'command', action }, (v) =>
      saveSession(v!)
    );
    if (!ok) {
      // 命令未持久化：内存/磁盘权威不变，命令也未发出；登记可重试操作，
      // 即使刷新控制台，讲解员仍有明确的重试入口收敛画面。
      if (this.state.session === s) this.rememberUnsynced(s.sessionId, action, 'command');
      return;
    }
    this.forgetUnsynced();
    this.post(command);
  }

  private async commandDual(action: CommandAction): Promise<void> {
    const s = this.state.session;
    if (!s || s.mode !== 'dual') return;
    const { session: next, command } = issueDual(s, action);
    if (!command || next === s) return; // 叠加拒绝 / 空操作
    const ok = await this.commitSession(next, s, { kind: 'command', action }, (v) =>
      saveSession(v!)
    );
    if (!ok) {
      if (this.state.session === s) this.rememberUnsynced(s.sessionId, action, 'command');
      return;
    }
    this.forgetUnsynced();
    this.post(command);
  }

  next() {
    return this.command({ type: 'next' });
  }
  prev() {
    return this.command({ type: 'prev' });
  }
  goto(page: number) {
    return this.command({ type: 'goto', page });
  }
  setBlackout(blackout: boolean) {
    return this.command({ type: 'setBlackout', blackout });
  }

  /** 重试沿用原序号（retryPending 不改 seq）；同样先落库后发送。 */
  async retry(): Promise<void> {
    const s = this.state.session;
    if (!s?.running || !s.pending) return;
    if (s.mode === 'dual') {
      await this.retryDualCmd(s);
      return;
    }
    const { session: next, command } = retryPending(s);
    if (!command) return;
    const ok = await this.commitSession(next, s, { kind: 'retry' }, (v) => saveSession(v!));
    if (!ok) {
      this.rememberUnsynced(s.sessionId, s.pending.action, 'retry');
      return;
    }
    this.forgetUnsynced();
    this.post(command);
  }

  /**
   * 双屏重试：序号不变、attempts+1，两侧回执进度清空后重新落库，
   * 再发新一轮 prepare。旧 attempt 的 PREPARED/SHOWN 全部作废，
   * 两侧窗口收到新 attempt 的 prepare 时会自行先回到权威帧再装载。
   */
  private async retryDualCmd(s: SessionRecord): Promise<void> {
    const { session: next, command } = retryDual(s);
    if (!command) return;
    const ok = await this.commitSession(next, s, { kind: 'retry' }, (v) => saveSession(v!));
    if (!ok) {
      this.rememberUnsynced(s.sessionId, s.pending!.action, 'retry');
      return;
    }
    this.forgetUnsynced();
    this.post(command);
  }

  /**
   * 重放“已尝试但未持久化”的操作（刷新后通过横幅重试入口调用）。
   * 刷新恢复后磁盘上的该命令处于 unconfirmed：优先按“同序号重试”重发
   * （观众窗已呈现则只重放 ACK，未呈现则按原目标画面呈现）；
   * 仅在没有未决命令（失败写入发生在 issue 之前的命令路径）时才重新 issue。
   */
  private async retryUnsynced(): Promise<void> {
    const op = this.state.unsynced;
    if (!op) return;
    if (this.state.session?.pending) {
      await this.retry();
    } else {
      await this.command(op.action);
    }
  }

  /**
   * 停映：先把会话记录删除落到磁盘（事务完成才算数），再通知观众窗结束。
   * 删除失败时会话仍在运行 —— 内存不宣布结束、SESSION_ENDED 不发出，
   * 刷新后恢复的仍是同一场运行会话（已结束会话绝不复活，运行会话也绝不假死），
   * UI 给出可重试的存储错误。
   */
  async endShow(): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    const ok = await this.commitSession(null, s, { kind: 'endShow' }, async () => {
      await clearSession();
    });
    if (!ok) return;
    this.bus.post({ kind: 'SESSION_ENDED', sessionId: s.sessionId });
    this.recovering.clear();
    this.roleViewers = {};
    this.forgetUnsynced();
    this.state = {
      ...this.state,
      session: null,
      frozen: false,
      recoveringViewers: 0,
      popup: 'none',
      storageError: null,
      unsynced: null
    };
    this.emit();
  }

  pending(): PendingCommand | null {
    return this.state.session?.pending ?? null;
  }

  // ---- 消息入口 ----------------------------------------------------------

  private onMessage(msg: WireMessage) {
    switch (msg.kind) {
      case 'SNAPSHOT_REQ':
        this.handleSnapshotReq(msg);
        break;
      case 'ACK':
        if (this.state.session?.mode === 'dual') this.handleDualAck(msg);
        else this.handleAck(msg);
        break;
      default:
        break;
    }
  }

  private handleSnapshotReq(req: SnapshotRequest) {
    const s = this.state.session;
    if (!s) {
      // 无会话时应答空快照，让观众窗保持待命（轮询），不报错。
      const empty: SnapshotResponse = {
        kind: 'SNAPSHOT_RES',
        sessionId: req.sessionId ?? '',
        running: false,
        confirmed: { seq: 0, page: 0, blackout: false },
        pending: null,
        viewerId: req.viewerId
      };
      this.post(empty);
      return;
    }
    const res: SnapshotResponse = {
      kind: 'SNAPSHOT_RES',
      sessionId: s.sessionId,
      running: s.running,
      confirmed: s.lastConfirmed,
      pending: s.pending,
      viewerId: req.viewerId,
      mode: s.mode,
      role: req.role
    };
    this.post(res);

    if (s.mode === 'dual') {
      this.handleDualSnapshotRole(s, req);
    } else {
      // 恢复后若有未决命令（pending/unconfirmed/failed 不自动补发，避免对 failed
      // 命令在图片仍坏时形成风暴）；仅当未决仍是 pending（正在等待该新窗口确认）
      // 时立刻重放一次，便于新窗口快速同步。
      if (s.pending && s.pending.status === 'pending') {
        const cmd: CommandMessage = {
          kind: 'CMD',
          sessionId: s.sessionId,
          seq: s.pending.seq,
          action: s.pending.action,
          page: s.pending.target.page,
          blackout: s.pending.target.blackout
        };
        this.post(cmd);
      }
    }

    if (s.running && !this.recovering.has(req.viewerId)) {
      this.recovering.add(req.viewerId);
      // 观众窗成功取得快照即证明窗口通路存在，解除 POPUP_BLOCKED 提示（会话不变）。
      // 双屏模式下需两块屏幕都出现才视为通路齐备。
      const popupOpen =
        s.mode !== 'dual' ||
        (this.roleViewers.main != null && this.roleViewers.backup != null);
      this.state = {
        ...this.state,
        recoveringViewers: this.recovering.size,
        popup: popupOpen ? 'open' : this.state.popup
      };
      this.emit();
    }
  }

  /**
   * 双屏模式的角色登记与“换窗口”检测：
   *  - 角色首次上报：记录 viewerId，若此时正有未决切换，该角色尚无本轮回执，
   *    处于 preparing 时立即补发装载命令让新窗口加入；
   *  - 同一 viewerId 周期轮询：幂等；
   *  - 同一角色换了 viewerId（旧窗重载/关闭后新开）：旧窗口的一切在途回执对
   *    控制台作废。若切换已进入 partial（可能已有屏幕先行显示），为避免两块
   *    屏幕分裂，直接把命令打回未确认并 ABORT，由讲解员用新 attempt 重试
   *    （新窗口重载后本身也已先同步到最后确认画面）。
   */
  private handleDualSnapshotRole(s: SessionRecord, req: SnapshotRequest) {
    const role = req.role;
    if (role !== 'main' && role !== 'backup') return;
    const prev = this.roleViewers[role];
    this.roleViewers[role] = req.viewerId;

    const p = s.pending;
    if (!p) return;
    if (prev === req.viewerId) return; // 轮询或已登记

    if (prev != null && (p.status === 'partial' || p.status === 'preparing')) {
      // 该角色的窗口在切换中途被替换：旧回执作废，打回未确认并回滚已显示侧。
      const next: SessionRecord = {
        ...s,
        pending: { ...p, status: 'unconfirmed', dual: p.dual ? { ...p.dual } : undefined }
      };
      const abort: AbortMessage = {
        kind: 'ABORT',
        sessionId: s.sessionId,
        seq: p.seq,
        page: p.target.page,
        blackout: p.target.blackout,
        attempt: p.attempts
      };
      // 先落库未确认回滚态，再发 ABORT（内存/磁盘权威一致后才宣布）。
      void this.commitSession(next, s, { kind: 'dualRollback' }, (v) => saveSession(v!)).then(
        (ok) => {
          if (ok) this.post(abort);
        }
      );
      return;
    }

    // 新窗口加入时若仍在准备阶段，定向补发本轮装载命令（携带新 attempt）。
    if (p.status === 'preparing') {
      const cmd: CommandMessage = {
        kind: 'CMD',
        sessionId: s.sessionId,
        seq: p.seq,
        action: p.action,
        page: p.target.page,
        blackout: p.target.blackout,
        phase: 'prepare',
        attempt: p.attempts,
        viewerId: req.viewerId
      };
      this.post(cmd);
    }
  }

  private handleAck(ack: Ack) {
    const s = this.state.session;
    if (!s) return;
    // receiveAck 内部严格校验会话与序号：旧确认、其它会话确认都不会改动权威状态。
    const next = receiveAck(s, ack);
    if (next === s) return;
    // 同一确认（会话+序号+画面）去重：它对应的提交可能仍在队列中，
    // 重复 ACK 不得再产生一次独立落库（两次落库之间穿插故障会造成分裂）。
    const fingerprint = `${s.sessionId}:${ack.seq}:${next.lastConfirmed.page}:${next.lastConfirmed.blackout}`;
    if (this.acksInFlight.has(fingerprint)) return;
    this.acksInFlight.add(fingerprint);
    // 确认只在落库成功后才允许把页面显示为“已确认”。落库失败时：
    // 内存与磁盘都停留在未确认命令（观众窗可能已显示新画面），讲解员用“重试”
    // （沿用同序号）重新收敛；刷新后控制台与观众窗都会回到磁盘上的同一权威。
    const pendingAction = s.pending?.action;
    void this.commitSession(next, s, { kind: 'ack' }, (v) => saveSession(v!)).then((ok) => {
      this.acksInFlight.delete(fingerprint);
      if (!ok && pendingAction && this.state.session === s) {
        this.rememberUnsynced(s.sessionId, pendingAction, 'ack');
      }
    });
  }

  /**
   * 双屏确认模式的回执处理。三条纪律：
   *  1. 只有会话/序号/目标/attempt/角色全部匹配当前未决命令的回执才有效
   *     （纯函数内校验）——迟到、重复、异会话、上一轮尝试的旧回执一律丢弃；
   *  2. 阶段推进（preparing→partial、单侧 SHOWN 计数）只在两侧齐备的关键点
   *     落库；单侧进度是进程内临时状态，刷新即清空（重试不得借用旧回执）；
   *  3. 两侧 SHOWN 匹配后仍须权威状态落库成功才广播 CONFIRMED；任一侧失败、
   *     超时或存储失败都下发 ABORT，让已先行显示的一侧回到上一张已确认画面。
   */
  private handleDualAck(ack: Ack) {
    const s = this.state.session;
    if (!s || s.mode !== 'dual' || !s.pending) return;
    if (ack.stage !== 'prepared' && ack.stage !== 'shown') return;

    if (ack.stage === 'prepared') {
      const r = receivePreparedAck(s, ack);
      if (r.session === s && !r.show && !r.rollback) {
        // 无效回执（迟到/异会话/旧 attempt）；唯一例外：两侧已齐备进入 partial
        // 后收到的同轮重复 PREPARED（可能 SHOW 丢了），幂等重发一次 SHOW。
        this.maybeResendShow(s, ack);
        return;
      }
      if (r.rollback) {
        this.dualStageFailure(s, r.session, r.rollback, ack, 'prepared');
        return;
      }
      if (r.show) {
        // 两侧准备回执匹配：先把“部分显示前”的阶段状态落库，再下发 SHOW。
        void this.commitSession(r.session, s, { kind: 'ack' }, (v) => saveSession(v!)).then(
          (ok) => {
            if (ok) this.post(r.show!);
            // 落库失败：不发 SHOW，两侧仍停在权威帧（仅完成装载），存储横幅可重试。
          }
        );
        return;
      }
      // 单侧 PREPARED：仅更新内存临时进度（不落库、不改变权威）。
      this.state = { ...this.state, session: r.session };
      this.emit();
      return;
    }

    // stage === 'shown'
    const r = receiveShownAck(s, ack);
    if (r.session === s && !r.confirmed && !r.rollback) return; // 无效回执
    if (r.rollback) {
      this.dualStageFailure(s, r.session, r.rollback, ack, 'shown');
      return;
    }
    if (!r.confirmed) {
      // 单侧 SHOWN：进入/保持“部分显示”（临时进度，不落库；partial 标记已在
      // 下发 SHOW 前随两侧准备齐备落过一次）。
      this.state = { ...this.state, session: r.session };
      this.emit();
      return;
    }

    // 两侧 SHOWN 匹配：去重后把权威前进落库；成功才广播 CONFIRMED。
    const p = s.pending;
    const fingerprint = `${s.sessionId}:${p.seq}:${p.attempts}:${p.target.page}:${p.target.blackout}`;
    if (this.dualConfirmsInFlight.has(fingerprint)) return;
    this.dualConfirmsInFlight.add(fingerprint);
    const pendingAction = p.action;
    void this.commitSession(r.session, s, { kind: 'ack' }, (v) => saveSession(v!)).then((ok) => {
      this.dualConfirmsInFlight.delete(fingerprint);
      if (ok) {
        this.forgetUnsynced();
        const c = r.session.lastConfirmed;
        const confirmedMsg: ConfirmedMessage = {
          kind: 'CONFIRMED',
          sessionId: s.sessionId,
          seq: c.seq,
          page: c.page,
          blackout: c.blackout
        };
        this.post(confirmedMsg);
        return;
      }
      // 权威持久化失败：绝不宣布已确认。两侧穹顶必须回到上一张已确认画面
      // （= 磁盘权威，画面回滚不宣布任何新权威，故先于回滚标记发出也安全）。
      if (this.state.session !== s) return; // 已被更新的操作取代
      const rb = rollbackAfterConfirmFailure(this.state.session);
      const abort = rb.abort;
      this.post(abort);
      if (pendingAction) this.rememberUnsynced(s.sessionId, pendingAction, 'ack');
      // 回滚态落库，但保留本次存储失败横幅：权威前进确已失败，讲解员需要
      // 明确的可重试入口（重试产生新 attempt，绝不复用这轮回执）。
      const err = this.state.storageError;
      void this.commitSession(rb.session, this.state.session, { kind: 'ack' }, (v) =>
        saveSession(v!)
      ).then((rbOk) => {
        if (!rbOk) return;
        if (err) this.state = { ...this.state, storageError: err };
        this.emit();
      });
    });
  }

  /**
   * 阶段失败（单侧准备失败或单侧显示失败）：先持久化失败/回滚态，再 ABORT。
   * 若落库本身也失败，仍发 ABORT 把穹顶收敛回磁盘上的最后确认帧，并挂出
   * 可重试存储错误（权威从未前进，回滚不构成新的权威宣布）。
   */
  private dualStageFailure(
    base: SessionRecord,
    failed: SessionRecord,
    abort: AbortMessage,
    ack: Ack,
    stage: 'prepared' | 'shown'
  ) {
    const fingerprint = `${base.sessionId}:${ack.seq}:${ack.attempt}:${stage}:${ack.role}:${ack.ok}`;
    if (this.dualFailuresSeen.has(fingerprint)) return;
    this.dualFailuresSeen.add(fingerprint);
    void this.commitSession(failed, base, { kind: 'dualRollback' }, (v) => saveSession(v!)).then(
      () => {
        // 无论落库成功与否都把穹顶收回最后确认帧；成功失败均有确定状态。
        this.post(abort);
        this.dualFailuresSeen.delete(fingerprint);
      }
    );
  }

  /** partial 阶段收到同轮重复 PREPARED：幂等重发 SHOW（修复 SHOW 丢失）。 */
  private maybeResendShow(s: SessionRecord, ack: Ack) {
    const p = s.pending;
    if (!p?.dual || p.status !== 'partial') return;
    if (
      ack.sessionId !== s.sessionId ||
      ack.seq !== p.seq ||
      ack.attempt !== p.attempts ||
      !p.dual.prepared.main ||
      !p.dual.prepared.backup
    ) {
      return;
    }
    if (!ack.ok) return;
    if (ack.page !== p.target.page || ack.blackout !== p.target.blackout) return;
    const show: ShowMessage = {
      kind: 'SHOW',
      sessionId: s.sessionId,
      seq: p.seq,
      page: p.target.page,
      blackout: p.target.blackout,
      attempt: p.attempts
    };
    this.post(show);
  }

  /** 存储横幅“重试写入”：双屏回滚标记落库失败后，重试当前回滚态即可。 */
  private async retryDualRollback(): Promise<void> {
    const s = this.state.session;
    if (!s?.pending) return;
    const next: SessionRecord = { ...s, pending: { ...s.pending, status: 'unconfirmed' } };
    await this.commitSession(next, s, { kind: 'dualRollback' }, (v) => saveSession(v!));
  }

  dispose() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.bus.close();
  }
}

/** 用 createImageBitmap / Image 做一次解码探测；失败即视为该张不可呈现。 */
function probeDecode(blob: Blob): Promise<void> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).then((bmp) => {
      if (!bmp.width || !bmp.height) throw new Error('zero size');
      bmp.close?.();
    });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (!img.naturalWidth) reject(new Error('zero size'));
      else resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}
