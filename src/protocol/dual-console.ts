/**
 * 控制台侧“双屏确认模式”协议状态机（纯函数，便于 Vitest 核验）。
 *
 * 正式讲解时主投影（main）与备用投影（backup）同时工作，一次切换必须走完
 * 两阶段握手，控制台才会推进权威画面：
 *
 *   CMD(phase=prepare, attempt=N)
 *       ├─ main   PREPARED ─┐
 *       └─ backup PREPARED ─┤ 两侧准备回执匹配（会话/序号/目标/尝试）
 *                           ▼
 *   SHOW(attempt=N)
 *       ├─ main   SHOWN ───┐
 *       └─ backup SHOWN ───┤ 两侧显示回执匹配
 *                           ▼
 *                   权威状态落库（由控制器完成）
 *                           ▼
 *                   CONFIRMED 广播（固化两侧画面）
 *
 * 任一阶段出现：单侧失败、超时、或最终权威持久化失败 —— 命令保持未确认，
 * 已先行显示的一侧经 ABORT(attempt=N) 回到上一张已确认画面。重试递增 attempt，
 * 旧 attempt 的一切迟到回执都不得推进新命令。
 */
import {
  AbortMessage,
  Ack,
  CommandAction,
  CommandMessage,
  ConfirmedFrame,
  DualProgress,
  PendingCommand,
  ScreenRole,
  SessionRecord,
  ShowMessage,
  emptyDualProgress
} from './types';
import { propose } from './console';

export interface DualIssueResult {
  session: SessionRecord;
  /** 装载阶段命令（phase=prepare）；空操作/叠加拒绝时为 null。 */
  command: CommandMessage | null;
  noop?: boolean;
}

function buildPrepareCommand(session: SessionRecord, p: PendingCommand): CommandMessage {
  return {
    kind: 'CMD',
    sessionId: session.sessionId,
    seq: p.seq,
    action: p.action,
    page: p.target.page,
    blackout: p.target.blackout,
    phase: 'prepare',
    attempt: p.attempts
  };
}

/** 双屏模式开始一条切换：进入 preparing，两侧回执为空（不借用任何旧回执）。 */
export function issueDual(
  session: SessionRecord,
  action: CommandAction,
  now = Date.now(),
  pageCount = session.frozenProgram.items.length
): DualIssueResult {
  if (!session.running) throw new Error('会话未在放映中');
  if (session.mode !== 'dual') throw new Error('非双屏确认模式会话');
  if (session.pending) {
    // 任一未决阶段（装载中/部分显示/未确认/失败）都不接受叠加新命令；
    // failed 可被讲解员的下一条命令沿同序号取代（与单屏语义一致，坏图不锁场）。
    if (session.pending.status !== 'failed') return { session, command: null };
  }

  const target = propose(session.lastConfirmed, action, pageCount);
  if (
    target.page === session.lastConfirmed.page &&
    target.blackout === session.lastConfirmed.blackout
  ) {
    return { session, command: null, noop: true };
  }

  const seq = session.lastConfirmed.seq + 1;
  const pending: PendingCommand = {
    seq,
    action,
    target,
    status: 'preparing',
    issuedAt: now,
    attempts: 1,
    dual: { prepared: emptyDualProgress(), shown: emptyDualProgress() }
  };
  const next = { ...session, pending };
  return { session: next, command: buildPrepareCommand(next, pending) };
}

/**
 * 重试（超时/未确认/失败/部分显示后均可）：沿用原序号，但 attempts 递增，
 * 两侧 PREPARED/SHOWN 进度全部清空——新的一轮握手绝不复用旧回执。
 */
export function retryDual(session: SessionRecord, now = Date.now()): DualIssueResult {
  const p = session.pending;
  if (!p || session.mode !== 'dual') return { session, command: null };
  const pending: PendingCommand = {
    ...p,
    status: 'preparing',
    attempts: p.attempts + 1,
    issuedAt: now,
    dual: { prepared: emptyDualProgress(), shown: emptyDualProgress() }
  };
  const next = { ...session, pending };
  return { session: next, command: buildPrepareCommand(next, pending) };
}

