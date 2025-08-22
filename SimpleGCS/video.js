/*
  video.js — Inset Video Panel (HTTPS + Live-Edge + Catch‑up)
  - Assumes MediaMTX serves HTTPS on:
      HLS   : https://<host>:8888/<path>/index.m3u8
      WebRTC: https://<host>:8889/<path>/
  - Uses hls.js (if available) or native HLS; starts at live edge
  - Adds a "Go Live" button and a LIVE badge that shows drift
  - Keeps playback near the tip with a small live-keeper and catch-up rate
*/
(() => {
  class VideoPanel {
    constructor(opts = {}) {
      this.host = opts.host || location.hostname || "127.0.0.1";
      this.hlsPort = opts.hlsPort ?? 8888;
      this.wrtcPort = opts.wrtcPort ?? 8889;
      this.path = opts.path || "relay_stream";
      this.user = opts.user || localStorage.getItem("video.user") || "viewer";
      this.pass = opts.pass || localStorage.getItem("video.pass") || "view123";
      this.scheme = opts.scheme || (location.protocol === "https:" ? "https" : "http");
      this.el = null;
      this.hls = null;
      this.videoEl = null;
      this.liveTimer = null;
      this.liveBadgeEl = null;
    }

    _hlsUrl() { return `${this.scheme}://${this.host}:${this.hlsPort}/${this.path}/index.m3u8`; }
    _webrtcUrl() { return `${this.scheme}://${this.host}:${this.wrtcPort}/${this.path}/`; }

    open() {
      if (this.el) { this.show(); return; }

      const wrap = document.createElement("div");
      wrap.id = "video-panel";
      wrap.style.cssText = [
        "position:absolute; right:12px; bottom:12px; width:420px; height:240px;",
        "background:#111; color:#fff; z-index:9999; border-radius:10px;",
        "box-shadow:0 8px 24px rgba(0,0,0,.35); overflow:hidden;",
        "display:flex; flex-direction:column; user-select:none;"
      ].join("");

      const bar = document.createElement("div");
      bar.style.cssText = "height:36px; background:#222; display:flex; align-items:center; padding:0 8px; gap:8px; cursor:move;";
      const title = document.createElement("div");
      title.textContent = "Video";
      title.style.cssText = "font-weight:600; flex:1;";

      const btn = (label, bg) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = `border:0; border-radius:8px; padding:4px 8px; cursor:pointer; font:600 12px system-ui; background:${bg}; color:#111;`;
        return b;
      };

      const liveBtn = btn("Go Live", "#a5d6a7");
      liveBtn.addEventListener("click", () => this._goLive());
      const popBtn = btn("New window", "#90caf9");
      popBtn.addEventListener("click", () => this.openNewWindow());
      const cfgBtn = btn("Settings", "#ffd54f");
      cfgBtn.addEventListener("click", () => this.openSettings());
      const closeBtn = btn("×", "#ef9a9a");
      closeBtn.style.width = "28px";
      closeBtn.addEventListener("click", () => this.close());
      bar.append(title, liveBtn, popBtn, cfgBtn, closeBtn);

      const vid = document.createElement("video");
      vid.style.cssText = "width:100%; height:100%; background:#000;";
      vid.autoplay = true; vid.playsInline = true; vid.muted = true; vid.controls = true;

      const body = document.createElement("div");
      body.style.cssText = "position:relative; flex:1; display:flex;";
      body.append(vid);

      // LIVE badge (clickable)
      const liveBadge = document.createElement("div");
      liveBadge.style.cssText = "position:absolute; left:8px; top:8px; padding:2px 8px; border-radius:999px; font:600 12px system-ui; letter-spacing:.08em; background:#e53935; color:#fff; cursor:pointer; user-select:none;";
      liveBadge.textContent = "LIVE";
      liveBadge.title = "Click to jump to live";
      liveBadge.addEventListener("click", () => this._goLive());
      body.append(liveBadge);
      this.liveBadgeEl = liveBadge;

      const grip = document.createElement("div");
      grip.style.cssText = "position:absolute; right:0; bottom:0; width:18px; height:18px; background:linear-gradient(135deg, transparent 50%, rgba(255,255,255,.25) 50%); cursor:nwse-resize;";
      body.append(grip);

      wrap.append(bar, body);
      (document.getElementById("map") || document.body).appendChild(wrap);

      // drag
      let drag = null;
      bar.addEventListener("mousedown", (e) => { drag = { x:e.clientX, y:e.clientY, left:wrap.offsetLeft, top:wrap.offsetTop }; e.preventDefault(); });
      document.addEventListener("mousemove", (e) => {
        if (!drag) return; const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
        wrap.style.left = (drag.left + dx) + "px"; wrap.style.top = (drag.top + dy) + "px";
        wrap.style.right = "auto"; wrap.style.bottom = "auto";
      });
      document.addEventListener("mouseup", () => { drag = null; });

      // resize
      let rez = null;
      grip.addEventListener("mousedown", (e) => { rez = { x:e.clientX, y:e.clientY, w:wrap.offsetWidth, h:wrap.offsetHeight }; e.preventDefault(); });
      document.addEventListener("mousemove", (e) => {
        if (!rez) return; const dx = e.clientX - rez.x; const dy = e.clientY - rez.y;
        wrap.style.width = Math.max(280, rez.w + dx) + "px"; wrap.style.height = Math.max(160, rez.h + dy) + "px";
      });
      document.addEventListener("mouseup", () => { rez = null; });

      this.el = wrap; this.videoEl = vid;
      this._playHLS();
    }

    _playHLS() {
      const url = this._hlsUrl();
      localStorage.setItem("video.user", this.user || "");
      localStorage.setItem("video.pass", this.pass || "");
      localStorage.setItem("video.host", this.host || "");
      localStorage.setItem("video.path", this.path || "");

      if (location.protocol === "https:" && url.startsWith("http://")) { this._fallbackIframe(); return; }

      // Native HLS (Safari/iOS)
      if (this.videoEl && this.videoEl.canPlayType && this.videoEl.canPlayType("application/vnd.apple.mpegurl")) {
        this.videoEl.src = url;
        this.videoEl.addEventListener("loadedmetadata", () => this._goLive(), { once:true });
        this.videoEl.play().catch(() => {});
        this._startLiveKeeper();
        return;
      }

      // hls.js path
      if (!window.Hls) { this._fallbackIframe(); return; }
      if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; }

      const auth = (this.user && this.pass) ? "Basic " + btoa(`${this.user}:${this.pass}`) : null;
      const hls = new Hls({
        autoStartLoad: false,
        startPosition: -1,
        lowLatencyMode: true,
        backBufferLength: 10,
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        maxLiveSyncPlaybackRate: 1.2,
        maxBufferLength: 15,
        xhrSetup: (xhr) => { if (auth) xhr.setRequestHeader("Authorization", auth); }
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data && data.fatal) { try { hls.destroy(); } catch {} this.hls = null; this._fallbackIframe(); }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        try { hls.startLoad(-1); } catch {}
        this._goLive();
        if (this.videoEl) this.videoEl.play().catch(() => {});
        this._startLiveKeeper();
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => { if (data && data.details && data.details.live) this._maybeNudgeLive(); });
      hls.on(Hls.Events.BUFFER_APPENDED, () => { this._maybeNudgeLive(); });

      hls.loadSource(url);
      hls.attachMedia(this.videoEl);
      this.hls = hls;
      if (this.videoEl) this.videoEl.play().catch(() => {});
      this._updateLiveBadge();
    }

    _getEdges() {
      const v = this.videoEl;
      const S = v && v.seekable && v.seekable.length ? v.seekable : null;
      const B = v && v.buffered && v.buffered.length ? v.buffered : null;
      const seekEnd = S ? S.end(S.length - 1) : NaN;
      const bufEnd  = B ? B.end(B.length - 1) : NaN;
      return { seekEnd, bufEnd };
    }

    _seekLive() {
      const v = this.videoEl; if (!v) return;
      if (this.hls && Number.isFinite(this.hls.liveSyncPosition)) { try { v.currentTime = this.hls.liveSyncPosition; return; } catch {}
      }
      const { seekEnd, bufEnd } = this._getEdges();
      if (Number.isFinite(seekEnd)) {
        if (Number.isFinite(bufEnd) && (seekEnd - bufEnd) > 1.0) { try { v.currentTime = Math.max(0, bufEnd - 0.05); return; } catch {} }
        try { v.currentTime = Math.max(0, seekEnd - 0.1); } catch {}
      }
    }

    _goLive() {
      try { if (this.hls) { this.hls.stopLoad(); this.hls.startLoad(-1); } } catch {}
      this._seekLive();
      setTimeout(() => this._seekLive(), 250);
      setTimeout(() => this._seekLive(), 750);
      if (this.videoEl) this.videoEl.play().catch(() => {});
    }

    _computeBehind() {
      const v = this.videoEl; if (!v || !v.seekable || !v.seekable.length) return Infinity;
      const end = v.seekable.end(v.seekable.length - 1);
      return end - v.currentTime;
    }

    _applyCatchupRate(behind) {
      if (!this.videoEl) return;
      let rate = 1.0;
      if (behind > 12) rate = 1.25; else if (behind > 6) rate = 1.12;
      if (Math.abs((this.videoEl.playbackRate || 1) - rate) > 0.01) this.videoEl.playbackRate = rate;
    }

    _setLiveBadge(isLive, behindSec) {
      const el = this.liveBadgeEl; if (!el) return;
      if (isLive) { el.style.background = '#e53935'; el.style.opacity = '0.95'; el.textContent = 'LIVE'; }
      else { el.style.background = '#616161'; el.style.opacity = '0.85'; el.textContent = Number.isFinite(behindSec) ? `LIVE -${Math.round(behindSec)}s` : 'LIVE'; }
    }

    _updateLiveBadge() { const b = this._computeBehind(); this._setLiveBadge(b <= 5, b); }

    _maybeNudgeLive() {
      const v = this.videoEl; if (!v) return;
      const r = v.seekable; if (!r || !r.length) return;
      const end = r.end(r.length - 1);
      if ((end - v.currentTime) > 5) this._goLive();
      this._updateLiveBadge();
    }

    _startLiveKeeper() {
      this._stopLiveKeeper();
      this._updateLiveBadge();
      this.liveTimer = setInterval(() => {
        const behind = this._computeBehind();
        this._updateLiveBadge();
        if (behind === Infinity) return;
        this._applyCatchupRate(behind);
        if (behind > 5) this._goLive();
      }, 1000);
    }

    _stopLiveKeeper() { if (this.liveTimer) { clearInterval(this.liveTimer); this.liveTimer = null; } if (this.videoEl) this.videoEl.playbackRate = 1.0; }

    _fallbackIframe() {
      const iframe = document.createElement("iframe");
      iframe.src = this._webrtcUrl();
      iframe.style.cssText = "border:0; width:100%; height:100%; background:#000;";
      const parent = this.videoEl ? this.videoEl.parentNode : null;
      if (parent && this.videoEl) parent.replaceChild(iframe, this.videoEl);
      this.videoEl = null;
      this._stopLiveKeeper();
      if (this.liveBadgeEl && this.liveBadgeEl.parentNode) this.liveBadgeEl.parentNode.removeChild(this.liveBadgeEl);
      this.liveBadgeEl = null;
    }

    openNewWindow() { window.open(this._webrtcUrl(), "_blank", "noopener,noreferrer"); }

    openSettings() {
      const host = prompt("MediaMTX host", this.host) || this.host;
      const path = prompt("Path", this.path) || this.path;
      const user = prompt("Viewer username", this.user || "") || "";
      const pass = prompt("Viewer password", this.pass || "") || "";
      this.host = host; this.path = path; this.user = user; this.pass = pass;
      if (this.el) {
        if (!this.videoEl) {
          const body = this.el.querySelector("div:nth-child(2)");
          if (body) {
            body.innerHTML = "";
            const vid = document.createElement("video");
            vid.style.cssText = "width:100%; height:100%; background:#000;";
            vid.autoplay = true; vid.playsInline = true; vid.muted = true; vid.controls = true;
            body.appendChild(vid);
            this.videoEl = vid;
          }
        }
        this._playHLS();
      }
    }

    show() { if (this.el) this.el.style.display = "flex"; }
    hide() { if (this.el) this.el.style.display = "none"; }
    toggle() { if (this.el && this.el.style.display !== "none") this.hide(); else this.open(); }
    close() {
      if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; }
      this._stopLiveKeeper();
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.el = null; this.videoEl = null; this.liveBadgeEl = null;
    }
  }

  const _instance = new VideoPanel({
    host: localStorage.getItem("video.host") || location.hostname || "127.0.0.1",
    path: localStorage.getItem("video.path") || "relay_stream",
    user: localStorage.getItem("video.user") || "viewer",
    pass: localStorage.getItem("video.pass") || "view123"
  });

  window.VideoPanel = {
    toggle: () => _instance.toggle(),
    open:   () => _instance.open(),
    close:  () => _instance.close(),
    openNewWindow: () => _instance.openNewWindow()
  };
})();
