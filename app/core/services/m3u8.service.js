"use strict";

const fs = require("fs");
const { execFile } = require("child_process");

const HLS_TYPES = new Set(["application/x-mpegurl", "application/vnd.apple.mpegurl", "audio/mpegurl", "audio/x-mpegurl"]);
const activeOutputs = new Set();
const FFMPEG_TIMEOUT = 5 * 60 * 1000;

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

	static selectAudioTrack(tracks, groupId) {
		const matching = tracks.filter((track) => track.groupId === groupId);
		return matching.find((track) => track.default) ?? matching.find((track) => track.autoselect) ?? matching[0];
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
		const audioTracks = [];
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
				if (media.TYPE === "AUDIO") {
					if (media.URI) {
						audioTracks.push({
							groupId: media["GROUP-ID"],
							url: M3U8Service.resolveUrl(media.URI, base),
							name: media.NAME,
							language: media.LANGUAGE,
							default: media.DEFAULT === "YES",
							autoselect: media.AUTOSELECT === "YES",
						});
					} else {
						embeddedAudioGroups.add(media["GROUP-ID"]);
					}
				}
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
			variants: clearVariants.map(({ audioGroup, ...variant }) => {
				const audioTrack =
					!embeddedAudioGroups.has(audioGroup) &&
					M3U8Service.selectAudioTrack(audioTracks, audioGroup);
				return {
					...variant,
					externalAudio: Boolean(audioTrack),
					audioPlaylist: audioTrack?.url,
					audioName: audioTrack?.name,
					audioLanguage: audioTrack?.language,
				};
			}),
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

	static async resolveMediaPlaylist(url, attempts, onQuality) {
		const visited = new Set();
		let audioPlaylist;
		let stage = "HLS playlist";
		while (!visited.has(url) && visited.size < 5) {
			visited.add(url);
			const { variants, segments } = await M3U8Service.load(url, stage, attempts);
			if (variants.length) {
				const best = variants.sort((a, b) => b.quality - a.quality || b.bandwidth - a.bandwidth)[0];
				if (best.quality) onQuality(best.quality);
				url = best.url;
				audioPlaylist ??= best.audioPlaylist;
				stage = "HLS media playlist";
				continue;
			}
			if (!segments.some(({ initialization }) => !initialization)) {
				throw hlsError("HLS_PLAYLIST", "HLS media playlist contains no segments");
			}
			return { segments, audioPlaylist };
		}
		throw hlsError("HLS_PLAYLIST", "HLS playlist nesting limit reached");
	}

	static async saveSegments(segments, targetPath, label, attempts, progress) {
		const file = await fs.promises.open(targetPath, "w");
		try {
			for (let index = 0; index < segments.length; index++) {
				const { url, range, initialization } = segments[index];
				const prefix = label === "media" ? "" : label + " ";
				const stage = initialization
					? "HLS " + prefix + "initialization segment"
					: "HLS " + prefix + "segment " + (index + 1);
				const started = Date.now();
				const { data } = await M3U8Service.request(url, stage, { binary: true, range, attempts });
				await file.writeFile(Buffer.from(data));
				progress(index + 1, segments.length, data.byteLength, Math.max(Date.now() - started, 1));
			}
		} finally {
			await file.close();
		}
	}

	static muxTracks(videoPath, audioPath, outputPath, ffmpegPath = "ffmpeg") {
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-y",
			"-i",
			videoPath,
			"-i",
			audioPath,
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-c",
			"copy",
			"-movflags",
			"+faststart",
			"-f",
			"mp4",
			outputPath,
		];
		return new Promise((resolve, reject) => {
			execFile(
				ffmpegPath,
				args,
				{ timeout: FFMPEG_TIMEOUT, windowsHide: true, maxBuffer: 1024 * 1024 },
				(error, _stdout, stderr) => {
					if (!error) return resolve();
					if (error.code === "ENOENT") {
						return reject(hlsError("HLS_AUDIO_NO_FFMPEG", "Separate HLS audio requires ffmpeg on PATH or FFMPEG_PATH"));
					}
					const detail = String(stderr || error.message)
						.trim()
						.split(/\r?\n/)
						.slice(-4)
						.join("\n");
					reject(hlsError("HLS_AUDIO_MUX", "Failed to merge HLS audio and video" + (detail ? "\n" + detail : "")));
				}
			);
		});
	}

	async download(
		filePath,
		{
			attempts = 3,
			externalAudio = false,
			audioPlaylist,
			mediaPlaylist = false,
			onProgress = () => {},
			onQuality = () => {},
			ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
		} = {}
	) {
		const tempPath = filePath + ".hls.part";
		const videoPath = filePath + ".video.part";
		const audioPath = filePath + ".audio.part";
		const temporaryPaths = [tempPath, videoPath, audioPath];
		if (activeOutputs.has(filePath)) throw hlsError("HLS_ACTIVE", "HLS output is already being downloaded");
		activeOutputs.add(filePath);
		try {
			const video = await M3U8Service.resolveMediaPlaylist(
				this.url,
				attempts,
				mediaPlaylist ? () => {} : onQuality
			);
			const resolvedAudioPlaylist = video.audioPlaylist || audioPlaylist;
			if (externalAudio && !resolvedAudioPlaylist) {
				throw hlsError("HLS_AUDIO_PLAYLIST", "Separate HLS audio playlist URL is missing");
			}

			const audio = resolvedAudioPlaylist
				? await M3U8Service.resolveMediaPlaylist(resolvedAudioPlaylist, attempts, () => {})
				: null;
			const totalSegments = video.segments.length + (audio?.segments.length || 0);
			let completedSegments = 0;
			await M3U8Service.saveSegments(
				video.segments,
				audio ? videoPath : tempPath,
				audio ? "video" : "media",
				attempts,
				(index, _total, bytes, milliseconds) => {
					completedSegments++;
					onProgress(completedSegments, totalSegments, bytes, milliseconds);
				}
			);
			if (audio) {
				await M3U8Service.saveSegments(
					audio.segments,
					audioPath,
					"audio",
					attempts,
					(index, _total, bytes, milliseconds) => {
						completedSegments++;
						onProgress(completedSegments, totalSegments, bytes, milliseconds);
					}
				);
				await M3U8Service.muxTracks(videoPath, audioPath, tempPath, ffmpegPath);
				for (const temporaryPath of [videoPath, audioPath]) {
					await fs.promises.unlink(temporaryPath).catch((cleanupError) => {
						if (cleanupError.code !== "ENOENT") throw cleanupError;
					});
				}
			}
			await fs.promises.rename(tempPath, filePath);
		} catch (error) {
			for (const temporaryPath of temporaryPaths) {
				await fs.promises.unlink(temporaryPath).catch((cleanupError) => {
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
