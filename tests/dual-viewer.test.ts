import { describe, expect, it } from 'vitest';
import {
  AbortMessage,
  CommandMessage,
  ConfirmedMessage,
  ConfirmedFrame,
  ShowMessage
} from '../src/protocol/types';
import {
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
} from '../src/protocol/dual-viewer';

const SESSION = 'sess_dual';

function snapshot(
  viewerId: string,
  role: 'main' | 'backup',
  frame: ConfirmedFrame = { seq: 0, page: 0, blackout: false }
) {
  return {
    kind: 'SNAPSHOT_RES' as const,
    sessionId: SESSION,
    running: true,
    confirmed: frame,
    pending: null,
    viewerId,
    mode: 'dual' as const,
    role
  };
}

function recovered(role: 'main' | 'backup' = 'main', frame?: ConfirmedFrame): DualViewerState {
  const id = `v-${role}`;
  let v = initDualViewer(id, role);
  v = beginDualRecovery(v);
  v = applyDualSnapshot(v, snapshot(id, role, frame));
  return v;
}

function prepare(
  seq: number,
  page: number,
  attempt: number,
  blackout = false,
  sid = SESSION
): CommandMessage {
  return {
    kind: 'CMD',
    sessionId: sid,
    seq,
    action: { type: 'goto', page },
    page,
    blackout,
    phase: 'prepare',
    attempt
  };
}

function show(seq: number, page: number, attempt: number, blackout = false): ShowMessage {
  return { kind: 'SHOW', sessionId: SESSION, seq, page, blackout, attempt };
}

function abort(seq: number, page: number, attempt: number, blackout = false): AbortMessage {
  return { kind: 'ABORT', sessionId: SESSION, seq, page, blackout, attempt };
}

/** 驱动一次完整 prepare→show 成功，返回 displayed 状态。 */
function driveDisplayed(v: DualViewerState, seq: number, page: number, attempt = 1) {
  const a = receivePrepareCommand(v, prepare(seq, page, attempt));
  expect(a.preload).not.toBeNull();
  v = a.state;
  expect(v.stage).toBe('preparing');
  const p = resolvePrepare(v, a.preload!, attempt, true)!;
  v = p.state;
  expect(v.stage).toBe('prepared');
  expect(p.ack).toMatchObject({ ok: true, stage: 'prepared', attempt });
  const sh = receiveShow(v, show(seq, page, attempt));
  expect(sh.render).not.toBeNull();
  v = sh.state;
  expect(v.stage).toBe('showing');
  const done = resolveShow(v, sh.render!, attempt, true)!;
  v = done.state;
  expect(v.stage).toBe('displayed');
  expect(done.ack).toMatchObject({ ok: true, stage: 'shown', attempt });
  return v;
}

describe('双屏观众窗：恢复', () => {
  it('启动进入恢复态、画面为空；快照恢复后显示权威帧、stage=idle', () => {
    const v0 = beginDualRecovery(initDualViewer('v-main', 'main'));
    expect(v0.phase).toBe('recovering');
    expect(v0.display).toBeNull();
    const v = recovered('main', { seq: 3, page: 3, blackout: true });
    expect(v.phase).toBe('live');
    expect(v.appliedSeq).toBe(3);
    expect(v.frame).toEqual({ seq: 3, page: 3, blackout: true });
    expect(v.display).toEqual({ seq: 3, page: 3, blackout: true });
    expect(v.stage).toBe('idle');
  });

  it('定向给其它窗口/非恢复态的快照被忽略', () => {
    let v = beginDualRecovery(initDualViewer('v-main', 'main'));
    expect(applyDualSnapshot(v, snapshot('v-backup', 'backup')).phase).toBe('recovering');
    v = applyDualSnapshot(v, snapshot('v-main', 'main'));
    // 已 live 后再来快照不覆盖
    expect(applyDualSnapshot(v, snapshot('v-main', 'main', { seq: 9, page: 9, blackout: false }))).toBe(v);
  });
});

