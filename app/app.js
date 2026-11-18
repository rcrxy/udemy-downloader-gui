"use strict";

const { shell, remote, ipcRenderer } = require("electron");
const { dialog, BrowserWindow, desktopCapturer } = remote;
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream");

const dialogs = require("dialogs")({});

const sanitize = require("sanitize-filename");
const vtt2srt = require("node-vtt-to-srt");
const FileDownload = require("./core/services/file-download.service");
const WindowRecorder = require("./core/services/window-recorder.service");
const https = require("https");
const cookie = require("cookie");

const { Settings, ui, utils } = require("./helpers");
const { default: UdemyService, M3U8Service } = require("./core/services");

const PAGE_SIZE = 25;
const MSG_DRM_PROTECTED = translate("Contains DRM protection and cannot be downloaded");
const HTTP_TIMEOUT = 40000; // 40 segundos

const loggers = [];
let repoAccount = "heliomarpm";
let udemyService;
let selectedRecordingSource = null;
let recordingClock = null;
const windowRecorder = new WindowRecorder({
	desktopCapturer,
	getOutputDirectory: () => Settings.downloadDirectory("Recordings"),
	onChange: renderRecorderState,
});

ipcRenderer.on("saveDownloads", () => saveDownloads(true));

// external browser
// $(document).on('click', 'a[href^="http"]', (event) => {
$(document).on("click", ".how-get-token", (event) => {
	event.preventDefault();
	shell.openExternal(event.target.href);
});

$(document).ajaxError(function (_event, _request) {
	$(".dimmer").removeClass("active");
});

$(".ui.dropdown").dropdown();

$(".ui.login #business").on("change", function () {
	if ($(this).is(":checked")) {
		ui.$subdomainField.val(Settings.subDomain);
		ui.toggleSubdomainField(true);
	} else {
		ui.$subdomainField.val(null);
		ui.toggleSubdomainField(false);
	}
});

$(".courses-sidebar").on("click", function () {
	ui.navSidebar(this, "courses");
});

$(".downloads-sidebar").on("click", async function () {
	ui.navSidebar(this, "downloads");
	renderDownloads();
});

$(".recorder-sidebar").on("click", async function () {
	ui.navSidebar(this, "recorder");
	await loadRecordingSources();
});

$(".settings-sidebar").on("click", function () {
	ui.navSidebar(this, "settings");
	loadSettings();
});

$(".about-sidebar").on("click", function () {
	ui.navSidebar(this, "about");
});

$(".logger-sidebar").on("click", function () {
	ui.navSidebar(this, "logger");
	clearBagdeLoggers();
});

$(".logout-sidebar").on("click", function () {
	dialogs.confirm(translate("Confirm Log Out?"), function (ok) {
		if (ok) {
			ui.busyLogout(true);
			saveDownloads(false);
			Settings.accessToken = null;
			ui.resetToLogin();
		}
	});
});

$(".ui.dashboard .content").on("click", ".load-more.button", (e) => loadMore(e.currentTarget));

$(".ui.dashboard .content").on("click", ".dismiss-download", function () {
	const courseId = $(this).parents(".course.item").attr("course-id");
	removeCurseDownloads(courseId);
});

$(".ui.dashboard .content").on("click", ".open-in-browser", function () {
	const link = `https://${Settings.subDomain}.udemy.com${$(this).parents(".course.item").attr("course-url")}`;
	shell.openExternal(link);
});

$(".ui.dashboard .content").on("click", ".open-dir", function () {
	const pathDownloaded = $(this).parents(".course.item").find('input[name="path-downloaded"]').val();
	shell.openPath(pathDownloaded);
});

$(".ui.dashboard .content").on("click", ".check-updates", () => checkUpdate("heliomarpm"));

$(".ui.dashboard .content").on("click", ".check-updates-original", () => checkUpdate("FaisalUmair"));

$(".ui.dashboard .content").on("click", ".old-version-mac", () => {
	shell.openExternal("https://github.com/FaisalUmair/udemy-downloader-gui/releases/download/v1.8.2/Udeler-1.8.2-mac.dmg");
});

$(".ui.dashboard .content").on("click", ".old-version-linux", () => {
	shell.openExternal("https://github.com/FaisalUmair/udemy-downloader-gui/releases/download/v1.8.2/Udeler-1.8.2-linux-x86_x64.AppImage");
});

$(".ui.dashboard .content").on("click", ".download-success, .course-encrypted", function () {
	$(this).hide();
	$(this).parents(".course").find(".download-status").show();
});

$(".ui.dashboard .content").on("click", ".save_m3u.button", function (e) {
	e.stopImmediatePropagation();
	saveM3u($(this).parents(".course"));
});
$(".ui.dashboard .content").on("click", ".download.button, .download-error", function (e) {
	e.stopImmediatePropagation();
	prepareDownloading($(this).parents(".course"));
});

$(".ui.dashboard .content").on("click", "#clear_logger", clearLogArea);

$(".ui.dashboard .content").on("click", "#save_logger", saveLogFile);

$(".ui.dashboard .content").on("click", ".refresh-recording-sources", loadRecordingSources);

$(".ui.dashboard .content").on("click", ".start-recording", async () => {
	if (!selectedRecordingSource) {
		showAlert(translate("Select a window to record"));
		return;
	}
	const $video = $(".recording-preview");
	try {
		$(".start-recording").addClass("loading disabled");
		await windowRecorder.start(selectedRecordingSource, {
			includeAudio: $('input[name="recording-system-audio"]').is(":checked"),
		});
		$video[0].srcObject = windowRecorder.stream;
	} catch (error) {
		appendLog("startRecording_Error", error);
		showAlert(error.message, translate("Unable to start recording"));
		renderRecorderState(windowRecorder.snapshot());
	} finally {
		$(".start-recording").removeClass("loading");
	}
});

$(".ui.dashboard .content").on("click", ".pause-recording", () => {
	if (windowRecorder.state === "paused") windowRecorder.resume();
	else windowRecorder.pause();
});

$(".ui.dashboard .content").on("click", ".stop-recording", async () => {
	$(".pause-recording, .stop-recording").addClass("loading disabled");
	try {
		await windowRecorder.stop();
	} catch (error) {
		appendLog("stopRecording_Error", error);
		showAlert(error.message, translate("Recording failed"));
	} finally {
		$(".pause-recording, .stop-recording").removeClass("loading disabled");
	}
});

$(".ui.dashboard .content").on("click", ".open-recordings", async () => {
	const directory = Settings.downloadDirectory("Recordings");
	await fs.promises.mkdir(directory, { recursive: true });
	shell.openPath(directory);
});

$(".ui.dashboard .content").on("click", ".new-recording", () => {
	$(".recording-result").hide();
	loadRecordingSources();
});

$(".ui.dashboard .content .courses.section .search.form").on("submit", function (e) {
	e.preventDefault();
	const keyword = $(e.target).find("input").val();
	search(keyword);
});

$(".download-update.button").on("click", () => {
	shell.openExternal(`https://github.com/${repoAccount}/udemy-downloader-gui/releases/latest`);
});

$(".content .ui.about").on("click", 'a[href^="http"]', function (e) {
	e.preventDefault();
	shell.openExternal(this.href);
});

$(".ui.settings .form").on("submit", (e) => {
	e.preventDefault();
	saveSettings(e.target);
});

const $settingsForm = $(".ui.settings .form");

$settingsForm.find('input[name="enabledownloadstartend"]').on("change", function () {
	$settingsForm.find('input[name="downloadstart"], input[name="downloadend"]').prop("readonly", !this.checked);
});

