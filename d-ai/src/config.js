export const casdoorBase = import.meta.env.VITE_CASDOOR_BASE || "/casdoor";
export const casibaseBase = import.meta.env.VITE_CASIBASE_BASE || "/casibase";

export const authConfig = {
  clientId: import.meta.env.VITE_CASDOOR_CLIENT_ID || "ba3a96dbc430c5c6a22b",
  application: import.meta.env.VITE_CASDOOR_APPLICATION || "casibase",
  organization: "ifm",
  redirectUri: import.meta.env.VITE_CASDOOR_REDIRECT_URI || "http://casibase.local:14000/callback",
  scope: import.meta.env.VITE_CASDOOR_SCOPE || "profile",
};