/** 双屏模式的超时判定：preparing 与 partial（部分显示）都受超时约束。 */
export function expireDualPending(
  session: SessionRecord,
  now = Date.now(),
  timeoutMs: number
): SessionRecord {
  const p = session.pending;
  if (!p) return session;
  if (p.status !== 'preparing' && p.status !== 'partial') return session;
  if (now - p.issuedAt < timeoutMs) return session;
  // 超时只改标记、清空两侧临时回执进度，绝不改变 lastConfirmed；
  // 是否下发 ABORT（让已显示侧回滚）由控制器决定。
  return {
    ...session,
    pending: { ...p, status: 'unconfirmed', dual: p.dual ? { ...p.dual } : undefined }
  };
}

function ackMatchesTarget(ack: Ack, p: PendingCommand): boolean {
  if (!ack.ok) {
    return ack.target.page === p.target.page && ack.target.blackout === p.target.blackout;
  }
  return ack.page === p.target.page && ack.blackout === p.target.blackout;
}

/**
 * 回执的“新鲜度”闸门：会话、序号、尝试（attempt）、角色（role）、阶段目标
 * 全部匹配当前未决命令才有效。重试产生新 attempt 后，上一轮尝试的迟到、重复
 * 回执一律返回 null（旧回执不可能推进新命令）。
 */
function validateReceipt(
  session: SessionRecord,
  ack: Ack,
  stage: 'prepared' | 'shown'
): { pending: PendingCommand; role: ScreenRole } | null {
  if (ack.sessionId !== session.sessionId) return null;
  const p = session.pending;
  if (!p || !p.dual) return null;
  if (ack.seq !== p.seq) return null;
  if (ack.attempt !== p.attempts || ack.stage !== stage) return null;
  const role = ack.role;
  if (role !== 'main' && role !== 'backup') return null;
  if (!ackMatchesTarget(ack, p)) return null;
  return { pending: p, role };
}

function withProgress(
  session: SessionRecord,
  patch: (dual: NonNullable<PendingCommand['dual']>) => DualProgress,
  shown: boolean
): SessionRecord {
  const p = session.pending!;
  const dual: NonNullable<PendingCommand['dual']> = {
    prepared: { ...p.dual!.prepared },
    shown: { ...p.dual!.shown }
  };
  const next = patch(dual);
  if (shown) dual.shown = next;
  else dual.prepared = next;
  return { ...session, pending: { ...p, dual } };
}

export interface PreparedAckResult {
  session: SessionRecord;
  /** 两侧准备回执均已匹配：控制器应下发 SHOW。 */
  show: ShowMessage | null;
  /** 准备失败：控制器应先持久化未确认回滚态，再向两侧下发 ABORT。 */
  rollback: AbortMessage | null;
}

/**
 * 处理一条 PREPARED 回执。
 *  - 两侧成功回执齐备：返回 SHOW（控制台才允许要求观众窗切换画面）；
 *  - 任一侧准备失败（图片无法装载）：目标画面尚未在任何一侧切换，
 *    命令转 failed，控制器清理两侧装载状态（ABORT，无画面回滚动作）；
 *  - 迟到/重复/异会话/旧 attempt：返回同一 session（无 show/rollback），
 *    但两侧齐备瞬间的重复回执由控制器负责幂等重发 SHOW（见 controller）。
 */
