// 스윙 플레인 보조선: 사용자가 직접 긋는 직선 + 공 위치 터치로 그리는 자동선(공→어깨, 공→손)
// 좌표는 모두 영상 기준 정규화 좌표(0~1)로 저장해 화면 크기가 바뀌어도 같은 위치에 그려진다.

import { LM, mid } from './series.js';

export const LINE_COLORS = {
  user: '#00e5ff',
  shoulder: '#ff6b6b', // 공→어깨(어깨 플레인)
  hands: '#ffd166',    // 공→손(어드레스 샤프트 방향 근사)
};

/** 두 점을 지나는 무한 직선이 [0,w]×[0,h] 사각형과 만나는 두 점 */
export function clipInfiniteLine(p, q, w, h) {
  const dx = q.x - p.x, dy = q.y - p.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
  const ts = [];
  if (Math.abs(dx) > 1e-9) {
    for (const x of [0, w]) {
      const t = (x - p.x) / dx, y = p.y + t * dy;
      if (y >= -1e-6 && y <= h + 1e-6) ts.push(t);
    }
  }
  if (Math.abs(dy) > 1e-9) {
    for (const y of [0, h]) {
      const t = (y - p.y) / dy, x = p.x + t * dx;
      if (x >= -1e-6 && x <= w + 1e-6) ts.push(t);
    }
  }
  if (ts.length < 2) return null;
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  return [{ x: p.x + t0 * dx, y: p.y + t0 * dy }, { x: p.x + t1 * dx, y: p.y + t1 * dy }];
}

/**
 * 어드레스 자세에서 자동선의 기준점(어깨 중점·손 중점)을 뽑는다.
 * @param {Array|null} lmAddress 어드레스 시점 랜드마크
 */
export function autoAnchors(lmAddress) {
  if (!lmAddress) return null;
  return {
    shoulder: mid(lmAddress[LM.L_SHOULDER], lmAddress[LM.R_SHOULDER]),
    hands: mid(lmAddress[LM.L_WRIST], lmAddress[LM.R_WRIST]),
  };
}

/** 선 하나: 실선 구간 + 양쪽으로 연장한 점선 */
function strokeLine(ctx, a, b, w, h, color, lw, label) {
  const A = { x: a.x * w, y: a.y * h }, B = { x: b.x * w, y: b.y * h };
  const ext = clipInfiniteLine(A, B, w, h);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  if (ext) {
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([lw * 3, lw * 2.5]);
    ctx.lineWidth = lw * 0.8;
    ctx.beginPath(); ctx.moveTo(ext[0].x, ext[0].y); ctx.lineTo(ext[1].x, ext[1].y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineWidth = lw;
  ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
  if (label) {
    ctx.font = `600 ${Math.max(11, lw * 4)}px sans-serif`;
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(0,0,0,.8)';
    ctx.shadowBlur = 3;
    ctx.fillText(label, B.x + lw * 2, B.y - lw * 2);
  }
  ctx.restore();
}

/**
 * 보조선 도구. 오버레이 캔버스의 포인터 입력을 받아 선/공 위치를 기록한다.
 * - 선 모드: 누른 채 끌어서 놓기, 또는 두 번 터치
 * - 공 모드: 한 번 터치
 * @param {HTMLCanvasElement} canvas
 * @param {{onChange?:()=>void, onHint?:(msg:string)=>void}} opt
 */
export function createLineTool(canvas, { onChange, onHint } = {}) {
  const st = { lines: [], ball: null, mode: null, pending: null, drag: null, history: [], visible: true };

  const toNorm = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const pxDist = (a, b) => {
    const r = canvas.getBoundingClientRect();
    return Math.hypot((a.x - b.x) * r.width, (a.y - b.y) * r.height);
  };
  const changed = () => onChange?.();

  function setMode(mode) {
    st.mode = st.mode === mode ? null : mode;
    st.pending = null;
    st.drag = null;
    canvas.classList.toggle('is-drawing', !!st.mode);
    if (st.mode === 'line') onHint?.('영상 위를 누른 채 끌거나, 두 점을 차례로 터치해 선을 그으세요.');
    else if (st.mode === 'ball') onHint?.('공 위치를 한 번 터치하세요. 어드레스 자세 기준으로 공→어깨, 공→손 선을 그려요.');
    else onHint?.('');
    changed();
    return st.mode;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!st.mode) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const p = toNorm(e);
    if (st.mode === 'ball') {
      st.history.push({ type: 'ball', prev: st.ball });
      st.ball = p;
      setMode(null);
      changed();
      return;
    }
    st.drag = { a: st.pending || p, b: p, fromPending: !!st.pending };
    changed();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    e.preventDefault();
    st.drag.b = toNorm(e);
    changed();
  });
  const finish = (e) => {
    if (!st.drag) return;
    const { a, fromPending } = st.drag;
    const b = toNorm(e);
    st.drag = null;
    if (pxDist(a, b) < 12) {
      // 짧은 터치: 첫 점이면 대기, 이미 대기점이 있으면(같은 자리) 무시
      if (!fromPending) { st.pending = a; onHint?.('두 번째 점을 터치하세요.'); }
      changed();
      return;
    }
    st.lines.push({ a, b });
    st.history.push({ type: 'line' });
    st.pending = null;
    onHint?.('선을 그었어요. 더 그리거나 ✏️를 다시 눌러 끝내세요.');
    changed();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => { st.drag = null; changed(); });

  return {
    state: st,
    setMode,
    undo() {
      const last = st.history.pop();
      if (!last) return false;
      if (last.type === 'line') st.lines.pop();
      else st.ball = last.prev;
      changed();
      return true;
    },
    clear() {
      st.lines = []; st.ball = null; st.history = []; st.pending = null; st.drag = null;
      changed();
    },
    toggleVisible() { st.visible = !st.visible; changed(); return st.visible; },
    toJSON() { return { lines: st.lines.map((l) => ({ a: { ...l.a }, b: { ...l.b } })), ball: st.ball ? { ...st.ball } : null }; },
    /**
     * @param {CanvasRenderingContext2D} ctx
     * @param {{shoulder:{x,y}, hands:{x,y}}|null} anchors 어드레스 기준점(자세 분석 전이면 null)
     */
    draw(ctx, w, h, anchors) {
      drawLines(ctx, w, h, st, anchors);
    },
  };
}

/** 저장된 보조선 데이터(또는 도구 상태)를 그린다. 스냅샷에도 재사용. */
export function drawLines(ctx, w, h, st, anchors) {
  if (st.visible === false) return;
  const lw = Math.max(2, w / 200);
  for (const l of st.lines || []) strokeLine(ctx, l.a, l.b, w, h, LINE_COLORS.user, lw);
  if (st.drag) strokeLine(ctx, st.drag.a, st.drag.b, w, h, LINE_COLORS.user, lw);
  if (st.pending) {
    ctx.save();
    ctx.fillStyle = LINE_COLORS.user;
    ctx.beginPath(); ctx.arc(st.pending.x * w, st.pending.y * h, lw * 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  if (st.ball) {
    if (anchors) {
      strokeLine(ctx, st.ball, anchors.shoulder, w, h, LINE_COLORS.shoulder, lw, '어깨');
      strokeLine(ctx, st.ball, anchors.hands, w, h, LINE_COLORS.hands, lw, '손');
    }
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1, lw / 2);
    ctx.beginPath(); ctx.arc(st.ball.x * w, st.ball.y * h, lw * 2.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}
