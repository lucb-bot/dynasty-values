/**
 * Value-history line chart, drawn as inline SVG.
 *
 * One series, so no legend is needed - the title names it. Follows the house
 * chart rules: 2px line, recessive grid and axes, no number printed on every
 * point, values in text tokens rather than the series color, and a crosshair
 * plus tooltip on hover because an SVG chart on a web page is interactive by
 * default.
 */

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  return n;
};

const fmtValue = (v) => Math.round(v).toLocaleString();
const fmtDate = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'UTC' });
};

/** "Nice" round gridline steps for a value axis. */
function niceTicks(min, max, count = 4) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) out.push(t);
  return out;
}

/**
 * @param dates  ISO date strings, ascending
 * @param values numbers aligned with `dates`; null for a missing week
 */
export function valueHistoryChart(dates, values, { width = 620, height = 220, label = 'Blended value' } = {}) {
  const pts = [];
  for (let i = 0; i < dates.length; i++) {
    if (Number.isFinite(values[i])) pts.push({ i, date: dates[i], v: values[i] });
  }
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';

  if (pts.length < 2) {
    wrap.innerHTML = '<div class="empty">Not enough history for this asset yet.</div>';
    return wrap;
  }

  const pad = { t: 12, r: 14, b: 26, l: 52 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const vMin = Math.min(...pts.map((p) => p.v));
  const vMax = Math.max(...pts.map((p) => p.v));
  const span = vMax - vMin || 1;
  const lo = Math.max(0, vMin - span * 0.12);
  const hi = vMax + span * 0.12;

  const x = (i) => pad.l + (i / (dates.length - 1)) * innerW;
  const y = (v) => pad.t + innerH - ((v - lo) / (hi - lo)) * innerH;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    role: 'img', 'aria-label': `${label} over time`, class: 'vchart',
    preserveAspectRatio: 'none',
  });

  // Recessive gridlines and value labels.
  for (const t of niceTicks(lo, hi)) {
    svg.append(el('line', { x1: pad.l, x2: width - pad.r, y1: y(t), y2: y(t), class: 'grid' }));
    const lab = el('text', { x: pad.l - 8, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' });
    lab.textContent = fmtValue(t);
    svg.append(lab);
  }

  // Date labels at the ends and middle only - never one per point.
  for (const idx of [0, Math.floor((dates.length - 1) / 2), dates.length - 1]) {
    const lab = el('text', {
      x: x(idx), y: height - 8, class: 'axis',
      'text-anchor': idx === 0 ? 'start' : idx === dates.length - 1 ? 'end' : 'middle',
    });
    lab.textContent = fmtDate(dates[idx]);
    svg.append(lab);
  }

  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const areaD = `${d} L${x(pts[pts.length - 1].i).toFixed(1)},${pad.t + innerH} L${x(pts[0].i).toFixed(1)},${pad.t + innerH} Z`;
  svg.append(el('path', { d: areaD, class: 'vchart-area' }));
  svg.append(el('path', { d, class: 'vchart-line', fill: 'none' }));

  // Endpoint marker, the one point worth calling out.
  const last = pts[pts.length - 1];
  svg.append(el('circle', { cx: x(last.i), cy: y(last.v), r: 4, class: 'vchart-dot' }));

  // Crosshair + tooltip.
  const cross = el('line', { y1: pad.t, y2: pad.t + innerH, class: 'vchart-cross', opacity: 0 });
  const hoverDot = el('circle', { r: 4.5, class: 'vchart-hover', opacity: 0 });
  svg.append(cross, hoverDot);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  const hit = el('rect', { x: pad.l, y: pad.t, width: innerW, height: innerH, fill: 'transparent', style: 'cursor:crosshair' });
  svg.append(hit);

  const move = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * width;
    let best = pts[0], bestGap = Infinity;
    for (const p of pts) {
      const gap = Math.abs(x(p.i) - px);
      if (gap < bestGap) { bestGap = gap; best = p; }
    }
    cross.setAttribute('x1', x(best.i)); cross.setAttribute('x2', x(best.i));
    cross.setAttribute('opacity', 1);
    hoverDot.setAttribute('cx', x(best.i)); hoverDot.setAttribute('cy', y(best.v));
    hoverDot.setAttribute('opacity', 1);
    tip.hidden = false;
    tip.innerHTML = `<b>${fmtValue(best.v)}</b><span>${fmtDate(best.date)}</span>`;
    const leftPct = (x(best.i) / width) * 100;
    tip.style.left = `${Math.min(88, Math.max(4, leftPct))}%`;
  };
  const leave = () => { cross.setAttribute('opacity', 0); hoverDot.setAttribute('opacity', 0); tip.hidden = true; };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', leave);

  wrap.append(svg, tip);
  return wrap;
}
