/**
 * Persistent silence state — survives restarts.
 */
import * as fs from "fs";
import * as path from "path";

export type VibeState = {
  silencedChannels: string[];
};

const DEFAULT_STATE: VibeState = { silencedChannels: [] };

let statePath: string;
let silencedChannels: Set<string>;

export function initState(pluginDir: string): void {
  statePath = path.join(pluginDir, "state.json");
  silencedChannels = new Set(loadState().silencedChannels);
}

function loadState(): VibeState {
  try {
    if (fs.existsSync(statePath)) {
      const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return { ...DEFAULT_STATE, ...data };
    }
  } catch (e) {
    // Fall through to default
  }
  return { ...DEFAULT_STATE };
}

function saveState(): void {
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({ silencedChannels: [...silencedChannels] }, null, 2),
    );
  } catch (e) {
    // Silently fail — state is best-effort
  }
}

export function isSilenced(channelId: string): boolean {
  return silencedChannels.has(channelId);
}

export function silence(channelId: string): void {
  silencedChannels.add(channelId);
  saveState();
}

export function unsilence(channelId: string): void {
  silencedChannels.delete(channelId);
  saveState();
}
