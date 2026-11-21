// 실제 결과 입력 폼과 추측 결과 표시(화면 조각). 분석 결과 화면과 기록 탭에서 함께 쓴다.

import { CLUBS, CLUB_LABEL, START_LABEL, CURVE_LABEL, MIN_SAMPLES, beatsBaseline, featuresFrom } from './predict.js';

const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '-');

export const emptyOutcome = (club = null) => ({ club, distance: null, start: null, curve: null, contact: 'good' });

/** 입력된 값이 하나라도 있는지 */
export function hasOutcome(o) {
  return !!o && (Number.isFinite(o.distance) || Number.isFinite(o.start) || Number.isFinite(o.curve));
}

/** 기록 요약 문구 */
export function outcomeSummary(o) {
  if (!hasOutcome(o)) return '';
  const parts = [];
  if (o.club) parts.push(CLUB_LABEL[o.club]);
  if (Number.isFinite(o.distance)) parts.push(`${fmt(o.distance)}m`);
  if (Number.isFinite(o.start)) parts.push(`출발 ${START_LABEL[o.start]}`);
  if (Number.isFinite(o.curve)) parts.push(`휘어짐 ${CURVE_LABEL[o.curve]}`);
  if (o.contact === 'mishit') parts.push('빗맞음(학습 제외)');
  return parts.join(' · ');
}

/** 예전 기록에는 features가 없을 수 있어 지표에서 다시 만든다 */
export function withFeatures(records) {
  return records.map((r) => (r.features ? r : { ...r, features: featuresFrom(r) }));
}

/**
 * 결과 입력 폼을 container에 그리고 값이 바뀔 때 onChange(outcome)를 부른다.
 * @returns {{get:()=>object}}
 */
