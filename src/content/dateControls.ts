export type QPDatePreset = 'week' | 'month1' | 'month3' | 'month6' | 'year1' | 'all';

export interface DateControlsState {
  preset: QPDatePreset;
  from: string;
  to: string;
}

interface InitDateControlsOptions {
  root: ParentNode;
  isFree: boolean;
  initialState: DateControlsState;
  onPremiumBlocked: () => void;
  onChange: (state: DateControlsState) => void;
}

export interface QuickPanelDateControlsApi {
  getState: () => DateControlsState;
  setState: (next: Partial<DateControlsState>) => void;
  destroy: () => void;
}

const PRESET_LABELS: Record<QPDatePreset, string> = {
  week: 'Posts from 1 Week Back',
  month1: 'Posts from 1 Month Back',
  month3: 'Posts from 3 Months Back',
  month6: 'Posts from 6 Months Back',
  year1: 'Posts from 1 Year Back',
  all: 'All Posts',
};

function toInputDateValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDisplayDateValue(value: string): string {
  if (!value) return '';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function parseInputDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

function getTodayInputValue(): string {
  return toInputDateValue(new Date());
}

export function initQuickPanelDateControls(options: InitDateControlsOptions): QuickPanelDateControlsApi | null {
  const { root, isFree, onPremiumBlocked, onChange } = options;

  const presetTrigger = root.querySelector('#la-date-preset-trigger') as HTMLButtonElement | null;
  const presetLabel = root.querySelector('#la-date-preset-label') as HTMLElement | null;
  const presetMenu = root.querySelector('#la-date-preset-menu') as HTMLElement | null;
  const presetOptions = Array.from(root.querySelectorAll('.la-date-option')) as HTMLButtonElement[];
  const fromTrigger = root.querySelector('#la-date-from-trigger') as HTMLButtonElement | null;
  const toTrigger = root.querySelector('#la-date-to-trigger') as HTMLButtonElement | null;
  const fromText = root.querySelector('#la-date-from-text') as HTMLElement | null;
  const toText = root.querySelector('#la-date-to-text') as HTMLElement | null;
  const fromInput = root.querySelector('#la-date-from') as HTMLInputElement | null;
  const toInput = root.querySelector('#la-date-to') as HTMLInputElement | null;

  if (!presetTrigger || !presetLabel || !presetMenu || !fromTrigger || !toTrigger || !fromText || !toText || !fromInput || !toInput) {
    return null;
  }

  let state: DateControlsState = {
    preset: options.initialState.preset,
    from: options.initialState.from,
    to: options.initialState.to,
  };
  let isPresetOpen = false;
  let calendarEl: HTMLDivElement | null = null;
  let calendarTarget: 'from' | 'to' | null = null;
  let viewMonthDate = new Date();

  const syncUI = () => {
    presetLabel.textContent = PRESET_LABELS[state.preset];
    fromInput.value = state.from;
    toInput.value = state.to;
    fromText.textContent = state.from ? toDisplayDateValue(state.from) : 'From';
    toText.textContent = state.to ? toDisplayDateValue(state.to) : 'To';

    presetOptions.forEach((option) => {
      const value = option.dataset.value as QPDatePreset;
      option.classList.toggle('active', value === state.preset);
      option.classList.toggle('locked', option.dataset.locked === '1');
    });
  };

  const closePreset = () => {
    isPresetOpen = false;
    presetMenu.classList.remove('open');
    presetTrigger.classList.remove('open');
  };

  const openPreset = () => {
    isPresetOpen = true;
    presetMenu.classList.add('open');
    presetTrigger.classList.add('open');
  };

  const closeCalendar = () => {
    if (!calendarEl) return;
    calendarEl.remove();
    calendarEl = null;
    calendarTarget = null;
  };

  const buildCalendarDays = (year: number, month: number): string => {
    const first = new Date(year, month, 1);
    const startWeekday = first.getDay();
    const start = new Date(year, month, 1 - startWeekday);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayValue = toInputDateValue(today);
    const rows: string[] = [];

    for (let i = 0; i < 42; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const value = toInputDateValue(day);
      const isOutside = day.getMonth() !== month;
      const selectedValue = calendarTarget === 'from' ? state.from : state.to;
      const isSelected = selectedValue === value;
      const isToday = value === todayValue;
      const isFuture = day.getTime() > today.getTime();
      rows.push(
        `<button type="button" class="la-cal-day${isOutside ? ' outside' : ''}${isSelected ? ' selected' : ''}${isToday ? ' today' : ''}${isFuture ? ' future' : ''}" data-date="${value}" ${isFuture ? 'disabled aria-disabled="true"' : ''}>${day.getDate()}</button>`
      );
    }

    return rows.join('');
  };

  const renderCalendar = () => {
    if (!calendarEl) return;
    const monthName = viewMonthDate.toLocaleString('en-US', { month: 'long' });
    const year = viewMonthDate.getFullYear();
    const month = viewMonthDate.getMonth();

    calendarEl.innerHTML = `
      <div class="la-cal-header">
        <button type="button" class="la-cal-nav" data-nav="-1">&#8249;</button>
        <div class="la-cal-title">${monthName} ${year}</div>
        <button type="button" class="la-cal-nav" data-nav="1">&#8250;</button>
      </div>
      <div class="la-cal-weekdays">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="la-cal-grid">
        ${buildCalendarDays(year, month)}
      </div>
      <div class="la-cal-footer">
        <button type="button" class="la-cal-action" data-action="clear">Clear</button>
        <button type="button" class="la-cal-action" data-action="today">Today</button>
      </div>
    `;

    const navButtons = Array.from(calendarEl.querySelectorAll('.la-cal-nav')) as HTMLButtonElement[];
    navButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const delta = Number(btn.dataset.nav || '0');
        viewMonthDate = new Date(viewMonthDate.getFullYear(), viewMonthDate.getMonth() + delta, 1);
        renderCalendar();
      });
    });

    const dayButtons = Array.from(calendarEl.querySelectorAll('.la-cal-day')) as HTMLButtonElement[];
    dayButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (btn.disabled) return;
        const nextValue = btn.dataset.date || '';
        if (calendarTarget === 'from') {
          state.from = nextValue;
          if (!state.to) state.to = getTodayInputValue();
        }
        if (calendarTarget === 'to') state.to = nextValue;
        state.preset = 'all';
        syncUI();
        onChange({ ...state });
        closeCalendar();
      });
    });

    const actionButtons = Array.from(calendarEl.querySelectorAll('.la-cal-action')) as HTMLButtonElement[];
    actionButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'clear') {
          if (calendarTarget === 'from') state.from = '';
          if (calendarTarget === 'to') state.to = '';
          state.preset = 'all';
          syncUI();
          onChange({ ...state });
          closeCalendar();
          return;
        }
        if (action === 'today') {
          const today = getTodayInputValue();
          if (calendarTarget === 'from') {
            state.from = today;
            if (!state.to) state.to = today;
          }
          if (calendarTarget === 'to') state.to = today;
          state.preset = 'all';
          syncUI();
          onChange({ ...state });
          closeCalendar();
        }
      });
    });
  };

  const openCalendarFor = (target: 'from' | 'to') => {
    if (isFree) {
      onPremiumBlocked();
      return;
    }

    closePreset();

    const trigger = target === 'from' ? fromTrigger : toTrigger;
    const selected = target === 'from' ? parseInputDate(state.from) : parseInputDate(state.to);
    calendarTarget = target;
    viewMonthDate = selected || new Date();
    viewMonthDate = new Date(viewMonthDate.getFullYear(), viewMonthDate.getMonth(), 1);

    if (!calendarEl) {
      calendarEl = document.createElement('div');
      calendarEl.className = 'la-calendar-popover';
      document.body.appendChild(calendarEl);
    }

    const rect = trigger.getBoundingClientRect();
    calendarEl.style.top = `${Math.round(window.scrollY + rect.bottom + 2)}px`;
    calendarEl.style.left = `${Math.round(window.scrollX + rect.left)}px`;
    renderCalendar();
  };

  const onPresetTriggerClick = (event: Event) => {
    event.stopPropagation();
    if (isPresetOpen) closePreset();
    else {
      closeCalendar();
      openPreset();
    }
  };

  const onPresetOptionClick = (event: Event) => {
    const target = event.currentTarget as HTMLButtonElement;
    const value = target.dataset.value as QPDatePreset;
    const locked = target.dataset.locked === '1';
    if (locked) {
      onPremiumBlocked();
      closePreset();
      return;
    }
    state.preset = value;
    if (value !== 'all') {
      state.from = '';
      state.to = '';
    }
    syncUI();
    onChange({ ...state });
    closePreset();
  };

  const onFromClick = (event: Event) => {
    event.stopPropagation();
    openCalendarFor('from');
  };

  const onToClick = (event: Event) => {
    event.stopPropagation();
    openCalendarFor('to');
  };

  const onDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node;
    if (isPresetOpen && !presetMenu.contains(target) && !presetTrigger.contains(target)) {
      closePreset();
    }
    if (calendarEl && !calendarEl.contains(target) && !fromTrigger.contains(target) && !toTrigger.contains(target)) {
      closeCalendar();
    }
  };

  presetTrigger.addEventListener('click', onPresetTriggerClick);
  presetOptions.forEach((option) => option.addEventListener('click', onPresetOptionClick));
  fromTrigger.addEventListener('click', onFromClick);
  toTrigger.addEventListener('click', onToClick);
  document.addEventListener('click', onDocumentClick);

  syncUI();

  return {
    getState: () => ({ ...state }),
    setState: (next) => {
      state = {
        preset: next.preset ?? state.preset,
        from: next.from ?? state.from,
        to: next.to ?? state.to,
      };
      syncUI();
    },
    destroy: () => {
      presetTrigger.removeEventListener('click', onPresetTriggerClick);
      presetOptions.forEach((option) => option.removeEventListener('click', onPresetOptionClick));
      fromTrigger.removeEventListener('click', onFromClick);
      toTrigger.removeEventListener('click', onToClick);
      document.removeEventListener('click', onDocumentClick);
      closePreset();
      closeCalendar();
    },
  };
}
