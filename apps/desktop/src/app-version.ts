// Injected by Vite from package.json at build time, so the version shows
// immediately and offline. Tests run without Vite and see "dev".
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
