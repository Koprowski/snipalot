import { execSync } from "node:child_process";

const targets = ["Snipalot.exe", "electron.exe"];

for (const imageName of targets) {
  try {
    execSync(`taskkill /IM ${imageName} /F`, { stdio: "pipe" });
    console.log(`[kill-stale] terminated ${imageName}`);
  } catch {
    console.log(`[kill-stale] ${imageName} not running`);
  }
}
