import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ensureFfmpeg } from "./ensure-ffmpeg.mjs";

const DEFAULT_FPS = 10;

/**
 * Records the session's Electron page as an H.264 mp4 by piping CDP screencast
 * frames through ffmpeg. Returns `{ outPath, stop }`; await `stop()` so the
 * file is finalized before publishing it. The approach and its evaluated
 * alternatives live in docs/research/electron-video-capture.md.
 */
export async function startVideoRecording(session, { outPath, fps = DEFAULT_FPS, ffmpegPath } = {}) {
  if (!session?.context || !session?.page) {
    throw new Error("Pass the session returned by connectElectronSession");
  }
  const root = session.repoRoot ?? process.cwd();
  const output = NodePath.resolve(root, outPath ?? defaultOutPath(root));
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const ffmpeg = spawnFfmpeg(ffmpegPath ?? ensureFfmpeg(root), output, fps);
  const cdp = await session.context.newCDPSession(session.page);
  cdp.on("Page.screencastFrame", (frame) => {
    // Chromium withholds the next frame until the previous one is acknowledged.
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    ffmpeg.stdin.write(Buffer.from(frame.data, "base64"));
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  let finished = null;
  return {
    outPath: output,
    async stop() {
      finished ??= finalizeRecording(cdp, ffmpeg, output);
      return finished;
    },
  };
}

function defaultOutPath(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return NodePath.join(root, ".dev", "verification", `electron-${stamp}.mp4`);
}

function spawnFfmpeg(ffmpegPath, output, fps) {
  const ffmpeg = NodeChildProcess.spawn(
    ffmpegPath,
    [
      "-y",
      "-f", "image2pipe",
      "-framerate", String(fps),
      "-i", "pipe:0",
      // H.264 requires even dimensions; GitHub playback requires yuv420p.
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      output,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  // An early ffmpeg exit surfaces as EPIPE on stdin; stop() reports the real failure via exit code.
  ffmpeg.stdin.on("error", () => {});
  return ffmpeg;
}

async function finalizeRecording(cdp, ffmpeg, output) {
  await cdp.send("Page.stopScreencast").catch(() => {});
  ffmpeg.stdin.end();
  const code = await waitForExit(ffmpeg);
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code} while writing ${output}`);
  }
  if (!NodeFS.existsSync(output) || NodeFS.statSync(output).size === 0) {
    throw new Error(`Screencast produced no frames for ${output}; drive the UI before stopping`);
  }
  return output;
}

function waitForExit(ffmpeg) {
  if (ffmpeg.exitCode !== null) return Promise.resolve(ffmpeg.exitCode);
  return new Promise((resolve, reject) => {
    ffmpeg.once("exit", resolve);
    ffmpeg.once("error", reject);
  });
}
