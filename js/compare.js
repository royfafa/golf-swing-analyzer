// 영상 2개를 임팩트 시점에 맞춰 나란히 보는 비교 화면.
// 각 영상은 촬영 모드(일반/슬로모션)에 따라 시간 배율이 다르므로, 모든 동기화는 "임팩트 기준 실제 시간"으로 한다.
// 영상은 저장하지 않는다(메모리의 objectURL만 사용).

import { COMMON_FPS, snapFps, computeTimeScale, frameCenter, toRealSeconds } from './timebase.js';
import { readVideoMeta } from './mp4meta.js';
import { seekTo, primeVideo, estimateFpsByPlayback } from './video.js';

/** 브라우저가 안정적으로 재생하는 배속 범위. 벗어나면 프레임 이동 방식으로 재생한다. */
const NATIVE_RATE_MIN = 0.0625;
const NATIVE_RATE_MAX = 4;
/** 함께 보기 구간: 임팩트 전 3초 ~ 후 2초(실제 시간) 안에서 두 영상이 모두 있는 부분 */
const SYNC_BEFORE = 3;
const SYNC_AFTER = 2;

const $ = (s, root = document) => root.querySelector(s);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');

/** 임팩트 기준 실제 시간(초) → 영상 시간 */
export function timeAtOffset(slot, off) {
  return slot.impact + off / slot.tb.timeScale;
}
/** 영상 시간 → 임팩트 기준 실제 시간(초) */
export function offsetAt(slot, t) {
  return (t - slot.impact) * slot.tb.timeScale;
}
/**
 * 두 영상이 모두 존재하는 임팩트 기준 실제 시간 구간
 * @param {Array<{impact:number, duration:number, tb:{timeScale:number}}>} list
 */
export function syncRange(list, before = SYNC_BEFORE, after = SYNC_AFTER) {
  let lo = -before, hi = after;
  for (const s of list) {
    lo = Math.max(lo, -s.impact * s.tb.timeScale);
    hi = Math.min(hi, (s.duration - s.impact) * s.tb.timeScale);
  }
  return { lo, hi: Math.max(lo, hi) };
}
/** 실제 시간 배속 → 각 영상의 재생 속도. 범위를 벗어나면 native=false */
export function playbackPlan(list, speed) {
  const rates = list.map((s) => speed / s.tb.timeScale);
  return { rates, native: rates.every((r) => r >= NATIVE_RATE_MIN && r <= NATIVE_RATE_MAX) };
}

/**
 * @param {{toast:(m:string,ms?:number)=>void,
 *   getAnalysisSource:()=>null|{file:File,fileFps:number,mode:string,captureFps:number,fileType:string,impact:number|null,meta:object|null},
 *   onEnter?:()=>void}} opt
 */
