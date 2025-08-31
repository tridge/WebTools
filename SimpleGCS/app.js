/*
  app.js - Simple, mobile-friendly GCS app for autonomous buoys
  Refactored to use MapManager and utility modules
*/

(() => {
    // --- State ---
    let MAVLink = new MAVLink20Processor();
    let gcsSystemId = 255, gcsComponentId = 190;
    let vehSysId = -1, vehCompId = -1;

    // Vehicle type cache
    const VehicleType = { mavType: null, cls: "plane", lastSeen: 0 };

    // Connection
    let ws = null;
    let hbInterval = null;
    let setupSigning = false;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let intentionalDisconnect = false;
    let lastConnectionUrl = null;
    let doneConnect = false;

    // Messages dictionary
    let messages = {};
    // Track pending command ACKs (by MAV_CMD id)
    const PendingAcks = new Set();

    // Human-readable names for common MAV_CMDs we send
    function mavCmdName(id) {
        switch (id) {
            case mavlink20.MAV_CMD_COMPONENT_ARM_DISARM: return "COMPONENT_ARM_DISARM";
            case mavlink20.MAV_CMD_DO_SET_MODE: return "DO_SET_MODE";
            case mavlink20.MAV_CMD_DO_REPOSITION: return "DO_REPOSITION";
            case mavlink20.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN: return "PREFLIGHT_REBOOT_SHUTDOWN";
            case mavlink20.MAV_CMD_DO_FENCE_ENABLE: return "DO_FENCE_ENABLE";
            default: return "MAV_CMD " + id;
        }
    }

    // Human-readable names for MAV_RESULT
    function mavResultName(code) {
        switch (code) {
            case mavlink20.MAV_RESULT_ACCEPTED: return "ACCEPTED";
            case mavlink20.MAV_RESULT_TEMPORARILY_REJECTED: return "TEMPORARILY_REJECTED";
            case mavlink20.MAV_RESULT_DENIED: return "DENIED";
            case mavlink20.MAV_RESULT_UNSUPPORTED: return "UNSUPPORTED";
            case mavlink20.MAV_RESULT_FAILED: return "FAILED";
            case mavlink20.MAV_RESULT_IN_PROGRESS: return "IN_PROGRESS";
            case mavlink20.MAV_RESULT_CANCELLED: return "CANCELLED";
            default: return "RESULT " + code;
        }
    }


    // Telemetry state
    let telemetry = {
        batteryPct: null,
        currentA: null,
        speed: 0,
        lastUpdate: 0,
        armed: false,
        modeName: "—"
    };

    // --- AppSettings (persisted) ---
    const AppSettings = (() => {
        const LS = {
            tiles: "gcs.tiles.provider",
            autoFence: "gcs.auto.fetchFence",
            autoMission: "gcs.auto.fetchMission"
        };

        function get(key, def) {
            const v = localStorage.getItem(key);
            if (v == null) return def;
            return v;
        }

        function getBool(key, def = false) {
            const v = localStorage.getItem(key);
            if (v == null) return def;
            return v === "1" || v === "true";
        }

        const state = {
            tiles: get(LS.tiles, "osm"),
            autoFetchFence: getBool(LS.autoFence, true),
            autoFetchMission: getBool(LS.autoMission, false)
        };

        function save() {
            localStorage.setItem(LS.tiles, state.tiles);
            localStorage.setItem(LS.autoFence, state.autoFetchFence ? "1" : "0");
            localStorage.setItem(LS.autoMission, state.autoFetchMission ? "1" : "0");
        }

        return {
            get tiles() { return state.tiles; },
            set tiles(v) { state.tiles = v; save(); },
            get autoFetchFence() { return state.autoFetchFence; },
            set autoFetchFence(v) { state.autoFetchFence = !!v; save(); },
            get autoFetchMission() { return state.autoFetchMission; },
            set autoFetchMission(v) { state.autoFetchMission = !!v; save(); },
            save, state
        };
    })();
    window.AppSettings = AppSettings;

    // Initialize map
    const map = MapManager.init("map");

    // Setup fence and mission modules
    Fence.init({ map, MAVLink, toast: window.GCSUtils.toast, sendCommandInt });
    Mission.init({ map, MAVLink, toast: window.GCSUtils.toast, sendCommandInt });

    // UI elements
    const armBtn = document.getElementById("armBtn");
    const disarmBtn = document.getElementById("disarmBtn");
    const rtlBtn = document.getElementById("rtlBtn");
    const loiterBtn = document.getElementById("loiterBtn");
    const recenterBtn = document.getElementById("recenterBtn");
    const connectBtn = document.getElementById("connectBtn");

    // --- Command helpers ---
    function sendCommandInt(cmd, params = []) {
        if (!ws) {
            window.GCSUtils.toast("Not connected");
            return;
        }

        const payload = new mavlink20.messages.command_int(
            vehSysId,
            vehCompId,
            mavlink20.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            cmd,
            0, 0,
            params[0] || 0, params[1] || 0, params[2] || 0, params[3] || 0,
            params[4] || 0, params[5] || 0, params[6] || 0
        );

        const pkt = payload.pack(MAVLink);
        try { PendingAcks.add(cmd); } catch {}
        ws.send(Uint8Array.from(pkt));
    }

    function sendSetMode(mode) {
        if (!ws) {
            window.GCSUtils.toast("Not connected");
            return;
        }
        sendCommandInt(mavlink20.MAV_CMD_DO_SET_MODE, [
            mavlink20.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            mode
        ]);
    }

    function sendReboot() {
        sendCommandInt(mavlink20.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, [1]);
    }

    function sendForceDisarm() {
        sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [0, 21196]);
    }

    function sendForceArm() {
        sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [1, 21196]);
    }

    // --- Telemetry Display ---
    function initTelemetryDisplay() {
        const toolbar = document.getElementById("toolbar");
        const telemetryDiv = document.createElement("div");
        telemetryDiv.id = "telemetry";
        telemetryDiv.style.cssText = `
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 8px;
            margin: 10px 0;
            font-size: 11px;
            text-align: center;
            color: #fff;
            width: calc(var(--barW) - 12px);
        `;

        // Status display
        const statusDiv = document.createElement("div");
        statusDiv.id = "status-display";
        statusDiv.style.cssText = "margin-bottom: 8px;";
        statusDiv.innerHTML = `
            <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px;">
                <span></span>
                <span id="armed-pill" style="
                    padding:1px 4px; border-radius:999px; font-weight:500;
                    background:#9e9e9e; color:#111;">DISARM</span>
            </div>
            <div style="opacity:0.8">MODE: <span id="mode-value" style="font-weight:700">—</span></div>
        `;
        telemetryDiv.prepend(statusDiv);

        // Battery display
        const batteryDiv = document.createElement("div");
        batteryDiv.id = "battery-display";
        batteryDiv.style.cssText = "margin-bottom: 6px;";
        batteryDiv.innerHTML = `
            <div style="opacity: 0.7; margin-bottom: 2px;">BATTERY</div>
            <div id="battery-value" style="font-size: 14px; font-weight: bold;">---%</div>
            <div id="current-value" style="font-size: 12px; opacity: 0.85;">--- A</div>
        `;

        // Speed display
        const speedDiv = document.createElement("div");
        speedDiv.id = "speed-display";
        speedDiv.innerHTML = `
            <div style="opacity: 0.7; margin-bottom: 2px;">SPEED</div>
            <div id="speed-value" style="font-size: 14px; font-weight: bold;">--- knots</div>
        `;

        // LTE display
        const lteDiv = document.createElement("div");
        lteDiv.id = "lte-display";
        lteDiv.style.cssText = "margin-top: 6px;";
        lteDiv.innerHTML = `
            <div style="opacity:.7; margin-bottom:2px;">LTE</div>
            <div id="lte-carrier" style="font-size:13px; font-weight:600;">—</div>
            <div id="lte-rsrp" style="font-size:12px; opacity:.85;">— dBm</div>
        `;

        telemetryDiv.appendChild(batteryDiv);
        telemetryDiv.appendChild(speedDiv);
        telemetryDiv.appendChild(lteDiv);

        const spacer = toolbar.querySelector('div[style*="flex:1"]');
        toolbar.insertBefore(telemetryDiv, spacer);
    }

    function updateTelemetryDisplay() {
        const batteryEl = document.getElementById("battery-value");
        const currentEl = document.getElementById("current-value");
        const speedEl = document.getElementById("speed-value");
        const armedEl = document.getElementById("armed-pill");
        const modeEl = document.getElementById("mode-value");

        // Battery
        if (batteryEl) {
            if (telemetry.batteryPct !== null && telemetry.batteryPct >= 0) {
                let color = "#4caf50";
                if (telemetry.batteryPct < 20) color = "#f44336";
                else if (telemetry.batteryPct < 40) color = "#ff9800";
                batteryEl.textContent = `${telemetry.batteryPct}%`;
                batteryEl.style.color = color;
            } else {
                batteryEl.textContent = "---";
                batteryEl.style.color = "#fff";
            }
        }

        // Current
        if (currentEl) {
            if (telemetry.currentA !== null && telemetry.currentA >= 0) {
                currentEl.textContent = `${telemetry.currentA.toFixed(1)} A`;
            } else {
                currentEl.textContent = "--- A";
            }
        }

        // Speed
        if (speedEl) {
            if (telemetry.speed >= 0) {
                const speedKnots = 1.94384449 * telemetry.speed;
                speedEl.textContent = `${speedKnots.toFixed(1)} knots`;
            } else {
                speedEl.textContent = "--- knots";
            }
        }

        // Armed status
        if (armedEl) {
            if (telemetry.armed) {
                armedEl.textContent = "ARMED";
                armedEl.style.background = "#81c784";
            } else {
                armedEl.textContent = "DISARM";
                armedEl.style.background = "#9e9e9e";
            }
        }

        if (modeEl) modeEl.textContent = telemetry.modeName || "—";
    }

    function updateLTE() {
        const carrierEl = document.getElementById("lte-carrier");
        const rsrpEl = document.getElementById("lte-rsrp");
        if (!carrierEl || !rsrpEl) return;

        const sysmsgs = messages[vehSysId];
        if (!sysmsgs) return;

        const nvfMcc = sysmsgs["NAMED_VALUE_FLOAT[LTE_MCCMNC]"];
        const nvfRsrp = sysmsgs["NAMED_VALUE_FLOAT[LTE_RSRP]"];

        // Carrier
        let carrierTxt = "—";
        if (nvfMcc && typeof nvfMcc.value === "number") {
            const code = Math.round(nvfMcc.value);
            carrierTxt = window.GCSUtils.MCCMNC_MAP[code] || String(code);
        }
        carrierEl.textContent = carrierTxt;

        // RSRP (0.1 dB units → dBm)
        let rsrpTxt = "— dBm";
        if (nvfRsrp && typeof nvfRsrp.value === "number") {
            const dbm = nvfRsrp.value / 10.0;
            rsrpTxt = `${dbm.toFixed(1)} dBm`;
        }
        rsrpEl.textContent = rsrpTxt;
    }

    // --- StatusText log ---
    const StatusLog = {
        max: 500,
        items: [],

        push(sev, txt) {
            if (Array.isArray(txt)) txt = String.fromCharCode(...txt);
            txt = String(txt || "").replace(/\0+$/, "");
            this.items.push({ t: new Date(), sev: sev ?? -1, txt });
            if (this.items.length > this.max) {
                this.items.splice(0, this.items.length - this.max);
            }
            this.renderIfOpen();
        },

        tag(sev) {
            const map = ["EMERG","ALERT","CRIT","ERR","WARN","NOTICE","INFO","DEBUG"];
            return (sev >= 0 && sev < map.length) ? map[sev] : "INFO";
        },

        _tip: null,
        _box: null,

        open(anchorEl) {
            if (this._tip) { this._tip.show(); return; }

            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex; flex-direction:column; gap:6px; width:520px;";

            const header = document.createElement("div");
            header.textContent = "Messages (STATUSTEXT)";
            header.style.cssText = "font-weight:600;";

            const box = document.createElement("pre");
            box.style.cssText = `
                margin:0; background:#111; color:#eee; border-radius:6px;
                padding:8px; max-height:15.5em; overflow:auto;
                font: 12px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
                white-space: pre-wrap; word-break: break-word;
            `;
            this._box = box;

            const help = document.createElement("div");
            help.style.cssText = "opacity:.7; font-size:12px;";
            help.textContent = "Newest at the bottom. Keeps last 500 messages.";

            wrap.append(header, box, help);

            this._tip = tippy(anchorEl, {
                content: wrap,
                interactive: true,
                trigger: "click",
                theme: "light-border",
                placement: "right-end",
                appendTo: () => document.body,
                zIndex: 9999,
                onShow: () => this.renderIfOpen()
            });

            this._tip.show();
        },

        renderIfOpen() {
            if (!this._box) return;
            const lines = this.items.map(it => {
                const t = it.t.toTimeString().slice(0, 8);
                return `${t}  [${this.tag(it.sev)}] ${it.txt}`;
            });
            this._box.textContent = lines.join("\n");
            this._box.scrollTop = this._box.scrollHeight;
        }
    };

    // --- Menu System ---
    function initMenuButton() {
        const toolbar = document.getElementById("toolbar");
        const recenterBtn = document.getElementById("recenterBtn");

        const menuBtn = document.createElement("button");
        menuBtn.id = "menuBtn";
        menuBtn.className = "btn small";
        menuBtn.innerHTML = "☰";
        menuBtn.style.fontSize = "18px";

        toolbar.insertBefore(menuBtn, recenterBtn);

        const menuDiv = document.createElement("div");
        menuDiv.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 4px;
            min-width: 150px;
        `;

        const menuItems = [
            { text: "Video (Inset)", action: () => { window.VideoPanel?.toggle(); menuTip.hide(); }},
            { text: "Video (New Window)", action: () => { window.VideoPanel?.openNewWindow(); menuTip.hide(); }},
            { text: "Messages", action: () => { StatusLog.open(menuBtn); menuTip.hide(); } },
            { text: "Settings", action: () => { openSettingsTip(menuBtn); menuTip.hide(); } },
            { text: "Fetch Fence", action: () => { Fence.fetch(); menuTip.hide(); }},
            { text: "Fetch Mission", action: () => { Mission.fetch(); menuTip.hide(); }},
            { text: "Fence Disable", action: () => { Fence.disable(); menuTip.hide(); }},
            { text: "Fence Enable", action: () => { Fence.enable(); menuTip.hide(); }},
            { text: "Reboot", action: () => { sendReboot(); menuTip.hide(); }},
            { text: "ForceDisarm", action: () => { sendForceDisarm(); menuTip.hide(); }},
            { text: "ForceArm", action: () => { sendForceArm(); menuTip.hide(); }},
        ];

        menuItems.forEach(item => {
            const btn = document.createElement("button");
            btn.style.cssText = `
                padding: 8px 12px;
                background: #f0f0f0;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                text-align: left;
                font-size: 14px;
                transition: background 0.2s;
            `;
            btn.textContent = item.text;
            btn.onmouseover = () => btn.style.background = "#e0e0e0";
            btn.onmouseout = () => btn.style.background = "#f0f0f0";
            btn.onclick = item.action;
            menuDiv.appendChild(btn);
        });

        const menuTip = tippy(menuBtn, {
            content: menuDiv,
            interactive: true,
            trigger: "click",
            theme: "light-border",
            placement: "right-start",
            appendTo: () => document.body,
            zIndex: 10000
        });

        return menuBtn;
    }

    // Settings dialog
    function openSettingsTip(anchorEl) {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex; flex-direction:column; gap:12px; min-width:280px;";

        // Map tiles section
        const tilesSection = document.createElement("div");
        tilesSection.innerHTML = `<label style="display:block; font-weight:600; margin-bottom:4px;">Map Tiles</label>`;
        const select = document.createElement("select");
        select.style.cssText = "width:100%; padding:6px;";

        [
            ["osm", "OpenStreetMap (default)"],
            ["opentopomap", "OpenTopoMap"],
            ["carto-light", "Carto Light"],
            ["carto-dark", "Carto Dark"],
            ["esri-world-imagery", "Esri World Imagery (Satellite)"],
            ["au-ga-topo", "Australia — Geoscience Topographic"],
            ["uk-os-opendata", "UK — Ordnance Survey OpenData"],
            ["google", "Google Maps (Roadmap)"],
            ["google-terrain", "Google Maps (Terrain)"],
            ["google-satellite", "Google Maps (Satellite)"],
            ["google-hybrid", "Google Maps (Hybrid)"]
        ].forEach(([val, label]) => {
            const opt = document.createElement("option");
            opt.value = val;
            opt.textContent = label;
            if (AppSettings.tiles === val) opt.selected = true;
            select.appendChild(opt);
        });

        // Apply tile changes immediately
        select.onchange = () => {
            AppSettings.tiles = select.value;
            MapManager.applyTileProvider();
        };

        tilesSection.appendChild(select);

        // Display options section
        const displaySection = document.createElement("div");
        displaySection.innerHTML = `<label style="display:block; font-weight:600; margin-bottom:6px;">Display Options</label>`;

        const mkChk = (id, label, init, onChange) => {
            const d = document.createElement("label");
            d.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:4px;";
            const c = document.createElement("input");
            c.type = "checkbox";
            c.checked = init;
            c.id = id;
            c.onchange = onChange;
            const s = document.createElement("span");
            s.textContent = label;
            d.append(c, s);
            return { wrap: d, chk: c };
        };

        const showGrid = mkChk("show-grid", "Show Grid", MetricGrid.enabled || false, (e) => {
            if (e.target.checked) {
                MetricGrid.on();
            } else {
                MetricGrid.off();
            }
        });

        const showLocation = mkChk("show-location", "Show My Location", UserLocation.active(), (e) => {
            if (e.target.checked) {
                UserLocation.start();
            } else {
                UserLocation.stop();
            }
        });

        displaySection.appendChild(showGrid.wrap);
        displaySection.appendChild(showLocation.wrap);

        // Auto-fetch section
        const autoSection = document.createElement("div");
        autoSection.innerHTML = `<label style="display:block; font-weight:600; margin-bottom:6px;">Auto-fetch on Connect</label>`;

        const fence = mkChk("auto-fence", "Fetch fence on first heartbeat", AppSettings.autoFetchFence, (e) => {
            AppSettings.autoFetchFence = e.target.checked;
        });

        const mission = mkChk("auto-mission", "Fetch mission on first heartbeat", AppSettings.autoFetchMission, (e) => {
            AppSettings.autoFetchMission = e.target.checked;
        });

        autoSection.appendChild(fence.wrap);
        autoSection.appendChild(mission.wrap);

        // Close button
        const closeBtn = document.createElement("button");
        closeBtn.className = "btn small";
        closeBtn.textContent = "Close";
        closeBtn.style.cssText = "align-self: flex-end; margin-top: 8px;";
        closeBtn.onclick = () => {
            tip.hide();
        };

        wrap.append(tilesSection, displaySection, autoSection, closeBtn);

        const tip = tippy(anchorEl, {
            content: wrap,
            interactive: true,
            trigger: "manual",
            theme: "light-border",
            appendTo: () => document.body,
            placement: "right-start"
        });
        tip.show();
    }

    // --- Connection Management ---
    function initConnection() {
        const button = connectBtn;
        const tipDiv = document.createElement("div");
        tipDiv.appendChild(document.importNode(
            document.getElementById("connection_tip_template").content, true)
                          );

        const tip = tippy(button, {
            content: tipDiv,
            interactive: true,
            trigger: "click",
            theme: "light-border",
            appendTo: () => document.body,
            placement: "right-start"
        });

        tipDiv.querySelector("#Close").onclick = () => tip.hide();

        const urlInput = tipDiv.querySelector("#target_url");
        const hbCheckbox = tipDiv.querySelector("#send_heartbeat");
        const passphraseInput = tipDiv.querySelector("#signing_passphrase");
        const connectBtnDialog = tipDiv.querySelector("#connection_button");
        const disconnectBtn = tipDiv.querySelector("#disconnection_button");
        const sysInput = tipDiv.querySelector("#system_id");
        const compInput = tipDiv.querySelector("#component_id");

        // Random IDs to avoid collisions
        function rand100_200() {
            return Math.floor(Math.random() * 101) + 100;
        }
        sysInput.value = rand100_200();
        compInput.value = rand100_200();

        const LS_KEYS = {
            url: "gcs.url",
            pass: "gcs.passphrase"
        };

        urlInput.value = localStorage.getItem(LS_KEYS.url) || "wss://anusc.tridgell.net:20001";
        passphraseInput.value = localStorage.getItem(LS_KEYS.pass) || "";

        function applyIds() {
            let sid = parseInt(sysInput.value || "255", 10);
            let cid = parseInt(compInput.value || "190", 10);
            sid = (sid >= 1 && sid <= 255) ? sid : 255;
            cid = (cid >= 0 && cid <= 255) ? cid : 190;
            gcsSystemId = sid;
            gcsComponentId = cid;
            MAVLink.srcSystem = sid;
            MAVLink.srcComponent = cid;
        }

        function setConnState(state) {
            if (state === "connected") button.style.background = "#00c853";
            else if (state === "connecting") button.style.background = "#f9a825";
            else if (state === "error") button.style.background = "#e53935";
            else button.style.background = "";
        }

        function startHeartbeatLoop() {
            if (hbInterval) {
                clearInterval(hbInterval);
                hbInterval = null;
            }
            if (!hbCheckbox.checked) return;

            hbInterval = setInterval(() => {
                try {
                    if (!setupSigning) {
                        const pass = passphraseInput.value.trim();
                        if (pass.length > 0) {
                            setupSigning = true;
                            const enc = new TextEncoder();
                            const hash = mavlink20.sha256(enc.encode(pass));
                            MAVLink.signing.secret_key = new Uint8Array(hash);
                            MAVLink.signing.sign_outgoing = true;
                        }
                    }

                    const msg = new mavlink20.messages.heartbeat(6, 8, 0, 0, 4);
                    const pkt = msg.pack(MAVLink);
                    ws?.send(Uint8Array.from(pkt));
                } catch (e) {
                    console.error("Heartbeat send failed:", e?.message || e);
                    if (hbInterval) {
                        clearInterval(hbInterval);
                        hbInterval = null;
                    }
                    setConnState("error");
                    window.GCSUtils.toast("Heartbeat stopped after error");
                }
            }, 1000);
        }

        function connect(url) {
            applyIds();
            lastConnectionUrl = url;
            intentionalDisconnect = false;

            if (ws) disconnect(false);
            setupSigning = false;

            setConnState("connecting");
            ws = new WebSocket(url);
            ws.binaryType = "arraybuffer";

            ws.onopen = () => {
                tip.hide();
                setConnState("connected");
                reconnectAttempts = 0;
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                }
                startHeartbeatLoop();
                window.GCSUtils.toast("Connected");
            };

            ws.onerror = (error) => {
                console.log("WebSocket error:", error);
                setConnState("error");
            };

            ws.onclose = (event) => {
                console.log("WebSocket closed:", event.code, event.reason);

                if (hbInterval) {
                    clearInterval(hbInterval);
                    hbInterval = null;
                }

                Fence.onDisconnected();
                Mission.onDisconnected();
                FTPManager.clearLink();

                if (!intentionalDisconnect) {
                    setConnState("error");
                    scheduleReconnect();
                } else {
                    setConnState("");
                    window.GCSUtils.toast("Disconnected");
                }
            };

            ws.onmessage = handleMessage;
        }

        function scheduleReconnect() {
            if (reconnectTimer || intentionalDisconnect) return;

            reconnectAttempts++;
            const delay = 2000;

            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (!intentionalDisconnect && lastConnectionUrl) {
                    connect(lastConnectionUrl);
                }
            }, delay);
        }

        function disconnect(intentional = true) {
            intentionalDisconnect = intentional;

            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            if (intentional) {
                reconnectAttempts = 0;
                lastConnectionUrl = null;
            }

            if (ws) {
                try { ws.close(); } catch {}
            }
            ws = null;

            if (hbInterval) {
                clearInterval(hbInterval);
                hbInterval = null;
            }

            if (intentional) {
                setConnState("");
                window.GCSUtils.toast("Disconnected");
            }

            MapManager.clearTargetPosition();
        }

        connectBtnDialog.onclick = () => {
            if (!urlInput.checkValidity()) {
                window.GCSUtils.toast("Enter ws:// or wss:// URL");
                urlInput.focus();
                return;
            }

            localStorage.setItem(LS_KEYS.url, urlInput.value.trim());
            const pass = passphraseInput.value.trim();
            if (pass.length) {
                localStorage.setItem(LS_KEYS.pass, pass);
            } else {
                localStorage.removeItem(LS_KEYS.pass);
            }

            connect(urlInput.value);
        };

        disconnectBtn.onclick = () => {
            disconnect(true);
        };

        // Auto-connect on load
        (() => {
            if (doneConnect) return;

            localStorage.setItem(LS_KEYS.url, (urlInput.value || '').trim());
            const pass = (passphraseInput.value || '').trim();
            if (pass.length) localStorage.setItem(LS_KEYS.pass, pass);

            const url = urlInput.value;
            let tries = 0;
            const maxTries = 5;

            const tick = () => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    doneConnect = true;
                    return;
                }
                if (ws && ws.readyState === WebSocket.CONNECTING) {
                    return void setTimeout(tick, 1000);
                }
                if (++tries > maxTries) return;
                console.log("Trying connect");
                connect(url);
                setTimeout(tick, 1000);
            };

            tick();
        })();
    }

    // --- Message Handling ---
    function handleMessage(evt) {
        const buf = new Uint8Array(evt.data);
        MAVLink.pushBuffer(buf);

        while (true) {
            const m = MAVLink.parseChar(null);
            if (m === null) break;
            if (m._id == -1) continue;

            // Update messages dictionary
            if (!(m.sysid in messages)) {
                messages[m.sysid] = {};
            }
            messages[m.sysid][m._name] = m;

            const trimNuls = v => (typeof v === "string" ? v.replace(/\0+$/, "") : v);

            if (m._instance_field !== undefined) {
                let instanceValue = trimNuls(m[m._instance_field]);
                messages[m.sysid][`${m._name}[${instanceValue}]`] = m;
            }

            processMessage(m);
        }
    }

    function processMessage(m) {
        // HEARTBEAT - vehicle discovery and status
        if (m._name === "HEARTBEAT" && m.autopilot == mavlink20.MAV_AUTOPILOT_ARDUPILOTMEGA) {
            if (m.sysid != vehSysId) {
                vehSysId = m.sysid;
                vehCompId = m.compid;
                FTPManager.setLink(MAVLink, ws, vehSysId, vehCompId);
                Fence.onConnected(ws);
                Mission.onConnected(ws);

                if (AppSettings.autoFetchMission) {
                    try {
                        setTimeout(() => Mission.fetch(true), 10);
                    } catch {}
                }
            }

            VehicleType.mavType = m.type;
            VehicleType.cls = window.GCSUtils.classifyVehicle(m.type);
            VehicleType.lastSeen = Date.now();

            telemetry.armed = !!(m.base_mode & mavlink20.MAV_MODE_FLAG_SAFETY_ARMED);

            const isRoverish = (VehicleType.mavType === mavlink20.MAV_TYPE_GROUND_ROVER) ||
                  (VehicleType.mavType === mavlink20.MAV_TYPE_SURFACE_BOAT);
            telemetry.modeName = isRoverish ?
                (window.GCSUtils.roverModeNames[m.custom_mode] || `${m.custom_mode}`) :
                `${m.custom_mode}`;

            updateTelemetryDisplay();
        }

        // GLOBAL_POSITION_INT - position and speed
        if (m._name === "GLOBAL_POSITION_INT") {
            const lat = m.lat / 1e7;
            const lon = m.lon / 1e7;
            MapManager.updateVehiclePosition(lat, lon, VehicleType.cls, MapManager.lastHeadingDeg);

            // Calculate ground speed
            const vxMs = m.vx / 100.0;
            const vyMs = m.vy / 100.0;
            telemetry.speed = Math.sqrt(vxMs * vxMs + vyMs * vyMs);
            updateTelemetryDisplay();
        }

        // ATTITUDE - heading
        if (m._name === "ATTITUDE") {
            if (typeof m.yaw === "number") {
                MapManager.updateVehicleHeading(m.yaw);
            }
        }

        // File transfer
        if (m._name === "FILE_TRANSFER_PROTOCOL") {
            FTPManager.handleMessage(m);
        }

        // Battery status
        if (m._name === "BATTERY_STATUS") {
            telemetry.batteryPct = m.battery_remaining;
            telemetry.lastUpdate = Date.now();
            telemetry.currentA = m.current_battery / 100.0;
            updateTelemetryDisplay();
        }

        // System status
        if (m._name === "SYS_STATUS") {
            const sensorsEnabled = m.onboard_control_sensors_enabled;
            Fence.setEnabled((sensorsEnabled & mavlink20.MAV_SYS_STATUS_GEOFENCE) != 0);
        }

        // Target position
        if (m._name === "POSITION_TARGET_GLOBAL_INT") {
            if (m.lat_int !== 0 || m.lon_int !== 0) {
                const lat = m.lat_int / 1e7;
                const lon = m.lon_int / 1e7;
                MapManager.updateTargetPosition(lat, lon);
            } else {
                MapManager.clearTargetPosition();
            }
        }

        // Command acknowledgements
        if (m._name === "COMMAND_ACK") {
            if (gcsSystemId == m.target_system &&
                gcsComponentId == m.target_component) {
                // Optional: check we were expecting this command
                if (PendingAcks.has(m.command)) {
                    if (m.result !== mavlink20.MAV_RESULT_IN_PROGRESS) {
                        PendingAcks.delete(m.command);
                        if (m.result !== mavlink20.MAV_RESULT_ACCEPTED) {
                            const msg = `CMD ${mavCmdName(m.command)}: ${mavResultName(m.result)}`;
                            // Log to STATUSTEXT panel and show a bottom-of-map toast
                            try { StatusLog.push(mavlink20.MAV_SEVERITY_ERROR ?? 3, msg); } catch {}
                            try { window.GCSUtils.toast(msg, 3000); } catch {}
                        }
                    }
                }
            }
        }

        // Status messages
        if (m._name === "STATUSTEXT") {
            StatusLog.push(m.severity, m.text);
        }
    }

    // --- Button Event Handlers ---
    armBtn.onclick = () => {
        sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [1]);
        window.GCSUtils.toast("ARM sent");
    };

    disarmBtn.onclick = () => {
        sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [0]);
        window.GCSUtils.toast("DISARM sent");
    };

    rtlBtn.onclick = () => {
        sendSetMode(window.GCSUtils.roverModes.RTL);
        window.GCSUtils.toast("RTL sent");
    };

    loiterBtn.onclick = () => {
        sendSetMode(window.GCSUtils.roverModes.LOITER);
        window.GCSUtils.toast("LOITER sent");
    };

    recenterBtn.onclick = () => {
        MapManager.recenterOnVehicle();
    };

    // Handle long press for repositioning
    window.addEventListener('mapLongPress', (e) => {
        const { lat, lng } = e.detail;
        sendCommandInt(mavlink20.MAV_CMD_DO_REPOSITION, [
            0, mavlink20.MAV_DO_REPOSITION_FLAGS_CHANGE_MODE, 0, 0,
            lat * 1e7, lng * 1e7, 0
        ]);
        window.GCSUtils.toast("DO_REPOSITION sent");
    });

    // --- Initialize Everything ---
    initTelemetryDisplay();
    initMenuButton();
    initConnection();

    // Start LTE update timer
    setInterval(updateLTE, 1000);

    console.log("Simple GCS Map ready.");
})();
