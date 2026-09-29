import { describe, expect, it } from 'vitest';
import {
  AbortMessage,
  Ack,
  ConfirmedMessage,
  FailAckMessage,
  ShowMessage,
  makeSessionId
} from '../src/protocol/types';
import { startSession } from '../src/protocol/console';
import {
  expireDualPending,
  issueDual,
  receivePreparedAck,
  receiveShownAck,
  retryDual,
  rollbackAfterConfirmFailure
} from '../src/protocol/dual-console';
import { DEFAULT_ACK_TIMEOUT_MS } from '../src/protocol/types';

function fresh(pages = 5) {
  return startSession(makeSessionId(), pages, 1000, 'dual');
}

const prepared = (
  sid: string,
  seq: number,
  page: number,
  role: 'main' | 'backup',
  attempt = 1,
  blackout = false
): Ack => ({
  kind: 'ACK',
  sessionId: sid,
  seq,
  viewerId: `v-${role}`,
  ok: true,
  page,
  blackout,
  stage: 'prepared',
  attempt,
  role
});

const shown = (
  sid: string,
  seq: number,
  page: number,
  role: 'main' | 'backup',
  attempt = 1,
  blackout = false
): Ack => ({
  kind: 'ACK',
  sessionId: sid,
  seq,
  viewerId: `v-${role}`,
  ok: true,
  page,
  blackout,
  stage: 'shown',
  attempt,
  role
});

const failPrepared = (
  sid: string,
  seq: number,
  page: number,
  role: 'main' | 'backup',
  attempt = 1
): FailAckMessage => ({
  kind: 'ACK',
  sessionId: sid,
  seq,
  viewerId: `v-${role}`,
  ok: false,
  reason: 'IMAGE_FAILED',
  target: { page, blackout: false },
  page: 0,
  blackout: false,
  stage: 'prepared',
  attempt,
  role
});

const failShown = (
  sid: string,
  seq: number,
  page: number,
  role: 'main' | 'backup',
  attempt = 1
): FailAckMessage => ({
  ...failPrepared(sid, seq, page, role, attempt),
  stage: 'shown'
});

