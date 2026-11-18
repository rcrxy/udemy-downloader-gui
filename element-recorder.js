const fs = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MIME_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

function onUdemy(frame, host) {
    if (!frame || frame.detached) return false;
    const url = new URL(frame.url || "about:blank");
    return url.protocol === "https:" && url.hostname === host;
}

function registerElementRecorder(ipcMain, isMainRenderer, getPlayer) {
    let active;

    function publish(job, state, fields = {}) {
        job.state = state;
        if (job.owner.isDestroyed()) return;
        const end = job.pausedAt || Date.now();
        job.owner.send("element-recording:state", {
            state,
            elapsedMs: job.startedAt ? end - job.startedAt - job.pausedDuration : 0,
            includesAudio: job.includesAudio,
            audioWarning: job.audioWarning,
            mode: "element",
            ...fields,
        });
    }

    function settle(job, value, error) {
        if (!job.pending) return;
        const { timer, resolve, reject } = job.pending;
        job.pending = null;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
    }

    function command(job, action) {
        if (job.pending) throw new Error("An element recording command is already running");
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                close(job, { message: "The Udemy player stopped responding", fallback: action === "start" });
            }, action === "stop" ? 20000 : 8000);
            job.pending = { action, resolve, reject, timer };
            try {
                job.frame.send("element-recording:command", job.id, action, job.includeAudio);
            } catch (error) {
                close(job, { message: error.message });
            }
        });
    }

    async function close(job, { keep = false, message, fallback = false } = {}) {
        if (job.closing) return job.closing;
        const starting = job.state === "starting";
        job.closing = (async () => {
            let file;
            try {
                file = await job.openFile;
                await job.writing;
                await file?.close();
            } catch (error) {
                await file?.close().catch(() => {});
                keep = false;
                fallback = false;
                message = error.message;
            }
            if (keep && !job.bytes) {
                keep = false;
                fallback = job.pending?.action !== "stop";
                message ||= "The video element produced no recording data";
            }
            if (!keep && file) await fs.unlink(job.path).catch(console.error);
            job.detach();
            if (active === job) active = null;
            if (!keep && !job.frame.detached) {
                try { job.frame.send("element-recording:command", job.id, "cancel"); } catch {}
            }
            if (fallback) {
                const result = { fallback: message, path: keep ? job.path : null };
                if (starting) settle(job, result);
                else {
                    publish(job, "starting", { ...result, sourceId: job.sourceId });
                    settle(job, result);
                }
            } else if (keep) {
                publish(job, "completed", { path: job.path });
                settle(job, { path: job.path });
            } else {
                const error = message || "Element recording was interrupted";
                publish(job, "error", { error });
                settle(job, null, new Error(error));
            }
        })();
        return job.closing;
    }

    function fromPlayer(event, id) {
        const job = active;
        return job && !job.closing && job.id === id && event.sender === job.contents &&
            event.senderFrame === job.frame && onUdemy(event.senderFrame, job.host) ? job : null;
    }

    ipcMain.handle("element-recording:start", async (event, sourceId, includeAudio) => {
        if (!isMainRenderer(event)) throw new Error("Element recording is only available from the main window");
        if (active) throw new Error("An element recording is already active");
        const player = getPlayer();
        if (!player || player.id !== sourceId) throw new Error("The Udemy player has closed");
        const contents = player.window.webContents;
        const frame = contents.mainFrame;
        if (!onUdemy(frame, player.host)) throw new Error("Open a Udemy course in the player before recording");

        const id = randomUUID();
        const directory = require("./app/helpers/settings").downloadDirectory("Recordings");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const job = {
            id, sourceId, contents, frame, host: player.host, owner: event.sender,
            includeAudio: includeAudio === true,
            pausedDuration: 0,
            bytes: 0,
            path: join(directory, `Udemy Player-${stamp}-${id.slice(0, 8)}.webm`),
        };
        const interrupted = () => close(job, { message: "The Udemy player closed or navigated during recording" });
        const navigating = ({ isMainFrame, isSameDocument }) => {
            if (isMainFrame && !isSameDocument) interrupted();
        };
        job.detach = () => {
            contents.removeListener("did-start-navigation", navigating);
            contents.removeListener("render-process-gone", interrupted);
            contents.removeListener("destroyed", interrupted);
        };
        active = job;
        contents.on("did-start-navigation", navigating);
        contents.once("render-process-gone", interrupted);
        contents.once("destroyed", interrupted);
        publish(job, "starting");
        return command(job, "start");
    });

    ipcMain.handle("element-recording:control", (event, action) => {
        const job = active;
        if (!isMainRenderer(event) || !job || job.owner !== event.sender || job.closing) {
            throw new Error("No element recording is available");
        }
        const allowed = { pause: ["recording"], resume: ["paused"], stop: ["recording", "paused"] };
        if (!Object.hasOwn(allowed, action) || !allowed[action].includes(job.state)) {
            throw new Error("Invalid element recording command");
        }
        if (action === "stop") publish(job, "finalizing");
        return command(job, action);
    });

    ipcMain.handle("element-recording:chunk", async (event, id, chunk) => {
        const job = fromPlayer(event, id);
        if (!job?.openFile || job.writing || !(chunk instanceof ArrayBuffer) ||
            !chunk.byteLength || chunk.byteLength > MAX_CHUNK_BYTES) {
            throw new Error("Invalid element recording chunk");
        }
        const file = await job.openFile;
        if (job.closing || job.writing) throw new Error("Element recording is closing");
        job.writing = file.writeFile(Buffer.from(chunk));
        try {
            await job.writing;
            job.bytes += chunk.byteLength;
        } finally {
            job.writing = null;
        }
    });

    ipcMain.on("element-recording:result", (event, id, result, detail) => {
        const job = fromPlayer(event, id);
        if (!job) return;
        const message = typeof detail === "string" ? detail.slice(0, 240) : undefined;
        if (result === "unavailable") {
            close(job, { message, fallback: true });
        } else if (result === "error") {
            close(job, { message });
        } else if (result === "stopped" || result === "switch-to-window") {
            close(job, { keep: true, message, fallback: result === "switch-to-window" && job.pending?.action !== "stop" });
        } else if (result === "started" && job.pending?.action === "start" && MIME_TYPES.includes(detail?.mimeType)) {
            job.openFile = fs.mkdir(dirname(job.path), { recursive: true }).then(() => fs.open(job.path, "wx"));
            job.openFile.catch((error) => close(job, { message: error.message }));
            job.includesAudio = detail.includesAudio === true;
            job.audioWarning = job.includeAudio && !job.includesAudio ? "The video element has no audio track. Recording video only." : null;
            job.startedAt = Date.now();
            publish(job, "recording");
            settle(job, true);
        } else if (result === "paused" && job.pending?.action === "pause") {
            job.pausedAt = Date.now();
            publish(job, "paused");
            settle(job, true);
        } else if (result === "resumed" && job.pending?.action === "resume") {
            job.pausedDuration += Date.now() - job.pausedAt;
            job.pausedAt = null;
            publish(job, "recording");
            settle(job, true);
        }
    });
}

module.exports = { registerElementRecorder };
