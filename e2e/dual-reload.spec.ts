import { chromium, expect, test } from '@playwright/test';
import {
  addImages,
  hudText,
  installIncomingMsgCtl,
  msgCtl,
  openConsole,
  pngImage,
  startShowDual
} from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 双屏确认模式 · 窗口重载：窗口重载后必须先同步最后确认状态（权威快照），
 * 迟到的未确认画面不得“粘”在重载后的屏幕上；重载窗口继续参与后续切换。
 */
test.describe('双屏确认：窗口重载同步最后确认状态', () => {
  test('确认后重载任一屏：回到最后确认页；遮黑状态一并恢复', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('p1.png'), pngImage('p2.png'), pngImage('p3.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);

    // 走到第 3 页并确认
    await consolePage.getByTestId('goto-input').fill('3');
    await consolePage.getByTestId('goto-go').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 遮黑并确认后重载备屏：快照必须带回“第 3 页 + 遮黑”完整画面
    await consolePage.getByTestId('blackout').click();
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toMatch(/遮黑/);
    await expect(consolePage.locator('.badge-dark')).toBeVisible();

    await backup.reload();
    await expect(backup.getByTestId('viewer-recovering')).toBeVisible({ timeout: 3000 });
    await expect.poll(() => hudText(backup), { timeout: 10_000 }).toMatch(/遮黑/);
    expect(await backup.getByTestId('viewer-role').innerText()).toContain('备用投影');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 解除遮黑后两屏继续联动
    await consolePage.getByTestId('blackout').click();
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 3 / 3 页');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });

  test('切换中途（部分显示）重载备屏：重载后先停在最后确认页；控制台打回未确认并重试收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installIncomingMsgCtl(context);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);
    const ctl = msgCtl(consolePage);

    // 确定性卡在“部分显示”：两屏物理切到第 2 页，但备屏 SHOWN 不到达控制台。
    await ctl.hold({ kind: 'ACK', stage: 'shown', role: 'backup' });
    await consolePage.getByTestId('next').click();
    await expect(consolePage.getByTestId('dual-phase-partial')).toBeVisible({ timeout: 5000 });
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1'); // 权威仍第 1 页

    // 此刻重载备屏：快照权威仍是第 1 页，重载后必须先停在第 1 页（而非粘住第 2 页）。
    await backup.reload();
    await expect(backup.getByTestId('viewer-recovering')).toBeVisible({ timeout: 3000 });
    await expect.poll(() => hudText(backup), { timeout: 10_000 }).toContain('第 1 / 3 页');

    // 控制台检测到备屏角色换了窗口：命令打回未确认（主屏此前已显示，需随 ABORT 回滚）。
    await expect(consolePage.getByTestId('dual-phase-unconfirmed')).toBeVisible({ timeout: 5000 });
    await expect.poll(() => hudText(main), { timeout: 5000 }).toContain('第 1 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 放行旧消息（此时旧 SHOWN 已无效）并显式重试：沿 seq=1、新 attempt 收敛。
    await ctl.releaseAll();
    await ctl.clear();
    await consolePage.getByTestId('retry').click();
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 3 页');
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });

  test('控制台刷新：从磁盘恢复双屏会话，未决命令清空回执、回到未确认', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    await consolePage.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('dual-panel')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    // 两屏画面保持
    expect(await hudText(main)).toContain('第 2 / 2 页');
    expect(await hudText(backup)).toContain('第 2 / 2 页');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });
});
