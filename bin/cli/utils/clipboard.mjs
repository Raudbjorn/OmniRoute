import { execSync } from "node:child_process";

export function copyToClipboard(text) {
  try {
    const execOpts = { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 2000 };
    {
      try {
        execSync("xclip -selection clipboard", execOpts);
      } catch {
        try {
          execSync("xsel --clipboard --input", execOpts);
        } catch {
          execSync("wl-copy", execOpts);
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function isClipboardSupported() {
  try {
    execSync("which xclip || which xsel || which wl-copy", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
