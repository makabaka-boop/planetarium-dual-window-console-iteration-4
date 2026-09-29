import { useEffect, useReducer, useRef } from 'react';
import { ViewerRuntime, PresentStatus } from '../viewer/ViewerRuntime';

export function ViewerPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const statusRef = useRef<PresentStatus>({ phase: 'recovering' });

  useEffect(() => {
    if (!canvasRef.current) return;
    const runtime = new ViewerRuntime(canvasRef.current);
    runtimeRef.current = runtime;
    const unsub = runtime.subscribe(() => {
      statusRef.current = runtime.getStatus();
      force();
    });
    runtime.start();
    return () => {
      unsub();
      runtime.dispose();
    };
  }, []);

  const status = statusRef.current;

  return (
    <div className="viewer">
      <canvas ref={canvasRef} className="dome-canvas" data-testid="dome-canvas" />
      {status.phase === 'recovering' && (
        <Overlay>
          <div className="overlay-card" data-testid="viewer-recovering">
            正在从控制台恢复权威快照…
          </div>
        </Overlay>
      )}
      {status.phase === 'standby' && (
        <Overlay>
          <div className="overlay-card" data-testid="viewer-standby">
            观众窗待命。请在控制台开始放映。
          </div>
        </Overlay>
      )}
      {status.phase === 'ended' && (
        <Overlay>
          <div className="overlay-card" data-testid="viewer-ended">
            本场放映已结束。
          </div>
        </Overlay>
      )}
      {status.phase === 'live' && (
        <>
          <div className="viewer-hud" data-testid="viewer-hud">
            {status.blackout ? '遮黑' : `第 ${status.page + 1} / ${status.total} 页`}
            <span className="hud-seq mono">seq {status.seq}</span>
          </div>
          {status.imageError && (
            <div className="viewer-error" data-testid="viewer-image-error">
              该页图片呈现失败，仍显示最后成功页
            </div>
          )}
        </>
      )}
      {status.phase === 'dual-live' && (
        <>
          <div className="viewer-hud viewer-hud-dual" data-testid="viewer-hud">
            <span className="hud-role" data-testid="viewer-role">
              {status.role === 'main' ? '主投影' : '备用投影'}
            </span>
            {status.blackout ? '遮黑' : `第 ${status.page + 1} / ${status.total} 页`}
            <span className="hud-seq mono">权威 seq {status.confirmedSeq}</span>
          </div>
          <div className={`dual-stage-badge stage-${status.stage}`} data-testid="dual-stage-badge">
            {status.stage === 'idle' && '已确认：与权威画面一致'}
            {status.stage === 'preparing' && '准备中：装载下一画面（屏幕未切换）'}
            {status.stage === 'prepared' && '准备完成：等待控制台统一切换'}
            {status.stage === 'showing' && '切换中…'}
            {status.stage === 'displayed' && '部分显示：本屏已切换，等待双屏确认'}
            {status.stage === 'failed-prepare' && '装载失败：保持上一张已确认画面'}
            {status.pendingSeq != null && (
              <span className="mono">目标 seq {status.pendingSeq}</span>
            )}
          </div>
          {status.imageError && (
            <div className="viewer-error" data-testid="viewer-image-error">
              该页图片呈现失败，已回到最后确认页
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Overlay(props: { children: React.ReactNode }) {
  return <div className="viewer-overlay">{props.children}</div>;
}
