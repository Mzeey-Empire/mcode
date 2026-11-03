import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ensureFfmpeg } from "./ensure-ffmpeg.mjs";

const OUTPUT_FPS = 25;

/**
 * Paces captured images into fixed-rate output slots using epoch seconds.
 * @param {number} fps
 * @returns {{ push(frame: { image: Buffer, at: number }): Buffer[], finish(at: number): Buffer[] }}
 */
export function createFramePacer(fps) {
  let start = 0;
  let held = null;
  let written = 0;
  return {
    push(frame) {
      if (held === null) {
        start = frame.at;
        held = frame.image;
        return [];
      }
      const due = Math.ceil((frame.at - start) * fps - 1e-6);
      const output = Array(Math.max(0, due - written)).fill(held);
      written = Math.max(written, due);
      held = frame.image;
      return output;
    },
    finish(at) {
      if (held === null) return [];
      const due = Math.max(written + 1, Math.ceil((at - start) * fps - 1e-6));
      const output = Array(due - written).fill(held);
      written = due;
      return output;
    },
  };
}

/**
 * Records the session's Electron page as an H.264 mp4 by piping CDP screencast
 * frames through ffmpeg. Clips play at real speed because frames are timed by
 * their capture timestamps, and the last frame holds until `stop()`. Returns
 * `{ outPath, stop }`; await `stop()` so the file is finalized before publishing
 * it. The approach and its evaluated alternatives live in
 * docs/research/electron-video-capture.md.
 */
export async function startVideoRecording(session, { outPath, ffmpegPath } = {}) {
  if (!session?.context || !session?.page) {
    throw new Error("Pass the session returned by connectElectronSession");
  }
  const root = session.repoRoot ?? process.cwd();
  const output = NodePath.resolve(root, outPath ?? defaultOutPath(root));
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const ffmpeg = spawnFfmpeg(ffmpegPath ?? ensureFfmpeg(root), output);
  const cdp = await session.context.newCDPSession(session.page);
  const pacer = createFramePacer(OUTPUT_FPS);
  let stopped = false;
  cdp.on("Page.screencastFrame", (frame) => {
    // Chromium withholds the next frame until the previous one is acknowledged.
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    if (stopped) return;
    const at = frame.metadata?.timestamp ?? Date.now() / 1000;
    const image = Buffer.from(frame.data, "base64");
    for (const buffer of pacer.push({ image, at })) {
      ffmpeg.stdin.write(buffer);
    }
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  let finished = null;
  return {
    outPath: output,
    async stop() {
      if (finished === null) {
        const stopAt = Date.now() / 1000;
        stopped = true;
        finished = finalizeRecording(cdp, ffmpeg, output, pacer, stopAt);
      }
      return finished;
    },
  };
}

function defaultOutPath(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return NodePath.join(root, ".dev", "verification", `electron-${stamp}.mp4`);
}

function spawnFfmpeg(ffmpegPath, output) {
  const ffmpeg = NodeChildProcess.spawn(
    ffmpegPath,
    [
      "-y",
      "-f", "image2pipe",
      "-framerate", String(OUTPUT_FPS),
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

async function finalizeRecording(cdp, ffmpeg, output, pacer, stopAt) {
  await cdp.send("Page.stopScreencast").catch(() => {});
  const frames = pacer.finish(stopAt);
  for (const buffer of frames) {
    ffmpeg.stdin.write(buffer);
  }
  ffmpeg.stdin.end();
  const code = await waitForExit(ffmpeg);
  if (frames.length === 0) {
    throw new Error(`Screencast produced no frames for ${output}; drive the UI before stopping`);
  }
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code} while writing ${output}`);
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