describe('双屏控制台：两阶段握手', () => {
  it('发命令进入 preparing，权威画面不变，CMD 为装载阶段且带 attempt', () => {
    const s0 = fresh();
    const r = issueDual(s0, { type: 'next' }, 1000);
    expect(r.command).toMatchObject({
      seq: 1,
      page: 1,
      phase: 'prepare',
      attempt: 1
    });
    expect(r.session.pending?.status).toBe('preparing');
    expect(r.session.pending?.dual).toEqual({
      prepared: { main: false, backup: false },
      shown: { main: false, backup: false }
    });
    expect(r.session.lastConfirmed).toEqual({ seq: 0, page: 0, blackout: false });
  });

  it('preparing/partial/unconfirmed 期间拒绝叠加命令', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    expect(issueDual(s, { type: 'next' }, 1001).command).toBeNull();
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main')).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'backup')).session;
    expect(s.pending?.status).toBe('partial');
    expect(issueDual(s, { type: 'next' }, 1002).command).toBeNull();
  });

  it('只有一侧准备回执：仍 preparing，不产生 SHOW', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    const r = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main'));
    expect(r.show).toBeNull();
    expect(r.session.pending?.status).toBe('preparing');
    expect(r.session.pending?.dual?.prepared.main).toBe(true);
    expect(r.session.pending?.dual?.prepared.backup).toBe(false);
  });

  it('两侧准备回执匹配：转 partial 并产出 SHOW（携带 attempt）', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main')).session;
    const r = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'backup'));
    expect(r.rollback).toBeNull();
    expect(r.show).toMatchObject<Partial<ShowMessage>>({
      kind: 'SHOW',
      seq: 1,
      page: 1,
      attempt: 1
    });
    expect(r.session.pending?.status).toBe('partial');
  });

  it('只有一侧 SHOWN：保持 partial、权威不变', () => {
    let s = fresh();
    s = issueDual(s, { type: 'goto', page: 2 }, 1000).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 2, 'main')).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 2, 'backup')).session;
    const r = receiveShownAck(s, shown(s.sessionId, 1, 2, 'main'));
    expect(r.confirmed).toBe(false);
    expect(r.rollback).toBeNull();
    expect(r.session.pending?.status).toBe('partial');
    expect(r.session.lastConfirmed.seq).toBe(0);
  });

  it('两侧 SHOWN 匹配：权威前进、未决清空（等待控制器落库后广播 CONFIRMED）', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main')).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'backup')).session;
    s = receiveShownAck(s, shown(s.sessionId, 1, 1, 'main')).session;
    const r = receiveShownAck(s, shown(s.sessionId, 1, 1, 'backup'));
    expect(r.confirmed).toBe(true);
    expect(r.session.lastConfirmed).toEqual({ seq: 1, page: 1, blackout: false });
    expect(r.session.pending).toBeNull();
  });

  it('准备阶段任一侧失败：转 failed 并产出 ABORT（目标尚未显示）', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main')).session;
    const r = receivePreparedAck(s, failPrepared(s.sessionId, 1, 1, 'backup'));
    expect(r.session.pending?.status).toBe('failed');
    expect(r.rollback).toMatchObject<Partial<AbortMessage>>({
      kind: 'ABORT',
      seq: 1,
      page: 1,
      attempt: 1
    });
    expect(r.session.lastConfirmed.seq).toBe(0);
  });

  it('部分显示时另一侧显示失败：转 failed 且必须 ABORT 已显示侧', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main')).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'backup')).session;
    // 主屏已切换
    s = receiveShownAck(s, shown(s.sessionId, 1, 1, 'main')).session;
    // 备屏显示失败：主屏必须回滚
    const r = receiveShownAck(s, failShown(s.sessionId, 1, 1, 'backup'));
    expect(r.session.pending?.status).toBe('failed');
    expect(r.rollback?.attempt).toBe(1);
    expect(r.session.lastConfirmed.seq).toBe(0);
  });

  it('两侧 SHOWN 齐备但持久化失败：rollbackAfterConfirmFailure 回未确认并 ABORT', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main')).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'backup')).session;
    s = receiveShownAck(s, shown(s.sessionId, 1, 1, 'main')).session;
    s = receiveShownAck(s, shown(s.sessionId, 1, 1, 'backup')).session;
    // 控制器场景：两侧齐备状态（lastConfirmed 已在纯函数内前进）；模拟落库失败时
    // 实际控制器用的是齐备前的 partial 会话，这里直接核验回滚助手语义。
    const partial: typeof s = {
      ...s,
      lastConfirmed: { seq: 0, page: 0, blackout: false },
      pending: {
        seq: 1,
        action: { type: 'next' },
        target: { page: 1, blackout: false },
        status: 'partial',
        issuedAt: 1000,
        attempts: 1,
        dual: {
          prepared: { main: true, backup: true },
          shown: { main: true, backup: true }
        }
      }
    };
    const rb = rollbackAfterConfirmFailure(partial);
    expect(rb.session.pending?.status).toBe('unconfirmed');
    expect(rb.session.lastConfirmed).toEqual({ seq: 0, page: 0, blackout: false });
    expect(rb.abort).toMatchObject({ kind: 'ABORT', seq: 1, attempt: 1 });
  });
});

describe('双屏控制台：重试不借用旧回执', () => {
  it('重试沿用 seq 但 attempts+1，两侧回执全部清空', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    s = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main')).session;
    const r = retryDual(s, 2000);
    expect(r.command?.seq).toBe(1);
    expect(r.command?.attempt).toBe(2);
    expect(r.session.pending?.attempts).toBe(2);
    expect(r.session.pending?.status).toBe('preparing');
    expect(r.session.pending?.dual?.prepared).toEqual({ main: false, backup: false });
    expect(r.session.pending?.dual?.shown).toEqual({ main: false, backup: false });
  });

  it('旧 attempt 的迟到回执（prepared/shown）不得推进新一轮', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    s = retryDual(s, 2000).session; // 现在 attempt=2
    // attempt=1 的迟到准备回执
    const stale = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main', 1));
    expect(stale.session).toBe(s);
    expect(stale.show).toBeNull();
    const staleShown = receiveShownAck(s, shown(s.sessionId, 1, 1, 'main', 1));
    expect(staleShown.session).toBe(s);
    expect(staleShown.confirmed).toBe(false);
    // 新一轮 attempt=2 的回执才有效
    const ok = receivePreparedAck(s, prepared(s.sessionId, 1, 1, 'main', 2));
    expect(ok.session).not.toBe(s);
  });
});

