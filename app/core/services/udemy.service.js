"use strict";

const axios = require("axios");
const NodeCache = require("node-cache");
const M3U8Service = require("./m3u8.service");

class UdemyService {
	#timeout = 40000;
	#headerAuth = null;

	#urlBase;
	#urlLogin;
	#URL_COURSES = "/users/me/subscribed-courses";
	#URL_COURSES_ENROLL = "/users/me/subscription-course-enrollments";
	#ASSETS_FIELDS = "&fields[asset]=asset_type,title,filename,body,captions,media_sources,stream_urls,download_urls,external_url,media_license_token";

	#cache = new NodeCache({ stdTTL: 3600 }); // TTL padrão de 1 hora

	constructor(subDomain = "www", httpTimeout = 40000) {
		subDomain = (subDomain.trim().length === 0 ? "www" : subDomain.trim()).toLowerCase();

		this.#urlBase = `https://${subDomain}.udemy.com`;
		this.#timeout = httpTimeout;
		this.#headerAuth = null;
		this.#urlLogin = `${this.#urlBase}/join/login-popup`;
	}

	/**
	 * Creates and returns a new Error object with the specified name and message.
	 *
	 * @param {string} name - The name of the error.
	 * @param {string} [message=""] - The optional error message. Default is an empty string.
	 * @returns {Error} The newly created Error object.
	 */
	_error(name, message = "") {
		const error = new Error();
		error.name = name;
		error.message = message;
		return error;
	}

	async _prepareStreamSource(courseId, el, includeHlsQualities) {
		try {
			if (el._class === "lecture") {
				const assetType = el.asset?.asset_type?.toLowerCase();
				if (assetType === "video" || assetType === "videomashup") {
					const asset = el.asset;
					const videoUrls = asset.stream_urls?.Video;
					const streamUrls = videoUrls?.length ? videoUrls : asset.media_sources;
					asset.streams = await this._convertToStreams(streamUrls, Boolean(asset.media_license_token), includeHlsQualities);
					delete asset.stream_urls;
					delete asset.media_sources;
				} else if (assetType === "presentation") {
					const lecture = await this.fetchLecture(courseId, el.id, true, true);
					el.asset = lecture.asset;
					el.supplementary_assets = lecture.supplementary_assets;
				}
			}
		} catch (error) {
			throw this._error("EPREPARE_STREAM_SOURCE", error.message);
		}
	}

	async _prepareStreamsSource(courseId, items, includeHlsQualities) {
		// console.log("Preparing stream urls...", items);
		try {
			const promises = items.map((el) => this._prepareStreamSource(courseId, el, includeHlsQualities));
			await Promise.all(promises);
			// console.log("All streams prepared");
		} catch (error) {
			throw this._error("EPREPARE_STREAMS_SOURCE", error.message);
		}
	}

	async _convertToStreams(streamUrls, hasLicense, includeHlsQualities = true) {
		const sources = {};
		const entries = [];
		for (const entry of Array.isArray(streamUrls) ? streamUrls : []) {
			const src = entry?.file || entry?.src;
			if (typeof src !== "string" || !src.trim()) continue;
			const url = src.startsWith("//") ? "https:" + src : src;
			entries.push({ url, type: entry.type, label: entry.label });
		}
		const clearEntries = entries.filter((entry) => !M3U8Service.isProtectedUrl(entry.url));
		const compareQualities = includeHlsQualities || clearEntries.some((entry) => /^\d+p?$/i.test(entry.label));
		// A license token marks the asset as potentially protected. Udemy may still
		// expose a clear fallback stream, so only classify the asset as encrypted
		// when every available media source is protected.
		let isEncrypted = entries.length > 0 && clearEntries.length === 0;
		let protectedPlaylist = false;

		if (!isEncrypted) {
			for (const entry of clearEntries) {
				const url = entry.url;
				if (entry.type === "application/dash+xml") continue;

				const type = M3U8Service.isHls(entry.type, url) ? "application/x-mpegurl" : (entry.type || "");
				const quality = String(entry.label || "auto").toLowerCase().replace(/^(\d+)p$/, "$1");
				if (quality !== "auto" && !/^\d+$/.test(quality)) continue;
				const source = { type, url };
				sources[quality] = source;

				if (quality !== "auto" || type !== "application/x-mpegurl" || !compareQualities) continue;
				try {
					const variants = await new M3U8Service(url).loadPlaylist();
					for (const variant of variants) {
						if (!variant.quality) continue;
						sources[variant.quality] ??= { type, url: variant.url, externalAudio: variant.externalAudio, mediaPlaylist: true };
					}
				} catch (error) {
					if (error.code === "HLS_PROTECTED") {
						protectedPlaylist = true;
						delete sources[quality];
					}
					// Playlist probing only improves quality discovery. Leave the
					// master URL in the source list so the download stage can retry it.
				}
			}
			isEncrypted = protectedPlaylist && !Object.keys(sources).length;
		}

		const qualities = Object.keys(sources).filter((key) => key !== "auto").sort((a, b) => Number(a) - Number(b));
		const fallback = sources.auto ? "auto" : null;
		return {
			minQuality: qualities[0] ?? fallback,
			maxQuality: qualities[qualities.length - 1] ?? fallback,
			isEncrypted,
			sources,
		};
	}

