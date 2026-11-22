/* follow-drum-tab clocks. Both report "song time" in seconds; TimeMap turns that into beats.
 *   InternalClock - performance.now() based, any rate, used when a song has no video.
 *   YouTubeClock  - wraps the YouTube IFrame Player; polls getCurrentTime() and interpolates between updates.
 * Shared interface: time(), playing(), play(), pause(), seek(sec), setRate(r), rate, rates(), duration(), destroy()
 */
(function (root) {
  'use strict';

  class InternalClock {
    constructor() { this.kind = 'internal'; this.base = 0; this.basePerf = 0; this.on = false; this.rate = 1; this.onstate = null; }
    time() { return this.on ? this.base + ((performance.now() - this.basePerf) / 1000) * this.rate : this.base; }
    playing() { return this.on; }
    play() { if (this.on) return; this.basePerf = performance.now(); this.on = true; this.onstate && this.onstate('playing'); }
    pause() { if (!this.on) return; this.base = this.time(); this.on = false; this.onstate && this.onstate('paused'); }
    seek(sec) { this.base = sec; this.basePerf = performance.now(); }
    setRate(r) { this.base = this.time(); this.basePerf = performance.now(); this.rate = r; return r; }
    rates() { const r = []; for (let x = 0.5; x <= 1.2501; x += 0.05) r.push(Math.round(x * 100) / 100); return r; }
    duration() { return 0; }
    destroy() { this.pause(); }
  }

  /* ---------- YouTube ---------- */
  let apiPromise = null;
  function loadApi() {
    if (root.YT && root.YT.Player) return Promise.resolve(root.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const prev = root.onYouTubeIframeAPIReady;
      root.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(root.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiPromise = null; reject(new Error('Could not load YouTube. Check the internet connection.')); };
      document.head.appendChild(s);
    });
    return apiPromise;
  }

  function parseYouTubeId(s) {
    s = String(s || '').trim();
    const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
  }

  const YT_ERRORS = {
    2: 'That video link looks wrong.',
    5: 'This video cannot play in the browser.',
    100: 'This video was removed or is private.',
    101: 'This video does not allow playing inside other apps. Try another upload (lyric or "Official Audio" videos usually work).',
    150: 'This video does not allow playing inside other apps. Try another upload (lyric or "Official Audio" videos usually work).',
    152: 'YouTube refused to embed here. Open the app from its web address (https), not from a file.',
    153: 'YouTube refused to embed here. Open the app from its web address (https), not from a file.',
  };

  class YouTubeClock {
    constructor(el, videoId, opts) {
      this.kind = 'youtube';
      this.el = el; this.videoId = videoId; this.opts = opts || {};
      this.state = -1; this.rate = 1; this.ready = false; this.player = null;
      this.lastRaw = null; this.lastPerf = 0; this.est = 0; this.pendingSeek = null;
      this.onstate = null;
      this._init();
    }
    async _init() {
      try {
        const YT = await loadApi();
        const host = document.createElement('div');
        this.el.innerHTML = '';
        this.el.appendChild(host);
        this.player = new YT.Player(host, {
          videoId: this.videoId,
          width: '100%', height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin },
          events: {
            onReady: () => {
              this.ready = true;
              this.player.setPlaybackRate(this.rate);
              if (this.pendingSeek != null) { this.player.seekTo(this.pendingSeek, true); this.pendingSeek = null; }
              this.opts.onReady && this.opts.onReady(this);
            },
            onStateChange: (e) => {
              this.state = e.data;
              this.lastRaw = null;
              const name = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' }[e.data];
              this.onstate && this.onstate(name);
            },
            onPlaybackRateChange: (e) => { this.rate = e.data; this.lastRaw = null; this.opts.onRate && this.opts.onRate(e.data); },
            onError: (e) => this.opts.onError && this.opts.onError(YT_ERRORS[e.data] || `YouTube error ${e.data}.`),
          },
        });
      } catch (err) {
        this.opts.onError && this.opts.onError(err.message);
      }
    }
    time() {
      if (!this.ready) return this.pendingSeek != null ? this.pendingSeek : this.est;
      const raw = this.player.getCurrentTime() || 0;
      const now = performance.now();
      if (this.state === 1) {
        if (this.lastRaw === null || raw !== this.lastRaw) {
          // New reading: keep moving smoothly unless we are clearly off (seek, stall).
          const predicted = this.lastRaw === null ? raw : this.est + ((now - this.lastPerf) / 1000) * this.rate;
          this.lastRaw = raw;
          this.lastPerf = now;
          this.est = Math.abs(predicted - raw) > 0.3 ? raw : (predicted + raw) / 2;
          return this.est;
        }
        return this.est + ((now - this.lastPerf) / 1000) * this.rate;
      }
      this.est = raw;
      this.lastRaw = null;
      return raw;
    }
    playing() { return this.state === 1; }
    play() { if (this.ready) this.player.playVideo(); }
    pause() { if (this.ready) this.player.pauseVideo(); }
    seek(sec) {
      sec = Math.max(0, sec);
      this.lastRaw = null; this.est = sec;
      if (this.ready) this.player.seekTo(sec, true);
      else this.pendingSeek = sec;
    }
    setRate(r) {
      this.rate = r;
      if (this.ready) {
        this.player.setPlaybackRate(r);
        const actual = this.player.getPlaybackRate();
        if (actual) this.rate = actual;
      }
      return this.rate;
    }
    rates() { return this.ready && this.player.getAvailablePlaybackRates ? this.player.getAvailablePlaybackRates() : [0.5, 0.75, 1]; }
    duration() { return this.ready ? this.player.getDuration() || 0 : 0; }
    destroy() { try { this.player && this.player.destroy(); } catch (e) {} this.el.innerHTML = ''; }
  }

  root.FDTClock = { InternalClock, YouTubeClock, parseYouTubeId, loadApi };
})(window);