export function initCompare({ toast, getAnalysisSource, onEnter }) {
  const panel = $('#panel-compare');
  const slots = {};
  for (const key of ['A', 'B']) {
    const col = $(`.cmp-col[data-slot="${key}"]`, panel);
    slots[key] = {
      key, col, video: $('video', col), card: null,
      file: null, url: null, meta: null, playbackFps: null, duration: 0,
      fileFps: 30, mode: 'normal', captureFps: 240, fileType: 'auto',
      tb: computeTimeScale({ mode: 'normal', fileFps: 30 }),
      impact: null, seekTimeouts: 0,
    };
  }
  let target = 'A';
  let playing = false;
  let playToken = 0;
  let syncPos = 0; // 함께 보기에서 멈춰 있을 때의 위치(임팩트 기준 실제 초)
  let corrections = 0;
  let lastPlan = '';

  /* ---------- 슬롯 카드 ---------- */
  const slotsBox = $('#cmp-slots', panel);
  slotsBox.innerHTML = ['A', 'B'].map((k) => `
    <article class="card cmp-slot" data-slot="${k}">
      <h2><span class="num">${k}</span>${k === 'A' ? '영상 A (예: 오늘 스윙)' : '영상 B (예: 지난 스윙·레슨 영상)'}</h2>
      <div class="cmp-actions">
        <label class="btn file-btn"><input type="file" accept="video/*" hidden />📁 영상 선택</label>
        <button type="button" class="btn" data-act="from-analysis">분석 탭 영상 사용</button>
      </div>
      <div class="cmp-settings" hidden>
        <p class="hint" data-el="name"></p>
        <div class="field">
          <span class="field-label">촬영 모드</span>
          <div class="seg" data-el="mode">
            <button type="button" data-value="normal">일반 (실시간)</button>
            <button type="button" data-value="slowmo">슬로모션</button>
          </div>
        </div>
        <div class="field">
          <span class="field-label">파일 프레임레이트</span>
          <select data-el="fps"></select>
        </div>
        <div data-el="slowmo" hidden>
          <div class="field">
            <span class="field-label">슬로모션 촬영 속도</span>
            <select data-el="capture"><option value="120">120fps (4배 느리게)</option><option value="240">240fps (8배 느리게)</option></select>
          </div>
          <div class="field">
            <span class="field-label">파일 형태</span>
            <div class="seg seg-3" data-el="fileType">
              <button type="button" data-value="auto">자동</button>
              <button type="button" data-value="native">원본 고프레임</button>
              <button type="button" data-value="slowed">느리게 재생됨</button>
            </div>
          </div>
        </div>
        <div class="timebase" data-el="tb"></div>
      </div>
    </article>`).join('');

  for (const k of ['A', 'B']) {
    const s = slots[k];
    s.card = $(`.cmp-slot[data-slot="${k}"]`, slotsBox);
    const q = (el) => $(`[data-el="${el}"]`, s.card);
    $('input[type=file]', s.card).addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) await loadSlot(s, f);
    });
    $('[data-act="from-analysis"]', s.card).addEventListener('click', async () => {
      const src = getAnalysisSource();
      if (!src) { toast('분석 탭에 불러온 영상이 없어요.'); return; }
      await loadSlot(s, src.file, src);
    });
    segBind(q('mode'), (v) => { s.mode = v; onSlotTimebase(s); });
    segBind(q('fileType'), (v) => { s.fileType = v; onSlotTimebase(s); });
    q('fps').addEventListener('change', (e) => { s.fileFps = Number(e.target.value); onSlotTimebase(s); });
    q('capture').addEventListener('change', (e) => { s.captureFps = Number(e.target.value); onSlotTimebase(s); });
  }

  function segBind(seg, fn) {
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { segSet(seg, b.dataset.value); fn(b.dataset.value); }));
  }
  function segSet(seg, v) {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.value === v));
  }

  /* ---------- 영상 불러오기 ---------- */
  function waitMeta(video, ms = 10000) {
    return new Promise((resolve, reject) => {
      const done = (fn, a) => { clearTimeout(tm); video.removeEventListener('loadedmetadata', ok); video.removeEventListener('error', bad); fn(a); };
      const ok = () => done(resolve);
      const bad = () => done(reject, new Error('decode'));
      const tm = setTimeout(() => done(reject, new Error('timeout')), ms);
      video.addEventListener('loadedmetadata', ok);
      video.addEventListener('error', bad);
    });
  }

  async function loadSlot(s, file, preset = null) {
    stop();
    if (s.url) URL.revokeObjectURL(s.url);
    s.file = file;
    s.url = URL.createObjectURL(file);
    s.impact = null;
    s.playbackFps = null;
    s.video.src = s.url;
    try {
      await waitMeta(s.video);
    } catch {
      toast(`영상 ${s.key}를 브라우저가 열지 못했어요. 다른 형식(H.264)으로 시도해 주세요.`, 5000);
      return;
    }
    s.duration = Number.isFinite(s.video.duration) ? s.video.duration : 0;
    const stage = $('.stage', s.col);
    stage.style.setProperty('--ar', `${s.video.videoWidth} / ${s.video.videoHeight}`);
    stage.style.setProperty('--ar-num', String(s.video.videoWidth / s.video.videoHeight || 1));

    if (preset) {
      s.meta = preset.meta ?? null;
      s.fileFps = preset.fileFps;
      s.mode = preset.mode;
      s.captureFps = preset.captureFps;
      s.fileType = preset.fileType;
    } else {
      s.meta = await readVideoMeta(file);
      let fps = s.meta ? snapFps(s.meta.modeFps) : null;
      if (!fps) {
        s.playbackFps = await estimateFpsByPlayback(s.video);
        fps = s.playbackFps ? snapFps(s.playbackFps) : 30;
      }
      s.fileFps = fps;
      s.mode = fps >= 90 ? 'slowmo' : 'normal';
      s.fileType = 'auto';
    }
    if (!s.duration && s.meta) s.duration = s.meta.durationSec;
    s.tb = computeTimeScale(s);
    await primeVideo(s.video);
    if (preset?.impact != null) {
      s.impact = preset.impact;
      await seekSlot(s, s.impact);
    } else {
      await seekSlot(s, frameCenter(0, s.fileFps));
    }
    renderSlot(s);
    layout();
    // 임팩트가 없으면 이 영상을 조정 대상으로
    setTarget(s.impact == null ? s.key : (bothReady() ? 'sync' : target));
    toast(s.impact == null
      ? `영상 ${s.key}: 임팩트 프레임으로 옮긴 뒤 "현재 프레임 = ${s.key} 임팩트"를 눌러 주세요.`
      : `영상 ${s.key}: 분석 탭에서 확정한 임팩트를 가져왔어요.`, 4000);
  }

  function onSlotTimebase(s) {
    const prev = s.tb.timeScale;
    s.tb = computeTimeScale(s);
    if (prev !== s.tb.timeScale) stop();
    renderSlot(s);
    renderAll();
  }

  function renderSlot(s) {
    const q = (el) => $(`[data-el="${el}"]`, s.card);
    $('.cmp-settings', s.card).hidden = !s.file;
    if (!s.file) return;
    q('name').textContent = `${s.file.name} · ${s.video.videoWidth}×${s.video.videoHeight}` +
      (s.meta ? ` · 파일 정보 ${fmt(s.meta.modeFps, 1)}fps${s.meta.isVFR ? ' (가변 프레임)' : ''}` : '');
    segSet(q('mode'), s.mode);
    segSet(q('fileType'), s.fileType);
    q('slowmo').hidden = s.mode !== 'slowmo';
    q('capture').value = String(s.captureFps);
    const values = new Set([...COMMON_FPS, s.fileFps]);
    q('fps').innerHTML = [...values].sort((a, b) => a - b)
      .map((f) => `<option value="${f}" ${f === s.fileFps ? 'selected' : ''}>${f} fps</option>`).join('');
    const warn = s.tb.resolvedType === 'slowed' && s.meta?.isVFR
      ? '<div class="warn">⚠ 가변 프레임레이트 파일이에요. 임팩트 주변이 같은 속도 구간인지 확인해 주세요.</div>' : '';
    q('tb').innerHTML = `영상 ${fmt(s.duration, 2)}초 → 실제 <b>${fmt(toRealSeconds(s.duration, s.tb.timeScale), 2)}초</b> · 1프레임 = 실제 ${fmt(1000 / s.tb.effectiveFps, 1)}ms<br>` +
      `임팩트: ${s.impact == null ? '<b style="color:var(--warn)">미지정</b>' : `<b>${fmt(s.impact, 3)}초</b> ✔`}${warn}`;
  }

  /* ---------- 배치 ---------- */
  function layout() {
    const loaded = ['A', 'B'].map((k) => slots[k]).filter((s) => s.file);
    const portrait = loaded.length > 0 && loaded.every((s) => s.video.videoHeight > s.video.videoWidth);
    $('#cmp-stages', panel).classList.toggle('is-row', portrait);
    for (const k of ['A', 'B']) {
      const s = slots[k];
      $('.stage', s.col).hidden = !s.file;
      $('.cmp-empty', s.col).hidden = !!s.file;
    }
    $('#cmp-viewer', panel).hidden = loaded.length === 0;
  }

  /* ---------- 조정 대상 ---------- */
  const targetSeg = $('#cmp-target', panel);
  targetSeg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    setTarget(b.dataset.value);
  }));
  const bothReady = () => slots.A.file && slots.B.file && slots.A.impact != null && slots.B.impact != null;

  function setTarget(t) {
    stop();
    if (t === 'sync' && !bothReady()) t = slots.A.file ? 'A' : 'B';
    if (t !== 'sync' && !slots[t].file) t = t === 'A' ? 'B' : 'A';
    target = t;
    if (target === 'sync') {
      syncPos = 0;
      seekSync(0);
    }
    renderAll();
  }

  function activeSlots() {
    if (target === 'sync') return [slots.A, slots.B];
    return slots[target].file ? [slots[target]] : [];
  }

  /* ---------- 위치 체계 ----------
   * 한 영상 조정: 위치 = 그 영상의 실제 시간(영상 시간 × 배율)
   * 함께 보기:     위치 = 임팩트 기준 실제 시간
   */
  function posRange() {
    if (target === 'sync') return syncRange([slots.A, slots.B]);
    const s = slots[target];
    return { lo: 0, hi: toRealSeconds(s.duration, s.tb.timeScale) };
  }
  function currentPos() {
    if (target === 'sync') return playing ? offsetAt(slots.A, slots.A.video.currentTime) : syncPos;
    const s = slots[target];
    return toRealSeconds(s.video.currentTime, s.tb.timeScale);
  }
  function timeFor(s, pos) {
    const t = target === 'sync' ? timeAtOffset(s, pos) : pos / s.tb.timeScale;
    return Math.max(0, Math.min(s.duration - 1e-3, t));
  }

  async function seekSlot(s, t) {
    const ok = await seekTo(s.video, frameCenter(t, s.fileFps));
    if (!ok) s.seekTimeouts++;
  }

  // 마지막 요청만 처리하는 이동 큐(두 영상 함께)
  let seekBusy = false, seekPending = null;
  async function requestPos(pos) {
    seekPending = pos;
    if (seekBusy) return;
    seekBusy = true;
    while (seekPending !== null) {
      const p = seekPending;
      seekPending = null;
      if (target === 'sync') syncPos = p;
      await Promise.all(activeSlots().map((s) => seekSlot(s, timeFor(s, p))));
    }
    seekBusy = false;
    renderTime();
  }
  const seekSync = (pos) => requestPos(pos);

  /* ---------- 컨트롤 ---------- */
  const scrub = $('#cmp-scrub', panel);
  scrub.addEventListener('input', () => {
    stop();
    const { lo, hi } = posRange();
    requestPos(lo + (hi - lo) * (Number(scrub.value) / 1000));
  });
  function stepFrames(dir) {
    stop();
    const list = activeSlots();
    if (!list.length) return;
    if (target !== 'sync') {
      const s = list[0];
      const t = frameCenter(s.video.currentTime, s.fileFps) + dir / s.fileFps;
      requestPos(toRealSeconds(Math.max(0, Math.min(s.duration - 1e-3, t)), s.tb.timeScale));
      return;
    }
    // 함께 보기: 두 영상 중 더 촘촘한 쪽의 1프레임(실제 시간)만큼
    const step = Math.min(...list.map((s) => 1 / s.tb.effectiveFps));
    const { lo, hi } = posRange();
    requestPos(Math.max(lo, Math.min(hi, currentPos() + dir * step)));
  }
  $('#cmp-prev', panel).addEventListener('click', () => stepFrames(-1));
  $('#cmp-next', panel).addEventListener('click', () => stepFrames(1));
  $('#cmp-to-impact', panel).addEventListener('click', () => {
    stop();
    if (target === 'sync') { requestPos(0); return; }
    const s = slots[target];
    if (s.impact == null) { toast('아직 임팩트를 지정하지 않았어요.'); return; }
    requestPos(toRealSeconds(s.impact, s.tb.timeScale));
  });
  $('#cmp-play', panel).addEventListener('click', () => (playing ? stop() : play()));
  $('#cmp-set-impact', panel).addEventListener('click', async () => {
    if (target === 'sync') return;
    const s = slots[target];
    s.impact = frameCenter(s.video.currentTime, s.fileFps);
    renderSlot(s);
    const other = slots[target === 'A' ? 'B' : 'A'];
    if (bothReady()) {
      toast('두 영상의 임팩트가 정해졌어요. "함께 보기"로 비교하세요.');
      setTarget('sync');
    } else if (other.file && other.impact == null) {
      toast(`이제 영상 ${other.key}의 임팩트를 지정해 주세요.`);
      setTarget(other.key);
    } else {
      toast(`영상 ${s.key} 임팩트 지정 완료. 영상 ${other.key}도 불러와 주세요.`);
      renderAll();
    }
  });

  /* ---------- 재생 ---------- */
  function stop() {
    if (!playing) return;
    playing = false;
    playToken++;
    for (const k of ['A', 'B']) slots[k].video.pause();
    if (target === 'sync') syncPos = offsetAt(slots.A, slots.A.video.currentTime);
    renderAll();
  }

  async function play() {
    const list = activeSlots();
    if (!list.length) return;
    const speed = Number($('#cmp-rate', panel).value);
    const plan = playbackPlan(list, speed);
    const { lo, hi } = posRange();
    let pos = currentPos();
    if (pos >= hi - 1e-3 || pos < lo) pos = lo;
    playing = true;
    const token = ++playToken;
    renderAll();
    await Promise.all(list.map((s) => seekSlot(s, timeFor(s, pos))));
    if (token !== playToken) return;

    if (plan.native) {
      lastPlan = `동시 재생 (${list.map((s, i) => `${s.key} ×${fmt(plan.rates[i], 3)}`).join(', ')})`;
      list.forEach((s, i) => { s.video.playbackRate = plan.rates[i]; });
      try {
        await Promise.all(list.map((s) => s.video.play()));
      } catch {
        toast('재생을 시작하지 못했어요. 프레임 이동으로 확인해 주세요.');
        stop();
        return;
      }
      const tick = async () => {
        if (token !== playToken) return;
        const master = list[0];
        let p = target === 'sync' ? offsetAt(master, master.video.currentTime) : toRealSeconds(master.video.currentTime, master.tb.timeScale);
        if (p >= hi - 1e-3 || master.video.ended) {
          // 구간 끝: 처음으로 돌아가 반복
          list.forEach((s) => s.video.pause());
          await Promise.all(list.map((s) => seekSlot(s, timeFor(s, lo))));
          if (token !== playToken) return;
          await Promise.all(list.map((s) => s.video.play().catch(() => {})));
          p = lo;
        } else if (target === 'sync') {
          // 두 번째 영상이 2프레임 이상 어긋나면 위치를 맞춘다
          for (const s of list.slice(1)) {
            const expect = timeFor(s, p);
            if (Math.abs(s.video.currentTime - expect) > 2 / s.fileFps) {
              s.video.currentTime = expect;
              corrections++;
            }
          }
        }
        renderTime(p);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } else {
      // 배속이 범위를 벗어나면(예: 실시간 영상과 8배 슬로모션 파일 비교) 프레임 이동으로 재생
      lastPlan = `프레임 이동 재생 (배속 범위 밖: ${list.map((s, i) => `${s.key} ×${fmt(plan.rates[i], 2)}`).join(', ')})`;
      let last = performance.now();
      while (token === playToken) {
        const now = performance.now();
        pos += speed * ((now - last) / 1000);
        last = now;
        if (pos > hi) pos = lo;
        if (target === 'sync') syncPos = pos;
        await Promise.all(list.map((s) => seekSlot(s, timeFor(s, pos))));
        renderTime(pos);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    renderDiag();
  }

  /* ---------- 표시 ---------- */
  function renderTime(pos = currentPos()) {
    const { lo, hi } = posRange();
    if (document.activeElement !== scrub && hi > lo) scrub.value = String(Math.round(((pos - lo) / (hi - lo)) * 1000));
    let text;
    if (target === 'sync') {
      const sign = pos > 0 ? '+' : '';
      text = `임팩트 기준 ${sign}${fmt(pos, 3)}초 (실제) · A ${fmt(slots.A.video.currentTime, 3)}초 · B ${fmt(slots.B.video.currentTime, 3)}초`;
    } else {
      const s = slots[target];
      text = `영상 ${s.key} · 영상 ${fmt(s.video.currentTime, 3)}초 · 실제 ${fmt(pos, 3)}초 · 프레임 ${Math.floor(s.video.currentTime * s.fileFps + 1e-6)}`;
    }
    $('#cmp-timecode', panel).textContent = text;
  }

  function renderAll() {
    targetSeg.querySelectorAll('button').forEach((b) => {
      const v = b.dataset.value;
      b.disabled = v === 'sync' ? !bothReady() : !slots[v].file;
      b.classList.toggle('is-on', v === target);
    });
    for (const k of ['A', 'B']) slots[k].col.classList.toggle('is-target', target === k || target === 'sync');
    $('#cmp-play', panel).textContent = playing ? '⏸' : '▶︎';
    const setBtn = $('#cmp-set-impact', panel);
    setBtn.hidden = target === 'sync';
    if (target !== 'sync') setBtn.textContent = `현재 프레임 = ${target} 임팩트`;
    $('#cmp-to-impact', panel).textContent = target === 'sync' ? '임팩트로' : `${target} 임팩트로`;
    let hint = '';
    if (!slots.A.file || !slots.B.file) hint = '아래에서 영상 A와 B를 모두 불러와 주세요.';
    else if (!bothReady()) hint = '각 영상의 임팩트 프레임을 지정하면 "함께 보기"가 켜져요.';
    else if (target === 'sync') hint = '두 영상이 임팩트 순간에 맞춰져 있어요. 배속은 "실제 시간" 기준이에요.';
    else hint = `영상 ${target}만 움직여요. 임팩트를 다시 지정할 수 있어요.`;
    $('#cmp-hint', panel).textContent = hint;
    renderTime();
    renderDiag();
  }

  function renderDiag() {
    const rows = [];
    for (const k of ['A', 'B']) {
      const s = slots[k];
      if (!s.file) continue;
      rows.push(`<dt>영상 ${k}</dt><dd>${s.fileFps}fps · ${s.tb.resolvedType} · 배율 ×${fmt(s.tb.timeScale, 4)} · 1프레임 = 실제 ${fmt(1000 / s.tb.effectiveFps, 1)}ms${s.meta?.isVFR ? ' · VFR' : ''} · 이동 타임아웃 ${s.seekTimeouts}회</dd>`);
    }
    if (bothReady()) {
      const { lo, hi } = syncRange([slots.A, slots.B]);
      rows.push(`<dt>함께 보기 구간</dt><dd>임팩트 기준 ${fmt(lo, 2)} ~ +${fmt(hi, 2)}초 (실제)</dd>`);
      const plan = playbackPlan([slots.A, slots.B], Number($('#cmp-rate', panel).value));
      rows.push(`<dt>재생 방식</dt><dd>${plan.native ? '동시 재생' : '프레임 이동 재생'} (A ×${fmt(plan.rates[0], 3)}, B ×${fmt(plan.rates[1], 3)})</dd>`);
    }
    if (lastPlan) rows.push(`<dt>마지막 재생</dt><dd>${lastPlan}</dd>`);
    rows.push(`<dt>동기 보정</dt><dd>${corrections}회</dd>`);
    $('#cmp-diag', panel).innerHTML = rows.join('');
  }

  $('#cmp-rate', panel).addEventListener('change', () => { stop(); renderDiag(); });

  // 탭 전환 시 재생 정지
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    if (t.dataset.tab === 'compare') onEnter?.();
    else stop();
  }));

  layout();
  renderAll();
  return { slots };
}
