const { BrowserWindow, session } = require("electron");
const { randomUUID } = require("node:crypto");
const { parse } = require("cookie");

function udemyHost(subdomain) {
    if (typeof subdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(subdomain.trim())) {
        throw new Error("Invalid Udemy subdomain");
    }
    return `${subdomain.trim().toLowerCase()}.udemy.com`;
}

function registerUdemyLogin(ipcMain, isMainRenderer) {
    let loginWindow;
    ipcMain.handle("udemy:login", (event, subdomain) => {
        if (!isMainRenderer(event)) throw new Error("Udemy login is only available from the main window");
        if (loginWindow) {
            loginWindow.focus();
            return null;
        }

        const host = udemyHost(subdomain);
        const parent = BrowserWindow.fromWebContents(event.sender);
        const [width, height] = parent.getSize();
        const loginSession = session.fromPartition(`udemy-login-${randomUUID()}`);
        const window = new BrowserWindow({
            parent,
            modal: true,
            width: width - 100,
            height: height - 100,
            webPreferences: { session: loginSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        loginWindow = window;
        const contentsId = window.webContents.id;
        return new Promise((resolve, reject) => {
            let result = null;
            let closing = false;
            window.once("close", () => { closing = true; });
            window.once("closed", () => {
                loginWindow = null;
                loginSession.webRequest.onBeforeSendHeaders(null);
                resolve(result);
            });
            loginSession.webRequest.onBeforeSendHeaders({ urls: [`https://${host}/*`] }, (request, callback) => {
                callback({ requestHeaders: request.requestHeaders });
                if (result || request.webContentsId !== contentsId) return;
                const headers = Object.fromEntries(Object.entries(request.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]));
                const token = parse(headers.cookie || "").access_token || /^Bearer (.+)$/i.exec(headers.authorization || "")?.[1];
                if (token) {
                    result = { token, subdomain: host.split(".")[0] };
                    setImmediate(() => { if (!window.isDestroyed()) window.close(); });
                }
            });
            window.loadURL(`https://${host}${host === "www.udemy.com" ? "/join/login-popup" : "/"}`).catch((error) => {
                if (closing || window.isDestroyed() || error.code === "ERR_ABORTED") return;
                if (!result) reject(error);
                window.destroy();
            });
        });
    });
}

module.exports = { registerUdemyLogin, udemyHost };
