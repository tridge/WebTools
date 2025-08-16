(() => {
  // Simple HLS player panel with Basic-Auth support + pop-out
  class VideoPanel {
    constructor(opts = {}) {
      this.host = opts.host || location.hostname || "127.0.0.1";
      this.hlsPort = opts.hlsPort ?? 8888;
      this.wrtcPort = opts.wrtcPort ?? 8889;
      this.path = opts.path || "relay_stream";
      this.user = opts.user || localStorage.getItem("video.user") || "viewer";
      this.pass = opts.pass || localStorage.getItem("video.pass") || "view123";
      this.el = null;
      this.hls = null;
    }

    _hlsUrl() {
      return `http://${this.host}:${this.hlsPort}/${this.path}/index.m3u8`;
    }
    _webrtcUrl() {
      // MediaMTX built-in WebRTC viewer page
      return `http://${this.host}:${this.wrtcPort}/${this.path}/`;
    }

    open() {
      if (this.el) { this.show(); return; }

      // container
      const wrap = document.createElement("div");
      wrap.id = "video-panel";
      wrap.style.cssText = `
        position:absolute; right:12px; bottom:12px; width:420px; height:240px;
        background:#111; color:#fff; z-index:9999; border-radius:10px;
        box-shadow:0 8px 24px rgba(0,0,0,.35); overflow:hidden;
        display:flex; flex-direction:column; user-select:none;
      `;

      // title bar
      const bar = document.createElement("div");
      bar.style.cssText = `
        height:36px; background:#222; display:flex; align-items:center;
        padding:0 8px; gap:8px; cursor:move;
      `;
      const title = document.createElement("div");
      title.textContent = "Video";
      title.style.cssText = "font-weight:600; flex:1;";

      // controls
      const btnStyles = `border:0; border-radius:8px; padding:4px 8px; cursor:pointer; font:600 12px system-ui;`;
      const popBtn = document.createElement("button");
      popBtn.textContent = "New window";
      popBtn.style.cssText = `${btnStyles} background:#90caf9; color:#111;`;
      popBtn.onclick = () => this.openNewWindow();

      const cfgBtn = document.createElement("button");
      cfgBtn.textContent = "Settings";
      cfgBtn.style.cssText = `${btnStyles} background:#ffd54f; color:#111;`;
      cfgBtn.onclick = () => this.openSettings();

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "×";
      closeBtn.style.cssText = `${btnStyles} background:#ef9a9a; color:#111; width:28px; text-align:center;`;
      closeBtn.onclick = () => this.close();

      bar.append(title, popBtn, cfgBtn, closeBtn);

      // video element
      const vid = document.createElement("video");
      vid.id = "video-el";
      vid.style.cssText = "width:100%; height:100%; background:#000;";
      vid.autoplay = true;
      vid.playsInline = true; // iOS
      vid.muted = true;       // autoplay policy
      vid.controls = true;

      const body = document.createElement("div");
      body.style.cssText = "position:relative; flex:1; display:flex;";
      body.append(vid);

      // resize handle
      const grip = document.createElement("div");
      grip.style.cssText = `
        position:absolute; right:0; bottom:0; width:18px; height:18px;
        background:linear-gradient(135deg, transparent 50%, rgba(255,255,255,.25) 50%);
        cursor:nwse-resize;
      `;
      body.append(grip);

      wrap.append(bar, body);
      document.getElementById("map").appendChild(wrap); // overlay on map

      // drag
      let drag = null;
      bar.addEventListener("mousedown", (e) => {
        drag = { x: e.clientX, y: e.clientY, left: wrap.offsetLeft, top: wrap.offsetTop };
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        wrap.style.left = (drag.left + dx) + "px";
        wrap.style.top  = (drag.top  + dy) + "px";
        wrap.style.right = "auto"; wrap.style.bottom = "auto";
      });
      document.addEventListener("mouseup", () => drag = null);

      // resize
      let rez = null;
      grip.addEventListener("mousedown", (e) => {
        rez = { x: e.clientX, y: e.clientY, w: wrap.offsetWidth, h: wrap.offsetHeight };
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!rez) return;
        const dx = e.clientX - rez.x, dy = e.clientY - rez.y;
        wrap.style.width  = Math.max(280, rez.w + dx) + "px";
        wrap.style.height = Math.max(160, rez.h + dy) + "px";
      });
      document.addEventListener("mouseup", () => rez = null);

      this.el = wrap;
      this.videoEl = vid;

      // start playback
      this._playHLS();
    }

    _playHLS() {
      const url = this._hlsUrl();
      // store defaults
      localStorage.setItem("video.user", this.user || "");
      localStorage.setItem("video.pass", this.pass || "");
      localStorage.setItem("video.host", this.host || "");
      localStorage.setItem("video.path", this.path || "");

      // Safari (native HLS)
      if (this.videoEl.canPlayType("application/vnd.apple.mpegurl")) {
        // Browsers vary on inline credentials; let the Basic prompt appear if needed
        this.videoEl.src = url;
        this.videoEl.play().catch(()=>{});
        return;
      }

      // hls.js
      if (!window.Hls) {
        console.warn("hls.js not loaded; falling back to iframe WebRTC viewer");
        this._fallbackIframe();
        return;
      }
      if (this.hls) { this.hls.destroy(); this.hls = null; }

      const auth = (this.user && this.pass) ? "Basic " + btoa(`${this.user}:${this.pass}`) : null;
      const hls = new Hls({
        // keep defaults light; set Authorization header if we have creds
        xhrSetup: (xhr/*, url*/) => { if (auth) xhr.setRequestHeader("Authorization", auth); }
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        // If network/HTTP auth issues, try iframe fallback
        if (data?.fatal) {
          console.warn("HLS fatal error:", data);
          hls.destroy();
          this.hls = null;
          this._fallbackIframe();
        }
      });
      hls.loadSource(url);
      hls.attachMedia(this.videoEl);
      this.hls = hls;

      // try autoplay
      this.videoEl.play().catch(()=>{ /* user gesture may be needed */ });
    }

    _fallbackIframe() {
      // use MediaMTX built-in WebRTC viewer as an embedded iframe
      const iframe = document.createElement("iframe");
      iframe.src = this._webrtcUrl(); // viewer will prompt for Basic auth
      iframe.style.cssText = "border:0; width:100%; height:100%; background:#000;";
      // swap video element out
      const parent = this.videoEl.parentNode;
      if (this.videoEl) parent.removeChild(this.videoEl);
      parent.appendChild(iframe);
      this.videoEl = null;
    }

    openNewWindow() {
      window.open(this._webrtcUrl(), "_blank", "noopener,noreferrer");
    }

    openSettings() {
      const host = prompt("MediaMTX host", this.host) || this.host;
      const path = prompt("Path", this.path) || this.path;
      const user = prompt("Viewer username", this.user || "") || "";
      const pass = prompt("Viewer password", this.pass || "") || "";
      this.host = host; this.path = path; this.user = user; this.pass = pass;
      // reload playback if panel is open
      if (this.el) {
        // if we had iframe fallback, rebuild panel to return to HLS if possible
        try {
          if (this.hls) { this.hls.destroy(); this.hls = null; }
          if (!this.videoEl) {
            // reconstruct a fresh video element
            const body = this.el.querySelector("div:nth-child(2)");
            body.innerHTML = "";
            const vid = document.createElement("video");
            vid.style.cssText = "width:100%; height:100%; background:#000;";
            vid.autoplay = true; vid.playsInline = true; vid.muted = true; vid.controls = true;
            body.appendChild(vid);
            this.videoEl = vid;
          }
        } catch {}
        this._playHLS();
      }
    }

    show() { if (this.el) this.el.style.display = "flex"; }
    hide() { if (this.el) this.el.style.display = "none"; }

    toggle() { (this.el && this.el.style.display !== "none") ? this.hide() : this.open(); }

    close() {
      if (this.hls) { try { this.hls.destroy(); } catch{} this.hls = null; }
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.el = null; this.videoEl = null;
    }
  }

  // expose singleton-like helper
  const _instance = new VideoPanel({
    host: localStorage.getItem("video.host") || location.hostname || "127.0.0.1",
    path: localStorage.getItem("video.path") || "relay_stream",
    user: localStorage.getItem("video.user") || "viewer",
    pass: localStorage.getItem("video.pass") || "view123",
  });

  window.VideoPanel = {
    toggle: () => _instance.toggle(),
    open:   () => _instance.open(),
    close:  () => _instance.close(),
    openNewWindow: () => _instance.openNewWindow()
  };
})();
