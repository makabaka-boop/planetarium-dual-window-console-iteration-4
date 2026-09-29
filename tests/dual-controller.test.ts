import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 双屏确认模式的控制器编排测试（假总线 + 假 db，不触碰真实 IndexedDB）：
 * 核验两阶段握手消息顺序、ABORT 回滚、权威落库成功才广播 CONFIRMED、
 * 存储失败时两侧回滚、以及重试产生新 attempt（旧回执作废）。
 */

const fakeDb = vi.hoisted(() => {
  const state: { draft: unknown; session: unknown } = {
    draft: { items: [{ id: 'b1', blobId: 'b1' }, { id: 'b2', blobId: 'b2' }, { id: 'b3', blobId: 'b3' }] },
    session: null
  };
  let failNext: null | ((reason: string) => boolean) = null;
  function maybeFail(reason: string) {
    if (failNext && failNext(reason)) {
      failNext = null;
      throw new Error(`forced abort: ${reason}`);
    }
  }
  return {
    state,
    armOnce(predicate: (reason: string) => boolean) {
      failNext = predicate;
    },
    reset() {
      state.draft = {
        items: [{ id: 'b1', blobId: 'b1' }, { id: 'b2', blobId: 'b2' }, { id: 'b3', blobId: 'b3' }]
      };
      state.session = null;
      failNext = null;
    },
    async loadDraft() {
      return (state.draft as { items?: unknown[] })?.items ? state.draft : null;
    },
    async loadSession() {
      return state.session as never;
    },
    async saveSession(session: unknown) {
      maybeFail('saveSession');
      state.session = session;
    },
    async clearSession() {
      maybeFail('endShow');
      state.session = null;
    },
    async saveFrozenAndSession(session: unknown) {
      maybeFail('startShow');
      state.session = session;
    },
    async saveDraft() {},
    async putBlobsAndDraft() {},
    async deleteBlob() {}
  };
});

vi.mock('../src/db', () => ({
  loadDraft: fakeDb.loadDraft,
  loadSession: fakeDb.loadSession,
  saveSession: fakeDb.saveSession,
  clearSession: fakeDb.clearSession,
  saveFrozenAndSession: fakeDb.saveFrozenAndSession,
  saveDraft: fakeDb.saveDraft,
  putBlobsAndDraft: fakeDb.putBlobsAndDraft,
  deleteBlob: fakeDb.deleteBlob,
  StorageError: class StorageError extends Error {}
}));

class FakeSessionStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
vi.stubGlobal('sessionStorage', new FakeSessionStorage());
vi.stubGlobal('window', {
  sessionStorage: globalThis.sessionStorage,
  location: { origin: 'http://test' }
});
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('clearInterval', () => undefined);

import { ConsoleController } from '../src/console/ConsoleController';
import { WireMessage } from '../src/protocol/types';

class FakeBus {
  closed = false;
  posted: WireMessage[] = [];
  private handlers = new Set<(m: WireMessage) => void>();
  subscribe(h: (m: WireMessage) => void) {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }
  post(m: WireMessage) {
    this.posted.push(m);
  }
  emit(m: WireMessage) {
    this.handlers.forEach((h) => h(m));
  }
  close() {
    this.handlers.clear();
    this.closed = true;
  }
  byKind(kind: string) {
    return this.posted.filter((m) => m.kind === kind);
  }
}

const prepared = (
  sid: string,
  role: 'main' | 'backup',
  attempt = 1
): WireMessage => ({
  kind: 'ACK',
  sessionId: sid,
  seq: 1,
  viewerId: `v-${role}`,
  ok: true,
  page: 1,
  blackout: false,
  stage: 'prepared',
  attempt,
  role
});

const shown = (sid: string, role: 'main' | 'backup', attempt = 1): WireMessage => ({
  kind: 'ACK',
  sessionId: sid,
  seq: 1,
  viewerId: `v-${role}`,
  ok: true,
  page: 1,
  blackout: false,
  stage: 'shown',
  attempt,
  role
});

