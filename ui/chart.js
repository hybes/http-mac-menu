// The two drawings of a value's numeric history: a sparkline for lists and an
// interactive trend for a single value. One series, one colour; every number
// the plot implies is also written out as text.
(() => {
  const { h, svg } = window.httpWidgets.dom;

  const MAX_SPARKLINE_POINTS = 256;
  const TREND_HEIGHT = 132;
  const TREND_PAD = { top: 12, bottom: 12, side: 6 };

  const finitePoints = (points) => {
    if (!Array.isArray(points)) return [];
    const sorted = points
      .filter(
        (point) =>
          point &&
          Number.isFinite(point.timestamp) &&
          Number.isFinite(point.value)
      )
      .map((point) => ({ timestamp: point.timestamp, value: point.value }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (sorted.length <= MAX_SPARKLINE_POINTS) return sorted;
    return Array.from({ length: MAX_SPARKLINE_POINTS }, (_, index) => {
      const sourceIndex = Math.round(
        (index * (sorted.length - 1)) / (MAX_SPARKLINE_POINTS - 1)
      );
      return sorted[sourceIndex];
    });
  };

  const formatNumber = (value, signDisplay = 'auto') =>
    Number.isFinite(value)
      ? new Intl.NumberFormat(undefined, {
          maximumSignificantDigits: 6,
          signDisplay,
        }).format(value)
      : '—';

  const milliseconds = (timestamp) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return Math.abs(timestamp) < 10_000_000_000 ? timestamp * 1000 : timestamp;
  };

  const clock = (timestamp) => {
    const time = milliseconds(timestamp);
    if (time === null) return '';
    const date = new Date(time);
    const today = date.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(
      undefined,
      today
        ? { hour: '2-digit', minute: '2-digit' }
        : { weekday: 'short', hour: '2-digit', minute: '2-digit' }
    ).format(date);
  };

  const relativeTime = (timestamp) => {
    const time = milliseconds(timestamp);
    if (time === null) return { label: 'Waiting for data', dateTime: '' };
    const date = new Date(time);
    const elapsed = Math.max(0, Math.round((Date.now() - time) / 1000));
    let label = 'just now';
    if (elapsed >= 86_400) {
      label = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(date);
    } else if (elapsed >= 3_600) {
      label = `${Math.floor(elapsed / 3_600)}h ago`;
    } else if (elapsed >= 60) {
      label = `${Math.floor(elapsed / 60)}m ago`;
    } else if (elapsed >= 10) {
      label = `${elapsed}s ago`;
    }
    return {
      label,
      dateTime: date.toISOString(),
      exact: date.toLocaleString(),
    };
  };

  const summarise = (points) => {
    if (!points.length) return null;
    const values = points.map((point) => point.value);
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    let change = points.length > 1 ? formatNumber(delta, 'exceptZero') : '—';
    if (points.length > 1 && first !== 0) {
      const percentage = new Intl.NumberFormat(undefined, {
        style: 'percent',
        maximumFractionDigits: 1,
        signDisplay: 'exceptZero',
      }).format(delta / Math.abs(first));
      change = `${change} (${percentage})`;
    }
    return {
      low: Math.min(...values),
      high: Math.max(...values),
      first,
      last,
      change,
      direction: delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat',
    };
  };

  const project = (points, width, height, pad) => {
    const values = points.map((point) => point.value);
    const low = Math.min(...values);
    const range = Math.max(...values) - low;
    const start = points[0].timestamp;
    const span = points[points.length - 1].timestamp - start;
    const innerWidth = width - pad.side * 2;
    const innerHeight = height - pad.top - pad.bottom;
    return points.map((point, index) => ({
      x:
        pad.side +
        (span > 0
          ? (point.timestamp - start) / span
          : index / Math.max(1, points.length - 1)) *
          innerWidth,
      y:
        pad.top +
        (1 - (range > 0 ? (point.value - low) / range : 0.5)) * innerHeight,
    }));
  };

  const pathThrough = (coordinates) =>
    coordinates
      .map(
        ({ x, y }, index) =>
          `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
      )
      .join(' ');

  const sparkline = (points, className = 'sparkline') => {
    const clean = finitePoints(points);
    if (clean.length < 2) return null;
    const width = 96;
    const height = 28;
    const coordinates = project(clean, width, height, {
      top: 3,
      bottom: 3,
      side: 2,
    });
    return svg(
      'svg',
      {
        class: className,
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      svg('path', { d: pathThrough(coordinates) })
    );
  };

  // The larger plot. Hover, drag or use the arrow keys to read any sample;
  // with nothing selected the readout shows the latest one.
  const createTrend = () => {
    const readoutValue = h('strong', { class: 'trend-readout-value' });
    const readoutTime = h('span', { class: 'trend-readout-time' });
    const readout = h(
      'p',
      { class: 'trend-readout' },
      readoutValue,
      readoutTime
    );

    const grid = svg('g', { class: 'trend-grid' });
    const area = svg('path', { class: 'trend-area' });
    const line = svg('path', { class: 'trend-line' });
    const crosshair = svg('line', { class: 'trend-crosshair' });
    const dot = svg('circle', { class: 'trend-dot', r: '4' });
    const plot = svg(
      'svg',
      {
        class: 'trend-plot',
        role: 'slider',
        tabindex: '0',
        focusable: 'true',
        'aria-orientation': 'horizontal',
      },
      grid,
      area,
      line,
      crosshair,
      dot
    );

    const high = h('span', { class: 'trend-bound trend-bound-high' });
    const low = h('span', { class: 'trend-bound trend-bound-low' });
    const empty = h('p', { class: 'trend-empty' });
    const frame = h('div', { class: 'trend-frame' }, plot, high, low, empty);

    const axisStart = h('span');
    const axisEnd = h('span');
    const axis = h(
      'p',
      { class: 'trend-axis', 'aria-hidden': 'true' },
      axisStart,
      axisEnd
    );
    const stats = h('dl', { class: 'trend-stats' });
    const element = h(
      'figure',
      { class: 'trend' },
      readout,
      frame,
      axis,
      stats
    );

    let points = [];
    let coordinates = [];
    let width = 0;
    let selected = null;
    let signature = '';
    let label = 'Value';

    const stat = (term, description) =>
      h(
        'div',
        { class: 'trend-stat' },
        h('dt', { text: term }),
        h('dd', { text: description })
      );

    const showSelection = () => {
      const index = selected ?? points.length - 1;
      const point = points[index];
      const position = coordinates[index];
      if (!point || !position) return;
      readoutValue.textContent = formatNumber(point.value);
      readoutTime.textContent =
        selected === null
          ? `latest, ${clock(point.timestamp)}`
          : clock(point.timestamp);
      dot.setAttribute('cx', position.x.toFixed(2));
      dot.setAttribute('cy', position.y.toFixed(2));
      crosshair.setAttribute('x1', position.x.toFixed(2));
      crosshair.setAttribute('x2', position.x.toFixed(2));
      crosshair.setAttribute('y1', '0');
      crosshair.setAttribute('y2', String(TREND_HEIGHT));
      crosshair.classList.toggle('is-active', selected !== null);
      plot.setAttribute('aria-valuenow', String(index));
      plot.setAttribute(
        'aria-valuetext',
        `${formatNumber(point.value)} at ${clock(point.timestamp)}`
      );
    };

    const draw = () => {
      const drawable = points.length >= 2 && width > 0;
      element.dataset.state = drawable ? 'ready' : 'empty';
      plot.setAttribute('viewBox', `0 0 ${Math.max(1, width)} ${TREND_HEIGHT}`);
      if (!drawable) {
        coordinates = [];
        return;
      }
      coordinates = project(points, width, TREND_HEIGHT, TREND_PAD);
      const baseline = TREND_HEIGHT - TREND_PAD.bottom;
      const top = TREND_PAD.top;
      grid.replaceChildren(
        svg('line', {
          x1: '0',
          x2: String(width),
          y1: String(top),
          y2: String(top),
        }),
        svg('line', {
          x1: '0',
          x2: String(width),
          y1: String(baseline),
          y2: String(baseline),
        })
      );
      const outline = pathThrough(coordinates);
      line.setAttribute('d', outline);
      area.setAttribute(
        'd',
        `${outline} L${coordinates[coordinates.length - 1].x.toFixed(2)} ${baseline} L${coordinates[0].x.toFixed(2)} ${baseline} Z`
      );
      plot.setAttribute('aria-valuemin', '0');
      plot.setAttribute('aria-valuemax', String(points.length - 1));
      showSelection();
    };

    const select = (index) => {
      if (!coordinates.length) return;
      selected =
        index === null
          ? null
          : Math.min(coordinates.length - 1, Math.max(0, index));
      showSelection();
    };

    const nearest = (clientX) => {
      const bounds = plot.getBoundingClientRect();
      const x = clientX - bounds.left;
      let best = 0;
      let distance = Infinity;
      coordinates.forEach((position, index) => {
        const gap = Math.abs(position.x - x);
        if (gap < distance) {
          distance = gap;
          best = index;
        }
      });
      return best;
    };

    plot.addEventListener('pointermove', (event) => {
      if (coordinates.length) select(nearest(event.clientX));
    });
    plot.addEventListener('pointerdown', (event) => {
      if (coordinates.length) select(nearest(event.clientX));
    });
    plot.addEventListener('pointerleave', () => select(null));
    plot.addEventListener('blur', () => select(null));
    plot.addEventListener('keydown', (event) => {
      if (!coordinates.length) return;
      const current = selected ?? coordinates.length - 1;
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (step) {
        event.preventDefault();
        select(current + step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        select(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        select(coordinates.length - 1);
      }
    });

    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0].contentRect.width);
      if (next === width) return;
      width = next;
      draw();
    });
    observer.observe(frame);

    const update = (rawPoints, { name = 'Value', ready = true } = {}) => {
      const next = finitePoints(rawPoints);
      const last = next[next.length - 1];
      const nextSignature = `${next.length}:${last?.timestamp}:${last?.value}:${ready}`;
      label = name;
      plot.setAttribute(
        'aria-label',
        `${label}, samples from the last 24 hours`
      );
      if (nextSignature === signature) return;
      signature = nextSignature;
      points = next;
      if (selected !== null && selected >= points.length) selected = null;

      const summary = summarise(points);
      if (points.length < 2 || !summary) {
        readout.hidden = true;
        axis.hidden = true;
        stats.replaceChildren();
        high.textContent = '';
        low.textContent = '';
        empty.textContent = !ready
          ? 'Finish the setup to start collecting readings.'
          : points.length === 1
            ? 'One reading so far. The trend appears after the next one.'
            : 'No numeric readings yet. Text values are shown without a trend.';
        draw();
        return;
      }

      readout.hidden = false;
      axis.hidden = false;
      empty.textContent = '';
      high.textContent = formatNumber(summary.high);
      low.textContent = formatNumber(summary.low);
      axisStart.textContent = clock(points[0].timestamp);
      axisEnd.textContent = clock(last.timestamp);
      stats.replaceChildren(
        stat('Low', formatNumber(summary.low)),
        stat('High', formatNumber(summary.high)),
        stat('Change', summary.change)
      );
      draw();
    };

    return {
      element,
      update,
      destroy: () => observer.disconnect(),
    };
  };

  window.httpWidgets.chart = {
    MAX_SPARKLINE_POINTS,
    finitePoints,
    formatNumber,
    relativeTime,
    sparkline,
    createTrend,
  };
})();
