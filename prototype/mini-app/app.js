(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const screens = [...document.querySelectorAll('[data-screen]')];
  const telegramWebApp = window.Telegram?.WebApp;
  const tg = telegramWebApp?.initData ? telegramWebApp : null;

  const elements = {
    boot: $('bootPanel'), bootTitle: $('bootTitle'), bootText: $('bootText'), demo: $('demoButton'),
    bottomNav: document.querySelector('.bottom-nav'), back: $('backButton'), theme: $('themeButton'),
    next: $('wizardNext'), previous: $('wizardBack'), form: $('bookingForm'), toast: $('toast'),
    modal: $('modalBackdrop'), modalClose: $('modalClose'), modalTitle: $('modalTitle'), modalText: $('modalText'), modalIcon: $('modalIcon'),
    dayGrid: $('dayGrid'), morning: $('morningSlots'), afternoon: $('afternoonSlots'),
    morningFieldset: $('morningFieldset'), afternoonFieldset: $('afternoonFieldset'),
    availabilityNote: $('availabilityNote'), availabilityState: $('availabilityState'), weekLabel: $('weekLabel'),
    previousWeek: $('previousWeek'), nextWeek: $('nextWeek'),
    bookingList: $('bookingList'), bookingsState: $('bookingsState'), bookingsCount: $('bookingsCount'),
    activeCount: $('activeCount'), archiveCount: $('archiveCount'),
    detailCard: $('bookingDetailCard'), detailActions: $('bookingDetailActions'),
    notificationChannel: $('notificationChannel'), notificationEmail: $('notificationEmail'),
    notificationEmailBlock: $('notificationEmailBlock'), saveNotifications: $('saveNotifications'),
    modalConfirmActions: $('modalConfirmActions'), modalCancel: $('modalCancel'), modalConfirm: $('modalConfirm'),
    modalReasonBlock: $('modalReasonBlock'), modalReason: $('modalReason'),
    adminQueue: $('adminQueue'), adminQueueState: $('adminQueueState'), adminQueueCount: $('adminQueueCount'),
    adminPendingCount: $('adminPendingCount'), adminDecidedToday: $('adminDecidedToday'), adminNavCount: $('adminNavCount'),
    adminDetailCard: $('adminDetailCard'), adminDetailActions: $('adminDetailActions'),
    adminSettingsState: $('adminSettingsState'), adminSettingsContent: $('adminSettingsContent'),
    googleIntegrationCard: $('googleIntegrationCard'), scheduleSettingsForm: $('scheduleSettingsForm'),
    scheduleTimezone: $('scheduleTimezone'), workingPeriods: $('workingPeriods'),
    minimumLeadTimeMinutes: $('minimumLeadTimeMinutes'), bookingHorizonDays: $('bookingHorizonDays'),
    maxMeetingsPerDay: $('maxMeetingsPerDay'), bufferBeforeMinutes: $('bufferBeforeMinutes'),
    bufferAfterMinutes: $('bufferAfterMinutes'), saveScheduleSettings: $('saveScheduleSettings'),
    restrictionCount: $('restrictionCount'), blockedUserCount: $('blockedUserCount'), templateCount: $('templateCount'),
  };

  const state = {
    mode: 'live', screen: 'home', history: [], step: 1, user: null,
    format: 'Онлайн', duration: '30', weeks: [], weekIndex: 0,
    dates: [], date: null, slot: null, timezone: 'Europe/Moscow',
    idempotencyKey: newIdempotencyKey(), submitting: false,
    bookingScope: 'active', bookingCounts: { active: 0, archive: 0 },
    bookingsByScope: { active: [], archive: [] },
    selectedBooking: null, rescheduleOriginal: null, pendingCancelId: null,
    notificationChannel: 'TELEGRAM', demoBookings: [],
    adminScope: 'pending', adminBookings: [], adminSummary: { pending: 0, decidedToday: 0 },
    selectedAdminBooking: null, pendingAdminAction: null, adminSettings: null,
  };

  const stepCopy = {
    1: ['Детали встречи', 'Расскажите, о чём будет встреча'],
    2: ['Дата и время', 'Показываем только свободные окна'],
    3: ['Контакты', 'Telegram — основной канал уведомлений'],
    4: ['Проверьте заявку', 'Убедитесь, что всё указано верно'],
  };

  function setTheme(theme, persist = true) {
    root.dataset.theme = theme;
    const dark = theme === 'dark';
    elements.theme.setAttribute('aria-pressed', String(dark));
    elements.theme.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1f1e30' : '#6759e8');
    if (persist && !tg) localStorage.setItem('meeting-mini-app-theme', theme);
  }

  function initializeTelegram() {
    const requested = new URLSearchParams(location.search).get('theme');
    const preferred = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    setTheme(tg?.colorScheme || requested || localStorage.getItem('meeting-mini-app-theme') || preferred, false);
    if (!tg) return;
    body.classList.add('telegram-mode');
    const syncTelegram = () => {
      setTheme(tg.colorScheme || 'light', false);
      root.style.setProperty('--app-viewport-height', `${tg.viewportStableHeight || tg.viewportHeight || innerHeight}px`);
      const safe = tg.safeAreaInset || {};
      const contentSafe = tg.contentSafeAreaInset || {};
      root.style.setProperty('--safe-top', `${Math.max(safe.top || 0, contentSafe.top || 0)}px`);
      root.style.setProperty('--safe-bottom', `${Math.max(safe.bottom || 0, contentSafe.bottom || 0)}px`);
    };
    tg.onEvent('themeChanged', syncTelegram);
    tg.onEvent('viewportChanged', syncTelegram);
    tg.onEvent('safeAreaChanged', syncTelegram);
    tg.onEvent('contentSafeAreaChanged', syncTelegram);
    tg.BackButton.onClick(goBack);
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('secondary_bg_color');
      tg.setBackgroundColor('bg_color');
      tg.setBottomBarColor?.('bottom_bar_bg_color');
    } catch { /* Older Telegram clients ignore unsupported color methods. */ }
    syncTelegram();
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/mini-app/v1${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.message || 'Не удалось выполнить запрос');
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function bootstrap() {
    initializeTelegram();
    elements.demo.addEventListener('click', () => location.assign('/mini-app?demo=1'));
    if (new URLSearchParams(location.search).get('demo') === '1') {
      enterDemo();
      return;
    }
    try {
      let session;
      try {
        session = await api('/me');
      } catch (error) {
        if (error.status !== 401 || !tg?.initData) throw error;
        session = await api('/session', { method: 'POST', body: JSON.stringify({ initData: tg.initData }) });
      }
      state.user = session.user;
      $('meetingEmail').value = session.user.lastConfirmedEmail || '';
      initializeNotificationPreferences();
      body.classList.add('live-mode');
      body.classList.toggle('admin-mode', session.user.role === 'ADMIN');
      elements.boot.classList.add('is-ready');
      if (session.user.role === 'ADMIN') void loadAdminQueue();
    } catch (error) {
      elements.boot.classList.add('is-error');
      elements.bootTitle.textContent = 'Откройте приложение в Telegram';
      elements.bootText.textContent = error.status === 403
        ? 'Адрес приложения не совпадает с настройками сервера.'
        : 'Для безопасной записи нужна подтверждённая Telegram-сессия.';
      elements.demo.classList.remove('is-hidden');
    }
  }

  function enterDemo() {
    state.mode = 'demo';
    state.user = {
      role: 'ADMIN',
      lastConfirmedEmail: 'ivan@example.com',
      notificationChannel: 'TELEGRAM',
    };
    state.demoBookings = createDemoBookings();
    elements.boot.classList.add('is-ready');
    body.classList.remove('live-mode');
    body.classList.add('admin-mode');
    $('meetingTitle').value = 'Обсуждение проекта';
    $('meetingComment').value = 'Покажу текущий прототип и план запуска.';
    $('meetingEmail').value = 'ivan@example.com';
    initializeNotificationPreferences();
    void loadAdminQueue();
  }

  function showScreen(name, options = {}) {
    if (!options.fromHistory && name !== state.screen) state.history.push(state.screen);
    state.screen = name;
    screens.forEach((screen) => {
      const active = screen.dataset.screen === name;
      screen.classList.toggle('is-active', active);
      screen.setAttribute('aria-hidden', String(!active));
    });
    const flow = name === 'wizard' || name === 'success' || name === 'booking-detail' || name === 'admin-detail' || name === 'admin-settings';
    elements.bottomNav.classList.toggle('is-hidden', flow);
    elements.back.classList.toggle('is-hidden', !flow);
    if (tg) flow ? tg.BackButton.show() : tg.BackButton.hide();
    tg?.enableClosingConfirmation?.(name === 'wizard');
    document.querySelectorAll('.bottom-nav [data-nav]').forEach((button) => {
      const active = button.dataset.nav === name ||
        (name === 'booking-detail' && button.dataset.nav === 'bookings') ||
        (name === 'admin-detail' && button.dataset.nav === 'admin');
      button.classList.toggle('is-active', active);
      active ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
    });
    if (name === 'bookings') void loadBookings();
    if (name === 'admin') void loadAdminQueue();
    if (name === 'admin-settings') void loadAdminSettings();
    scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goBack() {
    if (state.screen === 'wizard' && state.rescheduleOriginal && state.step === 2) {
      return void showScreen('booking-detail', { fromHistory: true });
    }
    if (state.screen === 'wizard' && state.step > 1) {
      const target = state.rescheduleOriginal && state.step === 4 ? 2 : state.step - 1;
      return void setWizardStep(target);
    }
    showScreen(state.history.pop() || 'home', { fromHistory: true });
  }

  async function setWizardStep(step) {
    state.step = Math.max(1, Math.min(4, step));
    document.querySelectorAll('.wizard-step').forEach((panel) => panel.classList.toggle('is-active', Number(panel.dataset.step) === state.step));
    document.querySelectorAll('.stepper li').forEach((item, index) => {
      const itemStep = index + 1;
      item.classList.toggle('is-current', itemStep === state.step);
      item.classList.toggle('is-done', itemStep < state.step);
      item.querySelector('span').textContent = itemStep < state.step ? '✓' : String(itemStep);
    });
    [$('wizardTitle').textContent, $('wizardSubtitle').textContent] = stepCopy[state.step];
    const stepper = document.querySelector('.stepper');
    stepper.classList.toggle('is-reschedule', Boolean(state.rescheduleOriginal));
    $('wizardEyebrow').textContent = state.rescheduleOriginal ? 'Перенос встречи' : 'Новая запись';
    if (state.rescheduleOriginal) {
      const items = stepper.querySelectorAll('li');
      items[1].querySelector('span').textContent = state.step === 4 ? '✓' : '1';
      items[1].querySelector('small').textContent = 'Новое время';
      items[3].querySelector('span').textContent = '2';
      items[3].querySelector('small').textContent = 'Проверка';
      if (state.step === 2) {
        $('wizardSubtitle').textContent = 'Старая встреча останется действующей до подтверждения';
      }
    } else {
      stepper.querySelectorAll('li')[1].querySelector('small').textContent = 'Время';
    }
    elements.previous.classList.toggle('is-hidden', state.step === 1);
    elements.next.textContent = state.step === 4
      ? (state.rescheduleOriginal ? 'Отправить перенос' : 'Отправить заявку')
      : 'Продолжить';
    if (state.step === 2) await loadAvailability();
    if (state.step === 4) updateReview();
    scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function loadAvailability() {
    setAvailabilityState('Загружаем свободные даты…');
    state.slot = null;
    try {
      if (state.mode === 'demo') {
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
        state.weeks = [0, 1, 2, 3].map((offset) => ({ offset, startDate: isoDate(addDays(start, offset * 7)), endDate: isoDate(addDays(start, offset * 7 + 6)) }));
      } else {
        state.weeks = (await api(`/availability/weeks?duration=${state.duration}`)).weeks;
      }
      state.weekIndex = Math.min(state.weekIndex, Math.max(0, state.weeks.length - 1));
      await loadWeek();
    } catch (error) {
      setAvailabilityState(error.message || 'Не удалось загрузить расписание', true);
    }
  }

  async function loadWeek() {
    const week = state.weeks[state.weekIndex];
    elements.previousWeek.disabled = state.weekIndex === 0;
    elements.nextWeek.disabled = state.weekIndex >= state.weeks.length - 1;
    if (!week) {
      elements.weekLabel.textContent = 'Нет доступных недель';
      renderDates([]);
      return setAvailabilityState('Свободных дат пока нет', true);
    }
    elements.weekLabel.textContent = `${formatShortDate(week.startDate)}–${formatShortDate(week.endDate)}`;
    setAvailabilityState('Загружаем даты…');
    if (state.mode === 'demo') {
      state.dates = [0, 1, 2, 3, 4].map((day) => isoDate(addDays(new Date(`${week.startDate}T12:00:00`), day)));
    } else {
      state.dates = (await api(`/availability/dates?duration=${state.duration}&weekOffset=${week.offset}`)).dates;
    }
    state.date = state.dates.includes(state.date) ? state.date : state.dates[0] || null;
    renderDates(state.dates);
    if (state.date) await loadSlots();
    else setAvailabilityState('На этой неделе свободных дат нет', true);
  }

  function renderDates(dates) {
    elements.dayGrid.replaceChildren(...dates.map((date) => {
      const button = document.createElement('button');
      const value = new Date(`${date}T12:00:00`);
      button.type = 'button';
      button.dataset.date = date;
      button.dataset.value = formatLongDate(date);
      button.setAttribute('aria-pressed', String(date === state.date));
      button.classList.toggle('is-selected', date === state.date);
      button.innerHTML = `<small>${new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(value).replace('.', '').toUpperCase()}</small><strong>${value.getDate()}</strong><i></i>`;
      return button;
    }));
  }

  async function loadSlots() {
    setAvailabilityState('Проверяем свободные окна…');
    elements.morning.replaceChildren();
    elements.afternoon.replaceChildren();
    try {
      let slots;
      if (state.mode === 'demo') {
        slots = ['09:00', '09:30', '10:30', '11:00', '14:00', '15:30', '17:00'].map((time) => ({
          date: state.date, time, startAt: new Date(`${state.date}T${time}:00+03:00`).toISOString(), timezone: 'Europe/Moscow',
        }));
      } else {
        slots = (await api(`/availability/slots?duration=${state.duration}&date=${state.date}`)).slots;
      }
      state.slot = slots.find((slot) => slot.startAt === state.slot?.startAt) || slots[0] || null;
      if (state.slot) state.timezone = state.slot.timezone;
      renderSlots(slots);
      elements.availabilityNote.innerHTML = `<span></span>Доступно ${slots.length} ${plural(slots.length, 'окно', 'окна', 'окон')} · ${timezoneLabel(state.timezone)}`;
      setAvailabilityState('', false);
      if (!slots.length) setAvailabilityState('На эту дату свободных окон нет', true);
    } catch (error) {
      setAvailabilityState(error.message || 'Не удалось загрузить время', true);
    }
  }

  function renderSlots(slots) {
    const build = (slot) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.startAt = slot.startAt;
      button.dataset.value = slot.time;
      button.textContent = slot.time;
      const selected = state.slot?.startAt === slot.startAt;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      return button;
    };
    const morning = slots.filter((slot) => Number(slot.time.slice(0, 2)) < 13);
    const afternoon = slots.filter((slot) => Number(slot.time.slice(0, 2)) >= 13);
    elements.morning.replaceChildren(...morning.map(build));
    elements.afternoon.replaceChildren(...afternoon.map(build));
    elements.morningFieldset.classList.toggle('is-hidden', morning.length === 0);
    elements.afternoonFieldset.classList.toggle('is-hidden', afternoon.length === 0);
  }

  function setAvailabilityState(message, visible = true) {
    elements.availabilityState.textContent = message;
    elements.availabilityState.classList.toggle('is-hidden', !visible || !message);
  }

  function selectChoice(button) {
    const group = button.closest('[data-choice-group]');
    if (!group) return;
    if (button.dataset.startAt) {
      state.slot = { startAt: button.dataset.startAt, time: button.dataset.value, timezone: state.timezone };
      [elements.morning, elements.afternoon].forEach((container) => container.querySelectorAll('button').forEach((choice) => setSelected(choice, choice === button)));
    } else if (button.dataset.date) {
      state.date = button.dataset.date;
      elements.dayGrid.querySelectorAll('button').forEach((choice) => setSelected(choice, choice === button));
      void loadSlots();
    } else {
      group.querySelectorAll('button').forEach((choice) => setSelected(choice, choice === button));
      if (group.dataset.choiceGroup === 'format') state.format = button.dataset.value;
      if (group.dataset.choiceGroup === 'duration') {
        state.duration = button.dataset.value;
        state.weekIndex = 0; state.date = null; state.slot = null;
      }
      if (group.dataset.choiceGroup === 'notification') {
        state.notificationChannel = button.dataset.value;
        elements.notificationEmailBlock.classList.toggle(
          'is-hidden',
          state.notificationChannel !== 'EMAIL',
        );
      }
    }
    tg?.HapticFeedback?.selectionChanged();
  }

  function setSelected(button, selected) {
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }

  function validateCurrentStep() {
    if (state.step === 1 && !$('meetingTitle').value.trim()) return invalid($('meetingTitle'), 'Укажите тему встречи');
    if (state.step === 2 && !state.slot) return invalid(null, 'Выберите свободное время');
    const email = $('meetingEmail');
    if (state.step === 3 && $('calendarInvite').checked && email.value && !email.checkValidity()) return invalid(email, 'Проверьте email');
    return true;
  }

  function invalid(element, message) {
    element?.focus(); showToast(message); tg?.HapticFeedback?.notificationOccurred('error'); return false;
  }

  function updateReview() {
    const email = $('meetingEmail').value.trim();
    $('reviewTitle').textContent = $('meetingTitle').value.trim();
    $('reviewFormat').textContent = state.format;
    $('reviewFormat').className = `format-chip ${state.format === 'Онлайн' ? 'online' : 'personal'}`;
    $('reviewDate').textContent = formatLongDate(state.date);
    $('reviewTime').textContent = state.slot?.time || '—';
    $('reviewDuration').textContent = `${state.duration} мин`;
    $('reviewEmail').textContent = $('calendarInvite').checked && email ? email : 'Только Telegram';
    $('reviewComment').textContent = $('meetingComment').value.trim() || 'Комментарий не добавлен';
  }

  async function submitBooking() {
    if (state.submitting) return;
    if (state.mode === 'demo') {
      if (state.rescheduleOriginal) {
        const demo = createDemoReschedule();
        return showSuccess(demo, true);
      }
      return showSuccess({ publicCode: 'M-DEMO2026', startAt: state.slot.startAt, durationMinutes: Number(state.duration), meetingFormat: state.format === 'Онлайн' ? 'ONLINE' : 'IN_PERSON' }, false);
    }
    state.submitting = true;
    elements.next.disabled = true;
    elements.next.setAttribute('aria-busy', 'true');
    elements.next.textContent = 'Отправляем…';
    try {
      const email = $('meetingEmail').value.trim();
      const result = state.rescheduleOriginal
        ? await api(`/bookings/${state.rescheduleOriginal.id}/reschedule`, {
          method: 'POST',
          body: JSON.stringify({
            startAt: state.slot.startAt,
            email: $('calendarInvite').checked && email ? email : null,
            idempotencyKey: state.idempotencyKey,
          }),
        })
        : await api('/bookings', {
          method: 'POST',
          body: JSON.stringify({
            title: $('meetingTitle').value.trim(), comment: $('meetingComment').value.trim(),
            meetingFormat: state.format === 'Онлайн' ? 'ONLINE' : 'IN_PERSON',
            durationMinutes: Number(state.duration), startAt: state.slot.startAt,
            email: $('calendarInvite').checked && email ? email : null,
            idempotencyKey: state.idempotencyKey,
          }),
        });
      showSuccess(result.booking, Boolean(state.rescheduleOriginal));
    } catch (error) {
      if (error.status === 409) {
        showToast('Это время уже занято. Выберите другое окно.');
        state.slot = null;
        await setWizardStep(2);
      } else showToast(error.message || 'Не удалось отправить заявку. Попробуйте ещё раз.');
      tg?.HapticFeedback?.notificationOccurred('error');
    } finally {
      state.submitting = false;
      elements.next.disabled = false;
      elements.next.removeAttribute('aria-busy');
      elements.next.textContent = state.step === 4
        ? (state.rescheduleOriginal ? 'Отправить перенос' : 'Отправить заявку')
        : 'Продолжить';
    }
  }

  function showSuccess(booking, rescheduled = false) {
    $('successCode').textContent = booking.publicCode;
    $('successTitle').textContent = rescheduled ? 'Перенос отправлен' : 'Отправлено на согласование';
    $('successText').textContent = rescheduled
      ? 'Старая встреча остаётся действующей, пока администратор не подтвердит новое время.'
      : 'Сообщим о решении в Telegram. Время временно закреплено за вами.';
    $('successDate').textContent = `${formatLongDate(state.date || booking.startAt.slice(0, 10))} · ${state.slot.time}`;
    $('successMeta').textContent = `${booking.durationMinutes} минут · ${booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная'}`;
    tg?.disableClosingConfirmation?.();
    tg?.HapticFeedback?.notificationOccurred('success');
    showScreen('success');
  }

  function initializeNotificationPreferences() {
    state.notificationChannel = state.user?.notificationChannel || 'TELEGRAM';
    elements.notificationEmail.value = state.user?.lastConfirmedEmail || '';
    elements.notificationChannel.querySelectorAll('button').forEach((button) => {
      setSelected(button, button.dataset.value === state.notificationChannel);
    });
    elements.notificationEmailBlock.classList.toggle(
      'is-hidden',
      state.notificationChannel !== 'EMAIL',
    );
  }

  async function loadBookings() {
    elements.bookingsState.textContent = 'Загружаем записи…';
    elements.bookingsState.classList.remove('is-hidden');
    elements.bookingList.replaceChildren();
    try {
      if (state.mode === 'demo') {
        state.bookingsByScope.active = state.demoBookings.filter(isDemoActive);
        state.bookingsByScope.archive = state.demoBookings.filter((booking) => !isDemoActive(booking));
      } else {
        const [active, archive] = await Promise.all([
          api('/bookings?scope=active'),
          api('/bookings?scope=archive'),
        ]);
        state.bookingsByScope.active = active.bookings;
        state.bookingsByScope.archive = archive.bookings;
      }
      state.bookingCounts.active = state.bookingsByScope.active.length;
      state.bookingCounts.archive = state.bookingsByScope.archive.length;
      elements.activeCount.textContent = state.bookingCounts.active;
      elements.archiveCount.textContent = state.bookingCounts.archive;
      elements.bookingsCount.textContent = state.bookingCounts[state.bookingScope];
      renderBookings();
    } catch (error) {
      elements.bookingsState.textContent = error.message || 'Не удалось загрузить записи';
    }
  }

  function renderBookings() {
    const bookings = state.bookingsByScope[state.bookingScope];
    elements.bookingsCount.textContent = bookings.length;
    elements.bookingList.innerHTML = bookings.map(renderBookingCard).join('');
    elements.bookingsState.textContent = bookings.length
      ? ''
      : state.bookingScope === 'active'
        ? 'Активных записей пока нет'
        : 'Архив пока пуст';
    elements.bookingsState.classList.toggle('is-hidden', bookings.length > 0);
  }

  function renderBookingCard(booking) {
    const status = bookingStatus(booking);
    const format = booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная';
    const typeLabel = booking.type === 'RESCHEDULE' ? '<span class="request-code">Запрос на перенос</span>' : '';
    return `<article class="booking-card${state.bookingScope === 'archive' ? ' is-muted' : ''}">
      <div class="booking-status ${status.className}"><span>${status.icon}</span>${status.label}</div>
      <div class="booking-card-head"><div>${typeLabel}<p>${escapeHtml(formatBookingMoment(booking))}</p><h3>${escapeHtml(booking.title)}</h3></div><span class="format-chip ${booking.meetingFormat === 'ONLINE' ? 'online' : 'personal'}">${format}</span></div>
      <div class="booking-detail-row"><span>${booking.durationMinutes} минут</span><i></i><span>${escapeHtml(booking.publicCode)}</span></div>
      <button class="outline-button full-width" type="button" data-booking-id="${escapeHtml(booking.id)}">Подробнее</button>
    </article>`;
  }

  async function openBooking(id) {
    try {
      const cached = [...state.bookingsByScope.active, ...state.bookingsByScope.archive]
        .find((booking) => booking.id === id);
      const booking = state.mode === 'demo' ? cached : (await api(`/bookings/${id}`)).booking;
      if (!booking) throw new Error('Заявка не найдена');
      state.selectedBooking = booking;
      renderBookingDetail(booking);
      showScreen('booking-detail');
    } catch (error) {
      showToast(error.message || 'Не удалось открыть заявку');
    }
  }

  function renderBookingDetail(booking) {
    const status = bookingStatus(booking);
    const format = booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная';
    $('bookingDetailCode').textContent = `${booking.type === 'RESCHEDULE' ? 'Перенос' : 'Заявка'} ${booking.publicCode}`;
    $('bookingDetailTitle').textContent = booking.title;
    $('bookingDetailFormat').textContent = format;
    $('bookingDetailFormat').className = `format-chip ${booking.meetingFormat === 'ONLINE' ? 'online' : 'personal'}`;
    const meetLink = booking.googleMeetUrl && /^https:\/\//u.test(booking.googleMeetUrl)
      ? `<a class="meet-link" href="${escapeHtml(booking.googleMeetUrl)}" target="_blank" rel="noopener noreferrer">Открыть Google Meet</a>`
      : '';
    const comment = booking.comment
      ? `<div class="detail-comment"><span>Комментарий</span><p>${escapeHtml(booking.comment)}</p></div>`
      : '';
    elements.detailCard.innerHTML = `
      <div class="detail-status-row"><div class="booking-status ${status.className}"><span>${status.icon}</span>${status.label}</div><span>${booking.durationMinutes} мин</span></div>
      <div class="detail-time-block"><strong>${escapeHtml(formatBookingMoment(booking))}</strong><span>${escapeHtml(timezoneLabel(booking.timezone))} · ${format}</span></div>
      <dl class="detail-list">
        <div><dt>Номер</dt><dd>${escapeHtml(booking.publicCode)}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(booking.email || 'Только Telegram')}</dd></div>
        ${booking.rejectionReason ? `<div><dt>Причина</dt><dd>${escapeHtml(booking.rejectionReason)}</dd></div>` : ''}
      </dl>${comment}${meetLink}`;
    const actions = [];
    if (booking.canReschedule) actions.push(`<button class="secondary-button" type="button" data-reschedule-id="${escapeHtml(booking.id)}">Перенести</button>`);
    if (booking.canCancel) actions.push(`<button class="danger-button" type="button" data-cancel-id="${escapeHtml(booking.id)}">Отменить</button>`);
    elements.detailActions.className = `detail-actions${actions.length === 2 ? ' two' : ''}`;
    elements.detailActions.innerHTML = actions.join('');
  }

  function startReschedule(booking) {
    state.rescheduleOriginal = booking;
    state.idempotencyKey = newIdempotencyKey();
    state.duration = String(booking.durationMinutes);
    state.format = booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная';
    state.weekIndex = 0; state.date = null; state.slot = null;
    $('meetingTitle').value = booking.title;
    $('meetingComment').value = booking.comment || '';
    $('meetingEmail').value = booking.email || state.user?.lastConfirmedEmail || '';
    $('calendarInvite').checked = Boolean($('meetingEmail').value);
    syncWizardChoices();
    state.history = ['booking-detail'];
    void setWizardStep(2);
    showScreen('wizard', { fromHistory: true });
  }

  function syncWizardChoices() {
    document.querySelectorAll('[data-choice-group="format"] button').forEach((button) => setSelected(button, button.dataset.value === state.format));
    document.querySelectorAll('[data-choice-group="duration"] button').forEach((button) => setSelected(button, button.dataset.value === state.duration));
  }

  function askToCancel(booking) {
    state.pendingCancelId = booking.id;
    elements.modalTitle.textContent = 'Отменить встречу?';
    elements.modalText.textContent = `Заявка «${booking.title}» будет отменена, а занятое время освободится.`;
    elements.modalIcon.textContent = '!';
    elements.modalClose.classList.add('is-hidden');
    elements.modalConfirmActions.classList.remove('is-hidden');
    elements.modal.classList.remove('is-hidden');
    elements.modalCancel.focus();
  }

  async function cancelSelectedBooking() {
    const id = state.pendingCancelId;
    if (!id) return;
    elements.modalConfirm.disabled = true;
    elements.modalConfirm.textContent = 'Отменяем…';
    try {
      if (state.mode === 'demo') {
        const booking = state.demoBookings.find((item) => item.id === id);
        if (booking) {
          booking.status = 'CANCELLED_BY_USER';
          booking.canCancel = false;
          booking.canReschedule = false;
        }
      } else {
        await api(`/bookings/${id}/cancel`, { method: 'POST' });
      }
      closeModal();
      showScreen('bookings', { fromHistory: true });
      await loadBookings();
      showToast('Встреча отменена, время снова свободно');
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      showToast(error.message || 'Не удалось отменить встречу');
    } finally {
      elements.modalConfirm.disabled = false;
      elements.modalConfirm.textContent = 'Да, отменить';
    }
  }

  async function loadAdminSettings() {
    if (state.user?.role !== 'ADMIN') return;
    elements.adminSettingsState.textContent = 'Загружаем настройки…';
    elements.adminSettingsState.classList.remove('is-hidden');
    elements.adminSettingsContent.classList.add('is-hidden');
    try {
      state.adminSettings = state.mode === 'demo'
        ? demoAdminSettings()
        : await api('/admin/settings');
      renderAdminSettings();
    } catch (error) {
      elements.adminSettingsState.textContent = error.message || 'Не удалось загрузить настройки';
    }
  }

  function renderAdminSettings() {
    const settings = state.adminSettings;
    if (!settings) return;
    const google = settings.google;
    const connected = google.configured && google.authorized;
    elements.googleIntegrationCard.className = `integration-status-card ${connected ? 'is-connected' : 'needs-attention'}`;
    elements.googleIntegrationCard.innerHTML = `
      <div class="integration-status-head"><span class="integration-logo"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M8 3v4M16 3v4M3 10h18"></path><path d="m9 15 2 2 4-4"></path></svg></span><div><p class="eyebrow">Google Calendar</p><h2>${connected ? 'Календарь подключён' : 'Нужно подключение'}</h2></div><span class="integration-dot" aria-hidden="true"></span></div>
      <p>${connected ? 'Свободные окна, заявки и подтверждённые встречи синхронизируются автоматически.' : 'Проверьте OAuth-настройки в Telegram-разделе администратора.'}</p>
      <div class="integration-account"><span>Аккаунт</span><strong>${escapeHtml(google.accountEmail || 'Не определён')}</strong></div>`;
    const schedule = settings.schedule;
    elements.scheduleTimezone.value = schedule.timezone;
    elements.workingPeriods.innerHTML = renderWorkingPeriods(schedule.workingPeriods);
    setSelectValue(elements.minimumLeadTimeMinutes, schedule.minimumLeadTimeMinutes, `${schedule.minimumLeadTimeMinutes} мин`);
    setSelectValue(elements.bookingHorizonDays, schedule.bookingHorizonDays, `${schedule.bookingHorizonDays} дней`);
    setSelectValue(elements.maxMeetingsPerDay, schedule.maxMeetingsPerDay, `До ${schedule.maxMeetingsPerDay}`);
    setSelectValue(elements.bufferBeforeMinutes, schedule.bufferBeforeMinutes, `${schedule.bufferBeforeMinutes} минут`);
    setSelectValue(elements.bufferAfterMinutes, schedule.bufferAfterMinutes, `${schedule.bufferAfterMinutes} минут`);
    elements.restrictionCount.textContent = settings.overview.activeRestrictions;
    elements.blockedUserCount.textContent = settings.overview.blockedUsers;
    elements.templateCount.textContent = settings.overview.templates;
    elements.adminSettingsState.classList.add('is-hidden');
    elements.adminSettingsContent.classList.remove('is-hidden');
  }

  function renderWorkingPeriods(periods) {
    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const grouped = new Map();
    periods.forEach((period) => {
      if (!grouped.has(period.weekday)) grouped.set(period.weekday, []);
      grouped.get(period.weekday).push(`${minuteTime(period.startMinute)}–${minuteTime(period.endMinute)}`);
    });
    return [...grouped.entries()].map(([weekday, ranges]) => `<span><strong>${dayNames[weekday] || weekday}</strong><small>${escapeHtml(ranges.join(', '))}</small></span>`).join('');
  }

  function minuteTime(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function setSelectValue(select, value, label) {
    if (![...select.options].some((option) => Number(option.value) === Number(value))) {
      select.add(new Option(label, String(value)));
    }
    select.value = String(value);
  }

  function demoAdminSettings() {
    return {
      google: { configured: true, authorized: true, accountEmail: 'calendar@example.com', tokenExpiresAt: null },
      schedule: {
        timezone: 'Europe/Moscow', minimumLeadTimeMinutes: 1440,
        bufferBeforeMinutes: 0, bufferAfterMinutes: 0, maxMeetingsPerDay: 4, bookingHorizonDays: 30,
        workingPeriods: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1080 })),
      },
      overview: { activeRestrictions: 1, blockedUsers: 0, templates: 8 },
    };
  }

  async function saveAdminSchedule(event) {
    event.preventDefault();
    const payload = {
      timezone: elements.scheduleTimezone.value,
      minimumLeadTimeMinutes: Number(elements.minimumLeadTimeMinutes.value),
      bookingHorizonDays: Number(elements.bookingHorizonDays.value),
      maxMeetingsPerDay: Number(elements.maxMeetingsPerDay.value),
      bufferBeforeMinutes: Number(elements.bufferBeforeMinutes.value),
      bufferAfterMinutes: Number(elements.bufferAfterMinutes.value),
    };
    elements.saveScheduleSettings.disabled = true;
    elements.saveScheduleSettings.textContent = 'Сохраняем…';
    try {
      if (state.mode === 'demo') Object.assign(state.adminSettings.schedule, payload);
      else state.adminSettings = await api('/admin/settings/schedule', { method: 'PATCH', body: JSON.stringify(payload) });
      renderAdminSettings();
      showToast('Правила записи сохранены');
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      showToast(error.message || 'Не удалось сохранить правила');
    } finally {
      elements.saveScheduleSettings.disabled = false;
      elements.saveScheduleSettings.textContent = 'Сохранить правила';
    }
  }

  async function loadAdminQueue() {
    if (state.user?.role !== 'ADMIN') return;
    elements.adminQueueState.textContent = 'Загружаем очередь…';
    elements.adminQueueState.classList.remove('is-hidden');
    elements.adminQueue.replaceChildren();
    try {
      if (state.mode === 'demo') {
        const all = state.demoBookings.map(toDemoAdminBooking);
        state.adminBookings = all.filter((booking) => state.adminScope === 'pending'
          ? ['PENDING_APPROVAL', 'CONFIRMATION_ERROR'].includes(booking.status)
          : !['PENDING_APPROVAL', 'CONFIRMATION_ERROR'].includes(booking.status));
        state.adminSummary = {
          pending: all.filter((booking) => ['PENDING_APPROVAL', 'CONFIRMATION_ERROR'].includes(booking.status)).length,
          decidedToday: all.filter((booking) => !['PENDING_APPROVAL', 'CONFIRMATION_ERROR'].includes(booking.status)).length,
        };
      } else {
        const payload = await api(`/admin/bookings?scope=${state.adminScope}`);
        state.adminBookings = payload.bookings;
        state.adminSummary = payload.summary;
      }
      renderAdminQueue();
    } catch (error) {
      elements.adminQueueState.textContent = error.message || 'Не удалось загрузить очередь';
    }
  }

  function renderAdminQueue() {
    const { pending, decidedToday } = state.adminSummary;
    elements.adminQueueCount.textContent = pending;
    elements.adminPendingCount.textContent = `${pending} ${plural(pending, 'заявка', 'заявки', 'заявок')}`;
    elements.adminDecidedToday.textContent = decidedToday;
    elements.adminNavCount.textContent = pending;
    elements.adminNavCount.classList.toggle('is-hidden', pending === 0);
    elements.adminQueue.innerHTML = state.adminBookings.map(renderAdminCard).join('');
    elements.adminQueueState.textContent = state.adminBookings.length
      ? ''
      : state.adminScope === 'pending'
        ? 'Очередь пуста — все заявки обработаны'
        : 'Недавних решений пока нет';
    elements.adminQueueState.classList.toggle('is-hidden', state.adminBookings.length > 0);
  }

  function renderAdminCard(booking) {
    const format = booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная';
    const status = bookingStatus(booking);
    const account = booking.user.username ? ` · @${escapeHtml(booking.user.username)}` : '';
    const warning = booking.queueState === 'TECHNICAL_ERROR'
      ? '<div class="queue-warning">Google Calendar не подтвердил встречу. Заявку можно отклонить или заблокировать.</div>'
      : '';
    const actions = booking.canConfirm
      ? `<div class="approval-actions"><button class="primary-button" type="button" data-admin-action="confirm" data-admin-id="${escapeHtml(booking.id)}">Подтвердить</button><button class="danger-button" type="button" data-admin-action="reject" data-admin-id="${escapeHtml(booking.id)}">Отклонить</button></div>`
      : '';
    return `<article class="approval-card">
      <div class="booking-status ${status.className}"><span>${status.icon}</span>${status.label}</div>
      <div class="approval-head"><div><span class="request-code">${escapeHtml(booking.publicCode)}</span><h3>${escapeHtml(booking.title)}</h3><p>${escapeHtml(booking.user.displayName)}${account}</p></div><span class="format-chip ${booking.meetingFormat === 'ONLINE' ? 'online' : 'personal'}">${format}</span></div>
      <div class="approval-time"><span class="date-tile compact"><span>${escapeHtml(adminMonth(booking.startAt))}</span><strong>${new Date(booking.startAt).toLocaleString('ru-RU', { timeZone: booking.timezone, day: 'numeric' })}</strong></span><div><strong>${escapeHtml(formatBookingMoment(booking))}</strong><p>${escapeHtml(timezoneLabel(booking.timezone))} · ${booking.durationMinutes} минут</p></div></div>
      ${warning}${actions}
      <button class="outline-button full-width" type="button" data-admin-booking-id="${escapeHtml(booking.id)}">Открыть заявку</button>
    </article>`;
  }

  async function openAdminBooking(id) {
    try {
      const cached = state.adminBookings.find((booking) => booking.id === id);
      const booking = state.mode === 'demo'
        ? cached
        : (await api(`/admin/bookings/${id}`)).booking;
      if (!booking) throw new Error('Заявка не найдена');
      state.selectedAdminBooking = booking;
      renderAdminDetail(booking);
      showScreen('admin-detail');
    } catch (error) {
      showToast(error.message || 'Не удалось открыть заявку');
    }
  }

  function renderAdminDetail(booking) {
    const status = bookingStatus(booking);
    const format = booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная';
    $('adminDetailCode').textContent = `Заявка ${booking.publicCode}`;
    $('adminDetailTitle').textContent = booking.title;
    $('adminDetailFormat').textContent = format;
    $('adminDetailFormat').className = `format-chip ${booking.meetingFormat === 'ONLINE' ? 'online' : 'personal'}`;
    elements.adminDetailCard.innerHTML = `
      <div class="detail-status-row"><div class="booking-status ${status.className}"><span>${status.icon}</span>${status.label}</div><span>${booking.durationMinutes} мин</span></div>
      <div class="detail-time-block"><strong>${escapeHtml(formatBookingMoment(booking))}</strong><span>${escapeHtml(timezoneLabel(booking.timezone))} · ${format}</span></div>
      ${booking.googleCalendarDayUrl ? `<section class="calendar-review-card">
        <div class="calendar-review-head">
          <span class="calendar-review-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M8 3v4M16 3v4M3 10h18"></path><path d="m9 15 2 2 4-4"></path></svg></span>
          <div><small>GOOGLE CALENDAR</small><strong>Сверьте занятость</strong></div>
        </div>
        <p>Откроем нужный день календаря. Сравните эту встречу с другими заявками на согласовании.</p>
        <button class="calendar-review-button" type="button" data-calendar-url="${escapeHtml(booking.googleCalendarDayUrl)}"><span>Открыть этот день</span><span aria-hidden="true">↗</span></button>
        <span class="calendar-review-note">После проверки вернитесь сюда — заявка останется открытой.</span>
      </section>` : ''}
      <dl class="detail-list">
        <div><dt>Пользователь</dt><dd>${escapeHtml(booking.user.displayName)}</dd></div>
        <div><dt>Telegram</dt><dd>${escapeHtml(booking.user.username ? `@${booking.user.username}` : booking.user.telegramId)}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(booking.email || 'Не указан')}</dd></div>
        <div><dt>Тип</dt><dd>${booking.type === 'RESCHEDULE' ? 'Перенос встречи' : 'Новая встреча'}</dd></div>
        ${booking.rejectionReason ? `<div><dt>Причина</dt><dd>${escapeHtml(booking.rejectionReason)}</dd></div>` : ''}
      </dl>${booking.comment ? `<div class="detail-comment"><span>Комментарий</span><p>${escapeHtml(booking.comment)}</p></div>` : ''}`;
    const actions = [];
    if (booking.canConfirm) actions.push(`<button class="primary-button" type="button" data-admin-action="confirm" data-admin-id="${escapeHtml(booking.id)}">Подтвердить</button>`);
    if (booking.canReject) actions.push(`<button class="danger-button" type="button" data-admin-action="reject" data-admin-id="${escapeHtml(booking.id)}">Отклонить</button>`);
    if (booking.canBlock) actions.push(`<button class="text-button destructive-text" type="button" data-admin-action="block" data-admin-id="${escapeHtml(booking.id)}">Отклонить и заблокировать</button>`);
    elements.adminDetailActions.className = `detail-actions${actions.length === 2 ? ' two' : ''}`;
    elements.adminDetailActions.innerHTML = actions.join('');
  }

  function askAdminDecision(booking, action) {
    const copy = {
      confirm: ['Подтвердить встречу?', 'Перед созданием события сервер ещё раз проверит, свободно ли это время.', 'Подтвердить'],
      reject: ['Отклонить заявку?', 'Резерв времени будет снят. Причину можно сообщить пользователю.', 'Отклонить'],
      block: ['Отклонить и заблокировать?', 'Все ожидающие заявки пользователя будут отклонены, новые заявки перестанут приниматься.', 'Заблокировать'],
    }[action];
    if (!copy) return;
    state.pendingAdminAction = { bookingId: booking.id, action };
    elements.modalTitle.textContent = copy[0];
    elements.modalText.textContent = copy[1];
    elements.modalIcon.textContent = action === 'confirm' ? '✓' : '!';
    elements.modalReasonBlock.classList.toggle('is-hidden', action === 'confirm');
    elements.modalReason.value = '';
    elements.modalClose.classList.add('is-hidden');
    elements.modalConfirmActions.classList.remove('is-hidden');
    elements.modalConfirm.className = action === 'confirm' ? 'primary-button' : 'danger-button';
    elements.modalConfirm.textContent = copy[2];
    elements.modalCancel.textContent = 'Назад';
    elements.modal.classList.remove('is-hidden');
    (action === 'confirm' ? elements.modalCancel : elements.modalReason).focus();
  }

  async function executeAdminDecision() {
    const pending = state.pendingAdminAction;
    if (!pending) return cancelSelectedBooking();
    const reason = elements.modalReason.value.trim();
    elements.modalConfirm.disabled = true;
    elements.modalConfirm.textContent = 'Сохраняем…';
    try {
      let result;
      if (state.mode === 'demo') {
        const booking = state.demoBookings.find((item) => item.id === pending.bookingId);
        if (!booking) throw new Error('Заявка уже исчезла из очереди');
        booking.status = pending.action === 'confirm' ? 'CONFIRMED' : 'REJECTED';
        booking.rejectionReason = pending.action === 'confirm' ? null : reason || null;
        booking.calendarSyncStatus = pending.action === 'confirm' ? 'SYNCED' : 'CANCELLED';
        booking.canCancel = pending.action === 'confirm';
        booking.canReschedule = pending.action === 'confirm';
        booking.demoUserStatus = pending.action === 'block' ? 'BANNED' : 'ACTIVE';
        result = { decision: { outcome: pending.action === 'block' ? 'BLOCKED' : pending.action === 'confirm' ? 'CONFIRMED' : 'REJECTED' }, booking: toDemoAdminBooking(booking) };
      } else {
        result = await api(`/admin/bookings/${pending.bookingId}/${pending.action}`, {
          method: 'POST',
          body: JSON.stringify({ reason: reason || null }),
        });
      }
      const messages = {
        CONFIRMED: ['Встреча подтверждена', 'В Google Calendar создано одно событие, пользователь получил уведомление.', '✓'],
        REJECTED: ['Заявка отклонена', 'Резерв времени снят, пользователь получил уведомление.', '×'],
        BLOCKED: ['Пользователь заблокирован', 'Заявка отклонена, новые заявки этого аккаунта не принимаются.', '!'],
        SLOT_UNAVAILABLE: ['Время уже занято', 'Заявка закрыта без создания события. Предложите пользователю выбрать другое время.', '!'],
        CONFIRMATION_ERROR: ['Ошибка Google Calendar', 'Заявка сохранена с технической ошибкой. Её можно открыть и безопасно отклонить.', '!'],
        ALREADY_PROCESSED: ['Заявка уже обработана', 'Другой администратор успел раньше. Показан актуальный результат.', 'i'],
      };
      const message = messages[result.decision.outcome] || ['Решение сохранено', 'Очередь обновлена.', '✓'];
      closeModal();
      showScreen('admin', { fromHistory: true });
      await loadAdminQueue();
      showModal(...message);
      tg?.HapticFeedback?.notificationOccurred(result.decision.outcome === 'CONFIRMED' ? 'success' : 'warning');
    } catch (error) {
      showToast(error.message || 'Техническая ошибка. Заявка не изменена, попробуйте ещё раз.');
    } finally {
      elements.modalConfirm.disabled = false;
    }
  }

  function toDemoAdminBooking(booking) {
    const pending = booking.status === 'PENDING_APPROVAL';
    const technicalError = booking.status === 'CONFIRMATION_ERROR';
    return {
      ...booking,
      googleCalendarDayUrl: calendarDayUrl(booking.startAt, booking.timezone),
      user: {
        id: 'demo-user', telegramId: '900000003', username: 'ivan_petrov',
        displayName: 'Иван Петров', status: booking.demoUserStatus || 'ACTIVE',
      },
      queueState: technicalError ? 'TECHNICAL_ERROR' : pending ? 'REQUIRES_DECISION' : 'PROCESSED',
      canConfirm: pending,
      canReject: pending || technicalError,
      canBlock: (pending || technicalError) && booking.demoUserStatus !== 'BANNED',
    };
  }

  function adminMonth(startAt) {
    return new Intl.DateTimeFormat('ru-RU', { month: 'short' })
      .format(new Date(startAt)).replace('.', '').toUpperCase();
  }

  function calendarDayUrl(startAt, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(startAt));
    const part = (type) => parts.find((item) => item.type === type)?.value || '';
    return `https://calendar.google.com/calendar/r/day/${Number(part('year'))}/${Number(part('month'))}/${Number(part('day'))}`;
  }

  function openCalendarDay(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://calendar.google.com' || !url.pathname.startsWith('/calendar/')) {
        throw new Error('Некорректная ссылка календаря');
      }
      tg?.HapticFeedback?.selectionChanged();
      if (tg?.openLink) {
        tg.openLink(url.toString());
        return;
      }
      const opened = window.open(url.toString(), '_blank', 'noopener,noreferrer');
      if (!opened) showToast('Разрешите открытие новой вкладки для Google Calendar');
    } catch (error) {
      showToast(error.message || 'Не удалось открыть Google Calendar');
    }
  }

  async function saveNotificationPreferences() {
    const email = elements.notificationEmail.value.trim();
    if (state.notificationChannel === 'EMAIL' && (!email || !elements.notificationEmail.checkValidity())) {
      return invalid(elements.notificationEmail, 'Укажите корректный email');
    }
    elements.saveNotifications.disabled = true;
    try {
      if (state.mode === 'demo') {
        state.user.notificationChannel = state.notificationChannel;
        if (email) state.user.lastConfirmedEmail = email;
      } else {
        const session = await api('/me/notifications', {
          method: 'PATCH',
          body: JSON.stringify({ channel: state.notificationChannel, email: email || null }),
        });
        state.user = session.user;
      }
      initializeNotificationPreferences();
      showToast(state.notificationChannel === 'EMAIL' ? 'Ответы придут на email' : 'Ответы придут в Telegram');
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      showToast(error.message || 'Не удалось сохранить канал');
    } finally {
      elements.saveNotifications.disabled = false;
    }
  }

  function createDemoBookings() {
    const base = addDays(new Date(), 4);
    const make = (values) => ({
      id: values.id, publicCode: values.publicCode, type: values.type || 'NEW', source: 'MINI_APP',
      meetingFormat: values.meetingFormat || 'ONLINE', durationMinutes: values.durationMinutes || 30,
      startAt: values.startAt, endAt: new Date(new Date(values.startAt).getTime() + (values.durationMinutes || 30) * 60_000).toISOString(),
      timezone: 'Europe/Moscow', title: values.title, comment: values.comment || null,
      email: 'ivan@example.com', status: values.status, rejectionReason: null, originalBookingId: null,
      googleMeetUrl: values.status === 'CONFIRMED' && values.meetingFormat !== 'IN_PERSON' ? 'https://meet.google.com/demo-room' : null,
      calendarSyncStatus: values.status === 'CONFIRMED' ? 'SYNCED' : 'PENDING',
      canCancel: ['PENDING_APPROVAL', 'CONFIRMED'].includes(values.status),
      canReschedule: values.status === 'CONFIRMED', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    return [
      make({ id: 'demo-pending', publicCode: 'M-7A3F21C9D4', title: 'Обсуждение проекта', comment: 'Покажу текущий прототип и план запуска.', status: 'PENDING_APPROVAL', startAt: atLocalTime(base, '10:30') }),
      make({ id: 'demo-confirmed', publicCode: 'M-9B18E642A0', title: 'Рабочая встреча', status: 'CONFIRMED', meetingFormat: 'IN_PERSON', durationMinutes: 45, startAt: atLocalTime(addDays(base, 3), '15:30') }),
      make({ id: 'demo-archive', publicCode: 'M-4C6F209BD1', title: 'Знакомство с проектом', status: 'REJECTED', startAt: atLocalTime(addDays(base, -10), '12:00') }),
    ];
  }

  function createDemoReschedule() {
    const original = state.rescheduleOriginal;
    const booking = {
      ...original,
      id: `demo-reschedule-${Date.now()}`,
      publicCode: 'M-R3SCH2026',
      type: 'RESCHEDULE',
      status: 'PENDING_APPROVAL',
      startAt: state.slot.startAt,
      endAt: new Date(new Date(state.slot.startAt).getTime() + original.durationMinutes * 60_000).toISOString(),
      originalBookingId: original.id,
      googleMeetUrl: null,
      calendarSyncStatus: 'PENDING',
      canReschedule: false,
    };
    state.demoBookings.unshift(booking);
    return booking;
  }

  function isDemoActive(booking) {
    if (['PENDING_APPROVAL', 'CONFIRMATION_ERROR'].includes(booking.status)) return true;
    return booking.status === 'CONFIRMED' && new Date(booking.endAt) > new Date();
  }

  function bookingStatus(booking) {
    const statuses = {
      PENDING_APPROVAL: { label: booking.type === 'RESCHEDULE' ? 'Перенос на согласовании' : 'На согласовании', className: 'pending', icon: '' },
      CONFIRMED: { label: new Date(booking.endAt) > new Date() ? 'Подтверждено' : 'Завершено', className: 'confirmed', icon: '✓' },
      REJECTED: { label: 'Отклонено', className: 'rejected', icon: '×' },
      EXPIRED: { label: 'Срок истёк', className: 'cancelled', icon: '×' },
      CANCELLED_BY_USER: { label: 'Отменено', className: 'cancelled', icon: '×' },
      SLOT_UNAVAILABLE: { label: 'Время недоступно', className: 'error', icon: '!' },
      CONFIRMATION_ERROR: { label: 'Нужна проверка', className: 'error', icon: '!' },
    };
    return statuses[booking.status] || { label: booking.status, className: 'error', icon: '!' };
  }

  function formatBookingMoment(booking) {
    const date = new Date(booking.startAt);
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: booking.timezone,
      weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    }).format(date).replace(',', ' ·');
  }

  function atLocalTime(date, time) {
    return new Date(`${isoDate(date)}T${time}:00+03:00`).toISOString();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/gu, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  let toastTimer;
  function showToast(message) {
    elements.toast.textContent = message; elements.toast.classList.add('is-visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2800);
  }

  function showModal(title, text, icon = '✓') {
    elements.modalTitle.textContent = title; elements.modalText.textContent = text; elements.modalIcon.textContent = icon;
    state.pendingAdminAction = null;
    elements.modalReasonBlock.classList.add('is-hidden');
    elements.modalReason.value = '';
    elements.modalConfirmActions.classList.add('is-hidden');
    elements.modalClose.classList.remove('is-hidden');
    elements.modal.classList.remove('is-hidden'); elements.modalClose.focus();
  }

  function closeModal() {
    state.pendingCancelId = null;
    state.pendingAdminAction = null;
    elements.modalReasonBlock.classList.add('is-hidden');
    elements.modalReason.value = '';
    elements.modal.classList.add('is-hidden');
    elements.modalConfirmActions.classList.add('is-hidden');
    elements.modalClose.classList.remove('is-hidden');
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button === elements.previousWeek) { state.weekIndex -= 1; void loadWeek(); return; }
    if (button === elements.nextWeek) { state.weekIndex += 1; void loadWeek(); return; }
    if (button.dataset.nav) { showScreen(button.dataset.nav); return; }
    if (button.dataset.action === 'start-booking') {
      state.rescheduleOriginal = null;
      state.history = ['home']; state.idempotencyKey = newIdempotencyKey();
      state.weekIndex = 0; state.date = null; state.slot = null;
      $('meetingTitle').value = state.mode === 'demo' ? 'Обсуждение проекта' : '';
      $('meetingComment').value = state.mode === 'demo' ? 'Покажу текущий прототип и план запуска.' : '';
      setWizardStep(1); showScreen('wizard', { fromHistory: true }); return;
    }
    if (button.closest('[data-choice-group]')) { selectChoice(button); return; }
    if (button.dataset.bookingTab) {
      document.querySelectorAll('[data-booking-tab]').forEach((tab) => { const selected = tab === button; tab.classList.toggle('is-selected', selected); tab.setAttribute('aria-selected', String(selected)); });
      state.bookingScope = button.dataset.bookingTab;
      renderBookings();
      return;
    }
    if (button.dataset.adminTab) {
      document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
        const selected = tab === button;
        tab.classList.toggle('is-selected', selected);
        tab.setAttribute('aria-selected', String(selected));
      });
      state.adminScope = button.dataset.adminTab;
      void loadAdminQueue();
      return;
    }
    if (button.dataset.adminBookingId) { void openAdminBooking(button.dataset.adminBookingId); return; }
    if (button.dataset.calendarUrl) { openCalendarDay(button.dataset.calendarUrl); return; }
    if (button.dataset.adminAction && button.dataset.adminId) {
      const booking = state.selectedAdminBooking?.id === button.dataset.adminId
        ? state.selectedAdminBooking
        : state.adminBookings.find((item) => item.id === button.dataset.adminId);
      if (booking) askAdminDecision(booking, button.dataset.adminAction);
      return;
    }
    if (button.dataset.bookingId) { void openBooking(button.dataset.bookingId); return; }
    if (button.dataset.cancelId) {
      const booking = state.selectedBooking?.id === button.dataset.cancelId
        ? state.selectedBooking
        : [...state.bookingsByScope.active, ...state.bookingsByScope.archive].find((item) => item.id === button.dataset.cancelId);
      if (booking) askToCancel(booking);
      return;
    }
    if (button.dataset.rescheduleId) {
      const booking = state.selectedBooking?.id === button.dataset.rescheduleId
        ? state.selectedBooking
        : state.bookingsByScope.active.find((item) => item.id === button.dataset.rescheduleId);
      if (booking) startReschedule(booking);
      return;
    }
    if (button.dataset.action) showToast('Действие появится на следующем этапе');
  });

  elements.theme.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  elements.scheduleSettingsForm.addEventListener('submit', saveAdminSchedule);
  elements.back.addEventListener('click', goBack);
  elements.previous.addEventListener('click', () => setWizardStep(state.step - 1));
  elements.next.addEventListener('click', async () => {
    if (!validateCurrentStep()) return;
    if (state.rescheduleOriginal && state.step === 2) await setWizardStep(4);
    else if (state.step < 4) await setWizardStep(state.step + 1);
    else await submitBooking();
  });
  elements.saveNotifications.addEventListener('click', saveNotificationPreferences);
  elements.form.addEventListener('submit', (event) => event.preventDefault());
  elements.modalClose.addEventListener('click', closeModal);
  elements.modalCancel.addEventListener('click', closeModal);
  elements.modalConfirm.addEventListener('click', () => {
    if (state.pendingAdminAction) void executeAdminDecision();
    else void cancelSelectedBooking();
  });
  elements.modal.addEventListener('click', (event) => { if (event.target === elements.modal) closeModal(); });
  addEventListener('keydown', (event) => { if (event.key === 'Escape' && !elements.modal.classList.contains('is-hidden')) closeModal(); });

  function formatLongDate(date) { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`)); }
  function formatShortDate(date) { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`)).replace('.', ''); }
  function addDays(date, days) { const copy = new Date(date); copy.setDate(copy.getDate() + days); return copy; }
  function isoDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  function plural(value, one, few, many) { const n = Math.abs(value) % 100; const n1 = n % 10; return n > 10 && n < 20 ? many : n1 > 1 && n1 < 5 ? few : n1 === 1 ? one : many; }
  function timezoneLabel(timezone) {
    return ({
      'Europe/Kaliningrad': 'Калининград', 'Europe/Moscow': 'Москва', 'Europe/Samara': 'Самара',
      'Asia/Yekaterinburg': 'Екатеринбург', 'Asia/Omsk': 'Омск', 'Asia/Krasnoyarsk': 'Красноярск',
      'Asia/Irkutsk': 'Иркутск', 'Asia/Yakutsk': 'Якутск', 'Asia/Vladivostok': 'Владивосток',
      'Asia/Magadan': 'Магадан', 'Asia/Kamchatka': 'Камчатка',
    })[timezone] || timezone;
  }
  function newIdempotencyKey() { return `mini-app:${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }

  screens.forEach((screen) => screen.setAttribute('aria-hidden', String(screen.dataset.screen !== state.screen)));
  void bootstrap();
})();
