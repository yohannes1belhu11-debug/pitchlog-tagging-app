(() => {
  'use strict';

  // ---------- State ----------

  // event: { id, time (seconds), label, subtype, qualifiers: { groupName: value } }
  let events = [];
  let currentVideoPath = null;
  let nextEventId = 1;

  // Each tag can optionally define:
  //  - subtypes: a single-select list shown as chips after logging (e.g. Progressive/Lateral/Backward)
  //  - qualifierGroups: any number of independent single-select chip groups (e.g. Outcome, Pressure)
  // Tags with neither behave exactly like a flat tag: one click, one instant log.
  let tags = [
    {
      label: 'Goal', key: '1',
      qualifierGroups: [
        { name: 'Body part', options: ['Left foot', 'Right foot', 'Head', 'Other'] }
      ]
    },
    {
      label: 'Shot', key: '2',
      subtypes: ['On target', 'Off target', 'Blocked'],
      qualifierGroups: [
        { name: 'Body part', options: ['Left foot', 'Right foot', 'Head'] },
        { name: 'Situation', options: ['Open play', 'Set piece', 'Penalty'] }
      ]
    },
    {
      label: 'Pass', key: '3',
      subtypes: ['Progressive', 'Lateral', 'Backward', 'Long'],
      qualifierGroups: [
        { name: 'Outcome', options: ['Successful', 'Unsuccessful'] },
        { name: 'Pressure', options: ['Under pressure', 'Free'] }
      ]
    },
    {
      label: 'Foul', key: '4',
      qualifierGroups: [
        { name: 'Zone', options: ['Defensive third', 'Middle third', 'Attacking third'] }
      ]
    },
    { label: 'Card', key: '5', subtypes: ['Yellow', 'Red'] },
    { label: 'Corner', key: '6' },
    { label: 'Sub', key: '7', substitution: true },
    {
      label: 'Possession', key: '8', interval: true,
      qualifierGroups: [
        { name: 'Ended by', options: ['Shot', 'Turnover', 'Foul won', 'Out of play'] }
      ]
    }
  ];

  // Captured at startup so hasAutosavableWork() can detect whether the
  // tag set has been customized (loaded from a session or extended with
  // custom tags). Used to decide whether the current state is worth
  // autosaving.
  const DEFAULT_TAGS_LENGTH = tags.length;

  // ---------- Match clock (independent of video) ----------
  // Timestamp-based: clockStartedAt (ms epoch), clockBaseSeconds, clockRunning.
  // The setInterval display timer ONLY refreshes the UI — never advances time.

  const PERIOD_LABELS = {
    'PRE_MATCH': 'Pre-match', '1H': '1st Half', 'HT': 'Half-time',
    '2H': '2nd Half', 'FT': 'Full-time', 'ET1': 'ET 1st Half',
    'ET_HT': 'ET Half-time', 'ET2': 'ET 2nd Half'
  };

  function blankMatchClock() {
    return {
      clockStartedAt: null, clockBaseSeconds: 0, clockRunning: false,
      period: 'PRE_MATCH', scoreFor: 0, scoreAgainst: 0,
      videoSyncOffset: 0, selectedTeam: 'our', selectedPlayerId: null,
      activeSequenceId: null, nextSequenceNumber: 1
    };
  }

  let matchClock = blankMatchClock();

  function getMatchSeconds() {
    if (!matchClock.clockRunning || matchClock.clockStartedAt === null) return matchClock.clockBaseSeconds;
    return matchClock.clockBaseSeconds + (Date.now() - matchClock.clockStartedAt) / 1000;
  }

  function getMatchSecondsFromVideo() {
    if (!currentVideoPath) return null;
    return getCurrentTime() + matchClock.videoSyncOffset;
  }

  function getCurrentMatchSeconds() {
    if (matchClock.clockRunning) return getMatchSeconds();
    const fromVideo = getMatchSecondsFromVideo();
    if (fromVideo !== null && fromVideo > 0) return fromVideo;
    return matchClock.clockBaseSeconds;
  }

  function formatMatchClock(seconds, period) {
    if (!period || period === 'PRE_MATCH') return '00:00';
    const s = Math.max(0, Math.floor(seconds));
    const pad = (n) => String(n).padStart(2, '0');
    let boundary = 0;
    if (period === '1H' || period === 'HT') boundary = 45 * 60;
    else if (period === '2H' || period === 'FT') boundary = 90 * 60;
    else if (period === 'ET1' || period === 'ET_HT') boundary = 105 * 60;
    else if (period === 'ET2') boundary = 120 * 60;
    if (s > boundary && (period === '1H' || period === '2H' || period === 'ET1' || period === 'ET2')) {
      return `${Math.floor(boundary / 60)}+${s - boundary}`;
    }
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  function formatOfficialMinute(seconds, period) {
    if (!period || period === 'PRE_MATCH') return 0;
    const s = Math.max(0, Math.floor(seconds));
    let boundary = 0;
    if (period === '1H' || period === 'HT') boundary = 45 * 60;
    else if (period === '2H' || period === 'FT') boundary = 90 * 60;
    else if (period === 'ET1' || period === 'ET_HT') boundary = 105 * 60;
    else if (period === 'ET2') boundary = 120 * 60;
    if (s > boundary && (period === '1H' || period === '2H' || period === 'ET1' || period === 'ET2')) {
      return Math.floor(boundary / 60) + Math.ceil((s - boundary) / 60);
    }
    return Math.ceil(s / 60);
  }

  function startMatchClock() {
    if (matchClock.clockRunning) return;
    if (matchClock.period === 'PRE_MATCH') matchClock.period = '1H';
    matchClock.clockStartedAt = Date.now();
    matchClock.clockRunning = true;
    renderMatchClock(); markAutosaveDirty();
  }

  function pauseMatchClock() {
    if (!matchClock.clockRunning) return;
    matchClock.clockBaseSeconds = getMatchSeconds();
    matchClock.clockStartedAt = null;
    matchClock.clockRunning = false;
    renderMatchClock(); markAutosaveDirty();
  }

  function endHalf() {
    if (matchClock.clockRunning) {
      matchClock.clockBaseSeconds = getMatchSeconds();
      matchClock.clockStartedAt = null;
      matchClock.clockRunning = false;
    }
    if (matchClock.period === '1H') { matchClock.clockBaseSeconds = 45 * 60; matchClock.period = 'HT'; }
    else if (matchClock.period === '2H') { matchClock.clockBaseSeconds = 90 * 60; matchClock.period = 'FT'; }
    else if (matchClock.period === 'ET1') { matchClock.clockBaseSeconds = 105 * 60; matchClock.period = 'ET_HT'; }
    else if (matchClock.period === 'ET2') { matchClock.clockBaseSeconds = 120 * 60; matchClock.period = 'FT'; }
    renderMatchClock(); markAutosaveDirty();
  }

  function startNextHalf() {
    if (matchClock.period === 'HT') { matchClock.period = '2H'; matchClock.clockBaseSeconds = 45 * 60; }
    else if (matchClock.period === 'FT') { matchClock.period = 'ET1'; matchClock.clockBaseSeconds = 90 * 60; }
    else if (matchClock.period === 'ET_HT') { matchClock.period = 'ET2'; matchClock.clockBaseSeconds = 105 * 60; }
    else return;
    matchClock.clockStartedAt = Date.now();
    matchClock.clockRunning = true;
    renderMatchClock(); markAutosaveDirty();
  }

  let clockDisplayTimer = null;
  function startClockDisplayTimer() {
    if (clockDisplayTimer) return;
    clockDisplayTimer = setInterval(() => {
      if (matchClock.clockRunning) {
        renderMatchClock();
        if (touchlineMode) renderTouchlineAll();
      }
    }, 250);
  }

  function renderMatchClock() {
    const clockEl = document.getElementById('matchClockDisplay');
    const periodEl = document.getElementById('matchPeriodDisplay');
    if (clockEl) clockEl.textContent = formatMatchClock(getCurrentMatchSeconds(), matchClock.period);
    if (periodEl) periodEl.textContent = PERIOD_LABELS[matchClock.period] || matchClock.period;
    const btnStart = document.getElementById('btnClockStart');
    const btnPause = document.getElementById('btnClockPause');
    const btnEndHalf = document.getElementById('btnClockEndHalf');
    const btnNextHalf = document.getElementById('btnClockNextHalf');
    if (btnStart) btnStart.disabled = matchClock.clockRunning || matchClock.period === 'FT';
    if (btnPause) btnPause.disabled = !matchClock.clockRunning;
    if (btnEndHalf) btnEndHalf.disabled = matchClock.period === 'PRE_MATCH' || matchClock.period === 'HT' || matchClock.period === 'FT' || matchClock.period === 'ET_HT';
    if (btnNextHalf) {
      btnNextHalf.disabled = !(matchClock.period === 'HT' || matchClock.period === 'FT' || matchClock.period === 'ET_HT');
      if (matchClock.period === 'HT') btnNextHalf.textContent = 'Start 2nd Half';
      else if (matchClock.period === 'FT') btnNextHalf.textContent = 'Start Extra Time';
      else if (matchClock.period === 'ET_HT') btnNextHalf.textContent = 'Start ET 2nd Half';
      else btnNextHalf.textContent = 'Next Half';
    }
  }

  // ---------- Elements ----------

  const video = document.getElementById('video');
  const videoEmpty = document.getElementById('videoEmpty');
  const videoErrorMsg = document.getElementById('videoErrorMsg');
  const videoDetachedMsg = document.getElementById('videoDetachedMsg');
  const btnDetachVideo = document.getElementById('btnDetachVideo');
  const btnReattachVideo = document.getElementById('btnReattachVideo');
  const tally = document.getElementById('tally');

  const btnOpenVideo = document.getElementById('btnOpenVideo');
  const btnOpenVideoEmpty = document.getElementById('btnOpenVideoEmpty');
  const btnLoadSession = document.getElementById('btnLoadSession');
  const btnSaveSession = document.getElementById('btnSaveSession');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnAddCustom = document.getElementById('btnAddCustom');

  const btnPlayPause = document.getElementById('btnPlayPause');
  const timecodeEl = document.getElementById('timecode');
  const durationEl = document.getElementById('duration');
  const scrub = document.getElementById('scrub');
  const timelineStrip = document.getElementById('timelineStrip');
  const timelineMarkersEl = document.getElementById('timelineMarkers');
  const timelinePlayheadEl = document.getElementById('timelinePlayhead');
  const speed = document.getElementById('speed');

  const tagButtonsEl = document.getElementById('tagButtons');
  const eventListEl = document.getElementById('eventList');
  const eventCountEl = document.getElementById('eventCount');
  const eventSearchInput = document.getElementById('eventSearchInput');
  const eventTypeFilter = document.getElementById('eventTypeFilter');
  const eventFilterCountEl = document.getElementById('eventFilterCount');
  const tabEvents = document.getElementById('tabEvents');
  const tabStats = document.getElementById('tabStats');
  const tabAnalytics = document.getElementById('tabAnalytics');
  const statsPanelEl = document.getElementById('statsPanel');
  const statsContentEl = document.getElementById('statsContent');
  const analyticsPanelEl = document.getElementById('analyticsPanel');
  const analyticsContentEl = document.getElementById('analyticsContent');
  const btnUndo = document.getElementById('btnUndo');

  const detailPanel = document.getElementById('detailPanel');

  const addTagModal = document.getElementById('addTagModal');
  const newTagName = document.getElementById('newTagName');
  const newTagKey = document.getElementById('newTagKey');
  const newTagSubtypes = document.getElementById('newTagSubtypes');
  const newTagQualifiers = document.getElementById('newTagQualifiers');
  const newTagIsInterval = document.getElementById('newTagIsInterval');
  const btnCancelAddTag = document.getElementById('btnCancelAddTag');
  const btnConfirmAddTag = document.getElementById('btnConfirmAddTag');

  const btnExportClips = document.getElementById('btnExportClips');
  const clipExportModal = document.getElementById('clipExportModal');
  const clipPreRoll = document.getElementById('clipPreRoll');
  const clipPostRoll = document.getElementById('clipPostRoll');
  const btnCancelClipExport = document.getElementById('btnCancelClipExport');
  const btnConfirmClipExport = document.getElementById('btnConfirmClipExport');

  const btnManageSquad = document.getElementById('btnManageSquad');
  const squadModal = document.getElementById('squadModal');
  const squadListEl = document.getElementById('squadList');
  const squadBulkInput = document.getElementById('squadBulkInput');
  const btnAddSquadBulk = document.getElementById('btnAddSquadBulk');
  const btnCloseSquadModal = document.getElementById('btnCloseSquadModal');

  const btnMatchSetup = document.getElementById('btnMatchSetup');
  const matchSetupModal = document.getElementById('matchSetupModal');
  const matchSummaryEl = document.getElementById('matchSummary');
  const matchCompetition = document.getElementById('matchCompetition');
  const matchDate = document.getElementById('matchDate');
  const matchOpponent = document.getElementById('matchOpponent');
  const matchVenue = document.getElementById('matchVenue');
  const matchHomeAway = document.getElementById('matchHomeAway');
  const matchOurScore = document.getElementById('matchOurScore');
  const matchOpponentScore = document.getElementById('matchOpponentScore');
  const matchFormation = document.getElementById('matchFormation');
  const lineupSlotsEl = document.getElementById('lineupSlots');
  const btnCancelMatchSetup = document.getElementById('btnCancelMatchSetup');
  const btnSaveMatchSetup = document.getElementById('btnSaveMatchSetup');

  const btnPitchMap = document.getElementById('btnPitchMap');
  const pitchMapModal = document.getElementById('pitchMapModal');
  const pitchMapTagFilter = document.getElementById('pitchMapTagFilter');
  const pitchMapPlayerFilter = document.getElementById('pitchMapPlayerFilter');
  // SP-V6: the modal's team filter uses the v3 team semantics ('our' /
  // 'opponent' / unattributed) — the legacy `side` field stays untouched in
  // the data model; only the filter source field changed.
  const pitchMapTeamFilter = document.getElementById('pitchMapTeamFilter');
  const pitchMapZonesToggle = document.getElementById('pitchMapZonesToggle');
  const pitchMapSvg = document.getElementById('pitchMapSvg');
  const pitchMapLegend = document.getElementById('pitchMapLegend');
  const pitchMapCount = document.getElementById('pitchMapCount');
  const btnClosePitchMap = document.getElementById('btnClosePitchMap');

  const btnSeasonView = document.getElementById('btnSeasonView');
  const seasonModal = document.getElementById('seasonModal');
  const btnCloseSeasonModal = document.getElementById('btnCloseSeasonModal');
  const btnAddSeasonMatches = document.getElementById('btnAddSeasonMatches');
  const seasonMatchListEl = document.getElementById('seasonMatchList');
  const seasonStatsContentEl = document.getElementById('seasonStatsContent');
  const btnExportSeasonCsv = document.getElementById('btnExportSeasonCsv');

  // Recovery modal + autosave toast elements
  const recoveryModal = document.getElementById('recoveryModal');
  const recoveryDetails = document.getElementById('recoveryDetails');
  const btnRecoverAutosave = document.getElementById('btnRecoverAutosave');
  const btnDiscardRecovery = document.getElementById('btnDiscardRecovery');
  const autosaveToast = document.getElementById('autosaveToast');
  const autosaveToastText = document.getElementById('autosaveToastText');
  const autosaveToastClose = document.getElementById('autosaveToastClose');

  // Dirty-state indicator + unsaved-changes confirm modal
  const dirtyIndicator = document.getElementById('dirtyIndicator');
  const dirtyDot = dirtyIndicator ? dirtyIndicator.querySelector('.dirty-dot') : null;
  const dirtyLabel = dirtyIndicator ? dirtyIndicator.querySelector('.dirty-label') : null;
  const unsavedConfirmModal = document.getElementById('unsavedConfirmModal');
  const btnUnsavedSave = document.getElementById('btnUnsavedSave');
  const btnUnsavedDiscard = document.getElementById('btnUnsavedDiscard');
  const btnUnsavedCancel = document.getElementById('btnUnsavedCancel');

  // ---------- Squad roster (persists across matches, separate from tags/events) ----------

  let squad = []; // { id, number, name }
  let nextPlayerId = 1;

  // generatePlayerId(): returns a `player_<n>` id guaranteed unique
  // against ALL existing squad ids — any format, including imported ids
  // outside the player_<digits> pattern — and advances nextPlayerId.
  // (Uniqueness no longer relies solely on the one-time numeric recompute
  // at startup; it is re-checked against the live squad at every add.)
  function generatePlayerId() {
    const result = window.Integrity.nextFreePlayerId(squad.map((p) => String(p.id)), nextPlayerId);
    nextPlayerId = result.next;
    return result.id;
  }

  // persistSquad(): writes the squad to disk via the main process and
  // surfaces failures via the autosave toast (reused for squad errors).
  async function persistSquad() {
    const ok = await window.matchtag.saveSquad(squad);
    if (!ok) {
      showAutosaveToast('Could not save the squad roster. Check disk space and file permissions.');
    }
    return ok;
  }

  function renderSquadList() {
    if (squad.length === 0) {
      squadListEl.innerHTML = '<div class="squad-empty-note">No players added yet — use the box below.</div>';
      return;
    }
    squadListEl.innerHTML = '';
    squad.forEach((p) => {
      const chip = document.createElement('div');
      chip.className = 'squad-chip';
      chip.innerHTML = `
        ${p.number ? `<span class="squad-number">${escapeHtml(p.number)}</span>` : ''}
        <span>${escapeHtml(p.name)}</span>
        <button class="squad-chip-remove" title="Remove">✕</button>
      `;
      chip.querySelector('.squad-chip-remove').addEventListener('click', async () => {
        squad = squad.filter((x) => x.id !== p.id);
        renderSquadList();
        await persistSquad();
        markAutosaveDirty();
      });
      squadListEl.appendChild(chip);
    });
  }

  function openSquadModal() {
    renderSquadList();
    squadBulkInput.value = '';
    squadModal.style.display = 'flex';
  }

  function closeSquadModal() {
    squadModal.style.display = 'none';
  }

  btnManageSquad.addEventListener('click', openSquadModal);
  btnCloseSquadModal.addEventListener('click', closeSquadModal);

  btnAddSquadBulk.addEventListener('click', async () => {
    const lines = squadBulkInput.value.split('\n').map((l) => l.trim()).filter(Boolean);
    lines.forEach((line) => {
      const commaIdx = line.indexOf(',');
      let number = '';
      let name = line;
      if (commaIdx !== -1) {
        number = line.slice(0, commaIdx).trim();
        name = line.slice(commaIdx + 1).trim();
      }
      if (!name) return;
      squad.push({ id: generatePlayerId(), number, name });
    });
    squadBulkInput.value = '';
    renderSquadList();
    await persistSquad();
    markAutosaveDirty();
  });

  // ---------- Match setup (metadata + formation/starting XI) ----------

  const FORMATIONS = {
    '4-4-2': ['GK', 'RB', 'CB', 'CB', 'LB', 'RM', 'CM', 'CM', 'LM', 'ST', 'ST'],
    '4-3-3': ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CM', 'CM', 'RW', 'ST', 'LW'],
    '4-2-3-1': ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CDM', 'CAM', 'RW', 'LW', 'ST'],
    '3-5-2': ['GK', 'CB', 'CB', 'CB', 'RWB', 'CM', 'CM', 'CM', 'LWB', 'ST', 'ST'],
    '3-4-3': ['GK', 'CB', 'CB', 'CB', 'RM', 'CM', 'CM', 'LM', 'RW', 'ST', 'LW'],
    '5-3-2': ['GK', 'RWB', 'CB', 'CB', 'CB', 'LWB', 'CM', 'CM', 'CM', 'ST', 'ST'],
    '4-1-4-1': ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'RM', 'CM', 'CM', 'LM', 'ST']
  };

  function blankMatchInfo() {
    return {
      competition: '', date: '', opponent: '', venue: '', homeAway: 'home',
      ourScore: '', opponentScore: '', formation: '', startingXI: []
    };
  }

  let matchInfo = blankMatchInfo();

  function renderMatchSummary() {
    const parts = [];
    if (matchInfo.opponent) parts.push(`vs ${matchInfo.opponent}`);
    if (matchInfo.homeAway) {
      parts.push(matchInfo.homeAway === 'home' ? 'Home' : matchInfo.homeAway === 'away' ? 'Away' : 'Neutral');
    }
    if (matchInfo.ourScore !== '' && matchInfo.opponentScore !== '' && matchInfo.ourScore != null && matchInfo.opponentScore != null) {
      parts.push(`${matchInfo.ourScore}–${matchInfo.opponentScore}`);
    }
    if (matchInfo.date) parts.push(matchInfo.date);
    if (matchInfo.formation) parts.push(matchInfo.formation);
    matchSummaryEl.textContent = parts.join(' · ');
    renderScoreboard();
  }

  function renderScoreboard() {
    const scoreEl = document.getElementById('scoreboardDisplay');
    const stateEl = document.getElementById('scoreStateDisplay');
    if (scoreEl) scoreEl.textContent = `${matchClock.scoreFor} — ${matchClock.scoreAgainst}`;
    if (stateEl) {
      let state = 'draw';
      if (matchClock.scoreFor > matchClock.scoreAgainst) state = 'winning';
      else if (matchClock.scoreFor < matchClock.scoreAgainst) state = 'losing';
      stateEl.textContent = state.toUpperCase();
      stateEl.className = 'score-state ' + state;
    }
  }

  function renderLineupSlots(forceReset) {
    const formation = matchFormation.value;
    const positions = FORMATIONS[formation] || [];

    if (!positions.length) {
      lineupSlotsEl.innerHTML = '<div class="detail-empty-note">Choose a formation to set the starting XI.</div>';
      matchInfo.startingXI = [];
      return;
    }

    if (forceReset || matchInfo.startingXI.length !== positions.length) {
      matchInfo.startingXI = positions.map((pos) => ({ position: pos, playerId: '' }));
    }

    const squadOptions = squad.map((p) => {
      const label = p.number ? `${p.number} ${p.name}` : p.name;
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    }).join('');

    lineupSlotsEl.innerHTML = matchInfo.startingXI.map((slot, i) => `
      <div class="lineup-slot">
        <span class="lineup-position">${escapeHtml(slot.position)}</span>
        <select class="lineup-player-select" data-slot-index="${i}">
          <option value="">— Select player —</option>
          ${squadOptions}
        </select>
      </div>
    `).join('');

    matchInfo.startingXI.forEach((slot, i) => {
      const sel = lineupSlotsEl.querySelector(`select[data-slot-index="${i}"]`);
      if (sel) sel.value = slot.playerId || '';
    });

    lineupSlotsEl.querySelectorAll('.lineup-player-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const idx = Number(sel.dataset.slotIndex);
        matchInfo.startingXI[idx].playerId = sel.value;
        markAutosaveDirty();
      });
    });
  }

  function openMatchSetupModal() {
    matchCompetition.value = matchInfo.competition || '';
    matchDate.value = matchInfo.date || '';
    matchOpponent.value = matchInfo.opponent || '';
    matchVenue.value = matchInfo.venue || '';
    matchHomeAway.value = matchInfo.homeAway || 'home';
    matchOurScore.value = matchInfo.ourScore ?? '';
    matchOpponentScore.value = matchInfo.opponentScore ?? '';
    matchFormation.value = matchInfo.formation || '';
    renderLineupSlots(false);
    matchSetupModal.style.display = 'flex';
  }

  function closeMatchSetupModal() {
    matchSetupModal.style.display = 'none';
  }

  btnMatchSetup.addEventListener('click', openMatchSetupModal);
  btnCancelMatchSetup.addEventListener('click', closeMatchSetupModal);
  matchFormation.addEventListener('change', () => {
    renderLineupSlots(true);
    markAutosaveDirty();
  });

  btnSaveMatchSetup.addEventListener('click', () => {
    matchInfo.competition = matchCompetition.value.trim();
    matchInfo.date = matchDate.value;
    matchInfo.opponent = matchOpponent.value.trim();
    matchInfo.venue = matchVenue.value.trim();
    matchInfo.homeAway = matchHomeAway.value;
    matchInfo.ourScore = matchOurScore.value;
    matchInfo.opponentScore = matchOpponentScore.value;
    matchInfo.formation = matchFormation.value;
    renderMatchSummary();
    renderEventList(); // player labels may now show updated starting-XI positions
    closeMatchSetupModal();
    markAutosaveDirty();
  });

  // ---------- Time formatting ----------

  function formatTimecode(totalSeconds, withTenths) {
    const s = Math.max(0, totalSeconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const pad = (n) => String(n).padStart(2, '0');
    let out = `${pad(h)}:${pad(m)}:${pad(sec)}`;
    if (withTenths) {
      const tenths = Math.floor((s % 1) * 10);
      out += `.${tenths}`;
    }
    return out;
  }

  // ---------- Video loading ----------

  let currentVideoUrl = null;
  let isDetached = false;
  let remoteState = { currentTime: 0, duration: 0, paused: true, playbackRate: 1 };

  async function openVideo() {
    const result = await window.matchtag.openVideo();
    if (!result) return;
    loadVideoFromPath(result.path, result.url);
  }

  function loadVideoFromPath(filePath, fileUrl) {
    currentVideoPath = filePath;
    currentVideoUrl = fileUrl;
    videoErrorMsg.style.display = 'none';
    videoDetachedMsg.style.display = 'none';
    video.src = fileUrl;
    videoEmpty.style.display = 'none';
    video.style.display = 'block';
    btnPlayPause.disabled = false;
    scrub.disabled = false;
    speed.disabled = false;
    btnDetachVideo.disabled = false;
    markAutosaveDirty();
  }

  // A single source of truth for "what time is it right now" and "how long is
  // the video", regardless of whether the video is playing locally or in the
  // detached window. Tagging, seeking, and the transport bar all go through
  // these instead of touching video.currentTime/video.duration directly.
  function getCurrentTime() {
    return isDetached ? remoteState.currentTime : video.currentTime;
  }

  function getDuration() {
    return isDetached ? remoteState.duration : video.duration;
  }

  function seekTo(time) {
    if (isDetached) {
      remoteState.currentTime = time; // optimistic, so the UI feels instant
      window.matchtag.sendVideoCommand({ type: 'seek', value: time });
    } else {
      video.currentTime = time;
    }
  }

  // ---------- Timeline strip (event markers + playhead) ----------

  function renderTimelineStrip() {
    const duration = getDuration();
    if (!duration || !isFinite(duration) || duration <= 0) {
      timelineMarkersEl.innerHTML = '';
      return;
    }

    const marks = events.map((ev) => {
      const color = eventDotColor(ev);
      const label = `${ev.label} · ${formatTimecode(ev.time, true)}`;
      if (ev.isInterval) {
        const startPct = (ev.startTime / duration) * 100;
        const endPct = (ev.endTime / duration) * 100;
        const widthPct = Math.max(0.3, endPct - startPct);
        return `<div class="timeline-mark timeline-mark-interval" style="left:${startPct}%; width:${widthPct}%; background:${color};" data-time="${ev.time}" title="${escapeHtml(label)}"></div>`;
      }
      const pct = (ev.time / duration) * 100;
      return `<div class="timeline-mark" style="left:${pct}%; background:${color};" data-time="${ev.time}" title="${escapeHtml(label)}"></div>`;
    }).join('');

    timelineMarkersEl.innerHTML = marks;
    timelineMarkersEl.querySelectorAll('.timeline-mark').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        seekTo(parseFloat(el.dataset.time));
      });
    });
  }

  function updateTimelinePlayhead() {
    const duration = getDuration();
    const current = getCurrentTime();
    if (!duration || !isFinite(duration) || duration <= 0) {
      timelinePlayheadEl.style.left = '0%';
      return;
    }
    const pct = Math.min(100, Math.max(0, (current / duration) * 100));
    timelinePlayheadEl.style.left = pct + '%';
  }

  timelineStrip.addEventListener('click', (e) => {
    if (!currentVideoPath) return;
    const duration = getDuration();
    if (!duration || !isFinite(duration)) return;
    const rect = timelineStrip.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    seekTo(Math.min(duration, Math.max(0, fraction * duration)));
  });

  video.addEventListener('loadedmetadata', () => {
    scrub.max = Math.floor(video.duration * 10);
    durationEl.textContent = formatTimecode(video.duration, false);
    renderTimelineStrip();
    updateTimelinePlayhead();
  });

  video.addEventListener('timeupdate', () => {
    if (!scrubbing) {
      scrub.value = Math.floor(video.currentTime * 10);
    }
    timecodeEl.textContent = formatTimecode(video.currentTime, true);
    updateTimelinePlayhead();
  });

  video.addEventListener('play', () => tally.classList.add('live'));
  video.addEventListener('pause', () => tally.classList.remove('live'));

  video.addEventListener('error', () => {
    const err = video.error;
    const messages = {
      1: 'Loading was aborted.',
      2: 'A network or file-access error occurred while loading this video.',
      3: 'The video file could not be decoded (unsupported codec).',
      4: 'This video format is not supported.'
    };
    const message = err ? (messages[err.code] || 'Could not load this video.') : 'Could not load this video.';
    // Build the error UI: message text + a "Find video" button that lets the
    // analyst re-link to the video file if it was moved or renamed.
    const showRelink = !!currentVideoPath;
    videoErrorMsg.innerHTML = `
      <p>${escapeHtml(message)}</p>
      ${showRelink ? '<button id="btnRelinkVideo" class="btn btn-accent">Find video</button>' : ''}
      <p class="video-error-hint">The video file may have been moved or renamed. Click "Find video" to locate it — your tagged events will be preserved.</p>
    `;
    videoErrorMsg.style.display = 'flex';
    video.style.display = 'none';
    btnPlayPause.disabled = true;
    scrub.disabled = true;
    btnDetachVideo.disabled = true;
    const btnRelink = document.getElementById('btnRelinkVideo');
    if (btnRelink) {
      btnRelink.addEventListener('click', relinkVideo);
    }
  });

  // relinkVideo(): let the analyst pick a new location for the video file
  // when the original path is missing or broken. Preserves all tagged events.
  async function relinkVideo() {
    const result = await window.matchtag.openVideo();
    if (!result) return;
    loadVideoFromPath(result.path, result.url);
  }

  // ---------- Detach / reattach video ----------

  btnDetachVideo.addEventListener('click', async () => {
    if (!currentVideoPath || isDetached) return;

    const state = {
      url: currentVideoUrl,
      currentTime: video.currentTime,
      paused: video.paused,
      playbackRate: video.playbackRate
    };
    const ok = await window.matchtag.detachVideo(state);
    if (!ok) return;

    remoteState = state;
    isDetached = true;
    btnDetachVideo.disabled = true;

    video.pause();
    video.removeAttribute('src');
    video.load();
    video.style.display = 'none';
    videoDetachedMsg.style.display = 'flex';
  });

  btnReattachVideo.addEventListener('click', () => {
    window.matchtag.reattachVideo();
    // The actual UI reattachment happens in onVideoClosed below, which fires
    // once the detached window actually closes - the same path used whether
    // the user clicks this button or just closes that window directly.
  });

  function reattachLocally() {
    if (!isDetached) return;
    isDetached = false;
    btnDetachVideo.disabled = false;

    const restoreState = remoteState;
    videoDetachedMsg.style.display = 'none';
    video.style.display = 'block';
    video.src = currentVideoUrl;

    const applyRestoredState = () => {
      video.currentTime = restoreState.currentTime || 0;
      video.playbackRate = restoreState.playbackRate || 1;
      if (!restoreState.paused) video.play();
      video.removeEventListener('loadedmetadata', applyRestoredState);
    };
    video.addEventListener('loadedmetadata', applyRestoredState);
  }

  window.matchtag.onVideoState((state) => {
    const durationJustLearned = !remoteState.duration && state.duration;
    remoteState = state;
    if (!isDetached) return;
    if (state.duration) {
      scrub.max = Math.floor(state.duration * 10);
      durationEl.textContent = formatTimecode(state.duration, false);
    }
    if (!scrubbing) scrub.value = Math.floor(state.currentTime * 10);
    timecodeEl.textContent = formatTimecode(state.currentTime, true);
    btnPlayPause.textContent = state.paused ? '▶' : '⏸';
    tally.classList.toggle('live', !state.paused);
    updateTimelinePlayhead();
    if (durationJustLearned) renderTimelineStrip();
  });

  window.matchtag.onVideoClosed(() => {
    reattachLocally();
  });

  // ---------- Transport controls ----------

  let scrubbing = false;

  btnPlayPause.addEventListener('click', () => {
    if (isDetached) {
      window.matchtag.sendVideoCommand({ type: remoteState.paused ? 'play' : 'pause' });
      return;
    }
    if (video.paused) {
      video.play();
      btnPlayPause.textContent = '⏸';
    } else {
      video.pause();
      btnPlayPause.textContent = '▶';
    }
  });

  scrub.addEventListener('input', () => {
    scrubbing = true;
    const t = Number(scrub.value) / 10;
    timecodeEl.textContent = formatTimecode(t, true);
  });

  scrub.addEventListener('change', () => {
    seekTo(Number(scrub.value) / 10);
    scrubbing = false;
  });

  speed.addEventListener('change', () => {
    const rate = Number(speed.value);
    if (isDetached) {
      window.matchtag.sendVideoCommand({ type: 'setRate', value: rate });
    } else {
      video.playbackRate = rate;
    }
  });

  // ---------- Tag buttons ----------

  let activeIntervals = {}; // tag.label -> { startTime }

  function tagHasDetails(tag) {
    return Boolean((tag.subtypes && tag.subtypes.length) || (tag.qualifierGroups && tag.qualifierGroups.length) || tag.substitution);
  }

  function isRecordingInterval(tag) {
    return Object.prototype.hasOwnProperty.call(activeIntervals, tag.label);
  }

  function renderTagButtons() {
    tagButtonsEl.innerHTML = '';
    tags.forEach((tag) => {
      const recording = tag.interval && isRecordingInterval(tag);
      const btn = document.createElement('button');
      btn.className = 'tag-btn' + (recording ? ' tag-btn-recording' : '');
      btn.innerHTML = `
        <span>${escapeHtml(tag.label)}${tag.interval ? ' ⏱' : ''}</span>
        <span class="key">${escapeHtml(tag.key)}</span>
        ${recording ? '<span class="tag-recording-label">Recording…</span>' : ''}
        ${tagHasDetails(tag) ? '<span class="tag-detail-dot" title="Has extra detail options"></span>' : ''}
      `;
      btn.addEventListener('click', () => handleTagPress(tag));
      tagButtonsEl.appendChild(btn);
    });
  }

  function handleTagPress(tag) {
    // Tagging no longer requires a video. The match clock provides the timestamp.
    if (tag.interval) {
      if (isRecordingInterval(tag)) { finishInterval(tag); }
      else { startInterval(tag); }
    } else {
      logEvent(tag);
    }
  }

  function startInterval(tag) {
    // Capture BOTH clocks at the START: the video clock (used when a video
    // is loaded — existing behavior) and the independent match clock (used
    // when no video is available, so interval events carry real match times
    // instead of 0 — F2 fix).
    activeIntervals[tag.label] = {
      startTime: getCurrentTime(),
      startMatchSeconds: getCurrentMatchSeconds(),
      startPeriod: matchClock.period
    };
    renderTagButtons();
  }

  // buildEventTimestamps(): creates the match-time fields for an event.
  // `anchor` (optional): { matchSeconds, period } captured at an earlier
  // moment — used by no-video interval events (F2) so their match-time
  // fields describe the interval START and stay mutually consistent with
  // the interval bounds (matchTime == startTime, matchSeconds ==
  // floor(startTime)) instead of mixing a zero video clock with the match
  // clock. When omitted (all instant events, and video-linked intervals),
  // behavior is exactly as before.
  function buildEventTimestamps(anchor) {
    // videoTime is null when no video is loaded OR when the video failed to load
    // (video.readyState === 0 means no data has loaded, which happens when the
    // video file is missing/corrupt). This prevents storing videoTime=0 for
    // events tagged while a broken video path is set.
    const videoLoaded = currentVideoPath && video.readyState >= 2;
    const videoTime = videoLoaded ? getCurrentTime() : null;
    const matchSeconds = anchor ? anchor.matchSeconds : getCurrentMatchSeconds();
    const period = anchor ? anchor.period : matchClock.period;
    return {
      videoTime: videoTime,
      matchTime: matchSeconds,
      matchSeconds: Math.floor(matchSeconds),
      officialMinute: formatOfficialMinute(matchSeconds, period),
      second: Math.floor(matchSeconds) % 60,
      period: period
    };
  }

  // buildEventBase(tag): creates the common event fields shared by instant
  // and interval events. Includes the v3 match-time fields plus the legacy
  // `time` field (aliased to matchTime) for backward compatibility.
  // `anchor` is only provided for no-video interval events (see F2 above).
  function buildEventBase(tag, anchor) {
    const ts = buildEventTimestamps(anchor);
    return {
      id: nextEventId++,
      time: ts.matchTime,          // legacy alias for matchTime
      videoTime: ts.videoTime,
      matchTime: ts.matchTime,
      matchSeconds: ts.matchSeconds,
      officialMinute: ts.officialMinute,
      second: ts.second,
      period: ts.period,
      label: tag.label,
      subtype: null,
      qualifiers: {},
      location: null,
      playerId: matchClock.selectedPlayerId || null,
      playerOffId: null,
      playerOnId: null,
      side: matchClock.selectedTeam === 'our' ? 'for' : matchClock.selectedTeam === 'opponent' ? 'against' : null,
      team: matchClock.selectedTeam,
      sequenceId: matchClock.activeSequenceId || null,
      scoreForBefore: matchClock.scoreFor,
      scoreAgainstBefore: matchClock.scoreAgainst
    };
  }

  function finishInterval(tag) {
    const active = activeIntervals[tag.label];
    if (!active) return;
    delete activeIntervals[tag.label];

    // F2 fix: decide which clock owns the interval bounds using the SAME
    // "is the video actually usable" test as buildEventTimestamps(), so the
    // two never disagree (both run in this synchronous block).
    const videoLoaded = currentVideoPath && video.readyState >= 2;
    let startTime, endTime, anchor = null;
    if (videoLoaded) {
      // Video linked (existing behavior, preserved): interval bounds are
      // video times, and the match-time fields describe the FINISH moment.
      const currentTime = getCurrentTime();
      startTime = Math.min(active.startTime, currentTime);
      endTime = Math.max(active.startTime, currentTime);
    } else {
      // No usable video: use the independent match clock for the interval
      // bounds (captured at START and FINISH), and anchor the event's
      // match-time fields to the START so the whole event is internally
      // consistent: time == matchTime == startTime, matchSeconds ==
      // floor(startTime), officialMinute/second derived from startTime.
      const endMatchSeconds = getCurrentMatchSeconds();
      startTime = Math.min(active.startMatchSeconds, endMatchSeconds);
      endTime = Math.max(active.startMatchSeconds, endMatchSeconds);
      anchor = { matchSeconds: startTime, period: active.startPeriod };
    }
    const event = Object.assign(buildEventBase(tag, anchor), {
      time: startTime, isInterval: true, startTime, endTime, matchTime: startTime
    });
    events.push(event);
    events.sort((a, b) => a.time - b.time);
    lastLoggedEventId = event.id;
    updateUndoButton();
    renderTagButtons();
    renderEventList();
    openDetailPanel(tag, event);
    markAutosaveDirty();
  }

  function logEvent(tag) {
    const event = buildEventBase(tag);
    // For goal events, update the live score
    if (tag.label === 'Goal' || tag.label === 'GOAL') {
      if (matchClock.selectedTeam === 'our') {
        event.scoreForBefore = matchClock.scoreFor;
        event.scoreAgainstBefore = matchClock.scoreAgainst;
        matchClock.scoreFor++;
        event.scoreForAfter = matchClock.scoreFor;
        event.scoreAgainstAfter = matchClock.scoreAgainst;
      } else if (matchClock.selectedTeam === 'opponent') {
        event.scoreForBefore = matchClock.scoreFor;
        event.scoreAgainstBefore = matchClock.scoreAgainst;
        matchClock.scoreAgainst++;
        event.scoreForAfter = matchClock.scoreFor;
        event.scoreAgainstAfter = matchClock.scoreAgainst;
      }
      renderScoreboard();
    }
    events.push(event);
    events.sort((a, b) => a.time - b.time);
    lastLoggedEventId = event.id;
    updateUndoButton();
    renderEventList();
    openDetailPanel(tag, event);
    markAutosaveDirty();
  }

  let lastLoggedEventId = null;

  // F3 fix — shared score-correction for goal removal (single system, used by
  // BOTH the undo button and the per-event delete button; NOT a second undo
  // system). Called AFTER the goal event has been removed from `events`.
  //
  // How it works (no blind subtraction):
  //   1. Restore the live score to the exact pre-goal state recorded on the
  //      removed event itself (scoreForBefore/scoreAgainstBefore were
  //      captured at tag time = "reliable previous state").
  //   2. Every remaining event that was logged AFTER the removed goal
  //      (event ids are assigned monotonically at log time, so id >
  //      removed.id means "logged later") carries score fields that include
  //      the removed goal's increment. Shift their stored
  //      scoreForBefore/scoreAgainstBefore (and After, on goals) by the
  //      removed goal's delta so the whole chain stays consistent.
  //   3. Re-apply the deltas of the remaining goals logged after the removed
  //      one ("derive the restored score from the remaining goal events") so
  //      the live score lands on the correct final value for mid-stream
  //      deletions too.
  // For the undo path the removed goal is by definition the most recently
  // logged event, so steps 2/3 find nothing and the result is exactly the
  // pre-goal match state. Own goals / penalties follow the existing goal
  // representation (team selection alone decides which side increments), so
  // no special cases are needed.
  function applyGoalRemovalScoreCorrection(removedEvent) {
    if (!removedEvent || typeof removedEvent !== 'object') return false;
    if (removedEvent.label !== 'Goal' && removedEvent.label !== 'GOAL') return false;
    // scoreForAfter/scoreAgainstAfter are only set by logEvent() when the
    // goal actually incremented the score. A goal tagged with no team
    // selected never changed the score, and removing it must not either.
    if (removedEvent.scoreForAfter == null || removedEvent.scoreAgainstAfter == null) return false;
    const beforeF = Number(removedEvent.scoreForBefore);
    const beforeA = Number(removedEvent.scoreAgainstBefore);
    const dF = Number(removedEvent.scoreForAfter) - beforeF;
    const dA = Number(removedEvent.scoreAgainstAfter) - beforeA;
    // Sanity gate: logEvent() always increments exactly one side by 1.
    // Anything else is not a score-changing goal in the current model —
    // leave the score untouched rather than corrupt it.
    if (!Number.isFinite(beforeF) || !Number.isFinite(beforeA)) return false;
    if (!((dF === 0 && dA === 1) || (dF === 1 && dA === 0))) return false;

    matchClock.scoreFor = beforeF;
    matchClock.scoreAgainst = beforeA;

    events.forEach((ev) => {
      if (!(ev && typeof ev === 'object') || ev.id == null || !(ev.id > removedEvent.id)) return;
      // This event was logged after the removed goal: its score fields
      // include the removed goal's increment.
      if (ev.scoreForBefore != null) ev.scoreForBefore -= dF;
      if (ev.scoreAgainstBefore != null) ev.scoreAgainstBefore -= dA;
      if (ev.scoreForAfter != null) ev.scoreForAfter -= dF;
      if (ev.scoreAgainstAfter != null) ev.scoreAgainstAfter -= dA;
      // If it is itself a score-changing goal, re-apply its own increment to
      // the live score so the final value reflects the remaining goals.
      if ((ev.label === 'Goal' || ev.label === 'GOAL') &&
          ev.scoreForAfter != null && ev.scoreAgainstAfter != null) {
        matchClock.scoreFor += Number(ev.scoreForAfter) - Number(ev.scoreForBefore);
        matchClock.scoreAgainst += Number(ev.scoreAgainstAfter) - Number(ev.scoreAgainstBefore);
      }
    });

    renderScoreboard();
    return true;
  }

  function updateUndoButton() {
    btnUndo.disabled = lastLoggedEventId == null || !events.some((e) => e.id === lastLoggedEventId);
  }

  function undoLastTag() {
    if (lastLoggedEventId == null) return;
    const undoneEvent = events.find((e) => e.id === lastLoggedEventId);
    if (activeDetailEvent && activeDetailEvent.id === lastLoggedEventId) closeDetailPanel();
    events = events.filter((e) => e.id !== lastLoggedEventId);
    lastLoggedEventId = null;

    // F3 fix: if the undone event was a goal that changed the live score,
    // restore the exact pre-goal match state (see
    // applyGoalRemovalScoreCorrection). For undo this is precise: the goal is
    // the most recently logged event, so no event was logged after it and
    // every remaining event's score fields were captured before the goal —
    // already consistent with the restored state.
    applyGoalRemovalScoreCorrection(undoneEvent);

    updateUndoButton();
    renderEventList();
    markAutosaveDirty();
  }

  btnUndo.addEventListener('click', undoLastTag);

  // ---------- Detail panel (subtypes, qualifiers & pitch location) ----------

  let activeDetailTag = null;
  let activeDetailEvent = null;

  const PITCH_THIRDS = ['Defensive third', 'Middle third', 'Attacking third'];
  const PITCH_CHANNELS = ['Left channel', 'Central channel', 'Right channel'];

  function clamp01(n) {
    return Math.min(1, Math.max(0, n));
  }

  function locationZone(x, y) {
    const tIdx = Math.min(2, Math.floor(x * 3));
    const cIdx = Math.min(2, Math.floor(y * 3));
    return `${PITCH_THIRDS[tIdx]} · ${PITCH_CHANNELS[cIdx]}`;
  }

  function openDetailPanel(tag, event) {
    activeDetailTag = tag;
    activeDetailEvent = event;
    renderDetailPanel();
    detailPanel.style.display = 'block';
  }

  function closeDetailPanel() {
    detailPanel.style.display = 'none';
    activeDetailTag = null;
    activeDetailEvent = null;
  }

  function pitchMarkingsSvg() {
    return `
      <rect x="4" y="4" width="692" height="442" class="pitch-outline" rx="3" />
      <line x1="350" y1="4" x2="350" y2="446" class="pitch-line" />
      <circle cx="350" cy="225" r="55" class="pitch-line" />
      <circle cx="350" cy="225" r="3" class="pitch-spot" />
      <rect x="4" y="115" width="110" height="220" class="pitch-line" />
      <rect x="4" y="170" width="45" height="110" class="pitch-line" />
      <circle cx="96" cy="225" r="3" class="pitch-spot" />
      <path d="M 114 180 A 55 55 0 0 1 114 270" class="pitch-line" />
      <rect x="586" y="115" width="110" height="220" class="pitch-line" />
      <rect x="651" y="170" width="45" height="110" class="pitch-line" />
      <circle cx="604" cy="225" r="3" class="pitch-spot" />
      <path d="M 586 180 A 55 55 0 0 0 586 270" class="pitch-line" />
    `;
  }

  function pitchSvgMarkup(ev) {
    const marker = ev.location
      ? `<circle class="pitch-marker" cx="${ev.location.x * 700}" cy="${ev.location.y * 450}" r="8"/>`
      : '';
    return `
      <svg class="pitch-svg" id="pitchSvg" viewBox="0 0 700 450" preserveAspectRatio="xMidYMid meet">
        ${pitchMarkingsSvg()}
        ${marker}
      </svg>
      <div class="pitch-readout">
        ${ev.location
          ? `<span class="pitch-zone-text">${escapeHtml(locationZone(ev.location.x, ev.location.y))}</span>
             <button class="chip pitch-clear-btn" id="clearLocation">Clear</button>`
          : '<span class="pitch-zone-text placeholder">Click the pitch to set a location</span>'}
      </div>
    `;
  }

  function playerChipLabel(p) {
    const starterEntry = (matchInfo.startingXI || []).find((s) => s.playerId === p.id);
    const posSuffix = starterEntry ? ` (${starterEntry.position})` : '';
    return (p.number ? `${p.number} ${p.name}` : p.name) + posSuffix;
  }

  // resolvePlayer(playerId): look up a player in the current squad by ID.
  // Returns the player object { id, number, name } or null if not found.
  // This is the core of the Phase 1E reference-by-ID change: events store
  // only the playerId string, and the renderer resolves it to the current
  // squad entry at display time. If the player was deleted from the squad,
  // this returns null and the caller shows "Unknown player".
  function resolvePlayer(playerId) {
    if (!playerId || typeof playerId !== 'string') return null;
    return squad.find((p) => p.id === playerId) || null;
  }

  function squadChipsMarkup(ev, kind, selectedField) {
    if (squad.length === 0) {
      return '<span class="detail-empty-note">No players added — use "Manage squad" in the top bar.</span>';
    }
    const starterIds = new Set((matchInfo.startingXI || []).map((s) => s.playerId).filter(Boolean));
    const starters = squad.filter((p) => starterIds.has(p.id));
    const bench = squad.filter((p) => !starterIds.has(p.id));
    // selectedField is now 'playerId', 'playerOffId', or 'playerOnId'
    // (a plain string, not a snapshot object)
    const selectedId = ev[selectedField];

    function chipsFor(list) {
      return list.map((p) => {
        const isSel = selectedId && selectedId === p.id ? ' selected' : '';
        return `<button class="chip${isSel}" data-kind="${kind}" data-player-id="${escapeHtml(p.id)}">${escapeHtml(playerChipLabel(p))}</button>`;
      }).join('');
    }

    let html = '';
    if (starters.length) {
      html += `<div class="detail-subgroup-label">Starting XI</div><div class="detail-chips">${chipsFor(starters)}</div>`;
    }
    if (bench.length) {
      html += `<div class="detail-subgroup-label">${starters.length ? 'Bench' : 'Squad'}</div><div class="detail-chips">${chipsFor(bench)}</div>`;
    }
    return html;
  }

  function playerSectionMarkup(ev) {
    return squadChipsMarkup(ev, 'player', 'playerId');
  }

  function sideSectionMarkup(ev) {
    const options = [
      { value: 'for', label: 'For' },
      { value: 'against', label: 'Against' },
      { value: 'neutral', label: 'Neutral' }
    ];
    const chips = options.map((o) => {
      const selected = ev.side === o.value ? ' selected' : '';
      return `<button class="chip${selected}" data-kind="side" data-value="${o.value}">${o.label}</button>`;
    }).join('');
    return `<div class="detail-chips">${chips}</div>`;
  }

  function timingControlsMarkup(ev) {
    return `
      <div class="timing-controls">
        <button class="btn btn-ghost timing-btn" data-nudge="-1">-1s</button>
        <button class="btn btn-ghost timing-btn" data-nudge="-0.1">-0.1s</button>
        <span class="timing-current">${formatTimecode(ev.time, true)}</span>
        <button class="btn btn-ghost timing-btn" data-nudge="0.1">+0.1s</button>
        <button class="btn btn-ghost timing-btn" data-nudge="1">+1s</button>
      </div>
      <button class="btn btn-ghost btn-set-playhead" id="setToPlayhead">Use current playhead position</button>
    `;
  }

  function intervalTimingControlsMarkup(ev) {
    const duration = (ev.endTime - ev.startTime).toFixed(1);
    return `
      <div class="timing-bound-label">Start</div>
      <div class="timing-controls">
        <button class="btn btn-ghost timing-btn" data-bound="start" data-nudge="-1">-1s</button>
        <button class="btn btn-ghost timing-btn" data-bound="start" data-nudge="-0.1">-0.1s</button>
        <span class="timing-current">${formatTimecode(ev.startTime, true)}</span>
        <button class="btn btn-ghost timing-btn" data-bound="start" data-nudge="0.1">+0.1s</button>
        <button class="btn btn-ghost timing-btn" data-bound="start" data-nudge="1">+1s</button>
      </div>
      <button class="btn btn-ghost btn-set-playhead" id="setStartPlayhead">Set start to current playhead</button>

      <div class="timing-bound-label">End</div>
      <div class="timing-controls">
        <button class="btn btn-ghost timing-btn" data-bound="end" data-nudge="-1">-1s</button>
        <button class="btn btn-ghost timing-btn" data-bound="end" data-nudge="-0.1">-0.1s</button>
        <span class="timing-current">${formatTimecode(ev.endTime, true)}</span>
        <button class="btn btn-ghost timing-btn" data-bound="end" data-nudge="0.1">+0.1s</button>
        <button class="btn btn-ghost timing-btn" data-bound="end" data-nudge="1">+1s</button>
      </div>
      <button class="btn btn-ghost btn-set-playhead" id="setEndPlayhead">Set end to current playhead</button>

      <div class="timing-duration">Duration: ${duration}s</div>
    `;
  }

  // ---------- Aggregate pitch map ----------

  const PITCH_MAP_PALETTE = ['#e8b93b', '#4f8fdb', '#e08a3c', '#3ba8a0', '#8a6fd1', '#d84b4b', '#6fcf6f', '#e07ec0'];

  function eventDotColor(ev) {
    if (ev.label === 'Card') {
      if (ev.subtype === 'Yellow') return '#e8c93b';
      if (ev.subtype === 'Red') return '#d84b4b';
    }
    const idx = tags.findIndex((t) => t.label === ev.label);
    return PITCH_MAP_PALETTE[(idx === -1 ? 0 : idx) % PITCH_MAP_PALETTE.length];
  }

  function eventDotLegendLabel(ev) {
    if (ev.label === 'Card' && (ev.subtype === 'Yellow' || ev.subtype === 'Red')) {
      return `${ev.subtype} card`;
    }
    return ev.label;
  }

  function populatePitchMapFilters() {
    const tagOptions = ['<option value="__all__">All events</option>']
      .concat(tags.map((t) => `<option value="${escapeHtml(t.label)}">${escapeHtml(t.label)}</option>`));
    pitchMapTagFilter.innerHTML = tagOptions.join('');

    const playerOptions = [
      '<option value="__all__">All players</option>',
      '<option value="__none__">No player set</option>'
    ].concat(squad.map((p) => {
      const label = p.number ? `${p.number} ${p.name}` : p.name;
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    }));
    pitchMapPlayerFilter.innerHTML = playerOptions.join('');
  }

  function renderPitchMap() {
    const tagFilterValue = pitchMapTagFilter.value || '__all__';
    const playerFilterValue = pitchMapPlayerFilter.value || '__all__';
    const teamFilterValue = pitchMapTeamFilter.value || '__all__';

    // Only events with a USABLE location are drawn (finite numeric x/y —
    // the same rule the analytics engine's validation applies: malformed
    // locations are dropped, out-of-range ones are kept).
    let filtered = events.filter((ev) => ev.location &&
      typeof ev.location.x === 'number' && isFinite(ev.location.x) &&
      typeof ev.location.y === 'number' && isFinite(ev.location.y));
    if (tagFilterValue !== '__all__') {
      filtered = filtered.filter((ev) => ev.label === tagFilterValue);
    }
    if (playerFilterValue === '__none__') {
      filtered = filtered.filter((ev) => !ev.playerId);
    } else if (playerFilterValue !== '__all__') {
      filtered = filtered.filter((ev) => ev.playerId === playerFilterValue);
    }
    if (teamFilterValue !== '__all__') {
      // v3 team semantics — matches the analytics layer's vocabulary.
      filtered = filtered.filter((ev) => teamFilterValue === 'unattributed' ? !ev.team : ev.team === teamFilterValue);
    }

    const dots = filtered.map((ev) => {
      const color = eventDotColor(ev);
      const cx = (ev.location.x * 700).toFixed(1);
      const cy = (ev.location.y * 450).toFixed(1);
      return `<circle class="pitch-map-dot" cx="${cx}" cy="${cy}" r="7" style="fill:${color};" />`;
    }).join('');

    // SP-V6: optional 3×3 zone overlay — grid LINES only (no shading, no
    // counts); reuses the spatial section's fixed zone-line markup.
    pitchMapSvg.innerHTML = pitchMarkingsSvg() + (pitchMapShowZones ? ZONE_LINES_SVG : '') + dots;

    const seen = new Map();
    filtered.forEach((ev) => {
      const label = eventDotLegendLabel(ev);
      if (!seen.has(label)) seen.set(label, eventDotColor(ev));
    });

    if (seen.size > 1) {
      pitchMapLegend.innerHTML = Array.from(seen.entries())
        .map(([label, color]) => `<span class="legend-item"><span class="legend-dot" style="background:${color};"></span>${escapeHtml(label)}</span>`)
        .join('');
      pitchMapLegend.style.display = 'flex';
    } else {
      pitchMapLegend.innerHTML = '';
      pitchMapLegend.style.display = 'none';
    }

    const totalLocated = events.filter((ev) => ev.location).length;
    pitchMapCount.textContent = totalLocated === 0
      ? 'No events have a location set yet — click the pitch in any tag\'s detail panel to add one.'
      : `Showing ${filtered.length} of ${totalLocated} located event${totalLocated === 1 ? '' : 's'}.`;
  }

  function openPitchMapModal() {
    populatePitchMapFilters();
    pitchMapTagFilter.value = '__all__';
    pitchMapPlayerFilter.value = '__all__';
    pitchMapTeamFilter.value = '__all__';
    renderPitchMap();
    pitchMapModal.style.display = 'flex';
  }

  function closePitchMapModal() {
    pitchMapModal.style.display = 'none';
  }

  btnPitchMap.addEventListener('click', openPitchMapModal);
  btnClosePitchMap.addEventListener('click', closePitchMapModal);
  pitchMapTagFilter.addEventListener('change', renderPitchMap);
  pitchMapPlayerFilter.addEventListener('change', renderPitchMap);
  pitchMapTeamFilter.addEventListener('change', renderPitchMap);

  // SP-V6 zone overlay toggle (lines only — never shading or counts).
  let pitchMapShowZones = false;
  if (pitchMapZonesToggle) {
    pitchMapZonesToggle.addEventListener('click', () => {
      pitchMapShowZones = !pitchMapShowZones;
      pitchMapZonesToggle.textContent = pitchMapShowZones ? '3×3 zones: on' : '3×3 zones: off';
      pitchMapZonesToggle.classList.toggle('zones-on', pitchMapShowZones);
      renderPitchMap();
    });
  }

  function renderDetailPanel() {
    const tag = activeDetailTag;
    const ev = activeDetailEvent;

    const headerTime = ev.isInterval
      ? `${formatTimecode(ev.startTime, true)} → ${formatTimecode(ev.endTime, true)}`
      : formatTimecode(ev.time, true);

    let html = `
      <div class="detail-panel-header">
        <span class="detail-panel-title">${escapeHtml(tag.label)} · ${headerTime}</span>
        <button id="detailPanelDone" class="btn btn-ghost detail-panel-close">Done</button>
      </div>
      <div class="detail-panel-body">
        <div class="detail-group">
          <span class="detail-group-label">${ev.isInterval ? 'Start / End' : 'Timestamp'}</span>
          ${ev.isInterval ? intervalTimingControlsMarkup(ev) : timingControlsMarkup(ev)}
        </div>
        <div class="detail-group">
          <span class="detail-group-label">Side</span>
          ${sideSectionMarkup(ev)}
        </div>
    `;

    if (tag.substitution) {
      html += `
        <div class="detail-group">
          <span class="detail-group-label">Player off</span>
          ${squadChipsMarkup(ev, 'playerOff', 'playerOffId')}
        </div>
        <div class="detail-group">
          <span class="detail-group-label">Player on</span>
          ${squadChipsMarkup(ev, 'playerOn', 'playerOnId')}
        </div>
      `;
    } else {
      html += `
        <div class="detail-group">
          <span class="detail-group-label">Player</span>
          ${playerSectionMarkup(ev)}
        </div>
      `;
    }

    if (tag.subtypes && tag.subtypes.length) {
      html += `<div class="detail-group"><span class="detail-group-label">Type</span><div class="detail-chips">`;
      tag.subtypes.forEach((opt) => {
        const selected = ev.subtype === opt ? ' selected' : '';
        html += `<button class="chip${selected}" data-kind="subtype" data-value="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`;
      });
      html += `</div></div>`;
    }

    (tag.qualifierGroups || []).forEach((group) => {
      html += `<div class="detail-group"><span class="detail-group-label">${escapeHtml(group.name)}</span><div class="detail-chips">`;
      group.options.forEach((opt) => {
        const selected = ev.qualifiers[group.name] === opt ? ' selected' : '';
        html += `<button class="chip${selected}" data-kind="qualifier" data-group="${escapeHtml(group.name)}" data-value="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`;
      });
      html += `</div></div>`;
    });

    html += `<div class="detail-group"><span class="detail-group-label">Location</span>${pitchSvgMarkup(ev)}</div>`;

    html += `</div>`;
    detailPanel.innerHTML = html;

    detailPanel.querySelectorAll('.chip:not(.pitch-clear-btn)').forEach((chip) => {
      chip.addEventListener('click', () => {
        const kind = chip.dataset.kind;
        if (kind === 'player' || kind === 'playerOff' || kind === 'playerOn') {
          // v2: store playerId (string) instead of a snapshot object.
          // The field name is kind + 'Id' (e.g. 'playerId', 'playerOffId', 'playerOnId').
          const playerId = chip.dataset.playerId;
          const fieldName = kind + 'Id';
          const alreadySelected = ev[fieldName] === playerId;
          ev[fieldName] = alreadySelected ? null : playerId;
        } else if (kind === 'side') {
          const value = chip.dataset.value;
          ev.side = (ev.side === value) ? null : value;
        } else if (kind === 'subtype') {
          const value = chip.dataset.value;
          ev.subtype = (ev.subtype === value) ? null : value;
        } else {
          const value = chip.dataset.value;
          const group = chip.dataset.group;
          ev.qualifiers[group] = (ev.qualifiers[group] === value) ? null : value;
        }
        renderDetailPanel();
        renderEventList();
        markAutosaveDirty();
      });
    });

    detailPanel.querySelectorAll('.timing-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = parseFloat(btn.dataset.nudge);
        const bound = btn.dataset.bound;
        const max = isFinite(getDuration()) ? getDuration() : Infinity;

        if (ev.isInterval && bound === 'start') {
          ev.startTime = Math.min(ev.endTime, Math.max(0, ev.startTime + delta));
          ev.time = ev.startTime;
        } else if (ev.isInterval && bound === 'end') {
          ev.endTime = Math.max(ev.startTime, Math.min(max, ev.endTime + delta));
        } else {
          ev.time = Math.min(max, Math.max(0, ev.time + delta));
        }
        events.sort((a, b) => a.time - b.time);
        renderDetailPanel();
        renderEventList();
        markAutosaveDirty();
      });
    });

    const setPlayheadBtn = detailPanel.querySelector('#setToPlayhead');
    if (setPlayheadBtn) {
      setPlayheadBtn.addEventListener('click', () => {
        ev.time = getCurrentTime();
        events.sort((a, b) => a.time - b.time);
        renderDetailPanel();
        renderEventList();
        markAutosaveDirty();
      });
    }

    const setStartPlayheadBtn = detailPanel.querySelector('#setStartPlayhead');
    if (setStartPlayheadBtn) {
      setStartPlayheadBtn.addEventListener('click', () => {
        ev.startTime = Math.min(getCurrentTime(), ev.endTime);
        ev.time = ev.startTime;
        events.sort((a, b) => a.time - b.time);
        renderDetailPanel();
        renderEventList();
        markAutosaveDirty();
      });
    }

    const setEndPlayheadBtn = detailPanel.querySelector('#setEndPlayhead');
    if (setEndPlayheadBtn) {
      setEndPlayheadBtn.addEventListener('click', () => {
        ev.endTime = Math.max(getCurrentTime(), ev.startTime);
        renderDetailPanel();
        renderEventList();
        markAutosaveDirty();
      });
    }

    const pitchSvg = detailPanel.querySelector('#pitchSvg');
    if (pitchSvg) {
      pitchSvg.addEventListener('click', (e) => {
        const rect = pitchSvg.getBoundingClientRect();
        ev.location = {
          x: clamp01((e.clientX - rect.left) / rect.width),
          y: clamp01((e.clientY - rect.top) / rect.height)
        };
        renderDetailPanel();
        renderEventList();
        markAutosaveDirty();
      });
    }

    const clearBtn = detailPanel.querySelector('#clearLocation');
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ev.location = null;
        renderDetailPanel();
        renderEventList();
        markAutosaveDirty();
      });
    }

    document.getElementById('detailPanelDone').addEventListener('click', closeDetailPanel);
  }

  // ---------- Add custom tag (modal) ----------

  function openAddTagModal() {
    newTagName.value = '';
    newTagKey.value = '';
    newTagSubtypes.value = '';
    newTagQualifiers.value = '';
    newTagIsInterval.checked = false;
    addTagModal.style.display = 'flex';
    newTagName.focus();
  }

  function closeAddTagModal() {
    addTagModal.style.display = 'none';
  }

  function parseQualifiersText(text) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) return null;
        const name = line.slice(0, colonIndex).trim();
        const options = line.slice(colonIndex + 1).split(',').map((s) => s.trim()).filter(Boolean);
        if (!name || options.length === 0) return null;
        return { name, options };
      })
      .filter(Boolean);
  }

  btnAddCustom.addEventListener('click', openAddTagModal);
  btnCancelAddTag.addEventListener('click', closeAddTagModal);

  btnConfirmAddTag.addEventListener('click', () => {
    const label = newTagName.value.trim();
    if (!label) return;

    const subtypes = newTagSubtypes.value.split(',').map((s) => s.trim()).filter(Boolean);
    const qualifierGroups = parseQualifiersText(newTagQualifiers.value);

    let key = newTagKey.value.trim();
    const usedKeys = new Set(tags.map((t) => t.key));
    if (!key || usedKeys.has(key)) {
      key = '';
      for (let i = 0; i <= 9; i++) {
        if (!usedKeys.has(String(i))) { key = String(i); break; }
      }
    }

    const newTag = { label, key };
    if (subtypes.length) newTag.subtypes = subtypes;
    if (qualifierGroups.length) newTag.qualifierGroups = qualifierGroups;
    if (newTagIsInterval.checked) newTag.interval = true;

    tags.push(newTag);
    renderTagButtons();
    populateEventTypeFilter();
    closeAddTagModal();
    markAutosaveDirty();
  });

  // Keyboard shortcuts: number keys tag, spacebar toggles play/pause, Escape closes overlays.
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') { closeAddTagModal(); closeClipExportModal(); closeSquadModal(); closePitchMapModal(); closeMatchSetupModal(); closeSeasonModal(); }
      return;
    }

    if (e.key === 'Escape') {
      closeDetailPanel();
      closeAddTagModal();
      closeClipExportModal();
      closeSquadModal();
      closePitchMapModal();
      closeMatchSetupModal();
      closeSeasonModal();
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLastTag();
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      if (!btnPlayPause.disabled) btnPlayPause.click();
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!currentVideoPath) return;
      e.preventDefault();
      const step = e.shiftKey ? 1 : 5;
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const max = isFinite(getDuration()) ? getDuration() : Infinity;
      seekTo(Math.min(max, Math.max(0, getCurrentTime() + dir * step)));
      return;
    }

    const tag = tags.find((t) => t.key === e.key);
    if (tag) handleTagPress(tag);
  });

  // ---------- Event list ----------

  function eventDetailText(ev) {
    const parts = [];
    const playerOffId = ev.playerOffId;
    const playerOnId = ev.playerOnId;
    const playerId = ev.playerId;

    if (playerOffId || playerOnId) {
      const offPlayer = resolvePlayer(playerOffId);
      const onPlayer = resolvePlayer(playerOnId);
      const off = offPlayer ? (offPlayer.number ? `#${offPlayer.number} ${offPlayer.name}` : offPlayer.name) : (playerOffId ? 'Unknown player' : '?');
      const on = onPlayer ? (onPlayer.number ? `#${onPlayer.number} ${onPlayer.name}` : onPlayer.name) : (playerOnId ? 'Unknown player' : '?');
      parts.push(`${off} → ${on}`);
    } else if (playerId) {
      const player = resolvePlayer(playerId);
      if (player) {
        parts.push(player.number ? `#${player.number} ${player.name}` : player.name);
      } else {
        parts.push('Unknown player');
      }
    }
    if (ev.subtype) parts.push(ev.subtype);
    Object.values(ev.qualifiers || {}).forEach((v) => { if (v) parts.push(v); });
    if (ev.location) parts.push(`📍 ${locationZone(ev.location.x, ev.location.y)}`);
    return parts.join(' · ');
  }

  // ---------- Event log filtering ----------

  let eventSearchTerm = '';
  let eventTypeFilterValue = '__all__';

  function populateEventTypeFilter() {
    const currentValue = eventTypeFilter.value || '__all__';
    const options = ['<option value="__all__">All types</option>']
      .concat(tags.map((t) => `<option value="${escapeHtml(t.label)}">${escapeHtml(t.label)}</option>`));
    eventTypeFilter.innerHTML = options.join('');
    eventTypeFilter.value = currentValue;
    if (eventTypeFilter.value !== currentValue) {
      // the previously selected type no longer exists (e.g. after loading a
      // different session) - fall back to showing everything rather than a
      // filter silently pointing at nothing
      eventTypeFilter.value = '__all__';
      eventTypeFilterValue = '__all__';
    }
  }

  function matchesEventFilters(ev) {
    if (eventTypeFilterValue !== '__all__' && ev.label !== eventTypeFilterValue) return false;
    if (eventSearchTerm) {
      const haystack = [ev.label, eventDetailText(ev), ev.side || ''].join(' ').toLowerCase();
      if (!haystack.includes(eventSearchTerm.toLowerCase())) return false;
    }
    return true;
  }

  eventSearchInput.addEventListener('input', () => {
    eventSearchTerm = eventSearchInput.value;
    renderEventList();
  });

  eventTypeFilter.addEventListener('change', () => {
    eventTypeFilterValue = eventTypeFilter.value;
    renderEventList();
  });

  function renderEventList() {
    eventCountEl.textContent = String(events.length);

    if (events.length === 0) {
      eventListEl.innerHTML = '<div class="event-empty">No events tagged yet. Load a video and tap a tag button to start.</div>';
      eventFilterCountEl.textContent = '';
      renderStatsPanel();
      renderTimelineStrip();
      return;
    }

    const filteredEvents = events.filter(matchesEventFilters);
    const filterActive = eventSearchTerm !== '' || eventTypeFilterValue !== '__all__';
    eventFilterCountEl.textContent = filterActive
      ? `Showing ${filteredEvents.length} of ${events.length}.`
      : '';

    if (filteredEvents.length === 0) {
      eventListEl.innerHTML = '<div class="event-empty">No events match your search or filter.</div>';
      renderStatsPanel();
      renderTimelineStrip();
      return;
    }

    eventListEl.innerHTML = '';
    filteredEvents.forEach((ev) => {
      const tagDef = tags.find((t) => t.label === ev.label) || { label: ev.label };
      const detailText = eventDetailText(ev);
      const timeDisplay = ev.isInterval
        ? `${formatTimecode(ev.startTime, true)} → ${formatTimecode(ev.endTime, true)}`
        : formatTimecode(ev.time, true);

      const row = document.createElement('div');
      row.className = 'event-row' + (ev.side ? ` event-row-${ev.side}` : '');
      row.innerHTML = `
        <span class="event-time">${timeDisplay}</span>
        <span class="event-label">
          ${escapeHtml(ev.label)}
          ${detailText ? `<span class="event-detail">${escapeHtml(detailText)}</span>` : ''}
        </span>
        <button class="event-edit" title="Edit details">✎</button>
        <button class="event-delete" title="Delete event">✕</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('event-delete') || e.target.classList.contains('event-edit')) return;
        seekTo(ev.time);
      });
      row.querySelector('.event-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        openDetailPanel(tagDef, ev);
      });
      row.querySelector('.event-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        const deleted = ev;
        events = events.filter((x) => x.id !== ev.id);
        if (ev.id === lastLoggedEventId) lastLoggedEventId = null;
        // F3 fix: deleting a goal (possibly with events logged after it) must
        // also revert/correct the live score — same shared correction as undo.
        applyGoalRemovalScoreCorrection(deleted);
        updateUndoButton();
        renderEventList();
        markAutosaveDirty();
      });
      eventListEl.appendChild(row);
    });

    renderStatsPanel();
    renderTimelineStrip();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Live stats ----------

  function computeStatsFor(eventsList) {
    const byType = new Map(); // label -> { count, subtypeCounts, qualifierCounts }
    const bySide = { for: 0, against: 0, neutral: 0 };
    const byPlayer = new Map(); // playerId -> { player, count }

    eventsList.forEach((ev) => {
      if (!byType.has(ev.label)) {
        byType.set(ev.label, { count: 0, subtypeCounts: new Map(), qualifierCounts: new Map() });
      }
      const typeStats = byType.get(ev.label);
      typeStats.count++;

      if (ev.subtype) {
        typeStats.subtypeCounts.set(ev.subtype, (typeStats.subtypeCounts.get(ev.subtype) || 0) + 1);
      }

      Object.entries(ev.qualifiers || {}).forEach(([group, value]) => {
        if (!value) return;
        if (!typeStats.qualifierCounts.has(group)) typeStats.qualifierCounts.set(group, new Map());
        const groupMap = typeStats.qualifierCounts.get(group);
        groupMap.set(value, (groupMap.get(value) || 0) + 1);
      });

      if (ev.side) bySide[ev.side] = (bySide[ev.side] || 0) + 1;

      // v2: events store playerId/playerOffId/playerOnId (strings), not
      // snapshot objects. Resolve to the current squad entry for display.
      // If the player doesn't exist in the squad, use a fallback object
      // so the stats still aggregate correctly by ID.
      const involvedIds = [ev.playerId, ev.playerOffId, ev.playerOnId].filter(Boolean);
      involvedIds.forEach((pid) => {
        if (!byPlayer.has(pid)) {
          const player = resolvePlayer(pid) || { id: pid, number: '', name: 'Unknown player' };
          byPlayer.set(pid, { player, count: 0 });
        }
        byPlayer.get(pid).count++;
      });
    });

    return { byType, bySide, byPlayer };
  }

  function computeStats() {
    return computeStatsFor(events);
  }

  function buildStatsHtml({ byType, bySide, byPlayer }) {
    let html = '';

    html += '<div class="stats-section-label">By type</div><div class="stats-type-list">';
    const orderedLabels = tags.map((t) => t.label).filter((label) => byType.has(label));
    const extraLabels = Array.from(byType.keys()).filter((label) => !orderedLabels.includes(label));
    [...orderedLabels, ...extraLabels].forEach((label) => {
      const stat = byType.get(label);
      html += `
        <div class="stats-type-row">
          <span>${escapeHtml(label)}</span>
          <span class="stats-type-count">${stat.count}</span>
        </div>
      `;
      if (stat.subtypeCounts.size > 0) {
        const parts = Array.from(stat.subtypeCounts.entries()).map(([k, v]) => `${escapeHtml(k)} ${v}`);
        html += `<div class="stats-breakdown-line">${parts.join(' · ')}</div>`;
      }
      stat.qualifierCounts.forEach((groupMap, groupName) => {
        const total = Array.from(groupMap.values()).reduce((a, b) => a + b, 0);
        const parts = Array.from(groupMap.entries()).map(([val, count]) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          return `${escapeHtml(val)} ${count} (${pct}%)`;
        });
        html += `<div class="stats-breakdown-line"><span class="stats-breakdown-label">${escapeHtml(groupName)}:</span> ${parts.join(' · ')}</div>`;
      });
    });
    html += '</div>';

    const sideTotal = bySide.for + bySide.against + bySide.neutral;
    if (sideTotal > 0) {
      html += `
        <div class="stats-section-label">By side</div>
        <div class="stats-side-row">
          <span class="stats-side-chip stats-side-for">For ${bySide.for}</span>
          <span class="stats-side-chip stats-side-against">Against ${bySide.against}</span>
          <span class="stats-side-chip stats-side-neutral">Neutral ${bySide.neutral}</span>
        </div>
      `;
    }

    if (byPlayer.size > 0) {
      const sorted = Array.from(byPlayer.values()).sort((a, b) => b.count - a.count).slice(0, 8);
      html += '<div class="stats-section-label">Most involved players</div><div class="stats-player-list">';
      sorted.forEach(({ player, count }) => {
        const label = player.number ? `${player.number} ${player.name}` : player.name;
        html += `<div class="stats-player-row"><span>${escapeHtml(label)}</span><span class="stats-player-count">${count}</span></div>`;
      });
      html += '</div>';
    }

    return html;
  }

  function renderStatsPanel() {
    if (events.length === 0) {
      statsContentEl.innerHTML = '<div class="event-empty">No events tagged yet — stats will appear here once you start tagging.</div>';
      if (analyticsPanelEl.style.display !== 'none') renderAnalyticsPanel();
      return;
    }

    statsContentEl.innerHTML = buildStatsHtml(computeStats());
    if (analyticsPanelEl.style.display !== 'none') renderAnalyticsPanel();
  }

  // ---------- Match analytics (Analytics tab) ----------
  //
  // Renders the MATCH ANALYTICS OBJECT produced by src/analytics.js
  // (window.AnalyticsEngine.computeMatchAnalytics — a pure, deterministic
  // function of the current session). This is a READ-ONLY report: it never
  // mutates events, matchInfo, matchClock or squad, and it is recomputed
  // from scratch on every render (spec §12.6 idempotence).

  // ---------- Spatial section (SPATIAL & HEAT-MAP ENGINE V1) ----------
  //
  // Renders the spatial contract (A.spatial, src/analytics.js) through the
  // PURE view transform window.AnalyticsEngine.computeSpatialView(A, filters).
  // This layer ONLY renders — every count, share and duration comes from the
  // engine; no spatial statistic is computed in DOM code. Deterministic:
  // same session + same filters → byte-identical markup (no randomness, no
  // clock reads, fixed color steps). The section re-renders through the
  // existing renderStatsPanel → renderAnalyticsPanel live-refresh hook.
  //
  // Visualization rules (spec §5, SP-H): grid-based 3×3 counts only — NO
  // KDE, blur, interpolation, gradients, contours or smoothing. Color is
  // supplemental: the integer count is printed in every non-empty cell, full
  // numeric tables always accompany the visuals, and event dots mark the
  // ACTUAL recorded points. Below the minimum sample (6 located events,
  // display threshold only) no density surface is drawn at all.

  const spatialFilters = {
    scope: '__all__', team: '__all__', period: '__all__',
    state: '__all__', sequence: '__all__', player: '__all__'
  };
  let lastAnalytics = null;      // cached MATCH ANALYTICS OBJECT (spatial source)
  let lastSpatialView = null;    // cached view (cell traceability reads grid.events)
  const spatialTrace = { gridId: null, zoneKey: null };

  // Fixed deterministic density scale (spec §5.3): four crimson steps keyed
  // to the share of the grid's OWN maximum cell (comparability across grids
  // is via the printed numbers, not the colors — stated in the legend).
  const DENSITY_FILLS = [
    null,
    'rgba(216, 30, 46, 0.22)',
    'rgba(216, 30, 46, 0.42)',
    'rgba(216, 30, 46, 0.62)',
    'rgba(216, 30, 46, 0.82)'
  ];
  const DENSITY_LEGEND = ['≤ 25% of max', '26–50% of max', '51–75% of max', '76–100% of max'];

  function densityStep(count, maxCount) {
    if (!(count > 0) || !(maxCount > 0)) return 0;
    const s = count / maxCount;
    if (s <= 0.25) return 1;
    if (s <= 0.50) return 2;
    if (s <= 0.75) return 3;
    return 4;
  }

  // Display-only rounding (half-up, 1 decimal) — the engine keeps full
  // precision everywhere internally (spec §12.3).
  function anRound1(x) {
    return Math.round((x + Number.EPSILON) * 10) / 10;
  }

  // 3×3 zone grid lines at the exact third boundaries of the 0..700 × 0..450
  // viewBox (aligned with floor(x*3) / floor(y*3) binning and with the dot
  // coordinates, which use the same full-viewBox mapping as the pitch-map
  // modal and the detail-panel marker).
  const ZONE_LINES_SVG = ''
    + '<line x1="233.33" y1="0" x2="233.33" y2="450" class="an-zoneline"/>'
    + '<line x1="466.67" y1="0" x2="466.67" y2="450" class="an-zoneline"/>'
    + '<line x1="0" y1="150" x2="700" y2="150" class="an-zoneline"/>'
    + '<line x1="0" y1="300" x2="700" y2="300" class="an-zoneline"/>';

  const SHORT_ZONE_KEYS = ['Def·L', 'Def·C', 'Def·R', 'Mid·L', 'Mid·C', 'Mid·R', 'Att·L', 'Att·C', 'Att·R'];

  function spatialSquadNameMap() {
    const m = new Map();
    squad.forEach((p) => { m.set(p.id, p); });
    return m;
  }

  function spatialPlayerName(resolver, pid) {
    const p = resolver.get(pid);
    if (!p) return 'Unknown player';
    return p.number ? `${p.number} ${p.name}` : p.name;
  }

  // One located-event dot: the ACTUAL recorded point (full display
  // precision, no aggregation). Team-coloured; goals get a white ring.
  function spatialDotMarkup(rec, resolver) {
    const color = rec.team === 'our' ? '#d81e2e' : (rec.team === 'opponent' ? '#c8cdd2' : '#e8b93b');
    const cx = (rec.x * 700).toFixed(1);
    const cy = (rec.y * 450).toFixed(1);
    const pname = rec.playerId ? spatialPlayerName(resolver, rec.playerId) : null;
    const title = rec.label + (rec.subtype ? ' · ' + rec.subtype : '')
      + ' · ' + rec.minuteBin
      + (pname ? ' · ' + pname : '')
      + (rec.sequenceId ? ' · ' + rec.sequenceId : '');
    return `<circle class="an-dot${rec.isGoal ? ' an-dot-goal' : ''}" cx="${cx}" cy="${cy}" r="5.5" fill="${color}"><title>${escapeHtml(title)}</title></circle>`;
  }

  // Density grid SVG (spec §5.2 draw order): cell rects (fills; clickable
  // for traceability) → zone lines → pitch markings → event dots → cell
  // counts. Cells with 0 events get no fill and no count. When
  // `opts.insufficient` is true (fewer than minSampleForDensity located
  // events) NO fills and NO counts are drawn — only markings, lines and the
  // actual dots; a message states the reason (never a manufactured surface).
  function buildSpatialGridSvg(g, opts) {
    const cells = g.cells;
    const resolver = opts.resolver;
    let maxCount = 0;
    cells.forEach((c) => { if (c.counts.events > maxCount) maxCount = c.counts.events; });
    let s = `<svg class="an-grid-svg" viewBox="0 0 700 450" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(g.id)} — tagged event density (3×3)">`;
    for (let ti = 0; ti < 3; ti++) {
      for (let ci = 0; ci < 3; ci++) {
        const c = cells[ti * 3 + ci];
        const n = c.counts.events;
        const step = opts.insufficient ? 0 : densityStep(n, maxCount);
        const x = (ti * 700 / 3).toFixed(2);
        const y = (ci * 450 / 3).toFixed(2);
        const w = (700 / 3).toFixed(2);
        const h = (450 / 3).toFixed(2);
        const fill = step ? ` style="fill:${DENSITY_FILLS[step]};"` : '';
        const attrs = opts.clickable === false
          ? ''
          : ` data-grid="${escapeHtml(g.id)}" data-zone="${escapeHtml(c.zoneKey)}" tabindex="0" role="img" aria-label="${escapeHtml(c.zoneKey)}: ${n} tagged events"`;
        s += `<rect class="an-zcell" x="${x}" y="${y}" width="${w}" height="${h}"${fill}${attrs}/>`;
      }
    }
    s += ZONE_LINES_SVG;
    s += pitchMarkingsSvg();
    (g.events || []).forEach((rec) => { s += spatialDotMarkup(rec, resolver); });
    if (!opts.insufficient && opts.showCounts !== false) {
      for (let ti = 0; ti < 3; ti++) {
        for (let ci = 0; ci < 3; ci++) {
          const c = cells[ti * 3 + ci];
          if (c.counts.events === 0) continue;
          const cx = (ti * 700 / 3 + 700 / 6).toFixed(2);
          const cy = (ci * 450 / 3 + 450 / 6).toFixed(2);
          s += `<text class="an-zcount" x="${cx}" y="${cy}">${c.counts.events}</text>`;
        }
      }
    }
    s += '</svg>';
    return s;
  }

  function gridMaxCount(g) {
    let maxCount = 0;
    g.cells.forEach((c) => { if (c.counts.events > maxCount) maxCount = c.counts.events; });
    return maxCount;
  }

  // Traceability rows: the located events of one zone cell (read-only).
  function buildTraceRows(g, zoneKey, resolver) {
    const recs = (g.events || []).filter((r) => r.zoneKey === zoneKey);
    let html = `<div class="an-trace-title">${escapeHtml(zoneKey)} — ${recs.length} located event${recs.length === 1 ? '' : 's'}</div>`;
    recs.forEach((r) => {
      const pname = r.playerId ? spatialPlayerName(resolver, r.playerId) : null;
      const teamLabel = r.team === 'our' ? 'Us' : (r.team === 'opponent' ? 'Opponent' : '—');
      html += '<div class="an-trace-row">'
        + `<span class="an-trace-bin">${escapeHtml(r.minuteBin)}</span>`
        + `<span class="an-trace-label">${escapeHtml(r.label)}${r.subtype ? ' · ' + escapeHtml(r.subtype) : ''}</span>`
        + `<span class="an-trace-player">${escapeHtml(pname || '—')}</span>`
        + `<span class="an-trace-team">${teamLabel}</span>`
        + `<span class="an-trace-id">#${r.eventId}</span>`
        + '</div>';
    });
    return html;
  }

  function buildSpatialGridBlock(g, minSample, resolver) {
    const insufficient = g.located < minSample;
    const share = g.locatedShare.value === null ? '—' : `${g.locatedShare.value}%`;
    let html = '<div class="an-grid-wrap">';
    html += `<div class="an-grid-head">${escapeHtml(g.scopeLabel)} — ${escapeHtml(g.partitionLabel)} · ${g.located}/${g.population} located events (${share})</div>`;
    html += buildSpatialGridSvg(g, { insufficient, resolver });
    if (insufficient) {
      html += `<div class="an-grid-insufficient">Insufficient tagged locations for spatial visualization. (${g.located} located event${g.located === 1 ? '' : 's'} in this view — see the table below)</div>`;
    } else {
      html += '<div class="an-sp-legend">'
        + DENSITY_FILLS.slice(1).map((fill, i) => `<span class="legend-item"><span class="legend-dot" style="background:${fill};"></span>${DENSITY_LEGEND[i]}</span>`).join('')
        + `<span class="an-sp-legend-max">max = ${gridMaxCount(g)} (busiest cell)</span>`
        + '</div>';
    }
    if (g.unlocated > 0) {
      const pct = g.population > 0 ? anRound1((g.unlocated / g.population) * 100) : null;
      html += `<div class="an-unloc-strip">Unlocated: ${g.unlocated}${pct !== null ? ` (${pct}% of selection)` : ''} — not shown on the pitch.</div>`;
    }
    html += `<div class="an-trace" data-trace-grid="${escapeHtml(g.id)}">`;
    if (spatialTrace.gridId === g.id && spatialTrace.zoneKey) {
      html += buildTraceRows(g, spatialTrace.zoneKey, resolver);
    } else {
      html += '<div class="an-trace-hint">Click a zone cell to list its located events.</div>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function buildSpatialFilterBar(A, view) {
    const F = view.filters;
    const SP = A.spatial;
    const playerSet = F.player !== '__all__';
    const opt = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    const wrap = (key, label, options, extra) =>
      `<label>${label} <select class="an-sp-filter" data-filter="${key}"${extra || ''}>${options.join('')}</select></label>`;

    const scopeOptions = [opt('__all__', 'All events', F.scope === '__all__')]
      .concat(SP.completeness.byLabel.map((row) => opt(row.label, row.label, F.scope === row.label)));
    const teamOptions = [opt('__all__', 'All teams (compare)', F.team === '__all__'),
      opt('our', 'Us', F.team === 'our'), opt('opponent', 'Opponent', F.team === 'opponent')];
    const periodOptions = [opt('__all__', 'All periods', F.period === '__all__')]
      .concat(['1H', '2H', 'ET1', 'ET2'].map((p) => opt(p, p, F.period === p)));
    const stateOptions = [opt('__all__', 'All states', F.state === '__all__'),
      opt('WINNING', 'Winning', F.state === 'WINNING'),
      opt('DRAW', 'Drawing', F.state === 'DRAW'),
      opt('LOSING', 'Losing', F.state === 'LOSING')];
    const seqOptions = [opt('__all__', 'All sequences', F.sequence === '__all__')]
      .concat(view.sequenceOptions.map((sq) => opt(sq, sq, F.sequence === sq)));
    const playerList = (A.players && Array.isArray(A.players.list)) ? A.players.list : [];
    const playerOptions = [opt('__all__', 'All players', F.player === '__all__')]
      .concat(playerList.map((p) => opt(p.playerId, p.number ? `${p.number} ${p.name}` : p.name, F.player === p.playerId)));

    let html = '<div class="an-sp-filters">';
    html += wrap('scope', 'Event', scopeOptions);
    html += wrap('team', 'Team', teamOptions,
      playerSet ? ' disabled title="A player selection overrides the team partition"' : '');
    html += wrap('period', 'Period', periodOptions);
    html += wrap('state', 'State', stateOptions,
      view.stateFilterSuppressed ? ' disabled title="Suppressed: score reconciliation MISMATCH (X1)"' : '');
    html += wrap('sequence', 'Sequence', seqOptions);
    html += wrap('player', 'Player', playerOptions);
    html += '</div>';
    return html;
  }

  const SP_TABLE_KEYS = ['events', 'goals', 'shots', 'chances', 'passes', 'turnovers'];
  const SP_TABLE_HEAD = ['Events', 'Goals', 'Shots', 'Chances', 'Passes', 'Turnovers'];

  function spatialCountsRow(label, counts) {
    return `<tr><td>${escapeHtml(label)}</td>` + SP_TABLE_KEYS.map((k) => `<td>${counts[k]}</td>`).join('') + '</tr>';
  }

  // Numeric tables (numbers-before-color, SP-H4): byZone (all 9 + Unlocated),
  // byThird / byChannel margins, and the full 19-key zone × metric matrix in
  // a horizontally scrollable container — all restricted to the current
  // selection, all values straight from the engine's view grids.
  function buildSpatialTables(A, view) {
    const T = view.tableGrid;
    let html = '';
    html += '<div class="stats-section-label">By zone (3×3 — current selection)</div>';
    html += '<table class="an-table"><thead><tr><th>Zone</th>' + SP_TABLE_HEAD.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    T.cells.forEach((c) => { html += spatialCountsRow(c.zoneKey, c.counts); });
    html += spatialCountsRow('Unlocated', T.unlocatedBucket.counts);
    html += '</tbody></table>';

    html += '<div class="stats-section-label">By third (3×3 margins — current selection)</div>';
    html += '<table class="an-table"><thead><tr><th>Third</th>' + SP_TABLE_HEAD.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    T.margins.byThird.forEach((m) => { html += spatialCountsRow(m.name, m.counts); });
    html += spatialCountsRow('Unlocated', T.unlocatedBucket.counts);
    html += '</tbody></table>';

    html += '<div class="stats-section-label">By channel (3×3 margins — current selection)</div>';
    html += '<table class="an-table"><thead><tr><th>Channel</th>' + SP_TABLE_HEAD.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    T.margins.byChannel.forEach((m) => { html += spatialCountsRow(m.name, m.counts); });
    html += spatialCountsRow('Unlocated', T.unlocatedBucket.counts);
    html += '</tbody></table>';

    const cellKeys = A.spatial.model.cellKeys;
    html += '<details class="an-fullmatrix"><summary>Full zone × metric table (all 19 bucket keys)</summary>';
    html += '<div class="an-table-scroll"><table class="an-table"><thead><tr><th>Metric</th>'
      + SHORT_ZONE_KEYS.map((z) => `<th>${z}</th>`).join('') + '<th>Unloc</th><th>Total</th></tr></thead><tbody>';
    cellKeys.forEach((k) => {
      let total = T.unlocatedBucket.counts[k];
      let row = `<tr><td>${escapeHtml(k)}</td>`;
      T.cells.forEach((c) => { row += `<td>${c.counts[k]}</td>`; total += c.counts[k]; });
      row += `<td>${T.unlocatedBucket.counts[k]}</td><td>${total}</td></tr>`;
      html += row;
    });
    html += '</tbody></table></div></details>';
    html += '<div class="an-poss-note">D/M/A = Defensive/Middle/Attacking third · L/C/R = Left/Central/Right channel · partition: all teams in the current selection.</div>';
    return html;
  }

  // Player spatial analysis: small multiples (top 12 by located count; the
  // located count is printed in every heading — numbers, not rates) plus the
  // full player × zone table.
  function buildSpatialPlayersHtml(view, minSample, resolver) {
    let html = '';
    html += '<div class="stats-section-label">Player spatial — Tagged Event Density (3×3, counts not rates)</div>';
    const PGS = view.playerGrids;
    if (PGS.length === 0) {
      html += '<div class="an-poss-note">No located player events in this selection.</div>';
      return html;
    }
    html += '<div class="an-player-grids">';
    PGS.slice(0, 12).forEach((g) => {
      html += `<div class="an-player-grid"><div class="an-player-head">${escapeHtml(g.partitionLabel)} · ${g.located} located</div>`;
      html += buildSpatialGridSvg(g, { insufficient: g.located < minSample, resolver, clickable: false, showCounts: false });
      html += '</div>';
    });
    html += '</div>';
    if (PGS.length > 12) html += `<div class="an-poss-note">Showing 12 of ${PGS.length} players — full counts in the table below.</div>`;
    html += '<div class="an-table-scroll"><table class="an-table"><thead><tr><th>Player</th>'
      + SHORT_ZONE_KEYS.map((z) => `<th>${z}</th>`).join('') + '<th>Unloc</th><th>Tot</th></tr></thead><tbody>';
    PGS.forEach((g) => {
      let tot = g.unlocatedBucket.counts.events;
      let row = `<tr><td>${escapeHtml(g.partitionLabel)}</td>`;
      g.cells.forEach((c) => { row += `<td>${c.counts.events}</td>`; tot += c.counts.events; });
      row += `<td>${g.unlocatedBucket.counts.events}</td><td>${tot}</td></tr>`;
      html += row;
    });
    html += '</tbody></table></div>';
    html += '<div class="an-poss-note">D/M/A = Defensive/Middle/Attacking third · L/C/R = Left/Central/Right channel. Sub events are not attributed to players spatially (playerOff/playerOn only).</div>';
    return html;
  }

  // Tagged Possession Duration by Zone (M-B10..13 × CT-ZONE under the full
  // M-L2-B4 constraint): UNROUNDED seconds summed by the engine; displayed
  // rounded to 1 decimal; NC-1 basis line always rendered; both team totals
  // reported; never "Possession %".
  function buildDurationGridSvg(P) {
    const cells = P.secondsExact.cells;
    let max = 0;
    cells.forEach((v) => { if (v > max) max = v; });
    let s = '<svg class="an-grid-svg" viewBox="0 0 700 450" preserveAspectRatio="xMidYMid meet" role="img" aria-label="tagged possession seconds by zone">';
    for (let ti = 0; ti < 3; ti++) {
      for (let ci = 0; ci < 3; ci++) {
        const v = cells[ti * 3 + ci];
        const step = densityStep(v, max);
        const x = (ti * 700 / 3).toFixed(2);
        const y = (ci * 450 / 3).toFixed(2);
        const w = (700 / 3).toFixed(2);
        const h = (450 / 3).toFixed(2);
        const fill = step ? ` style="fill:${DENSITY_FILLS[step]};"` : '';
        s += `<rect class="an-dcell" x="${x}" y="${y}" width="${w}" height="${h}"${fill}/>`;
      }
    }
    s += ZONE_LINES_SVG;
    s += pitchMarkingsSvg();
    for (let ti = 0; ti < 3; ti++) {
      for (let ci = 0; ci < 3; ci++) {
        const v = cells[ti * 3 + ci];
        if (!(v > 0)) continue;
        const cx = (ti * 700 / 3 + 700 / 6).toFixed(2);
        const cy = (ci * 450 / 3 + 450 / 6).toFixed(2);
        s += `<text class="an-dcount" x="${cx}" y="${cy}">${anRound1(v)}</text>`;
      }
    }
    s += '</svg>';
    return s;
  }

  function buildSpatialPossessionHtml(view, SP) {
    const D = view.possessionDurationByZone;
    let html = '';
    html += '<div class="stats-section-label">Tagged Possession Duration by Zone (recorded interval tags only)</div>';
    const hasIntervals = (D.our.locatedIntervals + D.our.unlocatedIntervals
      + D.opponent.locatedIntervals + D.opponent.unlocatedIntervals
      + D.unattributed.locatedIntervals + D.unattributed.unlocatedIntervals) > 0;
    if (!hasIntervals) {
      html += '<div class="an-poss-note">No tagged Possession intervals in this selection.</div>';
      return html;
    }
    html += `<div class="an-poss-note">${escapeHtml(D.basis)}.</div>`;
    html += `<div class="an-poss-limit">${escapeHtml(SP.limitations[1])}</div>`;
    [['our', 'Us'], ['opponent', 'Opponent']].forEach(([part, label]) => {
      const P = D[part];
      html += `<div class="an-grid-wrap"><div class="an-grid-head">${label} — tagged seconds by zone · ${P.locatedIntervals} located interval${P.locatedIntervals === 1 ? '' : 's'}</div>`;
      if (P.locatedIntervals > 0) {
        html += buildDurationGridSvg(P);
      } else {
        html += `<div class="an-grid-insufficient">No located Possession intervals for ${label.toLowerCase()} in this selection.</div>`;
      }
      html += `<div class="an-unloc-strip">Tagged total: ${anRound1(P.totalSecondsExact)}s${P.unlocatedIntervals > 0 ? ` · unlocated ${P.unlocatedIntervals} interval(s), ${anRound1(P.secondsExact.unlocated)}s not shown on the pitch` : ''}</div>`;
      html += '</div>';
    });
    const U = D.unattributed;
    if (U.locatedIntervals + U.unlocatedIntervals > 0) {
      html += `<div class="an-poss-note">Unattributed intervals: ${U.locatedIntervals + U.unlocatedIntervals} (${anRound1(U.totalSecondsExact)}s) — excluded from the team grids above.</div>`;
    }
    return html;
  }

  function buildSpatialHtml(A, view) {
    const SP = A.spatial;
    const C = view.completeness;
    const resolver = spatialSquadNameMap();
    const minSample = SP.params.minSampleForDensity;
    let html = '';

    // Completeness (unlocated events are reported, never discarded) + the
    // standing limitation and orientation notes.
    const shareTxt = C.locatedShare.value === null ? '—' : `${C.locatedShare.value}%`;
    html += `<div class="an-sp-summary">Total tagged events: ${C.total} · Located: ${C.located} (${shareTxt}) · Unlocated: ${C.unlocated}</div>`;
    html += `<div class="an-poss-limit">${escapeHtml(SP.limitations[0])}</div>`;
    html += `<div class="an-poss-note">${escapeHtml(SP.limitations[2])}</div>`;
    if (C.outOfRange > 0) {
      html += `<div class="an-poss-note">${C.outOfRange} located event(s) have coordinates outside [0,1] — clamped into the nearest zone for binning and flagged (SP-X1).</div>`;
    }

    // Spatial gates (advisories — displayed, never silently resolved).
    const X1 = SP.gates['SP-X1'];
    const x1Warn = X1.labelsBelowShare.length > 0 || X1.locationOutOfRange > 0 || X1.invalidLocation > 0;
    const X2 = SP.gates['SP-X2'];
    html += '<div class="an-gates">';
    html += `<div class="an-gate-row">SP-X1 location completeness: <span class="${x1Warn ? 'an-flag-warn' : 'an-flag-ok'}">${C.located}/${C.total} located (${shareTxt})</span>`
      + (X1.labelsBelowShare.length ? ` <span class="an-excl">(${X1.labelsBelowShare.map((l) => `${escapeHtml(l.label)} ${l.share}%`).join(', ')} below 50%)</span>` : '')
      + (X1.locationOutOfRange ? ` <span class="an-excl">· out-of-range ${X1.locationOutOfRange}</span>` : '')
      + (X1.invalidLocation ? ` <span class="an-excl">· invalid ${X1.invalidLocation}</span>` : '')
      + '</div>';
    html += `<div class="an-gate-row">SP-X2 foul Zone-qualifier vs location disagreements: ${X2.foulZoneQualifierMismatches}${X2.foulZoneQualifierMismatches > 0 ? ' <span class="an-excl">(independent claims — spatial metrics use location; reported, not resolved)</span>' : ''}</div>`;
    html += '</div>';

    // Filter bar + suppression/honesty notes.
    html += buildSpatialFilterBar(A, view);
    if (view.stateFilterSuppressed) {
      html += '<div class="an-poss-note">Score-state filter suppressed: score reconciliation MISMATCH (X1).</div>';
    }
    html += '<div class="an-poss-note">Phase filter: not available — the event model has no phase field; use Event / Team / Period / Score state / Sequence / Player.</div>';

    // Density grids (Us + Opponent comparison, or the focused selection).
    view.grids.forEach((g) => { html += buildSpatialGridBlock(g, minSample, resolver); });
    if (view.unattributedLocated > 0 && view.filters.team === '__all__' && view.filters.player === '__all__') {
      html += `<div class="an-poss-note">${view.unattributedLocated} located event(s) have no team attributed — included in the tables, not drawn as a team grid.</div>`;
    }

    // Numeric tables, player section, possession duration.
    html += buildSpatialTables(A, view);
    html += buildSpatialPlayersHtml(view, minSample, resolver);
    html += buildSpatialPossessionHtml(view, SP);
    return html;
  }

  function renderSpatialSection() {
    const el = document.getElementById('anSpatial');
    if (!el) return;
    if (!lastAnalytics || !window.AnalyticsEngine || typeof window.AnalyticsEngine.computeSpatialView !== 'function') {
      el.innerHTML = '<div class="event-empty">Spatial engine not available (src/analytics.js).</div>';
      lastSpatialView = null;
      return;
    }
    let view = null;
    try {
      view = window.AnalyticsEngine.computeSpatialView(lastAnalytics, spatialFilters);
    } catch (err) {
      el.innerHTML = `<div class="event-empty">Spatial engine error: ${escapeHtml(String(err && err.message || err))}</div>`;
      lastSpatialView = null;
      return;
    }
    if (!view) {
      el.innerHTML = '<div class="event-empty">Spatial data unavailable.</div>';
      lastSpatialView = null;
      return;
    }
    lastSpatialView = view;
    el.innerHTML = buildSpatialHtml(lastAnalytics, view);
  }

  function fmtEnv(env, suffix) {
    // Renders a metric result envelope { value, num?, den?, excluded? }.
    if (!env || env.value === null || env.value === undefined) return '—';
    let out = String(env.value);
    if (suffix) out += suffix;
    if (typeof env.num === 'number' && typeof env.den === 'number' && env.den > 0) {
      out += ` <span class="an-numden">(${env.num}/${env.den})</span>`;
    }
    const exKeys = env.excluded ? Object.keys(env.excluded).filter((k) => env.excluded[k] > 0) : [];
    if (exKeys.length) {
      out += ` <span class="an-excl">· excl. ${exKeys.map((k) => `${k} ${env.excluded[k]}`).join(', ')}</span>`;
    }
    return out;
  }

  function fmtPct(env) { return fmtEnv(env, '%'); }

  function fmtSecs(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') return `${v}s`;
    return String(v);
  }

  function anTeamRow(label, ourHtml, oppHtml) {
    return `<tr><td>${escapeHtml(label)}</td><td class="an-our">${ourHtml}</td><td class="an-opp">${oppHtml}</td></tr>`;
  }

  function buildAnalyticsHtml(A) {
    const S = A.matchSummary;
    const L1 = A.level1;
    const L2 = A.level2;
    let html = '';

    // --- Header: match + score reconciliation -----------------------------
    const metaParts = [];
    if (S.competition) metaParts.push(escapeHtml(S.competition));
    if (S.homeAway) metaParts.push(S.homeAway === 'home' ? 'Home' : S.homeAway === 'away' ? 'Away' : 'Neutral');
    if (S.opponent) metaParts.push(`vs ${escapeHtml(S.opponent)}`);
    if (S.date) metaParts.push(escapeHtml(S.date));
    if (S.formation) metaParts.push(escapeHtml(S.formation));
    html += `<div class="an-head">`;
    html += `<div class="an-title">Match analytics</div>`;
    html += `<div class="an-meta">${metaParts.length ? metaParts.join(' · ') : 'No match details set'}</div>`;
    const sc = S.score;
    html += `<div class="an-score">${sc.chain.for}–${sc.chain.against} <span class="an-numden">(goal chain, ${sc.chain.attributedGoals} attributed)</span></div>`;
    html += `</div>`;

    // --- Data quality gates (X-group) --------------------------------------
    const G = A.gates;
    const x1Cls = sc.reconciliation === 'MISMATCH' ? 'an-flag-bad' : (sc.reconciliation === 'MATCH' ? 'an-flag-ok' : 'an-flag-warn');
    const gateRows = [
      `X1 score reconciliation: <span class="${x1Cls}">${sc.reconciliation}</span>`
      + (sc.manual ? ` (manual ${sc.manual.for}–${sc.manual.against})` : ' (manual score not set)'),
      `X2 unattributed events: ${G.X2_unattributedEvents.total}`
      + (G.X2_unattributedEvents.total > 0 ? ` <span class="an-excl">(${Object.entries(G.X2_unattributedEvents.byLabel).map(([l, n]) => `${escapeHtml(l)} ${n}`).join(', ')})</span>` : ''),
      `X4 press consistency: ${G.X4_pressConsistency.our.flag || G.X4_pressConsistency.opponent.flag ? '<span class="an-flag-bad">FLAGGED (Press Wins &gt; Presses)</span>' : 'ok'}`,
      `X5 goal/shot co-tag: ${G.X5_goalShotCoTag.our.flag || G.X5_goalShotCoTag.opponent.flag ? '<span class="an-flag-bad">FLAGGED (Goals &gt; Shots)</span>' : 'ok'}`
    ];
    const x3bad = A.gates.X3_completeness.filter((c) => c.share !== null && c.share < 100);
    gateRows.push(`X3 completeness: ${x3bad.length === 0 ? 'all checked fields complete' : `${x3bad.length} field(s) incomplete`}`);
    const x6dup = G.X6_coTagAdvisory.sameLabel;
    gateRows.push(`X6 co-timing advisory: ${x6dup.length === 0 ? 'no same-label near-duplicates' : `<span class="an-flag-warn">${x6dup.map((d) => `${escapeHtml(d.label)} ×${d.count}`).join(', ')} within 5s — possible double-tags</span>`}`);
    const issues = A.validation.issues;
    gateRows.push(`Validation: ${issues.length === 0 ? 'clean' : `<span class="an-flag-warn">${issues.map((i) => `${escapeHtml(i.code)} ×${i.count}`).join(', ')}</span>`}`);
    html += '<div class="stats-section-label">Data quality gates</div>';
    html += `<div class="an-gates">${gateRows.map((g) => `<div class="an-gate-row">${g}</div>`).join('')}</div>`;

    // --- Match summary ------------------------------------------------------
    html += '<div class="stats-section-label">Match summary (tagged universe)</div>';
    html += '<table class="an-table"><tbody>';
    html += `<tr><td>Events used</td><td class="an-our">${S.totalEvents}</td><td class="an-opp">${S.inPlayEvents} in play · ${S.nonPlayEvents} non-play · ${S.unknownPeriodEvents} unknown period</td></tr>`;
    const stoppageTags = ['1H', '2H', 'ET1', 'ET2'].filter((p) => S.stoppageByPeriod[p]).map((p) => `${p}+`);
    html += `<tr><td>Stoppage events</td><td class="an-our">${S.stoppageEvents}</td><td class="an-opp">${stoppageTags.length ? escapeHtml(stoppageTags.join(', ')) : 'none flagged'}</td></tr>`;
    html += `<tr><td>Located events</td><td class="an-our">${S.locatedEvents}</td><td class="an-opp">${S.totalEvents - S.locatedEvents} unlocated</td></tr>`;
    html += `<tr><td>Periods played</td><td class="an-our">${S.periodsPlayed.length ? S.periodsPlayed.join(', ') : '—'}</td><td class="an-opp">nominal ${S.durationMinutes}′</td></tr>`;
    html += '</tbody></table>';

    // --- Team comparison (Level 1 + Level 2) -------------------------------
    html += '<div class="stats-section-label">Team comparison — Level 1 counts</div>';
    html += '<table class="an-table an-team"><thead><tr><th></th><th class="an-our">Us</th><th class="an-opp">Opponent</th></tr></thead><tbody>';
    const T1 = L1.team;
    const rows1 = [
      ['Goals', T1.our.goals.value, T1.opponent.goals.value],
      ['Shots', T1.our.shots.value, T1.opponent.shots.value],
      ['Shots on target', T1.our.shotsOnTarget.value, T1.opponent.shotsOnTarget.value],
      ['Shots off target', T1.our.shotsOffTarget.value, T1.opponent.shotsOffTarget.value],
      ['Blocked shots', T1.our.shotsBlocked.value, T1.opponent.shotsBlocked.value],
      ['Shots unknown outcome', T1.our.shotsUnknownOutcome.value, T1.opponent.shotsUnknownOutcome.value],
      ['Chances', T1.our.chances.value, T1.opponent.chances.value],
      ['Crosses', T1.our.crosses.value, T1.opponent.crosses.value],
      ['Corners', T1.our.corners.value, T1.opponent.corners.value],
      ['Fouls', T1.our.fouls.value, T1.opponent.fouls.value],
      ['Yellow cards', T1.our.yellowCards.value, T1.opponent.yellowCards.value],
      ['Red cards', T1.our.redCards.value, T1.opponent.redCards.value],
      ['Substitutions', T1.our.substitutions.value, T1.opponent.substitutions.value],
      ['Passes', T1.our.passes.value, T1.opponent.passes.value],
      ['Successful passes', T1.our.successfulPasses.value, T1.opponent.successfulPasses.value],
      ['Passes unknown outcome', T1.our.passesUnknownOutcome.value, T1.opponent.passesUnknownOutcome.value],
      ['Progressive / lateral / backward / long',
        `${T1.our.progressivePasses.value}/${T1.our.lateralPasses.value}/${T1.our.backwardPasses.value}/${T1.our.longPasses.value}`,
        `${T1.opponent.progressivePasses.value}/${T1.opponent.lateralPasses.value}/${T1.opponent.backwardPasses.value}/${T1.opponent.longPasses.value}`],
      ['Passes under pressure', T1.our.passesUnderPressure.value, T1.opponent.passesUnderPressure.value],
      ['Presses', T1.our.presses.value, T1.opponent.presses.value],
      ['Press wins', T1.our.pressWins.value, T1.opponent.pressWins.value],
      ['Interceptions', T1.our.interceptions.value, T1.opponent.interceptions.value],
      ['Recoveries', T1.our.recoveries.value, T1.opponent.recoveries.value],
      ['Turnovers', T1.our.turnovers.value, T1.opponent.turnovers.value],
      ['Duels', T1.our.duels.value, T1.opponent.duels.value],
      ['Positive transitions', T1.our.positiveTransitions.value, T1.opponent.positiveTransitions.value],
      ['Negative transitions', T1.our.negativeTransitions.value, T1.opponent.negativeTransitions.value],
      ['All events', T1.our.events.value, T1.opponent.events.value]
    ];
    rows1.forEach((r) => { html += anTeamRow(r[0], String(r[1]), String(r[2])); });
    if (T1.unattributed.events.value > 0) {
      html += `<tr class="an-unattr"><td>Unattributed (no team)</td><td colspan="2">${T1.unattributed.events.value} events — excluded from both columns above</td></tr>`;
    }
    html += '</tbody></table>';

    html += '<div class="stats-section-label">Team comparison — Level 2 derived</div>';
    html += '<table class="an-table an-team"><thead><tr><th></th><th class="an-our">Us</th><th class="an-opp">Opponent</th></tr></thead><tbody>';
    const D = L2.team;
    html += anTeamRow('Shot accuracy (on/(on+off))', fmtPct(D.our.shotAccuracy), fmtPct(D.opponent.shotAccuracy));
    html += anTeamRow('Shot conversion (goals/shots)', fmtPct(D.our.shotConversion), fmtPct(D.opponent.shotConversion));
    html += anTeamRow('Chance conversion (goals/chances)', fmtPct(D.our.chanceConversion), fmtPct(D.opponent.chanceConversion));
    html += anTeamRow('Pass success', fmtPct(D.our.passSuccess), fmtPct(D.opponent.passSuccess));
    html += anTeamRow('Pass success · under pressure', fmtPct(D.our.pressureSplitPassSuccess.underPressure), fmtPct(D.opponent.pressureSplitPassSuccess.underPressure));
    html += anTeamRow('Pass success · free', fmtPct(D.our.pressureSplitPassSuccess.free), fmtPct(D.opponent.pressureSplitPassSuccess.free));
    html += anTeamRow('Ball-winning events (rec+int)', String(D.our.ballWinningEvents.value), String(D.opponent.ballWinningEvents.value));
    html += anTeamRow('Press win ratio', fmtPct(D.our.pressWinRatio), fmtPct(D.opponent.pressWinRatio));
    const psO = D.our.passSubtypeProfile;
    const psP = D.opponent.passSubtypeProfile;
    html += anTeamRow('Pass subtype profile',
      Object.entries(psO.shares).map(([k, v]) => `${k} ${v === null ? '—' : v + '%'}`).join(' · ') + (psO.knownTotal ? '' : ' (no subtype-known passes)'),
      Object.entries(psP.shares).map(([k, v]) => `${k} ${v === null ? '—' : v + '%'}`).join(' · ') + (psP.knownTotal ? '' : ' (no subtype-known passes)'));
    html += anTeamRow('Per-90 (goals · shots · passes)',
      `${D.our.per90.goals.value} · ${D.our.per90.shots.value} · ${D.our.per90.passes.value}`,
      `${D.opponent.per90.goals.value} · ${D.opponent.per90.shots.value} · ${D.opponent.per90.passes.value}`);
    html += '</tbody></table>';

    // --- TAGGED POSSESSION block (explicitly named, limitation shown) ------
    const PO = L1.possession.our;
    const PP = L1.possession.opponent;
    const PU = L1.possession.unattributed;
    const share = D.our.taggedPossessionShare;
    const oppShare = D.opponent.taggedPossessionShare;
    html += '<div class="stats-section-label">Tagged possession (recorded intervals only)</div>';
    html += `<div class="an-poss-note">${escapeHtml(share.basis)}.</div>`;
    html += '<table class="an-table an-team"><thead><tr><th></th><th class="an-our">Us</th><th class="an-opp">Opponent</th></tr></thead><tbody>';
    html += anTeamRow('Tagged possession intervals', String(PO.intervals.value), String(PP.intervals.value));
    html += anTeamRow('Tagged possession duration', fmtSecs(PO.totalDuration.value), fmtSecs(PP.totalDuration.value));
    html += anTeamRow('Mean interval duration', fmtEnv(PO.meanDuration, 's'), fmtEnv(PP.meanDuration, 's'));
    const erRow = (dist) => Object.entries(dist.buckets).filter(([, n]) => n > 0).map(([k, n]) => `${escapeHtml(k)} ${n}`).join(' · ')
      + (dist.unknown > 0 ? ` · unknown ${dist.unknown}` : '');
    html += anTeamRow('Ended by', erRow(PO.endReasons) || '—', erRow(PP.endReasons) || '—');
    html += anTeamRow('Tagged Possession Share',
      share.value === null ? `<span class="an-flag-warn">—</span>` : `<strong>${share.value}%</strong>`,
      oppShare.value === null ? `<span class="an-flag-warn">—</span>` : `<strong>${oppShare.value}%</strong>`);
    html += '</tbody></table>';
    if (PU.intervals.value > 0) {
      html += `<div class="an-poss-note">${PU.intervals.value} possession interval(s) (${fmtSecs(PU.totalDuration.value)}) have no team attributed and are excluded from the share.</div>`;
    }
    html += `<div class="an-poss-limit">${escapeHtml(share.limitation)}</div>`;

    // --- Score state --------------------------------------------------------
    const SS = L2.scoreState;
    html += '<div class="stats-section-label">Score state (goal-chain based)</div>';
    if (SS.changes.value === null) {
      html += `<div class="an-poss-limit">Not computed — ${escapeHtml(SS.durationReason || SS.changes.reason || 'insufficient goal data')}.</div>`;
    } else {
      html += '<table class="an-table"><tbody>';
      html += `<tr><td>State changes</td><td class="an-our">${SS.changes.value}</td></tr>`;
      ['WINNING', 'DRAW', 'LOSING'].forEach((k) => {
        html += `<tr><td>Time ${k.toLowerCase()}</td><td class="an-our">${fmtSecs(SS.durationSeconds[k])}</td></tr>`;
      });
      html += '</tbody></table>';
    }

    // --- Transitions (linkage, τ reported) ----------------------------------
    const TR = L2.transitions;
    html += '<div class="stats-section-label">Transitions &amp; linkage (τ reported)</div>';
    html += '<table class="an-table"><tbody>';
    html += `<tr><td>Positive Transition → Shot (≤${TR.transitionToShot.params.tau}s)</td><td class="an-our">${fmtPct(TR.transitionToShot)}</td></tr>`;
    html += `<tr><td>Positive Transition → Chance (≤${TR.transitionToChance.params.tau}s)</td><td class="an-our">${fmtPct(TR.transitionToChance)}</td></tr>`;
    html += `<tr><td>Positive Transition → Goal (≤${TR.transitionToGoal.params.tau}s)</td><td class="an-our">${fmtPct(TR.transitionToGoal)}</td></tr>`;
    html += `<tr><td>Turnover → opponent Shot/Chance (≤${TR.turnoversFollowedByOpponentShotOrChance.params.tau}s)</td><td class="an-our">${fmtPct(TR.turnoversFollowedByOpponentShotOrChance)}</td></tr>`;
    html += '</tbody></table>';

    // --- Level 3 contexts ----------------------------------------------------
    const L3 = A.level3;
    html += '<div class="stats-section-label">By period (Level 3)</div>';
    html += '<table class="an-table"><thead><tr><th>Period</th><th>Events</th><th>Goals</th><th>Shots</th><th>Chances</th><th>Passes</th><th>Turnovers</th></tr></thead><tbody>';
    Object.entries(L3.byPeriod).forEach(([p, b]) => {
      if (b.counts.events === 0) return;
      html += `<tr><td>${escapeHtml(p)}${b.stoppage.events > 0 ? ` <span class="an-excl">(+${b.stoppage.events} stoppage)</span>` : ''}</td><td>${b.counts.events}</td><td>${b.counts.goals}</td><td>${b.counts.shots}</td><td>${b.counts.chances}</td><td>${b.counts.passes}</td><td>${b.counts.turnovers}</td></tr>`;
    });
    html += '</tbody></table>';

    html += '<div class="stats-section-label">By minute bin (period + match seconds)</div>';
    html += '<table class="an-table"><thead><tr><th>Bin</th><th>Events</th><th>Goals</th><th>Shots</th><th>Chances</th><th>Passes</th><th>Turnovers</th></tr></thead><tbody>';
    Object.entries(L3.byMinuteBin).forEach(([bin, b]) => {
      if (b.events === 0) return;
      html += `<tr><td>${escapeHtml(bin)}</td><td>${b.events}</td><td>${b.goals}</td><td>${b.shots}</td><td>${b.chances}</td><td>${b.passes}</td><td>${b.turnovers}</td></tr>`;
    });
    html += '</tbody></table>';

    html += '<div class="stats-section-label">By third (3×3 model)</div>';
    html += '<table class="an-table"><thead><tr><th>Third</th><th>Events</th><th>Goals</th><th>Shots</th><th>Chances</th><th>Passes</th><th>Turnovers</th></tr></thead><tbody>';
    Object.entries(L3.byThird).forEach(([t, b]) => {
      if (b.events === 0) return;
      html += `<tr><td>${escapeHtml(t)}</td><td>${b.events}</td><td>${b.goals}</td><td>${b.shots}</td><td>${b.chances}</td><td>${b.passes}</td><td>${b.turnovers}</td></tr>`;
    });
    html += '</tbody></table>';

    if (L3.byState) {
      html += '<div class="stats-section-label">By score state (before event)</div>';
      html += '<table class="an-table"><thead><tr><th>State</th><th>Events</th><th>Goals</th><th>Shots</th><th>Chances</th><th>Passes</th><th>Turnovers</th></tr></thead><tbody>';
      Object.entries(L3.byState).forEach(([st, b]) => {
        if (b.events === 0) return;
        html += `<tr><td>${escapeHtml(st)}</td><td>${b.events}</td><td>${b.goals}</td><td>${b.shots}</td><td>${b.chances}</td><td>${b.passes}</td><td>${b.turnovers}</td></tr>`;
      });
      html += '</tbody></table>';
    } else {
      html += `<div class="an-poss-limit">Score-state context suppressed: ${escapeHtml(L3.stateSuppressedReason)}.</div>`;
    }

    // --- Spatial (SPATIAL & HEAT-MAP ENGINE V1) -----------------------------
    // Placeholder — filled by renderSpatialSection() immediately after this
    // HTML is mounted (and re-filled on every filter change / live refresh).
    html += '<div class="stats-section-label">Spatial — Tagged Event Density (3×3)</div>';
    html += '<div id="anSpatial"></div>';

    // --- Players -------------------------------------------------------------
    html += '<div class="stats-section-label">Players (counts + ratios, no per-90)</div>';
    const PL = A.players;
    if (PL.list.length === 0) {
      html += '<div class="an-poss-note">No player-attributed events.</div>';
    } else {
      html += `<div class="an-poss-note">${escapeHtml(PL.note)}</div>`;
      html += '<table class="an-table"><thead><tr><th>Player</th><th>Events</th><th>Goals</th><th>Shots</th><th>Passes</th><th>Pass&nbsp;%</th><th>Presses</th><th>Turnovers</th><th>+ / −</th></tr></thead><tbody>';
      PL.list.forEach((p) => {
        const label = p.number ? `${escapeHtml(p.number)} ${escapeHtml(p.name)}` : escapeHtml(p.name);
        html += `<tr><td>${label}${p.appearance ? '' : ' <span class="an-excl">(no appearance)</span>'}</td><td>${p.metrics.events}</td><td>${p.metrics.goals}</td><td>${p.metrics.shots}</td><td>${p.metrics.passes}</td><td>${p.metrics.passSuccess.value === null ? '—' : p.metrics.passSuccess.value + '%'}</td><td>${p.metrics.presses}</td><td>${p.metrics.turnovers}</td><td>${p.metrics.positiveEvents} / ${p.metrics.negativeEvents}</td></tr>`;
      });
      html += '</tbody></table>';
      if (PL.unattributed.events > 0) {
        html += `<div class="an-poss-note">${PL.unattributed.events} events have no player attributed${PL.unattributed.byLabel && Object.keys(PL.unattributed.byLabel).length ? ` (${Object.entries(PL.unattributed.byLabel).map(([l, n]) => `${escapeHtml(l)} ${n}`).join(', ')})` : ''}.</div>`;
      }
    }

    // --- Sequences ------------------------------------------------------------
    const SQ = A.sequences;
    if (SQ.total > 0) {
      html += '<div class="stats-section-label">Sequences (SEQ)</div>';
      html += '<table class="an-table"><tbody>';
      html += `<tr><td>Sequences</td><td class="an-our">${SQ.total}</td><td class="an-opp">${SQ.withTransition} contain a transition marker</td></tr>`;
      html += `<tr><td>Mean events / duration</td><td class="an-our">${SQ.meanEventCount === null ? '—' : SQ.meanEventCount}</td><td class="an-opp">${SQ.meanDurationSeconds === null ? '—' : SQ.meanDurationSeconds + 's'} <span class="an-excl">(${SQ.spanningCount} span periods, excluded from mean)</span></td></tr>`;
      html += '</tbody></table>';
    }

    // --- Protocol notes ---------------------------------------------------------
    html += '<div class="stats-section-label">Method notes</div>';
    html += `<div class="an-protocol">${A.protocol.notes.map((n) => `• ${escapeHtml(n)}`).join('<br>')}</div>`;
    html += `<div class="an-engine">${escapeHtml(A.spec)} · engine v${escapeHtml(A.engine.version)} · deterministic</div>`;

    return html;
  }

  function renderAnalyticsPanel() {
    if (!window.AnalyticsEngine || typeof window.AnalyticsEngine.computeMatchAnalytics !== 'function') {
      analyticsContentEl.innerHTML = '<div class="event-empty">Analytics engine not loaded (src/analytics.js).</div>';
      return;
    }
    if (events.length === 0) {
      analyticsContentEl.innerHTML = '<div class="event-empty">No events tagged yet — the match analytics report will appear here once you start tagging.</div>';
      return;
    }
    let A;
    try {
      A = window.AnalyticsEngine.computeMatchAnalytics({
        events: events,
        matchInfo: matchInfo,
        matchClock: matchClock,
        squad: squad,
        tags: tags
      });
    } catch (err) {
      analyticsContentEl.innerHTML = `<div class="event-empty">Analytics engine error: ${escapeHtml(String(err && err.message || err))}</div>`;
      return;
    }
    analyticsContentEl.innerHTML = buildAnalyticsHtml(A);
    lastAnalytics = A;   // cached for the spatial section (filter re-renders)
    renderSpatialSection();
  }

  function setEventsTab(tab) {
    // tab: 'events' | 'stats' | 'analytics'
    // Filter bar visibility is intentionally untouched (the pre-existing
    // events/stats switching never toggled it either).
    const active = { events: tab === 'events', stats: tab === 'stats', analytics: tab === 'analytics' };
    tabEvents.classList.toggle('active', active.events);
    tabStats.classList.toggle('active', active.stats);
    tabAnalytics.classList.toggle('active', active.analytics);
    eventListEl.style.display = active.events ? 'block' : 'none';
    statsPanelEl.style.display = active.stats ? 'block' : 'none';
    analyticsPanelEl.style.display = active.analytics ? 'block' : 'none';
    if (active.analytics) renderAnalyticsPanel();
  }

  tabEvents.addEventListener('click', () => setEventsTab('events'));
  tabStats.addEventListener('click', () => setEventsTab('stats'));
  tabAnalytics.addEventListener('click', () => setEventsTab('analytics'));

  // Spatial section interactions (event delegation on the analytics panel —
  // the section re-renders on every filter change / live refresh, so
  // per-element listeners would be lost; delegation survives re-renders).
  function spatialCellActivate(t) {
    const gridId = t.getAttribute('data-grid');
    const zoneKey = t.getAttribute('data-zone');
    if (!gridId || !zoneKey) return;
    if (spatialTrace.gridId === gridId && spatialTrace.zoneKey === zoneKey) {
      spatialTrace.gridId = null;   // clicking the open cell again closes it
      spatialTrace.zoneKey = null;
    } else {
      spatialTrace.gridId = gridId;
      spatialTrace.zoneKey = zoneKey;
    }
    renderSpatialSection();
  }

  analyticsContentEl.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const cls = t.getAttribute('class') || '';
    if (cls.indexOf('an-sp-filter') === -1) return;
    const key = t.getAttribute('data-filter');
    if (!key || !(key in spatialFilters)) return;
    spatialFilters[key] = t.value;
    spatialTrace.gridId = null;   // population changed — close the open trace
    spatialTrace.zoneKey = null;
    renderSpatialSection();
  });

  analyticsContentEl.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const cls = t.getAttribute('class') || '';
    if (cls.indexOf('an-zcell') === -1) return;
    spatialCellActivate(t);
  });

  analyticsContentEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const cls = t.getAttribute('class') || '';
    if (cls.indexOf('an-zcell') === -1) return;
    e.preventDefault();
    spatialCellActivate(t);
  });

  // ---------- Season view (combine several saved sessions) ----------
  //
  // V1 migration point (Player & Season Data Engine): the season stats
  // section now consumes PlayerSeasonEngine.computeSeason() — the
  // deterministic player/season aggregation layer — instead of the legacy
  // combined-totals panel (computeStatsFor over the concatenated event
  // list). The legacy computation itself is untouched and still powers the
  // live Stats tab for the current session; it is no longer duplicated
  // here. Each loaded match keeps its OWN squad snapshot + matchClock +
  // __savedAt (needed by the engine: per-session identity resolution,
  // FT/minutes evidence, match identity) — the session files on disk are
  // never modified.

  let seasonMatches = []; // { id, sourceFile, savedAt, matchInfo, events, tags, squad, matchClock }
  let nextSeasonMatchId = 1;

  function seasonMatchLabel(m) {
    const info = m.matchInfo;
    const parts = [];
    if (info && info.opponent) parts.push(`vs ${info.opponent}`);
    if (info && info.homeAway) {
      parts.push(info.homeAway === 'home' ? 'Home' : info.homeAway === 'away' ? 'Away' : 'Neutral');
    }
    if (info && info.ourScore !== '' && info.ourScore != null && info.opponentScore !== '' && info.opponentScore != null) {
      parts.push(`${info.ourScore}–${info.opponentScore}`);
    }
    if (info && info.date) parts.push(info.date);
    return parts.length ? parts.join(' · ') : '(Match with no details set)';
  }

  function renderSeasonMatchList() {
    if (seasonMatches.length === 0) {
      seasonMatchListEl.innerHTML = '<div class="detail-empty-note" style="padding:10px;">No matches loaded yet — click "+ Add match session(s)" and pick one or more saved .json sessions.</div>';
      return;
    }
    seasonMatchListEl.innerHTML = seasonMatches.map((m) => `
      <div class="season-match-row" data-id="${m.id}">
        <span class="season-match-label">${escapeHtml(seasonMatchLabel(m))}</span>
        <span class="season-match-count">${m.events.length} event${m.events.length === 1 ? '' : 's'}</span>
        <button class="season-match-remove" title="Remove">✕</button>
      </div>
    `).join('');

    seasonMatchListEl.querySelectorAll('.season-match-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.season-match-row');
        const id = Number(row.dataset.id);
        seasonMatches = seasonMatches.filter((m) => m.id !== id);
        renderSeasonMatchList();
        renderSeasonStats();
      });
    });
  }

  // renderSeasonStats(): renders the Player & Season Data Engine output.
  // The engine is a pure consumer of the Analytics Engine; all core season
  // statistics are computed in src/player-season.js, never in this DOM code.
  // Recent Form (Phase C): the same PS output is consumed ONCE by the Recent
  // Form Engine (window.RecentFormEngine.computeRecentForm) and rendered as
  // an additional read-only section — no Recent Form figure is recalculated
  // here, and neither PS nor RF is ever mutated.
  function renderSeasonStats() {
    seasonRecentForm = null;
    if (seasonMatches.length === 0) {
      seasonStatsContentEl.innerHTML = '<div class="event-empty">Load one or more match sessions above to see combined totals.</div>';
      return;
    }
    if (!window.PlayerSeasonEngine || typeof window.PlayerSeasonEngine.computeSeason !== 'function') {
      seasonStatsContentEl.innerHTML = '<div class="event-empty">Season engine not loaded (src/player-season.js).</div>';
      return;
    }
    let PS;
    try {
      PS = window.PlayerSeasonEngine.computeSeason(seasonMatches);
    } catch (err) {
      seasonStatsContentEl.innerHTML = `<div class="event-empty">Season engine error: ${escapeHtml(String(err && err.message || err))}</div>`;
      return;
    }
    let rfError = null;
    if (window.RecentFormEngine && typeof window.RecentFormEngine.computeRecentForm === 'function') {
      try {
        seasonRecentForm = window.RecentFormEngine.computeRecentForm(PS, {});
      } catch (err) {
        seasonRecentForm = null;
        rfError = err;
      }
    }
    seasonStatsContentEl.innerHTML = buildSeasonDataHtml(PS) + buildRecentFormSectionHtml(rfError);
    wireRecentFormPlayerSelect();
    renderRecentFormPlayerDetail();
  }

  // buildSeasonDataHtml(PS): minimal verification UI for the Player & Season
  // Data Engine output (task Part 28 — deliberately NOT a full player
  // intelligence dashboard). Renders only; every statistic comes from the
  // engine. Column tags: [R] RECORDED (counted directly from tagged events),
  // [D] DERIVED (computed from recorded counts), [U] UNAVAILABLE (shown with
  // reason). A legend is printed with every table.
  function seasonQualityTag(q) {
    if (q === 'RELIABLE') return '<span class="sn-qual sn-qual-reliable">reliable</span>';
    if (q === 'MIXED') return '<span class="sn-qual sn-qual-mixed">mixed</span>';
    if (q === 'ESTIMATED') return '<span class="sn-qual sn-qual-estimated">estimated</span>';
    return '<span class="sn-qual sn-qual-unavailable">unavailable</span>';
  }

  function seasonNum(v) {
    return (v === null || v === undefined) ? '—' : String(v);
  }

  function seasonPct(env) {
    if (!env || env.value === null || env.value === undefined) return '—';
    return `${env.value}%`;
  }

  function buildSeasonDataHtml(PS) {
    const cov = PS.coverage;
    const T = PS.teamSeason;

    let html = '';

    // --- Coverage header (task Part 22) ---
    html += `
      <div class="sn-section-label">Season data — ${cov.uniqueMatches} match${cov.uniqueMatches === 1 ? '' : 'es'} (recorded)</div>
      <div class="sn-coverage">
        Matches in database: ${cov.sessionsLoaded} · Unique: ${cov.uniqueMatches} · Complete records: ${cov.completeMatchRecords} · Partial records: ${cov.partialMatchRecords}
        ${cov.duplicateSessionsExcluded > 0 ? ` · Duplicate sessions excluded: ${cov.duplicateSessionsExcluded}` : ''}
      </div>
      <div class="sn-legend">
        <span class="sn-legend-item"><b>[R]</b> RECORDED — counted directly from tagged events</span>
        <span class="sn-legend-item"><b>[D]</b> DERIVED — computed from recorded counts (ratios, averages, per-90, minutes)</span>
        <span class="sn-legend-item"><b>[U]/—</b> UNAVAILABLE — insufficient data (reason shown)</span>
      </div>
    `;

    // --- TEAM SEASON DATA ---
    const gk = (n) => seasonNum(n);
    html += `
      <div class="sn-section-label">Team season data</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Matches [R]</th><th>W</th><th>D</th><th>L</th><th>Goals for [R]</th><th>Goals against [R]</th><th>No result</th><th>Result flagged (X1)</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>${T.matches}</td><td>${T.wins}</td><td>${T.draws}</td><td>${T.losses}</td>
            <td>${gk(T.goalsFor)}</td><td>${gk(T.goalsAgainst)}</td>
            <td>${gk(T.noResultMatches)}</td><td>${gk(T.resultFlaggedMatches)}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <div class="sn-note">Match result (W/D/L) comes from the final score (manual entry when set, otherwise the attributed goal chain); score-state buckets below use each event's recorded score BEFORE the event. ${T.resultFlaggedMatches > 0 ? 'Some results are flagged: manual score disagrees with the goal chain (X1 MISMATCH) — shown, never silently resolved.' : ''}</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Tagged event totals [R]</th><th>Us</th><th>Opponent</th></tr>
        </thead>
        <tbody>
          ${[
            ['Events', T.totals.our.events, T.totals.opponent.events],
            ['Goals', T.totals.our.goals, T.totals.opponent.goals],
            ['Shots', T.totals.our.shots, T.totals.opponent.shots],
            ['Shots on target', T.totals.our.shotsOnTarget, T.totals.opponent.shotsOnTarget],
            ['Chances', T.totals.our.chances, T.totals.opponent.chances],
            ['Passes', T.totals.our.passes, T.totals.opponent.passes],
            ['Successful passes', T.totals.our.successfulPasses, T.totals.opponent.successfulPasses],
            ['Presses', T.totals.our.presses, T.totals.opponent.presses],
            ['Press wins', T.totals.our.pressWins, T.totals.opponent.pressWins],
            ['Recoveries', T.totals.our.recoveries, T.totals.opponent.recoveries],
            ['Interceptions', T.totals.our.interceptions, T.totals.opponent.interceptions],
            ['Turnovers', T.totals.our.turnovers, T.totals.opponent.turnovers],
            ['Duels', T.totals.our.duels, T.totals.opponent.duels],
            ['Fouls', T.totals.our.fouls, T.totals.opponent.fouls]
          ].map((row) => `<tr><td>${row[0]}</td><td>${gk(row[1])}</td><td>${gk(row[2])}</td></tr>`).join('')}
          <tr class="sn-row-derived"><td>Average per match [D]</td><td>${gk(T.averagesPerMatch.our.events)} events · ${gk(T.averagesPerMatch.our.goals)} goals</td><td>${gk(T.averagesPerMatch.opponent.events)} events · ${gk(T.averagesPerMatch.opponent.goals)} goals</td></tr>
          <tr class="sn-row-derived"><td>Pass success (pooled) [D]</td><td>${seasonPct(T.percentages.our.passSuccess)}</td><td>${seasonPct(T.percentages.opponent.passSuccess)}</td></tr>
          <tr class="sn-row-derived"><td>Press win ratio (pooled) [D]</td><td>${seasonPct(T.percentages.our.pressWinRatio)}</td><td>${seasonPct(T.percentages.opponent.pressWinRatio)}</td></tr>
          <tr class="sn-row-derived"><td>Tagged possession seconds [R]</td><td>${gk(Math.round(T.possession.ourSecondsExact * 10) / 10)}s (${T.possession.ourIntervals} intervals)</td><td>${gk(Math.round(T.possession.opponentSecondsExact * 10) / 10)}s (${T.possession.opponentIntervals} intervals)</td></tr>
          <tr class="sn-row-derived"><td>Tagged Possession Share — season [D]</td><td colspan="2">${T.possession.share && T.possession.share.value !== null && T.possession.share.value !== undefined ? `${T.possession.share.value}%` : '— (insufficient tagged possession data)'}</td></tr>
        </tbody>
      </table>
      </div>
      <div class="sn-note">${escapeHtml(T.possession.basis)}.</div>
      <div class="sn-note">Located tagged events [R]: Us ${T.spatial.located.our} located / ${T.spatial.unlocated.our} unlocated · Opponent ${T.spatial.located.opponent} located / ${T.spatial.unlocated.opponent} unlocated. ${escapeHtml(T.spatial.note)}.</div>
    `;

    // --- PLAYER SEASON DATA ---
    html += `
      <div class="sn-section-label">Player season data (tagged events)</div>
      <div class="sn-table-scroll sn-player-scroll">
      <table class="sn-table">
        <thead>
          <tr>
            <th>Player</th><th>Apps [R]</th><th>Starts [R]</th><th>Sub apps [R]</th><th>Unused [R]</th>
            <th>Minutes [D]</th><th>Minutes quality</th>
            <th>Goals [R]</th><th>Shots [R]</th><th>SoT [R]</th><th>Chances [R]</th><th>Key P [R]</th>
            <th>Passes [R]</th><th>Pass% [D]</th><th>Rec [R]</th><th>Int [R]</th><th>Press [R]</th><th>Press W [R]</th>
            <th>TO [R]</th><th>Rec/90 [D]</th><th>TO/90 [D]</th><th>Press W/90 [D]</th><th>Goals/90 [D]</th>
          </tr>
        </thead>
        <tbody>
    `;

    if (PS.playerOrder.length === 0) {
      html += '<tr><td colspan="24" class="sn-empty">No player records.</td></tr>';
    }
    PS.playerOrder.forEach((pid) => {
      const p = PS.players[pid];
      const mins = p.appearances > 0 || p.minutes.quality !== 'UNAVAILABLE'
        ? `${seasonNum(p.minutes.reliableMinutes + p.minutes.estimatedMinutes > 0 ? p.minutes.reliableMinutes + p.minutes.estimatedMinutes : null)}`
        : '—';
      const per90 = (k) => {
        const m = p.per90.metrics[k];
        if (!m || m.value === null) return '—';
        return String(m.value);
      };
      const nameLabel = escapeHtml(p.name) + (p.number ? ` (${escapeHtml(p.number)})` : '');
      html += `
        <tr${p.dataQuality.status !== 'VALID' ? ' class="sn-row-partial"' : ''}>
          <td title="${escapeHtml(p.playerId)}${p.nameVariants.length > 1 ? ' · name varies between matches (flagged)' : ''}">${nameLabel}</td>
          <td>${p.appearances}</td><td>${p.starts}</td><td>${p.substituteAppearances}</td><td>${p.unusedSubstitutions}</td>
          <td>${mins}</td><td>${seasonQualityTag(p.minutes.quality)}</td>
          <td>${p.totals.goals}</td><td>${p.totals.shots}</td><td>${p.totals.shotsOnTarget}</td><td>${p.totals.chances}</td><td>${p.totals.keyPasses}</td>
          <td>${p.totals.passes}</td><td>${seasonPct(p.percentages.passSuccess)}</td>
          <td>${p.totals.recoveries}</td><td>${p.totals.interceptions}</td><td>${p.totals.presses}</td><td>${p.totals.pressWins}</td>
          <td>${p.totals.turnovers}</td>
          <td>${per90('recoveries')}</td><td>${per90('turnovers')}</td><td>${per90('pressWins')}</td><td>${per90('goals')}</td>
        </tr>
      `;
    });
    html += `
        </tbody>
      </table>
      </div>
      <div class="sn-note">Minutes are ${escapeHtml(p0minutesBasis(PS))}</div>
      <div class="sn-note">Per-90 values [D] use reliable minutes only; totals and denominator cover the same matches (per-90 is null when no reliable minutes exist). Unused = squad-listed, never started, never substituted on — PitchLog has no bench list, so unused counts may include players outside the matchday squad. Unused substitutes are not appearances.</div>
    `;

    // --- Data quality / gates (task Part 23) ---
    const G = PS.gates;
    const gateLines = [];
    if (G.PSD_X1_duplicates.length) {
      gateLines.push(`Duplicate / identity warnings: ${G.PSD_X1_duplicates.length} (same saved match loaded more than once is excluded from totals; look-alike matches are flagged, never merged)`);
    }
    if (G.PSD_X2_startingXI.length) {
      gateLines.push(`Starting XI missing or incomplete: ${G.PSD_X2_startingXI.length} match(es) — participation "unknown" for non-starters; unused-substitute evidence degraded`);
    }
    if (G.PSD_X3_ftMarker.length) {
      gateLines.push(`No full-time marker: ${G.PSD_X3_ftMarker.length} match(es) — minutes fall back to last-known evidence (ESTIMATED, never per-90)`);
    }
    if (G.PSD_X7_x1Mismatch.length) {
      gateLines.push(`Score-chain inconsistency (X1 MISMATCH): ${G.PSD_X7_x1Mismatch.length} match(es) — result flagged; score-state partitions suppressed for those matches`);
    }
    if (G.PSD_X8_emptyMetadata.length) {
      gateLines.push(`Missing date/opponent metadata: ${G.PSD_X8_emptyMetadata.length} match(es)`);
    }
    if (G.PSD_X6_subAttributionNoise.length) {
      gateLines.push(`Substitution attribution noise: ${G.PSD_X6_subAttributionNoise.length} match(es) (opponent-team subs referencing our players, un-timed or duplicate sub markers)`);
    }
    if (PS.identityAudit.drift.length) {
      gateLines.push(`Player name drift: ${PS.identityAudit.drift.length} player(s) — same playerId with different names across matches (kept as ONE identity; flagged for review)`);
    }
    if (PS.identityAudit.possibleDuplicates.length) {
      gateLines.push(`Possible duplicate persons: ${PS.identityAudit.possibleDuplicates.length} name(s) shared by different playerIds (never merged)`);
    }

    html += `
      <div class="sn-section-label">Data quality</div>
      <div class="sn-gates">
        ${gateLines.length ? gateLines.map((l) => `<div class="sn-gate-line">⚠ ${escapeHtml(l)}</div>`).join('') : '<div class="sn-gate-ok">No data-quality warnings for the loaded matches.</div>'}
        <div class="sn-gate-summary">Minutes quality across player-match records: reliable ${PS.coverage.minutesReliableRecords} · estimated ${PS.coverage.minutesEstimatedRecords} · unavailable ${PS.coverage.minutesUnavailableRecords}${PS.coverage.gameStateSuppressedMatches > 0 ? ` · score-state suppressed matches: ${PS.coverage.gameStateSuppressedMatches}` : ''}</div>
      </div>
      <div class="sn-footer">
        Player &amp; Season Data Engine ${escapeHtml(PS.engine.version)} · spec ${escapeHtml(PS.spec)} · Analytics Engine ${escapeHtml(PS.engine.analyticsEngineVersion || '')} · deterministic — recomputing the same matches yields identical output.
      </div>
    `;

    return html;
  }

  function p0minutesBasis(PS) {
    return (PS.protocol && PS.protocol.minutesStandards && PS.protocol.minutesStandards.basis) || 'gated estimates from recorded participation boundaries; never official minutes.';
  }

  // ---------- Recent Form UI (Phase C — read-only engine output) ----------
  //
  // Minimal read-only integration of the Recent Form Engine V1
  // (src/recent-form.js → window.RecentFormEngine). The engine entry point
  // is invoked exactly once per season render inside renderSeasonStats()
  // above; every figure below comes from that engine output (RF object).
  // This block NEVER reads raw sessions or events, NEVER recomputes totals,
  // pooled percentages, per-90 values, differences or tolerances, and NEVER
  // mutates PS or RF. Null engine values are rendered as neutral labels (—,
  // or "N/A — insufficient reliable minutes" for per-90), never as zero.
  //
  // Terminology and presentation follow the engine/spec exactly:
  //   Recent Form · Recent Activity · Last 3 / Last 5 / Last 10 ·
  //   Season Baseline · Baseline Excluding Recent Window · Observed Change ·
  //   Difference · HIGHER / LOWER / WITHIN-TOLERANCE / INCONCLUSIVE ·
  //   Observed Variability · Sample Size · Reliable minutes.
  // No form scores, ratings, momentum or causal language — classifications
  // describe numbers, never players.

  let seasonRecentForm = null;   // latest Recent Form engine output (read-only)
  let rfSelectedPlayerId = null; // player selected for the Recent Form detail

  const RF_METRIC_LABELS = {
    events: 'Events', goals: 'Goals', shots: 'Shots', shotsOnTarget: 'Shots on target',
    chances: 'Chances', keyPasses: 'Key passes', crosses: 'Crosses', corners: 'Corners',
    passes: 'Passes', successfulPasses: 'Successful passes', unsuccessfulPasses: 'Unsuccessful passes',
    passesUnknownOutcome: 'Passes with unknown outcome', presses: 'Presses', pressWins: 'Press wins',
    interceptions: 'Interceptions', recoveries: 'Recoveries', turnovers: 'Turnovers',
    duels: 'Duels', fouls: 'Fouls', yellowCards: 'Yellow cards', redCards: 'Red cards',
    substitutions: 'Substitutions',
    positiveEvents: 'Positive events', negativeEvents: 'Negative events', neutralEvents: 'Neutral events',
    transitionsPositive: 'Positive transitions', transitionsNegative: 'Negative transitions',
    positiveTransitions: 'Positive transitions', negativeTransitions: 'Negative transitions',
    goalsFor: 'Goals for', goalsAgainst: 'Goals against',
    passSuccess: 'Pass success (pooled)', pressWinRatio: 'Press win ratio (pooled)', locatedShare: 'Located share'
  };

  // Display subsets (presentation choice only — every value is engine output).
  const RF_UI_COUNT_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses', 'crosses',
    'passes', 'successfulPasses', 'unsuccessfulPasses', 'presses', 'pressWins',
    'interceptions', 'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards'
  ];
  const RF_UI_PER90_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'keyPasses', 'crosses',
    'passes', 'presses', 'pressWins', 'interceptions', 'recoveries', 'turnovers',
    'duels', 'fouls'
  ];
  const RF_UI_AVG_KEYS = ['events', 'goals', 'passes', 'recoveries', 'turnovers'];
  const RF_UI_TEAM_KEYS = [
    'events', 'goals', 'shots', 'shotsOnTarget', 'chances', 'crosses', 'corners',
    'passes', 'successfulPasses', 'unsuccessfulPasses', 'presses', 'pressWins',
    'interceptions', 'recoveries', 'turnovers', 'duels', 'fouls', 'yellowCards', 'redCards'
  ];
  const RF_UI_WW_KEYS = [
    'goalsFor', 'goalsAgainst', 'events', 'goals', 'shots', 'shotsOnTarget', 'chances',
    'passes', 'successfulPasses', 'presses', 'pressWins', 'interceptions', 'recoveries',
    'turnovers', 'duels', 'fouls'
  ];
  const RF_PERIODS = ['1H', '2H', 'ET1', 'ET2', 'Non-play', 'Unknown'];
  const RF_SCORE_STATES = ['WINNING', 'DRAW', 'LOSING'];
  const RF_THIRDS = ['Defensive third', 'Middle third', 'Attacking third'];

  // ---- null-safe formatters (engine values only; null is never 0) ----------

  function rfNum(v) {
    return (v === null || v === undefined) ? '—' : String(v);
  }

  function rfMinutesFromSeconds(sec) {
    if (sec === null || sec === undefined) return '—';
    return String(Math.round(sec / 60));
  }

  function rfPctEnv(env) {
    if (!env || env.value === null || env.value === undefined) return '—';
    return `${env.value}% (${rfNum(env.num)}/${rfNum(env.den)})`;
  }

  function rfPer90Cell(m) {
    if (!m || m.value === null || m.value === undefined) {
      return '<span class="rf-na">N/A — insufficient reliable minutes</span>';
    }
    return String(m.value);
  }

  function rfDiffCell(c) {
    if (!c || c.absoluteDifference === null || c.absoluteDifference === undefined) return '—';
    const d = c.absoluteDifference;
    return (d > 0 ? '+' : '') + String(d);
  }

  function rfPctDiffCell(c) {
    if (!c || c.percentageDifference === null || c.percentageDifference === undefined) return '—';
    return (c.percentageDifference > 0 ? '+' : '') + String(c.percentageDifference) + '%';
  }

  function rfClassCell(c) {
    if (!c || c.classification === null || c.classification === undefined) return '—';
    const cls = `<span class="rf-class">${escapeHtml(String(c.classification))}</span>`;
    return c.reason ? `${cls} <span class="rf-reason">(${escapeHtml(String(c.reason))})</span>` : cls;
  }

  function rfTolCell(c) {
    if (!c || c.tolerance === null || c.tolerance === undefined) return '—';
    const suffix = c.toleranceRule === 'FIXED_5PP' ? ' pp' : '';
    return '±' + String(c.tolerance) + suffix;
  }

  function rfSampleCell(c) {
    if (!c) return '—';
    return `${rfNum(c.recentSample)} / ${rfNum(c.baselineSample)}`;
  }

  function rfWindowKeys(RF) {
    const w = (RF.input && RF.input.optionsEcho && RF.input.optionsEcho.windows) || [3, 5, 10];
    return w.map((n) => String(n));
  }

  function rfWindowLabel(n) {
    return `Last ${n}`;
  }

  function rfSelectedPlayerIdOf(RF) {
    if (rfSelectedPlayerId && RF.playerOrder.indexOf(rfSelectedPlayerId) !== -1) return rfSelectedPlayerId;
    return RF.playerOrder[0] || null;
  }

  function rfReasonCounts(list) {
    const counts = {};
    (list || []).forEach((e) => {
      const r = (e && e.reason) || 'UNKNOWN';
      counts[r] = (counts[r] || 0) + 1;
    });
    return Object.keys(counts).sort().map((r) => `${r}${counts[r] > 1 ? ' ×' + counts[r] : ''}`).join(', ');
  }

  function rfExcludedRecordsSummary(win) {
    const s = rfReasonCounts(win.excludedRecords);
    return s || '—';
  }

  function rfExcludedMatchesSummary(win) {
    const s = rfReasonCounts(win.excludedMatches);
    return s || '—';
  }

  // ---- comparison row builders (engine comparison objects only) ------------

  function rfComparisonRow(label, c, kind) {
    let recentCell;
    let baselineCell;
    if (kind === 'pct') {
      recentCell = (c.recentValue === null || c.recentValue === undefined)
        ? '—' : `${c.recentValue}% (${rfNum(c.recentNum)}/${rfNum(c.recentDen)})`;
      baselineCell = (c.baselineValue === null || c.baselineValue === undefined)
        ? '—' : `${c.baselineValue}% (${rfNum(c.baselineNum)}/${rfNum(c.baselineDen)})`;
    } else if (kind === 'per90') {
      recentCell = (c.recentValue === null || c.recentValue === undefined)
        ? '<span class="rf-na">N/A — insufficient reliable minutes</span>' : String(c.recentValue);
      baselineCell = rfNum(c.baselineValue);
    } else {
      recentCell = rfNum(c.recentValue);
      baselineCell = rfNum(c.baselineValue);
    }
    return `<tr><td>${label}</td><td>${recentCell}</td><td>${baselineCell}</td><td>${rfDiffCell(c)}</td><td>${rfPctDiffCell(c)}</td><td>${rfClassCell(c)}</td><td>${rfSampleCell(c)}</td><td>${rfTolCell(c)}</td></tr>`;
  }

  function rfComparisonRows(compSet) {
    let rows = '';
    RF_UI_COUNT_KEYS.forEach((k) => { rows += rfComparisonRow(RF_METRIC_LABELS[k] || k, compSet.counts[k], 'count'); });
    ['passSuccess', 'pressWinRatio', 'locatedShare'].forEach((k) => { rows += rfComparisonRow(RF_METRIC_LABELS[k], compSet.percentages[k], 'pct'); });
    RF_UI_PER90_KEYS.forEach((k) => { rows += rfComparisonRow((RF_METRIC_LABELS[k] || k) + '/90', compSet.per90[k], 'per90'); });
    return rows;
  }

  function rfComparisonTable(compSet) {
    return `
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Metric</th><th>Recent</th><th>Baseline</th><th>Difference</th><th>% Difference</th><th>Classification</th><th>Sample Size (recent / baseline)</th><th>Tolerance</th></tr>
        </thead>
        <tbody>${compSet ? rfComparisonRows(compSet) : '<tr><td colspan="8" class="sn-empty">No comparison data.</td></tr>'}</tbody>
      </table>
      </div>
    `;
  }

  // ---- section skeleton -----------------------------------------------------

  function buildRecentFormSectionHtml(rfError) {
    let html = '';
    if (rfError) {
      return `
        <div id="rfSection" class="rf-section">
          <div class="sn-section-label">Recent Form</div>
          <div class="sn-note">Recent Form engine error: ${escapeHtml(String((rfError && rfError.message) || rfError))}</div>
        </div>`;
    }
    if (!window.RecentFormEngine || typeof window.RecentFormEngine.computeRecentForm !== 'function') {
      return `
        <div id="rfSection" class="rf-section">
          <div class="sn-section-label">Recent Form</div>
          <div class="sn-note">Recent Form engine not loaded (src/recent-form.js).</div>
        </div>`;
    }
    const RF = seasonRecentForm;
    if (!RF) {
      return `
        <div id="rfSection" class="rf-section">
          <div class="sn-section-label">Recent Form</div>
          <div class="sn-note">Recent Form engine output unavailable for the loaded matches.</div>
        </div>`;
    }
    const wk = rfWindowKeys(RF);
    const sel = rfSelectedPlayerIdOf(RF);

    html += `
      <div id="rfSection" class="rf-section">
      <div class="sn-section-label">Recent Form — recent activity windows</div>
      <div class="sn-note">Descriptive windows over each player's most recent appearances and the team's most recent completed matches. All figures come from the Recent Form engine output (read-only); windows use actual appearances and are never padded. Column tags: [R] recorded · [D] derived.</div>
      <div class="sn-coverage">Recent Form input: ${RF.input.orderedMatchCount} ordered match(es) · ${RF.input.completedMatchCount} completed · windows ${wk.join(' / ')} · selected window ${RF.input.selectedWindow}</div>
    `;

    if (!RF.playerOrder.length) {
      html += `<div class="sn-note">No player records — load matches with tagged player events to see player Recent Form.</div>`;
    } else {
      html += `
        <div class="rf-player-picker">
          <label for="rfPlayerSelect">Player</label>
          <select id="rfPlayerSelect" class="rf-player-select">
            ${RF.playerOrder.map((pid) => {
              const p = RF.players[pid];
              const label = escapeHtml(p.name) + (p.number ? ` (${escapeHtml(p.number)})` : '');
              return `<option value="${escapeHtml(pid)}"${pid === sel ? ' selected' : ''}>${label}</option>`;
            }).join('')}
          </select>
        </div>
        <div id="rfPlayerDetail"></div>
      `;
    }

    html += buildRecentFormTeamHtml(RF);
    html += buildRecentFormDqHtml(RF);
    html += `
      <div class="sn-footer">
        Recent Form Engine ${escapeHtml(RF.engine.version)} · spec ${escapeHtml(RF.engine.spec)} · consumes Player &amp; Season Data Engine ${escapeHtml(rfNum(RF.engine.psEngineVersion))} output · deterministic — this view renders engine output only; no figures are recalculated here.
      </div>
      </div>
    `;
    return html;
  }

  function wireRecentFormPlayerSelect() {
    const sel = seasonStatsContentEl.querySelector('#rfPlayerSelect');
    if (!sel) return;
    sel.addEventListener('change', () => {
      rfSelectedPlayerId = sel.value || null;
      renderRecentFormPlayerDetail();
    });
  }

  function renderRecentFormPlayerDetail() {
    const RF = seasonRecentForm;
    const el = seasonStatsContentEl.querySelector('#rfPlayerDetail');
    if (!RF || !el) return;
    const pid = rfSelectedPlayerIdOf(RF);
    if (!pid || !RF.players[pid]) {
      el.innerHTML = '<div class="sn-note">No player records.</div>';
      return;
    }
    el.innerHTML = buildRecentFormPlayerDetailHtml(RF, RF.players[pid]);
  }

  // ---- player detail (selected player; engine output verbatim) -------------

  function buildRecentFormPlayerDetailHtml(RF, PRF) {
    const wk = rfWindowKeys(RF);
    const selWin = String(RF.input.selectedWindow);
    const nameLabel = escapeHtml(PRF.name) + (PRF.number ? ` (${escapeHtml(PRF.number)})` : '');

    let html = `
      <div class="rf-note">Player: <b>${nameLabel}</b> — appearances in season: ${rfNum(PRF.appearancesTotal)} · match records in season: ${rfNum(PRF.recordsInSeason)} · data quality: ${escapeHtml(String(PRF.dataQuality.status))}${PRF.dataQuality.flags.length ? ' (' + PRF.dataQuality.flags.map(escapeHtml).join(', ') + ')' : ''}${PRF.dataQuality.unresolvedPlayerMatches ? ' · unresolved player-match references: ' + rfNum(PRF.dataQuality.unresolvedPlayerMatches) : ''}</div>
    `;

    // A. window sample sizes
    html += `
      <div class="rf-block-label">Window sample sizes</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Window</th><th>Sample Size (appearances)</th><th>Available appearances</th><th>Excluded records in window (reasons)</th></tr>
        </thead>
        <tbody>
          ${wk.map((n) => {
            const w = PRF.windows[n];
            const sample = w.included < w.requested ? `${w.included} of ${w.requested} requested` : String(w.included);
            return `<tr><td>${rfWindowLabel(n)}</td><td>${sample}</td><td>${rfNum(w.available)}</td><td>${rfExcludedRecordsSummary(w)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <div class="sn-note">Windows slice the season's deterministic match order and are never padded — the true Sample Size is always shown. Excluded records are non-appearance player records (e.g. UNUSED_SUB) from the first window match onward.</div>
    `;

    // B + C. Recent Activity totals and per-appearance averages
    html += `
      <div class="rf-block-label">Recent Activity — tagged totals per window [R]</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Metric</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${RF_UI_COUNT_KEYS.map((k) => `<tr><td>${RF_METRIC_LABELS[k] || k}</td>${wk.map((n) => `<td>${rfNum(PRF.windows[n].totals[k])}</td>`).join('')}</tr>`).join('')}
          ${RF_UI_AVG_KEYS.map((k) => `<tr class="sn-row-derived"><td>${RF_METRIC_LABELS[k] || k} per appearance [D]</td>${wk.map((n) => `<td>${rfNum(PRF.windows[n].averagesPerAppearance[k])}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
      </div>
    `;

    // D. pooled percentages (engine value/num/den; never averaged in the UI)
    html += `
      <div class="rf-block-label">Pooled percentages [D]</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Percentage</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          <tr><td>Pass success (pooled)</td>${wk.map((n) => `<td>${rfPctEnv(PRF.windows[n].percentages.passSuccess)}</td>`).join('')}</tr>
          <tr><td>Press win ratio (pooled)</td>${wk.map((n) => `<td>${rfPctEnv(PRF.windows[n].percentages.pressWinRatio)}</td>`).join('')}</tr>
          <tr><td>Located share</td>${wk.map((n) => `<td>${rfPctEnv(PRF.windows[n].percentages.locatedShare)}</td>`).join('')}</tr>
        </tbody>
      </table>
      </div>
      <div class="sn-note">Pooled percentages sum the numerator and denominator across the window's appearances first (num/den shown); match percentages are never averaged.</div>
    `;

    // E. per-90 metrics with reliability disclosure (task Part 6)
    html += `
      <div class="rf-block-label">Per-90 metrics [D]</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Metric</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${RF_UI_PER90_KEYS.map((k) => `<tr><td>${(RF_METRIC_LABELS[k] || k)}/90</td>${wk.map((n) => `<td>${rfPer90Cell(PRF.windows[n].per90.metrics[k])}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
      </div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Per-90 reliability</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          <tr><td>Appearances in window</td>${wk.map((n) => `<td>${rfNum(PRF.windows[n].per90.appearancesInWindow)}</td>`).join('')}</tr>
          <tr><td>Appearances included in per-90</td>${wk.map((n) => `<td>${rfNum(PRF.windows[n].per90.appearancesIncludedInPer90)} of ${rfNum(PRF.windows[n].per90.appearancesInWindow)}</td>`).join('')}</tr>
          <tr><td>Reliable minutes</td>${wk.map((n) => `<td>${rfMinutesFromSeconds(PRF.windows[n].per90.reliableSeconds)} min (${rfNum(PRF.windows[n].per90.reliableSeconds)} s)</td>`).join('')}</tr>
          <tr><td>Minutes quality</td>${wk.map((n) => `<td>${seasonQualityTag(PRF.windows[n].per90.minutesQuality)}</td>`).join('')}</tr>
        </tbody>
      </table>
      </div>
      <div class="sn-note">${escapeHtml(String((PRF.windows[wk[0]] && PRF.windows[wk[0]].per90.basis) || 'Per-90 values use reliable minutes only; matches with estimated or unavailable minutes are excluded and reported.'))} A null per-90 value is shown as "N/A — insufficient reliable minutes", never as zero.</div>
    `;

    // F. period information
    html += `
      <div class="rf-block-label">Period information [R]</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Events per period</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${RF_PERIODS.map((p) => `<tr><td>${p}</td>${wk.map((n) => `<td>${rfNum((PRF.windows[n].periods[p] || {}).events)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
      </div>
    `;

    // G. game-state information (suppression surfaced, never hidden)
    html += `<div class="rf-block-label">Game state [R]</div>`;
    const gsAllSuppressed = wk.every((n) => PRF.windows[n].gameState === null);
    if (gsAllSuppressed) {
      html += `<div class="sn-note">Game-state detail is unavailable — score-state partitions were suppressed for every appearance in every window (score-chain inconsistency, X1 MISMATCH).</div>`;
    } else {
      html += `
        <div class="sn-table-scroll">
        <table class="sn-table">
          <thead>
            <tr><th>Events per score state</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${RF_SCORE_STATES.map((s) => `<tr><td>${s}</td>${wk.map((n) => {
              const gs = PRF.windows[n].gameState;
              return `<td>${gs ? rfNum(gs[s].events) : '—'}</td>`;
            }).join('')}</tr>`).join('')}
          </tbody>
        </table>
        </div>
      `;
    }
    const gsSuppressedCounts = wk.filter((n) => (PRF.windows[n].gameStateSuppressedMatches || 0) > 0);
    if (gsSuppressedCounts.length) {
      html += `<div class="sn-note">Game state suppressed in some appearances (X1 MISMATCH — score-state partitions suppressed for those matches): ${gsSuppressedCounts.map((n) => `${rfWindowLabel(n)}: ${rfNum(PRF.windows[n].gameStateSuppressedMatches)}`).join(' · ')}.</div>`;
    }
    html += `<div class="sn-note">Score state uses each event's recorded score BEFORE the event (WINNING / DRAW / LOSING).</div>`;

    // H. spatial information
    html += `
      <div class="rf-block-label">Spatial — located tagged events [R]</div>
      <div class="sn-note">${wk.map((n) => {
        const sp = PRF.windows[n].spatial;
        return `${rfWindowLabel(n)}: ${rfNum(sp.located)} located / ${rfNum(sp.unlocated)} unlocated`;
      }).join(' · ')}.</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Located events per third</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${RF_THIRDS.map((t) => `<tr><td>${t}</td>${wk.map((n) => `<td>${rfNum(PRF.windows[n].spatial.thirds[t])}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
      </div>
    `;

    // J + K. Observed Change — comparisons for the selected window
    const cmpA = PRF.comparisons[selWin] && PRF.comparisons[selWin].vsBaselineA;
    html += `
      <div class="rf-block-label">Observed Change — ${rfWindowLabel(selWin)} vs Season Baseline [D]</div>
      <div class="sn-note">Season Baseline = the full-season record for this player. Differences, percentage differences, tolerances and classifications come from the engine; classifications (HIGHER / LOWER / WITHIN-TOLERANCE / INCONCLUSIVE) describe numbers, never players. Boundary is INCLUSIVE.</div>
      ${rfComparisonTable(cmpA)}
    `;

    html += `<div class="rf-block-label">Observed Change — ${rfWindowLabel(selWin)} vs Baseline Excluding Recent Window [D]</div>`;
    const cmpB = PRF.comparisons[selWin] && PRF.comparisons[selWin].vsBaselineB;
    if (!cmpB) {
      html += `<div class="sn-note">Baseline Excluding Recent Window is provided only for the selected window (Last ${RF.input.selectedWindow}).</div>`;
    } else {
      const probe = cmpB.counts.events || {};
      const suppression = (probe.reason === 'WHOLE_SEASON_IN_WINDOW' || probe.reason === 'NO_DATA') ? probe.reason : null;
      if (suppression === 'WHOLE_SEASON_IN_WINDOW') {
        html += `<div class="rf-suppressed">Baseline Excluding Recent Window: unavailable — WHOLE_SEASON_IN_WINDOW. The selected window covers the entire season, so no records remain outside it; the unavailable baseline is never replaced with a fabricated value. Every comparison returns INCONCLUSIVE.</div>`;
      } else if (suppression === 'NO_DATA') {
        html += `<div class="rf-suppressed">Baseline Excluding Recent Window: unavailable — NO_DATA (no player records outside the window). The unavailable baseline is never replaced with a fabricated value.</div>`;
      } else {
        html += `<div class="sn-note">Baseline Excluding Recent Window = the season with the selected window's matches removed (window + baseline reconciles to the season for additive metrics).</div>`;
      }
      html += rfComparisonTable(cmpB);
    }

    // L. Recent 5 vs Previous 5 (task Part 10)
    const r5p5 = PRF.recentVsPrevious5;
    html += `<div class="rf-block-label">Recent 5 vs Previous 5 [D]</div>`;
    if (r5p5.eligibility === 'COMPARISON' && r5p5.comparisons) {
      html += `
        <div class="sn-note">Eligibility: ${escapeHtml(String(r5p5.eligibility))} — Sample Size: Recent 5 = ${rfNum(r5p5.recent5 && r5p5.recent5.included)} appearances · Previous 5 = ${rfNum(r5p5.previous5 && r5p5.previous5.included)} appearances.</div>
        <div class="sn-table-scroll">
        <table class="sn-table">
          <thead>
            <tr><th>Metric</th><th>Recent 5</th><th>Previous 5</th><th>Difference</th><th>% Difference</th><th>Classification</th><th>Sample Size (recent / previous)</th><th>Tolerance</th></tr>
          </thead>
          <tbody>${rfComparisonRows(r5p5.comparisons)}</tbody>
        </table>
        </div>
      `;
    } else {
      html += `<div class="sn-note">INCONCLUSIVE — ${escapeHtml(String(r5p5.reason))}. Sample size: ${rfNum(r5p5.appearancesTotal)} appearances recorded — at least 10 valid appearances are required for the Recent 5 vs Previous 5 comparison. Previous 5 is not fabricated; the Recent 5 activity itself is shown in the window tables above.</div>`;
    }

    // M. Observed Variability (min / max / range / mean / median only)
    html += `
      <div class="rf-block-label">Observed Variability — ${rfWindowLabel(selWin)} [D]</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Metric</th><th>Min</th><th>Max</th><th>Range</th><th>Mean</th><th>Median</th><th>Sample Size (matches)</th></tr>
        </thead>
        <tbody>
          ${RF_UI_COUNT_KEYS.map((k) => {
            const v = PRF.variability[selWin][k];
            return `<tr><td>${RF_METRIC_LABELS[k] || k}</td><td>${rfNum(v.min)}</td><td>${rfNum(v.max)}</td><td>${rfNum(v.range)}</td><td>${rfNum(v.mean)}</td><td>${rfNum(v.median)}</td><td>${rfNum(v.matches)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <div class="sn-note">Observed Variability lists min / max / range / mean / median only, over the appearances in the selected window.</div>
    `;

    // N. With / Without (observational; task Part 11)
    const ww = PRF.withWithout;
    html += `
      <div class="rf-block-label">With / Without — team record by tagged participation (observational) [D]</div>
      <div class="sn-note">WITH: ${rfNum(ww.with.matches)} completed matches (${rfNum(ww.with.wins)}W ${rfNum(ww.with.draws)}D ${rfNum(ww.with.losses)}L · goals for ${rfNum(ww.with.goalsFor)} · goals against ${rfNum(ww.with.goalsAgainst)}) · WITHOUT: ${rfNum(ww.without.matches)} completed matches (${rfNum(ww.without.wins)}W ${rfNum(ww.without.draws)}D ${rfNum(ww.without.losses)}L · goals for ${rfNum(ww.without.goalsFor)} · goals against ${rfNum(ww.without.goalsAgainst)})${ww.unresolved ? ' · UNRESOLVED participation matches: ' + rfNum(ww.unresolved) : ''}</div>
    `;
    if (ww.status === 'COMPARISON' && ww.comparisons) {
      html += `
        <div class="sn-note">Comparison basis: ${escapeHtml(String(ww.comparisonBasis))} — per-match averages for the WITH and WITHOUT groups (at least 3 completed matches required in both groups).</div>
        <div class="sn-table-scroll">
        <table class="sn-table">
          <thead>
            <tr><th>Team metric</th><th>WITH (per match)</th><th>WITHOUT (per match)</th><th>Difference</th><th>Classification</th><th>Tolerance</th></tr>
          </thead>
          <tbody>
            ${RF_UI_WW_KEYS.map((k) => {
              const c = ww.comparisons[k];
              if (!c) return '';
              return `<tr><td>${RF_METRIC_LABELS[k] || k}</td><td>${rfNum(c.withValue)}</td><td>${rfNum(c.withoutValue)}</td><td>${rfDiffCell(c)}</td><td>${rfClassCell(c)}</td><td>${rfTolCell(c)}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>
      `;
    } else if (ww.status === 'INSUFFICIENT_SAMPLE') {
      html += `<div class="sn-note">INSUFFICIENT_SAMPLE — the comparison requires at least 3 completed matches in BOTH groups; the observed group sizes above are the actual sample sizes and are never replaced with fabricated values.</div>`;
    } else {
      html += `<div class="sn-note">UNRESOLVED — no completed matches with resolved participation information for this player.</div>`;
    }
    html += `<div class="sn-note">${escapeHtml(String(ww.standingNote))}</div>`;

    // I. data-quality flags for this player (task Part 13)
    html += `
      <div class="rf-block-label">Recent Form data quality — ${nameLabel}</div>
      <div class="sn-note">Player-level: ${escapeHtml(String(PRF.dataQuality.status))}${PRF.dataQuality.flags.length ? ' — flags: ' + PRF.dataQuality.flags.map(escapeHtml).join(', ') : ' — no flags'}.</div>
      <div class="sn-note">Window-level: ${wk.map((n) => {
        const w = PRF.windows[n].dataQuality;
        return `${rfWindowLabel(n)}: ${escapeHtml(String(w.status))}${w.flags.length ? ' (' + w.flags.map(escapeHtml).join(', ') + ')' : ''}`;
      }).join(' · ')}.</div>
      <div class="sn-note">Flags are propagated from the Player &amp; Season records; missing data is displayed as unavailable (— or N/A), never converted to zero.</div>
    `;

    return html;
  }

  // ---- team Recent Form (task Part 12) ---------------------------------------

  function buildRecentFormTeamHtml(RF) {
    const T = RF.team;
    const wk = rfWindowKeys(RF);

    let html = `
      <div class="rf-block-label">Team Recent Form — completed matches</div>
      <div class="sn-note">Team windows count COMPLETED matches only (records with a valid result, full-time marker and complete starting XI); incomplete or no-result matches inside a window are excluded with reasons. Completed matches: ${rfNum(T.completedMatchesTotal)} of ${rfNum(RF.input.orderedMatchCount)} ordered.</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Window</th><th>Sample Size (completed matches)</th><th>Available completed</th><th>Excluded matches in window (reasons)</th></tr>
        </thead>
        <tbody>
          ${wk.map((n) => {
            const w = T.windows[n];
            const sample = w.included < w.requested ? `${w.included} of ${w.requested} requested` : String(w.included);
            return `<tr><td>${rfWindowLabel(n)}</td><td>${sample}</td><td>${rfNum(w.available)}</td><td>${rfExcludedMatchesSummary(w)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Window</th><th>W</th><th>D</th><th>L</th><th>Goals for</th><th>Goals against</th><th>No result</th><th>Result flagged (X1)</th></tr>
        </thead>
        <tbody>
          ${wk.map((n) => {
            const w = T.windows[n];
            return `<tr><td>${rfWindowLabel(n)}</td><td>${rfNum(w.results.wins)}</td><td>${rfNum(w.results.draws)}</td><td>${rfNum(w.results.losses)}</td><td>${rfNum(w.goalsFor)}</td><td>${rfNum(w.goalsAgainst)}</td><td>${rfNum(w.results.noResult)}</td><td>${rfNum(w.results.flaggedResults)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>
      <div class="sn-note">Match result (W/D/L) comes from the final score (manual entry when set, otherwise the attributed goal chain); flagged results are shown, never silently resolved.</div>
      <div class="sn-table-scroll">
      <table class="sn-table">
        <thead>
          <tr><th>Tagged activity [R] (Us / Opp)</th>${wk.map((n) => `<th>${rfWindowLabel(n)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${RF_UI_TEAM_KEYS.map((k) => `<tr><td>${RF_METRIC_LABELS[k] || k}</td>${wk.map((n) => {
            const w = T.windows[n];
            return `<td>${rfNum(w.totals.our[k])} / ${rfNum(w.totals.opponent[k])}</td>`;
          }).join('')}</tr>`).join('')}
          <tr class="sn-row-derived"><td>Average events per match [D] (Us)</td>${wk.map((n) => `<td>${rfNum(T.windows[n].averagesPerMatch.our.events)}</td>`).join('')}</tr>
          <tr class="sn-row-derived"><td>Average goals per match [D] (Us)</td>${wk.map((n) => `<td>${rfNum(T.windows[n].averagesPerMatch.our.goals)}</td>`).join('')}</tr>
          <tr class="sn-row-derived"><td>Pass success (pooled) [D] (Us / Opp)</td>${wk.map((n) => `<td>${rfPctEnv(T.windows[n].percentages.our.passSuccess)} / ${rfPctEnv(T.windows[n].percentages.opponent.passSuccess)}</td>`).join('')}</tr>
          <tr class="sn-row-derived"><td>Press win ratio (pooled) [D] (Us / Opp)</td>${wk.map((n) => `<td>${rfPctEnv(T.windows[n].percentages.our.pressWinRatio)} / ${rfPctEnv(T.windows[n].percentages.opponent.pressWinRatio)}</td>`).join('')}</tr>
          <tr class="sn-row-derived"><td>Tagged Possession Share [D]</td>${wk.map((n) => {
            const s = T.windows[n].taggedPossessionShare;
            if (!s || s.value === null || s.value === undefined) {
              return `<td><span class="rf-na">— (${escapeHtml(String(s && s.reason || 'NO_TAGGED_POSSESSION_INTERVALS'))})</span></td>`;
            }
            return `<td>${s.value}% (${rfNum(s.num)}/${rfNum(s.den)} tagged seconds)</td>`;
          }).join('')}</tr>
        </tbody>
      </table>
      </div>
      <div class="sn-note">Tagged activity totals are counted from tagged events in each window's completed matches. Tagged Possession Share uses tagged possession intervals only — not an official match possession statistic (NC-1). ${escapeHtml(String((T.windows[wk[0]] || {}).taggedPossessionShare && T.windows[wk[0]].taggedPossessionShare.basis || 'tagged possession intervals'))}</div>
      <div class="rf-note">Team Recent Form data quality: ${escapeHtml(String(T.dataQuality.status))} — completed ${rfNum(T.dataQuality.matchesValid)} of ${rfNum(RF.input.orderedMatchCount)} ordered matches${T.dataQuality.flags.length ? ' · flags: ' + T.dataQuality.flags.map(escapeHtml).join(', ') : ' · no flags'}.</div>
    `;
    return html;
  }

  // ---- top-level Recent Form data quality (task Part 13) --------------------

  function buildRecentFormDqHtml(RF) {
    const dq = RF.dataQuality;
    return `
      <div class="rf-block-label">Recent Form data quality</div>
      <div class="sn-note">Status: ${escapeHtml(String(dq.status))} · Propagated flags: ${dq.propagatedFlags.length ? dq.propagatedFlags.map(escapeHtml).join(', ') : 'none — no data-quality flags propagated from the loaded matches'} · Structural flags: ${dq.structuralFlags.length ? dq.structuralFlags.map(escapeHtml).join(', ') : 'none'}.</div>
      <div class="sn-note">Structural flags (duplicate-session exclusions, identity drift, possible duplicate persons, inconsistent goal chain, missing substitution information, unreliable minutes, X1 suppression where surfaced) affect window reliability and are shown, never silently suppressed. Location-coverage flags are informational. Missing data is never converted to zero.</div>
    `;
  }

  btnSeasonView.addEventListener('click', () => {
    renderSeasonMatchList();
    renderSeasonStats();
    seasonModal.style.display = 'flex';
  });

  function closeSeasonModal() {
    seasonModal.style.display = 'none';
  }

  btnCloseSeasonModal.addEventListener('click', closeSeasonModal);

  btnAddSeasonMatches.addEventListener('click', async () => {
    const loaded = await window.matchtag.loadMultipleSessions();
    if (!Array.isArray(loaded) || loaded.length === 0) return;

    loaded.forEach((data) => {
      if (data.sourceFile && seasonMatches.some((m) => m.sourceFile === data.sourceFile)) return; // already loaded
      seasonMatches.push({
        id: nextSeasonMatchId++,
        sourceFile: data.sourceFile || null,
        savedAt: data.__savedAt || null,
        matchInfo: data.matchInfo || null,
        events: Array.isArray(data.events) ? data.events : [],
        tags: Array.isArray(data.tags) ? data.tags : [],
        squad: Array.isArray(data.squad) ? data.squad : [],
        matchClock: data.matchClock && typeof data.matchClock === 'object' ? data.matchClock : null
      });
    });

    renderSeasonMatchList();
    renderSeasonStats();
  });

  btnExportSeasonCsv.addEventListener('click', async () => {
    if (seasonMatches.length === 0) return;

    const header = 'match,timecode,seconds,end_timecode,end_seconds,duration_seconds,label,side,player_number,player_name,player_off_number,player_off_name,player_on_number,player_on_name,subtype,qualifiers,location_zone,location_x,location_y';
    const rows = [];

    seasonMatches.forEach((m) => {
      const matchLabel = seasonMatchLabel(m);
      m.events.forEach((ev) => {
        const qualifiersStr = Object.entries(ev.qualifiers || {})
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
        const zone = ev.location ? locationZone(ev.location.x, ev.location.y) : '';
        const x = ev.location ? ev.location.x.toFixed(3) : '';
        const y = ev.location ? ev.location.y.toFixed(3) : '';
        const endTime = ev.isInterval ? ev.endTime : ev.time;
        const duration = ev.isInterval ? (ev.endTime - ev.startTime) : 0;
        rows.push([
          csvEscape(matchLabel),
          formatTimecode(ev.time, true),
          ev.time.toFixed(1),
          formatTimecode(endTime, true),
          endTime.toFixed(1),
          duration.toFixed(1),
          csvEscape(ev.label),
          csvEscape(ev.side || ''),
          csvEscape((() => { const p = resolvePlayer(ev.playerId); return p ? (p.number || '') : ''; })()),
          csvEscape((() => { const p = resolvePlayer(ev.playerId); return p ? p.name : ''; })()),
          csvEscape((() => { const p = resolvePlayer(ev.playerOffId); return p ? (p.number || '') : ''; })()),
          csvEscape((() => { const p = resolvePlayer(ev.playerOffId); return p ? p.name : ''; })()),
          csvEscape((() => { const p = resolvePlayer(ev.playerOnId); return p ? (p.number || '') : ''; })()),
          csvEscape((() => { const p = resolvePlayer(ev.playerOnId); return p ? p.name : ''; })()),
          csvEscape(ev.subtype || ''),
          csvEscape(qualifiersStr),
          csvEscape(zone),
          x,
          y
        ].join(','));
      });
    });

    const csv = [header, ...rows].join('\n');
    await window.matchtag.exportCsv(csv);
  });

  // ---------- Session save / load ----------

  // saveSession(): writes the current session to a user-chosen JSON file.
  // Returns true if saved, false if the user canceled the save dialog.
  // On success, marks the session clean and clears the autosave so it
  // never clobbers the deliberately-saved file.
  async function saveSession() {
    const sessionData = { videoPath: currentVideoPath, tags, events, squad, matchInfo, matchClock };
    const result = await window.matchtag.saveSession(sessionData);
    if (!result || result.canceled) return false;
    // Manual save succeeded — the saved file is now the source of truth.
    // Clear the autosave so it never clobbers a deliberately-saved session.
    setClean();
    await clearAutosave();
    return true;
  }

  btnSaveSession.addEventListener('click', saveSession);

  btnLoadSession.addEventListener('click', async () => {
    const data = await window.matchtag.loadSession();
    if (!data) return;

    tags = Array.isArray(data.tags) && data.tags.length ? data.tags : tags;
    events = Array.isArray(data.events)
      ? data.events.map((ev) => ({
          ...ev,
          subtype: ev.subtype ?? null,
          qualifiers: ev.qualifiers ?? {},
          location: ev.location ?? null,
          playerId: ev.playerId ?? null,
          playerOffId: ev.playerOffId ?? null,
          playerOnId: ev.playerOnId ?? null,
          side: ev.side ?? null,
          isInterval: ev.isInterval ?? false
        }))
      : [];
    nextEventId = events.reduce((max, ev) => Math.max(max, ev.id + 1), 1);

    activeIntervals = {};

    matchInfo = data.matchInfo && typeof data.matchInfo === 'object'
      ? { ...blankMatchInfo(), ...data.matchInfo }
      : blankMatchInfo();
    renderMatchSummary();

    // Restore match clock (merged onto blank; stopped on load)
    if (data.matchClock && typeof data.matchClock === 'object') {
      matchClock = { ...blankMatchClock(), ...data.matchClock };
      matchClock.clockRunning = false;
      matchClock.clockStartedAt = null;
    } else {
      matchClock = blankMatchClock();
    }
    renderMatchClock();
    renderTeamSelector();
    renderPlayerSelector();
    renderSequenceControls();
    renderScoreboard();
    renderVideoOffset();

    if (data.videoPath && data.videoUrl) loadVideoFromPath(data.videoPath, data.videoUrl);

    lastLoggedEventId = null;
    updateUndoButton();

    eventSearchTerm = '';
    eventSearchInput.value = '';
    eventTypeFilterValue = '__all__';
    populateEventTypeFilter();

    renderTagButtons();
    renderEventList();

    // Manual load succeeded — the loaded file is now the source of truth.
    // Clear the autosave so it never clobbers a deliberately-loaded session.
    // (loadVideoFromPath above may have called markAutosaveDirty +
    // scheduleAutosave; setClean + clearAutosave cancel that pending
    // write and delete the autosave file.)
    setClean();
    await clearAutosave();
  });

  // ---------- CSV export ----------

  btnExportCsv.addEventListener('click', async (e) => {
    // Shift+Click is owned exclusively by the full-analysis listener attached
    // further below; bail out here so exactly ONE export runs per click.
    // (Previously both listeners fired on Shift+Click, opening two save
    // dialogs / two exports.)
    if (e.shiftKey) return;
    const header = 'timecode,seconds,end_timecode,end_seconds,duration_seconds,label,side,player_number,player_name,player_off_number,player_off_name,player_on_number,player_on_name,subtype,qualifiers,location_zone,location_x,location_y';
    const rows = events.map((ev) => {
      const qualifiersStr = Object.entries(ev.qualifiers || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      const zone = ev.location ? locationZone(ev.location.x, ev.location.y) : '';
      const x = ev.location ? ev.location.x.toFixed(3) : '';
      const y = ev.location ? ev.location.y.toFixed(3) : '';
      const endTime = ev.isInterval ? ev.endTime : ev.time;
      const duration = ev.isInterval ? (ev.endTime - ev.startTime) : 0;
      return [
        formatTimecode(ev.time, true),
        ev.time.toFixed(1),
        formatTimecode(endTime, true),
        endTime.toFixed(1),
        duration.toFixed(1),
        csvEscape(ev.label),
        csvEscape(ev.side || ''),
        csvEscape((() => { const p = resolvePlayer(ev.playerId); return p ? (p.number || '') : ''; })()),
        csvEscape((() => { const p = resolvePlayer(ev.playerId); return p ? p.name : ''; })()),
        csvEscape((() => { const p = resolvePlayer(ev.playerOffId); return p ? (p.number || '') : ''; })()),
        csvEscape((() => { const p = resolvePlayer(ev.playerOffId); return p ? p.name : ''; })()),
        csvEscape((() => { const p = resolvePlayer(ev.playerOnId); return p ? (p.number || '') : ''; })()),
        csvEscape((() => { const p = resolvePlayer(ev.playerOnId); return p ? p.name : ''; })()),
        csvEscape(ev.subtype || ''),
        csvEscape(qualifiersStr),
        csvEscape(zone),
        x,
        y
      ].join(',');
    });
    const csv = [header, ...rows].join('\n');
    await window.matchtag.exportCsv(csv);
  });

  function csvEscape(value) {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // ---------- Clip playlist export (ffmpeg script) ----------

  function sanitizeFilename(str) {
    const cleaned = str.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'event';
  }

  function openClipExportModal() {
    if (!currentVideoPath || events.length === 0) return;
    clipPreRoll.value = '5';
    clipPostRoll.value = '8';
    clipExportModal.style.display = 'flex';
  }

  function closeClipExportModal() {
    clipExportModal.style.display = 'none';
  }

  btnExportClips.addEventListener('click', openClipExportModal);
  btnCancelClipExport.addEventListener('click', closeClipExportModal);

  btnConfirmClipExport.addEventListener('click', async () => {
    const preRoll = Math.max(0, parseFloat(clipPreRoll.value) || 0);
    const postRoll = Math.max(0, parseFloat(clipPostRoll.value) || 0);
    const duration = (getDuration() && isFinite(getDuration())) ? getDuration() : null;

    const clips = events.map((ev, idx) => {
      const coreStart = ev.isInterval ? ev.startTime : ev.time;
      const coreEnd = ev.isInterval ? ev.endTime : ev.time;
      const start = Math.max(0, coreStart - preRoll);
      const rawEnd = coreEnd + postRoll;
      const end = duration != null ? Math.min(duration, rawEnd) : rawEnd;
      const fileName = `clip_${String(idx + 1).padStart(3, '0')}_${sanitizeFilename(ev.label)}.mp4`;
      return { index: idx + 1, label: ev.label, detail: eventDetailText(ev), start, end, fileName };
    });

    // CSV reference
    const csvHeader = 'clip,label,details,start_timecode,end_timecode,duration_seconds,filename';
    const csvRows = clips.map((c) => [
      c.index,
      csvEscape(c.label),
      csvEscape(c.detail),
      formatTimecode(c.start, true),
      formatTimecode(c.end, true),
      (c.end - c.start).toFixed(1),
      c.fileName
    ].join(','));
    const csv = [csvHeader, ...csvRows].join('\n');

    // Windows batch script: cuts each clip with ffmpeg, then merges them into one reel
    const lines = [];
    lines.push('@echo off');
    lines.push('chcp 65001 >nul');
    lines.push('REM Generated by MatchTag. Run this from inside the folder it was saved to.');
    lines.push('setlocal enabledelayedexpansion');
    lines.push('');
    lines.push('where ffmpeg >nul 2>nul');
    lines.push('if errorlevel 1 (');
    lines.push('  echo ffmpeg was not found on this computer.');
    lines.push('  echo Install it first: run "winget install ffmpeg" in Command Prompt, then try again.');
    lines.push('  pause');
    lines.push('  exit /b 1');
    lines.push(')');
    lines.push('');
    lines.push(`set "SOURCE=${currentVideoPath}"`);
    lines.push('mkdir clips 2>nul');
    lines.push('');

    clips.forEach((c) => {
      lines.push(`echo Cutting clip ${c.index} of ${clips.length}: ${c.label}...`);
      lines.push(`ffmpeg -y -ss ${c.start.toFixed(2)} -i "%SOURCE%" -t ${(c.end - c.start).toFixed(2)} -c:v libx264 -c:a aac "clips\\${c.fileName}"`);
      lines.push('');
    });

    lines.push('echo Building the combined clip list...');
    lines.push('(');
    clips.forEach((c) => {
      lines.push(`  echo file 'clips/${c.fileName}'`);
    });
    lines.push(') > concat_list.txt');
    lines.push('');
    lines.push('echo Merging into one highlight reel...');
    lines.push('ffmpeg -y -f concat -safe 0 -i concat_list.txt -c copy highlight_reel.mp4');
    lines.push('');
    lines.push('echo Done. See highlight_reel.mp4 and the clips folder.');
    lines.push('pause');

    const script = lines.join('\r\n');

    const result = await window.matchtag.exportClipPlaylist({ csv, script });
    closeClipExportModal();
    if (result && !result.canceled) {
      window.alert(`Saved clip_playlist.csv and cut_clips.bat to:\n${result.dir}\n\nDouble-click cut_clips.bat there to build the highlight reel.`);
    }
  });

  // ---------- Dirty state, autosave, recovery, and safe close ----------
  //
  // `sessionDirty` is the single source of truth for "the current session
  // has unsaved changes". It is set true by setDirty() (called from every
  // state mutation point) and false by setClean() (called after manual
  // save, manual load, or discarding recovery). The autosave timer, the
  // dirty indicator in the top bar, and the close-protection modal all
  // key off this one flag, so they can never drift out of sync.
  //
  // The autosave file at userData/autosave.json mirrors the working
  // session. It is written (debounced) after every state mutation and
  // flushed synchronously on window close. On startup, if the file
  // exists, a recovery modal offers to restore the work.
  //
  // The autosave is cleared after a successful manual save or load so it
  // never clobbers a deliberately-saved session.
  //
  // Design notes:
  //   - `sessionDirty` drives: the dirty indicator UI, the autosave
  //     schedule, and the close-protection modal.
  //   - The debounced write (AUTOSAVE_DEBOUNCE_MS = 1500ms) coalesces
  //     rapid tagging into a single disk write.
  //   - On window close, beforeunload fires a synchronous flush so the
  //     write completes before the renderer is torn down.
  //   - If a write fails, a non-blocking toast is shown; the previous
  //     valid autosave (if any) is left intact (atomic write = temp +
  //     rename).
  //   - Safe close: the main process intercepts the OS close event and
  //     sends 'close:requested' to the renderer. If sessionDirty is true,
  //     the renderer shows the unsaved-changes modal (Save / Don't save /
  //     Cancel). The renderer then either calls closeProceed() (Save or
  //     Don't save) or does nothing (Cancel = stay open).

  let sessionDirty = false;
  let autosaveTimer = null;
  let autosaveWriteInFlight = false;
  let autosaveLastWriteFailed = false;
  let autosaveLastWriteError = '';
  let recoveryModalVisible = false;
  let pendingRecoveryData = null;
  let unsavedConfirmVisible = false;
  let pendingCloseResolution = null; // 'save' | 'discard' | null
  const AUTOSAVE_DEBOUNCE_MS = 1500;

  // ---------- Dirty-state indicator ----------

  function renderDirtyIndicator() {
    if (!dirtyIndicator) return;
    if (sessionDirty) {
      dirtyIndicator.classList.remove('dirty-clean');
      dirtyIndicator.classList.add('dirty-dirty');
      if (dirtyLabel) dirtyLabel.textContent = 'Unsaved';
      dirtyIndicator.title = 'You have unsaved changes. Save before closing to keep them.';
    } else {
      dirtyIndicator.classList.remove('dirty-dirty');
      dirtyIndicator.classList.add('dirty-clean');
      if (dirtyLabel) dirtyLabel.textContent = 'Saved';
      dirtyIndicator.title = 'No unsaved changes.';
    }
  }

  // setDirty(): mark the session as having unsaved changes. Called from
  // every state mutation point. Also schedules the debounced autosave.
  // Idempotent: calling it when already dirty just reschedules the
  // autosave (effectively resetting the debounce timer).
  function setDirty() {
    if (recoveryModalVisible) return; // don't touch state while recovery prompt is up
    if (unsavedConfirmVisible) return; // don't touch state while close-confirm is up
    const wasClean = !sessionDirty;
    sessionDirty = true;
    if (wasClean) renderDirtyIndicator();
    scheduleAutosave();
  }

  // setClean(): mark the session as clean (no unsaved changes). Used
  // after manual save, manual load, or discarding recovery. Cancels any
  // pending debounced autosave and updates the indicator.
  function setClean() {
    const wasDirty = sessionDirty;
    sessionDirty = false;
    clearAutosaveTimer();
    if (wasDirty) renderDirtyIndicator();
  }

  // Build the data payload that gets written to autosave.json. Same shape
  // as a manual session save, plus a single __savedAt ISO timestamp so the
  // recovery modal can show when the work was last preserved.
  function buildAutosaveData() {
    return {
      __savedAt: new Date().toISOString(),
      videoPath: currentVideoPath,
      tags,
      events,
      squad,
      matchInfo,
      matchClock
    };
  }

  // Decide whether the current state is worth autosaving. If everything is
  // empty/default, there's nothing to recover, so we skip the write and
  // instead clear any stale autosave from a previous session.
  function hasAutosavableWork() {
    if (events.length > 0) return true;
    if (currentVideoPath) return true;
    if (tags.length !== DEFAULT_TAGS_LENGTH) return true;
    if (JSON.stringify(matchInfo) !== JSON.stringify(blankMatchInfo())) return true;
    // Check matchClock state — if the match has started, the clock is running,
    // the score has changed, a team/player is selected, a sequence is active,
    // or the video offset is non-zero, there IS autosavable work.
    if (matchClock) {
      if (matchClock.clockRunning) return true;
      if (matchClock.clockBaseSeconds > 0) return true;
      if (matchClock.period !== 'PRE_MATCH') return true;
      if (matchClock.scoreFor > 0 || matchClock.scoreAgainst > 0) return true;
      if (matchClock.selectedPlayerId) return true;
      if (matchClock.activeSequenceId) return true;
      if (matchClock.videoSyncOffset !== 0) return true;
    }
    return false;
  }

  function clearAutosaveTimer() {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  }

  // Legacy aliases kept so the existing mutation hooks (which call
  // markAutosaveDirty / markAutosaveClean) continue to work. They now
  // delegate to the unified setDirty / setClean, so the dirty indicator
  // and close protection stay in sync with the autosave.
  function markAutosaveDirty() { setDirty(); }
  function markAutosaveClean() { setClean(); }

  // Schedule a debounced autosave. Multiple rapid mutations coalesce into
  // a single write to avoid hammering the disk during fast tagging.
  function scheduleAutosave() {
    clearAutosaveTimer();
    if (!sessionDirty) return;
    if (!hasAutosavableWork()) {
      // Dirty but no actual work — clear any stale autosave from a previous
      // session. Async delete; failure is non-fatal.
      window.matchtag.autosaveDelete().catch(() => {});
      return;
    }
    autosaveTimer = setTimeout(performAutosave, AUTOSAVE_DEBOUNCE_MS);
  }

  // Actually write the autosave. Async. Updates the failure flag for the
  // toast notification. Never throws — write failures are surfaced via the
  // toast, not as exceptions.
  async function performAutosave() {
    autosaveTimer = null;
    if (autosaveWriteInFlight) {
      // Another write is in progress; reschedule for later.
      autosaveTimer = setTimeout(performAutosave, AUTOSAVE_DEBOUNCE_MS);
      return;
    }
    autosaveWriteInFlight = true;
    const data = buildAutosaveData();
    let result;
    try {
      result = await window.matchtag.autosaveWrite(data);
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    autosaveWriteInFlight = false;
    if (result && result.ok) {
      if (autosaveLastWriteFailed) {
        autosaveLastWriteFailed = false;
        autosaveLastWriteError = '';
        hideAutosaveToast();
      }
    } else {
      const err = (result && result.error) || 'Unknown error';
      if (!autosaveLastWriteFailed || err !== autosaveLastWriteError) {
        autosaveLastWriteFailed = true;
        autosaveLastWriteError = err;
        showAutosaveToast('Autosave failed: ' + err + '. Please save your work manually.');
      }
    }
  }

  // Clear the autosave entirely (after manual save or load). Cancels any
  // pending debounced write and deletes the autosave file.
  async function clearAutosave() {
    clearAutosaveTimer();
    autosaveLastWriteFailed = false;
    autosaveLastWriteError = '';
    hideAutosaveToast();
    try {
      await window.matchtag.autosaveDelete();
    } catch (e) { /* best effort */ }
  }

  // Synchronous flush for the beforeunload handler. The renderer is about
  // to be torn down, so we cannot use async IPC here. If there's unsaved
  // work, write it; otherwise clear any stale autosave.
  //
  // This runs as a safety net for hard kills (power loss, kill -9). For
  // graceful closes via the OS close button, the main process intercepts
  // the close via the 'close' event and the renderer shows the unsaved-
  // changes modal instead — see the safe-close wiring below. beforeunload
  // still fires in both cases (the renderer is going down), so this
  // flush is the last line of defense.
  function flushAutosaveSync() {
    if (recoveryModalVisible) return; // don't touch autosave while recovery prompt is up
    clearAutosaveTimer();
    if (sessionDirty && hasAutosavableWork()) {
      const data = buildAutosaveData();
      window.matchtag.autosaveFlushSync(data);
    } else {
      // No unsaved work — clear any stale autosave so it doesn't surface a
      // spurious recovery prompt next startup.
      window.matchtag.autosaveFlushSync(null);
    }
  }

  function showAutosaveToast(message) {
    if (!autosaveToast || !autosaveToastText) return;
    autosaveToastText.textContent = message;
    autosaveToast.style.display = 'flex';
  }

  function hideAutosaveToast() {
    if (!autosaveToast) return;
    autosaveToast.style.display = 'none';
  }

  // ---------- Recovery check (on startup) ----------

  async function checkForRecoverableAutosave() {
    let autosave = null;
    try {
      autosave = await window.matchtag.autosaveRead();
    } catch (e) {
      return; // can't read, can't recover
    }
    if (!autosave) return; // no autosave, no recovery needed
    showRecoveryModal(autosave);
  }

  function showRecoveryModal(autosave) {
    pendingRecoveryData = autosave;

    // Format the saved-at timestamp
    let savedAtStr = 'unknown time';
    if (autosave.__savedAt) {
      try {
        const d = new Date(autosave.__savedAt);
        if (!isNaN(d.getTime())) {
          savedAtStr = d.toLocaleString();
        }
      } catch (e) { /* ignore */ }
    }

    // Format the video filename
    let videoStr = 'No video';
    if (autosave.videoPath) {
      const basename = autosave.videoPath.split(/[\\/]/).pop();
      videoStr = basename || autosave.videoPath;
      if (autosave.__videoExists === false) {
        videoStr += ' (file not found)';
      }
    }

    // Count events
    const eventCount = Array.isArray(autosave.events) ? autosave.events.length : 0;

    // Pre-recovery warning: cross-check the autosave's events against the
    // currently loaded squad (the local squad wins over the autosave's squad
    // snapshot, so references can go missing if the squad changed since the
    // autosave was written). Surfaced here so the analyst knows BEFORE
    // choosing whether to recover.
    const missingRefs = window.Integrity.findMissingPlayerRefs(
      autosave.events,
      squad.map((p) => String(p.id))
    );
    let missingPlayersRow = '';
    if (missingRefs.affectedEvents > 0) {
      missingPlayersRow = `
        <div class="detail-row">
          <span class="detail-label">⚠ Missing players:</span>
          <span class="detail-value">${missingRefs.affectedEvents} recovered ${missingRefs.affectedEvents === 1 ? 'event' : 'events'} reference${missingRefs.affectedEvents === 1 ? 's' : ''} ${missingRefs.missingIds.length === 1 ? 'a player' : missingRefs.missingIds.length + ' players'} not currently in your squad.</span>
        </div>
      `;
    }

    if (recoveryDetails) {
      recoveryDetails.innerHTML = `
        <div class="detail-row">
          <span class="detail-label">Last preserved:</span>
          <span class="detail-value">${escapeHtml(savedAtStr)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Video:</span>
          <span class="detail-value">${escapeHtml(videoStr)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Events:</span>
          <span class="detail-value">${eventCount}</span>
        </div>
        ${missingPlayersRow}
      `;
    }

    recoveryModalVisible = true;
    recoveryModal.style.display = 'flex';
  }

  function closeRecoveryModal() {
    recoveryModal.style.display = 'none';
    recoveryModalVisible = false;
  }

  // Restore state from the autosave. Similar to loadSession, but:
  //   - We don't clear the autosave file (keep it as a safety net until
  //     the analyst makes a change that triggers a new autosave, or until
  //     they manually save).
  //   - We use the local squad (already loaded from squad.json on startup)
  //     rather than the autosave's squad snapshot, because the local
  //     squad.json is always at least as up-to-date (the squad is
  //     auto-persisted on every change).
  //   - Because the local squad may have changed since the autosave was
  //     written, we cross-check every player reference in the recovered
  //     events against the current squad and warn explicitly when events
  //     reference missing players (instead of silently showing "Unknown
  //     player" later). The current squad is never replaced; event ids and
  //     event data are preserved untouched.
  async function recoverFromAutosave(autosave) {
    // Restore tags (only if the autosave's tags array is non-empty;
    // otherwise keep the defaults, same as loadSession).
    if (Array.isArray(autosave.tags) && autosave.tags.length) {
      tags = autosave.tags;
    }

    // Restore events (defensive null-coalescing, same as loadSession).
    if (Array.isArray(autosave.events)) {
      events = autosave.events.map((ev) => ({
        ...ev,
        subtype: ev.subtype ?? null,
        qualifiers: ev.qualifiers ?? {},
        location: ev.location ?? null,
        playerId: ev.playerId ?? null,
        playerOffId: ev.playerOffId ?? null,
        playerOnId: ev.playerOnId ?? null,
        side: ev.side ?? null,
        isInterval: ev.isInterval ?? false
      }));
    } else {
      events = [];
    }
    nextEventId = events.reduce((max, ev) => Math.max(max, (ev.id || 0) + 1), 1);

    // Reconciliation check: recovered events may reference players that are
    // no longer in the current squad (the squad can change between the
    // autosave being written and the recovery). Detect it now and surface an
    // explicit warning — the events (and their ids) are restored untouched.
    const missingRefs = window.Integrity.findMissingPlayerRefs(
      events,
      squad.map((p) => String(p.id))
    );
    if (missingRefs.affectedEvents > 0) {
      showAutosaveToast(
        missingRefs.affectedEvents + ' recovered ' + (missingRefs.affectedEvents === 1 ? 'event' : 'events') +
        ' reference' + (missingRefs.affectedEvents === 1 ? 's' : '') +
        ' ' + (missingRefs.missingIds.length === 1 ? 'a player' : missingRefs.missingIds.length + ' players') +
        ' not currently in your squad.'
      );
    }

    activeIntervals = {};

    // Restore matchInfo (merged onto blank, same as loadSession).
    if (autosave.matchInfo && typeof autosave.matchInfo === 'object') {
      matchInfo = { ...blankMatchInfo(), ...autosave.matchInfo };
    } else {
      matchInfo = blankMatchInfo();
    }

    // Restore video (if the path is still valid). loadVideoFromPath will
    // call markAutosaveDirty() + scheduleAutosave() — that's fine, because
    // the recovered work IS unsaved (dirty = true is correct).
    if (autosave.videoPath && autosave.videoUrl) {
      loadVideoFromPath(autosave.videoPath, autosave.videoUrl);
    }

    lastLoggedEventId = null;
    updateUndoButton();

    eventSearchTerm = '';
    eventSearchInput.value = '';
    eventTypeFilterValue = '__all__';
    populateEventTypeFilter();

    renderTagButtons();
    renderEventList();
    renderMatchSummary();

    // Restore match clock (merged onto blank; stopped on recovery)
    if (autosave.matchClock && typeof autosave.matchClock === 'object') {
      matchClock = { ...blankMatchClock(), ...autosave.matchClock };
      matchClock.clockRunning = false;
      matchClock.clockStartedAt = null;
    }
    renderMatchClock();
    renderTeamSelector();
    renderPlayerSelector();
    renderSequenceControls();
    renderScoreboard();
    renderVideoOffset();

    // The recovered work is unsaved — mark dirty so any subsequent change
    // triggers a fresh autosave, and so closing without saving preserves
    // the recovery file.
    markAutosaveDirty();
  }

  // Wire up the recovery modal buttons
  if (btnRecoverAutosave) {
    btnRecoverAutosave.addEventListener('click', async () => {
      const data = pendingRecoveryData;
      closeRecoveryModal();
      if (data) {
        await recoverFromAutosave(data);
        pendingRecoveryData = null;
      }
    });
  }

  if (btnDiscardRecovery) {
    btnDiscardRecovery.addEventListener('click', async () => {
      closeRecoveryModal();
      pendingRecoveryData = null;
      // Discard = delete the autosave file and start fresh.
      setClean();
      await clearAutosave();
    });
  }

  // Wire up the autosave toast close button
  if (autosaveToastClose) {
    autosaveToastClose.addEventListener('click', hideAutosaveToast);
  }

  // ---------- Safe-close protection ----------
  //
  // The main process intercepts the OS close (X button, Alt+F4, taskbar
  // close) and sends 'close:requested' to the renderer instead of closing
  // immediately. The renderer decides what to do:
  //
  //   - If the session is clean (sessionDirty === false), proceed with the
  //     close immediately. The beforeunload handler will still flush the
  //     autosave (which clears any stale autosave so it doesn't surface a
  //     spurious recovery prompt next startup).
  //
  //   - If the session is dirty, show the unsaved-changes modal with three
  //     choices:
  //       Save       → trigger the manual save flow, then proceed with close
  //       Don't save → discard unsaved work (clear the autosave so the
  //                    recovery modal doesn't show next startup), then
  //                    proceed with close
  //       Cancel     → do nothing; the window stays open
  //
  // The 'close:proceed' IPC tells the main process to set forceClose and
  // call close() again — this time the main's 'close' handler sees
  // forceClose and lets the close proceed (which fires beforeunload →
  // flushAutosaveSync → window tears down).

  function showUnsavedConfirmModal() {
    unsavedConfirmVisible = true;
    pendingCloseResolution = null;
    if (unsavedConfirmModal) unsavedConfirmModal.style.display = 'flex';
  }

  function hideUnsavedConfirmModal() {
    unsavedConfirmVisible = false;
    if (unsavedConfirmModal) unsavedConfirmModal.style.display = 'none';
  }

  // Called when the main process intercepts the OS close. Decides whether
  // to show the unsaved-changes modal or proceed immediately.
  function handleCloseRequested() {
    if (recoveryModalVisible) {
      // Recovery modal is up — block the close. The analyst must first
      // decide whether to recover or discard the autosaved work.
      return;
    }
    if (!sessionDirty) {
      // Clean — proceed immediately. The beforeunload handler will flush
      // the autosave (clearing any stale autosave so it doesn't surface
      // a spurious recovery prompt next startup).
      window.matchtag.closeProceed();
      return;
    }
    // Dirty — show the modal and let the user decide.
    showUnsavedConfirmModal();
  }

  if (btnUnsavedCancel) {
    btnUnsavedCancel.addEventListener('click', () => {
      // Cancel = stay open. Don't proceed with the close.
      hideUnsavedConfirmModal();
    });
  }

  if (btnUnsavedDiscard) {
    btnUnsavedDiscard.addEventListener('click', async () => {
      hideUnsavedConfirmModal();
      // Discard unsaved work: clear the dirty flag, delete the autosave
      // so the recovery modal doesn't show next startup, then proceed
      // with the close.
      setClean();
      await clearAutosave();
      window.matchtag.closeProceed();
    });
  }

  if (btnUnsavedSave) {
    btnUnsavedSave.addEventListener('click', async () => {
      hideUnsavedConfirmModal();
      // Save: trigger the manual save flow. If the user cancels the save
      // dialog, stay open (don't proceed with the close). If the save
      // succeeds, proceed with the close.
      const saved = await saveSession();
      if (saved) {
        window.matchtag.closeProceed();
      }
      // If saved === false (user canceled the save dialog), the window
      // stays open. The session is still dirty, so closing again will
      // re-prompt.
    });
  }

  // Wire up the main process's 'close:requested' message.
  window.matchtag.onCloseRequested(() => {
    handleCloseRequested();
  });

  // Synchronous flush on window close. The sendSync IPC completes the
  // write before the renderer is torn down, so no work is lost on
  // graceful close. (For hard crashes, the last debounced autosave is
  // the safety net.)
  //
  // Note: when the user clicks "Save" or "Don't save" in the unsaved-
  // changes modal, the close proceeds via closeProceed() → main sets
  // forceClose → close event fires → beforeunload → this flush runs.
  // In the "Save" case the session is already clean (setClean was called
  // by saveSession), so the flush deletes any stale autosave. In the
  // "Don't save" case the session is also clean (setClean was called by
  // the discard handler), so the flush also deletes the autosave. In the
  // hard-kill case (no modal shown), the session is still dirty and the
  // flush writes the autosave so recovery is offered next startup.
  window.addEventListener('beforeunload', () => {
    flushAutosaveSync();
  });

  // ---------- Wire up match clock buttons ----------

  const btnClockStart = document.getElementById('btnClockStart');
  const btnClockPause = document.getElementById('btnClockPause');
  const btnClockEndHalf = document.getElementById('btnClockEndHalf');
  const btnClockNextHalf = document.getElementById('btnClockNextHalf');
  if (btnClockStart) btnClockStart.addEventListener('click', startMatchClock);
  if (btnClockPause) btnClockPause.addEventListener('click', pauseMatchClock);
  if (btnClockEndHalf) btnClockEndHalf.addEventListener('click', endHalf);
  if (btnClockNextHalf) btnClockNextHalf.addEventListener('click', startNextHalf);

  // ---------- Team selector, player selector, sequence, video sync, touchline, CSV ----------

  function renderTeamSelector() {
    const btnOur = document.getElementById('btnTeamOur');
    const btnOpp = document.getElementById('btnTeamOpponent');
    if (btnOur) btnOur.classList.toggle('active', matchClock.selectedTeam === 'our');
    if (btnOpp) btnOpp.classList.toggle('active', matchClock.selectedTeam === 'opponent');
  }

  function renderPlayerSelector() {
    const sel = document.getElementById('selectedPlayerSelect');
    if (!sel) return;
    const current = matchClock.selectedPlayerId || '';
    sel.innerHTML = ['<option value="">— None —</option>'].concat(
      squad.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.number ? `${p.number} ${p.name}` : p.name)}</option>`)
    ).join('');
    sel.value = current;
  }

  function renderSequenceControls() {
    const btnStart = document.getElementById('btnStartSequence');
    const btnEnd = document.getElementById('btnEndSequence');
    const display = document.getElementById('activeSequenceDisplay');
    if (btnStart) btnStart.disabled = !!matchClock.activeSequenceId;
    if (btnEnd) btnEnd.disabled = !matchClock.activeSequenceId;
    if (display) display.textContent = matchClock.activeSequenceId || '';
  }

  function selectTeam(team) { matchClock.selectedTeam = team; renderTeamSelector(); markAutosaveDirty(); }
  function selectPlayer(playerId) { matchClock.selectedPlayerId = playerId || null; markAutosaveDirty(); }
  function startSequence() {
    if (matchClock.activeSequenceId) return;
    matchClock.activeSequenceId = `SEQ-${String(matchClock.nextSequenceNumber++).padStart(3, '0')}`;
    renderSequenceControls(); markAutosaveDirty();
  }
  function endSequence() {
    if (!matchClock.activeSequenceId) return;
    matchClock.activeSequenceId = null;
    renderSequenceControls(); markAutosaveDirty();
  }

  // Wire up desktop controls
  const btnTeamOur = document.getElementById('btnTeamOur');
  const btnTeamOpponent = document.getElementById('btnTeamOpponent');
  const selectedPlayerSelect = document.getElementById('selectedPlayerSelect');
  const btnStartSequence = document.getElementById('btnStartSequence');
  const btnEndSequence = document.getElementById('btnEndSequence');
  if (btnTeamOur) btnTeamOur.addEventListener('click', () => selectTeam('our'));
  if (btnTeamOpponent) btnTeamOpponent.addEventListener('click', () => selectTeam('opponent'));
  if (selectedPlayerSelect) selectedPlayerSelect.addEventListener('change', () => selectPlayer(selectedPlayerSelect.value));
  if (btnStartSequence) btnStartSequence.addEventListener('click', startSequence);
  if (btnEndSequence) btnEndSequence.addEventListener('click', endSequence);

  // ---------- Video sync offset UI ----------
  // Convention: matchTime = videoTime + videoSyncOffset
  const videoOffsetInput = document.getElementById('videoOffsetInput');
  function formatOffset(seconds) {
    const sign = seconds >= 0 ? '+' : '-';
    const abs = Math.abs(seconds);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  }
  function parseOffset(str) {
    if (!str) return 0; str = str.trim();
    let sign = 1;
    if (str.startsWith('+')) str = str.slice(1);
    else if (str.startsWith('-')) { sign = -1; str = str.slice(1); }
    str = str.trim();
    if (str.includes(':')) { const parts = str.split(':'); const m = parseInt(parts[0], 10); const s = parseInt(parts[1], 10); if (!isNaN(m) && !isNaN(s)) return sign * (m * 60 + s); }
    const n = parseInt(str, 10); if (!isNaN(n)) return sign * n;
    return 0;
  }
  function renderVideoOffset() { if (videoOffsetInput) videoOffsetInput.value = formatOffset(matchClock.videoSyncOffset); }
  function setVideoOffset(seconds) { matchClock.videoSyncOffset = seconds; renderVideoOffset(); renderMatchClock(); markAutosaveDirty(); }
  function adjustVideoOffset(delta) { setVideoOffset(matchClock.videoSyncOffset + delta); }

  const btnOffsetMinus10 = document.getElementById('btnOffsetMinus10');
  const btnOffsetMinus1 = document.getElementById('btnOffsetMinus1');
  const btnOffsetPlus1 = document.getElementById('btnOffsetPlus1');
  const btnOffsetPlus10 = document.getElementById('btnOffsetPlus10');
  const btnSetOffset = document.getElementById('btnSetOffset');
  if (btnOffsetMinus10) btnOffsetMinus10.addEventListener('click', () => adjustVideoOffset(-10));
  if (btnOffsetMinus1) btnOffsetMinus1.addEventListener('click', () => adjustVideoOffset(-1));
  if (btnOffsetPlus1) btnOffsetPlus1.addEventListener('click', () => adjustVideoOffset(1));
  if (btnOffsetPlus10) btnOffsetPlus10.addEventListener('click', () => adjustVideoOffset(10));
  if (btnSetOffset) btnSetOffset.addEventListener('click', () => { if (videoOffsetInput) setVideoOffset(parseOffset(videoOffsetInput.value)); });
  if (videoOffsetInput) videoOffsetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setVideoOffset(parseOffset(videoOffsetInput.value)); videoOffsetInput.blur(); } });

  // ---------- Expanded CSV export ----------
  function buildFullAnalysisCsv() {
    const header = ['Match ID','Date','Competition','Home Team','Away Team','Opponent','Period','Official Minute','Second','Match Seconds','Match Time','Video Time','Team','Primary Player ID','Secondary Player ID','Category','Event','Label','Subtype','Outcome','Phase','Pitch Zone','X','Y','Third','Channel','Score For Before','Score Against Before','Score For After','Score Against After','Score State','Sequence ID','Note','Created At','Updated At'];
    const matchId = matchInfo.date ? `${matchInfo.date}_${(matchInfo.opponent || 'unknown').replace(/\s+/g, '_')}` : '';
    const homeTeam = matchInfo.homeAway === 'home' ? 'Us' : (matchInfo.opponent || '');
    const awayTeam = matchInfo.homeAway === 'away' ? 'Us' : (matchInfo.opponent || '');
    const rows = events.map((ev) => {
      const zone = ev.location ? locationZone(ev.location.x, ev.location.y) : '';
      const tp = zone.split(' · ');
      const sfb = ev.scoreForBefore ?? 0;
      const sab = ev.scoreAgainstBefore ?? 0;
      let scoreState = 'DRAW'; if (sfb > sab) scoreState = 'WINNING'; else if (sfb < sab) scoreState = 'LOSING';
      const qualStr = Object.entries(ev.qualifiers || {}).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('; ');
      return [csvEscape(matchId),csvEscape(matchInfo.date||''),csvEscape(matchInfo.competition||''),csvEscape(homeTeam),csvEscape(awayTeam),csvEscape(matchInfo.opponent||''),csvEscape(ev.period||''),ev.officialMinute??'',ev.second??'',ev.matchSeconds??'',ev.matchTime!=null?ev.matchTime.toFixed(1):'',ev.videoTime!=null?ev.videoTime.toFixed(1):'',csvEscape(ev.team||''),csvEscape(ev.playerId||''),csvEscape(ev.playerOffId||''),csvEscape(ev.label||''),csvEscape(ev.label||''),csvEscape(ev.label||''),csvEscape(ev.subtype||''),csvEscape(qualStr),'',csvEscape(zone),ev.location?(ev.location.x*100).toFixed(1):'',ev.location?(ev.location.y*100).toFixed(1):'',csvEscape(tp[0]||''),csvEscape(tp[1]||''),sfb,sab,ev.scoreForAfter??'',ev.scoreAgainstAfter??'',csvEscape(scoreState),csvEscape(ev.sequenceId||''),'','',''].join(',');
    });
    return [header.join(','), ...rows].join('\n');
  }

  if (btnExportCsv) {
    btnExportCsv.title = 'Click: Standard CSV | Shift+Click: Full Analysis CSV';
    btnExportCsv.addEventListener('click', (e) => {
      if (e.shiftKey) { window.matchtag.exportCsv(buildFullAnalysisCsv()); }
    });
  }

  // ---------- Save status for Touchline ----------
  function renderTouchlineSaveStatus(status) {
    const el = document.getElementById('touchlineSaveStatus');
    if (!el) return;
    if (status === 'saved') { el.textContent = '✓ SAVED'; el.className = 'save-status-saved'; }
    else if (status === 'saving') { el.textContent = 'SAVING...'; el.className = 'save-status-saving'; }
    else if (status === 'error') { el.textContent = '⚠ SAVE ERROR'; el.className = 'save-status-error'; }
  }

  // ---------- Touchline Mode ----------
  let touchlineMode = false;
  const touchlineOverlay = document.getElementById('touchlineOverlay');
  const btnTouchlineToggle = document.getElementById('btnTouchlineToggle');
  const btnExitTouchline = document.getElementById('btnExitTouchline');
  const QUICK_TAGS = ['Shot','Chance','Cross','Key Pass','Press','Press Win','Turnover','Recovery','Interception','Duel','Positive Transition','Negative Transition','Goal','Card','Sub'];

  function enterTouchlineMode() { touchlineMode = true; if (touchlineOverlay) touchlineOverlay.style.display = 'flex'; if (btnTouchlineToggle) btnTouchlineToggle.textContent = 'Desktop Mode'; renderTouchlineQuickTags(); renderTouchlineAll(); }
  function exitTouchlineMode() { touchlineMode = false; if (touchlineOverlay) touchlineOverlay.style.display = 'none'; if (btnTouchlineToggle) btnTouchlineToggle.textContent = 'Touchline Mode'; }
  function toggleTouchlineMode() { if (touchlineMode) exitTouchlineMode(); else enterTouchlineMode(); }

  function renderTouchlineQuickTags() {
    const c = document.getElementById('touchlineQuickTags'); if (!c) return; c.innerHTML = '';
    QUICK_TAGS.forEach((label) => {
      const btn = document.createElement('button');
      btn.className = 'touchline-tag-btn' + (label === 'Goal' ? ' goal-tag' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        let tag = tags.find((t) => t.label === label);
        if (!tag) { tag = { label: label, key: '' }; tags.push(tag); renderTagButtons(); populateEventTypeFilter(); }
        handleTagPress(tag); renderTouchlineAll();
      });
      c.appendChild(btn);
    });
  }

  function renderTouchlineAll() {
    if (!touchlineMode) return;
    const seconds = getCurrentMatchSeconds();
    const tlClock = document.getElementById('touchlineClock');
    const tlPeriod = document.getElementById('touchlinePeriod');
    if (tlClock) tlClock.textContent = formatMatchClock(seconds, matchClock.period);
    if (tlPeriod) tlPeriod.textContent = PERIOD_LABELS[matchClock.period] || matchClock.period;
    const tlScore = document.getElementById('touchlineScore');
    if (tlScore) tlScore.textContent = `${matchClock.scoreFor} — ${matchClock.scoreAgainst}`;
    const tlState = document.getElementById('touchlineScoreState');
    if (tlState) { let s='draw',l='DRAW'; if(matchClock.scoreFor>matchClock.scoreAgainst){s='winning';l='WINNING';} else if(matchClock.scoreFor<matchClock.scoreAgainst){s='losing';l='LOSING';} tlState.textContent=l; tlState.className='touchline-score-state '+s; }
    const tlOur=document.getElementById('tlBtnTeamOur'), tlOpp=document.getElementById('tlBtnTeamOpp');
    if(tlOur)tlOur.classList.toggle('active',matchClock.selectedTeam==='our');
    if(tlOpp)tlOpp.classList.toggle('active',matchClock.selectedTeam==='opponent');
    const tlPS=document.getElementById('tlPlayerSelect');
    if(tlPS){const cur=matchClock.selectedPlayerId||'';tlPS.innerHTML=['<option value="">— None —</option>'].concat(squad.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.number?`${p.number} ${p.name}`:p.name)}</option>`)).join('');tlPS.value=cur;}
    const tlSS=document.getElementById('tlBtnStartSeq'),tlES=document.getElementById('tlBtnEndSeq'),tlAS=document.getElementById('tlActiveSeq');
    if(tlSS)tlSS.disabled=!!matchClock.activeSequenceId; if(tlES)tlES.disabled=!matchClock.activeSequenceId; if(tlAS)tlAS.textContent=matchClock.activeSequenceId||'';
    const tlBS=document.getElementById('tlBtnStart'),tlBP=document.getElementById('tlBtnPause'),tlBEH=document.getElementById('tlBtnEndHalf'),tlBNH=document.getElementById('tlBtnNextHalf');
    if(tlBS)tlBS.disabled=matchClock.clockRunning||matchClock.period==='FT'; if(tlBP)tlBP.disabled=!matchClock.clockRunning;
    if(tlBEH)tlBEH.disabled=matchClock.period==='PRE_MATCH'||matchClock.period==='HT'||matchClock.period==='FT'||matchClock.period==='ET_HT';
    if(tlBNH){tlBNH.disabled=!(matchClock.period==='HT'||matchClock.period==='FT'||matchClock.period==='ET_HT');if(matchClock.period==='HT')tlBNH.textContent='Start 2nd Half';else if(matchClock.period==='FT')tlBNH.textContent='Start Extra Time';else if(matchClock.period==='ET_HT')tlBNH.textContent='Start ET 2nd Half';else tlBNH.textContent='Next Half';}
    const tlBU=document.getElementById('tlBtnUndo');
    if(tlBU)tlBU.disabled=lastLoggedEventId==null||!events.some(e=>e.id===lastLoggedEventId);
    const tlR=document.getElementById('touchlineRecentEvents');
    if(tlR){const recent=events.slice(-10).reverse();tlR.innerHTML=recent.map(ev=>{const p=resolvePlayer(ev.playerId);const pl=p?(p.number?`#${p.number} ${p.name}`:p.name):'';const tl=ev.team==='opponent'?'OPP':'';return `<div class="touchline-recent-item" data-event-id="${ev.id}"><span class="tl-time">${formatMatchClock(ev.matchTime||ev.time,ev.period)}</span><span class="tl-main">${escapeHtml(tl?tl+' '+ev.label:ev.label)}</span><span class="tl-player">${escapeHtml(pl)}</span></div>`;}).join('');tlR.querySelectorAll('.touchline-recent-item').forEach(item=>{item.addEventListener('click',()=>{const id=parseInt(item.dataset.eventId,10);const ev=events.find(e=>e.id===id);if(ev&&currentVideoPath&&ev.videoTime!==null)seekTo(ev.videoTime);});});}
    const tlPitch=document.getElementById('touchlinePitchSvg'),tlReadout=document.getElementById('touchlinePitchReadout');
    if(tlPitch){tlPitch.innerHTML=pitchMarkingsSvg();const last=[...events].reverse().find(e=>e.location);if(last&&last.location){tlPitch.innerHTML+=`<circle class="pitch-marker" cx="${(last.location.x*700).toFixed(1)}" cy="${(last.location.y*450).toFixed(1)}" r="8"/>`;if(tlReadout)tlReadout.textContent=locationZone(last.location.x,last.location.y);}else{if(tlReadout)tlReadout.textContent='No location set';}}
  }

  if (btnTouchlineToggle) btnTouchlineToggle.addEventListener('click', toggleTouchlineMode);
  if (btnExitTouchline) btnExitTouchline.addEventListener('click', exitTouchlineMode);
  const tlBtnStart=document.getElementById('tlBtnStart'),tlBtnPause=document.getElementById('tlBtnPause'),tlBtnEndHalf=document.getElementById('tlBtnEndHalf'),tlBtnNextHalf=document.getElementById('tlBtnNextHalf');
  if(tlBtnStart)tlBtnStart.addEventListener('click',()=>{startMatchClock();renderTouchlineAll();});
  if(tlBtnPause)tlBtnPause.addEventListener('click',()=>{pauseMatchClock();renderTouchlineAll();});
  if(tlBtnEndHalf)tlBtnEndHalf.addEventListener('click',()=>{endHalf();renderTouchlineAll();});
  if(tlBtnNextHalf)tlBtnNextHalf.addEventListener('click',()=>{startNextHalf();renderTouchlineAll();});
  const tlBtnTeamOur=document.getElementById('tlBtnTeamOur'),tlBtnTeamOpp=document.getElementById('tlBtnTeamOpp'),tlPlayerSelect=document.getElementById('tlPlayerSelect'),tlBtnStartSeq=document.getElementById('tlBtnStartSeq'),tlBtnEndSeq=document.getElementById('tlBtnEndSeq'),tlBtnUndo=document.getElementById('tlBtnUndo');
  if(tlBtnTeamOur)tlBtnTeamOur.addEventListener('click',()=>{selectTeam('our');renderTouchlineAll();});
  if(tlBtnTeamOpp)tlBtnTeamOpp.addEventListener('click',()=>{selectTeam('opponent');renderTouchlineAll();});
  if(tlPlayerSelect)tlPlayerSelect.addEventListener('change',()=>{selectPlayer(tlPlayerSelect.value);renderTouchlineAll();});
  if(tlBtnStartSeq)tlBtnStartSeq.addEventListener('click',()=>{startSequence();renderTouchlineAll();});
  if(tlBtnEndSeq)tlBtnEndSeq.addEventListener('click',()=>{endSequence();renderTouchlineAll();});
  if(tlBtnUndo)tlBtnUndo.addEventListener('click',()=>{undoLastTag();renderTouchlineAll();});
  const tlPitchSvg=document.getElementById('touchlinePitchSvg');
  if(tlPitchSvg)tlPitchSvg.addEventListener('click',(e)=>{if(!lastLoggedEventId)return;const ev=events.find(x=>x.id===lastLoggedEventId);if(!ev)return;const rect=tlPitchSvg.getBoundingClientRect();ev.location={x:clamp01((e.clientX-rect.left)/rect.width),y:clamp01((e.clientY-rect.top)/rect.height)};markAutosaveDirty();renderTouchlineAll();});

  // ---------- Wire up open-video buttons ----------

  btnOpenVideo.addEventListener('click', openVideo);
  btnOpenVideoEmpty.addEventListener('click', openVideo);

  // ---------- Init ----------

  video.style.display = 'none';
  renderTagButtons();
  populateEventTypeFilter();
  renderEventList();
  updateUndoButton();
  renderMatchSummary();
  renderDirtyIndicator();
  renderMatchClock();
  startClockDisplayTimer();
  renderTeamSelector();
  renderPlayerSelector();
  renderSequenceControls();
  renderScoreboard();
  renderVideoOffset();

  window.matchtag.loadSquad()
    .then((loaded) => {
      if (Array.isArray(loaded) && loaded.length) {
        squad = loaded;
        const maxId = squad.reduce((max, p) => {
          const num = parseInt(String(p.id).replace('player_', ''), 10);
          return isNaN(num) ? max : Math.max(max, num);
        }, 0);
        nextPlayerId = maxId + 1;
      }
      renderPlayerSelector();
    })
    .catch(() => {
      // no squad file yet - fine, start empty
    })
    .finally(() => {
      // Now that the squad is loaded (or we've decided to start empty),
      // check for a recoverable autosave. This runs after the squad load
      // so that recovery uses the local squad (which is always at least
      // as up-to-date as the autosave's squad snapshot).
      checkForRecoverableAutosave();
    });
})();