describe('双屏观众窗：两阶段呈现', () => {
  it('prepare 只进入 preparing，display 仍是权威帧（屏幕未切换）', () => {
    const v0 = recovered();
    const a = receivePrepareCommand(v0, prepare(1, 1, 1));
    expect(a.preload).toEqual({ seq: 1, page: 1, blackout: false });
    expect(a.state.stage).toBe('preparing');
    expect(a.state.display).toEqual({ seq: 0, page: 0, blackout: false });
    expect(a.state.appliedSeq).toBe(0); // 权威序号未前进
  });

  it('prepared 阶段收到 SHOW 才真正切换；SHOWN 时仍未固化', () => {
    let v = recovered();
    v = driveDisplayed(v, 1, 1, 1);
    expect(v.display).toEqual({ seq: 1, page: 1, blackout: false });
    expect(v.frame).toEqual({ seq: 0, page: 0, blackout: false }); // 权威帧不变
    expect(v.appliedSeq).toBe(0);
  });

  it('CONFIRMED 匹配后才固化为权威帧、appliedSeq 前进', () => {
    let v = recovered();
    v = driveDisplayed(v, 1, 1, 1);
    const msg: ConfirmedMessage = { kind: 'CONFIRMED', sessionId: SESSION, seq: 1, page: 1, blackout: false };
    v = receiveConfirmed(v, msg);
    expect(v.frame).toEqual({ seq: 1, page: 1, blackout: false });
    expect(v.appliedSeq).toBe(1);
    expect(v.stage).toBe('idle');
    expect(v.pending).toBeNull();
  });

  it('未 displayed/画面不符的 CONFIRMED 一律忽略', () => {
    const v = recovered();
    const bad = receiveConfirmed(v, { kind: 'CONFIRMED', sessionId: SESSION, seq: 1, page: 1, blackout: false });
    expect(bad).toBe(v);
  });
});

describe('双屏观众窗：失败与回滚', () => {
  it('装载失败：画面不离开权威帧，回报失败 PREPARED', () => {
    let v = recovered();
    const a = receivePrepareCommand(v, prepare(1, 1, 1));
    v = a.state;
    const r = resolvePrepare(v, a.preload!, 1, false)!;
    v = r.state;
    expect(v.stage).toBe('failed-prepare');
    expect(v.display).toEqual({ seq: 0, page: 0, blackout: false });
    expect(r.ack.ok).toBe(false);
    expect(r.ack).toMatchObject({ stage: 'prepared', attempt: 1 });
  });

  it('已显示后 ABORT：回到上一张已确认画面并要求重绘，未决清空', () => {
    let v = recovered();
    v = driveDisplayed(v, 1, 1, 1);
    const r = receiveAbort(v, abort(1, 1, 1));
    expect(r.state).not.toBe(v);
    expect(r.repaintConfirmed).toBe(true);
    expect(r.state.display).toEqual({ seq: 0, page: 0, blackout: false });
    expect(r.state.frame).toEqual({ seq: 0, page: 0, blackout: false });
    expect(r.state.pending).toBeNull();
  });

  it('准备阶段 ABORT：只需清理状态、无需重绘（画面从未切换）', () => {
    let v = recovered();
    const a = receivePrepareCommand(v, prepare(1, 1, 1));
    v = a.state;
    const prepared = resolvePrepare(v, a.preload!, 1, true)!.state;
    const r = receiveAbort(prepared, abort(1, 1, 1));
    expect(r.state.stage).toBe('idle');
    expect(r.repaintConfirmed).toBe(false);
  });

  it('显示失败：自行回退到权威帧并回报失败 SHOWN，同序号下轮可再接受', () => {
    let v = recovered();
    const a = receivePrepareCommand(v, prepare(1, 1, 1));
    v = resolvePrepare(a.state, a.preload!, 1, true)!.state;
    const sh = receiveShow(v, show(1, 1, 1));
    v = sh.state;
    const r = resolveShow(v, sh.render!, 1, false)!;
    expect(r.ack.ok).toBe(false);
    expect(r.ack).toMatchObject({ stage: 'shown', target: { page: 1, blackout: false } });
    expect(r.state.display).toEqual({ seq: 0, page: 0, blackout: false });
    expect(r.state.pending).toBeNull();
    // 新一轮同序号尝试（attempt=2）可再次接受
    const again = receivePrepareCommand(r.state, prepare(1, 1, 2));
    expect(again.preload).not.toBeNull();
  });
});

