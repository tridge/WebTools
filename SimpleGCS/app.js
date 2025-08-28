/*
  app.js - Simple, mobile-friendly GCS map for autonomous buoys
*/

(() => {
    // --- State ---
    let MAVLink = new MAVLink20Processor(); // provided by ../modules/MAVLink/mavlink.js
    // IDs we send as (GCS identity)
    let gcsSystemId = 255, gcsComponentId = 190;
    // Target vehicle (auto-discovered from incoming msgs)
    let vehSysId = -1, vehCompId = -1;

    // Vehicle type cache (for icon)
    const VehicleType = { mavType: null, cls: "plane", lastSeen: 0 };

    // Map + marker
    const map = L.map(document.getElementById("map"), { zoomControl: true }).setView([0,0], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);

    // add a scale bar
    L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 300 }).addTo(map);

    // init UserLocation
    UserLocation.init(map, { autoCenterFirstFix: true });

    // optional grid overlay
    MetricGrid.init(map); // optional opts: { color: 'rgba(255,235,59,.6)', targetPx: 150, lineWidth: 1 }

    // setup fence and mission code
    Fence.init({ map, MAVLink, toast, sendCommandInt });
    Mission.init({ map, MAVLink, toast, sendCommandInt });

    // prevent iPhone popup menus
    map.getContainer().addEventListener("contextmenu", (e) => e.preventDefault());

    let vehicleMarker = null;
    let appliedVehClass = null;
    let lastHeadingDeg = null;

    // marker for vehicle target
    let targetMarker = null;

    // Toolbar
    const armBtn = document.getElementById("armBtn");
    const disarmBtn = document.getElementById("disarmBtn");
    const rtlBtn = document.getElementById("rtlBtn");
    const loiterBtn = document.getElementById("loiterBtn");
    const recenterBtn = document.getElementById("recenterBtn");
    const connectBtn = document.getElementById("connectBtn");

    // Connection
    let ws = null;
    let hbInterval = null;
    let setupSigning = false;

    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let intentionalDisconnect = false;
    let lastConnectionUrl = null;
    let doneConnect = false;

    // dictionary of all received messages
    let messages = {};

    const roverModes = {
        MANUAL       : 0,
        ACRO         : 1,
        STEERING     : 3,
        HOLD         : 4,
        LOITER       : 5,
        FOLLOW       : 6,
        SIMPLE       : 7,
	DOCK         : 8,
	CIRCLE       : 9,
        AUTO         : 10,
        RTL          : 11,
        SMART_RTL    : 12,
        GUIDED       : 15,
        INITIALISING : 16,
    };

    // MCCMNC → human label (AU big 3 + major UK carriers)
    const MCCMNC_MAP = {
	// Australia
	50501: "AU Telstra",
	50502: "AU Optus",
	50503: "AU Vodafone",

	// United Kingdom (common MNCs)
	23410: "UK O2",
	23411: "UK O2",
	23402: "UK O2",          // legacy/alt O2 code seen in field
	23415: "UK Vodafone",
	23420: "UK Three",
	23430: "UK EE (T-Mobile)",
	23433: "UK EE (Orange)",
	23431: "UK EE",
	23432: "UK EE",
	23434: "UK EE"
    };
    
    // --- Helpers ---
    function toast(msg, ms=1500) {
	const el = document.createElement("div");
	el.className = "toast";
	el.textContent = msg;
	document.body.appendChild(el);
	setTimeout(() => el.remove(), ms);
    }

    function mavStr(chars) {
	if (typeof chars === "string") return chars.replace(/\0+$/, "");
	if (Array.isArray(chars)) return String.fromCharCode(...chars).replace(/\0+$/, "");
	return String(chars || "").replace(/\0+$/, "");
    }

    // --- COMMAND_INT helper ---
    function sendCommandInt(cmd, params = []) {
	if (!ws) { toast("Not connected"); return; }
	const payload = new mavlink20.messages.command_int(
	    vehSysId,         // target_system
	    vehCompId,        // target_component
	    mavlink20.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
	    cmd,              // command
	    0, 0,
	    params[0] || 0, params[1] || 0, params[2] || 0, params[3] || 0,
	    params[4] || 0, params[5] || 0, params[6] || 0
	);
	const pkt = payload.pack(MAVLink);
	ws.send(Uint8Array.from(pkt));
    }

    function sendSetMode(mode) {
	if (!ws) { toast("Not connected"); return; }
	sendCommandInt(mavlink20.MAV_CMD_DO_SET_MODE, [ mavlink20.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, mode ]);
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

    // make rover mode names map
    const roverModeNames = Object.fromEntries(Object.entries(roverModes).map(([k,v]) => [v, k]));

    let lastTargetSeenMs = 0;

    // Create telemetry display elements
    function initTelemetryDisplay() {
	// Find the toolbar
	const toolbar = document.getElementById("toolbar");

	// Create telemetry container
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

	// Status (armed + mode)
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

	// Insert before the flex spacer
	const spacer = toolbar.querySelector('div[style*="flex:1"]');
	toolbar.insertBefore(telemetryDiv, spacer);


    }

    function updateTelemetryDisplay() {
	const batteryEl = document.getElementById("battery-value");
	const currentEl = document.getElementById("current-value");
	const speedEl = document.getElementById("speed-value");
	const armedEl = document.getElementById("armed-pill");
	const modeEl = document.getElementById("mode-value");

	// battery
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

	if (currentEl) {
	    if (telemetry.currentA !== null && telemetry.currentA >= 0) {
		currentEl.textContent = `${telemetry.currentA.toFixed(1)} A`;
	    } else {
		currentEl.textContent = "--- A";
	    }
	}

	// speed
	if (speedEl) {
	    if (telemetry.speed >= 0) {
		var speed_knots = 1.94384449 * telemetry.speed;
		speedEl.textContent = `${speed_knots.toFixed(1)} knots`;
	    } else {
		speedEl.textContent = "--- knots";
	    }
	}

	// armed + mode
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

    // Call initTelemetryDisplay() after the DOM is ready
    initTelemetryDisplay();

    // --- StatusText log
    const StatusLog = {
	max: 500,
	items: [],          // { t: Date, sev: number, txt: string }

	push(sev, txt) {
            // normalise & strip trailing NULs
            if (Array.isArray(txt)) txt = String.fromCharCode(...txt);
            txt = String(txt || "").replace(/\0+$/, "");
            this.items.push({ t: new Date(), sev: sev ?? -1, txt });
            if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
            this.renderIfOpen();
	},

	// severity to short tag
	tag(sev) {
            const map = ["EMERG","ALERT","CRIT","ERR","WARN","NOTICE","INFO","DEBUG"];
            // MAV_SEVERITY matches this order in ArduPilot (0..7)
            return (sev >= 0 && sev < map.length) ? map[sev] : "INFO";
	},

	// UI
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
            // ~10 rows visible. line-height ~1.25 → height ≈ 10*1.25em + padding
            box.style.cssText = `
      margin:0; background:#111; color:#eee; border-radius:6px;
      padding:8px; max-height:15.5em; overflow:auto;
      font: 12px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap; word-break: break-word;
    `;
            this._box = box;

            // tiny footer
            const help = document.createElement("div");
            help.style.cssText = "opacity:.7; font-size:12px;";
            help.textContent = "Newest at the bottom. Keeps last 500 messages.";

            wrap.append(header, box, help);

            this._tip = tippy(anchorEl, {
		content: wrap,
		interactive: true,
		trigger: "click",
		theme: "light-border",
		placement: "right-end", // Changed from "right-start" to avoid overlap
		appendTo: () => document.body,
		zIndex: 9999, // Lower z-index than menu
		onShow: () => this.renderIfOpen()
            });

            this._tip.show();
	},

	renderIfOpen() {
            if (!this._box) return;
            const lines = this.items.map(it => {
		// HH:MM:SS  [SEV] message
		const t = it.t.toTimeString().slice(0,8);
		return `${t}  [${this.tag(it.sev)}] ${it.txt}`;
            });
            this._box.textContent = lines.join("\n");
            // autoscroll to bottom
            this._box.scrollTop = this._box.scrollHeight;
	}
    };

    // setup the menu
    initMenuButton();

    function sendReboot() {
	sendCommandInt(mavlink20.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, [1])
    }

    function sendForceDisarm() {
	sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [0, 21196])
    }

    function sendForceArm() {
	sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [1, 21196])
    }

    // Initialize menu button
    function initMenuButton() {
	const toolbar = document.getElementById("toolbar");
	const recenterBtn = document.getElementById("recenterBtn");

	// Create menu button
	const menuBtn = document.createElement("button");
	menuBtn.id = "menuBtn";
	menuBtn.className = "btn small";
	menuBtn.innerHTML = "☰"; // Hamburger icon
	menuBtn.style.fontSize = "18px";

	// Insert before recenter button
	toolbar.insertBefore(menuBtn, recenterBtn);

	// Create menu using Tippy
	const menuDiv = document.createElement("div");
	menuDiv.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 4px;
        min-width: 150px;
    `;

	// Menu items
	const menuItems = [
            { text: "Toggle Grid", action: () => { MetricGrid.toggle(); menuTip.hide(); } },
	    { text: "Video (Inset)", action: () => { window.VideoPanel?.toggle(); menuTip.hide(); }},
	    { text: "Video (New Window)", action: () => { window.VideoPanel?.openNewWindow(); menuTip.hide(); }},
            { text: "Messages", action: () => { StatusLog.open(menuBtn); menuTip.hide(); } },
	    { text: "My Location", action: () => { UserLocation.toggle(); menuTip.hide(); } },
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

	// Create Tippy tooltip as menu with higher z-index
	const menuTip = tippy(menuBtn, {
            content: menuDiv,
            interactive: true,
            trigger: "click",
            theme: "light-border",
            placement: "right-start",
            appendTo: () => document.body,
            zIndex: 10000 // Higher z-index than messages dialog
	});

	return menuBtn;
    }

    function classifyVehicle(mavType) {
	if (mavType === mavlink20.MAV_TYPE_SURFACE_BOAT) return "boat";     // MAV_TYPE_SURFACE_BOAT
	if (mavType === mavlink20.MAV_TYPE_GROUND_ROVER) return "rover";    // MAV_TYPE_GROUND_ROVER
	if (mavType === mavlink20.MAV_TYPE_FIXED_WING)  return "plane";    // MAV_TYPE_FIXED_WING
	if (mavType === mavlink20.MAV_TYPE_QUADROTOR || mavType === mavlink20.MAV_TYPE_COAXIAL || mavType === mavlink20.MAV_TYPE_HELICOPTER) return "copter"; // quad/coax/heli
	return "plane";
    }

    function makeSvgIcon(kind, rotateDeg = 0) {
	const paths = {
	    plane: `
        <!-- Fixed-wing aircraft top view -->
        <g stroke-width="1" stroke="#333" fill="#e53935">
          <!-- Fuselage -->
          <path d="M12,20 L11,17 L11,10 L10,7 L10,4 L12,2 L14,4 L14,7 L13,10 L13,17 L12,20 Z"/>
          <!-- Main wings -->
          <path d="M3,11 L11,12 L11,14 L3,13 Z"/>
          <path d="M21,11 L13,12 L13,14 L21,13 Z"/>
          <!-- Tail wings -->
          <path d="M7,18 L11,17 L11,18 L7,19 Z"/>
          <path d="M17,18 L13,17 L13,18 L17,19 Z"/>
        </g>
      `,
	    copter: `
        <!-- Quadcopter top view -->
        <g stroke-width="1" stroke="#333" fill="#ff9800">
          <!-- Center body -->
          <circle cx="12" cy="12" r="3"/>
          <!-- Arms -->
          <rect x="11" y="4" width="2" height="16" />
          <rect x="4" y="11" width="16" height="2" />
          <!-- Motors/props -->
          <circle cx="12" cy="5" r="2.5" fill="#666"/>
          <circle cx="12" cy="19" r="2.5" fill="#666"/>
          <circle cx="5" cy="12" r="2.5" fill="#666"/>
          <circle cx="19" cy="12" r="2.5" fill="#666"/>
        </g>
      `,
	    rover: `
        <!-- Ground vehicle top view -->
        <g stroke-width="1" stroke="#333" fill="#4caf50">
          <!-- Main body -->
          <rect x="7" y="6" width="10" height="12" rx="2"/>
          <!-- Wheels -->
          <rect x="5" y="7" width="3" height="4" fill="#333" rx="0.5"/>
          <rect x="16" y="7" width="3" height="4" fill="#333" rx="0.5"/>
          <rect x="5" y="13" width="3" height="4" fill="#333" rx="0.5"/>
          <rect x="16" y="13" width="3" height="4" fill="#333" rx="0.5"/>
          <!-- Direction indicator -->
          <path d="M12,6 L10,9 L12,8 L14,9 Z" fill="#fff"/>
        </g>
      `,
	    boat: `
        <!-- Boat/USV top view -->
        <g stroke-width="1" stroke="#333" fill="#2196f3">
          <!-- Hull shape - pointed bow -->
          <path d="M12,4 L8,10 L8,18 Q12,20 12,20 Q12,20 16,18 L16,10 L12,4 Z"/>
          <!-- Deck detail -->
          <rect x="10" y="11" width="4" height="5" fill="#1976d2" rx="0.5"/>
          <!-- Bow indicator -->
          <path d="M12,4 L11,7 L12,6 L13,7 Z" fill="#fff"/>
        </g>
      `
	};

	const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" style="transform: rotate(${rotateDeg}deg); transform-origin: center;">
        ${paths[kind] || paths.plane}
      </svg>`;

	return L.divIcon({
	    html: svg,
	    className: "veh-ico",
	    iconSize: [40, 40],
	    iconAnchor: [20, 20]
	});
    }

    function ensureMarker(lat, lon) {
	if (!vehicleMarker) {
	    vehicleMarker = L.marker([lat, lon], { icon: makeSvgIcon(VehicleType.cls, lastHeadingDeg || 0) }).addTo(map);
	    appliedVehClass = VehicleType.cls;
	} else {
	    vehicleMarker.setLatLng([lat, lon]);
	}

	// Update icon if vehicle class changed or heading changed
	if (appliedVehClass !== VehicleType.cls || lastHeadingDeg != null) {
	    vehicleMarker.setIcon(makeSvgIcon(VehicleType.cls, lastHeadingDeg || 0));
	    appliedVehClass = VehicleType.cls;
	}
    }

    function rotateMarker(deg) {
	if (!vehicleMarker) return;

	// Update the icon with new rotation
	vehicleMarker.setIcon(makeSvgIcon(VehicleType.cls, deg));
    }

    function updateHeadingFromATTITUDE(yawRad) {
	let deg = yawRad * 180/Math.PI;
	deg = (deg + 360) % 360;
	lastHeadingDeg = deg;
	rotateMarker(deg);
    }

    // update vehicle target position
    function updateTargetPosition(lat, lon) {
	if (!targetMarker) {
	    // Create a small red circle marker for the target
	    targetMarker = L.circleMarker([lat, lon], {
		radius: 8,
		color: '#f44336',
		fillColor: '#f44336',
		fillOpacity: 0.6,
		weight: 2
	    }).addTo(map);
	    targetMarker.bindPopup("Target Position");
	} else {
	    targetMarker.setLatLng([lat, lon]);
	}
    }

    function updateLTE() {
	const carrierEl = document.getElementById("lte-carrier");
	const rsrpEl = document.getElementById("lte-rsrp");
	if (!carrierEl || !rsrpEl) return;

	const sys = vehSysId;
	sysmsgs = messages[sys];
	if (!sysmsgs) return;

	const nvf_mcc = sysmsgs["NAMED_VALUE_FLOAT[LTE_MCCMNC]"];
	const nvf_rsrp = sysmsgs["NAMED_VALUE_FLOAT[LTE_RSRP]"];

	// Carrier
	let carrierTxt = "—";
	if (nvf_mcc && typeof nvf_mcc.value === "number") {
	    const code = Math.round(nvf_mcc.value);
	    carrierTxt = MCCMNC_MAP[code] || String(code);
	}
	carrierEl.textContent = carrierTxt;

	// RSRP (0.1 dB units → dBm)
	let rsrpTxt = "— dBm";
	if (nvf_rsrp && typeof nvf_rsrp.value === "number") {
	    const dbm = nvf_rsrp.value / 10.0; // e.g. -1045 → -104.5
	    rsrpTxt = `${dbm.toFixed(1)} dBm`;
	}
	rsrpEl.textContent = rsrpTxt;
    }

    // refresh every second
    setInterval(updateLTE, 1000);
    
    // remove the target marker when not needed:
    function clearTargetPosition() {
	if (targetMarker) {
	    map.removeLayer(targetMarker);
	    targetMarker = null;
	}
    }

    // --- Connection dialog on left-bar Connect button ---
    (function initConnectTip(){
	const button = connectBtn;
	const tipDiv = document.createElement("div");
	tipDiv.appendChild(document.importNode(document.getElementById("connection_tip_template").content, true));
	const tip = tippy(button, {
	    content: tipDiv, interactive: true, trigger: "click", theme: "light-border",
	    appendTo: () => document.body, placement: "right-start"
	});
	tipDiv.querySelector("#Close").onclick = () => tip.hide();

	const url_input = tipDiv.querySelector("#target_url");
	const hb_checkbox = tipDiv.querySelector("#send_heartbeat");
	const passphrase_input = tipDiv.querySelector("#signing_passphrase");
	const connect_btn = tipDiv.querySelector("#connection_button");
	const disconnect_btn = tipDiv.querySelector("#disconnection_button");

	// use random sysid and compid so multiple users are less likely to collide
	const sys_input = tipDiv.querySelector("#system_id");
	const comp_input = tipDiv.querySelector("#component_id");
	// default random IDs between 100–200 inclusive
	function rand100_200() {
	    return Math.floor(Math.random() * 101) + 100; // 0–100 + 100 → 100–200
	}
	sys_input.value = rand100_200();
	comp_input.value = rand100_200();

	const LS_KEYS = {
	    url: "gcs.url",
	    pass: "gcs.passphrase"
	};

	// preload saved values (fallbacks preserved)
	url_input.value = localStorage.getItem(LS_KEYS.url) || "wss://anusc.tridgell.net:20001";
	passphrase_input.value = localStorage.getItem(LS_KEYS.pass) || "";


	function applyIds() {
	    let sid = parseInt(sys_input.value || "255", 10);
	    let cid = parseInt(comp_input.value || "190", 10);
	    sid = (sid>=1 && sid<=255) ? sid : 255;
	    cid = (cid>=0 && cid<=255) ? cid : 190;
	    gcsSystemId = sid; gcsComponentId = cid;

	    MAVLink.srcSystem = sid;
	    MAVLink.srcComponent = cid;
	}

	function setConnState(state) {
	    // color feedback on the left button
	    if (state === "connected")      button.style.background = "#00c853";
	    else if (state === "connecting")button.style.background = "#f9a825";
	    else if (state === "error")     button.style.background = "#e53935";
	    else                             button.style.background = ""; // default style
	}

	function startHeartbeatLoop() {
	    if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
	    if (!hb_checkbox.checked) return;
	    hbInterval = setInterval(() => {
		try {
		    if (!setupSigning) {
			const pass = passphrase_input.value.trim();
			if (pass.length > 0) {
			    setupSigning = true;
			    const enc = new TextEncoder();
			    const hash = mavlink20.sha256(enc.encode(pass));
			    MAVLink.signing.secret_key = new Uint8Array(hash);
			    MAVLink.signing.sign_outgoing = true;
			}
		    }
		    const msg = new mavlink20.messages.heartbeat(
			6, // MAV_TYPE_GCS
			8, // MAV_AUTOPILOT_INVALID
			0, 0, 4
		    );
		    const pkt = msg.pack(MAVLink);
		    ws?.send(Uint8Array.from(pkt));
		} catch (e) {
		    console.error("Heartbeat send failed:", e?.message || e);
		    if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
		    setConnState("error");
		    toast("Heartbeat stopped after error");
		}
	    }, 1000);
	}

	function connect(url) {
	    applyIds();

	    // Store the URL for reconnection attempts
	    lastConnectionUrl = url;
	    intentionalDisconnect = false; // Reset intentional disconnect flag

	    if (ws) disconnect(false); // Don't set intentional flag when reconnecting
	    setupSigning = false;

	    setConnState("connecting");
	    ws = new WebSocket(url);
	    ws.binaryType = "arraybuffer";

	    ws.onopen = () => {
		tip.hide();
		setConnState("connected");

		// Reset reconnect attempts on successful connection
		reconnectAttempts = 0;
		if (reconnectTimer) {
		    clearTimeout(reconnectTimer);
		    reconnectTimer = null;
		}

		startHeartbeatLoop();
		toast("Connected");
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

		// Only attempt reconnect if it wasn't an intentional disconnect
		if (!intentionalDisconnect) {
		    setConnState("error");
		    scheduleReconnect();
		} else {
		    setConnState(""); // default state for intentional disconnect
		    toast("Disconnected");
		}
	    };

	    ws.onmessage = (evt) => {
		const buf = new Uint8Array(evt.data);
		MAVLink.pushBuffer(buf);
		while (true) {
		    const m = MAVLink.parseChar(null);
		    if (m === null) break;
		    if (m._id == -1) continue;

		    // update messages dictionary
		    if (!(m.sysid in messages)) {
			messages[m.sysid] = {};
		    }
		    messages[m.sysid][m._name] = m;

		    const trimNuls = v => (typeof v === "string" ? v.replace(/\0+$/, "") : v);

		    if (m._instance_field !== undefined) {
			let instance_value = trimNuls(m[m._instance_field]);
			messages[m.sysid][`${m._name}[${instance_value}]`] = m;
		    }

		    // HEARTBEAT => vehicle type
		    if (m._name === "HEARTBEAT" && m.autopilot == mavlink20.MAV_AUTOPILOT_ARDUPILOTMEGA) {

			// Learn target addresses
			if (m.sysid != vehSysId) {
			    vehSysId = m.sysid;
			    vehCompId = m.compid;
			    FTPManager.setLink(MAVLink, ws, vehSysId, vehCompId);
			    Fence.onConnected(ws);
			    Mission.onConnected(ws);
			}

			VehicleType.mavType = m.type;
			VehicleType.cls = classifyVehicle(m.type);
			VehicleType.lastSeen = Date.now();

			telemetry.armed = !!(m.base_mode & mavlink20.MAV_MODE_FLAG_SAFETY_ARMED);
			// Mode name: for Rover/Boat use known names; otherwise show numeric
			const isRoverish = (VehicleType.mavType === mavlink20.MAV_TYPE_GROUND_ROVER) ||
			      (VehicleType.mavType === mavlink20.MAV_TYPE_SURFACE_BOAT);
			telemetry.modeName = isRoverish ? (roverModeNames[m.custom_mode] || `${m.custom_mode}`) : `${m.custom_mode}`;

			updateTelemetryDisplay();
		    }

		    // GLOBAL_POSITION_INT => lat/lon + heading if present and speed
		    if (m._name === "GLOBAL_POSITION_INT") {
			const lat = m.lat / 1e7, lon = m.lon / 1e7;
			ensureMarker(lat, lon);
			if (!map._movedOnce) { map.setView([lat, lon], 16); map._movedOnce = true; }

			// Calculate ground speed from vx and vy (cm/s)
			const vx_ms = m.vx / 100.0;  // Convert cm/s to m/s
			const vy_ms = m.vy / 100.0;
			telemetry.speed = Math.sqrt(vx_ms * vx_ms + vy_ms * vy_ms);
			updateTelemetryDisplay();
		    }

		    // ATTITUDE => yaw (continuous)
		    if (m._name === "ATTITUDE") {
			if (typeof m.yaw === "number") updateHeadingFromATTITUDE(m.yaw);
		    }

		    // Handle FTP messages
		    if (m._name === "FILE_TRANSFER_PROTOCOL") {
			FTPManager.handleMessage(m);
		    }

		    // BATTERY_STATUS => battery percentage
		    if (m._name === "BATTERY_STATUS") {
			telemetry.batteryPct = m.battery_remaining;
			telemetry.lastUpdate = Date.now();
			telemetry.currentA = m.current_battery / 100.0;
			updateTelemetryDisplay();
		    }

		    // SYS_STATUS => sensor state
		    if (m._name === "SYS_STATUS") {
			const sensors_present = m.onboard_control_sensors_present;
			const sensors_enabled = m.onboard_control_sensors_enabled;
			const sensors_health = m.onboard_control_sensors_health;
			Fence.setEnabled((sensors_enabled & mavlink20.MAV_SYS_STATUS_GEOFENCE) != 0);
		    }
		    
		    if (m._name === "POSITION_TARGET_GLOBAL_INT") {
			if (m.lat_int !== 0 || m.lon_int !== 0) {
			    const lat = m.lat_int / 1e7;
			    const lon = m.lon_int / 1e7;
			    updateTargetPosition(lat, lon);
			    lastTargetSeenMs = Date.now();
			} else {
			    clearTargetPosition();
			    lastTargetSeenMs = 0;
			}
		    }

		    // STATUSTEXT / STATUSTEXT_LONG => capture into Messages log
		    if (m._name === "STATUSTEXT") {
			StatusLog.push(m.severity, m.text);
		    }
		};
	    }
	}

	function scheduleReconnect() {
	    // Don't schedule if we're already scheduled or if user disconnected intentionally
	    if (reconnectTimer || intentionalDisconnect) return;

	    reconnectAttempts++;
	    const delay = 2000; // 2 seconds

	    reconnectTimer = setTimeout(() => {
		reconnectTimer = null;

		if (!intentionalDisconnect && lastConnectionUrl) {
		    connect(lastConnectionUrl);
		}
	    }, delay);
	}

	function disconnect(intentional = true) {
	    // Set the intentional disconnect flag
	    intentionalDisconnect = intentional;

	    // Clear any pending reconnection attempts
	    if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	    }

	    // Reset reconnect attempts if this is intentional
	    if (intentional) {
		reconnectAttempts = 0;
		lastConnectionUrl = null;
	    }

	    if (ws) {
		try {
		    ws.close();
		} catch {}
	    }
	    ws = null;

	    if (hbInterval) {
		clearInterval(hbInterval);
		hbInterval = null;
	    }

	    if (intentional) {
		setConnState("");
		toast("Disconnected");
	    }

	    clearTargetPosition();
	}

	connect_btn.onclick = () => {
	    if (!url_input.checkValidity()) { toast("Enter ws:// or wss:// URL"); url_input.focus(); return; }

	    // remember URL and passphrase
	    localStorage.setItem(LS_KEYS.url, url_input.value.trim());
	    const pass = passphrase_input.value.trim();
	    if (pass.length) {
		localStorage.setItem(LS_KEYS.pass, pass);
	    } else {
		localStorage.removeItem(LS_KEYS.pass); // don't store empty
	    }

	    connect(url_input.value);
	};

	disconnect_btn.onclick = () => {
	    disconnect(true); // Explicitly mark as intentional
	};

	// --- Auto-connect on first load (retry up to 5x, 1s gap) ---
	(function autoConnectWithRetry() {
	    if (doneConnect) return;

	    // Persist the preloaded (cached/default) values
	    localStorage.setItem(LS_KEYS.url, (url_input.value || '').trim());
	    const pass = (passphrase_input.value || '').trim();
	    if (pass.length) localStorage.setItem(LS_KEYS.pass, pass);

	    const url = url_input.value;

	    let tries = 0;
	    const maxTries = 5;

	    const tick = () => {
		// If we're already open, mark success and stop
		if (ws && ws.readyState === WebSocket.OPEN) {
		    doneConnect = true;
		    return;
		}
		// If we're connecting, just check again shortly
		if (ws && ws.readyState === WebSocket.CONNECTING) {
		    return void setTimeout(tick, 1000);
		}
		// Otherwise, attempt a connect (up to maxTries)
		if (++tries > maxTries) return;
		console.log("Trying connect");
		connect(url);
		setTimeout(tick, 1000);
	    };

	    tick();
	})();
    })();

    // Buttons
    armBtn.onclick = () => { sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [1]); toast("ARM sent"); };       // MAV_CMD_COMPONENT_ARM_DISARM
    disarmBtn.onclick = () => { sendCommandInt(mavlink20.MAV_CMD_COMPONENT_ARM_DISARM, [0]); toast("DISARM sent"); };
    rtlBtn.onclick = () => { sendSetMode(roverModes.RTL, []); toast("RTL sent"); };
    loiterBtn.onclick = () => { sendSetMode(roverModes.LOITER, []); toast("LOITER sent"); };
    recenterBtn.onclick = () => {
	if (vehicleMarker) {
	    const ll = vehicleMarker.getLatLng();
	    map.setView(ll, Math.max(map.getZoom(), 16));
	}
    };

    // --- Long-press to DO_REPOSITION (desktop + mobile), avoids pan-as-click ---
    (() => {
	const el = map.getContainer();
	let pressTimer = null, startPt = null, lastPt = null, activeId = null;
	const HOLD_MS = 600, MOVE_PX_TOL = 10;

	function clearAll(){ if (pressTimer){ clearTimeout(pressTimer); pressTimer=null; } activeId=null; startPt=lastPt=null; }

	el.addEventListener("pointerdown", (ev) => {
	    if (ev.target.closest(".leaflet-control")) return;
	    if (ev.pointerType === "touch") ev.preventDefault(); // <- suppress iOS long‑press callout

	    activeId = ev.pointerId;
	    startPt = lastPt = map.mouseEventToContainerPoint(ev);
	    pressTimer = setTimeout(() => {
		if (!lastPt) return;
		const ll = map.containerPointToLatLng(lastPt);
		sendCommandInt(mavlink20.MAV_CMD_DO_REPOSITION, [
		    0, mavlink20.MAV_DO_REPOSITION_FLAGS_CHANGE_MODE, 0, 0,
		    ll.lat*1e7, ll.lng*1e7, 0
		]);
		toast("DO_REPOSITION sent");
		clearAll();
	    }, HOLD_MS);
	}, { passive: false });

	el.addEventListener("pointermove", (ev) => {
	    if (ev.pointerId !== activeId) return;
	    if (ev.pointerType === "touch") ev.preventDefault(); // keep iOS from starting callout/scroll
	    lastPt = map.mouseEventToContainerPoint(ev);
	    if (startPt && lastPt && startPt.distanceTo(lastPt) > MOVE_PX_TOL) clearAll();
	}, { passive: false });

	["pointerup","pointercancel","pointerleave","pointerout"].forEach(t =>
	    el.addEventListener(t, (ev) => { if (ev.pointerId === activeId) clearAll(); }, { passive:false })
	);
    })();

    // clear target if stale
    setInterval(() => {
	if (targetMarker && lastTargetSeenMs && (Date.now() - lastTargetSeenMs > 5000)) {
	    clearTargetPosition();
	    lastTargetSeenMs = 0;
	}
    }, 1000);

    console.log("Simple GCS Map ready.");
})();
