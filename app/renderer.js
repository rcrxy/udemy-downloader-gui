"use strict";

const Sentry = require("@sentry/electron/renderer");
const Gettings = require("./helpers/settings.js");
const { version: appVersion, vars: pkgVars } = require("../package.json");

if (process.env.IS_PACKAGE && process.env.SENTRY_DSN && !process.env.DEBUG_MODE) {
	fetch(pkgVars.urlToggles)
		.then((resp) => {
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			return resp.json();
		})
		.then(({ enableSentry }) => {
			if (enableSentry) Sentry.init({ dsn: process.env.SENTRY_DSN });
		})
		.catch((error) => console.warn("Failed to load feature toggles", error.message));
}

const localeMeta = require("./locale/meta.json");
let localeJson;

function translate(text) {
	const language = Gettings.language;

	if (language == "English") {
		return text;
	} else {
		try {
			if (!localeJson) {
				localeJson = require(`./locale/${localeMeta[language]}`);
			}

			return localeJson[text] || text;
		} catch (e) {
			console.error(e);
			return text;
		}
	}
}

function translateWrite(text) {
	document.write(translate(text));
}

function urlDonate() {
	return `${pkgVars.urlDonate}&item_name=${translate("Udeler is free and without any ads. If you appreciate that, please consider donating to the Developer.").replace(" ", "+")}`;
}
