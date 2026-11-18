"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const axios = require("axios");
const Download = require("mt-files-downloader/lib/Download");
const M3U8Service = require("./m3u8.service");
const requireDownloader = createRequire(require.resolve("zeltice-mt-downloader"));
const async = requireDownloader("async");
const NewDownload = requireDownloader("./lib/NewDownloadSetup");
const ResumeDownload = requireDownloader("./lib/ReDownloadSetup");
const ThreadsGenerator = requireDownloader("./lib/core/ThreadsGeneratorSyncTask");

const METADATA_SIZE = 10 * 1024;
const activePaths = new Set();
const RETRYABLE_NETWORK_CODES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
]);

function downloadError(message, status, retryable = false) {
	return Object.assign(new Error(message), { status, retryable });
}

function requestError(error, phase) {
	const status = error.response?.status;
	if (status) return downloadError(phase + " HTTP " + status, status, status === 408 || status >= 500);
	const timedOut = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
	const message = phase + (timedOut ? " timed out" : " connection failed");
	return downloadError(message, undefined, RETRYABLE_NETWORK_CODES.has(error.code));
}

function fileUrl(url, video) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw downloadError("Invalid file URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw downloadError("Invalid file URL protocol");
	if (video && M3U8Service.isProtectedUrl(parsed.href)) {
		throw Object.assign(downloadError("Encrypted video resource"), { code: "MEDIA_PROTECTED" });
	}
	return parsed;
}

