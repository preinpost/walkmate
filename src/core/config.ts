import { homedir } from "node:os";
import { join } from "node:path";

/** Reads REVIEW_RECORDER_<name>. */
export const env = (name: string): string | undefined => process.env[`REVIEW_RECORDER_${name}`] || undefined;

/** Recordings, the whisper model and the review browser profile all live here. */
export const DATA_DIR = env("HOME") ?? join(homedir(), ".review-recorder");
export const REVIEWS_DIR = join(DATA_DIR, "reviews");
export const MODELS_DIR = join(DATA_DIR, "models");
/** Dedicated Chrome profile for live reviews; logins persist between reviews. */
export const CHROME_PROFILE = env("CHROME_PROFILE") ?? join(DATA_DIR, "chrome-profile");

export const WHISPER_MODEL_NAME = "ggml-large-v3-turbo.bin";
export const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_NAME}`;
