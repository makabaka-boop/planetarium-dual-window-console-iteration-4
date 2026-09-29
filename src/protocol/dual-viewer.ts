/**
 * 观众窗侧“双屏确认模式”协议状态机（纯函数，与 single 模式的 viewer.ts 并存）。
 *
 * 与 single 模式“收到 CMD 即切换画面”不同，dual 模式把一次切换拆成两步：
 *
 *   1. CMD(prepare, attempt)  只预装载目标资源（不切画面），回报 PREPARED；
 *   2. SHOW(attempt)          两侧准备齐备后才真正切换画面，回报 SHOWN。
 *
 * 失败/回滚纪律：
 *  - 准备失败：画面从未离开最后确认帧，回报失败 PREPARED 即可；
 *  - 已切换后收到 ABORT(同 attempt)：必须回到上一张已确认画面（frame），
 *    显示状态清空，使同序号的下一轮尝试可被再次接受；
 *  - CONFIRMED：把当前显示固化为权威帧（appliedSeq 前进）；
 *  - 任何携带旧 attempt 的消息/回执触发源（重试后的迟到消息）一律丢弃；
 *  - 会话不符、恢复期间、序号更旧或跳号一律丢弃；迟到/重复消息不得推进新命令。
 */
import {
  AbortMessage,
  Ack,
  CommandMessage,
  ConfirmedFrame,
  ConfirmedMessage,
  ScreenRole,
  ShowMessage
} from './types';

type RenderTarget = { seq: number; page: number; blackout: boolean };

export interface DualViewerState {
  viewerId: string;
  role: ScreenRole;
  phase: 'standby' | 'recovering' | 'live' | 'ended';
  sessionId: string | null;
  /** 最近一次被 CONFIRMED 固化的权威序号（= frame.seq）。 */
  appliedSeq: number;
  /** 权威帧：上一张已确认画面，也是任何回滚的目的地。 */
  frame: ConfirmedFrame | null;
  /**
   * 当前尝试的装载/显示状态：
   *  - preparing：已接受 prepare 命令，等待渲染层完成预装载；
   *  - prepared：预装载完成（PREPARED 已发），等待 SHOW；
   *  - showing：已收到 SHOW，渲染层正在切换画面；
   *  - displayed：画面已切到 display（SHOWN 已发），等待 CONFIRMED/ABORT；
   *  - failed-prepare：本次装载失败（PREPARED ok:false 已发），等待下一轮命令/ABORT。
   */
  stage:
    | 'idle'
    | 'preparing'
    | 'prepared'
    | 'showing'
    | 'displayed'
    | 'failed-prepare';
  /** 本次未决切换的目标与尝试号。 */
  pending: { target: RenderTarget; attempt: number } | null;
  /** 穹顶实际画面：displayed 阶段为目标画面，其余阶段等于权威帧。 */
  display: ConfirmedFrame | null;
  ignoredStale: number;
}

export function initDualViewer(viewerId: string, role: ScreenRole): DualViewerState {
  return {
    viewerId,
    role,
    phase: 'standby',
    sessionId: null,
    appliedSeq: -1,
    frame: null,
    stage: 'idle',
    pending: null,
    display: null,
    ignoredStale: 0
  };
}

export function beginDualRecovery(state: DualViewerState): DualViewerState {
  return {
    ...state,
    phase: 'recovering',
    sessionId: null,
    appliedSeq: -1,
    frame: null,
    stage: 'idle',
    pending: null,
    display: null,
    ignoredStale: 0
  };
}

/** 快照恢复：直接采用控制台的最后确认帧（窗口重载后先同步最后确认状态）。 */
export function applyDualSnapshot(
  state: DualViewerState,
  res: {
    viewerId: string;
    sessionId: string;
    running: boolean;
    confirmed: ConfirmedFrame;
    role?: ScreenRole;
  }
): DualViewerState {
  if (res.viewerId !== state.viewerId) return state;
  if (state.phase !== 'recovering') return state;
  return {
    ...state,
    phase: res.running ? 'live' : 'standby',
    sessionId: res.sessionId,
    role: res.role ?? state.role,
    appliedSeq: res.confirmed.seq,
    frame: { ...res.confirmed },
    display: { ...res.confirmed },
    stage: 'idle',
    pending: null,
    ignoredStale: 0
  };
}

