import { chromium, expect, test } from '@playwright/test';
import {
  addImages,
  armDbFault,
  disarmDbFaults,
  hudText,
  installDbFaultsInit,
  openConsole,
  pngImage,
  readPersistedState,
  startShowDual,
  storageErrorOp
} from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 双屏确认模式 · 存储故障下的确定权威状态：
 *  - 命令落库失败：不进入准备中、不发 prepare；
 *  - 两侧显示齐备但“权威前进”落库失败：不标记已确认、广播 ABORT，两屏回到
 *    上一张已确认画面，磁盘权威不前进；修复后重试（新 attempt）收敛。
 */
test.describe('双屏确认：存储故障', () => {
  test('命令事务中止：未进入准备中、两屏不切换；重试成功后走完整双确认', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);

    await armDbFault(consolePage, { reason: 'saveSession', phase: 'before', once: true });
    await consolePage.getByTestId('next').click();
    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 3000 });
    expect(await storageErrorOp(consolePage)).toBe('command');
    // 未持久化不宣布：无未决阶段（仍是“已确认”），两屏不切换。
    await expect(consolePage.getByTestId('dual-phase-confirmed')).toBeVisible();
    expect(await hudText(main)).toContain('第 1 / 2 页');
    expect(await hudText(backup)).toContain('第 1 / 2 页');

    // 修复后重试写入：正常开始一轮双确认。
    await consolePage.getByTestId('storage-retry').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    const disk = await readPersistedState(consolePage);
    expect(disk.confirmed).toMatchObject({ seq: 1, page: 1 });

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });

  test('权威前进落库失败：不确认、ABORT 两屏回滚；磁盘权威不前进；重试收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);

    // 先健康完成一次到第 2 页（建立 seq=1 权威），再准备第 3 页时让确认落库失败。
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    // 让本次切换的“权威前进” saveSession（第 3 次：命令 / 两侧准备齐 / 两侧显示齐）
    // 在请求成功后、commit 前中止——精确复现“两侧已显示但权威持久化失败”。
    await armDbFault(consolePage, {
      reason: 'saveSession',
      phase: 'afterRequest',
      once: true,
      skip: 2
    });
    await consolePage.getByTestId('next').click();
    // 两侧显示齐备、SHOW 已下发（两屏物理切换），但权威前进落库失败：
    // ABORT 随即把两屏收回。这里不竞争“第 3 页”这一瞬态（协议层已由单测覆盖），
    // 直接等待确定结果：存储错误 + 两屏回到上一张已确认画面（第 2 页）。
    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 8000 });
    expect(await storageErrorOp(consolePage)).toBe('ack');
    await expect.poll(() => hudText(main), { timeout: 5000 }).toContain('第 2 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 5000 }).toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    expect(await consolePage.locator('.seq-line').innerText()).toContain('seq=1');

    // 磁盘权威仍停在 seq=1。
    const disk = await readPersistedState(consolePage);
    expect(disk.confirmed).toMatchObject({ seq: 1, page: 1 });

    // 修复故障后显式重试（沿 seq=2 新 attempt），两屏与权威重新收敛。
    await disarmDbFaults(consolePage);
    await consolePage.getByTestId('retry').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');
    const disk2 = await readPersistedState(consolePage);
    expect(disk2.confirmed).toMatchObject({ seq: 2, page: 2 });

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });
});
