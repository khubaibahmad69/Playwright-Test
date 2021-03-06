import * as fs from "fs";
import { spawnSync } from "child_process";

const Usage = `
Usage: ts-node run.ts options
Options:
  --update             Force update to playwright browser.
  --recordings <path>  File to store recording IDs.
  --container          Use docker container for running tests (default on linux).
  --env <key> <value>  Set environment variable in tests.
  <test>               Run given test once.

On macOS, browsers are installed at $REPLAY_PLAYWRIGHT_BROWSER, defaulting to $HOME/.replay-playwright-browser
`;

let gNeedUpdate = false;
let gRecordingFile: string | undefined;
let gUseContainer = process.platform == "linux";
const gTests: string[] = [];
const gEnvironment: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg == "--update") {
    gNeedUpdate = true;
  } else if (arg == "--recordings") {
    gRecordingFile = process.argv[++i];
  } else if (arg == "--container") {
    gUseContainer = true;
  } else if (arg == "--env") {
    gEnvironment[process.argv[++i]] = process.argv[++i];
  } else {
    if (fs.existsSync(`${__dirname}/${arg}`)) {
      gTests.push(arg);
    } else {
      console.log(`Unknown test ${arg}`);
      console.log(Usage);
      process.exit(1);
    }
  }
}

if (!gNeedUpdate && !gTests.length) {
  console.log(Usage);
  process.exit(1);
}

if (gTests.length && !gRecordingFile) {
  console.log("Recordings file must be specified to run tests");
  console.log(Usage);
  process.exit(1);
}

const BrowserDir = process.env.REPLAY_PLAYWRIGHT_BROWSER || `${process.env.HOME}/.replay-playwright-browser`;

// This will need updating when we move to a more recent version of playwright.
const BrowserSubdir = `${BrowserDir}/firefox-1225`;

function mkdirSyncIfNotExists(dir: string) {
  try {
    fs.mkdirSync(dir);
  } catch (e) {}
}

function updateBrowser() {
  if (gUseContainer) {
    if (!gNeedUpdate) {
      const { stdout } = spawnSync("docker", ["image", "ls", "recordreplayinc/playwright:latest"]);
      if (stdout.includes("recordreplayinc/playwright")) {
        return;
      }
    }

    spawnSync("docker", ["image", "pull", "recordreplayinc/playwright:latest"], { stdio: "inherit" });
    return;
  }

  if (process.platform == "darwin") {
    if (!gNeedUpdate && fs.existsSync(`${BrowserSubdir}/firefox`)) {
      return;
    }

    spawnSync("rm", ["-rf", BrowserSubdir]);

    mkdirSyncIfNotExists(BrowserDir);
    mkdirSyncIfNotExists(BrowserSubdir);
    spawnSync("wget", ["https://replay.io/downloads/macOS-replay-playwright.tar.xz"], {
      cwd: BrowserSubdir,
      stdio: "inherit",
    });
    spawnSync("wget", ["https://replay.io/downloads/macOS-recordreplay.so"], {
      cwd: BrowserSubdir,
      stdio: "inherit",
    });
    spawnSync("tar", ["xf", "macOS-replay-playwright.tar.xz"], { cwd: BrowserSubdir });
    return;
  }
}

async function runTest(test: string) {
  const server = process.env.RECORD_REPLAY_SERVER || "wss://dispatch.replay.io";

  if (gUseContainer) {
    const tmpRecordingFile = `recordings-${(Math.random() * 1e9) | 0}.log`;
    const tmpRecordingPath = `${__dirname}/${tmpRecordingFile}`;
    if (fs.existsSync(gRecordingFile || "")) {
      fs.copyFileSync(gRecordingFile || "", tmpRecordingPath);
    }

    const script = `
npm i -g typescript ts-node playwright@1.8.1
npm i --save-dev @types/node
ts-node playwright-tests/${test}
`;
    const tmpScriptFile = `run-${(Math.random() * 1e9) | 0}`;
    const tmpScriptPath = `${__dirname}/${tmpScriptFile}`;
    fs.writeFileSync(tmpScriptPath, script);

    const envArgs = [];
    for (const [key, value] of Object.entries(gEnvironment)) {
      envArgs.push("-e", `${key}=${value}`);
    }

    spawnSync("docker", [
      "run",
      "-v", `${__dirname}:/playwright-tests`,
      "-e", `RECORD_REPLAY_RECORDING_ID_FILE=/playwright-tests/${tmpRecordingFile}`,
      "-e", `RECORD_REPLAY_SERVER=${server}`,
      "-e", "RECORD_ALL_CONTENT=1",
      ...envArgs,
      "recordreplayinc/playwright:latest",
      "bash",
      `/playwright-tests/${tmpScriptFile}`,
    ], { stdio: "inherit" });

    if (fs.existsSync(tmpRecordingPath)) {
      fs.copyFileSync(tmpRecordingPath, gRecordingFile || "");
      fs.unlinkSync(tmpRecordingPath);
    }

    fs.unlinkSync(tmpScriptPath);
    return;
  }

  if (process.platform == "darwin") {
    const driver = process.env.RECORD_REPLAY_DRIVER || `${BrowserSubdir}/macOS-recordreplay.so`;

    spawnSync("ts-node", [`${__dirname}/${test}`], {
      stdio: "inherit",
      env: {
        ...process.env,
        ...gEnvironment,
        PLAYWRIGHT_BROWSERS_PATH: BrowserDir,
        RECORD_REPLAY_DRIVER: driver,
        RECORD_REPLAY_RECORDING_ID_FILE: gRecordingFile,
        RECORD_REPLAY_SERVER: server,
        RECORD_ALL_CONTENT: "1",
      },
    });
    return;
  }
}

async function main() {
  updateBrowser();

  for (const test of gTests) {
    await runTest(test);
  }
}

main();