function loadSettings() {
	$settingsForm.find('input[name="check-new-version"]').prop("checked", Boolean(Settings.download.checkNewVersion));
	$settingsForm.find('input[name="auto-start-download"]').prop("checked", Boolean(Settings.download.autoStartDownload));
	$settingsForm
		.find('input[name="continue-downloading-encrypted"]')
		.prop("checked", Boolean(Settings.download.continueDonwloadingEncrypted));

	$settingsForm.find('input[name="enabledownloadstartend"]').prop("checked", Boolean(Settings.download.enableDownloadStartEnd));
	$settingsForm
		.find('input[name="downloadstart"], input[name="downloadend"]')
		.prop("readonly", !Boolean(Settings.download.enableDownloadStartEnd));

	$settingsForm.find('input:radio[name="downloadType"]').filter(`[value="${Settings.download.type}"]`).prop("checked", true);
	$settingsForm.find('input[name="skipsubtitles"]').prop("checked", Boolean(Settings.download.skipSubtitles));
	$settingsForm.find('input[name="autoretry"]').prop("checked", Boolean(Settings.download.autoRetry));
	$settingsForm.find('input[name="seq-zero-left"]').prop("checked", Boolean(Settings.download.seqZeroLeft));

	$settingsForm.find('input[name="downloadpath"]').val(Settings.downloadDirectory());
	$settingsForm.find('input[name="downloadstart"]').val(Settings.download.downloadStart);
	$settingsForm.find('input[name="downloadend"]').val(Settings.download.downloadEnd);

	const videoQuality = Settings.download.videoQuality;
	$settingsForm.find('input[name="videoquality"]').val(videoQuality);
	$settingsForm
		.find('input[name="videoquality"]')
		.parent(".dropdown")
		.find(".default.text")
		.html(translate(videoQuality || "Auto"));

	const language = Settings.language;
	$settingsForm.find('input[name="language"]').val(language || "");
	$settingsForm
		.find('input[name="language"]')
		.parent(".dropdown")
		.find(".default.text")
		.html(language || "English");

	const defaultSubtitle = Settings.download.defaultSubtitle;
	$settingsForm.find('input[name="defaultSubtitle"]').val(defaultSubtitle || "");
	$settingsForm
		.find('input[name="defaultSubtitle"]')
		.parent(".dropdown")
		.find(".defaultSubtitle.text")
		.html(defaultSubtitle || "");
}

function saveSettings(formElement) {
	const findInput = (inputName, attr = "") => $(formElement).find(`input[name="${inputName}"]${attr}`);

	const def = Settings.DownloadDefaultOptions;

	const checkNewVersion = findInput("check-new-version")[0].checked ?? def.checkNewVersion;
	const defaultSubtitle = findInput("defaultSubtitle").val() ?? def.defaultSubtitle;
	const downloadPath = findInput("downloadpath").val() ?? def.path;
	const autoStartDownload = findInput("auto-start-download")[0].checked ?? def.autoStartDownload;
	const continueDonwloadingEncrypted = findInput("continue-downloading-encrypted")[0].checked ?? def.continueDonwloadingEncrypted;
	const enableDownloadStartEnd = findInput("enabledownloadstartend")[0].checked ?? def.enableDownloadStartEnd;
	const downloadStart = parseInt(findInput("downloadstart").val() ?? def.downloadStart);
	const downloadEnd = parseInt(findInput("downloadend").val() ?? def.downloadEnd);
	const videoQuality = findInput("videoquality").val() ?? def.videoQuality;
	const downloadType = findInput("downloadType", ":checked").val() ?? def.type;
	const skipSubtitles = findInput("skipsubtitles")[0].checked ?? def.skipSubtitles;
	const seqZeroLeft = findInput("seq-zero-left")[0].checked ?? def.seqZeroLeft;
	const autoRetry = findInput("autoretry")[0].checked ?? def.autoRetry;
	const language = findInput("language").val() ?? undefined;

	Settings.download = {
		checkNewVersion,
		defaultSubtitle,
		path: downloadPath,
		autoStartDownload,
		continueDonwloadingEncrypted,
		enableDownloadStartEnd,
		downloadStart,
		downloadEnd,
		videoQuality,
		type: Number(downloadType),
		skipSubtitles,
		seqZeroLeft,
		autoRetry,
	};

	Settings.language = language;

	showAlert(translate("Settings Saved"));
}

function formatRecordingTime(milliseconds) {
	const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function renderRecordingSources(sources) {
	const $sources = $(".recording-sources").empty();
	if (!sources.length) {
		$sources.append($("<div>", { class: "ui segment", text: translate("No recordable windows were found.") }));
		return;
	}

	for (const source of sources) {
		const $card = $("<div>", {
			class: "card recording-source",
			tabindex: "0",
			role: "button",
			"aria-label": source.name,
		}).attr("data-source-id", source.id);
		const $image = $("<div>", { class: "image" });
		if (source.thumbnail) {
			$image.append($("<img>", { src: source.thumbnail, alt: "" }));
		} else {
			$image.append($("<div>", { class: "ui placeholder" }).append(
				$("<div>", { class: "rectangular image" })
			));
		}
		const $content = $("<div>", { class: "content" }).append(
			$("<div>", { class: "header", text: source.name }),
			$("<div>", { class: "meta" }).append(
				source.icon ? $("<img>", { class: "right floated tiny image", src: source.icon, alt: "" }) : "",
				$("<span>", { text: translate("Click to select this window") })
			)
		);
		$card.append($image, $content);
		const selectSource = () => {
			if (!["idle", "completed", "error"].includes(windowRecorder.state)) return;
			selectedRecordingSource = source;
			$sources.find(".recording-source").removeClass("selected");
			$card.addClass("selected");
			$(".start-recording").prop("disabled", false);
			$(".recording-result").hide();
		};
		$card.on("click", selectSource);
		$card.on("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				selectSource();
			}
		});
		$sources.append($card);
	}

	if (selectedRecordingSource) {
		$sources.find(".recording-source").each((_index, element) => {
			if ($(element).attr("data-source-id") === selectedRecordingSource.id) {
				$(element).addClass("selected");
			}
		});
	}
}

async function loadRecordingSources() {
	const $button = $(".refresh-recording-sources");
	if (["starting", "recording", "paused", "finalizing"].includes(windowRecorder.state)) return;
	$button.addClass("loading disabled");
	try {
		const sources = await windowRecorder.listSources();
		if (selectedRecordingSource && !sources.some((source) => source.id === selectedRecordingSource.id)) {
			selectedRecordingSource = null;
			$(".start-recording").prop("disabled", true);
		}
		renderRecordingSources(sources);
	} catch (error) {
		appendLog("loadRecordingSources_Error", error);
		showAlert(error.message, translate("Unable to load recording sources"));
	} finally {
		$button.removeClass("loading disabled");
	}
}

function renderRecorderState(snapshot) {
	const active = ["starting", "recording", "paused", "finalizing"].includes(snapshot.state);
	const labels = {
		idle: translate("Ready"),
		starting: translate("Starting Recording"),
		recording: translate("Recording"),
		paused: translate("Paused"),
		finalizing: translate("Saving Recording"),
		completed: translate("Recording saved"),
		error: translate("Recording failed"),
	};

	$(".recording-toolbar .checkbox, .refresh-recording-sources").toggleClass("disabled", active).find("input").prop("disabled", active);
	$(".refresh-recording-sources").prop("disabled", active);
	$(".start-recording").prop("disabled", active || !selectedRecordingSource);
	$(".recording-sources").toggle(!active);
	$(".recording-workspace").toggle(active);
	$(".recording-state-label").text(labels[snapshot.state] || snapshot.state);
	$(".recording-timer").text(formatRecordingTime(snapshot.elapsedMs));
	$(".pause-recording").prop("disabled", !["recording", "paused"].includes(snapshot.state));
	$(".stop-recording").prop("disabled", !["recording", "paused"].includes(snapshot.state));
	$(".pause-recording").html(
		snapshot.state === "paused"
			? '<i class="play icon"></i> ' + translate("Resume")
			: '<i class="pause icon"></i> ' + translate("Pause")
	);
	$(".recording-audio-warning")
		.text(snapshot.audioWarning || "")
		.toggle(Boolean(snapshot.audioWarning));

	if (snapshot.state === "completed") {
		$(".recording-preview")[0].srcObject = null;
		$(".recording-workspace").hide();
		$(".recording-result")
			.removeClass("negative")
			.addClass("positive")
			.show()
			.find(".header")
			.text(translate("Recording saved"));
		$(".recording-result-path").text(snapshot.path || "");
	} else if (snapshot.state === "error") {
		$(".recording-preview")[0].srcObject = null;
		$(".recording-workspace").hide();
		$(".recording-result")
			.removeClass("positive")
			.addClass("negative")
			.show()
			.find(".header")
			.text(translate("Recording failed"));
		$(".recording-result-path").text(snapshot.error || "");
		$(".recording-sources").show();
	}

	if (!recordingClock) {
		recordingClock = setInterval(() => {
			if (["starting", "recording", "paused", "finalizing"].includes(windowRecorder.state)) {
				$(".recording-timer").text(formatRecordingTime(windowRecorder.elapsedMs()));
			}
		}, 250);
	}
}