export function mountOutcomeForm(container, outcome, onChange) {
  const o = { ...emptyOutcome(), ...outcome };
  const seg = (name, opts) => `
    <div class="seg seg-${opts.length} seg-wrap" data-of="${name}">
      ${opts.map(([v, l]) => `<button type="button" data-value="${v}" class="${String(o[name]) === String(v) ? 'is-on' : ''}">${l}</button>`).join('')}
    </div>`;
  container.innerHTML = `
    <div class="field">
      <span class="field-label">클럽</span>
      <select data-of="club">
        <option value="">선택 안 함</option>
        ${CLUBS.map(([v, l]) => `<option value="${v}" ${o.club === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <span class="field-label">거리 (m, 캐리 또는 대략)</span>
      <input type="number" inputmode="numeric" min="1" max="400" step="1" data-of="distance" placeholder="예: 145" value="${Number.isFinite(o.distance) ? o.distance : ''}" />
    </div>
    <div class="field">
      <span class="field-label">출발 방향 <em class="opt">타깃을 바라봤을 때</em></span>
      ${seg('start', [[-1, '왼쪽'], [0, '똑바로'], [1, '오른쪽']])}
    </div>
    <div class="field">
      <span class="field-label">휘어짐</span>
      ${seg('curve', [[-2, '←← 크게'], [-1, '← 조금'], [0, '없음'], [1, '조금 →'], [2, '크게 →→']])}
    </div>
    <div class="field">
      <span class="field-label">타구</span>
      ${seg('contact', [['good', '정타'], ['mishit', '빗맞음 (뒤땅·탑볼·생크)']])}
      <p class="hint">빗맞은 샷은 학습에서 빼서 추측이 흐트러지지 않게 해요.</p>
    </div>`;

  const emit = () => onChange?.({ ...o });
  container.querySelector('[data-of="club"]').addEventListener('change', (e) => { o.club = e.target.value || null; emit(); });
  container.querySelector('[data-of="distance"]').addEventListener('input', (e) => {
    const n = Number(e.target.value);
    o.distance = e.target.value !== '' && Number.isFinite(n) && n > 0 && n <= 400 ? n : null;
    emit();
  });
  container.querySelectorAll('.seg[data-of]').forEach((sg) => {
    const name = sg.dataset.of;
    sg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const raw = b.dataset.value;
      const val = name === 'contact' ? raw : Number(raw);
      // 같은 버튼을 다시 누르면 선택 해제(정타/빗맞음 제외)
      o[name] = name !== 'contact' && o[name] === val ? null : val;
      sg.querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', String(o[name]) === x.dataset.value));
      emit();
    }));
  });
  return { get: () => ({ ...o }) };
}

const VIEW_LABEL = { face: '정면', dtl: '후방' };

/**
 * 추측 결과 HTML
 * @param {object} pred predictSwing 결과
 * @param {{view:string, club:string|null, featureLabels:Record<string,string>}} ctx
 */
export function predictionHTML(pred, { view, club, featureLabels }) {
  const keysText = (keys) => (keys?.length ? `추측에 많이 반영된 지표: ${keys.slice(0, 3).map((k) => featureLabels[k] || k).join(', ')}` : '');
  const waiting = (count, need, what) => `<p class="pred-wait">${what} 정타 기록 <b>${count}/${need}</b>개 — ${need - count}개 더 모이면 추측을 시작해요.</p>`;
  const distRow = (d) => Object.entries(d).sort((a, b) => b[1] - a[1]);
  let html = '';

  // 거리
  html += '<div class="pred-block"><div class="pred-title">거리</div>';
  if (!club) {
    html += '<p class="pred-wait">아래에서 클럽을 고르면 거리를 추측해요.</p>';
  } else if (!Number.isFinite(pred.distance?.value)) {
    html += waiting(pred.distance?.count ?? 0, MIN_SAMPLES, `${CLUB_LABEL[club]}·${VIEW_LABEL[view]}`);
  } else {
    const p = pred.distance;
    const good = beatsBaseline(p.eval, 'distance');
    html += `<div class="pred-main">약 ${fmt(p.value)}m <span class="pred-sub">비슷한 스윙 ${fmt(p.min)}~${fmt(p.max)}m</span></div>`;
    if (p.eval) {
      html += `<p class="pred-acc">과거 기록으로 시험한 평균 오차 <b>±${fmt(p.eval.mae)}m</b> (클럽 평균만 쓸 때 ±${fmt(p.eval.baselineMae)}m, ${p.eval.n}개)</p>`;
    }
    if (!good) html += `<p class="pred-warn">아직 스윙 지표로 거리 차이를 설명하지 못해요. 이 클럽 평균 <b>${fmt(p.clubAvg)}m</b>가 더 믿을 만해요.</p>`;
    html += `<p class="pred-keys">${keysText(p.keys)}</p>`;
  }
  html += '</div>';

  // 방향
  for (const [target, title, labels] of [['start', '출발 방향', START_LABEL], ['curve', '휘어짐', CURVE_LABEL]]) {
    const p = pred[target];
    html += `<div class="pred-block"><div class="pred-title">${title}</div>`;
    if (!Number.isFinite(p?.value)) {
      html += waiting(p?.count ?? 0, MIN_SAMPLES, `${VIEW_LABEL[view]} 영상`);
    } else {
      const good = beatsBaseline(p.eval, target);
      html += `<div class="pred-main">${labels[p.value]}</div>`;
      html += `<p class="pred-sub">비슷한 스윙 ${Object.values(p.dist).reduce((a, b) => a + b, 0)}개: ${distRow(p.dist).map(([v, c]) => `${labels[v]} ${c}`).join(' · ')}</p>`;
      if (p.eval) html += `<p class="pred-acc">과거 기록으로 시험한 적중률 <b>${Math.round(p.eval.hitRate * 100)}%</b> (가장 흔한 결과만 고를 때 ${Math.round(p.eval.baselineHitRate * 100)}%)</p>`;
      if (!good) html += '<p class="pred-warn">아직 스윙 지표로 방향 차이를 설명하지 못해요. 참고만 하세요.</p>';
      html += `<p class="pred-keys">${keysText(p.keys)}</p>`;
    }
    html += '</div>';
  }
  html += '<p class="pred-note">영상으로는 페이스 각도·스핀을 잴 수 없어, 물리 계산이 아니라 <b>지표가 비슷했던 내 과거 스윙의 실제 결과</b>로 추측한 값이에요. 같은 촬영 방향·정타 기록만 사용해요.</p>';
  return html;
}

/** 기록 탭 상단: 학습 현황 */
export function learningStatusHTML(records) {
  const rows = [];
  for (const view of ['face', 'dtl']) {
    const good = records.filter((r) => r.view === view && r.outcome && r.outcome.contact !== 'mishit');
    const dir = good.filter((r) => Number.isFinite(r.outcome.start) || Number.isFinite(r.outcome.curve)).length;
    const byClub = {};
    for (const r of good) if (r.outcome.club && Number.isFinite(r.outcome.distance)) byClub[r.outcome.club] = (byClub[r.outcome.club] || 0) + 1;
    const cnt = (n) => (n >= MIN_SAMPLES ? `${n}개 ✔` : `${n}/${MIN_SAMPLES}`);
    const clubs = Object.entries(byClub).map(([c, n]) => `${CLUB_LABEL[c]} ${cnt(n)}`);
    if (!dir && !clubs.length) continue;
    rows.push(`<li><b>${VIEW_LABEL[view]}</b> · 방향 ${cnt(dir)}${clubs.length ? ` · 거리: ${clubs.join(', ')}` : ''}</li>`);
  }
  if (!rows.length) return '<p class="hint">스윙을 저장할 때 실제 결과(클럽·거리·방향)를 적으면 추측 학습이 시작돼요. 기록마다 "결과 입력"으로 나중에 적을 수도 있어요.</p>';
  return `<ul class="learn-list">${rows.join('')}</ul><p class="hint">✔ 표시된 항목부터 새 스윙의 결과를 추측해요.</p>`;
}
