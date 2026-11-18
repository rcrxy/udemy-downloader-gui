const { BrowserWindow, session } = require("electron");
const { udemyHost } = require("./udemy-login");

const PLAYER_PARTITION = "persist:udemy-player";

function openPlayerPage(window, url) {
    return new Promise((resolve, reject) => {
        const contents = window.webContents;
        const timeout = setTimeout(() => fail(new Error("Udemy player page took too long to load")), 30000);
        function cleanup() {
            clearTimeout(timeout);
            contents.removeListener("dom-ready", ready);
            window.removeListener("closed", closed);
        }
        function ready() {
            cleanup();
            resolve();
        }
        function fail(error) {
            cleanup();
            reject(error);
        }
        function closed() {
            fail(new Error("Udemy player was closed"));
        }
        contents.once("dom-ready", ready);
        window.once("closed", closed);
        contents.loadURL(url).catch((error) => {
            if (error.code !== "ERR_ABORTED") fail(error);
        });
    });
}

function registerUdemyPlayer(ipcMain, isMainRenderer) {
    let player = null;
    ipcMain.handle("udemy-player:open", async (event, subdomain) => {
        if (!isMainRenderer(event)) throw new Error("Udemy player is only available from the main window");
        const host = udemyHost(subdomain);
        const owner = event.sender;
        if (player?.host !== host) player?.window.close();
        if (!player) {
            const playerSession = session.fromPartition(PLAYER_PARTITION);
            const window = new BrowserWindow({
                title: "Udemy Player",
                width: 1200,
                height: 800,
                webPreferences: {
                    session: playerSession,
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    backgroundThrottling: false,
                },
            });
            const id = window.getMediaSourceId();
            window.webContents.setWindowOpenHandler(({ url }) => {
                if (new URL(url).protocol !== "https:") return { action: "deny" };
                return {
                    action: "allow",
                    overrideBrowserWindowOptions: {
                        webPreferences: { session: playerSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
                    },
                };
            });
            const opened = { window, id, host, loaded: openPlayerPage(window, `https://${host}/`) };
            player = opened;
            window.once("closed", () => {
                if (player === opened) player = null;
                playerSession.cookies.flushStore().catch(console.error);
                if (!owner.isDestroyed()) owner.send("udemy-player:closed", id);
            });
        }

        const opened = player;
        try {
            await opened.loaded;
            if (opened.window.isDestroyed()) throw new Error("Udemy player was closed");
            if (opened.window.isMinimized()) opened.window.restore();
            opened.window.focus();
            return { id: opened.id, name: "Udemy Player", embedded: true };
        } catch (error) {
            if (!opened.window.isDestroyed()) opened.window.destroy();
            throw error;
        }
    });
}

module.exports = { registerUdemyPlayer };