export interface PrepareAccept {
  state: DualViewerState;
  /** 渲染层需要预装载的目标（只装载、不切画面）；null 表示消息被忽略。 */
  preload: RenderTarget | null;
}

function targetOf(msg: { seq: number; page: number; blackout: boolean }): RenderTarget {
  return { seq: msg.seq, page: msg.page, blackout: msg.blackout };
}

/**
 * 处理装载阶段命令。
 * 优先识别“当前未决切换的新一轮尝试”（seq 与 pending 相同）：
 *  - attempt 更新（重试 / ABORT 丢失 / 本窗口重载后控制台补发）：先回到权威
 *    帧（若此前已显示），再以新 attempt 重新装载；
 *  - attempt 相同或更旧：幂等忽略，绝不重复装载、不重复回执。
 * 没有匹配的未决切换时再按序号纪律判定（appliedSeq 仅在 CONFIRMED 时前进）：
 *  - seq < appliedSeq：更旧，忽略；
 *  - seq === appliedSeq：已固化的序号，无未决，忽略；
 *  - seq === appliedSeq + 1：新切换，接受；
 *  - 跳号：忽略。
 */
export function receivePrepareCommand(
  state: DualViewerState,
  msg: CommandMessage
): PrepareAccept {
  if (state.phase !== 'live' || !state.sessionId) return { state, preload: null };
  if (msg.sessionId !== state.sessionId) return { state, preload: null };
  if (msg.phase !== 'prepare' || typeof msg.attempt !== 'number') {
    return { state, preload: null };
  }
  const attempt = msg.attempt;
  const target = targetOf(msg);
  const cur = state.pending;

  if (cur && cur.target.seq === msg.seq) {
    if (attempt <= cur.attempt) {
      // 同序号旧尝试/同尝试的重复 prepare：幂等忽略。
      return { state, preload: null };
    }
    // 新一轮尝试：画面必须先回到上一张已确认帧，再为新 attempt 装载。
    const fallback = state.frame ?? { seq: state.appliedSeq, page: 0, blackout: false };
    const rollback: DualViewerState = {
      ...state,
      display: { ...fallback },
      stage: 'preparing',
      pending: { target, attempt }
    };
    return { state: rollback, preload: target };
  }

  if (msg.seq < state.appliedSeq) {
    return { state: { ...state, ignoredStale: state.ignoredStale + 1 }, preload: null };
  }
  if (msg.seq === state.appliedSeq) {
    return { state, preload: null };
  }
  if (msg.seq !== state.appliedSeq + 1) {
    return { state: { ...state, ignoredStale: state.ignoredStale + 1 }, preload: null };
  }
  return {
    state: { ...state, stage: 'preparing', pending: { target, attempt } },
    preload: target
  };
}

function prepareAck(
  state: DualViewerState,
  target: RenderTarget,
  attempt: number,
  ok: boolean
): Ack {
  const sessionId = state.sessionId!;
  if (ok) {
    return {
      kind: 'ACK',
      sessionId,
      seq: target.seq,
      viewerId: state.viewerId,
      ok: true,
      page: target.page,
      blackout: target.blackout,
      stage: 'prepared',
      attempt,
      role: state.role
    };
  }
  return {
    kind: 'ACK',
    sessionId,
    seq: target.seq,
    viewerId: state.viewerId,
    ok: false,
    reason: 'IMAGE_FAILED',
    target: { page: target.page, blackout: target.blackout },
    page: state.frame?.page ?? 0,
    blackout: state.frame?.blackout ?? false,
    stage: 'prepared',
    attempt,
    role: state.role
  };
}

export interface PrepareResult {
  state: DualViewerState;
  ack: Ack;
}

