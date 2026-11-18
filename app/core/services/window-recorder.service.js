"use strict";

const fs = require("fs");
const path = require("path");
const sanitize = require("sanitize-filename");

const MIME_TYPES = [
	"video/webm;codecs=vp9,opus",
	"video/webm;codecs=vp8,opus",
	"video/webm",
];

function chooseMimeType(MediaRecorderClass) {
	return MIME_TYPES.find((type) => MediaRecorderClass.isTypeSupported(type)) || "";
}

function timestamp(date) {
	return date.toISOString().replace(/[:.]/g, "-");
}

class WindowRecorder {
	constructor({
		listSources,
		getOutputDirectory,
		mediaDevices = navigator.mediaDevices,
		MediaRecorderClass = MediaRecorder,
		fsModule = fs,
		pathModule = path,
		sanitizeFilename = sanitize,
		now = Date.now,
		onChange = () => {},
	}) {
		this.listSources = listSources;
		this.getOutputDirectory = getOutputDirectory;
		this.mediaDevices = mediaDevices;
		this.MediaRecorderClass = MediaRecorderClass;
		this.fs = fsModule;
		this.path = pathModule;
		this.sanitizeFilename = sanitizeFilename;
		this.now = now;
		this.onChange = onChange;
		this.reset();
	}

	reset() {
		this.recorder = null;
		this.stream = null;
		this.fileStream = null;
		this.writeQueue = Promise.resolve();
		this.completion = null;
		this.resolveCompletion = null;
		this.rejectCompletion = null;
		this.finalizing = false;
		this.failure = null;
		this.recordingPath = null;
		this.mimeType = null;
		this.startedAt = null;
		this.pausedAt = null;
		this.pausedDuration = 0;
		this.state = "idle";
		this.includesAudio = false;
		this.audioWarning = null;
	}

	snapshot() {
		return {
			state: this.state,
			path: this.recordingPath,
			mimeType: this.mimeType,
			elapsedMs: this.elapsedMs(),
			includesAudio: this.includesAudio,
			audioWarning: this.audioWarning,
			error: this.failure?.message || null,
		};
	}

	emit() {
		this.onChange(this.snapshot());
	}

	elapsedMs() {
		if (!this.startedAt) return 0;
		const end = this.pausedAt || this.now();
		return Math.max(0, end - this.startedAt - this.pausedDuration);
	}

	async findSource(sourceId) {
		const sources = await this.listSources();
		return sources.find((source) => source.id === sourceId) || null;
	}

	videoConstraints(sourceId) {
		return {
			mandatory: {
				chromeMediaSource: "desktop",
				chromeMediaSourceId: sourceId,
				maxWidth: 4096,
				maxHeight: 2160,
				maxFrameRate: 30,
			},
		};
	}

	async captureStream(sourceId, includeAudio) {
		const video = this.videoConstraints(sourceId);
		if (!includeAudio) {
			const stream = await this.mediaDevices.getUserMedia({ audio: false, video });
			return { stream, audioWarning: null };
		}

		const audio = {
			mandatory: {
				chromeMediaSource: "desktop",
				chromeMediaSourceId: sourceId,
			},
		};
		try {
			const stream = await this.mediaDevices.getUserMedia({ audio, video });
			if (!stream.getAudioTracks().length) {
				stream.getTracks().forEach((track) => track.stop());
				throw new Error("System audio track was not created");
			}
			return { stream, audioWarning: null };
		} catch (error) {
			const stream = await this.mediaDevices.getUserMedia({ audio: false, video });
			return {
				stream,
				audioWarning: "System audio capture failed. The recording will contain video only. " + error.message,
			};
		}
	}

	async nextFilePath(sourceName) {
		const directory = await this.getOutputDirectory();
		await this.fs.promises.mkdir(directory, { recursive: true });
		const safeName = this.sanitizeFilename(String(sourceName || "recording")).trim().slice(0, 80) || "recording";
		const stamp = timestamp(new Date(this.now()));
		for (let attempt = 0; attempt < 100; attempt++) {
			const suffix = attempt ? "-" + attempt : "";
			const filePath = this.path.join(directory, safeName + "-" + stamp + suffix + ".webm");
			if (!this.fs.existsSync(filePath)) return filePath;
		}
		throw new Error("Unable to create a unique recording file path");
	}

