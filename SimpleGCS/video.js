/*
  VideoPanel (HTTPS + Live-Edge)
  - Assumes MediaMTX serves HTTPS on:
  HLS   : https://<host>:8888/<path>/index.m3u8
  WebRTC: https://<host>:8889/<path>/
  - Uses hls.js when needed and forces startup at the live edge
  - Adds a "Go Live" button to jump forward if the viewer drifts
  - Sends Basic-Auth headers for HLS (XHR) and lets the WebRTC viewer
  prompt via the browser (iframe/new window)
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
	    // Assume HTTPS MediaMTX endpoints when page is HTTPS
	    this.scheme = opts.scheme || (location.protocol === "https:" ? "https" : "http");
	    this.el = null;
	    this.hls = null;
	    this.videoEl = null;
	}

	_hlsUrl() {
	    return `${this.scheme}://${this.host}:${this.hlsPort}/${this.path}/index.m3u8`;
	}
	_webrtcUrl() {
	    return `${this.scheme}://${this.host}:${this.wrtcPort}/${this.path}/`;
	}

	open() {
	    if (this.el) { this.show(); return; }

	    const wrap = document.createElement("div");
	    wrap.id = "video-panel";
	    wrap.style.cssText = `
        position:absolute; right:12px; bottom:12px; width:420px; height:240px;
        background:#111; color:#fff; z-index:9999; border-radius:10px;
        box-shadow:0 8px 24px rgba(0,0,0,.35); overflow:hidden;
        display:flex; flex-direction:column; user-select:none;`;

	    const bar = document.createElement("div");
	    bar.style.cssText = `height:36px; background:#222; display:flex; align-items:center; padding:0 8px; gap:8px; cursor:move;`;
	    const title = document.createElement("div");
	    title.textContent = "Video";
	    title.style.cssText = "font-weight:600; flex:1;";

	    const btn = (label, bg) => { const b=document.createElement("button"); b.textContent=label; b.style.cssText=`border:0; border-radius:8px; padding:4px 8px; cursor:pointer; font:600 12px system-ui; background:${bg}; color:#111;`; return b; };

	    const liveBtn = btn("Go Live", "#a5d6a7");
	    liveBtn.onclick = () => this._seekLive();

	    const popBtn = btn("New window", "#90caf9");
	    popBtn.onclick = () => this.openNewWindow();

	    const cfgBtn = btn("Settings", "#ffd54f");
	    cfgBtn.onclick = () => this.openSettings();

	    const closeBtn = btn("×", "#ef9a9a");
	    closeBtn.style.width = "28px";
	    closeBtn.onclick = () => this.close();

	    bar.append(title, liveBtn, popBtn, cfgBtn, closeBtn);

	    const vid = document.createElement("video");
	    vid.style.cssText = "width:100%; height:100%; background:#000;";
	    vid.autoplay = true; vid.playsInline = true; vid.muted = true; vid.controls = true;

	    const body = document.createElement("div");
	    body.style.cssText = "position:relative; flex:1; display:flex;";
	    body.append(vid);

	    const grip = document.createElement("div");
	    grip.style.cssText = `position:absolute; right:0; bottom:0; width:18px; height:18px; background:linear-gradient(135deg, transparent 50%, rgba(255,255,255,.25) 50%); cursor:nwse-resize;`;
	    body.append(grip);

	    wrap.append(bar, body);
	    (document.getElementById("map") || document.body).appendChild(wrap);

	    // drag
	    let drag=null; bar.addEventListener("mousedown", e=>{ drag={x:e.clientX,y:e.clientY,left:wrap.offsetLeft,top:wrap.offsetTop}; e.preventDefault(); });
	    document.addEventListener("mousemove", e=>{ if(!drag) return; const dx=e.clientX-drag.x, dy=e.clientY-drag.y; wrap.style.left=(drag.left+dx)+"px"; wrap.style.top=(drag.top+dy)+"px"; wrap.style.right="auto"; wrap.style.bottom="auto"; });
	    document.addEventListener("mouseup", ()=>{ drag=null; });

	    // resize
	    let rez=null; grip.addEventListener("mousedown", e=>{ rez={x:e.clientX,y:e.clientY,w:wrap.offsetWidth,h:wrap.offsetHeight}; e.preventDefault(); });
	    document.addEventListener("mousemove", e=>{ if(!rez) return; const dx=e.clientX-rez.x, dy=e.clientY-rez.y; wrap.style.width=Math.max(280, rez.w+dx)+"px"; wrap.style.height=Math.max(160, rez.h+dy)+"px"; });
	    document.addEventListener("mouseup", ()=>{ rez=null; });

	    this.el = wrap; this.videoEl = vid;
	    this._playHLS();
	}

	_playHLS() {
	    const url = this._hlsUrl();
	    // remember user settings
	    localStorage.setItem("video.user", this.user || "");
	    localStorage.setItem("video.pass", this.pass || "");
	    localStorage.setItem("video.host", this.host || "");
	    localStorage.setItem("video.path", this.path || "");

	    // If we’re on HTTPS but the URL is HTTP (misconfig), fall back to WebRTC iframe
	    if (location.protocol === "https:" && url.startsWith("http://")) {
		console.warn("Mixed content would be blocked; using WebRTC iframe fallback.");
		this._fallbackIframe();
		return;
	    }

	    // Safari/iOS (native HLS)
	    if (this.videoEl.canPlayType("application/vnd.apple.mpegurl")) {
		this.videoEl.src = url;
		// seek to live once metadata is known
		this.videoEl.addEventListener("loadedmetadata", () => this._seekLive(), { once: true });
		this.videoEl.play().catch(()=>{});
		return;
	    }

	    // hls.js path
	    if (!window.Hls) { this._fallbackIframe(); return; }

	    if (this.hls) { try { this.hls.destroy(); } catch{} this.hls = null; }
	    const auth = (this.user && this.pass) ? "Basic "+btoa(`${this.user}:${this.pass}`) : null;
	    const hls = new Hls({
		autoStartLoad: false,                // we'll call startLoad(-1) at manifest parsed
		liveSyncDurationCount: 3,            // ~3 segments behind the edge
		liveMaxLatencyDurationCount: 10,     // cap latency
		xhrSetup: (xhr) => { if (auth) xhr.setRequestHeader("Authorization", auth); }
	    });

	    hls.on(Hls.Events.ERROR, (_evt, data) => {
		if (data?.fatal) { console.warn("HLS fatal", data); try { hls.destroy(); } catch{} this.hls=null; this._fallbackIframe(); }
	    });

	    hls.loadSource(url);
	    hls.attachMedia(this.videoEl);
	    hls.on(Hls.Events.MANIFEST_PARSED, () => {
		// start at live edge
		try { hls.startLoad(-1); } catch{}
		this._seekLive();
		this.videoEl.play().catch(()=>{});
	    });
	    hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
		if (data?.details?.live) this._maybeNudgeLive();
	    });

	    this.hls = hls;

	    // Last resort on autoplay policies
	    this.videoEl.play().catch(()=>{});
	}

	_seekLive() {
	    const v = this.videoEl; if (!v) return;
	    if (this.hls && typeof this.hls.liveSyncPosition === "number") {
		try { v.currentTime = this.hls.liveSyncPosition; return; } catch {}
	    }
	    const r = v.seekable; if (r && r.length) {
		const end = r.end(r.length - 1);
		try { v.currentTime = Math.max(0, end - 0.5); } catch {}
	    }
	}

	_maybeNudgeLive() {
	    const v = this.videoEl; if (!v) return;
	    const r = v.seekable; if (!r || !r.length) return;
	    const end = r.end(r.length - 1);
	    if ((end - v.currentTime) > 5) this._seekLive();
	}

	_fallbackIframe() {
	    const iframe = document.createElement("iframe");
	    iframe.src = this._webrtcUrl();
	    iframe.style.cssText = "border:0; width:100%; height:100%; background:#000;";
	    const parent = this.videoEl.parentNode;
	    if (this.videoEl) parent.replaceChild(iframe, this.videoEl);
	    this.videoEl = null;
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
		    body.innerHTML = "";
		    const vid = document.createElement("video");
		    vid.style.cssText = "width:100%; height:100%; background:#000;";
		    vid.autoplay = true; vid.playsInline = true; vid.muted = true; vid.controls = true;
		    body.appendChild(vid);
		    this.videoEl = vid;
		}
		this._playHLS();
	    }
	}

	show() { if (this.el) this.el.style.display = "flex"; }
	hide() { if (this.el) this.el.style.display = "none"; }
	toggle() { (this.el && this.el.style.display !== "none") ? this.hide() : this.open(); }
	close() { if (this.hls) { try { this.hls.destroy(); } catch{} this.hls=null; } if (this.el?.parentNode) this.el.parentNode.removeChild(this.el); this.el=null; this.videoEl=null; }
    }

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
