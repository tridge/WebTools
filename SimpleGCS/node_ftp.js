//!/usr/bin/env node

const WebSocket = require('ws');

global.jspack = new (require('../modules/MAVLink/local_modules/jspack/jspack.js')).default;

const mavlib = require('../modules/MAVLink/mavlink.js');  // Use local MAVLink definition

if (process.argv.length < 3) {
    console.error("Usage: node cli_test.js <WebSocket URL>");
    process.exit(1);
}

//process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

if (process.argv.length < 6) {
    console.log("Usage: node_ftp.js WSSURI signing_passphrase ftp_path save_path");
    process.exit(3);
}

const url = process.argv[2];
const signing_passphrase = process.argv[3];
const ftp_path = process.argv[4];
const save_path = process.argv[5];

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";

// Create a MAVLink v2 parser
parser = new MAVLink20Processor()

const crypto = require('crypto');

function passphrase_to_key(passphrase) {
    return crypto.createHash('sha256').update(Buffer.from(passphrase, 'ascii')).digest();
}

parser.signing.secret_key = passphrase_to_key(signing_passphrase);
parser.signing.sign_outgoing = true;

console.log("Setup signing");

const targetSystem = 1;
const targetComponent = 1;
let vehSysId = -1;
let vehCompId = -1;

const fs = require('fs');

// Shim global window for mavftp.js browser export
global.window = global;

require('../modules/MAVLink/mavftp.js'); // attaches window.MAVFTP

ws.on('open', () => {
    console.log('WS: connected ->', url);
    heartbeat_interval = setInterval(() => {
        try {
            const msg = new mavlib.mavlink20.messages.heartbeat(
		6,  // MAV_TYPE_GCS
		8,  // MAV_AUTOPILOT_INVALID
		0,  // base_mode
		0,  // custom_mode
		4   // MAV_STATE_ACTIVE
            );
	    const pkt = msg.pack(parser);
	    ws.send(pkt);
            console.log("Sent HEARTBEAT");
	} catch (e) {
	    console.error("Error sending HEARTBEAT:", e.message);
	    console.error(e.stack);
	}
    }, 1000);
});

function mav_pretty(msg) {
    // console.log(JSON.stringify(msg, null, 2));

    if (!msg || !msg._name || !msg.fieldnames) {
        return "<invalid MAVLink message>";
    }

    const name = msg._name;
    const fields = msg.fieldnames
        .map(fn => {
            let val = msg[fn];
            if (typeof val === "string") {
                val = `"${val}"`;
            } else if (Array.isArray(val)) {
                val = "[" + val.join(", ") + "]";
            }
            return `${fn}=${val}`;
        })
        .join(", ");

    return `${name} { ${fields} }`;
}

const ftp = new window.MAVFTP(parser,ws);
ftp.targetSystem = targetSystem;
ftp.targetComponent = targetComponent;

ws.on('message', (data) => {
    const buf = (data instanceof ArrayBuffer) ? Buffer.from(data) :
                (Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data));

    console.log(`Received ${buf.length} bytes: [${buf.slice(0, 10).toString('hex')}...]`);

    for (const b of buf) {
        try {
	    const msg = parser.parseChar(b);
            if (msg) {
                console.log(`MAVLink message ID: ${msg._id}`);
                if (msg._name === 'FILE_TRANSFER_PROTOCOL') {
                    ftp.handleMessage(msg);
                }
                if (msg._name === 'HEARTBEAT') {
                    if (msg.sysid != vehSysId) {
                        vehSysId = msg.sysid;
                        vehCompId = msg.compid;
                        ftp.targetSystem = vehSysId;
                        ftp.targetComponent = vehCompId;
                        ftp.getFile(ftp_path, (data) => {
                            if (!data) { if (!silent) toast('Failed to fetch fence'); return; }
                            console.log("Fetched file");
                            fs.writeFileSync(save_path, data);
                            process.exit(0);
                        }, { dropQueuedTag: true, dropQueuedPath: true, timeoutMs: 5000 });
                    }
                }
            }
        } catch (e) {
            console.warn(`Parser error on byte 0x${b.toString(16)}: ${e.message}`);
        }
    }
});

ws.on('close', () => {
    console.log("WebSocket closed");
    clearInterval(heartbeat_interval);
});

ws.on('error', (err) => {
    console.error("WebSocket error:", err.message);
});