	async start(source, { includeAudio = true } = {}) {
		if (this.state !== "idle" && this.state !== "completed" && this.state !== "error") {
			throw new Error("A recording is already active");
		}
		this.reset();
		this.state = "starting";
		this.emit();

		let capture;
		try {
			capture = await this.captureStream(source.id, includeAudio);
			this.stream = capture.stream;
			this.audioWarning = capture.audioWarning;
			this.includesAudio = capture.stream.getAudioTracks().length > 0;
			this.recordingPath = await this.nextFilePath(source.name);

			const mimeType = chooseMimeType(this.MediaRecorderClass);
			if (!mimeType) throw new Error("This Electron build does not support WebM recording");
			this.mimeType = mimeType;
			this.fileStream = this.fs.createWriteStream(this.recordingPath, { flags: "wx" });
			this.fileStream.on("error", (error) => this.fail(error));

			this.completion = new Promise((resolve, reject) => {
				this.resolveCompletion = resolve;
				this.rejectCompletion = reject;
			});
			this.completion.catch(() => {});
			this.recorder = new this.MediaRecorderClass(this.stream, {
				mimeType,
				videoBitsPerSecond: 8_000_000,
				audioBitsPerSecond: 128_000,
			});
			this.recorder.ondataavailable = (event) => this.queueChunk(event.data);
			this.recorder.onerror = (event) => this.fail(event.error || new Error("MediaRecorder failed"));
			this.recorder.onstop = () => {
				this.finalize().catch((error) => this.reject(error));
			};

			this.recorder.start(1000);
			this.startedAt = this.now();
			this.state = "recording";
			this.emit();
			return this.snapshot();
		} catch (error) {
			if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
			if (this.fileStream) this.fileStream.destroy();
			if (this.recordingPath && this.fs.existsSync(this.recordingPath)) {
				await this.fs.promises.unlink(this.recordingPath).catch(() => {});
			}
			this.failure = error;
			this.state = "error";
			this.emit();
			throw error;
		}
	}

	queueChunk(data) {
		if (!data || !data.size) return;
		this.writeQueue = this.writeQueue
			.then(async () => {
				const buffer = Buffer.from(await data.arrayBuffer());
				await new Promise((resolve, reject) => {
					this.fileStream.write(buffer, (error) => (error ? reject(error) : resolve()));
				});
			})
			.catch((error) => this.fail(error));
	}

	pause() {
		if (this.state !== "recording") return false;
		this.recorder.pause();
		this.pausedAt = this.now();
		this.state = "paused";
		this.emit();
		return true;
	}

	resume() {
		if (this.state !== "paused") return false;
		this.recorder.resume();
		this.pausedDuration += this.now() - this.pausedAt;
		this.pausedAt = null;
		this.state = "recording";
		this.emit();
		return true;
	}

	stop() {
		if (!this.recorder || !this.completion) return Promise.resolve(null);
		if (this.recorder.state !== "inactive") {
			this.state = "finalizing";
			this.emit();
			this.recorder.stop();
		}
		return this.completion;
	}

	fail(error) {
		if (!this.failure) this.failure = error instanceof Error ? error : new Error(String(error));
		if (this.recorder && this.recorder.state !== "inactive") {
			this.recorder.stop();
		} else if (!this.finalizing) {
			this.finalize().catch((finalizeError) => this.reject(finalizeError));
		}
	}

	async closeFileStream() {
		if (!this.fileStream) return;
		const fileStream = this.fileStream;
		this.fileStream = null;
		await new Promise((resolve, reject) => {
			fileStream.once("error", reject);
			fileStream.end(resolve);
		});
	}

	cleanupMedia() {
		if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
		this.stream = null;
		this.recorder = null;
	}

	async finalize() {
		if (this.finalizing) return this.completion;
		this.finalizing = true;
		const durationMs = this.elapsedMs();
		try {
			await this.writeQueue;
			await this.closeFileStream();
			this.cleanupMedia();
			if (this.failure) throw this.failure;
			const result = {
				...this.snapshot(),
				elapsedMs: durationMs,
				state: "completed",
			};
			this.state = "completed";
			this.emit();
			this.resolveCompletion?.(result);
			return result;
		} catch (error) {
			this.cleanupMedia();
			if (this.recordingPath && this.fs.existsSync(this.recordingPath)) {
				await this.fs.promises.unlink(this.recordingPath).catch(() => {});
			}
			this.failure = error;
			this.state = "error";
			this.emit();
			this.reject(error);
			throw error;
		} finally {
			this.finalizing = false;
		}
	}

	reject(error) {
		if (this.rejectCompletion) this.rejectCompletion(error);
	}
}

WindowRecorder.chooseMimeType = chooseMimeType;

module.exports = WindowRecorder;