function selectDownloadPath() {
	const path = dialog.showOpenDialogSync({
		properties: ["openDirectory"],
	});

	if (path && path[0]) {
		fs.access(path[0], fs.constants.R_OK && fs.constants.W_OK, function (err) {
			if (err) {
				showAlert(translate("Cannot select this folder"));
			} else {
				$settingsForm.find('input[name="downloadpath"]').val(path[0]);
			}
		});
	}
}

async function checkUpdate(account, silent = false) {
	ui.busyCheckUpdate(true);

	try {
		const response = await fetch(`https://api.github.com/repos/${account}/udemy-downloader-gui/releases/latest`);

		if (!response.ok) {
			throw new Error(`Failed to check for updates: ${response.status}`);
		}

		const data = await response.json();
		if (data.tag_name != `v${appVersion}`) {
			repoAccount = account;
			$(".ui.update-available.modal").modal("show");
		} else if (!silent) {
			showAlert(translate("No updates available"));
		}
	} catch (error) {
		console.error("Failed to check for updates", error);
		if (!silent) {
			showAlert(translate("Failed to check for updates"), translate("Check for updates"));
		}
		appendLog("Failed to check for updates", error);
	} finally {
		ui.busyCheckUpdate(false);
	}
}

async function checkLogin(alertExpired = true) {
	if (Settings.accessToken) {
		try {
			ui.busyLogin(true);

			udemyService = new UdemyService(Settings.subDomain, HTTP_TIMEOUT);
			const userContext = await udemyService.fetchProfile(Settings.accessToken, 30000);

			if (!userContext.header.isLoggedIn) {
				if (alertExpired) {
					showAlert(Settings.accessToken, translate("Token expired"));
				}
				ui.resetToLogin();
				return;
			}
			ui.busyLogin(false);
			ui.showDashboard();

			Settings.subscriber = utils.toBoolean(userContext.header.user.enableLabsInPersonalPlan) || utils.toBoolean(userContext.header.user.consumer_subscription_active);
			fetchCourses(Settings.subscriber).then(() => {
				console.log("fetchCourses done");
			});

			if (Settings.download.checkNewVersion) {
				checkUpdate("heliomarpm", true);
			}
		} catch (error) {
			console.error("Failed to fetch user profile", error);
			if (!process.env.DEBUG_MODE) Settings.accessToken = null;

			ui.resetToLogin();
			showAlert(error.message, error.name || "Error");
		} finally {
			console.log("access-token", Settings.accessToken);
		}
	}
}

function loginWithUdemy() {
	const $formLogin = $(".ui.login .form");

	if ($formLogin.find('input[name="business"]').is(":checked")) {
		if (!ui.$subdomainField.val()) {
			showAlert("Type Business Name");
			return;
		}
	} else {
		ui.$subdomainField.val(null);
	}

	const parent = remote.getCurrentWindow();
	const dimensions = parent.getSize();
	const session = remote.session;
	let udemyLoginWindow = new BrowserWindow({
		width: dimensions[0] - 100,
		height: dimensions[1] - 100,
		parent,
		modal: true,
	});

	session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["*://*.udemy.com/*"] }, function (request, callback) {
		const token = request.requestHeaders.Authorization
			? request.requestHeaders.Authorization.split(" ")[1]
			: cookie.parse(request.requestHeaders.Cookie || "").access_token;

		if (token) {
			Settings.accessToken = token;
			Settings.subDomain = new URL(request.url).hostname.split(".")[0];

			udemyLoginWindow.destroy();
			session.defaultSession.clearStorageData();
			session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["*://*.udemy.com/*"] }, function (request, callback) {
				callback({ requestHeaders: request.requestHeaders });
			});
			checkLogin();
		}
		callback({ requestHeaders: request.requestHeaders });
	});

	Settings.subDomain = ui.$subdomainField.val() ?? "www";

	if (ui.$subdomainField.val()) {
		udemyLoginWindow.loadURL(`https://${Settings.subDomain}.udemy.com`);
	} else {
		udemyLoginWindow.loadURL("https://www.udemy.com/join/login-popup");
	}
}

function loginWithAccessToken() {
	const $formLogin = $(".ui.login .form");

	if ($formLogin.find('input[name="business"]').is(":checked")) {
		if (!ui.$subdomainField.val()) {
			showAlert("Type Business Name");
			return;
		}
	} else {
		ui.$subdomainField.val("www");
	}

	dialogs.prompt("Access Token", (access_token) => {
		if (access_token) {
			const submain = ui.$subdomainField.val();
			Settings.accessToken = access_token;
			Settings.subDomain = submain.trim().length == 0 ? "www" : submain.trim();

			checkLogin();
		}
	});
}

function createCourseElement(courseCache, downloadSection = false) {
	courseCache.completed = courseCache.completed || false;
	courseCache.infoDownloaded = "";
	courseCache.encryptedVideos = 0;
	courseCache.pathDownloaded = "";
	courseCache.name = courseCache.name || courseCache.title;

	const history = Settings.downloadHistory.find((x) => Number(x.id) === Number(courseCache.id));
	if (history) {
		courseCache.infoDownloaded = translate(history.completed ? "Download finished on" : "Download started since") + " " + history.date;
		courseCache.completed = history.completed ? true : courseCache.completed;
		courseCache.encryptedVideos = Math.max(courseCache.encryptedVideos, history.encryptedVideos);
		courseCache.selectedSubtitle = history.selectedSubtitle ?? "";
		courseCache.pathDownloaded = history.pathDownloaded ?? "";
	}

	// Se o caminho não existir, obtenha o caminho de configurações de download para o título do curso
	if (!fs.existsSync(courseCache.pathDownloaded)) courseCache.pathDownloaded = Settings.downloadDirectory(sanitize(courseCache.name));

	const tagDismiss = `<a class="ui basic dismiss-download">&nbsp;&nbsp;&nbsp;${translate("Dismiss")}</a>`;

	const $course = $(`
        <div class="ui course item" course-id="${courseCache.id}" course-url="${courseCache.url}" course-completed="${courseCache.completed}" style="padding-top: 35px !important; padding-bottom: 25px;">
            <input type="hidden" name="encryptedvideos" value="${courseCache.encryptedVideos}">
            <input type="hidden" name="selectedSubtitle" value="${courseCache.selectedSubtitle}">
            <input type="hidden" name="path-downloaded" value="${courseCache.pathDownloaded}">

            <div class="ui tiny label download-quality grey"></div>
            <div class="ui tiny black label download-speed">
                <span class="value">0</span>
                <span class="download-unit"> KB/s</span>
            </div>

            <div class="ui tiny image wrapper">
                <div class="ui red left corner label icon-encrypted">
                    <i class="lock icon"></i>
                </div>
                <img src="${courseCache.image ?? courseCache.image_240x135}" class="course-image border-radius" />
                ${downloadSection ? tagDismiss : ""}
                <div class="tooltip">${courseCache.encryptedVideos == 0 ? "" : MSG_DRM_PROTECTED}</div>
            </div>

            <div class="content">
                <span class="coursename">${courseCache.name}</span>
                <div class="ui tiny icon green download-success message">
                    <i class="check icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${translate("Download Finished")}</h4>
                        </div>
                        <p>${translate("Click to dismiss")}</p>
                    </div>
                </div>
                <div class="ui tiny icon red download-error message">
                    <i class="bug icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${translate("Download Failed")}</h4>
                        </div>
                        <p>${translate("Click to retry")}</p>
                    </div>
                </div>
                <div class="ui tiny icon purple course-encrypted message">
                    <i class="lock icon"></i>
                    <div class="content">
                        <div class="headers">
                            <h4>${MSG_DRM_PROTECTED}</h4>
                        </div>
                        <p>${translate("Click to dismiss")}</p>
                    </div>
                </div>

                <div class="extra download-status">
                    ${ui.actionCardTemplate}
                </div>
                <!-- <div style="margin-top:15px"><span class="lecture-name"></span></div> -->
            </div>
        </div>`);

	if (!downloadSection) {
		if (courseCache.completed) {
			resetCourse($course, $course.find(".download-success"));
		} else if (courseCache.encryptedVideos > 0) {
			resetCourse($course, $course.find(".course-encrypted"));
		} else {
			$course.find(".info-downloaded").html(courseCache.infoDownloaded).css("color", "#6d05e8").show();
		}
	} else {
		if (!courseCache.completed) {
			$course.find(".individual.progress").progress("set percent", courseCache.individualProgress).css("display", "block");
			$course.find(".combined.progress").progress("set percent", courseCache.combinedProgress).css("display", "block");
			$course.find(".download-status .label").html(courseCache.progressStatus);

			$course.find(".info-downloaded").hide();
			// $course.css("padding-bottom", "25px");
		} else {
			$course.find(".info-downloaded").html(courseCache.infoDownloaded).css("color", "#48ca56").show();
		}
	}

	if (Number(courseCache.encryptedVideos) === 0) {
		$course.find(".icon-encrypted").hide();
		$course.find(".ui.tiny.image .tooltip").hide();
		$course.find(".ui.tiny.image").removeClass("wrapper");
	} else {
		$course.find(".icon-encrypted").show();
		$course.find(".ui.tiny.image .tooltip").show();
		$course.find(".ui.tiny.image").addClass("wrapper");
	}

	if (!fs.existsSync(courseCache.pathDownloaded)) {
		$course.find(".open-dir.button").hide();
	}

	return $course;
}

