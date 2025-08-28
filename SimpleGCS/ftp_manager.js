/* ftp_manager.js
   Singleton wrapper to ensure only one MAVFTP operation runs at a time,
   queueing additional requests.
*/
(() => {
    const State = {
        MAVLink: null,
        ws: null,
        ftp: null,
        targetSys: 1,
        targetComp: 1,
        busy: false,
        q: [],              // pending jobs
        current: null       // { type, path, tag, cb, timeoutMs, timer, _completed, _canceled }
    };

    const DEFAULT_TIMEOUT = 5000; // ms

    function ensureFtp() {
        if (!State.MAVLink || !State.ws) return null;
        if (!State.ftp) {
            try {
                State.ftp = new MAVFTP(State.MAVLink, State.ws);
                State.ftp.targetSystem = State.targetSys;
                State.ftp.targetComponent = State.targetComp;
            } catch (e) {
                console.warn('[FTPManager] failed to construct MAVFTP', e);
                State.ftp = null;
                return null;
            }
        }
        return State.ftp;
    }

    function finishCurrent() {
        if (State.current && State.current.timer) {
            try { clearTimeout(State.current.timer); } catch {}
        }
        State.current = null;
        State.busy = false;
        pump();
    }

    function pump() {
        if (State.busy) return;
        // Drop canceled jobs from the front
        while (State.q.length && State.q[0]._canceled) State.q.shift();
        const job = State.q.shift();
        if (!job) return;

        const ftp = ensureFtp();
        if (!ftp) { try { job.cb && job.cb(null); } finally { pump(); } return; }

        State.busy = true;
        State.current = job;

        const timeoutMs = Math.max(0, (job.timeoutMs == null ? DEFAULT_TIMEOUT : job.timeoutMs));
        job.timer = setTimeout(() => {
            if (job._completed) return;
            job._timedOut = true;
            console.warn('[FTPManager] timeout:', job.desc || job.path || job.type);
            try { job.cb && job.cb(null); } finally { finishCurrent(); }
        }, timeoutMs);

        try {
            if (job.type === 'get') {
                ftp.getFile(job.path, (data) => {
                    if (job._completed) return; // guard against double-completion
                    job._completed = true;
                    if (job.timer) { try { clearTimeout(job.timer); } catch {} }
                    try { job.cb && job.cb(data || null); } finally { finishCurrent(); }
                });
            } else {
                throw new Error('Unknown job type: ' + job.type);
            }
        } catch (e) {
            console.warn('[FTPManager] job threw:', e);
            if (job.timer) { try { clearTimeout(job.timer); } catch {} }
            try { job.cb && job.cb(null); } finally { finishCurrent(); }
        }
    }

    const API = {
        setLink(MAVLink, ws, sysId, compId) {
            State.MAVLink = MAVLink || null;
            State.ws = ws || null;
            if (typeof sysId === 'number') State.targetSys = sysId;
            if (typeof compId === 'number') State.targetComp = compId;
            // Recreate ftp on demand for a fresh link
            State.ftp = null;
        },
        clearLink() {
            // Abort current job (it will complete with null)
            if (State.current && State.current.timer) {
                try { clearTimeout(State.current.timer); } catch {}
            }
            State.current = null;
            State.busy = false;
            // Clear queue
            State.q.length = 0;
            // Drop link
            State.ws = null;
            State.ftp = null;
        },
        handleMessage(m) {
            // Deliver FTP payloads to MAVFTP instance if present
            if (!State.ftp || !m) return;
            try { State.ftp.handleMessage(m); } catch (e) {
                // Swallow to avoid wedging the queue
                console.warn('[FTPManager] handleMessage error', e);
            }
        },
        /**
         * getFile(path, cb, opts)
         * opts: {
         *   tag?: string,
         *   dropQueuedTag?: boolean,
         *   dropQueuedPath?: boolean,
         *   timeoutMs?: number
         * }
         */
        getFile(path, cb, opts) {
            const o = opts || {};
            const tag = o.tag;
            if (o.dropQueuedTag && tag) {
                // Mark any queued jobs with same tag as canceled
                State.q.forEach(j => { if (j.tag === tag) j._canceled = true; });
            }
            if (o.dropQueuedPath) {
                State.q.forEach(j => { if (j.path === path) j._canceled = true; });
            }
            State.q.push({
                type: 'get',
                path,
                cb,
                tag,
                timeoutMs: o.timeoutMs,
                desc: `get ${path}`
            });
            pump();
        },
        cancelQueuedByTag(tag) {
            State.q.forEach(j => { if (j.tag === tag) j._canceled = true; });
        },
        cancelQueuedByPath(path) {
            State.q.forEach(j => { if (j.path === path) j._canceled = true; });
        },
        // Optional helpers for debugging
        isBusy() { return !!State.busy; },
        queuedCount() { return State.q.filter(j => !j._canceled).length + (State.current ? 1 : 0); }
    };

    window.FTPManager = API;
})();