/** 两侧快照登记（控制器靠 role 跟踪屏幕在线；不影响握手）。 */
function snapshotReq(bus: FakeBus, role: 'main' | 'backup') {
  bus.emit({ kind: 'SNAPSHOT_REQ', viewerId: `v-${role}`, role });
}

describe('双屏控制器：消息编排与权威', () => {
  let controller: ConsoleController;
  let bus: FakeBus;
  let sid: string;

  beforeEach(async () => {
    fakeDb.reset();
    bus = new FakeBus();
    controller = new ConsoleController(bus as never);
    await controller.init();
    await controller.startShow('dual');
    sid = controller.getState().session!.sessionId;
    bus.posted = [];
    snapshotReq(bus, 'main');
    snapshotReq(bus, 'backup');
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('发命令只广播 prepare CMD（不广播 SHOW）；权威不变', async () => {
    await controller.next();
    const cmds = bus.byKind('CMD');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ phase: 'prepare', attempt: 1, seq: 1 });
    expect(bus.byKind('SHOW')).toHaveLength(0);
    expect(controller.getState().session?.lastConfirmed.seq).toBe(0);
    expect(controller.getState().session?.pending?.status).toBe('preparing');
  });

  it('单侧 PREPARED 不下发 SHOW；两侧齐备后才下发一条 SHOW', async () => {
    await controller.next();
    bus.emit(prepared(sid, 'main'));
    await flush();
    expect(bus.byKind('SHOW')).toHaveLength(0);
    expect(controller.getState().session?.pending?.status).toBe('preparing');

    bus.emit(prepared(sid, 'backup'));
    await flush();
    const shows = bus.byKind('SHOW');
    expect(shows).toHaveLength(1);
    expect(shows[0]).toMatchObject({ seq: 1, attempt: 1 });
    expect(controller.getState().session?.pending?.status).toBe('partial');
  });

  it('仅一侧 SHOWN 不推进权威；两侧齐备且落库后广播 CONFIRMED、权威前进', async () => {
    await controller.next();
    bus.emit(prepared(sid, 'main'));
    bus.emit(prepared(sid, 'backup'));
    await flush();
    bus.emit(shown(sid, 'main'));
    await flush();
    expect(controller.getState().session?.lastConfirmed.seq).toBe(0);
    expect(bus.byKind('CONFIRMED')).toHaveLength(0);

    bus.emit(shown(sid, 'backup'));
    await flush();
    expect(controller.getState().session?.lastConfirmed).toMatchObject({ seq: 1, page: 1 });
    expect(controller.getState().session?.pending).toBeNull();
    const confirmed = bus.byKind('CONFIRMED');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ seq: 1, page: 1 });
    // 磁盘权威同步前进
    expect((fakeDb.state.session as { lastConfirmed: { seq: number } }).lastConfirmed.seq).toBe(1);
  });

  it('准备阶段单侧失败：转 failed 并向两侧广播 ABORT', async () => {
    await controller.next();
    bus.emit(prepared(sid, 'main'));
    bus.emit({
      kind: 'ACK',
      sessionId: sid,
      seq: 1,
      viewerId: 'v-backup',
      ok: false,
      reason: 'IMAGE_FAILED',
      target: { page: 1, blackout: false },
      page: 0,
      blackout: false,
      stage: 'prepared',
      attempt: 1,
      role: 'backup'
    });
    await flush();
    expect(controller.getState().session?.pending?.status).toBe('failed');
    const aborts = bus.byKind('ABORT');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({ seq: 1, attempt: 1 });
  });

  it('部分显示时另一侧失败：failed + ABORT，已显示侧须回滚；权威不变', async () => {
    await controller.next();
    bus.emit(prepared(sid, 'main'));
    bus.emit(prepared(sid, 'backup'));
    await flush();
    bus.emit(shown(sid, 'main')); // 主屏已显示
    await flush();
    bus.emit({
      kind: 'ACK',
      sessionId: sid,
      seq: 1,
      viewerId: 'v-backup',
      ok: false,
      reason: 'IMAGE_FAILED',
      target: { page: 1, blackout: false },
      page: 0,
      blackout: false,
      stage: 'shown',
      attempt: 1,
      role: 'backup'
    });
    await flush();
    expect(controller.getState().session?.lastConfirmed.seq).toBe(0);
    expect(controller.getState().session?.pending?.status).toBe('failed');
    expect(bus.byKind('ABORT')).toHaveLength(1);
  });

  it('两侧 SHOWN 齐备但权威落库失败：不广播 CONFIRMED，广播 ABORT，命令回到未确认', async () => {
    await controller.next();
    bus.emit(prepared(sid, 'main'));
    bus.emit(prepared(sid, 'backup'));
    await flush();
    bus.emit(shown(sid, 'main'));
    await flush();
    // 让“权威前进”这一次落库失败
    fakeDb.armOnce((r) => r === 'saveSession');
    bus.emit(shown(sid, 'backup'));
    await flush();
    await flush();
    expect(bus.byKind('CONFIRMED')).toHaveLength(0);
    expect(bus.byKind('ABORT')).toHaveLength(1);
    const s = controller.getState().session!;
    expect(s.lastConfirmed.seq).toBe(0);
    expect(s.pending?.status).toBe('unconfirmed');
    expect(controller.getState().storageError?.operation.kind).toBe('ack');
  });

  it('重试：沿用 seq=1、attempt=2，旧 attempt 回执无法推进，新 attempt 正常确认', async () => {
    await controller.next();
    // 只有主屏准备好 → 超时由讲解员显式重试
    bus.emit(prepared(sid, 'main'));
    await flush();
    await controller.retry();
    const cmds = bus.byKind('CMD');
    expect(cmds.at(-1)).toMatchObject({ seq: 1, attempt: 2, phase: 'prepare' });
    expect(controller.getState().session?.pending?.dual?.prepared).toEqual({
      main: false,
      backup: false
    });

    // 旧 attempt=1 的迟到回执无效
    bus.emit(prepared(sid, 'backup', 1));
    await flush();
    expect(controller.getState().session?.pending?.status).toBe('preparing');
    expect(bus.byKind('SHOW')).toHaveLength(0);

    // 新 attempt=2 两侧齐备
    bus.emit(prepared(sid, 'main', 2));
    bus.emit(prepared(sid, 'backup', 2));
    await flush();
    bus.emit(shown(sid, 'main', 2));
    bus.emit(shown(sid, 'backup', 2));
    await flush();
    expect(controller.getState().session?.lastConfirmed.seq).toBe(1);
    expect(bus.byKind('CONFIRMED')).toHaveLength(1);
  });

  it('异会话/错序号/错画面的回执不改变状态', async () => {
    await controller.next();
    const base = prepared(sid, 'main') as Extract<WireMessage, { kind: 'ACK' }>;
    bus.emit({ ...base, sessionId: 'other' });
    bus.emit({ ...base, seq: 9 });
    bus.emit({ ...base, page: 9 });
    await flush();
    expect(controller.getState().session?.pending?.status).toBe('preparing');
    expect(bus.byKind('SHOW')).toHaveLength(0);
  });

  it('切换中途某角色以新 viewerId 快照登记：打回未确认并 ABORT', async () => {
    await controller.next();
    bus.emit(prepared(sid, 'main'));
    bus.emit(prepared(sid, 'backup'));
    await flush();
    bus.emit(shown(sid, 'main')); // partial：主屏已显示
    await flush();
    // 备屏重载，viewerId 变化
    bus.emit({ kind: 'SNAPSHOT_REQ', viewerId: 'v-backup-reloaded', role: 'backup' });
    await flush();
    const s = controller.getState().session!;
    expect(s.pending?.status).toBe('unconfirmed');
    expect(bus.byKind('ABORT')).toHaveLength(1);
  });
});