function resetCourse($course, $elMessage) {
	if ($elMessage.hasClass("download-success")) {
		$course.attr("course-completed", true);
	} else {
		$course.attr("course-completed", "");
	}

	$course.find(".download-quality").hide();
	$course.find(".download-speed").hide().find(".value").html(0);
	$course.find(".download-status").hide().html(ui.actionCardTemplate);
	// $course.css("padding", "14px 0px");
	$elMessage.css("display", "flex");

	if (Number($course.find("input[name='encryptedvideos']").val()) > 0) {
		$course.find(".icon-encrypted").show();
		$course.find(".ui.tiny.image .tooltip").show();
		$course.find(".ui.tiny.image").addClass("wrapper");
	}
}

function renderCourses(response, isResearch = false) {
	const $coursesSection = $(".ui.dashboard .ui.courses.section");
	const $coursesItems = $coursesSection.find(".ui.courses.items").empty();

	$coursesSection.find(".disposable").remove();

	if (response.results.length) {
		// response.results.forEach(course => {
		//     $coursesItems.append(htmlCourseCard(course));
		// });
		const courseElements = response.results.map((course) => createCourseElement(course));
		$coursesItems.append(courseElements);

		if (response.next) {
            const dataUrl = Array.isArray(response.next) ? response.next : [response.next];
			// added loadMore Button
			$coursesSection.append(
				`<button class="ui basic blue fluid load-more button disposable" data-url=${JSON.stringify(dataUrl)}>
                    ${translate("Load More")}
                </button>`
			);
		}
	} else {
		let msg = "";
		if (!isResearch) {
			msg = getMsgChangeSearchMode();
			appendLog(translate("No Courses Found"), msg);
		}

		$coursesItems.append(
			`<div class="ui yellow message disposable">
                ${translate("No Courses Found")} <br/>
                ${translate("Remember, you will only be able to see the courses you are enrolled in")}
                ${msg}
            </div>`
		);
	}
}

async function renderDownloads() {
	const $downloadsSection = $(".ui.downloads.section .ui.courses.items");
	if ($downloadsSection.find(".ui.course.item").length) {
		return;
	}

	const downloadedCourses = Settings.downloadedCourses || [];
	if (!downloadedCourses.length) {
		// if ($downloadsSection.find(".ui.yellow.message").length) {
		//     return;
		// }
		// $downloadsSection.append(
		//     `<div class="ui yellow message">
		//     ${translate("There are no Downloads to display")}
		//     </div>`
		// );
	} else {
		ui.busyLoadDownloads(true);
		// await utils.sleep(10);
		// // downloadedCourses.forEach(course => {
		// downloadedCourses.map(course => {
		//     const $courseItem = htmlCourseCard(course, true);
		//     $downloadsSection.append($courseItem);

		//     if (!course.completed && Settings.download.autoStartDownload) {
		//         initializeDownload($courseItem, course.selectedSubtitle);
		//         // $courseItem.find(".action.buttons").find(".pause.button").removeClass("disabled");
		//     }
		// });
		// ui.busyLoadDownloads(false);

		function addCourseToDOM(course) {
			return new Promise((resolve, _reject) => {
				const $courseItem = createCourseElement(course, true);
				$downloadsSection.append($courseItem);

				if (!course.completed && Settings.download.autoStartDownload) {
					prepareDownloading($courseItem, course.selectedSubtitle);
				}

				// Simula atraso de 200ms para demonstração
				// setTimeout(() => { resolve(); }, 200);
				resolve();
			});
		}

		const promises = downloadedCourses.map((course) => addCourseToDOM(course));

		// Executa todas as Promessas em paralelo
		Promise.all(promises)
			.then(() => ui.busyLoadDownloads(false))
			.catch((e) => {
				console.trace("Error adding courses:", e);
				ui.busyLoadDownloads(false);
			});
	}
}

