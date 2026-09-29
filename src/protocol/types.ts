/**
 * 穹顶讲解协议 (Dome Protocol)
 *
 * 权威状态 (authoritative state) 永远保存在讲解员控制台：
 *   - lastConfirmed: 观众窗最近一次成功呈现并确认的完整画面（页 + 遮黑）
 *   - pending:       已发出、等待确认的命令（待确认 -> 已确认 / 未确认 / 呈现失败）
 *
 * 消息经 BroadcastChannel 传递；图片本体不经消息传递，观众窗直接从同源
 * IndexedDB 按 blobId 读取。
 */

export type BlackoutState = boolean;

/** 节目单中的一个图片项。decodeFailed 仅标记该项，不影响其它项。 */
export interface SlideItem {
  id: string;
  blobId: string;
  name: string;
  type: string;
  size: number;
  decodeFailed?: boolean;
}

export interface Program {
  items: SlideItem[];
}

/**
 * 确认模式：
 *  - single：原单屏流程（CMD → 观众窗直接呈现 → ACK 确认），完全兼容；
 *  - dual：正式讲解的双屏确认模式（主投影 + 备用投影）。两侧先分别装载并
 *    回报准备完成，控制台收到两侧匹配的准备回执后才下发 SHOW；只有两侧
 *    显示回执均匹配且权威状态落库成功，控制台才推进权威画面（随后广播
 *    CONFIRMED）。任一阶段失败/超时都会令已先行显示的一侧回滚到上一张
 *    已确认画面。
 */
export type ConfirmMode = 'single' | 'dual';

/** 双屏模式下的固定角色：主投影 / 备用投影。 */
export type ScreenRole = 'main' | 'backup';
export const SCREEN_ROLES: readonly ScreenRole[] = ['main', 'backup'];

/** 双屏命令每个阶段、每块屏幕的回执进度（只在内存中维护，刷新即作废）。 */
export interface DualProgress {
  main: boolean;
  backup: boolean;
}

/** 已冻结的放映会话（放映开始后节目单不可再修订，编辑只写入草稿供下一会话）。 */
export interface SessionRecord {
  sessionId: string;
  startedAt: number;
  running: boolean;
  frozenProgram: Program;
  /** 权威画面：最近一次被观众窗确认呈现的完整快照。 */
  lastConfirmed: ConfirmedFrame;
  pending: PendingCommand | null;
  /** 确认模式；旧记录反序列化缺省为 single（原单屏流程兼容）。 */
  mode?: ConfirmMode;
}

export interface ConfirmedFrame {
  /** 产生该画面的命令序号；0 表示会话初始快照（尚未发出任何命令）。 */
  seq: number;
  page: number;
  blackout: boolean;
}

/**
 * 未决命令状态：
 *  - single 模式：pending（待 ACK）/ unconfirmed（超时）/ failed（呈现失败）；
 *  - dual 模式新增：
 *    preparing —— CMD（装载阶段）已发出，等待两侧 PREPARED；
 *    partial   —— SHOW 已发出，只有一侧回报了 SHOWN（部分显示）。
 */
export type PendingStatus =
  | 'pending'
  | 'preparing'
  | 'partial'
  | 'unconfirmed'
  | 'failed';

export interface PendingCommand {
  seq: number;
  action: CommandAction;
  /** 命令所指向的完整画面（绝对状态，观众窗即使漏掉中间命令也能直接呈现）。 */
  target: { page: number; blackout: boolean };
  status: PendingStatus;
  issuedAt: number;
  attempts: number;
  /**
   * 双屏确认模式的阶段进度（仅 mode==='dual' 存在；纯内存的临时状态，
   * 控制台刷新恢复后由控制器清空——重试必须重新取得新一轮回执，
   * 绝不借用刷新前的旧回执）。
   */
  dual?: {
    /** 本尝试（attempts）下两侧 PREPARED 回执。 */
    prepared: DualProgress;
    /** 本尝试（attempts）下两侧 SHOWN 回执。 */
    shown: DualProgress;
  };
}

export type CommandAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; page: number }
  | { type: 'setBlackout'; blackout: boolean };

/**
 * 控制台 -> 观众窗。viewerId 存在时为定向补发（重试/晚到观众窗快照后补发）。
 * single 模式：无 phase/attempt 字段（旧消息形状），观众窗收到即呈现。
 * dual 模式：phase='prepare'，要求观众窗预装载（不切换画面）并回报 PREPARED；
 *            attempt 标识本次尝试，观众窗据此丢弃上一轮尝试的所有旧回执触发源。
 */
