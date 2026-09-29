import { chromium, expect, test } from '@playwright/test';
import {
  addImages,
  dualStageText,
  gateOn,
  hudText,
  installSeqDecodeGate,
  openConsole,
  pngImage,
  startShowDual
} from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 双屏确认模式 · 成功链路与三态界面：
 * 准备中 → 部分显示 → 已确认。不承诺像素物理同时变化，但界面必须准确区分。
 * 用解码闸把装载/切换时序撑开，确定性地观测每一个阶段（否则本地小图瞬间完成）。
 */
test.describe('双屏确认：两阶段切换成功', () => {
  test('两侧准备齐备才切换、两侧显示齐备且落库才确认；主备 HUD 显示正确角色', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installSeqDecodeGate(context, false);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);

    // 打开双屏模式
    await consolePage.getByTestId('dual-mode-checkbox').check();
    const { main, backup } = await startShowDual(context, consolePage);

    // 两侧 HUD 角色正确，初始都是第 1/3 页且“已确认”
    expect(await main.getByTestId('viewer-role').innerText()).toContain('主投影');
    expect(await backup.getByTestId('viewer-role').innerText()).toContain('备用投影');
    expect(await hudText(main)).toContain('第 1 / 3 页');
    expect(await hudText(backup)).toContain('第 1 / 3 页');
    expect(await dualStageText(main)).toContain('已确认');
    expect(await dualStageText(backup)).toContain('已确认');

    // 控制台显示双屏面板、初始已确认
    await expect(consolePage.getByTestId('dual-phase-confirmed')).toBeVisible();

    // 挂起两块屏幕后续的一切解码（第 2 页的 prepare 装载会停在解码阶段）。
    const gMain = gateOn(main);
    const gBackup = gateOn(backup);
    await gMain.gate();
    await gBackup.gate();

    // 发起切换到第 2 页
    await consolePage.getByTestId('next').click();

    // 控制台进入“准备中”（两侧装载被解码闸挂住，PREPARED 尚未回报）
    await expect(consolePage.getByTestId('dual-phase-preparing')).toBeVisible({ timeout: 3000 });
    await expect(consolePage.getByTestId('status-preparing')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    // 两屏画面不动
    expect(await hudText(main)).toContain('第 1 / 3 页');
    expect(await hudText(backup)).toContain('第 1 / 3 页');
    // 没有 SHOW（准备未齐）
    expect(await dualStageText(main)).toContain('准备中');
    expect(await dualStageText(backup)).toContain('准备中');

    // 放行两侧装载解码：PREPARED 齐备 → SHOW 下发；图片已在装载阶段进缓存，
    // SHOW 直接取缓存绘制，两屏随后切换并 SHOWN，权威最终确认。
    await gMain.releaseAll();
    await gBackup.releaseAll();
    await gMain.ungate();
    await gBackup.ungate();

    // 最终两侧都到第 2 页
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 2 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 2 / 3 页');

    // 控制台权威前进、标记已呈现
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible({ timeout: 3000 });
    await expect(consolePage.getByTestId('dual-phase-confirmed')).toBeVisible();
    expect(await consolePage.locator('.seq-line').innerText()).toContain('seq=1');

    // 两侧观众窗阶段徽标回到“已确认”
    await expect.poll(() => dualStageText(main), { timeout: 3000 }).toContain('已确认');
    await expect.poll(() => dualStageText(backup), { timeout: 3000 }).toContain('已确认');

    // 可继续切到第 3 页，序号递增
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(main), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect.poll(() => hudText(backup), { timeout: 8000 }).toContain('第 3 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');
    expect(await consolePage.locator('.seq-line').innerText()).toContain('seq=2');

    await main.close();
    await backup.close();
    await context.close();
    await browser.close();
  });
});