async function fetchCourseContent(courseId, courseName, courseUrl, downloadSettings = Settings.download, forDownload = false) {
	try {
		// ui.busyBuildCourseData(true);

		const downloadType = Number(downloadSettings.type);
		const onlyAttachments = forDownload && downloadType === Settings.DownloadType.OnlyAttachments;
		const preferredQuality = String(downloadSettings.videoQuality || "").toLowerCase();
		const includeHlsQualities = !forDownload || !["", "auto", "highest"].includes(preferredQuality);
		const response = await udemyService.fetchCourseContent(courseId, onlyAttachments ? "attachments" : "all", undefined, includeHlsQualities);
		if (!response) {
			// ui.busyBuildCourseData(false);
			showAlert(`Id: ${courseId}`, translate("Course not found"));
			return null;
		}
		const downloadAttachments = downloadType === Settings.DownloadType.Both || downloadType === Settings.DownloadType.OnlyAttachments;

		const courseData = {
			id: courseId,
			name: courseName,
			chapters: [],
			totalLectures: 0,
			encryptedVideos: 0,
			availableSubs: {},
		};

		let chapterData = null;
		response.results.forEach((item) => {
			const type = item._class.toLowerCase();
			if (type == "chapter") {
				if (chapterData) {
					courseData.chapters.push(chapterData);
				}
				chapterData = { id: item.id, name: item.title.trim(), lectures: [] };
			} else if (type == "quiz" || type == "practice") {
				const srcUrl = `${courseUrl}t/${item._class}/${item.id}`;

				chapterData.lectures.push({
					type: "url",
					name: item.title,
					src: `<script type="text/javascript">window.location = "${srcUrl}";</script>`,
					quality: "Attachment",
				});
				courseData.totalLectures++;
			} else {
				const lecture = { type, name: item.title, src: "", quality: downloadSettings.videoQuality || "Auto", isEncrypted: false };
				const { asset, supplementary_assets } = item;
				const assetType = onlyAttachments ? "" : asset?.asset_type?.toLowerCase();

				if (assetType == "article") {
					lecture.type = "article";
					lecture.quality = asset.asset_type;
					lecture.src = asset.data?.body ?? asset.body;
				} else if (assetType == "file" || assetType == "e-book") {
					lecture.type = "file";
					lecture.quality = asset.asset_type;
					lecture.src = asset.download_urls[asset.asset_type][0].file;
				} else if (assetType == "presentation") {
					lecture.type = "file";
					lecture.quality = asset.asset_type;
					lecture.src = asset.url_set[asset.asset_type][0].file;
				} else if (assetType?.startsWith("video")) {
					const streams = asset.streams;

					if (streams?.isEncrypted) {
						lecture.isEncrypted = true;
						courseData.encryptedVideos++;
					} else if (!streams?.minQuality) {
						//WARN: File not uploaded
						lecture.type = "url";
						lecture.quality = "NotFound";
						lecture.src = `<script type="text/javascript">window.location = "${courseUrl}/${item._class}/${item.id}";</script>`;
						appendLog("File not uploaded", `Course: ${courseId}|${courseName}`, `Lecture: ${item.id}|${item.title}`);
					} else {

						switch ((lecture.quality || "").toLowerCase()) {
                            case "":
							case "auto":
							case "highest":
								lecture.quality = streams.maxQuality;
								break;
							case "lowest":
								lecture.quality = streams.minQuality;
								break;
							default:
								lecture.quality = utils.isNumber(lecture.quality) ? lecture.quality : lecture.quality.slice(0, -1);
						}

						if (lecture.quality && !streams.sources[lecture.quality]) {
							if (utils.isNumber(lecture.quality) && streams.maxQuality != "auto") {
								const source = utils.getClosestValue(streams.sources, lecture.quality);
								lecture.quality = source?.key || streams.maxQuality;
							} else {
								lecture.quality = streams.maxQuality;
							}
						}

						const source = streams.sources[lecture.quality];
						lecture.src = source.url;
						lecture.type = source.type;
						lecture.externalAudio = source.externalAudio;
						lecture.mediaPlaylist = source.mediaPlaylist;
					}
				} else if (!onlyAttachments) {
					appendLog("Unknown Asset Type ", `type: ${assetType}`, `Course: ${courseId}|${courseName}`);
				}

				if (!onlyAttachments && !downloadSettings.skipSubtitles && asset?.captions?.length > 0) {
					lecture.subtitles = {};

					asset.captions.forEach((caption) => {
						caption.video_label in courseData.availableSubs
							? (courseData.availableSubs[caption.video_label] = courseData.availableSubs[caption.video_label] + 1)
							: (courseData.availableSubs[caption.video_label] = 1);

						lecture.subtitles[caption.video_label] = caption.url;
					});
				}

				if (downloadAttachments && supplementary_assets?.length > 0) {
					const attachments = (lecture.attachments = []);

					supplementary_assets.forEach((attachment) => {
						const file = attachment.download_urls?.[attachment.asset_type]?.[0]?.file;
						const type = file || !attachment.external_url ? "file" : "url";
						const src = type === "file" ? file : `<script type="text/javascript">window.location = "${attachment.external_url}";</script>`;

						attachments.push({ type, name: attachment.title, src, quality: "Attachment" });
					});
				}

				chapterData.lectures.push(lecture);
				courseData.totalLectures++;
			}
		});

		if (chapterData) {
			courseData.chapters.push(chapterData);
		}

		// ui.busyBuildingCourseData(false);
		return courseData;
	} catch (error) {
		handleApiError(error, "EBUILDING_COURSE_DATA", courseName, true);
	}
}

async function fetchCourses(isSubscriber) {
	ui.busyLoadCourses(true);

	udemyService
		.fetchCourses(PAGE_SIZE, isSubscriber)
		.then((resp) => {
			renderCourses(resp);
			if (Settings.downloadedCourses) {
				renderDownloads();
			}
		})
		.catch((e) => {
			handleApiError(e, "EFETCHING_COURSES");
		})
		.finally(() => {
			ui.busyLoadCourses(false);
		});
}

function loadMore(loadMoreButton) {
	const $button = $(loadMoreButton);
	const $courses = $button.prev(".courses.items");
	const url = [...$button.data("url")];

	ui.busyLoadCourses(true);
	udemyService
		.fetchLoadMore(url[0])
		.then((resp) => {
			$courses.append(...resp.results.map((course) => createCourseElement(course, false)));
			if (!resp.next) {
                if (url.length > 1) {
                    $button.data("url", [url[1]]);
                } else {
                    $button.remove();
                }
			} else {
                if (url.length > 1) {
                    $button.data("url", [resp.next, url[1]]);
                }else {
                    $button.data("url", [resp.next]);
                }
            }
		})
		.catch((e) => {
			const statusCode = (e.response?.status || 0).toString() + (e.code ? ` :${e.code}` : "");
			appendLog(`ELOADING_MORE: (${statusCode})`, e);
		})
		.finally(() => {
			ui.busyLoadCourses(false);
		});
}

async function search(keyword) {
	ui.busyLoadCourses(true);

	try {
		const courses = await udemyService.fetchSearchCourses(keyword, PAGE_SIZE, Settings.subscriber);
		renderCourses(courses, !!keyword);
	} catch (error) {
		handleApiError(error, "ESEARCHING_COURSES", null, false);
	} finally {
		ui.busyLoadCourses(false);
	}
}

function getMsgChangeSearchMode() {
	const msg = Settings.subscriber
		? translate("This account has been identified with a subscription plan")
		: translate("This account was identified without a subscription plan");

	const button = `
    <div class="ui fluid buttons">
        <button class='ui primary button change-search-mode' onclick='toggleSubscriber()'>${translate("Change search mode")}</button>
    </div>`;

	return `<p>${msg}<br/>${translate("If it's wrong, change the search mode and try again")}${button}</p>`;
}

/**
 * Toggles the subscriber setting and clears the search field.
 */
function toggleSubscriber() {
	Settings.subscriber = !Settings.subscriber;
	search("");
}

function addDownloadHistory(courseId, courseName, completed = false, encryptedVideos = 0, selectedSubtitle = "", pathDownloaded = "") {
	courseId = Number(courseId);
	courseName = String(courseName) || "";
	completed = Boolean(completed);
	encryptedVideos = Number(encryptedVideos);
	selectedSubtitle = String(selectedSubtitle) || "";
	pathDownloaded = String(pathDownloaded) || "";

	const items = Settings.downloadHistory;
	const index = items.findIndex((x) => Number(x.id) === courseId);

	if (index !== -1) {
		const item = items[index];
		item.id = courseId;
		item.name = courseName;
		if (completed !== Boolean(item.completed)) {
			item.completed = completed;
			item.date = new Date(Date.now()).toLocaleDateString();
		}
		item.encryptedVideos = encryptedVideos;
		item.selectedSubtitle = selectedSubtitle;
		item.pathDownloaded = pathDownloaded;
	} else {
		items.push({
			id: courseId,
			name: courseName,
			completed,
			date: new Date(Date.now()).toLocaleDateString(),
			encryptedVideos,
			selectedSubtitle,
			pathDownloaded,
		});
	}

	Settings.downloadHistory = items;
}

function getDownloadHistory(courseId) {
	return Settings.downloadHistory.find((x) => x.id === courseId) || undefined;
}

function saveDownloads(shouldQuitApp) {
	ui.busySavingHistory(true);

	function getProgress($progress) {
		const dataPercent = $progress.attr("data-percent");
		return parseInt(dataPercent, 10);
	}

	const downloadedCourses = [];
	const downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item");

	downloads.each((_index, element) => {
		const $el = $(element);
		const hasProgress = $el.find(".progress.active").length > 0;
		const individualProgress = hasProgress ? getProgress($el.find(".download-status .individual.progress")) : 0;
		const combinedProgress = hasProgress ? getProgress($el.find(".download-status .combined.progress")) : 0;
		const isCompleted = !hasProgress && $el.attr("course-completed") === "true";

		const courseData = {
			id: Number($el.attr("course-id")),
			url: $el.attr("course-url"),
			name: $el.find(".coursename").text(),
			image: $el.find(".image img").attr("src"),
			individualProgress: Math.min(100, individualProgress),
			combinedProgress: Math.min(100, combinedProgress),
			completed: isCompleted,
			progressStatus: $el.find(".download-status .label").text(),
			encryptedVideos: Number($el.find('input[name="encryptedvideos"]').val()),
			selectedSubtitle: $el.find('input[name="selectedSubtitle"]').val(),
			pathDownloaded: $el.find('input[name="path-downloaded"]').val(),
		};

		downloadedCourses.push(courseData);
		addDownloadHistory(
			courseData.id,
			courseData.name,
			courseData.completed,
			courseData.encryptedVideos,
			courseData.selectedSubtitle,
			courseData.pathDownloaded
		);
	});

	Settings.downloadedCourses = downloadedCourses.sort((a, b) => {
		if (a.completed === b.completed) {
			return b.combinedProgress - a.combinedProgress;
		}
		return a.completed ? 1 : -1;
	});

	if (shouldQuitApp) {
		ipcRenderer.send("quitApp");
	} else {
		ui.busySavingHistory(false);
	}
}