	async #fetchUrl(url, method = "GET", httpTimeout = this.#timeout) {
		// Verifique o cache antes de fazer a requisição
		const cachedData = this.#cache.get(url);
		if (cachedData) {
			// console.log(`Cache hit: ${url}`);
			return cachedData;
		}

		console.log(`Fetching URL: ${url}`);
		try {
			const response = await axios({
				url,
				method,
				headers: this.#headerAuth,
				timeout: this.#timeout,
			});

			// Armazene o resultado no cache
			this.#cache.set(url, response.data);
			return response.data;
		} catch (e) {
			console.error(`Error fetching URL: ${url}`, e);
			throw e;
		}
	}

	async #fetchEndpoint(endpoint, method = "GET", httpTimeout = this.#timeout) {
		endpoint = `${this.#urlBase}/api-2.0${endpoint}`;
		return await this.#fetchUrl(endpoint, method, httpTimeout);
	}

	async fetchLoadMore(url, httpTimeout = this.#timeout) {
		// Verifique o cache antes de fazer a requisição
		const cachedData = this.#cache.get(url);
		if (cachedData) {
			// console.log(`Cache hit: ${url}`);
			return cachedData;
		}

		// console.log(`Fetching URL: ${url}`);
		try {
			const response = await axios({
				url,
				method: "GET",
				headers: this.#headerAuth,
				timeout: this.#timeout,
			});

			// Armazene o resultado no cache
			this.#cache.set(url, response.data);
			return response.data;
		} catch (e) {
			console.error(`Error fetching URL: ${url}`, e);
			throw e;
		}
	}

	async fetchProfile(accessToken, httpTimeout = this.#timeout) {
		this.#headerAuth = { Authorization: `Bearer ${accessToken}` };
		// return await this._fetchUrl("https://www.udemy.com/api-2.0/users/me");
		return await this.#fetchEndpoint("/contexts/me/?header=True");
	}

	async fetchSearchCourses(keyword, pageSize, isSubscriber, httpTimeout = this.#timeout) {
		if (!keyword) {
			return await this.fetchCourses(pageSize, isSubscriber, httpTimeout);
		}

		pageSize = Math.max(pageSize, 10);

		const param = `page=1&ordering=title&fields[user]=job_title&page_size=${pageSize}&search=${keyword}`;
		// const url = !isSubscriber ? `${this.#URL_COURSES}?${param}` : `${this.#URL_COURSES_ENROLL}?${param}`;
        const url = `${this.#URL_COURSES}?${param}`;
        const urlEnroll = `${this.#URL_COURSES_ENROLL}?${param}`;

        if (isSubscriber) {
            const [courses, enrolledCourses] = await Promise.all([
                this.#fetchEndpoint(url, "GET", httpTimeout),
                this.#fetchEndpoint(urlEnroll, "GET", httpTimeout)
            ]);

            const next = [courses.next, enrolledCourses.next].filter((n) => n !== null);
            const previous = [courses.previous, enrolledCourses.previous].filter((p) => p !== null);

            return {
                count: courses.count + enrolledCourses.count,
                next: next.length > 0 ? next : null,
                previous: previous.length > 0 ? previous : null,
                results: [...courses.results, ...enrolledCourses.results]
            }
        }

		return await this.#fetchEndpoint(url, "GET", httpTimeout);
	}

	async fetchCourses(pageSize = 30, isSubscriber = false, httpTimeout = this.#timeout) {
		pageSize = Math.max(pageSize, 10);

		const param = `page_size=${pageSize}&ordering=-last_accessed`;
		// const url = !isSubscriber ? `${this.#URL_COURSES}?${param}` : `${this.#URL_COURSES_ENROLL}?${param}`;
        const url = `${this.#URL_COURSES}?${param}`;
        const urlEnroll = `${this.#URL_COURSES_ENROLL}?${param}`;

        if (isSubscriber) {
            const [courses, enrolledCourses] = await Promise.all([
                this.#fetchEndpoint(url, "GET", httpTimeout),
                this.#fetchEndpoint(urlEnroll, "GET", httpTimeout)
            ]);

            const next = [courses.next, enrolledCourses.next].filter((n) => n !== null);
            const previous = [courses.previous, enrolledCourses.previous].filter((p) => p !== null);

            return {
                count: courses.count + enrolledCourses.count,
                next: next.length > 0 ? next : null,
                previous: previous.length > 0 ? previous : null,
                results: [...courses.results, ...enrolledCourses.results]
            }
        }

		return await this.#fetchEndpoint(url, "GET", httpTimeout);
	}

	async fetchCourse(courseId, httpTimeout = this.#timeout) {
		const url = `/courses/${courseId}/cached-subscriber-curriculum-items?page_size=10000&fields[lecture]=id,title,asset`;
		return await this.#fetchEndpoint(url, "GET", httpTimeout);
	}

	/**
	 * Fetches the lecture data for a given course and lecture ID.
	 *
	 * @param {number} courseId - The ID of the course.
	 * @param {number} lectureId - The ID of the lecture.
	 * @param {boolean} getAttachments - Whether to get supplementary assets. Defaults to false.
	 * @return {Promise<any>} - The lecture data.
	 */
	async fetchLecture(courseId, lectureId, getAttachments, allAssets = false, httpTimeout = this.#timeout) {
		let url = `/users/me/subscribed-courses/${courseId}/lectures/${lectureId}?fields[lecture]=id,title,asset${getAttachments ? ",supplementary_assets" : ""}`;
		url += allAssets ? "&fields[asset]=@all" : this.#ASSETS_FIELDS;

		const lectureData = await this.#fetchEndpoint(`${url}`, "GET", httpTimeout);
		// console.log("fetchLecture", lectureData);
		// await this._prepareStreamSource(lectureData);

		return lectureData;
	}

	async fetchLectureAttachments(lectureId, httpTimeout = this.#timeout) {
		const url = `/lectures/${lectureId}/supplementary-assets`;
		return await this.#fetchEndpoint(url);
	}

	/**
	 * Fetches the course content for a given course ID and content type.
	 *
	 * @param {number} courseId - The ID of the course.
	 * @param {'less' | 'all' | 'lectures' | 'attachments'} [contentType='all'] - The type of content to fetch.
	 * @return {Promise<any>} - The course content data.
	 */
	async fetchCourseContent(courseId, contentType, httpTimeout = this.#timeout, includeHlsQualities = true) {
		let url = `${this.#urlBase}/api-2.0/courses/${courseId}/cached-subscriber-curriculum-items?page_size=200`;

		contentType = (contentType || "less").toLowerCase();
		if (contentType !== "less") url += "&fields[lecture]=id,title";
		if (contentType === "all") url += ",asset,supplementary_assets";
		if (contentType === "lectures") url += ",asset";
		if (contentType === "attachments") url += ",supplementary_assets";
		if (contentType !== "less") url += this.#ASSETS_FIELDS;

		let contentData = null;
		let loadContent = false;

		try {
			// contentData = await this.#fetchEndpoint(url);
			do {
				const resp = await this.#fetchUrl(url);
				if (!contentData) {
					contentData = resp;
				} else {
					contentData.results.push(...resp.results);
				}

				if (resp.next) {
					url = decodeURI(resp.next);
					url = url.replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%2C/g, ",");
				}

				loadContent = resp.next != null;
			} while (loadContent);

			loadContent = false;
		} catch (error) {
			if (error?.response?.status === 503) {
				contentData = await this.fetchCourse(courseId, httpTimeout);
				loadContent = contentType !== "less";
			} else {
				throw error;
			}
		}

		if (!contentData || contentData.count == 0) {
			return null;
		}

		if (contentData.results[0]._class !== "chapter") {
			contentData.results.unshift({
				id: 0,
				_class: "chapter",
				title: "Chapter 1",
			});
			contentData.count++;
		}

		if (loadContent) {
			const promises = contentData.results.map(async (el) => {
				if (el._class === "lecture") {
					const lecture = await this.fetchLecture(courseId, el.id, true, false, httpTimeout);
					el.asset = lecture.asset;
					el.supplementary_assets = lecture.supplementary_assets;
				}
				return el;
			});
			await Promise.all(promises);
		}

		contentData.count = contentData.results.length;

		if (contentType !== "attachments") await this._prepareStreamsSource(courseId, contentData.results, includeHlsQualities);
		// console.log("fetchCourseContent", contentData);
		return contentData;
	}

	get urlBase() {
		return this.#urlBase;
	}
	get urlLogin() {
		return this.#urlLogin;
	}

	get timeout() {
		return this.#timeout;
	}
	set timeout(value) {
		this.#timeout = value;
	}
}

module.exports = UdemyService;