export interface CommandMessage {
  kind: 'CMD';
  sessionId: string;
  seq: number;
  action: CommandAction;
  page: number;
  blackout: boolean;
  viewerId?: string;
  phase?: 'prepare';
  attempt?: number;
}

/** dual 模式：控制台 -> 观众窗。两侧准备回执齐备后下发，观众窗才真正切换画面。 */
export interface ShowMessage {
  kind: 'SHOW';
  sessionId: string;
  seq: number;
  page: number;
  blackout: boolean;
  attempt: number;
}

/**
 * dual 模式：控制台 -> 观众窗。任一侧失败、超时或权威落库失败时下发，
 * 已先行显示目标画面的一侧必须回到上一张已确认画面；未切换的一侧仅清理
 * 装载状态。attempt 与当前尝试不符时忽略（迟到 ABORT 不得回滚新一轮尝试）。
 */
export interface AbortMessage {
  kind: 'ABORT';
  sessionId: string;
  seq: number;
  page: number;
  blackout: boolean;
  attempt: number;
}

/**
 * dual 模式：控制台 -> 观众窗。两侧 SHOWN 匹配且权威状态持久化成功后广播，
 * 表示该序号画面已成为权威；观众窗据此把当前显示固化为已确认帧。
 */
export interface ConfirmedMessage {
  kind: 'CONFIRMED';
  sessionId: string;
  seq: number;
  page: number;
  blackout: boolean;
}

/**
 * 观众窗 -> 控制台。
 * single 模式：无 stage/attempt/role（旧形状），呈现完成即发。
 * dual 模式：
 *  - stage='prepared'：预装载完成，画面尚未切换（或失败：未改变画面）；
 *  - stage='shown'：已真正切换到目标画面（或失败：已回滚到最后确认帧）。
 *  回执同时携带 attempt，控制台只接受与当前未决尝试一致的回执
 *  （重试产生新 attempt，旧回执一律不得推进新命令）。
 */
export interface AckMessage {
  kind: 'ACK';
  sessionId: string;
  seq: number;
  viewerId: string;
  ok: true;
  page: number;
  blackout: boolean;
  stage?: 'prepared' | 'shown';
  attempt?: number;
  role?: ScreenRole;
}

export interface FailAckMessage {
  kind: 'ACK';
  sessionId: string;
  seq: number;
  viewerId: string;
  ok: false;
  reason: 'IMAGE_FAILED';
  /** 该失败确认所尝试呈现的目标画面；控制台必须与当前 pending.target 完全一致才接受。 */
  target: { page: number; blackout: boolean };
  /** 呈现失败时观众窗实际仍停留的画面（最后成功页）。 */
  page: number;
  blackout: boolean;
  stage?: 'prepared' | 'shown';
  attempt?: number;
  role?: ScreenRole;
}

export type Ack = AckMessage | FailAckMessage;

export interface SnapshotRequest {
  kind: 'SNAPSHOT_REQ';
  sessionId?: string;
  viewerId: string;
  /** dual 模式下观众窗申报的角色（主/备）；single 模式可缺省。 */
  role?: ScreenRole;
}

export interface SnapshotResponse {
  kind: 'SNAPSHOT_RES';
  sessionId: string;
  running: boolean;
  confirmed: ConfirmedFrame;
  pending: PendingCommand | null;
  /** 应答的目标观众窗；其它窗口忽略，避免多控制台抢答时串台。 */
  viewerId: string;
  /** 本场放映的确认模式；观众窗恢复后据此选择 single/dual 协议路径。 */
  mode?: ConfirmMode;
  /** dual 模式下控制台为本窗口分配的角色。 */
  role?: ScreenRole;
}

/** 控制台通知所有观众窗会话结束（停映）。 */
export interface SessionEnded {
  kind: 'SESSION_ENDED';
  sessionId: string;
}

export type WireMessage =
  | CommandMessage
  | ShowMessage
  | AbortMessage
  | ConfirmedMessage
  | Ack
  | SnapshotRequest
  | SnapshotResponse
  | SessionEnded;

export const INITIAL_SEQ = 0;
export const DEFAULT_ACK_TIMEOUT_MS = 2000;

export function initialConfirmed(pageCount: number): ConfirmedFrame {
  // 空节目单不允许开始放映；page 固定 0（首页），不遮黑。
  void pageCount;
  return { seq: INITIAL_SEQ, page: 0, blackout: false };
}

/** 新一轮尝试开始时两侧回执均为空——重试绝不借用旧回执。 */
export function emptyDualProgress(): DualProgress {
  return { main: false, backup: false };
}

export function isDual(session: SessionRecord | null | undefined): boolean {
  return session?.mode === 'dual';
}

export function makeSessionId(now = Date.now()): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `sess_${now.toString(36)}_${rand}`;
}