function metadataExists(path) {
	try {
		const stat = fs.statSync(path);
		if (!stat.isFile()) throw new Error("Invalid download metadata file");
		if (stat.size >= METADATA_SIZE) return true;
		fs.unlinkSync(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return false;
}

function sourceIdentity(url) {
	const parsed = new URL(url);
	return parsed.origin + parsed.pathname;
}

function metadataWithSourceUrl(data, sourceUrl) {
	const meta = JSON.parse(Buffer.from(data).toString());
	meta.sourceUrl = sourceUrl;
	const serialized = JSON.stringify(meta);
	if (Buffer.byteLength(serialized) > METADATA_SIZE) {
		throw downloadError("Download metadata exceeds its storage limit");
	}
	const buffer = Buffer.alloc(METADATA_SIZE, 0x20);
	buffer.write(serialized);
	return buffer;
}

function validateDownloadMetadata(meta, expectedUrl) {
	if (!meta || !Number.isSafeInteger(meta.downloadSize) || meta.downloadSize <= 0) {
		return "Invalid download size";
	}
	if (!Array.isArray(meta.threads) || !meta.threads.length || meta.threads.length > 5) {
		return "Invalid download thread count";
	}
	try {
		if (sourceIdentity(meta.sourceUrl || meta.url) !== sourceIdentity(expectedUrl)) {
			return "Saved download metadata belongs to a different URL";
		}
	} catch {
		return "Invalid download metadata URL";
	}

	const threads = [...meta.threads].sort((left, right) => left?.start - right?.start);
	let nextStart = 0;
	for (const thread of threads) {
		const values = [thread?.start, thread?.position, thread?.end];
		if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
			return "Invalid download thread ranges";
		}
		const effectiveEnd = Math.min(thread.end, meta.downloadSize - 1);
		if (thread.start !== nextStart || thread.end < thread.start || effectiveEnd < thread.start) {
			return "Download thread ranges do not cover the file";
		}
		if (thread.position < thread.start || thread.position > effectiveEnd + 1) {
			return "Download progress is outside its thread range";
		}
		nextStart = effectiveEnd + 1;
	}
	if (nextStart !== meta.downloadSize) {
		return "Download thread ranges do not cover the file";
	}
	return null;
}

function downloadAttempt(job, signal) {
	const tempPath = job.filePath + ".mtd";
	const resume = metadataExists(tempPath);
	let fd;
	let failure;
	let canResume = false;
	let discardPartial = false;
	let fileMeta;
	let completed = false;
	const options = {
		...job.options,
		file: resume ? tempPath : job.filePath,
		url: job.url,
		onStart(meta) {
			if (signal.aborted) return;
			job.setMeta(meta);
			job.setStatus(1);
			job._computeStartTime();
			job._computePastDownloaded();
			job._computeTotalSize();
			job.emit("start", job);
		},
	};
	const config = { adapter: "http", timeout: options.timeout * 1000, maxRedirects: 5, proxy: false, signal, decompress: false };
	const identity = { "Accept-Encoding": "identity" };
	const supportsRanges = (headers) => /(?:^|,\s*)bytes(?:,|$)/i.test(headers?.["accept-ranges"] || "");

	return new Promise((resolve, reject) => {
		// Keep the stock range partition, metadata format, and progress calculation.
		const setup = resume ? new ResumeDownload(options) : new NewDownload(options);
		setup.execute((tasks) => {
			if (!resume) {
				// A failed HEAD must never create or open an empty .mtd.
				tasks["http-head"] = (done) => {
					let initialUrl;
					try {
						initialUrl = fileUrl(job.url, job.isVideo);
					} catch (error) {
						return done(error);
					}
					axios.head(initialUrl.href, { ...config, headers: identity }).then((response) => {
						const fileSize = Number(response.headers["content-length"]);
						if (!Number.isSafeInteger(fileSize) || fileSize < 0 || !response.headers["content-length"]) {
							throw downloadError("Missing or invalid download Content-Length");
						}
						const url = fileUrl(response.request?.res?.responseUrl || initialUrl.href, job.isVideo);
						const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
						const headers = response.headers.toJSON();
						canResume = supportsRanges(headers);
						discardPartial = !canResume;
						if (!canResume || fileSize < options.count * 2) options.count = 1;
						return { fileSize, url_object: url, port, headers };
					}).then((meta) => done(null, meta), (error) => done(error.retryable === undefined ? requestError(error, "HEAD") : error));
				};
				tasks["threads-generate"] = ["http-head", (done, results) => {
					new ThreadsGenerator(results["http-head"].fileSize, options).execute(done);
				}];
				tasks["meta-write"] = ["meta-generate", "file-handle", (done, results) => {
					const { data, position } = results["meta-generate"];
					let metadata;
					try {
						metadata = metadataWithSourceUrl(data, job.url);
					} catch (error) {
						return done(error);
					}
					fs.write(fd, metadata, 0, metadata.length, position, (error, bytes) => {
						done(error || (bytes === metadata.length ? null : downloadError("Incomplete download metadata write")));
					});
				}];
			}
			const open = tasks["file-handle"].pop();
			tasks["file-handle"].push(...(resume ? [] : ["http-head"]), (done, results) => {
				if (signal.aborted) return done(downloadError("Download paused"));
				open((error, handle) => {
					if (!error) fd = handle;
					done(error, handle);
				}, results);
			});
			if (resume) {
				const read = tasks["meta-read"].pop();
				tasks["meta-read"].push((done, results) => {
					read((error, meta) => {
						if (error) {
							discardPartial = error.message.includes(".mtd file is corrupt");
							return done(discardPartial ? downloadError("Invalid download metadata", undefined, true) : error);
						}
						canResume = supportsRanges(meta?.headers);
						const metadataError = validateDownloadMetadata(meta, job.url);
						if (!canResume || metadataError) {
							discardPartial = true;
							return done(downloadError(metadataError || "Saved download cannot be resumed", undefined, true));
						}
						done(null, meta);
					}, results);
				});
			}

			const generate = tasks["executor-generator"].pop();
			tasks["executor-generator"].push((done, results) => {
				generate((error, executor) => {
					if (error) return done(error);
					const meta = results[resume ? "meta-update" : "meta-read"];
					// Metadata is rewritten as transfer progress changes. Keep the
					// original request URL in the in-memory object so every rewrite
					// preserves the ownership check used by future resumes.
					meta.sourceUrl = job.url;
					fileMeta = meta;
					// The stock writer does not wait for asynchronous writes before closing.
					executor.writer = (data, position) => {
						if (failure || signal.aborted) return;
						try {
							const bytes = fs.writeSync(fd, data, 0, data.length, position);
							if (bytes !== data.length) failure = downloadError("Incomplete local download write");
						} catch (writeError) {
							failure = writeError;
						}
					};
					const buildMetadata = executor.metaBuilder;
					executor.metaBuilder = (callback) => {
						buildMetadata((error, response) => {
							if (error) return callback(error);
							try {
								response.data = metadataWithSourceUrl(response.data, job.url);
								callback(null, response);
							} catch (metadataError) {
								callback(metadataError);
							}
						});
					};

					// Request cancellation and timeouts are handled by the HTTP client.
					executor.timer = () => {};
					for (const thread of executor.threads) {
						thread.bodyRequest = (notify) => {
							const end = Math.min(thread.end, meta.downloadSize - 1);
							const start = thread.position;
							if (signal.aborted || start > end || failure) return notify(null, { event: "end" });
							const headers = canResume ? { ...identity, Range: "bytes=" + start + "-" + end } : identity;
							axios.get(meta.url, { ...config, headers, responseType: "stream" }).then(({ data, status, headers, request }) => {
								try {
									fileUrl(request?.res?.responseUrl || meta.url, job.isVideo);
								} catch (error) {
									data.destroy();
									throw error;
								}
								if (canResume && (status !== 206 || headers["content-range"] !== "bytes " + start + "-" + end + "/" + meta.downloadSize)) {
									data.destroy();
									throw downloadError("Server did not return the requested file range");
								}
								let received = 0;
								data.setTimeout?.(config.timeout, () => data.destroy(Object.assign(new Error("Download stalled"), { code: "ETIMEDOUT" })));
								notify(null, { event: "response", destroy: () => data.destroy() });
								data.on("data", (chunk) => {
									received += chunk.length;
									if (!failure && !signal.aborted && received <= end - start + 1) {
										notify(null, { event: "data", data: chunk });
									}
								});
								data.once("error", (error) => {
									failure ??= requestError(error, "GET");
									notify(failure);
								});
								data.once("end", () => {
									if (received !== end - start + 1) {
										failure ??= downloadError("Incomplete HTTP body", undefined, true);
										notify(failure);
									} else {
										notify(null, { event: "end" });
									}
								});
							}, (error) => {
								error.response?.data?.destroy();
								throw requestError(error, "GET");
							}).catch((error) => {
								failure ??= error;
								notify(error);
							});
						};
					}
					done(null, executor);
				}, results);
			});
			tasks["validate-download"] = ["http-data", (done, results) => {
				const meta = results[resume ? "meta-update" : "meta-read"];
				if (signal.aborted) return done(downloadError("Download paused"));
				if (failure) return done(failure);
				const metadataError = validateDownloadMetadata(meta, job.url);
				if (metadataError) return done(downloadError(metadataError));
				const complete = meta.threads.every((thread) => thread.position > Math.min(thread.end, meta.downloadSize - 1));
				done(complete ? null : downloadError("Incomplete file download", undefined, true));
			}];
			tasks["file-rename"] = ["file-truncate", (done) => {
				fs.close(fd, (closeError) => {
					fd = undefined;
					if (closeError) return done(closeError);
					fs.rename(tempPath, job.filePath, (error) => {
						completed = !error;
						done(error);
					});
				});
			}];

			async.auto(tasks, (error) => {
				try {
					if (fd !== undefined) fs.closeSync(fd);
					const emptyTransfer = fileMeta && !fileMeta.threads.some((thread) => thread.position > thread.start);
					if (error && (discardPartial || emptyTransfer) && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
					else if (error) metadataExists(tempPath);
					if (error) return reject(error);
					if (!completed) return reject(downloadError("File download was not finalized"));
					resolve();
				} catch (cleanupError) {
					reject(cleanupError);
				}
			});
		});
	});
}

class FileDownload extends Download {
	constructor(url, targetPath, autoRetry, isVideo = false) {
		super();
		this.setUrl(url);
		this.setFilePath(targetPath);
		this.activePath = path.resolve(targetPath);
		// The pinned engine normally used its two-thread default because it read the HTTP headers as options.
		this.setOptions({ threadsCount: 2, timeout: 5000, range: "0-100" });
		this.maxRetries = autoRetry ? 3 : 0;
		this.isVideo = isVideo;
	}

	start() {
		if (this.running || this.timer) return;
		this.resumePending = false;
		this._reset();
		this.retries = 0;
		this.attempt();
	}

	async attempt() {
		if (activePaths.has(this.activePath)) {
			this.setStatus(-1);
			this.setError(downloadError("This file is already being downloaded"));
			this.emit("error", this);
			return;
		}

		activePaths.add(this.activePath);
		this.running = true;
		this.controller = new AbortController();
		let error;
		try {
			await downloadAttempt(this, this.controller.signal);
		} catch (failure) {
			error = failure;
		} finally {
			activePaths.delete(this.activePath);
			this.running = false;
		}

		if (this.status === -2 && error) {
			if (this.resumePending) this.resume();
			return;
		}
		if (error?.retryable && this.retries < this.maxRetries) {
			this.setStatus(2);
			this.retries++;
			this.emit("retry", this, error, this.retries);
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.attempt();
			}, 3000);
		} else if (error) {
			this.setStatus(-1);
			this.setError(error);
			this.emit("error", this);
		} else {
			this._computeEndTime();
			this.setStatus(3);
			this.emit("end", this);
		}
	}

	stop() {
		this.resumePending = false;
		this.setStatus(-2);
		clearTimeout(this.timer);
		this.timer = undefined;
		this.controller?.abort();
	}

	resume() {
		if (this.status !== -2) return;
		this.resumePending = this.running;
		if (!this.running) this.start();
	}
}

module.exports = FileDownload;
