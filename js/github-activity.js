// js/github-activity.js
//
// Renders the GitHub contribution calendar on the home page from the static
// file at data/github-activity.json. That file is rebuilt by a scheduled
// GitHub Action, so the browser needs no token and there is no API call at
// page load beyond fetching one small JSON file from this same origin.

(function () {
  'use strict';

  const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const MIN_LABELLED_WEEKS = 3;   // narrower than this and month labels collide

  const dayFormatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });

  const monthFormatter = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
  const rangeFormatter = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });

  const parseDay = date => new Date(`${date}T00:00:00Z`);
  const plural = (count, word) => `${count.toLocaleString('en-GB')} ${word}${count === 1 ? '' : 's'}`;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function describe(day) {
    const when = dayFormatter.format(parseDay(day.date));
    return day.count === 0
      ? `No contributions on ${when}`
      : `${plural(day.count, 'contribution')} on ${when}`;
  }

  /**
   * Splits the flat day list into calendar columns. Every column holds one week
   * running Sunday to Saturday; the first and last are usually partial, and the
   * missing cells are left out of the DOM rather than filled with blanks so the
   * grid exposes only real days to assistive technology.
   */
  function toWeeks(days) {
    const weeks = [];
    let current = null;

    days.forEach(day => {
      const weekday = parseDay(day.date).getUTCDay();
      if (!current || weekday === 0) {
        current = [];
        weeks.push(current);
      }
      current[weekday] = day;
    });

    return weeks;
  }

  /** Month captions, each starting at the column that carries its first day. */
  function monthSpans(weeks) {
    const spans = [];

    weeks.forEach((week, index) => {
      const firstDay = week.find(Boolean);
      if (!firstDay) return;

      const date = parseDay(firstDay.date);
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const previous = spans.at(-1);

      if (previous && previous.key === key) {
        previous.span += 1;
        return;
      }

      spans.push({ key, label: monthFormatter.format(date), start: index, span: 1 });
    });

    // A month whose first column is the tail of the previous one gets no room
    // for a caption, so it borrows the space of the month before it instead.
    return spans.filter(span => span.span >= MIN_LABELLED_WEEKS);
  }

  function buildMonths(weeks) {
    const row = element('div', 'gh-graph__months');
    row.setAttribute('aria-hidden', 'true');

    monthSpans(weeks).forEach(span => {
      const label = element('span', 'gh-graph__month', span.label);
      label.style.gridColumn = `${span.start + 1} / span ${span.span}`;
      row.appendChild(label);
    });

    return row;
  }

  function buildWeekdays() {
    const column = element('div', 'gh-graph__weekdays');
    column.setAttribute('aria-hidden', 'true');
    WEEKDAY_LABELS.forEach(label => column.appendChild(element('span', 'gh-graph__weekday', label)));
    return column;
  }

  function buildGrid(activity, weeks) {
    const grid = element('div', 'gh-graph__grid');
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-readonly', 'true');
    grid.setAttribute('aria-label',
      `Contribution calendar: ${plural(activity.totalContributions, 'contribution')} between ` +
      `${rangeFormatter.format(parseDay(activity.from))} and ${rangeFormatter.format(parseDay(activity.to))}`);

    const cells = [];

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const row = element('div', 'gh-graph__row');
      row.setAttribute('role', 'row');
      let placed = false;

      weeks.forEach((week, weekIndex) => {
        const day = week[weekday];
        if (!day) return;

        const cell = element('span', 'gh-day');
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('tabindex', '-1');
        cell.setAttribute('aria-label', describe(day));
        cell.dataset.level = String(day.level);
        cell.dataset.week = String(weekIndex);
        cell.dataset.weekday = String(weekday);

        // Leading gap in the first partial week: start the row at its real
        // column instead of padding it with cells that mean nothing.
        if (!placed && weekIndex > 0) cell.style.gridColumnStart = String(weekIndex + 1);
        placed = true;

        row.appendChild(cell);
        cells.push(cell);
      });

      grid.appendChild(row);
    }

    return { grid, cells };
  }

  /**
   * One tooltip node for the whole calendar, positioned over the hovered or
   * focused day. It lives outside the scrolling area so it is never clipped.
   */
  function createTooltip(container) {
    const tip = element('div', 'gh-tip');
    tip.setAttribute('aria-hidden', 'true');
    container.appendChild(tip);

    return {
      show(cell) {
        tip.textContent = cell.getAttribute('aria-label');
        tip.classList.add('is-visible');

        const bounds = container.getBoundingClientRect();
        const cellBounds = cell.getBoundingClientRect();
        const centre = cellBounds.left + cellBounds.width / 2 - bounds.left;
        const half = tip.offsetWidth / 2;

        tip.style.left = `${Math.min(Math.max(centre, half + 4), bounds.width - half - 4)}px`;
        tip.style.top = `${cellBounds.top - bounds.top}px`;
      },
      hide() {
        tip.classList.remove('is-visible');
      }
    };
  }

  /**
   * Arrow-key movement over the calendar with a single tab stop, so keyboard
   * users can reach every day without 300-odd stops in the tab order.
   */
  function addKeyboardNavigation(grid, cells) {
    if (cells.length === 0) return;

    const byPosition = new Map(cells.map(cell => [`${cell.dataset.week}:${cell.dataset.weekday}`, cell]));
    let active = cells[0];
    active.setAttribute('tabindex', '0');

    const focus = cell => {
      if (!cell || cell === active) return;
      active.setAttribute('tabindex', '-1');
      active = cell;
      active.setAttribute('tabindex', '0');
      active.focus();
    };

    const step = (cell, weeks, weekdays) => {
      const week = Number(cell.dataset.week) + weeks;
      const weekday = Number(cell.dataset.weekday) + weekdays;
      return byPosition.get(`${week}:${weekday}`);
    };

    grid.addEventListener('keydown', event => {
      const cell = event.target.closest('.gh-day');
      if (!cell) return;

      const moves = {
        ArrowLeft: () => step(cell, -1, 0),
        ArrowRight: () => step(cell, 1, 0),
        ArrowUp: () => step(cell, 0, -1),
        ArrowDown: () => step(cell, 0, 1),
        Home: () => cells[0],
        End: () => cells.at(-1)
      };

      const move = moves[event.key];
      if (!move) return;

      const next = move();
      if (!next) return;

      event.preventDefault();
      focus(next);
    });

    // Clicking a day makes it the tab stop, so focus returns where the visitor
    // last looked rather than to the start of the year.
    grid.addEventListener('pointerdown', event => {
      const cell = event.target.closest('.gh-day');
      if (cell) focus(cell);
    });
  }

  function buildLegend() {
    const legend = element('div', 'gh-legend');
    legend.appendChild(element('span', 'gh-legend__label', 'Less'));

    for (let level = 0; level <= 4; level += 1) {
      const swatch = element('span', 'gh-day gh-day--legend');
      swatch.dataset.level = String(level);
      swatch.setAttribute('aria-hidden', 'true');
      legend.appendChild(swatch);
    }

    legend.appendChild(element('span', 'gh-legend__label', 'More'));
    return legend;
  }

  function buildHeader(activity) {
    const header = element('div', 'gh-activity__head');

    const total = element('p', 'gh-activity__total');
    total.appendChild(element('strong', null, activity.totalContributions.toLocaleString('en-GB')));
    total.appendChild(document.createTextNode(
      ` contribution${activity.totalContributions === 1 ? '' : 's'} in the last year`));
    header.appendChild(total);

    const link = element('a', 'gh-activity__link', `@${activity.login} on GitHub`);
    link.href = activity.profileUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    header.appendChild(link);

    return header;
  }

  function buildFooter(activity) {
    const footer = element('div', 'gh-activity__foot');
    footer.appendChild(element('p', 'gh-activity__updated',
      `Up to ${rangeFormatter.format(parseDay(activity.to))}`));
    footer.appendChild(buildLegend());
    return footer;
  }

  function render(root, activity) {
    const weeks = toWeeks(activity.days);
    const { grid, cells } = buildGrid(activity, weeks);

    const graph = element('div', 'gh-graph');
    graph.style.setProperty('--gh-weeks', String(weeks.length));
    graph.appendChild(buildMonths(weeks));
    graph.appendChild(buildWeekdays());
    graph.appendChild(grid);

    const scroller = element('div', 'gh-activity__scroll');
    scroller.appendChild(graph);

    root.textContent = '';
    root.appendChild(buildHeader(activity));
    root.appendChild(scroller);
    root.appendChild(buildFooter(activity));

    const tooltip = createTooltip(root);
    const showFor = event => {
      const cell = event.target.closest('.gh-day');
      if (cell) tooltip.show(cell);
    };

    grid.addEventListener('pointerover', showFor);
    grid.addEventListener('focusin', showFor);
    grid.addEventListener('focusout', tooltip.hide);
    scroller.addEventListener('scroll', tooltip.hide, { passive: true });

    // A touch pointer is destroyed on lift, which fires pointerleave straight
    // after the tap. Tapping a day also focuses it, so a focused cell keeps its
    // tooltip up rather than flashing it for the length of the press.
    grid.addEventListener('pointerleave', () => {
      const focused = document.activeElement;
      if (focused && focused.classList.contains('gh-day') && grid.contains(focused)) {
        tooltip.show(focused);
      } else {
        tooltip.hide();
      }
    });

    addKeyboardNavigation(grid, cells);

    // The most recent weeks are the interesting end of the year, and they sit
    // off-screen on a phone until the calendar is scrolled there.
    scroller.scrollLeft = scroller.scrollWidth;
  }

  function renderMessage(root, message, profileUrl) {
    root.textContent = '';

    const status = element('p', 'gh-activity__status', message);
    status.setAttribute('role', 'status');
    root.appendChild(status);

    if (profileUrl) {
      const link = element('a', 'gh-activity__link', 'View my activity on GitHub');
      link.href = profileUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      root.appendChild(link);
    }
  }

  function isUsable(activity) {
    return Boolean(activity)
      && Array.isArray(activity.days)
      && activity.days.length > 0
      && Number.isFinite(activity.totalContributions);
  }

  async function init() {
    const root = document.getElementById('githubActivity');
    if (!root) return;

    const source = root.dataset.source || '/data/github-activity.json';
    const profileUrl = root.dataset.profile;

    try {
      // no-cache revalidates rather than serving a day-old copy from disk; the
      // file is rebuilt daily and is small enough for that to be free.
      const response = await fetch(source, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`request failed with ${response.status}`);

      const activity = await response.json();
      if (!isUsable(activity)) throw new Error('the activity file carried no days');

      if (activity.totalContributions === 0) {
        renderMessage(root, 'No public contributions recorded in the last year.', profileUrl);
        return;
      }

      render(root, activity);
    } catch (error) {
      console.warn('GitHub activity unavailable:', error.message);
      renderMessage(root, 'Commit activity could not be loaded right now.', profileUrl);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