describe('双屏控制台：迟到、重复、异会话与错目标消息', () => {
  it('异会话回执一律无效', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    const r = receivePreparedAck(s, prepared('other-session', 1, 1, 'main'));
    expect(r.session).toBe(s);
  });

  it('序号不匹配当前未决的回执无效', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    const r = receivePreparedAck(s, prepared(s.sessionId, 9, 1, 'main'));
    expect(r.session).toBe(s);
  });

  it('目标画面不匹配的回执无效（同序号不同画面）', () => {
    let s = fresh();
    s = issueDual(s, { type: 'goto', page: 3 }, 1000).session; // 目标第 4 页
    const r = receivePreparedAck(s, prepared(s.sessionId, 1, 2, 'main')); // 回报第 3 页
    expect(r.session).toBe(s);
  });

  it('SHOWN 阶段状态错误（未在 partial）的回执无效', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    // 还在 preparing 就收到 SHOWN
    const r = receiveShownAck(s, shown(s.sessionId, 1, 1, 'main'));
    expect(r.session).toBe(s);
  });

  it('缺角色/缺阶段/缺 attempt 的畸形回执无效', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    const weird: Ack = {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v',
      ok: true,
      page: 1,
      blackout: false
      // 无 stage/attempt/role
    };
    expect(receivePreparedAck(s, weird).session).toBe(s);
  });
});

describe('双屏控制台：超时', () => {
  it('preparing 与 partial 超时转 unconfirmed，权威不变', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    const t1 = expireDualPending(s, 1000 + DEFAULT_ACK_TIMEOUT_MS + 1, DEFAULT_ACK_TIMEOUT_MS);
    expect(t1.pending?.status).toBe('unconfirmed');
    expect(t1.lastConfirmed.seq).toBe(0);

    let p = fresh();
    p = issueDual(p, { type: 'next' }, 1000).session;
    p = receivePreparedAck(p, prepared(p.sessionId, 1, 1, 'main')).session;
    p = receivePreparedAck(p, prepared(p.sessionId, 1, 1, 'backup')).session;
    const t2 = expireDualPending(p, 1000 + DEFAULT_ACK_TIMEOUT_MS + 1, DEFAULT_ACK_TIMEOUT_MS);
    expect(t2.pending?.status).toBe('unconfirmed');
  });

  it('未到超时不改变状态', () => {
    let s = fresh();
    s = issueDual(s, { type: 'next' }, 1000).session;
    expect(
      expireDualPending(s, 1000 + DEFAULT_ACK_TIMEOUT_MS - 50, DEFAULT_ACK_TIMEOUT_MS)
    ).toBe(s);
  });
});

describe('双屏控制台：完整成功链路', () => {
  it('prepare×2 → SHOW → shown×2 → 权威 seq=1', () => {
    let s = fresh(5);
    s = issueDual(s, { type: 'goto', page: 2 }, 1000).session;
    expect(s.pending?.status).toBe('preparing');
    let r = receivePreparedAck(s, prepared(s.sessionId, 1, 2, 'main'));
    s = r.session;
    expect(r.show).toBeNull();
    r = receivePreparedAck(s, prepared(s.sessionId, 1, 2, 'backup'));
    expect(r.show).not.toBeNull();
    s = r.session;
    expect(s.pending?.status).toBe('partial');
    s = receiveShownAck(s, shown(s.sessionId, 1, 2, 'main')).session;
    expect(s.lastConfirmed.seq).toBe(0); // 仍未确认
    s = receiveShownAck(s, shown(s.sessionId, 1, 2, 'backup')).session;
    expect(s.lastConfirmed).toEqual({ seq: 1, page: 2, blackout: false });
    expect(s.pending).toBeNull();

    // 下一条命令 seq=2
    const n = issueDual(s, { type: 'next' }, 1100);
    expect(n.command?.seq).toBe(2);
    expect(n.command?.attempt).toBe(1);
  });
});

// 仅类型层面确认 CONFIRMED 消息形状（控制器在落库成功后广播）。
export const _confirmedShapeCheck: ConfirmedMessage = {
  kind: 'CONFIRMED',
  sessionId: 's',
  seq: 1,
  page: 1,
  blackout: false
};