describe('双屏观众窗：重试与旧 attempt 消息', () => {
  it('同序号新 attempt 的 prepare：先回权威帧，再重新装载', () => {
    let v = driveDisplayed(recovered(), 1, 1, 1);
    // 控制台重试：seq 仍为 1，attempt=2
    const a = receivePrepareCommand(v, prepare(1, 1, 2));
    expect(a.preload).not.toBeNull();
    expect(a.state.pending?.attempt).toBe(2);
    expect(a.state.display).toEqual({ seq: 0, page: 0, blackout: false });
  });

  it('同序号同 attempt 的重复 prepare 幂等忽略（不重复装载/回执）', () => {
    let v = recovered();
    v = receivePrepareCommand(v, prepare(1, 1, 1)).state;
    const dup = receivePrepareCommand(v, prepare(1, 1, 1));
    expect(dup.preload).toBeNull();
    expect(dup.state).toBe(v);
  });

  it('旧 attempt 的 SHOW / ABORT 不得影响新一轮', () => {
    let v = driveDisplayed(recovered(), 1, 1, 1);
    v = receivePrepareCommand(v, prepare(1, 1, 2)).state; // 已进入新一轮 preparing
    // 旧 attempt=1 的 ABORT 不能回滚新一轮
    const staleAbort = receiveAbort(v, abort(1, 1, 1));
    expect(staleAbort.state).toBe(v);
    // 旧 attempt=1 的 SHOW 无效
    const staleShow = receiveShow(v, show(1, 1, 1));
    expect(staleShow.render).toBeNull();
  });

  it('displayed 阶段重复 SHOW：画面不动、重放 SHOWN（幂等）', () => {
    const v = driveDisplayed(recovered(), 1, 1, 1);
    const again = receiveShow(v, show(1, 1, 1));
    expect(again.render).toBeNull();
    expect(again.state).toBe(v);
    const replay = replayShown(v);
    expect(replay).toMatchObject({ ok: true, stage: 'shown', attempt: 1, seq: 1 });
  });
});

describe('双屏观众窗：序号、会话与跳号', () => {
  it('更旧命令与跳号命令被忽略', () => {
    let v = recovered('main', { seq: 2, page: 2, blackout: false });
    expect(receivePrepareCommand(v, prepare(1, 1, 1)).preload).toBeNull();
    expect(receivePrepareCommand(v, prepare(4, 4, 1)).preload).toBeNull();
    expect(receivePrepareCommand(v, prepare(3, 3, 1)).preload).not.toBeNull();
  });

  it('其它会话的消息一律无效', () => {
    const v = recovered();
    expect(receivePrepareCommand(v, prepare(1, 1, 1, false, 'other')).preload).toBeNull();
    expect(
      receiveAbort(v, { ...abort(1, 1, 1), sessionId: 'other' }).state
    ).toBe(v);
  });

  it('非恢复态、非 prepare 形状的 CMD 被忽略', () => {
    const v = recovered();
    const oldStyle: CommandMessage = {
      kind: 'CMD',
      sessionId: SESSION,
      seq: 1,
      action: { type: 'goto', page: 1 },
      page: 1,
      blackout: false
    };
    expect(receivePrepareCommand(v, oldStyle).preload).toBeNull();
  });
});

describe('双屏观众窗：停映', () => {
  it('SESSION_ENDED 清空一切未决尝试与画面', () => {
    let v = driveDisplayed(recovered(), 1, 1, 1);
    v = endDual(v, SESSION);
    expect(v.phase).toBe('ended');
    expect(v.pending).toBeNull();
    expect(v.display).toBeNull();
  });
});
