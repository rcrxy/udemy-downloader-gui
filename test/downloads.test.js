"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const axios = require("axios");
const sanitize = require("sanitize-filename");
const FileDownload = require("../app/core/services/file-download.service");
const M3U8Service = require("../app/core/services/m3u8.service");
const UdemyService = require("../app/core/services/udemy.service");

const fileBytes = Buffer.from(Array.from({ length: 64011 }, (_, index) => index % 251));

async function fixture(t, handler) {
	const root = fs.realpathSync(os.tmpdir());
	const dir = fs.mkdtempSync(path.join(root, "udeler-test-"));
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push({ url: req.url, method: req.method, range: req.headers.range });
		handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		assert.equal(path.dirname(fs.realpathSync(dir)), root);
		assert.match(path.basename(dir), /^udeler-test-/);
		fs.rmSync(dir, { recursive: true });
	});
	return { dir, requests, url: "http://127.0.0.1:" + server.address().port };
}

function serveFile(req, res, { bytes = fileBytes, ranges = true, partial = false, interruptAfter = 150 } = {}) {
	if (req.method === "HEAD") {
		if (ranges) res.setHeader("Accept-Ranges", "bytes");
		res.writeHead(200, { "Content-Length": bytes.length });
		res.end();
		return;
	}
	if (!req.headers.range) {
		res.writeHead(200, { "Content-Length": bytes.length });
		res.end(bytes);
		return;
	}
	const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range).map(Number);
	const chunk = bytes.subarray(start, end + 1);
	res.writeHead(206, { "Content-Range": "bytes " + start + "-" + end + "/" + bytes.length, "Content-Length": chunk.length });
	if (partial) {
		res.write(chunk.subarray(0, 4096));
		const timer = setTimeout(() => res.destroy(), interruptAfter);
		res.on("close", () => clearTimeout(timer));
	} else {
		res.end(chunk);
	}
}

function run(job) {
	return new Promise((resolve, reject) => {
		job.once("error", () => reject(job.error));
		job.once("end", resolve);
		job.start();
	});
}

function writeMetadata(file, meta) {
	const data = Buffer.alloc(10 * 1024, 0x20);
	data.write(JSON.stringify(meta));
	fs.writeFileSync(file, data);
}

test("HLS resolves relative variants, redirects, and segments without extension requirements", async (t) => {
	const f = await fixture(t, (req, res) => {
		switch (req.url) {
			case "/start.m3u8":
				res.writeHead(302, { Location: "/cdn/path/master.m3u8" }).end();
				break;
			case "/cdn/path/master.m3u8":
				res.end("#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1280x720\r\nvideo/avc1/4/media.m3u8\r\n");
				break;
			case "/cdn/path/video/avc1/4/media.m3u8":
				res.end("#EXTM3U\n#EXTINF:1,\n../../segments/001\n#EXTINF:1,\n/002.ts\n#EXT-X-ENDLIST");
				break;
			case "/cdn/path/video/segments/001":
				res.end("segment1");
				break;
			case "/002.ts":
				res.end("segment2");
				break;
			default:
				res.writeHead(404).end();
		}
	});
	const hls = new M3U8Service(f.url + "/start.m3u8");
	assert.equal((await hls.loadPlaylist())[0].url, f.url + "/cdn/path/video/avc1/4/media.m3u8");
	const output = path.join(f.dir, "video.mp4");
	await hls.download(output);
	assert.equal(fs.readFileSync(output, "utf8"), "segment1segment2");
	assert.equal(fs.existsSync(output + ".hls.part"), false);
});

test("HLS supports clear initialization segments and byte ranges", async (t) => {
	const f = await fixture(t, (req, res) => {
		if (req.url === "/media.m3u8") {
			res.end("#EXTM3U\n#EXT-X-MAP:URI=\"/init\"\n#EXTINF:1,\n#EXT-X-BYTERANGE:10@0\nmedia.m4s\n#EXTINF:1,\n#EXT-X-BYTERANGE:10\nmedia.m4s");
		} else if (req.url === "/init") {
			res.end("init");
		} else {
			serveFile(req, res);
		}
	});
	const output = path.join(f.dir, "video.mp4");
	await new M3U8Service(f.url + "/media.m3u8").download(output);
	assert.deepEqual(fs.readFileSync(output), Buffer.concat([Buffer.from("init"), fileBytes.subarray(0, 20)]));
	assert.deepEqual(f.requests.filter((req) => req.range).map((req) => req.range), ["bytes=0-9", "bytes=10-19"]);
});

