const { join } = require("node:path");

try {
    process.loadEnvFile(join(__dirname, ".env"));
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
