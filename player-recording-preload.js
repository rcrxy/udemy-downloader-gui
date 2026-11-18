const { ipcRenderer } = require("electron");

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const MIME_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const DRM_MESSAGE = "This video uses DRM and has been skipped.";
const encryptedVideos = new WeakSet();
let current;

document.addEventListener("encrypted", (event) => {
    encryptedVideos.add(event.target);
    if (current?.video === event.target) abort(current, DRM_MESSAGE);
}, true);

function isProtected(video) {
    return Boolean(video.mediaKeys) || encryptedVideos.has(video);
}

function send(job, result, detail) {
    ipcRenderer.send("element-recording:result", job.id, result, detail);
}

function cleanup(job) {
    if (current !== job) return;
    current = null;
    clearInterval(job.monitor);
    job.video?.removeEventListener("ended", job.ended);
    if (job.recorder) {
        job.recorder.onstop = job.recorder.onerror = job.recorder.ondataavailable = null;
        if (job.recorder.state !== "inactive") job.recorder.stop();
    }
    job.stream?.getTracks().forEach((track) => track.stop());
    if (job.probe) job.probe.srcObject = null;
}

function abort(job, message, result = "error") {
    if (current !== job) return;
    send(job, result, message);
    cleanup(job);
}

function findPlayingVideo() {
    let largest = 0;
    let selected;
    for (const video of document.querySelectorAll("video")) {
        const { width, height } = video.getBoundingClientRect();
        if (video.paused || video.ended || width * height <= largest) continue;
        largest = width * height;
        selected = video;
    }
    return selected;
}

function hasPicture(job) {
    const probe = job.probe;
    if (probe.readyState < 2 || !probe.videoWidth) return false;
    job.context.drawImage(probe, 0, 0, 32, 18);
    const pixels = job.context.getImageData(0, 0, 32, 18).data;
    let visible = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 22 && ++visible >= 6) return true;
    }
    return false;
}

function stop(job, fallbackReason) {
    job.fallbackReason ||= fallbackReason;
    if (job.recorder.state !== "inactive") job.recorder.stop();
}

function queueChunk(job, data) {
    if (!data.size || current !== job) return;
    job.queuedBytes += data.size;
    if (job.queuedBytes > MAX_QUEUED_BYTES) {
        abort(job, "The recording disk writer could not keep up");
        return;
    }
    job.writes = job.writes.then(async () => {
        for (let offset = 0; current === job && offset < data.size; offset += CHUNK_BYTES) {
            const part = await data.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
            if (current !== job) return;
            await ipcRenderer.invoke("element-recording:chunk", job.id, part);
            job.queuedBytes -= part.byteLength;
        }
    }).catch((error) => abort(job, error.message));
}

async function start(id, includeAudio) {
    if (current) return;
    const job = { id, writes: Promise.resolve(), queuedBytes: 0 };
    current = job;
    try {
        const video = job.video = findPlayingVideo();
        const protectedVideo = video ? isProtected(video) : [...document.querySelectorAll("video")].some(isProtected);
        if (protectedVideo) return abort(job, DRM_MESSAGE);
        if (!video || typeof video.captureStream !== "function") {
            return abort(job, "No capturable playing video element was found", "unavailable");
        }
        job.stream = video.captureStream();
        if (!includeAudio) {
            for (const track of job.stream.getAudioTracks()) {
                job.stream.removeTrack(track);
                track.stop();
            }
        }
        if (!job.stream.getVideoTracks().some((track) => track.readyState === "live")) {
            return abort(job, "The video element returned no live video track", "unavailable");
        }
        const probe = job.probe = document.createElement("video");
        probe.muted = true;
        probe.srcObject = job.stream;
        probe.play().catch(() => {});
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        job.context = canvas.getContext("2d", { willReadFrequently: true });
        let picture = false;
        for (let attempt = 0; current === job && attempt < 30; attempt++) {
            if (isProtected(video)) return abort(job, DRM_MESSAGE);
            if (hasPicture(job)) {
                picture = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (current !== job) return;
        if (!picture) return abort(job, "The video element returned black frames or no frames", "unavailable");

        const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
        if (!mimeType) return abort(job, "This video cannot be recorded as WebM", "unavailable");
        const recorder = job.recorder = new MediaRecorder(job.stream, {
            mimeType,
            videoBitsPerSecond: 8_000_000,
            audioBitsPerSecond: 128_000,
        });
        recorder.ondataavailable = ({ data }) => queueChunk(job, data);
        recorder.onerror = ({ error }) => {
            if (isProtected(video)) return abort(job, DRM_MESSAGE);
            stop(job, error?.message || "MediaRecorder failed");
        };
        recorder.onstop = async () => {
            await job.writes;
            if (current !== job) return;
            if (isProtected(video)) return abort(job, DRM_MESSAGE);
            send(job, job.fallbackReason ? "switch-to-window" : "stopped", job.fallbackReason);
            cleanup(job);
        };
        job.ended = () => stop(job);
        video.addEventListener("ended", job.ended);
        let missingSince = null;
        job.monitor = setInterval(() => {
            if (isProtected(video)) return abort(job, DRM_MESSAGE);
            if (recorder.state !== "recording" || (video.isConnected && video.paused)) {
                missingSince = null;
                return;
            }
            const videoTrack = job.stream.getVideoTracks()[0];
            try {
                if (videoTrack?.readyState === "live" && !videoTrack.muted && hasPicture(job)) {
                    missingSince = null;
                    return;
                }
            } catch {}
            missingSince ??= Date.now();
            if (Date.now() - missingSince >= 5000) stop(job, "The video element stopped producing visible frames");
        }, 1000);
        recorder.start(1000);
        send(job, "started", { mimeType, includesAudio: job.stream.getAudioTracks().length > 0 });
    } catch (error) {
        if (job.video && isProtected(job.video)) abort(job, DRM_MESSAGE);
        else abort(job, error.message || "Element capture is unavailable", "unavailable");
    }
}

ipcRenderer.on("element-recording:command", (_event, id, action, includeAudio) => {
    if (action === "start") {
        void start(id, includeAudio);
        return;
    }
    const job = current;
    if (!job || job.id !== id) return;
    if (action === "cancel") return cleanup(job);
    try {
        if (action === "pause") {
            job.recorder.pause();
            send(job, "paused");
        } else if (action === "resume") {
            job.recorder.resume();
            send(job, "resumed");
        } else if (action === "stop") {
            stop(job);
        }
    } catch (error) {
        abort(job, error.message);
    }
});