export function receivePreparedAck(session: SessionRecord, ack: Ack): PreparedAckResult {
  const v = validateReceipt(session, ack, 'prepared');
  if (!v) return { session, show: null, rollback: null };
  const p = v.pending;
  if (p.status !== 'preparing') return { session, show: null, rollback: null };

  if (!ack.ok) {
    const failed: SessionRecord = { ...session, pending: { ...p, status: 'failed' } };
    return {
      session: failed,
      show: null,
      rollback: buildAbort(failed, failed.pending!)
    };
  }

  const next = withProgress(
    session,
    (dual) => ({ ...dual.prepared, [v.role]: true }),
    false
  );
  const np = next.pending!;
  if (np.dual!.prepared.main && np.dual!.prepared.backup) {
    const shown: SessionRecord = { ...next, pending: { ...np, status: 'partial' } };
    return { session: shown, show: buildShow(shown, shown.pending!), rollback: null };
  }
  return { session: next, show: null, rollback: null };
}

export interface ShownAckResult {
  /** 计入该回执但尚未齐备时的会话；齐备时为携带新权威帧的会话（待控制器落库）。 */
  session: SessionRecord;
  /** 两侧 SHOWN 齐备：lastConfirmed 已前进、pending 已清空；控制器必须先落库。 */
  confirmed: boolean;
  /** 单侧显示失败：控制器持久化未确认回滚态后向两侧下发 ABORT。 */
  rollback: AbortMessage | null;
}

/**
 * 处理一条 SHOWN 回执。
 *  - 单侧失败（该侧呈现失败、已自行回滚到最后确认帧）：另一可能已显示的侧
 *    必须经 ABORT 回到上一张已确认画面；命令转 failed，权威不变；
 *  - 两侧成功且目标匹配：生成新的 lastConfirmed 并清空 pending。
 *    注意：本函数只计算目标状态，真正“宣布已确认”必须等控制器把该状态
 *    持久化成功，随后广播 CONFIRMED；持久化失败时控制器改为下发 ABORT。
 */
export function receiveShownAck(session: SessionRecord, ack: Ack): ShownAckResult {
  const v = validateReceipt(session, ack, 'shown');
  if (!v) return { session, confirmed: false, rollback: null };
  const p = v.pending;
  if (p.status !== 'partial') return { session, confirmed: false, rollback: null };

  if (!ack.ok) {
    const failed: SessionRecord = { ...session, pending: { ...p, status: 'failed' } };
    return { session: failed, confirmed: false, rollback: buildAbort(failed, failed.pending!) };
  }

  const next = withProgress(session, (dual) => ({ ...dual.shown, [v.role]: true }), true);
  const np = next.pending!;
  if (np.dual!.shown.main && np.dual!.shown.backup) {
    const confirmed: ConfirmedFrame = {
      seq: np.seq,
      page: np.target.page,
      blackout: np.target.blackout
    };
    return {
      session: { ...next, lastConfirmed: confirmed, pending: null },
      confirmed: true,
      rollback: null
    };
  }
  return { session: next, confirmed: false, rollback: null };
}

/**
 * 两侧 SHOWN 已匹配、但权威状态持久化失败时的回滚会话：
 * 权威画面保持不变，命令回到未确认（讲解员显式重试，attempt 递增）。
 */
export function rollbackAfterConfirmFailure(session: SessionRecord): {
  session: SessionRecord;
  abort: AbortMessage;
} {
  const p = session.pending;
  if (!p) throw new Error('无未决命令可回滚');
  const next: SessionRecord = { ...session, pending: { ...p, status: 'unconfirmed' } };
  return { session: next, abort: buildAbort(next, next.pending!) };
}

function buildShow(session: SessionRecord, p: PendingCommand): ShowMessage {
  return {
    kind: 'SHOW',
    sessionId: session.sessionId,
    seq: p.seq,
    page: p.target.page,
    blackout: p.target.blackout,
    attempt: p.attempts
  };
}

function buildAbort(session: SessionRecord, p: PendingCommand): AbortMessage {
  return {
    kind: 'ABORT',
    sessionId: session.sessionId,
    seq: p.seq,
    page: p.target.page,
    blackout: p.target.blackout,
    attempt: p.attempts
  };
}