function removeCurseDownloads(courseId) {
	const $downloads = $(".ui.downloads.section .ui.courses.items .ui.course.item"); //.slice(0);

	$downloads.each((_index, element) => {
		const $el = $(element);
		if ($el.attr("course-id") == courseId) {
			$el.remove();
		}
	});
}

async function saveM3u($course) {
	ui.prepareDownloading($course);

	const courseId = $course.attr("course-id");
	const courseName = $course.find(".coursename").text();
	const courseUrl = `https://${Settings.subDomain}.udemy.com${$course.attr("course-url")}`;

	console.clear();

	let courseData = null;
	try {
		courseData = await fetchCourseContent(courseId, courseName, courseUrl);
		if (!courseData) {
			// ui.showProgress($course, false);
			return;
		}

        console.log(courseData);
        dialog
		.showSaveDialog({
			title: "Save M3U",
			defaultPath: `${courseName}.m3u`,
			filters: [{ name: "M3U File (*.m3u)", fileExtension: ["m3u"] }],
		})
		.then((result) => {
			if (!result.canceled) {
				let filePath = result.filePath;
				if (!filePath.endsWith(".m3u")) filePath += ".m3u";

				let content = "#EXTM3U";
                let index = 0;
				courseData.chapters.forEach((chapter) => {
                    chapter.lectures.forEach((lecture, lec_index) => {
                        index++;
                        if (lecture.src) content += `\n#EXTINF:-1,${lec_index+1}. ${lecture.name}\n${lecture.src}`;

                        if (lecture.attachments && lecture.attachments.length > 0)
                          lecture.attachments.forEach((attachment, attach_index) => {
                            content += `\n#EXTINF:-1,${lec_index+1}.${attach_index+1} ${attachment.name}\n${attachment.src}`;
                          })
                    })
				});

				fs.writeFile(filePath, content, (error) => {
					if (error) {
						appendLog("saveM3u_Error", error);
						return;
					}
					console.log("File successfully create!");
				});
			}
		});

	} catch (error) {
		handleApiError(error, "ESAVE_M3U", null, false);
		ui.busyOff();
		$course.find(".prepare-downloading").hide();
	} finally {
        ui.showProgress($course, false);
    }
}

async function prepareDownloading($course, subtitle) {
	ui.prepareDownloading($course);
	// ui.showProgress($course, true);

	const courseId = $course.attr("course-id");
	const courseName = $course.find(".coursename").text();
	const courseUrl = `https://${Settings.subDomain}.udemy.com${$course.attr("course-url")}`;

	const downloadSettings = Settings.download;
	const defaultSubtitle = downloadSettings.skipSubtitles ? "" : (subtitle ?? downloadSettings.defaultSubtitle ?? "");

	console.clear();

	let courseData = null;
	try {
		courseData = await fetchCourseContent(courseId, courseName, courseUrl, downloadSettings, true);
		if (!courseData) {
			ui.showProgress($course, false);
			return;
		}

		$course.find('input[name="encryptedvideos"]').val(courseData.encryptedVideos);
		if (courseData.encryptedVideos > 0 && !downloadSettings.continueDonwloadingEncrypted) {
			resetCourse($course, $course.find(".course-encrypted"));
			return;
		}

		try {
			askForSubtitle(courseData.availableSubs, courseData.totalLectures, defaultSubtitle, (subtitle) => {
				startDownload($course, courseData, subtitle, downloadSettings);
			});
		} catch (error) {
			throw utils.newError("EASK_FOR_SUBTITLE", error.message);
		}
	} catch (error) {
		const errorName = error.name === "EASK_FOR_SUBTITLE" ? error.name : "EPREPARE_DOWNLOADING";
		handleApiError(error, errorName, null, false);
		ui.busyOff();
		$course.find(".prepare-downloading").hide();
		resetCourse($course, $course.find(".download-error"));
	}
}