test("HLS distinguishes playlist and segment errors, retries 503 once, and discards failed output", async (t) => {
	let temporaryFailures = 0;
	const f = await fixture(t, (req, res) => {
		if (req.url === "/media.m3u8") res.end("#EXTM3U\n#EXTINF:1,\n/temporary.ts\n#EXTINF:1,\n/missing.ts?signature=SECRET");
		else if (req.url === "/temporary.ts") {
			if (++temporaryFailures === 1) res.writeHead(503).end();
			else res.end("first segment");
		} else if (req.url === "/denied.m3u8") res.writeHead(403).end();
		else res.writeHead(404).end();
	});
	const output = path.join(f.dir, "video.mp4");
	await assert.rejects(new M3U8Service(f.url + "/media.m3u8").download(output), (error) => {
		assert.equal(error.status, 404);
		assert.match(error.message, /HLS segment 2/);
		assert.doesNotMatch(error.message, /SECRET/);
		return true;
	});
	await assert.rejects(new M3U8Service(f.url + "/denied.m3u8").download(output), /HLS playlist .*HTTP 403/);
	assert.equal(temporaryFailures, 2);
	assert.equal(f.requests.filter((req) => req.url.startsWith("/missing.ts")).length, 1);
	assert.equal(f.requests.filter((req) => req.url === "/denied.m3u8").length, 1);
	assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("HLS recognizes protection before attempting keys or media", async (t) => {
	const f = await fixture(t, (_req, res) => res.end(
		"#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"/key\"\n#EXTINF:1,\n/video.ts"
	));
	const output = path.join(f.dir, "video.mp4");
	await assert.rejects(new M3U8Service(f.url + "/protected.m3u8").download(output), { code: "HLS_PROTECTED" });
	assert.deepEqual(f.requests.map((req) => req.url), ["/protected.m3u8"]);
	assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("HLS quality preflight failure defers to the retrying download stage", async (t) => {
	let preflight = true;
	const f = await fixture(t, (req, res) => {
		if (req.url === "/unstable.m3u8" && preflight) {
			res.writeHead(404).end();
		} else if (req.url === "/unstable.m3u8") {
			res.end("#EXTM3U\n#EXTINF:1,\n/segment.ts");
		} else {
			res.end("recovered video");
		}
	});
	const source = (
		await new UdemyService()._convertToStreams(
			[{ label: "Auto", src: f.url + "/unstable.m3u8", type: "application/vnd.apple.mpegurl" }],
			false,
			true
		)
	).sources.auto;
	preflight = false;
	const output = path.join(f.dir, "recovered.mp4");
	await new M3U8Service(source.url).download(output);
	assert.equal(fs.readFileSync(output, "utf8"), "recovered video");
});

test("a license token falls back to clear sources instead of blocking the whole asset", async () => {
	const service = new UdemyService();
	const mixed = await service._convertToStreams([
		{ label: "Auto", src: "https://cdn.example/encrypted-files/master.m3u8", type: "application/vnd.apple.mpegurl" },
		{ label: "720p", file: "https://cdn.example/clear/720.mp4", type: "video/mp4" },
	], true, false);
	assert.equal(mixed.isEncrypted, false);
	assert.equal(mixed.maxQuality, "720");

	const protectedOnly = await service._convertToStreams([
		{ label: "Auto", src: "https://cdn.example/encrypted-files/master.m3u8", type: "application/vnd.apple.mpegurl" },
	], true, false);
	assert.equal(protectedOnly.isEncrypted, true);
});

test("HLS does not produce a silent file for a separate-audio variant", async (t) => {
	const f = await fixture(t, (_req, res) => res.end(
		'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",URI="audio.m3u8"\n' +
		'#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1280x720,AUDIO="a"\nvideo/media.m3u8'
	));
	const output = path.join(f.dir, "video.mp4");
	await assert.rejects(new M3U8Service(f.url + "/master.m3u8").download(output), { code: "HLS_AUDIO" });
	assert.deepEqual(f.requests.map((req) => req.url), ["/master.m3u8"]);
	assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("MP4 and non-range attachments are written with exactly the advertised bytes", async (t) => {
	const f = await fixture(t, (req, res) => serveFile(req, res, { ranges: req.url === "/lecture.mp4" }));
	for (const filename of ["lecture.mp4", "image.png"]) {
		const output = path.join(f.dir, filename);
		await run(new FileDownload(f.url + "/" + filename, output, false));
		assert.deepEqual(fs.readFileSync(output), fileBytes);
		assert.equal(fs.existsSync(output + ".mtd"), false);
	}
	assert.equal(f.requests.filter((req) => req.url === "/lecture.mp4" && req.range).length, 2);
	assert.equal(f.requests.filter((req) => req.url === "/image.png" && req.method === "GET").length, 1);
});

test("attachment retries a failed HEAD without leaving a zero-byte sidecar", async (t) => {
	let failed = false;
	const f = await fixture(t, (req, res) => {
		if (!failed && req.method === "HEAD") {
			failed = true;
			req.socket.destroy();
		} else {
			serveFile(req, res);
		}
	});
	const output = path.join(f.dir, "attachment.zip");
	fs.writeFileSync(output + ".mtd", "");
	const job = new FileDownload(f.url + "/attachment.zip", output, true);
	let retries = 0;
	job.on("retry", () => {
		retries++;
		assert.equal(fs.existsSync(output + ".mtd"), false);
	});
	await run(job);
	assert.equal(retries, 1);
	assert.deepEqual(fs.readFileSync(output), fileBytes);
	assert.equal(fs.existsSync(output + ".mtd"), false);
});

test("attachment retries a transient HEAD HTTP 503 before creating the sidecar", async (t) => {
	let failed = false;
	const f = await fixture(t, (req, res) => {
		if (!failed && req.method === "HEAD") {
			failed = true;
			res.writeHead(503).end();
		} else {
			serveFile(req, res);
		}
	});
	const output = path.join(f.dir, "attachment.zip");
	const job = new FileDownload(f.url + "/attachment.zip", output, true);
	let retries = 0;
	job.on("retry", () => {
		retries++;
		assert.equal(fs.existsSync(output + ".mtd"), false);
	});
	await run(job);
	assert.equal(retries, 1);
	assert.deepEqual(fs.readFileSync(output), fileBytes);
	assert.equal(fs.existsSync(output + ".mtd"), false);
});

test("a new job resumes an interrupted download using the existing .mtd", async (t) => {
	let interrupted = true;
	const f = await fixture(t, (req, res) => serveFile(req, res, { partial: interrupted }));
	const output = path.join(f.dir, "interrupted.zip");
	await assert.rejects(run(new FileDownload(f.url + "/interrupted.zip", output, false)), /GET connection failed/);
	assert.ok(fs.statSync(output + ".mtd").size > 10240);
	assert.equal(fs.existsSync(output), false);
	const metadata = JSON.parse(fs.readFileSync(output + ".mtd").subarray(-10 * 1024).toString());
	assert.equal(metadata.sourceUrl, f.url + "/interrupted.zip");
	interrupted = false;
	const before = f.requests.length;
	await run(new FileDownload(f.url + "/interrupted.zip?signature=rotated", output, false));
	const resumed = f.requests.slice(before);
	assert.ok(resumed.every((req) => req.method === "GET"));
	assert.ok(resumed.some((req) => !f.requests.slice(0, before).some((initial) => initial.range === req.range)));
	assert.deepEqual(fs.readFileSync(output), fileBytes);
	assert.equal(fs.existsSync(output + ".mtd"), false);
});

test("resume metadata from another URL is discarded before downloading the current file", async (t) => {
	const f = await fixture(t, (req, res) => serveFile(req, res));
	const output = path.join(f.dir, "attachment.zip");
	const currentUrl = f.url + "/attachment.zip";
	writeMetadata(output + ".mtd", {
		threads: [{ start: 0, position: 0, end: fileBytes.length - 1, connection: "idle" }],
		url: f.url + "/different.zip",
		method: "GET",
		port: f.url.split(":").pop(),
		downloadSize: fileBytes.length,
		headers: { "accept-ranges": "bytes" },
	});
	const job = new FileDownload(currentUrl, output, true);
	let retries = 0;
	job.on("retry", () => retries++);
	await run(job);
	assert.equal(retries, 1);
	assert.deepEqual(fs.readFileSync(output), fileBytes);
	assert.equal(fs.existsSync(output + ".mtd"), false);
});

test("overlapping resume metadata is discarded and the file is downloaded from scratch", async (t) => {
	const f = await fixture(t, (req, res) => serveFile(req, res));
	const output = path.join(f.dir, "attachment.zip");
	const currentUrl = f.url + "/attachment.zip";
	writeMetadata(output + ".mtd", {
		threads: [
			{ start: 0, position: 0, end: 40000, connection: "idle" },
			{ start: 30000, position: 30000, end: fileBytes.length - 1, connection: "idle" },
		],
		url: currentUrl,
		method: "GET",
		port: f.url.split(":").pop(),
		downloadSize: fileBytes.length,
		headers: { "accept-ranges": "bytes" },
	});
	const job = new FileDownload(currentUrl, output, true);
	let retries = 0;
	job.on("retry", () => retries++);
	await run(job);
	assert.equal(retries, 1);
	assert.deepEqual(fs.readFileSync(output), fileBytes);
	assert.equal(fs.existsSync(output + ".mtd"), false);
});

test("pause and immediate resume wait for the old download to finish closing", { timeout: 10000 }, async (t) => {
	let partial = true;
	const f = await fixture(t, (req, res) => serveFile(req, res, { partial, interruptAfter: 3000 }));
	const output = path.join(f.dir, "paused.zip");
	const job = new FileDownload(f.url + "/paused.zip", output, false);
	job.once("start", () => {
		const timer = setInterval(() => {
			if (!job.meta.threads.some((thread) => thread.position > thread.start)) return;
			clearInterval(timer);
			job.stop();
			partial = false;
			job.resume();
		}, 20);
		t.after(() => clearInterval(timer));
	});
	await run(job);
	assert.deepEqual(fs.readFileSync(output), fileBytes);
	assert.equal(f.requests.filter((req) => req.method === "HEAD").length, 1);
	assert.equal(fs.existsSync(output + ".mtd"), false);
});

test("a permanent attachment HTTP failure never produces a final file or retries", async (t) => {
	const f = await fixture(t, (req, res) => {
		if (req.method === "HEAD") serveFile(req, res);
		else res.writeHead(403).end("denied");
	});
	const output = path.join(f.dir, "attachment.zip");
	const job = new FileDownload(f.url + "/attachment.zip?signature=SECRET", output, true);
	let retries = 0;
	job.on("retry", () => retries++);
	await assert.rejects(run(job), /GET HTTP 403/);
	assert.equal(retries, 0);
	assert.equal(f.requests.filter((req) => req.method === "HEAD").length, 1);
	assert.equal(fs.existsSync(output), false);
	assert.equal(fs.existsSync(output + ".mtd"), false);
});

class Selection {
	constructor(selector = "") {
		this.selector = selector;
		this.length = 0;
		this.attributes = {};
		this.children = new Map();
		this[0] = {};
	}
	find(selector) {
		if (!this.children.has(selector)) this.children.set(selector, new Selection(selector));
		return this.children.get(selector);
	}
	attr(name, value) {
		if (value !== undefined) {
			this.attributes[name] = value;
			return this;
		}
		return this.attributes[name] || (name === "class" ? "ui grey" : "");
	}
	text() { return "Course"; }
	val() { return this; }
	hide() { return this; }
	show() { return this; }
	html() { return this; }
	parents() { return this; }
	clone() { return this; }
	push() {}
	click() { return this; }
	addClass() { return this; }
	removeClass() { return this; }
	progress() { return this; }
}

async function runCourse(f, settings) {
	const source = fs.readFileSync(path.join(__dirname, "../app/app.js"), "utf8");
	const utilsSource = fs.readFileSync(path.join(__dirname, "../app/helpers/utils.js"), "utf8");
	const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
	const logs = [];
	const statuses = [];
	const getContent = extract("async function fetchCourseContent(", "async function fetchCourses(");
	const download = extract("async function prepareDownloading(", "function askForSubtitle(");
	const course = new Selection();
	course.attr("course-id", "123").attr("course-url", "/course/");
	const context = {
		fs, path, URL, sanitize, FileDownload, M3U8Service, setInterval, clearInterval, module: {},
		$: (selector) => new Selection(selector),
		console: { clear() {} },
		Settings: {
			download: settings, subDomain: "www",
			DownloadType: { Both: 0, OnlyLectures: 1, OnlyAttachments: 2 },
			downloadDirectory: () => f.dir,
		},
		ui: { prepareDownloading() {}, showProgress() {}, busyOff() {} },
		udemyService: new UdemyService(),
		translate: (value) => value,
		askForSubtitle: (_subs, _total, _default, callback) => callback(""),
		sendNotification() {},
		appendLog: (stage, error) => logs.push(stage + " " + error),
		handleApiError: (error) => { throw error; },
		captureException: (error) => { throw error; },
	};
	const finished = new Promise((resolve) => {
		context.resetCourse = (_course, message) => {
			statuses.push(message.selector);
			resolve({ statuses, logs });
		};
	});
	vm.runInNewContext(utilsSource + getContent + download, context);
	await context.prepareDownloading(course);
	return finished;
}

function mockCurriculum(t, f) {
	const original = axios.defaults.adapter;
	const requests = [];
	axios.defaults.adapter = async (config) => {
		requests.push(config.url);
		assert.match(config.url, /courses\/123\/cached-subscriber-curriculum-items/);
		const results = [
			{ _class: "chapter", title: "Chapter", id: 1 },
			{
				_class: "lecture", title: "Broken HLS", id: 2,
				asset: { asset_type: "Video", media_sources: [{ label: "Auto", src: f.url + "/missing.m3u8", type: "application/vnd.apple.mpegurl" }] },
				supplementary_assets: [{ title: "Broken HLS attachment", asset_type: "File", download_urls: { File: [{ file: f.url + "/one.zip" }] } }],
			},
			{
				_class: "lecture", title: "Protected HLS", id: 3,
				asset: { asset_type: "Video", media_license_token: "fake", media_sources: [{ label: "Auto", src: f.url + "/encrypted-files/protected.m3u8" }] },
				supplementary_assets: [{ title: "Protected HLS attachment", asset_type: "File", download_urls: { File: [{ file: f.url + "/two.zip" }] } }],
			},
			{
				_class: "lecture", title: "Clear HLS", id: 4,
				asset: { asset_type: "Video", stream_urls: { Video: [] }, media_sources: [{ label: "Auto", src: f.url + "/clear.m3u8", type: "application/x-mpegurl" }] },
			},
			{
				_class: "lecture", title: "Clear MP4", id: 5,
				asset: { asset_type: "Video", stream_urls: { Video: [{ label: "720p", file: f.url + "/clear.mp4", type: "video/mp4" }] } },
			},
		];
		if (!config.url.includes("id,title,asset")) {
			for (const item of results) delete item.asset;
		}
		return { data: { count: results.length, results, next: null }, status: 200, headers: {}, config };
	};
	t.after(() => { axios.defaults.adapter = original; });
	return requests;
}

test("mixed course continues after failure, skips DRM, and saves attachments and later videos", async (t) => {
	const f = await fixture(t, (req, res) => {
		if (req.url === "/missing.m3u8") res.writeHead(404).end();
		else if (req.url === "/clear.m3u8") res.end("#EXTM3U\n#EXTINF:1,\n/segment.ts");
		else if (req.url === "/segment.ts") res.end("clear video");
		else serveFile(req, res);
	});
	mockCurriculum(t, f);
	const settings = { type: 0, videoQuality: "Auto", continueDonwloadingEncrypted: true, autoRetry: true };
	const result = await runCourse(f, settings);
	const dir = path.join(f.dir, "Course", "1. Chapter");
	assert.deepEqual(result.statuses, [".download-error"]);
	assert.match(result.logs.join("\n"), /HLS playlist .*HTTP 404/);
	assert.match(result.logs.join("\n"), /Video with DRM Protection/);
	assert.deepEqual(fs.readdirSync(dir), [
		"1.1 Broken HLS attachment.zip", "2.1 Protected HLS attachment.zip", "3. Clear HLS.mp4", "4. Clear MP4.mp4",
	]);
	assert.equal(fs.readFileSync(path.join(dir, "3. Clear HLS.mp4"), "utf8"), "clear video");
	assert.deepEqual(fs.readFileSync(path.join(dir, "4. Clear MP4.mp4")), fileBytes);
	assert.ok(f.requests.every((req) => !req.url.includes("protected.m3u8")));
});

test("DRM switch off blocks a known protected course, while attachment-only mode proceeds", async (t) => {
	const f = await fixture(t, (req, res) => serveFile(req, res));
	const apiCalls = mockCurriculum(t, f);
	const settings = { type: 0, videoQuality: "Auto", continueDonwloadingEncrypted: false };
	assert.deepEqual((await runCourse(f, settings)).statuses, [".course-encrypted"]);
	assert.deepEqual(f.requests, []);
	assert.deepEqual((await runCourse(f, { ...settings, type: 2 })).statuses, [".download-success"]);
	assert.match(apiCalls[1], /id,title,supplementary_assets/);
	assert.ok(f.requests.every((req) => req.url.endsWith(".zip")));
});
