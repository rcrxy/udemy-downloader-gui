"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WindowRecorder = require("../app/core/services/window-recorder.service");

function fakeStream(includeAudio = true) {
	const stopped = [];
	const makeTrack = (kind) => ({ kind, stop: () => stopped.push(kind) });
	const audioTracks = includeAudio ? [makeTrack("audio")] : [];
	const videoTracks = [makeTrack("video")];
	return {
		stopped,
		getAudioTracks: () => audioTracks,
		getVideoTracks: () => videoTracks,
		getTracks: () => [...audioTracks, ...videoTracks],
	};
}

class FakeMediaRecorder extends EventEmitter {
	static isTypeSupported(type) {
		return type === "video/webm;codecs=vp9,opus" || type === "video/webm;codecs=vp8,opus";
	}

	constructor(_stream, options) {
		super();
		this.options = options;
		this.state = "inactive";
		this.timer = null;
		this.sequence = 0;
	}

	emitData() {
		this.sequence++;
		this.ondataavailable({ data: new Blob(["chunk-" + this.sequence]) });
	}

	start() {
		this.state = "recording";
		this.timer = setInterval(() => this.emitData(), 10);
	}

	pause() {
		this.state = "paused";
		clearInterval(this.timer);
	}

	resume() {
		this.state = "recording";
		this.timer = setInterval(() => this.emitData(), 10);
	}

	stop() {
		if (this.state === "inactive") return;
		clearInterval(this.timer);
		this.emitData();
		this.state = "inactive";
		queueMicrotask(() => this.onstop());
	}
}

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "udeler-recorder-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

async function listSources() {
	return [{
		id: "window:1",
		name: "Lesson Browser",
		thumbnail: "data:image/png;base64,thumb",
		icon: "data:image/png;base64,icon",
	}];
}

test("window recorder lists capturable sources", async (t) => {
	fixture(t);
	const recorder = new WindowRecorder({
		listSources,
		getOutputDirectory: () => os.tmpdir(),
		mediaDevices: {},
		MediaRecorderClass: FakeMediaRecorder,
	});
	assert.deepEqual(await recorder.listSources(), [
		{
			id: "window:1",
			name: "Lesson Browser",
			thumbnail: "data:image/png;base64,thumb",
			icon: "data:image/png;base64,icon",
		},
	]);
	assert.equal((await recorder.findSource("window:1")).name, "Lesson Browser");
	assert.equal(await recorder.findSource("window:missing"), null);
});

test("window recorder streams chunks to disk and completes", async (t) => {
	const directory = fixture(t);
	const stream = fakeStream(true);
	const changes = [];
	const recorder = new WindowRecorder({
		listSources,
		getOutputDirectory: () => directory,
		mediaDevices: { getUserMedia: async () => stream },
		MediaRecorderClass: FakeMediaRecorder,
		onChange: (snapshot) => changes.push(snapshot),
	});
	const started = await recorder.start({ id: "window:1", name: "Lesson Browser" }, { includeAudio: true });
	assert.equal(started.state, "recording");
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal(recorder.pause(), true);
	assert.equal(recorder.resume(), true);
	await new Promise((resolve) => setTimeout(resolve, 25));
	const result = await recorder.stop();
	assert.equal(result.state, "completed");
	assert.equal(result.includesAudio, true);
	assert.ok(fs.existsSync(result.path));
	assert.match(fs.readFileSync(result.path, "utf8"), /chunk-/);
	assert.deepEqual(stream.stopped.sort(), ["audio", "video"]);
	assert.equal(changes.at(-1).state, "completed");
});

test("window recorder falls back to video when system audio is unavailable", async (t) => {
	const directory = fixture(t);
	const videoOnly = fakeStream(false);
	let requests = 0;
	const recorder = new WindowRecorder({
		listSources,
		getOutputDirectory: () => directory,
		mediaDevices: {
			getUserMedia: async () => {
				requests++;
				if (requests === 1) throw new Error("Audio capture unavailable");
				return videoOnly;
			},
		},
		MediaRecorderClass: FakeMediaRecorder,
	});
	const started = await recorder.start({ id: "window:1", name: "Lesson Browser" }, { includeAudio: true });
	assert.equal(started.includesAudio, false);
	assert.match(started.audioWarning, /video only/);
	await recorder.stop();
	assert.equal(requests, 2);
});

test("window recorder stops the first stream when audio was requested but missing", async () => {
	const emptyAudio = fakeStream(false);
	const videoOnly = fakeStream(false);
	let requests = 0;
	const recorder = new WindowRecorder({
		listSources,
		getOutputDirectory: () => os.tmpdir(),
		mediaDevices: { getUserMedia: async () => ++requests === 1 ? emptyAudio : videoOnly },
		MediaRecorderClass: FakeMediaRecorder,
	});
	const capture = await recorder.captureStream("window:1", true);
	assert.equal(capture.stream, videoOnly);
	assert.match(capture.audioWarning, /audio track was not created/);
	assert.deepEqual(emptyAudio.stopped, ["video"]);
	videoOnly.getTracks().forEach((track) => track.stop());
});
