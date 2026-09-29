import { chromium, expect, test } from '@playwright/test';
import {
  addImages,
  hudText,
  openConsole,
  pngImage,
  startShowDual
} from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 双屏确认模式 · 迟到 / 重复 / 异会话消息不得推进新命令。
 */
test.describe('双屏确认：消息隔离', () => {
  test('注入异会话 CMD/SHOW/ABORT/CONFIRMED：两屏与权威均不变', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);
    expect(await hudText(main)).toContain('第 1 / 2 页');

    // 从主屏内部注入一整套“别的会话/旧尝试”的消息，必须全部无效。
    await main.evaluate(() => {
      const ch = new BroadcastChannel('dome-presenter-v1');
      const foreign = 'totally-other-session';
      ch.postMessage({
        kind: 'CMD',
        sessionId: foreign,
        seq: 1,
        action: { type: 'goto', page: 1 },
        page: 1,
        blackout: false,
        phase: 'prepare',
        attempt: 1
      });
      ch.postMessage({ kind: 'SHOW', sessionId: foreign, seq: 1, page: 1, blackout: false, attempt: 1 });
      ch.postMessage({ kind: 'ABORT', sessionId: foreign, seq: 1, page: 1, blackout: false, attempt: 1 });
      ch.postMessage({ kind: 'CONFIRMED', sessionId: foreign, seq: 1, page: 1, blackout: false });
      // 同会话但伪造的越界高序号，同样必须被忽略
      ch.close();
    });
    await main.waitForTimeout(600);
    expect(await hudText(main)).toContain('第 1 / 2 页');
    expect(await hudText(backup)).toContain('第 1 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 本场会话自身的双屏切换仍然正常（异会话消息没有污染协议状态）。
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });

  test('旧会话结束、新会话开始：双屏权威从第一页重新开始，不受历史影响', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);
    await consolePage.getByTestId('dual-mode-checkbox').check();
    let { main, backup } = await startShowDual(context, consolePage);

    await consolePage.getByTestId('goto-input').fill('3');
    await consolePage.getByTestId('goto-go').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 3 / 3 页');

    await consolePage.getByTestId('end-show').click();
    await expect(main.getByTestId('viewer-ended')).toBeVisible({ timeout: 5000 });
    await main.close();
    await backup.close();

    // 新会话（再次以双屏模式开始）
    ({ main, backup } = await startShowDual(context, consolePage));
    expect(await hudText(main)).toContain('第 1 / 3 页');
    expect(await hudText(backup)).toContain('第 1 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    await expect(consolePage.getByTestId('presented-0')).toBeVisible();

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 3 页');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });
});
