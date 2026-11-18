/**
 * @typedef {Enumerator} DownloadTypeSetting
 * @property {number} Both
 * @property {number} OnlyLectures
 * @property {number} OnlyAttachments
 */

/**
 * @typedef {Object} DownloadSetting
 * @property {boolean} checkNewVersion
 * @property {string} defaultSubtitle
 * @property {string} path
 * @property {boolean} autoStartDownload
 * @property {boolean} continueDonwloadingEncrypted
 * @property {boolean} enableDownloadStartEnd
 * @property {number} downloadStart
 * @property {boolean} downloadEnd
 * @property {string} videoQuality
 * @property {DownloadTypeSetting} type
 * @property {boolean} skipSubtitles
 * @property {boolean} seqZeroLeft
 * @property {boolean} autoRetry
 */

/**
 * @typedef {Object} DownloadHistory
 * @property {number} id
 * @property {boolean} completed
 * @property {string} date
 * @property {number} encryptedVideos
 * @property {string} selectedSubtitle
 * @property {string} pathDownloaded
 */

/**
 * @typedef {Object} DownloadedCourses
 * @property {number} id
 * @property {string} url
 * @property {string} title
 * @property {string} image
 * @property {number} individualProgress
 * @property {number} combinedProgress
 * @property {boolean} completed
 * @property {string} progressStatus
 * @property {number} encryptedVideos
 * @property {string} selectedSubtitle
 * @property {string} pathDownloaded
 */

const Settings = (() => {
	"use strict";

	const settings = require("electron-settings");
	const { app } = require("@electron/remote");
	const path = require("path");
	const { homedir } = require("os");

	/** @type {DownloadTypeSetting} */
	const DownloadType = Object.freeze({
		Both: 0,
		OnlyLectures: 1,
		OnlyAttachments: 2,
	});

	/** @type {DownloadSetting} */
	const DownloadDefaultOptions = Object.freeze({
		checkNewVersion: true,
		defaultSubtitle: undefined,
		path: path.join(homedir(), "Downloads", "Udeler"),
		autoStartDownload: false,
		continueDonwloadingEncrypted: false,
		enableDownloadStartEnd: false,
		downloadStart: 0,
		downloadEnd: 0,
		type: DownloadType.Both,
		skipSubtitles: false,
		autoRetry: false,
		videoQuality: "Auto",
		seqZeroLeft: false,
	});

	let _language = null;
	settings.configure({
		dir: app.getPath("userData"),
		// Keep the filename used by electron-settings 3.
		fileName: "Settings",
		prettify: /^(1|true)$/i.test(process.env.PRETTIFY_SETTINGS || ""),
	});

	function getSetting(keyPath, defaultValue) {
		const value = settings.getSync(keyPath);
		return value === undefined ? defaultValue : value;
	}

	/**
	 * Ensures all default keys are set in the settings
	 * @internal
	 * @returns {void}
	 */
	function ensureDefaultKeys() {
		if (!getSetting("language")) settings.setSync("language", getLanguage());
		if (!getSetting("download")) settings.setSync("download", DownloadDefaultOptions);
	}

	/**
	 * Get navigator default language and set in settings "language"
	 *
	 * @returns defined language
	 */
	function getLanguage() {
		try {
			let language = getSetting("language");

			if (!language) {
				const navigatorLang = navigator.language.substring(0, 2);
				const meta = require("../locale/meta.json");

				language = Object.keys(meta).find((key) => meta[key] === (navigatorLang === "pt" ? "pt_BR.json" : `${navigatorLang}.json`));
			}

			return language || "English";
		} catch (error) {
			console.error("Error_Settings getLanguage(): " + error);
			return "English";
		}
	}

	/**
	 * Get the download directory for a given course
	 * @param {string} courseName - The name of the course
	 * @returns {string} - The download directory path
	 */
	function downloadDirectory(courseName = "") {
		const download_dir = getSetting("download.path") || DownloadDefaultOptions.path;
		return path.join(download_dir, courseName);
	}

	// Initialize settings
	(function init() {
		console.log("Initialize settings");
		ensureDefaultKeys();
	})();

	return {
		DownloadType,
		DownloadDefaultOptions,
		/** @param {String, Object} */
		get: getSetting,
		/** @param {String, Object} */
		set: (keyPath, value) => settings.setSync(keyPath, value),
		/** @type {string} */
		get language() {
			if (!_language) {
				_language = getLanguage();
			}
			return _language;
		},
		/** @type {string} */
		set language(value) {
			this.set("language", value || null);
			_language = value;
		},
		/** @type {string} */
		get subDomain() {
			return this.get("subdomain", "www");
		},
		/** @type {string} */
		set subDomain(value) {
			this.set("subdomain", value);
		},
		/** @type {string} */
		get accessToken() {
			return this.get("access_token");
		},
		/** @type {string} */
		set accessToken(value) {
			this.set("access_token", value || null);
		},
		/** @type {boolean} */
		get subscriber() {
			return Boolean(this.get("subscriber"));
		},
		/** @type {boolean} */
		set subscriber(value) {
			this.set("subscriber", value);
		},
		/** @type {DownloadSetting} */
		get download() {
			return { ...DownloadDefaultOptions, ...this.get("download") };
		},
		/** @type {DownloadSetting} */
		set download(value) {
			this.set("download", { ...this.get("download"), ...value });
		},
		/** @type {Array<DownloadHistory>} */
		get downloadHistory() {
			return this.get("downloadedHistory", []);
		},
		/** @type {Array<DownloadHistory>} */
		set downloadHistory(value) {
			this.set("downloadedHistory", value);
		},
		/** @type {Array<DownloadedCourses>} */
		get downloadedCourses() {
			return this.get("downloadedCourses");
		},
		/** @type {Array<DownloadedCourses>} */
		set downloadedCourses(value) {
			this.set("downloadedCourses", value);
		},
		/** @param {String} */
		downloadDirectory: (courseName) => downloadDirectory(courseName),
	};
})();

module.exports = Settings;