/**
 * 预装载结果回调。只接受与当前 preparing 未决完全一致（seq+目标+attempt）
 * 的结果；旧尝试/旧命令的迟到装载结果一律丢弃。
 * 成功：进入 prepared（画面仍停在权威帧），回报 PREPARED ok；
 * 失败：进入 failed-prepare（画面未动），回报 PREPARED ok:false。
 */
export function resolvePrepare(
  state: DualViewerState,
  target: RenderTarget,
  attempt: number,
  ok: boolean
): PrepareResult | null {
  const cur = state.pending;
  if (!cur || state.stage !== 'preparing') return null;
  if (cur.attempt !== attempt || !sameTarget(cur.target, target)) return null;
  const next: DualViewerState = {
    ...state,
    stage: ok ? 'prepared' : 'failed-prepare'
  };
  return { state: next, ack: prepareAck(next, target, attempt, ok) };
}

export interface ShowAccept {
  state: DualViewerState;
  /** 渲染层需要真正切换到的画面；null 表示忽略。 */
  render: RenderTarget | null;
}

/**
 * 处理 SHOW：必须存在同序号、同 attempt、已完成装载（prepared）的未决目标。
 * displayed 阶段收到重复 SHOW：幂等接受（渲染层无需重绘，由 resolveShow
 * 的调用方判断已显示时直接重放 SHOWN）。
 */
export function receiveShow(state: DualViewerState, msg: ShowMessage): ShowAccept {
  if (state.phase !== 'live' || !state.sessionId) return { state, render: null };
  if (msg.sessionId !== state.sessionId) return { state, render: null };
  const cur = state.pending;
  if (!cur || cur.attempt !== msg.attempt || cur.target.seq !== msg.seq) {
    return { state, render: null };
  }
  if (cur.target.page !== msg.page || cur.target.blackout !== msg.blackout) {
    return { state, render: null };
  }
  if (state.stage === 'displayed') {
    // 重复 SHOW（如另一侧迟到导致的重发）：画面不动，调用方直接重放 SHOWN。
    return { state, render: null };
  }
  if (state.stage !== 'prepared') return { state, render: null };
  return {
    state: { ...state, stage: 'showing' },
    render: cur.target
  };
}

/** displayed 阶段收到重复 SHOW 时，调用方据此重放 SHOWN（画面不动）。 */
export function replayShown(state: DualViewerState): Ack | null {
  if (state.stage !== 'displayed' || !state.pending || !state.sessionId) return null;
  const { target, attempt } = state.pending;
  return {
    kind: 'ACK',
    sessionId: state.sessionId,
    seq: target.seq,
    viewerId: state.viewerId,
    ok: true,
    page: target.page,
    blackout: target.blackout,
    stage: 'shown',
    attempt,
    role: state.role
  };
}

function shownAck(
  state: DualViewerState,
  target: RenderTarget,
  attempt: number,
  ok: boolean
): Ack {
  const sessionId = state.sessionId!;
  if (ok) {
    return {
      kind: 'ACK',
      sessionId,
      seq: target.seq,
      viewerId: state.viewerId,
      ok: true,
      page: target.page,
      blackout: target.blackout,
      stage: 'shown',
      attempt,
      role: state.role
    };
  }
  return {
    kind: 'ACK',
    sessionId,
    seq: target.seq,
    viewerId: state.viewerId,
    ok: false,
    reason: 'IMAGE_FAILED',
    target: { page: target.page, blackout: target.blackout },
    page: state.frame?.page ?? 0,
    blackout: state.frame?.blackout ?? false,
    stage: 'shown',
    attempt,
    role: state.role
  };
}

export interface ShowResult {
  state: DualViewerState;
  ack: Ack;
}

/**
 * 切换结果回调：
 *  - 成功：display 切到目标帧，进入 displayed，回报 SHOWN ok（尚未固化，
 *    必须等 CONFIRMED 才更新 frame/appliedSeq）；
 *  - 失败：画面与序号回退到权威帧，清空未决，回报 SHOWN ok:false；
 *    同序号的下一轮尝试仍可被接受。
 * 旧尝试/旧目标的迟到结果一律丢弃。
 */
