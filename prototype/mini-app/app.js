(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;
  const screens = [...document.querySelectorAll('[data-screen]')];
  const telegramWebApp = window.Telegram?.WebApp;
  const telegramInitData = telegramWebApp?.initData
    || new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash).get('tgWebAppData')
    || '';
  const tg = telegramWebApp?.initData ? telegramWebApp : null;
  const startParam = tg?.initDataUnsafe?.start_param
    || new URLSearchParams(location.search).get('tgWebAppStartParam')
    || '';

  const elements = {
    boot: $('bootPanel'), bootTitle: $('bootTitle'), bootText: $('bootText'), telegram: $('telegramButton'),
    bottomNav: document.querySelector('.bottom-nav'), back: $('backButton'), theme: $('themeButton'),
    next: $('wizardNext'), previous: $('wizardBack'), form: $('bookingForm'), toast: $('toast'),
    modal: $('modalBackdrop'), modalClose: $('modalClose'), modalTitle: $('modalTitle'), modalText: $('modalText'), modalIcon: $('modalIcon'),
    dayGrid: $('dayGrid'), morning: $('morningSlots'), afternoon: $('afternoonSlots'),
    morningFieldset: $('morningFieldset'), afternoonFieldset: $('afternoonFieldset'),
    availabilityNote: $('availabilityNote'), availabilityState: $('availabilityState'), weekLabel: $('weekLabel'),
    previousWeek: $('previousWeek'), nextWeek: $('nextWeek'),
    bookingList: $('bookingList'), bookingsState: $('bookingsState'), bookingsCount: $('bookingsCount'),
    bookingsScopeHint: $('bookingsScopeHint'),
    activeCount: $('activeCount'), archiveCount: $('archiveCount'),
    detailCard: $('bookingDetailCard'), detailActions: $('bookingDetailActions'),
    notificationChannel: $('notificationChannel'), notificationEmail: $('notificationEmail'),
    notificationEmailBlock: $('notificationEmailBlock'), saveNotifications: $('saveNotifications'),
    modalConfirmActions: $('modalConfirmActions'), modalCancel: $('modalCancel'), modalConfirm: $('modalConfirm'),
    modalReasonBlock: $('modalReasonBlock'), modalReason: $('modalReason'),
    adminQueue: $('adminQueue'), adminQueueState: $('adminQueueState'), adminQueueCount: $('adminQueueCount'),
    adminPendingCount: $('adminPendingCount'), adminDecidedToday: $('adminDecidedToday'), adminOldestWait: $('adminOldestWait'), adminReliability: $('adminReliability'), adminNavCount: $('adminNavCount'),
    adminDetailCard: $('adminDetailCard'), adminDetailActions: $('adminDetailActions'),
    adminSettingsState: $('adminSettingsState'), adminSettingsContent: $('adminSettingsContent'),
    googleIntegrationCard: $('googleIntegrationCard'), scheduleSettingsForm: $('scheduleSettingsForm'),
    scheduleTimezone: $('scheduleTimezone'), workingPeriods: $('workingPeriods'),
    minimumLeadTimeMinutes: $('minimumLeadTimeMinutes'), bookingHorizonDays: $('bookingHorizonDays'),
    maxMeetingsPerDay: $('maxMeetingsPerDay'), bufferBeforeMinutes: $('bufferBeforeMinutes'),
    bufferAfterMinutes: $('bufferAfterMinutes'), saveScheduleSettings: $('saveScheduleSettings'),
    restrictionCount: $('restrictionCount'), blockedUserCount: $('blockedUserCount'), templateCount: $('templateCount'),
    restrictionForm: $('restrictionForm'), restrictionDate: $('restrictionDate'), restrictionType: $('restrictionType'),
    restrictionTimeFields: $('restrictionTimeFields'), restrictionStartTime: $('restrictionStartTime'), restrictionEndTime: $('restrictionEndTime'),
    restrictionComment: $('restrictionComment'), saveRestriction: $('saveRestriction'), restrictionList: $('restrictionList'),
    restrictionsState: $('restrictionsState'), restrictionListCount: $('restrictionListCount'),
    blockedUsersList: $('blockedUsersList'), blockedUsersState: $('blockedUsersState'), blockedUsersListCount: $('blockedUsersListCount'),
    templateList: $('templateList'), templatesState: $('templatesState'), templatesListCount: $('templatesListCount'),
    templateEditorForm: $('templateEditorForm'), templateEditorLabel: $('templateEditorLabel'), templateEditorText: $('templateEditorText'),
    templatePlaceholders: $('templatePlaceholders'), saveTemplate: $('saveTemplate'),
    scrollControls: $('scrollControls'), scrollUp: $('scrollUp'), scrollDown: $('scrollDown'),
  };

  const state = {
    screen: 'home', history: [], step: 1, user: null,
    format: 'Онлайн', duration: '30', weeks: [], weekIndex: 0,
    dates: [], date: null, slot: null, timezone: 'Europe/Moscow',
    idempotencyKey: newIdempotencyKey(), submitting: false,
    bookingScope: 'active', bookingCounts: { active: 0, archive: 0 },
    bookingsByScope: { active: [], archive: [] },
    selectedBooking: null, rescheduleOriginal: null, pendingCancelId: null,
    notificationChannel: 'TELEGRAM',
    adminScope: 'pending', adminBookings: [], adminSummary: { pending: 0, decidedToday: 0, aging: 0, oldestWaitingMinutes: null, reliability: null },
    selectedAdminBooking: null, pendingAdminAction: null, adminSettings: null,
    workingPeriodsDraft: [],
    restrictions: [], pendingRestrictionDeleteId: null,
    blockedUsers: [], pendingUnblockUserId: null,
    templates: [], selectedTemplate: null,
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
    try {
      let session;
      try {
        session = await api('/me');
      } catch (error) {
        if (error.status !== 401 || !telegramInitData) throw error;
        session = await api('/session', { method: 'POST', body: JSON.stringify({ initData: telegramInitData }) });
      }
      state.user = session.user;
      $('meetingEmail').value = session.user.lastConfirmedEmail || '';
      initializeNotificationPreferences();
      body.classList.add('live-mode');
      body.classList.toggle('admin-mode', session.user.role === 'ADMIN');
      elements.boot.classList.add('is-ready');
      if (session.user.role === 'ADMIN') void loadAdminQueue();
      await openStartDestination();
      requestAnimationFrame(updateScrollControls);
    } catch (error) {
      elements.boot.classList.add('is-error');
      elements.bootTitle.textContent = 'Откройте приложение в Telegram';
      elements.bootText.textContent = error.status === 403
        ? 'Адрес приложения не совпадает с настройками сервера.'
        : 'Для записи откройте Mini App через Telegram-бота. Здесь используются только настоящие заявки.';
      elements.telegram.classList.remove('is-hidden');
    }
  }

  async function openStartDestination() {
    const calendarMatch = /^calendar_([a-z0-9]+)$/u.exec(startParam);
    if (calendarMatch && state.user?.role === 'ADMIN') {
      await openAdminBooking(calendarMatch[1]);
      return;
    }
    if (startParam === 'calendar') {
      showScreen(state.user?.role === 'ADMIN' ? 'admin' : 'bookings');
    }
  }

  function showScreen(name, options = {}) {
    if (!options.fromHistory && name !== state.screen) state.history.push(state.screen);
    state.screen = name;
    screens.forEach((screen) => {
      const active = screen.dataset.screen === name;
      screen.classList.toggle('is-active', active);
      screen.setAttribute('aria-hidden', String(!active));
    });
    const flow = name === 'wizard' || name === 'success' || name === 'booking-detail' || name === 'admin-detail' || name === 'admin-settings' || name === 'admin-restrictions' || name === 'admin-blocked-users' || name === 'admin-templates' || name === 'admin-template-editor';
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
    if (name === 'admin-restrictions') void loadRestrictions();
    if (name === 'admin-blocked-users') void loadBlockedUsers();
    if (name === 'admin-templates') void loadTemplates();
    scrollTo({ top: 0, behavior: 'smooth' });
    requestAnimationFrame(updateScrollControls);
  }

  function scrollStopPositions() {
    const candidates = document.querySelectorAll(
      '.screen.is-active h1, .screen.is-active h2, .screen.is-active article, .screen.is-active form, .screen.is-active .detail-actions, .screen.is-active .info-strip, .screen.is-active .calendar-review-card',
    );
    const positions = [...candidates]
      .filter((element) => element.offsetParent !== null)
      .map((element) => Math.max(0, Math.round(element.getBoundingClientRect().top + scrollY - 14)))
      .sort((left, right) => left - right);
    return [0, ...positions, Math.max(0, document.documentElement.scrollHeight - innerHeight)]
      .sort((left, right) => left - right)
      .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]) > 18);
  }

  function updateScrollControls() {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const bootVisible = !elements.boot.classList.contains('is-ready');
    const modalVisible = !elements.modal.classList.contains('is-hidden');
    elements.scrollControls.classList.toggle('is-hidden', maxScroll < 28 || bootVisible || modalVisible);
    elements.scrollUp.disabled = scrollY < 12;
    elements.scrollDown.disabled = scrollY > maxScroll - 12;
  }

  function moveByScrollStop(direction) {
    const positions = scrollStopPositions();
    const target = direction > 0
      ? positions.find((position) => position > scrollY + 24)
      : positions.reverse().find((position) => position < scrollY - 24);
    scrollTo({
      top: target ?? (direction > 0 ? document.documentElement.scrollHeight : 0),
      behavior: 'smooth',
    });
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
      state.weeks = (await api(`/availability/weeks?duration=${state.duration}`)).weeks;
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
    state.dates = (await api(`/availability/dates?duration=${state.duration}&weekOffset=${week.offset}`)).dates;
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
      const slots = (await api(`/availability/slots?duration=${state.duration}&date=${state.date}`)).slots;
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
    $('successCode').textContent = rescheduled ? 'Перенос встречи' : 'Заявка отправлена';
    $('successTitle').textContent = rescheduled ? 'Перенос отправлен' : 'Отправлено на согласование';
    $('successText').textContent = rescheduled
      ? 'Старая встреча остаётся действующей, пока новое время не будет подтверждено.'
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
      const [active, archive] = await Promise.all([
        api('/bookings?scope=active'),
        api('/bookings?scope=archive'),
      ]);
      state.bookingsByScope.active = active.bookings;
      state.bookingsByScope.archive = archive.bookings;
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
    elements.bookingsScopeHint.textContent = state.bookingScope === 'active'
      ? 'Здесь только предстоящие встречи'
      : 'Здесь хранятся прошедшие и закрытые записи';
    elements.bookingList.innerHTML = bookings.map(renderBookingCard).join('');
    elements.bookingsState.textContent = bookings.length
      ? ''
      : state.bookingScope === 'active'
        ? 'Активных записей пока нет'
        : 'История пока пуста';
    elements.bookingsState.classList.toggle('is-hidden', bookings.length > 0);
  }

  function renderBookingCard(booking) {
    const status = bookingStatus(booking);
    const format = booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная';
    const typeLabel = booking.type === 'RESCHEDULE' ? '<span class="request-code">Запрос на перенос</span>' : '';
    return `<article class="booking-card${state.bookingScope === 'archive' ? ' is-muted' : ''}">
      <div class="booking-status ${status.className}"><span>${status.icon}</span>${status.label}</div>
      <div class="booking-card-head"><div>${typeLabel}<p>${escapeHtml(formatBookingMoment(booking))}</p><h3>${escapeHtml(booking.title)}</h3></div><span class="format-chip ${booking.meetingFormat === 'ONLINE' ? 'online' : 'personal'}">${format}</span></div>
      <div class="booking-detail-row"><span>${booking.durationMinutes} минут</span><i></i><span>${escapeHtml(timezoneLabel(booking.timezone))}</span></div>
      <button class="outline-button full-width" type="button" data-booking-id="${escapeHtml(booking.id)}">Подробнее</button>
    </article>`;
  }

  async function openBooking(id) {
    try {
      const booking = (await api(`/bookings/${id}`)).booking;
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
    const canAdminDecide = state.user?.role === 'ADMIN'
      && ['PENDING_APPROVAL', 'CONFIRMATION_ERROR'].includes(booking.status);
    const calendarUrl = booking.googleCalendarDayUrl;
    $('bookingDetailCode').textContent = booking.type === 'RESCHEDULE' ? 'Перенос встречи' : 'Детали встречи';
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
      ${canAdminDecide ? renderCalendarReviewCard(calendarUrl, booking.id) : ''}
      <dl class="detail-list">
        <div><dt>Email</dt><dd>${escapeHtml(booking.email || 'Только Telegram')}</dd></div>
        ${booking.rejectionReason ? `<div><dt>Причина</dt><dd>${escapeHtml(booking.rejectionReason)}</dd></div>` : ''}
      </dl>${comment}${meetLink}`;
    const actions = [];
    if (canAdminDecide) {
      if (booking.status === 'PENDING_APPROVAL') actions.push(`<button class="primary-button" type="button" data-admin-action="confirm" data-admin-id="${escapeHtml(booking.id)}">Подтвердить</button>`);
      actions.push(`<button class="danger-button" type="button" data-admin-action="reject" data-admin-id="${escapeHtml(booking.id)}">Отклонить</button>`);
    } else {
      if (booking.canRetry) actions.push(`<button class="primary-button" type="button" data-retry-id="${escapeHtml(booking.id)}">Выбрать другое время</button>`);
      if (booking.canReschedule) actions.push(`<button class="secondary-button" type="button" data-reschedule-id="${escapeHtml(booking.id)}">Перенести</button>`);
      if (booking.canCancel) actions.push(`<button class="danger-button" type="button" data-cancel-id="${escapeHtml(booking.id)}">Отменить</button>`);
    }
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

  function retryUnavailableBooking(booking) {
    state.rescheduleOriginal = null;
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
      await api(`/bookings/${id}/cancel`, { method: 'POST' });
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
      state.adminSettings = await api('/admin/settings');
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
      <p>${connected ? 'Свободные окна, заявки и подтверждённые встречи синхронизируются автоматически.' : 'Проверьте подключение Google Calendar в Telegram-боте.'}</p>
      <div class="integration-account"><span>Аккаунт</span><strong>${escapeHtml(google.accountEmail || 'Не определён')}</strong></div>`;
    const schedule = settings.schedule;
    elements.scheduleTimezone.value = schedule.timezone;
    state.workingPeriodsDraft = schedule.workingPeriods.map((period) => ({ ...period }));
    renderWorkingPeriods();
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

  function renderWorkingPeriods() {
    const dayNames = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
    elements.workingPeriods.innerHTML = [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
      const periods = state.workingPeriodsDraft
        .filter((period) => period.weekday === weekday)
        .sort((left, right) => left.startMinute - right.startMinute);
      const enabled = periods.length > 0;
      const ranges = periods.map((period, index) => `
        <div class="work-period-row">
          <label><span>Начало</span><input type="time" lang="ru-RU" step="900" value="${minuteTimeInput(period.startMinute)}" data-period-field="startMinute" data-period-weekday="${weekday}" data-period-index="${index}" aria-label="${dayNames[weekday]}: начало интервала ${index + 1}"></label>
          <span class="work-period-dash">—</span>
          <label><span>Конец</span><input type="time" lang="ru-RU" step="900" value="${minuteTimeInput(period.endMinute)}" data-period-field="endMinute" data-period-weekday="${weekday}" data-period-index="${index}" aria-label="${dayNames[weekday]}: конец интервала ${index + 1}"></label>
          <button class="remove-work-period" type="button" data-remove-work-period="${weekday}:${index}" aria-label="Удалить интервал ${index + 1} в день ${dayNames[weekday]}">Удалить</button>
        </div>`).join('');
      return `<article class="week-day-card ${enabled ? 'is-enabled' : ''}" data-weekday="${weekday}">
        <button class="week-day-toggle" type="button" data-toggle-weekday="${weekday}" aria-pressed="${enabled}"><span class="day-switch" aria-hidden="true"><i></i></span><span><strong>${dayNames[weekday]}</strong><small>${enabled ? `Запись открыта · ${periods.map((period) => `${minuteTime(period.startMinute)}–${minuteTime(period.endMinute)}`).join(', ')}` : 'Запись закрыта · выходной'}</small></span></button>
        <div class="work-period-list ${enabled ? '' : 'is-hidden'}">${ranges}<button class="add-work-period" type="button" data-add-work-period="${weekday}" ${periods.length >= 4 ? 'disabled' : ''}>+ Добавить ещё время</button></div>
      </article>`;
    }).join('');
  }

  function minuteTime(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function minuteTimeInput(minutes) {
    return minutes === 1440 ? '00:00' : minuteTime(minutes);
  }

  function timeInputMinutes(value, field) {
    const [hour, minute] = String(value).split(':').map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (field === 'endMinute' && hour === 0 && minute === 0) return 1440;
    return hour * 60 + minute;
  }

  function toggleWorkingDay(weekday) {
    const enabled = state.workingPeriodsDraft.some((period) => period.weekday === weekday);
    state.workingPeriodsDraft = state.workingPeriodsDraft.filter((period) => period.weekday !== weekday);
    if (!enabled) state.workingPeriodsDraft.push({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 });
    renderWorkingPeriods();
  }

  function addWorkingPeriod(weekday) {
    const dayPeriods = state.workingPeriodsDraft
      .filter((period) => period.weekday === weekday)
      .sort((left, right) => left.startMinute - right.startMinute);
    if (dayPeriods.length >= 4) return;
    const candidate = findFreeWorkingPeriod(dayPeriods);
    if (!candidate) {
      showToast('В этом дне нет места для ещё одного интервала');
      return;
    }
    state.workingPeriodsDraft.push({ weekday, ...candidate });
    renderWorkingPeriods();
  }

  function findFreeWorkingPeriod(periods) {
    for (const duration of [120, 60, 30]) {
      for (let startMinute = 9 * 60; startMinute + duration <= 1440; startMinute += 30) {
        const endMinute = startMinute + duration;
        if (periods.every((period) => endMinute <= period.startMinute || startMinute >= period.endMinute)) {
          return { startMinute, endMinute };
        }
      }
    }
    return null;
  }

  function removeWorkingPeriod(weekday, index) {
    const dayPeriods = state.workingPeriodsDraft
      .filter((period) => period.weekday === weekday)
      .sort((left, right) => left.startMinute - right.startMinute);
    const removed = dayPeriods[index];
    if (!removed) return;
    const position = state.workingPeriodsDraft.indexOf(removed);
    state.workingPeriodsDraft.splice(position, 1);
    renderWorkingPeriods();
  }

  function updateWorkingPeriodInput(input) {
    const weekday = Number(input.dataset.periodWeekday);
    const index = Number(input.dataset.periodIndex);
    const field = input.dataset.periodField;
    const dayPeriods = state.workingPeriodsDraft
      .filter((period) => period.weekday === weekday)
      .sort((left, right) => left.startMinute - right.startMinute);
    const period = dayPeriods[index];
    const minutes = timeInputMinutes(input.value, field);
    if (!period || minutes === null || (field !== 'startMinute' && field !== 'endMinute')) return;
    period[field] = minutes;
    const summary = input.closest('.week-day-card')?.querySelector('.week-day-toggle small');
    if (summary) summary.textContent = `Запись открыта · ${dayPeriods.map((item) => `${minuteTime(item.startMinute)}–${minuteTime(item.endMinute)}`).join(', ')}`;
  }

  function validateWorkingPeriods() {
    if (!state.workingPeriodsDraft.length) return 'Оставьте хотя бы один рабочий день';
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      const periods = state.workingPeriodsDraft
        .filter((period) => period.weekday === weekday)
        .sort((left, right) => left.startMinute - right.startMinute);
      for (let index = 0; index < periods.length; index += 1) {
        if (periods[index].startMinute % 15 !== 0 || periods[index].endMinute % 15 !== 0) return 'Выберите время с шагом 15 минут';
        if (periods[index].endMinute - periods[index].startMinute < 30) return 'Каждый интервал должен длиться не меньше 30 минут';
        if (index > 0 && periods[index].startMinute < periods[index - 1].endMinute) return 'Интервалы одного дня не должны пересекаться';
      }
    }
    return null;
  }

  function setSelectValue(select, value, label) {
    if (![...select.options].some((option) => Number(option.value) === Number(value))) {
      select.add(new Option(label, String(value)));
    }
    select.value = String(value);
  }

  async function saveAdminSchedule(event) {
    event.preventDefault();
    const workingPeriodsError = validateWorkingPeriods();
    if (workingPeriodsError) {
      showToast(workingPeriodsError);
      return;
    }
    const payload = {
      timezone: elements.scheduleTimezone.value,
      minimumLeadTimeMinutes: Number(elements.minimumLeadTimeMinutes.value),
      bookingHorizonDays: Number(elements.bookingHorizonDays.value),
      maxMeetingsPerDay: Number(elements.maxMeetingsPerDay.value),
      bufferBeforeMinutes: Number(elements.bufferBeforeMinutes.value),
      bufferAfterMinutes: Number(elements.bufferAfterMinutes.value),
      workingPeriods: state.workingPeriodsDraft.map((period) => ({ ...period })),
    };
    elements.saveScheduleSettings.disabled = true;
    elements.saveScheduleSettings.textContent = 'Сохраняем…';
    try {
      state.adminSettings = await api('/admin/settings/schedule', { method: 'PATCH', body: JSON.stringify(payload) });
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

  async function loadRestrictions() {
    if (state.user?.role !== 'ADMIN') return;
    elements.restrictionsState.textContent = 'Загружаем ограничения…';
    elements.restrictionsState.classList.remove('is-hidden');
    elements.restrictionList.replaceChildren();
    elements.restrictionDate.min = isoDate(new Date());
    if (!elements.restrictionDate.value) elements.restrictionDate.value = isoDate(new Date());
    try {
      const payload = await api('/admin/restrictions');
      state.restrictions = payload.restrictions;
      renderRestrictions();
    } catch (error) {
      elements.restrictionsState.textContent = error.message || 'Не удалось загрузить ограничения';
    }
  }

  function renderRestrictions() {
    elements.restrictionListCount.textContent = state.restrictions.length;
    elements.restrictionCount.textContent = state.restrictions.length;
    elements.restrictionList.innerHTML = state.restrictions.map((restriction) => {
      const interval = restriction.type === 'FULL_DAY'
        ? 'Весь день'
        : `${minuteTime(restriction.startMinute)}–${minuteTime(restriction.endMinute)}`;
      const month = new Intl.DateTimeFormat('ru-RU', { month: 'short' })
        .format(new Date(`${restriction.date}T12:00:00`)).replace('.', '').toUpperCase();
      return `<article class="restriction-card"><div class="restriction-date"><span>${escapeHtml(month)}</span><strong>${Number(restriction.date.slice(8, 10))}</strong></div><div><h3>${escapeHtml(formatLongDate(restriction.date))}</h3><p>${escapeHtml(interval)}${restriction.comment ? ` · ${escapeHtml(restriction.comment)}` : ''}</p></div><button type="button" data-delete-restriction-id="${escapeHtml(restriction.id)}" aria-label="Удалить ограничение">×</button></article>`;
    }).join('');
    elements.restrictionsState.textContent = state.restrictions.length ? '' : 'Будущих ограничений пока нет';
    elements.restrictionsState.classList.toggle('is-hidden', state.restrictions.length > 0);
  }

  function toggleRestrictionTimeFields() {
    const interval = elements.restrictionType.value === 'TIME_INTERVAL';
    elements.restrictionTimeFields.classList.toggle('is-hidden', !interval);
    elements.restrictionStartTime.required = interval;
    elements.restrictionEndTime.required = interval;
  }

  async function saveRestriction(event) {
    event.preventDefault();
    const interval = elements.restrictionType.value === 'TIME_INTERVAL';
    const payload = {
      date: elements.restrictionDate.value,
      type: elements.restrictionType.value,
      startTime: interval ? elements.restrictionStartTime.value : null,
      endTime: interval ? elements.restrictionEndTime.value : null,
      comment: elements.restrictionComment.value.trim() || null,
    };
    elements.saveRestriction.disabled = true;
    elements.saveRestriction.textContent = 'Сохраняем…';
    try {
      const result = await api('/admin/restrictions', { method: 'POST', body: JSON.stringify(payload) });
      elements.restrictionComment.value = '';
      showToast(result.created ? 'Время закрыто для записи' : 'Такое ограничение уже существует');
      await loadRestrictions();
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      showToast(error.message || 'Не удалось закрыть время');
    } finally {
      elements.saveRestriction.disabled = false;
      elements.saveRestriction.textContent = 'Закрыть время';
    }
  }

  function askDeleteRestriction(id) {
    state.pendingRestrictionDeleteId = id;
    state.pendingAdminAction = null;
    state.pendingCancelId = null;
    elements.modalTitle.textContent = 'Удалить ограничение?';
    elements.modalText.textContent = 'Это время снова появится среди доступных окон.';
    elements.modalIcon.textContent = '!';
    elements.modalReasonBlock.classList.add('is-hidden');
    elements.modalClose.classList.add('is-hidden');
    elements.modalConfirmActions.classList.remove('is-hidden');
    elements.modalConfirm.className = 'danger-button';
    elements.modalConfirm.textContent = 'Да, удалить';
    elements.modalCancel.textContent = 'Назад';
    elements.modal.classList.remove('is-hidden');
    elements.modalCancel.focus();
  }

  async function deleteRestriction() {
    const id = state.pendingRestrictionDeleteId;
    if (!id) return;
    elements.modalConfirm.disabled = true;
    elements.modalConfirm.textContent = 'Удаляем…';
    try {
      await api(`/admin/restrictions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      closeModal();
      await loadRestrictions();
      showToast('Ограничение удалено');
    } catch (error) {
      showToast(error.message || 'Не удалось удалить ограничение');
    } finally {
      elements.modalConfirm.disabled = false;
    }
  }

  async function loadBlockedUsers() {
    if (state.user?.role !== 'ADMIN') return;
    elements.blockedUsersState.textContent = 'Загружаем список…';
    elements.blockedUsersState.classList.remove('is-hidden');
    elements.blockedUsersList.replaceChildren();
    try {
      state.blockedUsers = (await api('/admin/blocked-users')).users;
      renderBlockedUsers();
    } catch (error) {
      elements.blockedUsersState.textContent = error.message || 'Не удалось загрузить пользователей';
    }
  }

  function renderBlockedUsers() {
    elements.blockedUsersListCount.textContent = state.blockedUsers.length;
    elements.blockedUserCount.textContent = state.blockedUsers.length;
    elements.blockedUsersList.innerHTML = state.blockedUsers.map((user) => {
      const account = user.username ? `@${user.username}` : 'Без username';
      const blockedAt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(user.blockedAt));
      return `<article class="blocked-user-card"><div class="blocked-user-icon">${escapeHtml((user.displayName || '?').slice(0, 1).toUpperCase())}</div><div><h3>${escapeHtml(user.displayName)}</h3><p>${escapeHtml(account)} · заблокирован ${escapeHtml(blockedAt)}</p>${user.reason ? `<small>Причина: ${escapeHtml(user.reason)}</small>` : ''}</div><button class="outline-button" type="button" data-unblock-user-id="${escapeHtml(user.userId)}" data-unblock-user-name="${escapeHtml(user.displayName)}">Разблокировать</button></article>`;
    }).join('');
    elements.blockedUsersState.textContent = state.blockedUsers.length ? '' : 'Заблокированных пользователей нет';
    elements.blockedUsersState.classList.toggle('is-hidden', state.blockedUsers.length > 0);
  }

  function askUnblockUser(userId, displayName) {
    state.pendingUnblockUserId = userId;
    state.pendingRestrictionDeleteId = null;
    state.pendingAdminAction = null;
    state.pendingCancelId = null;
    elements.modalTitle.textContent = 'Разблокировать пользователя?';
    elements.modalText.textContent = `${displayName} снова сможет открывать Mini App и отправлять заявки.`;
    elements.modalIcon.textContent = '✓';
    elements.modalReasonBlock.classList.add('is-hidden');
    elements.modalClose.classList.add('is-hidden');
    elements.modalConfirmActions.classList.remove('is-hidden');
    elements.modalConfirm.className = 'primary-button';
    elements.modalConfirm.textContent = 'Разблокировать';
    elements.modalCancel.textContent = 'Назад';
    elements.modal.classList.remove('is-hidden');
    elements.modalCancel.focus();
  }

  async function unblockUser() {
    const userId = state.pendingUnblockUserId;
    if (!userId) return;
    elements.modalConfirm.disabled = true;
    elements.modalConfirm.textContent = 'Сохраняем…';
    try {
      await api(`/admin/blocked-users/${encodeURIComponent(userId)}/unblock`, { method: 'POST' });
      closeModal();
      await loadBlockedUsers();
      showToast('Пользователь разблокирован');
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      showToast(error.message || 'Не удалось разблокировать пользователя');
    } finally {
      elements.modalConfirm.disabled = false;
    }
  }

  async function loadTemplates() {
    if (state.user?.role !== 'ADMIN') return;
    elements.templatesState.textContent = 'Загружаем шаблоны…';
    elements.templatesState.classList.remove('is-hidden');
    elements.templateList.replaceChildren();
    try {
      state.templates = (await api('/admin/templates')).templates;
      renderTemplates();
    } catch (error) {
      elements.templatesState.textContent = error.message || 'Не удалось загрузить шаблоны';
    }
  }

  function renderTemplates() {
    elements.templatesListCount.textContent = state.templates.length;
    elements.templateCount.textContent = state.templates.length;
    elements.templateList.innerHTML = state.templates.map((template) => {
      const preview = template.text.replace(/\s+/gu, ' ').slice(0, 125);
      const suffix = template.text.length > 125 ? '…' : '';
      const variableCount = template.allowedPlaceholders.length;
      return `<button class="template-card" type="button" data-template-type="${escapeHtml(template.type)}"><span class="template-card-icon">T</span><span><strong>${escapeHtml(template.label)}</strong><small>${escapeHtml(preview)}${suffix}</small><em>${variableCount ? `Подстановок: ${variableCount}` : 'Без подстановок'}</em></span><b aria-hidden="true">›</b></button>`;
    }).join('');
    elements.templatesState.textContent = state.templates.length ? '' : 'Шаблоны не найдены';
    elements.templatesState.classList.toggle('is-hidden', state.templates.length > 0);
  }

  function openTemplateEditor(type) {
    const template = state.templates.find((item) => item.type === type);
    if (!template) return;
    state.selectedTemplate = template;
    elements.templateEditorLabel.textContent = template.label;
    elements.templateEditorText.value = template.text;
    elements.templatePlaceholders.innerHTML = template.allowedPlaceholders.length
      ? template.allowedPlaceholders.map((placeholder) => `<button type="button" data-insert-placeholder="${escapeHtml(placeholder.name)}"><code>{${escapeHtml(placeholder.name)}}</code><span>${escapeHtml(placeholder.label)}</span></button>`).join('')
      : '<p class="placeholder-empty">В этом сообщении подстановки не используются.</p>';
    showScreen('admin-template-editor');
  }

  function insertPlaceholder(name) {
    const token = `{${name}}`;
    const textarea = elements.templateEditorText;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.setRangeText(token, start, end, 'end');
    textarea.focus();
  }

  async function saveTemplate(event) {
    event.preventDefault();
    const template = state.selectedTemplate;
    if (!template) return;
    elements.saveTemplate.disabled = true;
    elements.saveTemplate.textContent = 'Сохраняем…';
    try {
      const payload = await api(`/admin/templates/${encodeURIComponent(template.type)}`, {
        method: 'PATCH',
        body: JSON.stringify({ text: elements.templateEditorText.value }),
      });
      state.selectedTemplate = payload.template;
      state.templates = state.templates.map((item) => item.type === payload.template.type ? payload.template : item);
      showToast('Шаблон сохранён');
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      showToast(error.message || 'Не удалось сохранить шаблон');
    } finally {
      elements.saveTemplate.disabled = false;
      elements.saveTemplate.textContent = 'Сохранить шаблон';
    }
  }

  async function loadAdminQueue() {
    if (state.user?.role !== 'ADMIN') return;
    elements.adminQueueState.textContent = 'Загружаем очередь…';
    elements.adminQueueState.classList.remove('is-hidden');
    elements.adminQueue.replaceChildren();
    try {
      const payload = await api(`/admin/bookings?scope=${state.adminScope}`);
      state.adminBookings = payload.bookings;
      state.adminSummary = payload.summary;
      renderAdminQueue();
    } catch (error) {
      elements.adminQueueState.textContent = error.message || 'Не удалось загрузить очередь';
    }
  }

  function renderAdminQueue() {
    const { pending, decidedToday, aging, oldestWaitingMinutes } = state.adminSummary;
    elements.adminQueueCount.textContent = pending;
    elements.adminPendingCount.textContent = `${pending} ${plural(pending, 'заявка', 'заявки', 'заявок')}`;
    elements.adminDecidedToday.textContent = decidedToday;
    elements.adminOldestWait.textContent = oldestWaitingMinutes === null
      ? 'Нет ожидания'
      : `${aging ? `${aging} требуют внимания · ` : ''}самая долгая ${formatWaitingTime(oldestWaitingMinutes)}`;
    elements.adminOldestWait.classList.toggle('is-aging', aging > 0);
    renderReliability(state.adminSummary.reliability);
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

  function renderReliability(metric) {
    if (!metric) {
      elements.adminReliability.classList.add('is-hidden');
      return;
    }
    const sampleSize = Math.max(0, Number(metric.sampleSize) || 0);
    const minimum = Math.max(1, Number(metric.minimumSampleSize) || 5);
    const remaining = Math.max(0, minimum - sampleSize);
    const progress = Math.min(100, Math.round((sampleSize / minimum) * 100));
    const collecting = metric.comparison === 'COLLECTING';
    const result = collecting
      ? `Нужно ещё ${remaining} ${plural(remaining, 'заявка', 'заявки', 'заявок')} для честного сравнения.`
      : metric.comparison === 'IMPROVED'
        ? 'Доля конфликтов стала ниже прежних 22%.'
        : metric.comparison === 'WORSE'
          ? 'Доля конфликтов выше прежних 22% — нужна дополнительная проверка.'
          : 'Доля конфликтов осталась на прежнем уровне — 22%.';
    const currentRate = metric.ratePercent === null ? 'Нет новых данных' : `${metric.ratePercent}% конфликтов`;
    elements.adminReliability.className = `reliability-card ${collecting ? 'collecting' : metric.comparison.toLowerCase()}`;
    elements.adminReliability.innerHTML = `
      <div class="reliability-head"><div><p class="eyebrow">Статистика заявок</p><h2>${collecting ? `${sampleSize} из ${minimum} заявок` : currentRate}</h2></div><span>${collecting ? 'Считаем' : escapeHtml(currentRate)}</span></div>
      <div class="reliability-progress" aria-label="Учтено ${sampleSize} из ${minimum} заявок"><span style="width:${progress}%"></span></div>
      <p>${escapeHtml(result)} Ранее занятое время выбрали в 2 из 9 заявок — это 22%.</p>`;
  }

  function renderAdminCard(booking) {
    const format = booking.meetingFormat === 'ONLINE' ? 'Онлайн' : 'Личная';
    const status = bookingStatus(booking);
    const account = booking.user.username ? ` · @${escapeHtml(booking.user.username)}` : '';
    const warning = booking.queueState === 'TECHNICAL_ERROR'
      ? '<div class="queue-warning">Google Calendar не подтвердил встречу. Заявку можно отклонить или заблокировать.</div>'
      : booking.status === 'PENDING_APPROVAL' && booking.slotAvailable === false
        ? '<div class="queue-warning">Это время уже занято в календаре. Подтвердить встречу нельзя, но заявку можно отклонить.</div>'
      : '';
    const actionButtons = [];
    if (booking.canConfirm) actionButtons.push(`<button class="primary-button" type="button" data-admin-action="confirm" data-admin-id="${escapeHtml(booking.id)}">Подтвердить</button>`);
    if (booking.canReject) actionButtons.push(`<button class="danger-button" type="button" data-admin-action="reject" data-admin-id="${escapeHtml(booking.id)}">Отклонить</button>`);
    const actions = actionButtons.length ? `<div class="approval-actions${actionButtons.length === 1 ? ' one' : ''}">${actionButtons.join('')}</div>` : '';
    return `<article class="approval-card">
      <div class="approval-meta"><div class="booking-status ${status.className}"><span>${status.icon}</span>${status.label}</div>${renderQueueAge(booking)}</div>
      <div class="approval-head"><div><span class="request-code">${booking.type === 'RESCHEDULE' ? 'Перенос встречи' : 'Новая встреча'}</span><h3>${escapeHtml(booking.title)}</h3><p>${escapeHtml(booking.user.displayName)}${account}</p></div><span class="format-chip ${booking.meetingFormat === 'ONLINE' ? 'online' : 'personal'}">${format}</span></div>
      <div class="approval-time"><span class="date-tile compact"><span>${escapeHtml(adminMonth(booking.startAt))}</span><strong>${new Date(booking.startAt).toLocaleString('ru-RU', { timeZone: booking.timezone, day: 'numeric' })}</strong></span><div><strong>${escapeHtml(formatBookingMoment(booking))}</strong><p>${escapeHtml(timezoneLabel(booking.timezone))} · ${booking.durationMinutes} минут</p></div></div>
      ${renderAdminSlotState(booking)}
      ${warning}${actions}
      <button class="outline-button full-width" type="button" data-admin-booking-id="${escapeHtml(booking.id)}">Открыть заявку</button>
    </article>`;
  }

  async function openAdminBooking(id) {
    try {
      const booking = (await api(`/admin/bookings/${id}`)).booking;
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
    $('adminDetailCode').textContent = booking.type === 'RESCHEDULE' ? 'Перенос встречи' : 'Детали заявки';
    $('adminDetailTitle').textContent = booking.title;
    $('adminDetailFormat').textContent = format;
    $('adminDetailFormat').className = `format-chip ${booking.meetingFormat === 'ONLINE' ? 'online' : 'personal'}`;
    elements.adminDetailCard.innerHTML = `
      <div class="detail-status-row"><div class="booking-status ${status.className}"><span>${status.icon}</span>${status.label}</div><span>${booking.durationMinutes} мин</span></div>
      ${renderQueueAge(booking)}
      <div class="detail-time-block"><strong>${escapeHtml(formatBookingMoment(booking))}</strong><span>${escapeHtml(timezoneLabel(booking.timezone))} · ${format}</span></div>
      ${renderAdminSlotState(booking)}
      ${renderCalendarReviewCard(booking.googleCalendarDayUrl, booking.id)}
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

  function renderAdminSlotState(booking) {
    if (booking.status !== 'PENDING_APPROVAL' || typeof booking.slotAvailable !== 'boolean') return '';
    const available = booking.slotAvailable;
    return `<div class="queue-slot-state ${available ? 'available' : 'unavailable'}"><span aria-hidden="true"></span>${available ? 'Время свободно — можно подтверждать' : 'Время уже занято — подтверждение недоступно'}</div>`;
  }

  function renderQueueAge(booking) {
    if (booking.waitingMinutes === null || booking.waitingMinutes === undefined) return '';
    return `<div class="queue-age${booking.isAging ? ' aging' : ''}">Ждёт решения ${escapeHtml(formatWaitingTime(booking.waitingMinutes))}</div>`;
  }

  function renderCalendarReviewCard(calendarUrl, bookingId) {
    if (!calendarUrl) return '';
    return `<section class="calendar-review-card">
        <div class="calendar-review-head">
          <span class="calendar-review-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M8 3v4M16 3v4M3 10h18"></path><path d="m9 15 2 2 4-4"></path></svg></span>
          <div><small>GOOGLE CALENDAR</small><strong>Сверьте занятость</strong></div>
        </div>
        <p>В нужном времени найдите бледную плашку «На согласовании» с темой этой встречи.</p>
        <button class="calendar-review-button" type="button" data-calendar-url="${escapeHtml(calendarUrl)}" data-calendar-booking-id="${escapeHtml(bookingId)}"><span>Открыть этот день</span><span aria-hidden="true">↗</span></button>
        <span class="calendar-review-note">В календаре нажмите встречу, затем ссылку «← Вернуться в Mini App». Она откроет эту заявку.</span>
      </section>`;
  }

  function askAdminDecision(booking, action) {
    const copy = {
      confirm: ['Подтвердить встречу?', 'Перед созданием события сервер ещё раз проверит, свободно ли это время.', 'Подтвердить'],
      reject: ['Отклонить заявку?', 'Резерв времени будет снят. Причину можно сообщить пользователю.', 'Отклонить'],
      block: ['Отклонить и заблокировать?', 'Все ожидающие заявки пользователя будут отклонены, новые заявки перестанут приниматься.', 'Заблокировать'],
    }[action];
    if (!copy) return;
    state.pendingAdminAction = {
      bookingId: booking.id,
      action,
      returnScreen: state.screen === 'booking-detail' ? 'bookings' : 'admin',
    };
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
      const result = await api(`/admin/bookings/${pending.bookingId}/${pending.action}`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || null }),
      });
      const messages = {
        CONFIRMED: ['Встреча подтверждена', 'В Google Calendar создано одно событие, пользователь получил уведомление.', '✓'],
        REJECTED: ['Заявка отклонена', 'Резерв времени снят, пользователь получил уведомление.', '×'],
        BLOCKED: ['Пользователь заблокирован', 'Заявка отклонена, новые заявки этого аккаунта не принимаются.', '!'],
        SLOT_UNAVAILABLE: ['Время уже занято', 'Заявка закрыта без создания события. Предложите пользователю выбрать другое время.', '!'],
        CONFIRMATION_ERROR: ['Ошибка Google Calendar', 'Заявка сохранена с технической ошибкой. Её можно открыть и безопасно отклонить.', '!'],
        ALREADY_PROCESSED: ['Заявка уже обработана', 'Решение по этой заявке уже принято. Показан актуальный результат.', 'i'],
      };
      const message = messages[result.decision.outcome] || ['Решение сохранено', 'Очередь обновлена.', '✓'];
      closeModal();
      showScreen(pending.returnScreen, { fromHistory: true });
      if (pending.returnScreen === 'bookings') await loadBookings();
      else await loadAdminQueue();
      showModal(...message);
      tg?.HapticFeedback?.notificationOccurred(result.decision.outcome === 'CONFIRMED' ? 'success' : 'warning');
    } catch (error) {
      showToast(error.message || 'Техническая ошибка. Заявка не изменена, попробуйте ещё раз.');
    } finally {
      elements.modalConfirm.disabled = false;
    }
  }

  function adminMonth(startAt) {
    return new Intl.DateTimeFormat('ru-RU', { month: 'short' })
      .format(new Date(startAt)).replace('.', '').toUpperCase();
  }

  async function openCalendarDay(value, bookingId) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://calendar.google.com' || !url.pathname.startsWith('/calendar/')) {
        throw new Error('Некорректная ссылка календаря');
      }
      if (!/^[a-z0-9]+$/u.test(bookingId || '')) throw new Error('Заявка не найдена');
      await api(`/admin/bookings/${bookingId}/calendar-return`, { method: 'POST' });
      tg?.HapticFeedback?.selectionChanged();
      showModal(
        'Возврат уже добавлен',
        'В Google Calendar нажмите эту встречу, затем ссылку «← Вернуться в Mini App». Она вернёт вас прямо к заявке.',
        '↩',
      );
      if (tg?.openLink) {
        tg.openLink(url.toString());
        return;
      }
      window.open(url.toString(), '_blank', 'noopener,noreferrer');
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
      const session = await api('/me/notifications', {
        method: 'PATCH',
        body: JSON.stringify({ channel: state.notificationChannel, email: email || null }),
      });
      state.user = session.user;
      initializeNotificationPreferences();
      showToast(state.notificationChannel === 'EMAIL' ? 'Ответы придут на email' : 'Ответы придут в Telegram');
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      showToast(error.message || 'Не удалось сохранить канал');
    } finally {
      elements.saveNotifications.disabled = false;
    }
  }

  function bookingStatus(booking) {
    if (
      new Date(booking.endAt).getTime() <= Date.now() &&
      ['PENDING_APPROVAL', 'CONFIRMATION_ERROR'].includes(booking.status)
    ) {
      return { label: 'Дата прошла', className: 'past', icon: '•' };
    }
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
    state.pendingRestrictionDeleteId = null;
    state.pendingUnblockUserId = null;
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
      $('meetingTitle').value = '';
      $('meetingComment').value = '';
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
    if (button.dataset.deleteRestrictionId) { askDeleteRestriction(button.dataset.deleteRestrictionId); return; }
    if (button.dataset.unblockUserId) { askUnblockUser(button.dataset.unblockUserId, button.dataset.unblockUserName || 'Пользователь'); return; }
    if (button.dataset.templateType) { openTemplateEditor(button.dataset.templateType); return; }
    if (button.dataset.insertPlaceholder) { insertPlaceholder(button.dataset.insertPlaceholder); return; }
    if (button.dataset.toggleWeekday !== undefined) { toggleWorkingDay(Number(button.dataset.toggleWeekday)); return; }
    if (button.dataset.addWorkPeriod !== undefined) { addWorkingPeriod(Number(button.dataset.addWorkPeriod)); return; }
    if (button.dataset.removeWorkPeriod) {
      const [weekday, index] = button.dataset.removeWorkPeriod.split(':').map(Number);
      removeWorkingPeriod(weekday, index);
      return;
    }
    if (button.dataset.calendarUrl) { void openCalendarDay(button.dataset.calendarUrl, button.dataset.calendarBookingId); return; }
    if (button.dataset.adminAction && button.dataset.adminId) {
      const booking = state.selectedAdminBooking?.id === button.dataset.adminId
        ? state.selectedAdminBooking
        : state.selectedBooking?.id === button.dataset.adminId
          ? state.selectedBooking
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
    if (button.dataset.retryId) {
      const booking = state.selectedBooking?.id === button.dataset.retryId
        ? state.selectedBooking
        : state.bookingsByScope.archive.find((item) => item.id === button.dataset.retryId);
      if (booking) retryUnavailableBooking(booking);
      return;
    }
    if (button.dataset.action) showToast('Это действие сейчас недоступно');
  });

  elements.theme.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  elements.scrollUp.addEventListener('click', () => moveByScrollStop(-1));
  elements.scrollDown.addEventListener('click', () => moveByScrollStop(1));
  addEventListener('scroll', updateScrollControls, { passive: true });
  addEventListener('resize', updateScrollControls);
  new MutationObserver(() => requestAnimationFrame(updateScrollControls))
    .observe($('app'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  elements.scheduleSettingsForm.addEventListener('submit', saveAdminSchedule);
  elements.restrictionForm.addEventListener('submit', saveRestriction);
  elements.templateEditorForm.addEventListener('submit', saveTemplate);
  elements.workingPeriods.addEventListener('change', (event) => {
    const input = event.target.closest('[data-period-field]');
    if (input) updateWorkingPeriodInput(input);
  });
  elements.restrictionType.addEventListener('change', toggleRestrictionTimeFields);
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
    if (state.pendingUnblockUserId) void unblockUser();
    else if (state.pendingRestrictionDeleteId) void deleteRestriction();
    else if (state.pendingAdminAction) void executeAdminDecision();
    else void cancelSelectedBooking();
  });
  elements.modal.addEventListener('click', (event) => { if (event.target === elements.modal) closeModal(); });
  addEventListener('keydown', (event) => { if (event.key === 'Escape' && !elements.modal.classList.contains('is-hidden')) closeModal(); });

  function formatLongDate(date) { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`)); }
  function formatShortDate(date) { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`)).replace('.', ''); }
  function addDays(date, days) { const copy = new Date(date); copy.setDate(copy.getDate() + days); return copy; }
  function isoDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  function plural(value, one, few, many) { const n = Math.abs(value) % 100; const n1 = n % 10; return n > 10 && n < 20 ? many : n1 > 1 && n1 < 5 ? few : n1 === 1 ? one : many; }
  function formatWaitingTime(minutes) {
    const value = Math.max(0, Number(minutes) || 0);
    if (value < 1) return 'меньше минуты';
    if (value < 60) return `${value} мин`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }
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
