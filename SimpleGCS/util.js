/*
  util.js - Utility functions for the GCS web app
*/

// Toast notification system
function toast(msg, ms = 1500) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
}

// MAVLink string helper
function mavStr(chars) {
    if (typeof chars === "string") return chars.replace(/\0+$/, "");
    if (Array.isArray(chars)) return String.fromCharCode(...chars).replace(/\0+$/, "");
    return String(chars || "").replace(/\0+$/, "");
}

// Vehicle classification
function classifyVehicle(mavType) {
    if (mavType === mavlink20.MAV_TYPE_SURFACE_BOAT) return "boat";
    if (mavType === mavlink20.MAV_TYPE_GROUND_ROVER) return "rover";
    if (mavType === mavlink20.MAV_TYPE_FIXED_WING) return "plane";
    if (mavType === mavlink20.MAV_TYPE_QUADROTOR ||
        mavType === mavlink20.MAV_TYPE_COAXIAL ||
        mavType === mavlink20.MAV_TYPE_HELICOPTER) return "copter";
    return "plane";
}

// MCCMNC mapping for LTE carriers
const MCCMNC_MAP = {
    // Australia
    50501: "AU Telstra",
    50502: "AU Optus",
    50503: "AU Vodafone",

    // United Kingdom (common MNCs)
    23410: "UK O2",
    23411: "UK O2",
    23402: "UK O2",
    23415: "UK Voda",
    23420: "UK Three",
    23430: "UK EE(T-M)",
    23433: "UK EE(O)",
    23431: "UK EE",
    23432: "UK EE",
    23434: "UK EE"
};

// Rover mode definitions
const roverModes = {
    MANUAL: 0,
    ACRO: 1,
    STEERING: 3,
    HOLD: 4,
    LOITER: 5,
    FOLLOW: 6,
    SIMPLE: 7,
    DOCK: 8,
    CIRCLE: 9,
    AUTO: 10,
    RTL: 11,
    SMART_RTL: 12,
    GUIDED: 15,
    INITIALISING: 16,
};

// Rover mode names mapping
const roverModeNames = Object.fromEntries(
    Object.entries(roverModes).map(([k, v]) => [v, k])
);

// Export utilities to global scope
window.GCSUtils = {
    toast,
    mavStr,
    classifyVehicle,
    MCCMNC_MAP,
    roverModes,
    roverModeNames
};