export function resolveShow(
  state: DualViewerState,
  target: RenderTarget,
  attempt: number,
  ok: boolean
): ShowResult | null {
  const cur = state.pending;
  if (!cur || state.stage !== 'showing') return null;
  if (cur.attempt !== attempt || !sameTarget(cur.target, target)) return null;
  if (ok) {
    const display: ConfirmedFrame = {
      seq: target.seq,
      page: target.page,
      blackout: target.blackout
    };
    const next: DualViewerState = { ...state, display, stage: 'displayed' };
    return { state: next, ack: shownAck(next, target, attempt, true) };
  }
  // 显示失败：回退到上一张已确认画面，清空未决（下一轮同序号尝试可再接受）。
  const fallback = state.frame ?? { seq: 0, page: 0, blackout: false };
  const next: DualViewerState = {
    ...state,
    display: { ...fallback },
    stage: 'idle',
    pending: null
  };
  return { state: next, ack: shownAck(state, target, attempt, false) };
}

export interface AbortResult {
  state: DualViewerState;
  /** 调用方必须把穹顶重绘回权威帧（此前已 displayed 时）；否则无需动画面。 */
  repaintConfirmed: boolean;
}

/**
 * ABORT：仅当会话/序号/尝试与当前未决一致时生效。
 * 已显示的一侧（displayed/showing）回到上一张已确认画面；其它阶段只清理
 * 装载状态。旧 attempt 的迟到 ABORT 不得影响新一轮尝试。
 */
export function receiveAbort(state: DualViewerState, msg: AbortMessage): AbortResult {
  if (state.phase !== 'live' || !state.sessionId) return { state, repaintConfirmed: false };
  if (msg.sessionId !== state.sessionId) return { state, repaintConfirmed: false };
  const cur = state.pending;
  if (!cur || cur.attempt !== msg.attempt || cur.target.seq !== msg.seq) {
    return { state, repaintConfirmed: false };
  }
  if (cur.target.page !== msg.page || cur.target.blackout !== msg.blackout) {
    return { state, repaintConfirmed: false };
  }
  const needsRepaint = state.stage === 'displayed' || state.stage === 'showing';
  const fallback = state.frame ?? { seq: state.appliedSeq, page: 0, blackout: false };
  return {
    state: {
      ...state,
      stage: 'idle',
      pending: null,
      display: { ...fallback }
    },
    repaintConfirmed: needsRepaint
  };
}

/**
 * CONFIRMED：权威固化。仅接受与当前 displayed 画面完全一致（序号+画面）
 * 的确认；迟到的/异会话的确认一律忽略。固化后 appliedSeq 前进、未决清空。
 */
export function receiveConfirmed(
  state: DualViewerState,
  msg: ConfirmedMessage
): DualViewerState {
  if (state.phase !== 'live' || !state.sessionId) return state;
  if (msg.sessionId !== state.sessionId) return state;
  if (state.stage !== 'displayed' || !state.pending) return state;
  const { target } = state.pending;
  if (target.seq !== msg.seq || target.page !== msg.page || target.blackout !== msg.blackout) {
    return state;
  }
  const frame: ConfirmedFrame = { seq: msg.seq, page: msg.page, blackout: msg.blackout };
  return {
    ...state,
    frame,
    display: frame,
    appliedSeq: msg.seq,
    stage: 'idle',
    pending: null
  };
}

/** 停映：一切未决尝试作废，持续黑屏。 */
export function endDual(state: DualViewerState, sessionId: string): DualViewerState {
  if (state.sessionId !== sessionId) return state;
  return {
    ...state,
    phase: 'ended',
    sessionId: null,
    appliedSeq: -1,
    frame: null,
    display: null,
    stage: 'idle',
    pending: null
  };
}

function sameTarget(a: RenderTarget, b: RenderTarget): boolean {
  return a.seq === b.seq && a.page === b.page && a.blackout === b.blackout;
}