function startDownload($course, courseData, subTitle = "", downloadSettings = Settings.download) {
	ui.showProgress($course, true);

	const subtitle = (Array.isArray(subTitle) ? subTitle[0] : subTitle).split("|");
	const onlyAttachments = Number(downloadSettings.type) === Settings.DownloadType.OnlyAttachments;
	$course.find(".info-downloaded").hide();
	$course.find('input[name="selectedSubtitle"]').val(subtitle);
	$course.find('input[name="encryptedvideos"]').val(courseData.encryptedVideos);

	const $clone = $course.clone();
	const $downloads = $(".ui.downloads.section .ui.courses.items");
	const $courses = $(".ui.courses.section .ui.courses.items");

	if ($course.parents(".courses.section").length) {
		const $downloadItem = $downloads.find("[course-id=" + $course.attr("course-id") + "]");
		if ($downloadItem.length) {
			$downloadItem.replaceWith($clone);
		} else {
			$downloads.prepend($clone);
		}
	} else {
		const $courseItem = $courses.find("[course-id=" + $course.attr("course-id") + "]");
		if ($courseItem.length) {
			$courseItem.replaceWith($clone);
		}
	}
	$course.push($clone[0]);

	const courseName = sanitize(courseData["name"]); //, { replacement: (s) => "? ".indexOf(s) > -1 ? "" : "-", }).trim();
	const $progressCombined = $course.find(".combined.progress");
	const $progressIndividual = $course.find(".individual.progress");

	const $downloadSpeed = $course.find(".download-speed");
	const $downloadSpeedValue = $downloadSpeed.find(".value");
	const $downloadSpeedUnit = $downloadSpeed.find(".download-unit");
	const $downloadQuality = $course.find(".download-quality");

	const downloadDirectory = Settings.downloadDirectory();
	$course.find('input[name="path-downloaded"]').val(`${downloadDirectory}/${courseName}`);
	$course.find(".open-dir.button").show();
	// $course.css("cssText", "padding-top: 35px !important").css("padding-bottom", "25px");

	const $actionButtons = $course.find(".action.buttons");
	const $downloadButton = $actionButtons.find(".download.button");
	const $pauseButton = $actionButtons.find(".pause.button");
	const $resumeButton = $actionButtons.find(".resume.button");

	$downloadButton.addClass("disabled");
	$pauseButton.removeClass("disabled");
	$resumeButton.addClass("disabled");

	$pauseButton.click(() => stopDownload());
	$resumeButton.click(() => resumeDownload());

	let activeDownload = null;
	let hadFailures = false;

	const lectureChapterMap = {};
	let sequenceMap = 0;
	courseData.chapters.forEach((chapter, chapterIndex) => {
		chapter.lectures.forEach((_lecture, lectureIndex) => {
			sequenceMap++;
			lectureChapterMap[sequenceMap] = { chapterIndex, lectureIndex };
		});
	});

	const labelColorMap = {
		144: "brown",
		240: "purple",
		360: "yellow",
		432: "orange",
		480: "teal",
		576: "blue",
		720: "olive",
		1080: "green",
		Highest: "green",
		auto: "red",
		Auto: "red",
		Attachment: "pink",
		Subtitle: "black",
	};

	let downloaded = 0;
	let toDownload = courseData["totalLectures"];

	const enableDownloadStartEnd = downloadSettings.enableDownloadStartEnd && toDownload > 0;
	let downloadStart = 1;
	if (enableDownloadStartEnd) {
		downloadStart = Math.max(1, Math.min(downloadSettings.downloadStart || 1, toDownload));
		const downloadEnd = Math.min(toDownload, Math.max(downloadStart, downloadSettings.downloadEnd || toDownload));

		toDownload = downloadEnd - downloadStart + 1;
	}

	$progressCombined.progress({
		total: toDownload,
		text: {
			active: `${translate("Downloaded")} {value} ${translate("out of")} {total} ${translate("items")}`,
		},
	});

	$progressCombined.progress("reset");
	$downloadSpeed.show();
	$downloadQuality.show();

	if (enableDownloadStartEnd) {
		downloadChapter(lectureChapterMap[downloadStart].chapterIndex, lectureChapterMap[downloadStart].lectureIndex);
	} else {
		downloadChapter(0, 0);
	}

	function stopDownload() {
		if (!activeDownload) return;
		activeDownload.stop();
		$pauseButton.addClass("disabled");
		$resumeButton.removeClass("disabled");
	}

	function resumeDownload() {
		if (!activeDownload) return;
		activeDownload.resume();
		$pauseButton.removeClass("disabled");
		$resumeButton.addClass("disabled");
	}

	function setLabelQuality(label) {
		const lastClass = $downloadQuality.attr("class").split(" ").pop();
		$downloadQuality
			.html(label.toString() + (!isNaN(parseFloat(label)) ? "p" : ""))
			.removeClass(lastClass)
			.addClass(labelColorMap[label] || "grey");
	}

	function downloadChapter(chapterIndex, lectureIndex) {
		try {
			const countLectures = courseData.chapters[chapterIndex].lectures.length;
			const seqName = utils.getSequenceName(
				chapterIndex + 1,
				courseData.chapters.length,
				sanitize(courseData.chapters[chapterIndex].name.trim()),
				". ",
				downloadDirectory + "/" + courseName
			);

			fs.mkdirSync(seqName.fullPath, { recursive: true });
			downloadLecture(chapterIndex, lectureIndex, countLectures, seqName.name);
		} catch (error) {
			handleApiError(error, "EDOWNLOADING_CHAPTER", null, false);
			resetCourse($course, $course.find(".download-error"));
		}
	}

	function downloadLecture(chapterIndex, lectureIndex, countLectures, sanitizedChapterName) {
		try {
			if (downloaded == toDownload) {
				if (hadFailures) {
					resetCourse($course, $course.find(".download-error"));
					return;
				}
				resetCourse($course, $course.find(".download-success"));
				sendNotification(
					downloadDirectory + "/" + courseName,
					courseName,
					$course.find(".ui.tiny.image").find(".course-image").attr("src")
				);
				return;
			} else if (lectureIndex == countLectures) {
				downloadChapter(++chapterIndex, 0);
				return;
			}

			const lectureData = courseData.chapters[chapterIndex].lectures[lectureIndex];
			const lectureType = lectureData.type.toLowerCase();
			const lectureName = lectureData.name.trim();
			const sanitizedLectureName = sanitize(lectureName);

			function continueLecture() {
				$progressCombined.progress("increment");
				downloaded++;
				downloadLecture(chapterIndex, lectureIndex + 1, countLectures, sanitizedChapterName);
			}

			function recordFailure(stage, error) {
				hadFailures = true;
				appendLog(stage, error, "Chapter " + (chapterIndex + 1) + ", item " + (lectureIndex + 1));
			}

			function finishProtected() {
				if (!lectureData.isEncrypted) {
					lectureData.isEncrypted = true;
					$course.find('input[name="encryptedvideos"]').val(++courseData.encryptedVideos);
				}
				appendLog("Video with DRM Protection", "Chapter " + (chapterIndex + 1) + ", item " + (lectureIndex + 1));
				if (!downloadSettings.continueDonwloadingEncrypted) {
					resetCourse($course, $course.find(".course-encrypted"));
					return;
				}
				checkAttachment();
			}

			function dlStart(src, target, callback, isVideo = false) {
				const dl = new FileDownload(src, target, downloadSettings.autoRetry, isVideo);
				activeDownload = dl;
				$pauseButton.removeClass("disabled");
				$resumeButton.addClass("disabled");

				const timer = setInterval(() => {
					if (dl.status !== 1) {
						$downloadSpeedValue.html(0);
						return;
					}
					const stats = dl.getStats();
					const speed = utils.getDownloadSpeed(stats.present.speed || 0);
					$downloadSpeedValue.html(speed.value);
					$downloadSpeedUnit.html(speed.unit);
					$progressIndividual.progress("set percent", stats.total.completed);
				}, 1000);

				const finish = (error) => {
					clearInterval(timer);
					activeDownload = null;
					$pauseButton.addClass("disabled");
					$resumeButton.addClass("disabled");
					callback(error);
				};
				dl.on("retry", (_job, error, retry) => appendLog("File download retry " + retry, error));
				dl.once("error", () => finish(dl.error));
				dl.once("end", () => finish());
				dl.start();
			}

			function downloadAttachments(index) {
				const attachment = lectureData.attachments[index];
				if (!attachment) return continueLecture();

				$progressIndividual.progress("reset");
				setLabelQuality(attachment.quality);
				$downloadSpeedValue.html(0);

				const attachmentName = sanitize(attachment.name.trim());
				const target = (suffix) => utils.getSequenceName(
					lectureIndex + 1, countLectures, attachmentName + suffix, "." + (index + 1) + " ", dir
				).fullPath;
				const next = (error) => {
					if (error) recordFailure("Attachment " + (index + 1) + " download failed", error);
					downloadAttachments(index + 1);
				};

				if (attachment.type === "url") {
					fs.writeFile(target(".html"), attachment.src, next);
					return;
				}

				const src = attachment.src?.startsWith("//") ? "https:" + attachment.src : attachment.src;
				let extension;
				try {
					extension = path.extname(new URL(src).pathname);
				} catch {
					next(new Error("Invalid attachment URL"));
					return;
				}
				const file = target(attachmentName.endsWith(extension) ? "" : extension);
				if (fs.existsSync(file)) next();
				else dlStart(src, file, next);
			}

			function checkAttachment() {
				$progressIndividual.progress("reset");
				if (!lectureData.attachments?.length) return continueLecture();
				lectureData.attachments.sort(utils.dynamicSort("name"));
				downloadAttachments(0);
			}

			async function downloadSubtitle() {
				$progressIndividual.progress("reset");
				setLabelQuality("Subtitle");
				$downloadSpeedValue.html(0);
				const file = utils.getSequenceName(lectureIndex + 1, countLectures, sanitizedLectureName + ".srt", ". ", dir).fullPath;
				if (fs.existsSync(file)) return;
				const tempFile = file + ".part";
				const subtitles = lectureData.subtitles;
				const available = subtitle.filter((label) => label in subtitles);
				const label = available.find((label) => !label.includes("[Auto]") && !label.includes("[" + translate("Auto") + "]")) ??
					available[0] ?? Object.keys(subtitles)[0];
				try {
					await new Promise((resolve, reject) => {
						const request = https.get(subtitles[label], (response) => {
							if (response.statusCode !== 200) {
								response.resume();
								reject(new Error("Subtitle HTTP " + response.statusCode));
								return;
							}
							pipeline(response, vtt2srt(), fs.createWriteStream(tempFile), (error) => {
								if (error) reject(error);
								else resolve();
							});
						});
						request.setTimeout(HTTP_TIMEOUT, () => request.destroy(new Error("Subtitle request timed out")));
						request.on("error", reject);
					});
					await fs.promises.rename(tempFile, file);
				} catch (error) {
					if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
					throw error;
				}
			}

			const dir = downloadDirectory + "/" + courseName + "/" + sanitizedChapterName;
			async function processLecture() {
				if (onlyAttachments) return checkAttachment();
				if (lectureData.isEncrypted) return finishProtected();

				const suffix = lectureType === "article" || lectureType === "url" ? ".html" : lectureType === "file" ? ".pdf" : ".mp4";
				const file = utils.getSequenceName(lectureIndex + 1, countLectures, sanitizedLectureName + suffix, ". ", dir).fullPath;
				$progressIndividual.progress("reset");
				setLabelQuality(lectureData.quality);
				$pauseButton.addClass("disabled");

				try {
					if (!fs.existsSync(file)) {
						if (suffix === ".html") {
							await fs.promises.writeFile(file, lectureData.src);
						} else if (M3U8Service.isHls(lectureType, lectureData.src)) {
							await new M3U8Service(lectureData.src).download(file, {
								attempts: downloadSettings.autoRetry ? 3 : 1,
								externalAudio: lectureData.externalAudio,
								audioPlaylist: lectureData.audioPlaylist,
								mediaPlaylist: lectureData.mediaPlaylist,
								onQuality: setLabelQuality,
								onProgress(index, total, bytes, milliseconds) {
									const speed = utils.getDownloadSpeed(bytes * 1000 / milliseconds);
									$downloadSpeedValue.html(speed.value);
									$downloadSpeedUnit.html(speed.unit);
									$progressIndividual.progress("set percent", Math.floor(index * 100 / total));
								},
							});
						} else {
							await new Promise((resolve, reject) => dlStart(lectureData.src, file, (error) => error ? reject(error) : resolve(), suffix === ".mp4"));
						}
					}
					if (lectureData.subtitles) await downloadSubtitle();
				} catch (error) {
					if (error.code === "HLS_PROTECTED" || error.code === "MEDIA_PROTECTED") return finishProtected();
					recordFailure("Lecture download failed", error);
				}
				checkAttachment();
			}

			processLecture().catch((error) => {
				recordFailure("Lecture processing failed", error);
				continueLecture();
			});
		} catch (error) {
			appendLog("downloadLecture_Error:", error);
			captureException(error);

			resetCourse($course, $course.find(".download-error"));
		}
	}

}

