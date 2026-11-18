"use strict";

const fs = require("fs");

const HLS_TYPES = new Set(["application/x-mpegurl", "application/vnd.apple.mpegurl", "audio/mpegurl", "audio/x-mpegurl"]);
const activeOutputs = new Set();

function hlsError(code, message, status) {
	return Object.assign(new Error(message), { code, status });
}

function playlistAttributes(line) {
	return Object.fromEntries(
		Array.from(line.matchAll(/(?:[:,])([A-Z0-9-]+)=("[^"]*"|[^,]*)/g), ([, name, value]) => [name, value.replace(/^"|"$/g, "")])
	);
}

class M3U8Service {
	constructor(url) {
		this.url = M3U8Service.resolveUrl(url);
	}

	static isHls(type, url) {
		return HLS_TYPES.has(String(type || "").split(";")[0].trim().toLowerCase()) || /\.m3u8(?:[?#]|$)/i.test(url || "");
	}

	static isProtectedUrl(url) {
		try {
			const pathname = new URL(url).pathname;
			return /(?:^|\/)encrypted-files(?:\/|$)/i.test(pathname);
		} catch {
			return false;
		}
	}

	static resolveUrl(uri, base) {
		let url;
		try {
			if (typeof uri !== "string" || !uri.trim()) throw new Error();
			url = new URL(uri, base);
		} catch {
			throw hlsError("HLS_URL", "Invalid HLS URL");
		}
		if (!["https:", "http:"].includes(url.protocol)) {
			throw hlsError("HLS_URL", "HLS requires an HTTP(S) URL");
		}
		return url.href;
	}

	static async request(url, stage, { binary = false, range, attempts = 3 } = {}) {
		const origin = new URL(url).origin;
		if (M3U8Service.isProtectedUrl(url)) {
			throw hlsError("HLS_PROTECTED", "Encrypted HLS resource");
		}

		for (let attempt = 1; attempt <= attempts; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 40000);
			let failure;
			try {
				const headers = range ? { Range: "bytes=" + range.start + "-" + range.end } : undefined;
				const response = await fetch(url, { headers, signal: controller.signal });
				const responseUrl = M3U8Service.resolveUrl(response.url || url);
				if (M3U8Service.isProtectedUrl(responseUrl)) {
					throw hlsError("HLS_PROTECTED", "Encrypted HLS resource");
				}
				if (!response.ok) {
					throw hlsError("HLS_HTTP", "HTTP " + response.status, response.status);
				}
				if (range) {
					const contentRange = response.headers.get("Content-Range");
					if (response.status !== 206 || !contentRange?.startsWith("bytes " + range.start + "-" + range.end + "/")) {
						throw hlsError("HLS_RANGE", "Server did not return the requested HLS byte range");
					}
				}
				const data = binary ? await response.arrayBuffer() : await response.text();
				if (binary && (!data.byteLength || (range && data.byteLength !== range.end - range.start + 1))) {
					throw hlsError("HLS_RANGE", "Incomplete HLS segment");
				}
				return { url: responseUrl, data };
			} catch (error) {
				// Avoid including credentials or signed URLs in the log.
				failure = error.code?.startsWith?.("HLS_") ? error : hlsError("HLS_NETWORK", controller.signal.aborted ? "Timed out" : "Network request failed");
				const retry = failure.code === "HLS_NETWORK" || failure.status === 408 || failure.status >= 500;
				if (!retry || attempt === attempts) {
					failure.message = stage + " (" + origin + ", attempt " + attempt + "): " + failure.message;
					throw failure;
				}
			} finally {
				clearTimeout(timer);
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}

	static parse(text, base) {
		const lines = text.trim().split(/\r?\n/).map((line) => line.trim());
		if (lines[0] !== "#EXTM3U") {
			throw hlsError("HLS_PLAYLIST", "Invalid HLS playlist");
		}
		if (lines.some((line) => /^#EXT-X-(?:SESSION-)?KEY:/.test(line) && playlistAttributes(line).METHOD !== "NONE")) {
			throw hlsError("HLS_PROTECTED", "HLS playlist declares encryption");
		}

		const variants = [];
		const segments = [];
		const externalAudioGroups = new Set();
		const embeddedAudioGroups = new Set();
		let stream;
		let segmentPending = false;
		let byteRange;
		let lastRange;
		const segment = (uri, bounds, initialization = false) => {
			const url = M3U8Service.resolveUrl(uri, base);
			let range;
			if (bounds) {
				const match = /^(\d+)(?:@(\d+))?$/.exec(bounds);
				const start = match?.[2] !== undefined ? Number(match[2]) : (!initialization && lastRange?.url === url ? lastRange.end + 1 : NaN);
				const length = Number(match?.[1]);
				if (!Number.isSafeInteger(start) || !Number.isSafeInteger(start + length) || length <= 0) {
					throw hlsError("HLS_RANGE", "Invalid HLS byte range");
				}
				range = { start, end: start + length - 1 };
			}
			if (!initialization) lastRange = range ? { url, end: range.end } : undefined;
			segments.push({ url, range, initialization });
		};

		for (const line of lines.slice(1)) {
			if (line.startsWith("#EXT-X-STREAM-INF:")) {
				stream = playlistAttributes(line);
			} else if (line.startsWith("#EXT-X-MEDIA:")) {
				const media = playlistAttributes(line);
				if (media.TYPE === "AUDIO") (media.URI ? externalAudioGroups : embeddedAudioGroups).add(media["GROUP-ID"]);
			} else if (line.startsWith("#EXT-X-MAP:")) {
				const map = playlistAttributes(line);
				segment(map.URI, map.BYTERANGE, true);
			} else if (line.startsWith("#EXT-X-BYTERANGE:")) {
				byteRange = line.slice("#EXT-X-BYTERANGE:".length);
			} else if (line.startsWith("#EXTINF:")) {
				segmentPending = true;
			} else if (line && !line.startsWith("#")) {
				if (stream) {
					const url = M3U8Service.resolveUrl(line, base);
					variants.push({
						url,
						quality: Number(stream.RESOLUTION?.split("x")[1]) || 0,
						bandwidth: Number(stream.BANDWIDTH) || 0,
						audioGroup: stream.AUDIO,
					});
					stream = undefined;
				} else if (segmentPending) {
					segment(line, byteRange);
					segmentPending = false;
					byteRange = undefined;
				}
			}
		}

		const clearVariants = variants.filter((variant) => !M3U8Service.isProtectedUrl(variant.url));
		if ((variants.length && !clearVariants.length) || segments.some(({ url }) => M3U8Service.isProtectedUrl(url))) {
			throw hlsError("HLS_PROTECTED", "HLS playlist refers to encrypted media");
		}
		return {
			variants: clearVariants.map(({ audioGroup, ...variant }) => ({
				...variant,
				externalAudio: externalAudioGroups.has(audioGroup) && !embeddedAudioGroups.has(audioGroup),
			})),
			segments,
		};
	}

	static async load(url, stage, attempts) {
		const response = await M3U8Service.request(url, stage, { attempts });
		try {
			return M3U8Service.parse(response.data, response.url);
		} catch (error) {
			error.message = stage + " (" + new URL(response.url).origin + "): " + error.message;
			throw error;
		}
	}

	async loadPlaylist(attempts) {
		return (await M3U8Service.load(this.url, "HLS master playlist", attempts)).variants;
	}

	async download(filePath, { attempts = 3, externalAudio = false, mediaPlaylist = false, onProgress = () => {}, onQuality = () => {} } = {}) {
		const tempPath = filePath + ".hls.part";
		if (activeOutputs.has(filePath)) throw hlsError("HLS_ACTIVE", "HLS output is already being downloaded");
		activeOutputs.add(filePath);
		let file;
		try {
			let url = this.url;
			let stage = mediaPlaylist ? "HLS media playlist" : "HLS playlist";
			const visited = new Set();
			while (!visited.has(url) && visited.size < 5) {
				if (externalAudio) {
					throw hlsError("HLS_AUDIO", "HLS variant requires a separate audio track");
				}
				visited.add(url);
				const { variants, segments } = await M3U8Service.load(url, stage, attempts);
				if (variants.length) {
					const best = variants.sort((a, b) => b.quality - a.quality || b.bandwidth - a.bandwidth)[0];
					if (best.quality) onQuality(best.quality);
					url = best.url;
					externalAudio = best.externalAudio;
					stage = "HLS media playlist";
					continue;
				}
				if (!segments.some(({ initialization }) => !initialization)) {
					throw hlsError("HLS_PLAYLIST", "HLS media playlist contains no segments");
				}

				file = await fs.promises.open(tempPath, "w");
				for (let i = 0; i < segments.length; i++) {
					const { url: segmentUrl, range, initialization } = segments[i];
					const start = Date.now();
					const { data } = await M3U8Service.request(segmentUrl, initialization ? "HLS initialization segment" : "HLS segment " + (i + 1), {
						binary: true, range, attempts,
					});
					await file.writeFile(Buffer.from(data));
					onProgress(i + 1, segments.length, data.byteLength, Math.max(Date.now() - start, 1));
				}
				await file.close();
				file = undefined;
				await fs.promises.rename(tempPath, filePath);
				return;
			}
			throw hlsError("HLS_PLAYLIST", "HLS playlist nesting limit reached");
		} catch (error) {
			if (file || fs.existsSync(tempPath)) {
				if (file) await file.close();
				await fs.promises.unlink(tempPath).catch((cleanupError) => {
					if (cleanupError.code !== "ENOENT") throw cleanupError;
				});
			}
			throw error;
		} finally {
			activeOutputs.delete(filePath);
		}
	}
}

module.exports = M3U8Service;
