import { chromium, expect, test } from '@playwright/test';
import {
  addImages,
  dualStageText,
  hudText,
  installIncomingMsgCtl,
  msgCtl,
  openConsole,
  pngImage,
  solidPng,
  startShowDual
} from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 用“控制台入站消息控制”确定性复现双屏确认的中间态与回滚（观众窗正常运行，
 * 只控制它们回报到控制台的 ACK）：
 *
 *  A. 挂住备屏 PREPARED：只有主屏准备回执 → 控制台保持“准备中”、不下发 SHOW、
 *     两屏画面不切换；放行后两屏切换、权威确认。
 *  B. 放行两侧 PREPARED、只挂住备屏 SHOWN：SHOW 已下发（两屏物理切换），
 *     控制台只收到主屏 SHOWN → “部分显示”，权威不前进；放行后确认。
 *  C. 永久丢弃备屏 ACK：准备阶段超时 → 未确认 + ABORT，画面与权威停在上一张；
 *     恢复后重试（新 attempt）收敛。
 *  D. 部分显示后超时：已先行显示的两屏经 ABORT 回到上一张已确认画面。
 */
test.describe('双屏确认：可控消息顺序下的准备中/部分显示/回滚/重试', () => {
  test('A · 仅一侧准备回执：准备中、无 SHOW、画面不动；放行后收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installIncomingMsgCtl(context);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await addImages(consolePage, [
      solidPng('red.png', [220, 40, 40]),
      solidPng('green.png', [40, 200, 90])
    ]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);
    const ctl = msgCtl(consolePage);

    // 挂住备屏的准备回执。
    await ctl.hold({ kind: 'ACK', stage: 'prepared', role: 'backup' });

    await consolePage.getByTestId('next').click();
    await expect(consolePage.getByTestId('dual-phase-preparing')).toBeVisible({ timeout: 3000 });

    // 给主屏回执足够时间到达；控制台仍“准备中”，且绝不发 SHOW。
    await consolePage.waitForTimeout(800);
    expect(await dualStageText(main)).not.toContain('部分显示');
    expect(await hudText(main)).toContain('第 1 / 2 页');
    expect(await hudText(backup)).toContain('第 1 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    // 控制台双屏面板：仅主屏准备完成（备屏仍准备中）。
    await expect(consolePage.getByTestId('dual-stage-backup')).toHaveText('准备中…');
    await expect(consolePage.getByTestId('dual-stage-main')).not.toHaveText('准备中…');

    // 放行备屏准备回执：下发 SHOW，两屏切换并确认。
    await ctl.releaseAll();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });

  test('B · 仅一侧显示回执：部分显示、权威不前进；放行后确认', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installIncomingMsgCtl(context);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await addImages(consolePage, [
      solidPng('red.png', [220, 40, 40]),
      solidPng('green.png', [40, 200, 90])
    ]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);
    const ctl = msgCtl(consolePage);

    // 放行 PREPARED（否则 SHOW 不下发），只挂住备屏 SHOWN。
    await ctl.hold({ kind: 'ACK', stage: 'shown', role: 'backup' });

    await consolePage.getByTestId('next').click();

    // 两屏物理切换（SHOW 两侧都收到），但控制台只收到主屏 SHOWN → 部分显示。
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('dual-phase-partial')).toBeVisible({ timeout: 3000 });
    await expect(consolePage.getByTestId('status-partial')).toBeVisible();
    // 权威不前进。
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    expect(await consolePage.locator('.seq-line').innerText()).toContain('seq=0');
    // 主屏徽标：本屏已切换、等待双确认。
    await expect.poll(() => dualStageText(main), { timeout: 3000 }).toContain('部分显示');

    // 放行备屏 SHOWN：权威确认，两屏徽标回到已确认。
    await ctl.releaseAll();
    await expect(consolePage.getByTestId('dual-phase-confirmed')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect
      .poll(() => dualStageText(main), { timeout: 3000 })
      .toContain('已确认');
    await expect
      .poll(() => dualStageText(backup), { timeout: 3000 })
      .toContain('已确认');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });

  test('C · 备屏回执永久丢失：准备超时未确认并 ABORT；恢复后重试收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installIncomingMsgCtl(context);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);
    const ctl = msgCtl(consolePage);

    await ctl.drop({ kind: 'ACK', role: 'backup' });
    await consolePage.getByTestId('next').click();
    await expect(consolePage.getByTestId('dual-phase-preparing')).toBeVisible({ timeout: 3000 });

    // 默认 2s 超时 + 200ms 巡检。
    await expect(consolePage.getByTestId('dual-phase-unconfirmed')).toBeVisible({ timeout: 6000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    // 准备阶段两屏画面从未切换。
    expect(await hudText(main)).toContain('第 1 / 2 页');
    expect(await hudText(backup)).toContain('第 1 / 2 页');

    // 恢复通信并显式重试（沿 seq=1、新 attempt），两屏收敛到第 2 页。
    await ctl.clear();
    await consolePage.getByTestId('retry').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });

  test('D · 部分显示后超时：两屏经 ABORT 回到上一张已确认画面', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installIncomingMsgCtl(context);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await addImages(consolePage, [
      solidPng('red.png', [220, 40, 40]),
      solidPng('green.png', [40, 200, 90])
    ]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);
    const ctl = msgCtl(consolePage);

    // 两侧 PREPARED 放行、备屏 SHOWN 丢弃 → 进入部分显示。
    await ctl.drop({ kind: 'ACK', stage: 'shown', role: 'backup' });
    await consolePage.getByTestId('next').click();
    await expect(consolePage.getByTestId('dual-phase-partial')).toBeVisible({ timeout: 5000 });
    // 两屏此时都已物理切到第 2 页。
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');

    // 部分显示超时：ABORT 下发，两屏回到上一张已确认画面（第 1 页）。
    await expect(consolePage.getByTestId('dual-phase-unconfirmed')).toBeVisible({ timeout: 6000 });
    await expect.poll(() => hudText(main), { timeout: 4000 }).toContain('第 1 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 4000 }).toContain('第 1 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    expect(await consolePage.locator('.seq-line').innerText()).toContain('seq=0');

    // 恢复并重试：新 attempt 收敛。
    await ctl.clear();
    await consolePage.getByTestId('retry').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });
});
