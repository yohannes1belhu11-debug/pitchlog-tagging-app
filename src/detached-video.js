(() => {
  'use strict';

  const video = document.getElementById('video');

  window.detachedVideo.onLoad((state) => {
    video.src = state.url;

    const applyInitialState = () => {
      video.currentTime = state.currentTime || 0;
      video.playbackRate = state.playbackRate || 1;
      if (!state.paused) video.play();
      video.removeEventListener('loadedmetadata', applyInitialState);
    };
    video.addEventListener('loadedmetadata', applyInitialState);
  });

  window.detachedVideo.onCommand((cmd) => {
    if (cmd.type === 'play') {
      video.play();
    } else if (cmd.type === 'pause') {
      video.pause();
    } else if (cmd.type === 'seek') {
      video.currentTime = cmd.value;
    } else if (cmd.type === 'setRate') {
      video.playbackRate = cmd.value;
    }
  });

  function reportState() {
    window.detachedVideo.reportState({
      currentTime: video.currentTime,
      duration: isFinite(video.duration) ? video.duration : 0,
      paused: video.paused,
      playbackRate: video.playbackRate
    });
  }

  video.addEventListener('timeupdate', reportState);
  video.addEventListener('play', reportState);
  video.addEventListener('pause', reportState);
  video.addEventListener('ratechange', reportState);
  video.addEventListener('loadedmetadata', reportState);

  // Convenience shortcuts in the detached window itself, mirroring the main
  // window's transport shortcuts, for when you're looking at this screen directly.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (video.paused) video.play(); else video.pause();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.shiftKey ? 1 : 5;
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const max = isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(max, Math.max(0, video.currentTime + dir * step));
    }
  });
})();
