export interface ProjectColor {
  key: string;
  accent: string;
  soft: string;
  text: string;
}

const PROJECT_COLORS: ProjectColor[] = [
  { key: "blue", accent: "#4b6b8a", soft: "#edf3f8", text: "#29465f" },
  { key: "teal", accent: "#4f766f", soft: "#edf5f2", text: "#2d514b" },
  { key: "violet", accent: "#6f6385", soft: "#f2eff6", text: "#493f5c" },
  { key: "amber", accent: "#927348", soft: "#f8f3e9", text: "#624a2a" },
  { key: "rose", accent: "#8c6268", soft: "#f8eff1", text: "#603d43" },
  { key: "green", accent: "#667b58", soft: "#f0f5ec", text: "#435438" },
];

const NEUTRAL: ProjectColor = {
  key: "neutral",
  accent: "#666666",
  soft: "#f2f2f0",
  text: "#333333",
};

export function projectColor(projectKey: string | null | undefined): ProjectColor {
  if (!projectKey) return NEUTRAL;
  let hash = 2166136261;
  for (const char of projectKey) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length] ?? NEUTRAL;
}