function askForSubtitle(subtitlesAvailable, totalLectures, defaultSubtitle = "", callback) {
	const subtitleLanguages = [];
	const languages = [];
	const totals = {};
	const languageKeys = {};

    try {
        if (subtitlesAvailable && Object.keys(subtitlesAvailable).length === 0) {
            callback("");
            return;
        }
    } catch (error) {
        return;
    }

	defaultSubtitle = defaultSubtitle.replace(/\s*\[.*?\]/g, "").trim();
	for (const key in subtitlesAvailable) {
		const subtitle = key.replace(/\s*\[.*?\]/g, "").trim();

		// default subtitle exists
		if (subtitle === defaultSubtitle) {
			callback(key);
			return;
		}

		if (!(subtitle in totals)) {
			languages.push(subtitle);
			totals[subtitle] = 0;
			languageKeys[subtitle] = [];
		}

		totals[subtitle] += subtitlesAvailable[key];
		languageKeys[subtitle].push(key);
	}

	if (languages.length === 1) {
		callback(languageKeys[0]);
		return;
	} else if (languages.length === 0) {
		return;
	}

	languages.forEach((language) => {
		totals[language] = Math.min(totalLectures, totals[language]);
	});

	languages.sort();
	languages.forEach((language) => {
		subtitleLanguages.push({
			name: `<b>${language}</b> <i>${totals[language]} ${translate("Lectures")}</i>`,
			value: languageKeys[language].join("|"),
		});
	});
	subtitleLanguages.unshift({ name: "", value: "" });

	const $subtitleModal = $(".ui.subtitle.modal");
	const $subtitleDropdown = $subtitleModal.find(".ui.dropdown");

	$subtitleModal.modal({ closable: false }).modal("show");
	$subtitleDropdown.dropdown({
		values: subtitleLanguages,
		onChange: (subtitle) => {
			$subtitleModal.modal("hide");
			$subtitleDropdown.dropdown({ values: [] });
			callback(subtitle);
		},
	});
}

function sendNotification(pathCourse, courseName, urlImage = null) {
	try {
		new Notification(courseName, {
			body: translate("Download Finished"),
			icon: urlImage ?? __dirname + "/assets/images/build/icon.png",
		}).onclick = () => {
			shell.openPath(pathCourse);
		};
	} catch (error) {
		appendLog("sendNotification", error);
	}
}

function clearLogArea() {
	loggers.length = 0;
	$(".ui.logger.section .ui.list").html("");
	clearBagdeLoggers();
}

function clearBagdeLoggers() {
	$("#badge-logger").text("0");
	$("#badge-logger").hide();
}

/**
 * Function to append a log entry with the specified title and error.
 *
 * @param {string} title - The title of the log entry.
 * @param {string|Error|object} error - The error message or Error object.
 */
function appendLog(title, error, additionalDescription = "") {
	let description =
		error instanceof Error
			? error.message //`${error.message}\n ${error.stack}`
			: typeof error == "object"
				? JSON.stringify(error)
				: error;

	description += additionalDescription !== "" ? "\n\n" + additionalDescription : "";

	// item added to list to display
	$(".ui.logger.section .ui.list").prepend(
		`<div class="item">
        <div class="header">
        ${title}
        </div>
        <samp>${description.replace("\n", "<br>").replace("\r", "<br>")}</samp>
        </div>`
	);

	// item added to array to save txt file
	loggers.unshift({
		datetime: new Date().toLocaleString(),
		title,
		description,
	});

	// increment badge
	const $badge = $("#badge-logger");
	const qtd = (parseInt($badge.text(), 0) || 0) + 1;

	$badge.text(qtd > 99 ? "99+" : qtd);
	$badge.show();

	if (error instanceof Error) {
		console.trace(`[${title}] ${error.message}\n ${error.stack}`);
		captureException(error);
	} else {
		console.warn(`[${title}] ${description}`);
	}
}

function saveLogFile() {
	if (loggers.length == 0) return;

	dialog
		.showSaveDialog({
			title: "Udeler Log",
			defaultPath: "udeler_logger.txt",
			filters: [{ name: "Text File (*.txt)", fileExtension: ["txt"] }],
		})
		.then((result) => {
			if (!result.canceled) {
				let filePath = result.filePath;
				if (!filePath.endsWith(".txt")) filePath += ".txt";

				let content = "";

				loggers.forEach((item) => {
					content += `${item.datetime} - ${item.title}: ${item.description}\n`;
				});

				fs.writeFile(filePath, content, (error) => {
					if (error) {
						appendLog("saveLogFile_Error", error);
						return;
					}
					console.log("File successfully create!");
				});
			}
		});
}

function handleApiError(error, errorName, courseName = null, triggerThrow = true) {
	error.name = errorName;
	error.code = error.code || "";

	const statusCode = error.response?.status || 0;
	switch (statusCode) {
		case 403:
			error.message = translate("You do not have permission to access this course");
			// prompt.alert(msgError);
			showAlertError(error.message, errorName);
			break;
		case 503:
			error.message = translate("Service is temporarily unavailable. Please wait a few minutes and try again.");
			showAlertError(error.message, errorName);
			break;
		case 504:
			error.message = "Gateway timeout";
			showAlertError(error.message, errorName);
			break;
		default:
			break;
	}

	if (courseName) error.message += `\n\n course: ${courseName}`;

	appendLog(`${errorName}: ${error.code}(${statusCode})`, error);

	if (triggerThrow) {
		// throw utils.newError(errorName, error.message);
		throw error;
	}
}

function showAlertError(message, title = "") {
	title = title ? `.:: ${title} ::.` : ".:: Error ::.";
	dialog.showErrorBox(title, message);
}

function showAlert(message, title = "") {
	if (title) title = `.:: ${title} ::.\n\r`;
	dialogs.alert(`${title}${message}`);
}

function captureException(exception) {
	if (Sentry) Sentry.captureException(exception);
}

process.on("uncaughtException", (error) => {
	appendLog("EPROCESS_UNCAUGHT_EXCEPTION", error);
	captureException(error);
});

process.on("unhandledRejection", (error) => {
	appendLog("EPROCESS_UNHANDLED_REJECTION", error);
	captureException(error);
});

// console.table(getAllDownloadsHistory());
checkLogin(false);
