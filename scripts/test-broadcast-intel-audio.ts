import assert from "node:assert/strict";
import { AUDIO_MIME, buildAudioFfmpegArgs, parseOutputDurationFromStderr } from "../lib/broadcast-intel/audio-extract";

const args = buildAudioFfmpegArgs();
assert.ok(args.includes("-vn"), "must drop the video stream");
assert.deepEqual(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2), ["-ac", "1"]);
assert.deepEqual(args.slice(args.indexOf("-ar"), args.indexOf("-ar") + 2), ["-ar", "16000"]);
assert.equal(args[args.indexOf("-i") + 1], "pipe:0", "reads the S3 stream from stdin");
assert.equal(args.at(-1), "pipe:1", "writes to stdout");
// audio/mp4 is not a Gemini-supported audio MIME; ADTS AAC is.
assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 2), ["-f", "adts"]);
assert.equal(AUDIO_MIME, "audio/aac");
assert.ok(!args.includes("-nostats"), "progress lines are the only reliable runtime source");

// THE reason this module exists. Measured on a 600s fragmented MP4 written
// with the same -movflags the archive uses, demuxed from a pipe:
//   header  → Duration: 00:00:50.02   (the probe window — wrong)
//   final   → time=00:09:59.97        (actually demuxed — right)
const REAL_STDERR = [
	"  Duration: 00:00:50.02, start: 0.400000, bitrate: N/A",
	"size=       0kB time=00:00:00.00 bitrate=N/A speed=   0x",
	"size=    1280kB time=00:05:06.47 bitrate=  34.2kbits/s speed= 306x",
	"size=    2554kB time=00:09:59.97 bitrate=  34.9kbits/s speed= 305x",
].join("\n");

assert.equal(parseOutputDurationFromStderr(REAL_STDERR), 600, "must read the LAST time=, not Duration:");
assert.equal(parseOutputDurationFromStderr("Duration: 00:00:50.02"), null, "no progress line → no runtime");
assert.equal(parseOutputDurationFromStderr(""), null);
assert.equal(parseOutputDurationFromStderr("time=00:00:00.00"), null, "a zero runtime is not a runtime");
assert.equal(parseOutputDurationFromStderr("time=01:02:03.50"), 3724);

console.log("PASS: broadcast-intel audio");
