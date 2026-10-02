import { homedir } from "node:os";
import { join } from "node:path";

/** Reads WALKMATE_<name>. */
export const env = (name: string): string | undefined => process.env[`WALKMATE_${name}`] || undefined;

/** Shared whisper models and the persistent review browser profile. Recordings are project-local. */
export const DATA_DIR = env("HOME") ?? join(homedir(), ".walkmate");
export const MODELS_DIR = join(DATA_DIR, "models");
/** Dedicated Chrome profile for live reviews; logins persist between reviews. */
export const CHROME_PROFILE = env("CHROME_PROFILE") ?? join(DATA_DIR, "chrome-profile");

export const WHISPER_MODEL_NAME = "ggml-large-v3-turbo.bin";
export const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL_NAME}`;
