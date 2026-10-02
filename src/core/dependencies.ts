import { execFile } from "node:child_process";

export function findExecutable(bin: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(process.platform === "win32" ? "where.exe" : "which", [bin], (err, stdout) =>
			resolve(err ? undefined : stdout.trim().split(/\r?\n/)[0]),
		);
	});
}

export function ffmpegInstallHint(): string {
	switch (process.platform) {
		case "darwin": return "brew install ffmpeg";
		case "win32": return "https://ffmpeg.org/download.html 에서 Windows 빌드를 설치하고 ffmpeg.exe를 PATH에 추가하세요.";
		default: return "Ubuntu/Debian: sudo apt install ffmpeg (다른 배포판은 패키지 관리자 사용)";
	}
}

export function whisperInstallHint(): string {
	if (process.platform === "darwin") return "brew install whisper-cpp && walkmate setup";
	return "https://github.com/ggml-org/whisper.cpp 의 설치 안내를 따라 whisper-cli를 준비한 뒤 walkmate setup을 실행하세요.";
}
